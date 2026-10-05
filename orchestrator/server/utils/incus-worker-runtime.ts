import type { Config } from "./config";
import type { DockerService } from "./docker";
import { IncusClient, type IncusInstance, type IncusDevice, type IncusCustomVolume } from "./incus-client";
import { AGENT_CREDENTIAL_MAPPINGS } from "./user-credentials";
import { join } from "node:path";
import { renderUserEnvVars } from "./user-env-store";
import { backupInstallationId } from "./backup-installation";
import { MANAGED_NETWORK_HOSTS_SCRIPT, normalizeManagedNetworkHosts } from './managed-network-hosts';
import { IncusWorkerStorage, type IncusStorageOwner } from "./incus-worker-storage";
import { resolveIncusPrimaryLease } from "./incus-worker-network";
import type { ContainerStatus } from "../../shared/types";
import { IncusWorkerCommands } from "./incus-worker-commands";
import { withOwnerWorkerRuntimeSetup } from "./worker-lifecycle-coordinator";
import type { WorkerConfigRevision } from './worker-config-store';
import { incusImageIdentity, sameIncusImageSource, type IncusWorkerImageIdentity } from './incus-worker-image';
import { IncusManagedVolumeRuntime } from './incus-managed-volume-runtime';
import { pathsOverlap, type StoredManagedVolume } from './managed-volume-store';
import { incusManagedNetworkAuthority, incusManagedBridgeIdentity, incusManagedNetworkDevice,
  incusManagedNetworkRule } from './incus-managed-network-identity';
import { ManagedNetworkStore } from './managed-network-store';
import { isIP } from 'node:net';
import { incusHostMountLayout, incusHostMountMetadata, assertIncusHostMountLayout } from './incus-host-mount-runtime';
import { INCUS_CANONICAL_ARCHIVE_SCRIPT } from './incus-canonical-archive';
import { INCUS_SELECTED_ARCHIVE_SCRIPT, nativeSelectedBackupPath } from './incus-selected-archive';
import { PassThrough, Readable, Transform } from 'node:stream';
import { snapshotIncusWorkerBackupRuntime, parseWorkerBackupRuntime, type WorkerBackupRuntimeSource } from './worker-backup-runtime';
import { IncusOfflineArchiveHelper } from './incus-offline-archive-helper';
import { writeGzipFile } from './worker-export';
import { INCUS_CANONICAL_RESTORE_SCRIPT } from './incus-canonical-restore';
import { validateIncusCanonicalRestoreArchive, validatePortableManagedVolumeArchive } from './portable-managed-volume-archive';
import { inspectIncusSelectedRestoreArchive, validateIncusSelectedRestoreArchive } from './portable-managed-volume-archive';
import { planIncusSelectedRestore, INCUS_SELECTED_RESTORE_SCRIPT } from './incus-selected-restore';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { openIncusDockerArchive, INCUS_OFFLINE_DOCKER_ARCHIVE_SCRIPT } from './incus-docker-archive';

export type IncusWorkerOptions = Parameters<DockerService["createWorkerContainer"]>[0] & {
  sshAuthorizedKeys?: string;
  configurationRevision?: WorkerConfigRevision;
  recreationNonce?: string;
  /** Authoritative internal records, never accepted from worker/user payloads. */
  managedVolumes?: StoredManagedVolume[];
  /** Initial-create-only, previously validated direct group; never user VM configuration. */
  hostMountGroupId?: string;
};

function sameDevice(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return !!actual && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** Config is a shell file consumed only by entrypoint.sh, never systemd's
 * EnvironmentFile parser. Quote values literally, including newlines. */
export function serializeIncusWorkerEnv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"))
      throw new Error("Invalid worker environment value");
    return `${key}='${value.replaceAll("'", "'\\''")}'`;
  }).join("\n") + "\n";
}

export function incusWorkerStatus(instance: IncusInstance): ContainerStatus {
  return ({ Running: "running", Stopped: "stopped", Starting: "starting",
    Stopping: "removing", Frozen: "unknown", Error: "error" } as Record<string, ContainerStatus>)[instance.status] ?? "unknown";
}

export const INCUS_GUEST_READINESS_SCRIPT = String.raw`
set -u
boot=$(cat /proc/sys/kernel/random/boot_id) || exit 70
provisioned=0; service=0
if test -e /run/agentor/worker.env; then
 test -f /run/agentor/worker.env && test -r /run/agentor/worker.env || exit 70
 if test -e /run/agentor/provisioned; then
  grep -qx agentor-runtime-v1 /run/agentor/provisioned
  result=$?
  case "$result" in 0) provisioned=1;; 1) :;; *) exit 70;; esac
 fi
fi
systemctl is-active --quiet agentor-worker.service
result=$?
case "$result" in
 0)
  if test "$provisioned" = 1; then
   runuser -u agent -- "$@"
   result=$?
   case "$result" in
    0)
     if test -e /tmp/worker-events; then
      grep -q '^READY|' /tmp/worker-events
      result=$?
      case "$result" in 0) service=1;; 1) :;; *) exit 70;; esac
     fi;;
    42) :;;
    *) exit 70;;
   esac
  fi;;
 3|4) :;;
 *) exit 70;;
esac
test "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" || exit 70
printf '%s %s %s\n' "$boot" "$provisioned" "$service"
`;

/** Exit42 means positively absent main session; transport/config errors remain
 * unknown. Exact matching rejects surviving main-other prefix sessions. */
export const INCUS_MAIN_SESSION_PROBE = String.raw`
message=$(LC_ALL=C tmux has-session -t '=main' 2>&1)
result=$?
case "$result" in
 0) exit 0;;
 1) case "$message" in
  "can't find session: main"|"can't find session: =main"|"no server running on "*|"error connecting to "*" (No such file or directory)") exit 42;;
  *) exit 70;;
 esac;;
 *) exit 70;;
esac
`;

/** Ordinary worker VM lifecycle. Incus credentials stay in the control plane;
 * guest configuration crosses only the agent file API after each boot. */
export class IncusWorkerRuntime {
  readonly client: IncusClient;
  private installation?: Promise<string>;
  constructor(private config: Config, client = IncusClient.fromConfig(config)) {
    this.client = client;
  }

  private installationId(): Promise<string> {
    return this.installation ??= backupInstallationId(this.config.dataDir);
  }

  private async storage(): Promise<IncusWorkerStorage> {
    return new IncusWorkerStorage(this.client, this.config, await this.installationId());
  }

  async removeStorage(owner: IncusStorageOwner): Promise<void> {
    await (await this.storage()).remove(owner);
  }

  private async assertAbsentCompute(owner: IncusStorageOwner) {
    try { await this.client.getInstance(owner.containerName); }
    catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return; throw error; }
    throw new Error('Archived Incus backup has unexpected compute; explicit recovery is required');
  }

  async backupRuntime(owner: IncusStorageOwner, incarnation?: string) {
    const validate = () => incarnation ? this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation)
      : this.assertAbsentCompute(owner);
    await validate();
    const identity = await (await this.storage()).imageIdentity(owner);
    if (!identity) throw new Error('Incus backup immutable source is missing');
    await validate();
    return snapshotIncusWorkerBackupRuntime(identity);
  }

  /** One networkless helper reads existing stopped/detached filesystem data.
   * Source volumes and original compute/devices are never changed. */
  async captureOfflineCanonical(owner: IncusStorageOwner, incarnation: string | undefined,
    validateRecord: () => void | Promise<void>, options: { workspace?: string; agents?: string;
      exclusions: string[]; signal?: AbortSignal }) {
    const storage = await this.storage();
    const original = incarnation ? await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation) : undefined;
    if (original && original.status !== 'Stopped') throw new Error('Offline Incus backup requires stopped compute');
    if (!original) await this.assertAbsentCompute(owner);
    const volumes = {} as Record<'workspace' | 'agents', NonNullable<Awaited<ReturnType<IncusWorkerStorage['inspectVolume']>>>>;
    for (const role of ['workspace', 'agents'] as const) {
      const volume = await storage.inspectVolume(owner, role);
      if (!volume || volume.project !== this.config.incusProject || !volume.created_at ||
          !Number.isFinite(Date.parse(volume.created_at)) || !Array.isArray(volume.used_by))
        throw new Error('Offline Incus canonical storage identity is unavailable');
      const expected = { type: 'disk', pool: this.config.incusStoragePool, source: volume.name,
        path: role === 'workspace' ? '/workspace' : '/home/agent/.agent-data' };
      const devices = original && Object.entries(original.expanded_devices ?? original.devices).filter(([, device]) =>
        device.type === 'disk' && device.pool === this.config.incusStoragePool && device.source === volume.name);
      if (volume.used_by.length !== (original ? 1 : 0) || original &&
          (!sameDevice(original.devices[role], expected) || devices?.length !== 1 || devices[0]?.[0] !== role ||
            !sameDevice(devices[0]?.[1], expected)))
        throw new Error('Offline Incus canonical storage references are ambiguous');
      volumes[role] = volume;
    }
    const runtime = await this.backupRuntime(owner, incarnation);
    const normalizeConfig = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    const assertSource = async (helperName?: string) => {
      await validateRecord();
      if (original) {
        const current = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
        if (current.status !== 'Stopped' || JSON.stringify(current.devices) !== JSON.stringify(original.devices))
          throw new Error('Offline Incus source compute changed during capture');
      } else await this.assertAbsentCompute(owner);
      for (const role of ['workspace', 'agents'] as const) {
        const before = volumes[role], current = await this.client.getCustomVolume(this.config.incusStoragePool, before.name);
        const references = (value: string[]) => value.map(ref => {
          const url = new URL(ref, this.client.endpoint);
          if (url.origin !== new URL(this.client.endpoint).origin || url.username || url.password || url.hash ||
              url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== this.config.incusProject ||
              [...url.searchParams.keys()].some(key => key !== 'project'))
            throw new Error('Offline canonical storage reference is foreign');
          return url.pathname;
        });
        const expected = references(before.used_by);
        if (expected.some(ref => ref !== `/1.0/instances/${owner.containerName}`) || new Set(expected).size !== expected.length)
          throw new Error('Offline canonical source references are ambiguous');
        if (helperName) expected.push(`/1.0/instances/${helperName}`);
        if (current.name !== before.name || current.project !== before.project || current.type !== before.type ||
            current.content_type !== before.content_type || current.created_at !== before.created_at ||
            normalizeConfig(current.config) !== normalizeConfig(before.config) || !Array.isArray(current.used_by) ||
            JSON.stringify(references(current.used_by).sort()) !== JSON.stringify(expected.sort()))
          throw new Error('Offline Incus canonical source authority changed during capture');
      }
      await validateRecord();
    };
    await assertSource();
    const bytes = { workspace: 0, agents: 0 };
    if (options.workspace || options.agents) await new IncusOfflineArchiveHelper(this.config, this.client,
      await this.installationId()).withGuest(owner, { workspace: volumes.workspace.name, agents: volumes.agents.name },
      assertSource, options.signal, async (name, assertHelper) => {
        const validate = async () => { await assertHelper(); await assertSource(name); };
        for (const role of ['workspace', 'agents'] as const) if (options[role]) {
          const stream = await this.archiveStream(name, role, validate, options, true);
          bytes[role] = await writeGzipFile(stream, options[role]!, options.signal);
        }
      });
    await assertSource();
    return { runtime, bytes };
  }

  /** Caller holds existing export lifecycle admission. Never allocate/start
   * storage, source guest environment, or enter a second worker setup queue. */
  async openCanonicalArchive(owner: IncusStorageOwner, incarnation: string, role: 'workspace' | 'agents',
    validateRecord: () => void | Promise<void>, options: { exclusions: string[]; signal?: AbortSignal }) {
    if (role !== 'workspace' && role !== 'agents') throw new Error('Invalid canonical archive role');
    const storage = await this.storage();
    const validate = async () => {
      await validateRecord();
      const instance = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
      if (instance.status !== 'Running') throw new Error('Running Incus canonical archive requires a running VM');
      const volume = await storage.inspectVolume(owner, role);
      const device = instance.devices[role];
      if (!volume || !device || !sameDevice(device, { type: 'disk', pool: this.config.incusStoragePool,
        source: volume.name, path: role === 'workspace' ? '/workspace' : '/home/agent/.agent-data' }))
        throw new Error('Incus canonical archive storage attachment is ambiguous');
      await validateRecord();
    };
    return this.archiveStream(owner.containerName, role, validate, options);
  }

  /** Shared read-only native storage proof, not a transport or transaction
   * abstraction. Cleanup uses the same proof without caller cancellation. */
  private async nativeArchiveAuthority(owner: IncusStorageOwner & Pick<IncusWorkerOptions,
    'storageManager' | 'mounts' | 'managedVolumes'>, incarnation: string,
    validateRecord: () => void | Promise<void>) {
    await validateRecord();
    const storage = await this.storage(), managed = new IncusManagedVolumeRuntime(this.config, this);
    const before = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    const expected: Record<string, IncusDevice> = { root: { type: 'disk', path: '/', pool: this.config.incusStoragePool },
      ...await this.accountDevices(owner) };
    const host = await incusHostMountLayout(this.config, owner, 'inspect');
    Object.assign(expected, host.devices);
    const volumes: Array<{ initial: IncusCustomVolume; inspect: () => Promise<IncusCustomVolume | undefined> }> = [];
    const addVolume = async (key: string, device: IncusDevice, inspect: () => Promise<IncusCustomVolume | undefined>) => {
      const volume = await inspect();
      if (!volume || volume.project !== this.config.incusProject || !volume.created_at || !Number.isFinite(Date.parse(volume.created_at)) ||
          !Array.isArray(volume.used_by) || volume.used_by.length !== 1 || expected[key])
        throw new Error('Selected archive storage identity is unavailable or duplicated');
      const reference = new URL(volume.used_by[0]!, this.client.endpoint);
      if (reference.origin !== new URL(this.client.endpoint).origin || reference.username || reference.password || reference.hash ||
          reference.pathname !== `/1.0/instances/${owner.containerName}` ||
          reference.searchParams.getAll('project').length !== 1 || reference.searchParams.get('project') !== this.config.incusProject ||
          [...reference.searchParams.keys()].some(key => key !== 'project'))
        throw new Error('Selected archive storage has foreign references');
      expected[key] = device; volumes.push({ initial: volume, inspect });
    };
    for (const role of ['workspace', 'agents'] as const)
      await addVolume(role, { type: 'disk', pool: this.config.incusStoragePool, source: owner.containerName + '-' + role,
        path: role === 'workspace' ? '/workspace' : '/home/agent/.agent-data' }, () => storage.inspectVolume(owner, role));
    if (before.devices.docker) await addVolume('docker', {
      type: 'disk', pool: this.config.incusStoragePool, source: owner.containerName + '-docker',
    }, () => storage.inspectVolume(owner, 'docker'));
    for (const record of owner.managedVolumes ?? []) {
      if (record.userId !== owner.userId || record.workerId !== owner.id || !record.attached || !record.seeded || record.state !== 'ready' ||
          record.incusLive || record.operation && record.operation.stage !== 'complete')
        throw new Error('Selected archive managed storage is not settled authority');
      await addVolume(managed.deviceKey(record), managed.device(record), () => managed.inspectVolume(record));
    }
    const prove = (instance: IncusInstance) => {
      if (instance.status !== 'Running' || instance.profiles?.length ||
          Object.keys(instance.config).some(key => key.startsWith('raw.')) ||
          Object.keys(instance.expanded_config ?? {}).some(key => key.startsWith('raw.')))
        throw new Error('Selected archive requires ordinary running native compute');
      for (const devices of [instance.devices, instance.expanded_devices ?? instance.devices]) {
        const disks = Object.entries(devices).filter(([, device]) => device.type === 'disk');
        if (disks.length !== Object.keys(expected).length || disks.some(([key, device]) => !sameDevice(device, expected[key] ?? {})))
          throw new Error('Selected archive native disk source or layout is foreign');
      }
      assertIncusHostMountLayout(instance, host);
    };
    prove(before);
    const bootId = async () => {
      const result = await this.client.exec(owner.containerName, ['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      if (result.returnCode !== 0 || !/^[a-f0-9-]{36}\n?$/.test(result.stdout)) throw new Error('Selected archive guest boot is unavailable');
      return result.stdout;
    };
    const boot = await bootId();
    const config = (instance: IncusInstance) => Object.fromEntries(Object.entries(instance.config)
      .filter(([key]) => !key.startsWith('volatile.') || ['volatile.uuid', 'volatile.base_image'].includes(key)));
    const validate = async () => {
      await validateRecord();
      const current = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation); prove(current);
      if (!isDeepStrictEqual(current.devices, before.devices) ||
          !isDeepStrictEqual(current.expanded_devices ?? current.devices, before.expanded_devices ?? before.devices) ||
          !isDeepStrictEqual(config(current), config(before)) || !isDeepStrictEqual(await this.accountDevices(owner),
            Object.fromEntries(Object.entries(expected).filter(([key]) => ['cred', 'kcfg', 'kdata'].includes(key)))))
        throw new Error('Selected archive native configuration changed');
      const currentHost = await incusHostMountLayout(this.config, owner, 'inspect');
      if (!isDeepStrictEqual(currentHost, host)) throw new Error('Selected archive host grant or source identity changed');
      for (const { initial, inspect } of volumes) if (!isDeepStrictEqual(await inspect(), initial))
        throw new Error('Selected archive storage metadata or references changed');
      if (await bootId() !== boot) throw new Error('Guest rebooted during selected archive capture');
      await validateRecord();
    };
    await validate();
    const proof = { mounts: Object.values(expected).flatMap(device => device.path ? [device.path] : []), credentials: !!expected.cred };
    return { validate, proof, boot, dockerVolume: before.devices.docker?.source };
  }

  /** Read-only selected capture while the caller holds the existing lifecycle
   * fence. Exhaustive native disk authority precedes any guest archive exec;
   * snapshots and guest boot identity are checked again before output EOF. */
  async openSelectedArchive(owner: IncusStorageOwner & Pick<IncusWorkerOptions,
    'storageManager' | 'mounts' | 'managedVolumes'>, incarnation: string, selected: string,
    validateRecord: () => void | Promise<void>, signal?: AbortSignal) {
    selected = nativeSelectedBackupPath(selected); signal?.throwIfAborted();
    const authority = await this.nativeArchiveAuthority(owner, incarnation, validateRecord);
    const { proof } = authority;
    const validate = async () => { signal?.throwIfAborted(); await authority.validate(); };
    await validate();
    const session = await this.client.execStream(owner.containerName,
      ['/usr/bin/python3', '-c', INCUS_SELECTED_ARCHIVE_SCRIPT, selected, JSON.stringify(proof)], {
        command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        signal, timeoutMs: 10 * 60_000,
      });
    const output = new PassThrough(); output.on('error', () => {}); output.once('close', () => session.close());
    session.stderr.resume(); session.stdout.on('error', error => output.destroy(error));
    session.stdout.pipe(output, { end: false }); session.stdin.end();
    void session.result.then(async code => {
      if (code !== 0) throw new Error('Selected native archive capture failed; verify path readability, approved mounts and current credential provisioning');
      await validate(); output.end();
    }).catch(error => output.destroy(error));
    return output;
  }

  /** Exact logical Docker selection only. Rootfs, arbitrary subtrees and
   * disabled/unmounted retained storage are not authority for this path. */
  async openDockerArchive(owner: IncusStorageOwner & Pick<IncusWorkerOptions,
    'storageManager' | 'mounts' | 'managedVolumes'>, incarnation: string,
    validateRecord: () => void | Promise<void>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const authority = await this.nativeArchiveAuthority(owner, incarnation, validateRecord);
    if (!authority.dockerVolume) throw Object.assign(new Error('Native Docker backup volume is unavailable'),
      { statusCode: 409, code: 'INCUS_DOCKER_BACKUP_UNAVAILABLE' });
    return openIncusDockerArchive(this.client, owner.containerName, authority.dockerVolume,
      authority.boot.trim(), authority.validate, signal);
  }

  /** Retained Docker data is not an inactive disposable-root directory. Stop
   * authority is read-only; a referenced block needs a private native copy,
   * while an archived detached block can attach directly with readonly=true. */
  async captureOfflineDocker(owner: IncusStorageOwner, incarnation: string | undefined,
    validateRecord: () => void | Promise<void>, options: { archivePath: string; maxBytes: number; signal?: AbortSignal }) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new Error('Invalid Docker archive byte limit');
    await validateRecord();
    const original = incarnation ? await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation) : undefined;
    if (original && original.status !== 'Stopped') throw new Error('Offline Docker backup requires stopped compute');
    if (!original) await this.assertAbsentCompute(owner);
    const storage = await this.storage(), before = await storage.inspectVolume(owner, 'docker');
    if (!before) throw Object.assign(new Error('Native Docker backup volume is unavailable'),
      { statusCode: 409, code: 'INCUS_DOCKER_BACKUP_UNAVAILABLE' });
    if (before.project !== this.config.incusProject || !Number.isFinite(Date.parse(before.created_at)) ||
        !Array.isArray(before.used_by)) throw new Error('Offline Docker storage authority is unavailable');
    const expectedDevice = { type: 'disk', pool: this.config.incusStoragePool, source: before.name };
    if (original) for (const devices of [original.devices, original.expanded_devices ?? original.devices]) {
      const matches = Object.entries(devices).filter(([, d]) => d.type === 'disk' &&
        d.pool === this.config.incusStoragePool && d.source === before.name);
      if (!sameDevice(devices.docker, expectedDevice) || matches.length !== 1 || matches[0]?.[0] !== 'docker')
        throw new Error('Offline Docker source attachment is ambiguous');
    }
    const references = (values: string[]) => values.map(ref => {
      const url = new URL(ref, this.client.endpoint);
      if (url.origin !== new URL(this.client.endpoint).origin || url.username || url.password || url.hash ||
          url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== this.config.incusProject ||
          [...url.searchParams.keys()].some(key => key !== 'project')) throw new Error('Offline Docker reference is foreign');
      return url.pathname;
    }).sort();
    const baseline = original ? [`/1.0/instances/${owner.containerName}`] : [];
    if (!isDeepStrictEqual(references(before.used_by), baseline)) throw new Error('Offline Docker references are ambiguous');
    const assertSource = async (helper?: string) => {
      // Uncancelled cleanup must retain source proof, not resurrect compute.
      await validateRecord();
      if (original) {
        const current = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
        if (current.status !== 'Stopped' || !isDeepStrictEqual(current.devices, original.devices) ||
            !isDeepStrictEqual(current.expanded_devices, original.expanded_devices) ||
            !isDeepStrictEqual(current.config, original.config)) throw new Error('Offline Docker source compute changed');
      } else await this.assertAbsentCompute(owner);
      const current = await this.client.getCustomVolume(this.config.incusStoragePool, before.name);
      const expected = [...baseline, ...(!original && helper ? [`/1.0/instances/${helper}`] : [])].sort();
      if (current.name !== before.name || current.project !== before.project || current.type !== before.type ||
          current.content_type !== before.content_type || current.created_at !== before.created_at ||
          !isDeepStrictEqual(current.config, before.config) || !Array.isArray(current.used_by) ||
          !isDeepStrictEqual(references(current.used_by), expected)) throw new Error('Offline Docker source storage changed');
      await validateRecord();
    };
    await assertSource(); let bytes = 0;
    await new IncusOfflineArchiveHelper(this.config, this.client, await this.installationId())
      .withGuest(owner, { docker: before.name, copy: !!original }, assertSource, options.signal, async (name, assertHelper) => {
        const validate = async () => { await assertHelper(); await assertSource(name); };
        await validate();
        const session = await this.client.execStream(name, ['/usr/bin/python3', '-c', INCUS_OFFLINE_DOCKER_ARCHIVE_SCRIPT],
          { command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
            signal: options.signal, timeoutMs: 10 * 60_000 });
        let diagnostic = '';
        session.stderr.on('data', chunk => { if (diagnostic.length < 4096) diagnostic += chunk.toString().slice(0, 4096 - diagnostic.length); });
        session.stdin.end();
        try {
          await Promise.all([session.result.then(code => { if (code !== 0) throw Object.assign(
            new Error('Offline Docker logical capture failed; verify clean readonly ext4'), { guestExitCode: code, guestDiagnostic: diagnostic }); }),
            pipeline(session.stdout, new Transform({ transform(chunk, _encoding, done) {
              bytes += chunk.length; done(bytes > options.maxBytes ? new Error('Docker archive exceeds byte limit') : null, chunk);
            } }), createWriteStream(options.archivePath, { flags: 'wx', mode: 0o600 }), { signal: options.signal })]);
          await validate();
        } finally { session.close(); }
      });
    await assertSource(); return bytes;
  }

  /** Internal managed capture supplies the helper's exact UUID/isolation and
   * source proof. The role/path cannot come from a portable bundle. */
  openOfflineManagedArchive(helperName: string, validate: () => Promise<void>, signal?: AbortSignal) {
    return this.archiveStream(helperName, 'managed', validate, { exclusions: [], signal }, true);
  }

  private async archiveStream(name: string, role: 'workspace' | 'agents' | 'managed', validate: () => Promise<void>,
    options: { exclusions: string[]; signal?: AbortSignal }, offline = false) {
    await validate();
    const session = await this.client.execStream(name,
      ['/usr/bin/python3', '-c', INCUS_CANONICAL_ARCHIVE_SCRIPT, role, JSON.stringify(options.exclusions), ...(offline ? ['offline'] : [])],
      { command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        signal: options.signal, timeoutMs: 10 * 60_000 });
    const output = new PassThrough();
    output.on('error', () => {});
    output.once('close', () => session.close());
    session.stderr.resume();
    session.stdout.on('error', error => output.destroy(error));
    session.stdout.pipe(output, { end: false });
    session.stdin.end();
    void session.result.then(async code => {
      if (code !== 0) throw new Error('Incus canonical archive capture failed');
      await validate();
      output.end();
    }).catch(error => output.destroy(error));
    return output;
  }

  async matchesWorkerIdentity(instance: IncusInstance, workerId: string, userId?: string): Promise<boolean> {
    return instance.type === "virtual-machine" && instance.config["user.agentor.id"] === workerId &&
      instance.name === `${this.config.containerPrefix}-${workerId}` &&
      instance.config["user.agentor.installation"] === await this.installationId() &&
      (!userId || instance.config["user.agentor.owner"] === userId);
  }

  /** Caller owns the worker admission; no guest environment/provisioning or
   * service restart is needed for these nonsecret, reconstructable hints. */
  async applyManagedHosts(owner: IncusStorageOwner, incarnation: string, entries: unknown): Promise<void> {
    const check = () => this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    if ((await check()).status !== 'Running') return;
    await this.checkedExec(owner.containerName, ['python3', '-c', MANAGED_NETWORK_HOSTS_SCRIPT,
      'apply', JSON.stringify(normalizeManagedNetworkHosts(entries))]);
    await check();
  }

  /** Telemetry is diagnostic only. It never supplies routing/worker identity. */
  async inspectState(owner: IncusStorageOwner, incarnation: string) {
    const check = async () => {
      const instance = await this.assertOwned(owner.containerName, owner.id);
      if (instance.config['user.agentor.owner'] !== owner.userId || !incarnation ||
          instance.config['volatile.uuid'] !== incarnation)
        throw new Error('Incus observation target ownership or incarnation changed');
      return instance;
    };
    const instance = await check();
    const state = await this.client.getInstanceState(owner.containerName);
    await check();
    const limit = (instance.expanded_config ?? instance.config)['limits.cpu'] ?? '1';
    const nic = (instance.expanded_devices ?? instance.devices).eth0;
    return { state, cpuCount: /^[1-9][0-9]*$/.test(limit) ? Number(limit) : 0,
      primaryMac: nic?.hwaddr ?? instance.config['volatile.eth0.hwaddr'] };
  }

  /** Read the journal without requiring provisioned /run config. This remains
   * available to diagnose a running guest whose worker service is unhealthy. */
  async openJournal(owner: IncusStorageOwner, incarnation: string, validateRecord: () => void,
    options: { tail?: number; follow?: boolean; sinceNow?: boolean; signal?: AbortSignal } = {}) {
    return withOwnerWorkerRuntimeSetup(owner.userId, owner.id, async () => {
      const validate = async () => {
        validateRecord();
        const instance = await this.assertOwned(owner.containerName, owner.id);
        validateRecord();
        if (instance.config['user.agentor.owner'] !== owner.userId || !incarnation || instance.config['volatile.uuid'] !== incarnation)
          throw new Error('Incus journal target ownership or incarnation changed');
        if (instance.status !== 'Running') throw new Error('Incus guest journal requires a running VM');
      };
      await validate();
      const command = ['journalctl', '--boot', '--no-pager', '--output=short-iso-precise',
        '_SYSTEMD_UNIT=agentor-worker.service', '+', 'SYSLOG_IDENTIFIER=agentor-app',
        '--lines=' + Math.min(10_000, Math.max(1, Math.trunc(options.tail ?? 200)))];
      if (options.follow) command.push('--follow');
      if (options.sinceNow) command.push('--since=now');
      const session = await this.client.execStream(owner.containerName, command, {
        command: [], user: 0, group: 0, signal: options.signal,
        timeoutMs: options.follow ? 24 * 60 * 60_000 : 10_000,
      });
      try {
        await validate(); session.stdin.end();
        return Object.assign(session, { isCurrent: () => { try { validateRecord(); return true; } catch { return false; } } });
      }
      catch (error) { session.close(); throw error; }
    });
  }

  async resolvePrimaryAddress(owner: IncusStorageOwner): Promise<{ address: string; incarnation: string }> {
    const initial = await this.assertOwned(owner.containerName, owner.id);
    if (initial.config["user.agentor.owner"] !== owner.userId) throw new Error("Incus worker account identity does not match");
    const [network, leases, peers] = await Promise.all([
      this.client.getNetwork(this.config.incusNetwork), this.client.getNetworkLeases(this.config.incusNetwork), this.client.listInstances(),
    ]);
    const result = resolveIncusPrimaryLease(initial, peers, network, leases, this.config.incusNetwork,
      await incusManagedNetworkAuthority(this.config.dataDir, owner));
    // A name survives recreation. Revalidate host incarnation/metadata after
    // the network reads rather than trusting a potentially stale name/IP pair.
    const current = await this.assertOwned(owner.containerName, owner.id);
    if (current.config["user.agentor.owner"] !== owner.userId) throw new Error("Incus worker account identity does not match");
    const confirmed = resolveIncusPrimaryLease(current, peers, network, leases, this.config.incusNetwork,
      await incusManagedNetworkAuthority(this.config.dataDir, owner));
    if (confirmed.incarnation !== result.incarnation || confirmed.address !== result.address)
      throw new Error("Incus worker changed during address resolution; retry");
    return confirmed;
  }

  private async assertOwned(name: string, workerId?: string, userId?: string, incarnation?: string): Promise<IncusInstance> {
    const instance = await this.client.getInstance(name);
    const id = workerId ?? instance.config["user.agentor.id"];
    if (!id || !await this.matchesWorkerIdentity(instance, id, userId))
      throw new Error("Refusing to manage an Incus instance without matching Agentor installation/worker identity");
    if (incarnation && instance.config['volatile.uuid'] !== incarnation)
      throw new Error('Incus worker incarnation changed; explicit recovery is required');
    return instance;
  }

  /** Managed-network topology is diagnostic, never primary routing or
   * Worker-Self authority. Addresses come from host leases, not guest state. */
  async inspectManagedNetwork(owner: IncusStorageOwner, incarnation: string, networkId: string):
    Promise<{ attached: boolean; ipv4Address: string }> {
    if (!incarnation) throw new Error('Incus network observation requires a captured worker incarnation');
    const store = new ManagedNetworkStore(this.config.dataDir);
    await store.loadUser(owner.userId);
    const network = store.get(owner.userId, networkId);
    if (!network || network.userId !== owner.userId) throw new Error('Managed network record is missing or foreign');
    const identity = incusManagedBridgeIdentity(await this.installationId(), network);
    const expected = incusManagedNetworkDevice(identity.installation, owner.id, network);
    const check = async () => {
      const instance = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
      const device = (instance.expanded_devices ?? instance.devices)[identity.key];
      if (instance.profiles.length || (device && !sameDevice(device, expected)) ||
          (instance.config[`volatile.${identity.key}.hwaddr`] &&
           instance.config[`volatile.${identity.key}.hwaddr`]!.toLowerCase() !== expected.hwaddr))
        throw new Error('Incus managed network observation has foreign or ambiguous device authority');
      return { instance, device };
    };
    const initial = await check();
    if (!initial.device) return { attached: false, ipv4Address: '' };
    if (initial.instance.status === 'Stopped') return { attached: true, ipv4Address: '' };
    if (initial.instance.status !== 'Running') throw new Error('Incus network observation state is unavailable');
    const native = await this.client.getNetwork(identity.name);
    if (native.name !== identity.name || native.type !== 'bridge' || !native.managed)
      throw new Error('Incus managed network bridge is unavailable');
    const leases = await this.client.getNetworkLeases(identity.name);
    const matching = leases.filter(lease => isIP(lease.address) === 4 &&
      lease.hwaddr.toLowerCase() === expected.hwaddr && ['dynamic', 'static'].includes(lease.type));
    const addresses = [...new Set(matching.map(lease => lease.address))];
    if (addresses.length > 1 || addresses.some(address => leases.some(lease =>
        lease.address === address && lease.hwaddr.toLowerCase() !== expected.hwaddr)))
      throw new Error('Incus managed network lease is ambiguous');
    const confirmed = await check();
    if (!confirmed.device || confirmed.instance.status !== 'Running')
      throw new Error('Incus managed network changed during observation');
    return { attached: true, ipv4Address: addresses[0] ?? '' };
  }

  /** Leaf operation under the caller's existing owner→worker lifecycle fence.
   * Never reacquire that fence from create/recovery. Bridge creation and exact
   * project allowlisting are separate narrow host-service operations. */
  async setManagedNetwork(owner: IncusStorageOwner, incarnation: string, networkId: string, attach: boolean): Promise<void> {
    if (!incarnation) throw new Error('Incus network mutation requires a captured worker incarnation');
    const store = new ManagedNetworkStore(this.config.dataDir);
    await store.loadUser(owner.userId);
    const network = store.get(owner.userId, networkId);
    if (!network || network.userId !== owner.userId) throw new Error('Managed network record is missing or foreign');
    const identity = incusManagedBridgeIdentity(await this.installationId(), network);
    const expected = incusManagedNetworkDevice(identity.installation, owner.id, network);
    if (attach && !sameDevice((await incusManagedNetworkAuthority(this.config.dataDir, owner))[identity.key], expected))
      throw new Error('Worker is not an authorized managed network member');
    const check = () => this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    let current = await check();
    if (current.profiles.length || !['Running', 'Stopped'].includes(current.status))
      throw new Error('Incus network target profiles or state are ambiguous');
    if (current.devices[identity.key] && !sameDevice(current.devices[identity.key], expected))
      throw new Error('Incus managed network device is foreign or modified');
    // Put the matching /run rule in place BEFORE hotplug, not after DHCP can
    // replace the worker's primary route/resolver settings.
    const boot = current.status === 'Running' ? await this.managedNetworkBoot(owner, incarnation) : undefined;
    if (attach && boot) {
      await this.writeManagedNetworkRule(owner, incarnation, identity.key, expected);
      await this.checkManagedNetworkBoot(owner, incarnation, boot, identity.key, expected);
    }
    current = await check();
    if (current.devices[identity.key] && !sameDevice(current.devices[identity.key], expected))
      throw new Error('Incus managed network device changed during setup');
    if (attach && !sameDevice((await incusManagedNetworkAuthority(this.config.dataDir, owner))[identity.key], expected))
      throw new Error('Managed network membership changed during setup');
    const devices = { ...current.devices };
    if (attach) devices[identity.key] = expected;
    else delete devices[identity.key];
    if (attach ? !current.devices[identity.key] : !!current.devices[identity.key])
      await this.client.updateInstanceDevices(owner.containerName, devices, undefined, current);
    current = await check();
    if (attach ? !sameDevice(current.devices[identity.key], expected) : !!current.devices[identity.key])
      throw new Error('Incus managed network attachment did not settle as requested');
    if (current.status === 'Running') {
      if (attach) {
        if (!boot) throw new Error('Guest boot changed during managed network attachment');
        await this.checkManagedNetworkBoot(owner, incarnation, boot, identity.key, expected);
        await this.activateManagedNetworkRule(owner, incarnation, expected);
        await this.checkManagedNetworkBoot(owner, incarnation, boot, identity.key, expected);
      }
      else {
        await this.checkedExec(owner.containerName, ['rm', '-f', `/run/systemd/network/00-agentor-${identity.key}.network`]);
        await check();
        await this.checkedExec(owner.containerName, ['timeout', '15', 'networkctl', 'reload']);
        await check();
      }
    }
  }

  private async writeManagedNetworkRule(owner: IncusStorageOwner, incarnation: string, key: string, device: IncusDevice) {
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    await this.checkedExec(owner.containerName, ['mkdir', '-p', '/run/systemd/network']);
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    await this.client.pushFile(owner.containerName, `/run/systemd/network/00-agentor-${key}.network`,
      incusManagedNetworkRule(device), { uid: 0, gid: 0, mode: 0o644 });
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    await this.checkedExec(owner.containerName, ['timeout', '15', 'networkctl', 'reload']);
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
  }

  private async activateManagedNetworkRule(owner: IncusStorageOwner, incarnation: string, device: IncusDevice) {
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    // Guest interface discovery is used only for local networkd activation,
    // never as host routing or Worker-Self authority.
    await this.checkedExec(owner.containerName, ['timeout', '15', 'bash', '-ec',
      'for p in /sys/class/net/*/address; do read -r mac < "$p"; if [ "$mac" = "$1" ]; then iface=${p%/address}; iface=${iface##*/}; networkctl reconfigure -- "$iface"; exit; fi; done; exit 1',
      'agentor-managed-network', device.hwaddr!]);
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
  }

  private async managedNetworkBoot(owner: IncusStorageOwner, incarnation: string): Promise<string> {
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    const result = await this.client.exec(owner.containerName, ['cat', '/proc/sys/kernel/random/boot_id']);
    const boot = result.stdout.trim();
    if (result.returnCode !== 0) throw new Error('Managed network guest boot identity is unavailable');
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(boot)) throw new Error('Managed network guest boot identity is unavailable');
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    return boot;
  }

  private async checkManagedNetworkBoot(owner: IncusStorageOwner, incarnation: string, boot: string, key: string, device: IncusDevice) {
    if (await this.managedNetworkBoot(owner, incarnation) !== boot)
      throw new Error('Guest rebooted during managed network configuration; reprovision before retry');
    await this.checkedExec(owner.containerName, ['timeout', '5', 'bash', '-ec',
      'test "$(cat /proc/sys/kernel/random/boot_id)" = "$1"; test "$(cat -- "$2")" = "$3"', 'agentor-managed-rule-proof',
      boot, `/run/systemd/network/00-agentor-${key}.network`, incusManagedNetworkRule(device).trimEnd()]);
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
  }

  /** /run disappears on guest reboot. Rematerialize only attached, currently
   * registry-authorized secondary NICs before worker services are activated. */
  async reprovisionManagedNetworks(owner: IncusStorageOwner, incarnation: string): Promise<void> {
    if (!incarnation) throw new Error('Incus network provisioning requires a captured worker incarnation');
    const instance = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    const secondaries = Object.entries(instance.expanded_devices ?? instance.devices)
      .filter(([key, device]) => device.type === 'nic' && key !== 'eth0');
    if (!secondaries.length) return;
    const allowed = await incusManagedNetworkAuthority(this.config.dataDir, owner);
    for (const [key, device] of secondaries) {
      if (!sameDevice(device, allowed[key] ?? {})) throw new Error('Incus secondary NIC is not registry-authorized');
    }
    const boot = await this.managedNetworkBoot(owner, incarnation);
    for (const [key, device] of secondaries) {
      await this.writeManagedNetworkRule(owner, incarnation, key, device);
      await this.checkManagedNetworkBoot(owner, incarnation, boot, key, device);
      await this.activateManagedNetworkRule(owner, incarnation, device);
      await this.checkManagedNetworkBoot(owner, incarnation, boot, key, device);
    }
  }

  commands(owner: IncusStorageOwner, incarnation: string, validateRecord: () => void | Promise<void>,
    setup?: <T>(operation: () => Promise<T>) => Promise<T>,
  ): IncusWorkerCommands {
    return new IncusWorkerCommands(this.client, owner.containerName, `incus:${incarnation}`, async () => {
      await validateRecord();
      const instance = await this.assertOwned(owner.containerName, owner.id);
      await validateRecord();
      if (instance.config['user.agentor.owner'] !== owner.userId ||
          instance.config['volatile.uuid'] !== incarnation || instance.status !== 'Running')
        throw new Error('Incus command target ownership, incarnation or running state changed');
    }, setup ?? ((operation) => withOwnerWorkerRuntimeSetup(owner.userId, owner.id, operation)));
  }

  private validateOptions(opts: IncusWorkerOptions): void {
    // Refuse pending storage features on restart too; never put persistent
    // Docker/account data on disposable rootfs when settings change.
    if (opts.hardwareDevices?.length)
      throw new Error("Incus hardware requires its feature integration");
    if (opts.mounts?.length && !opts.storageManager?.dataHostPath)
      throw new Error('Incus host mounts require authoritative platform storage');
    if (opts.credentialBinds?.length && !opts.storageManager)
      throw new Error("Incus account shares require authoritative platform storage");
    if (opts.dockerEnabled !== undefined && opts.dockerEnabled !== opts.environmentJson.dockerEnabled)
      throw new Error("Docker capability must match the resolved worker environment");
    if (opts.image) throw new Error("A custom OCI image requires its derived Incus image mapping");
  }

  private async accountDevices(opts: Pick<IncusWorkerOptions, 'storageManager' | 'userId' | 'credentialBinds'>): Promise<Record<string, IncusDevice>> {
    if (!opts.storageManager) return {};
    const userHost = opts.storageManager.getUserHostDir(opts.userId);
    const credentials = join(userHost, "credentials");
    const allowedBinds = new Set([
      ...AGENT_CREDENTIAL_MAPPINGS.filter((mapping) => mapping.fileBind !== false)
        .map((mapping) => `${join(credentials, mapping.fileName)}:${mapping.containerPath}`),
      opts.storageManager.getSshAuthorizedKeysBind(opts.userId),
      opts.storageManager.getKiloConfigBind(opts.userId), opts.storageManager.getKiloSharedDataBind(opts.userId),
    ]);
    if (opts.credentialBinds?.some((bind) => !allowedBinds.has(bind)))
      throw new Error("Refusing an unrecognized account share");
    const devices: Record<string, IncusDevice> = {
      // Short device keys also bound QEMU's Unix socket pathname (108 bytes).
      cred: { type: "disk", source: credentials, path: "/run/agentor/account-credentials" },
      kcfg: { type: "disk", source: join(userHost, "kilo/config"), path: "/home/agent/.agent-data/.kilo/config" },
      kdata: { type: "disk", source: join(userHost, "kilo/data"), path: "/home/agent/.agent-data/.kilo/shared-data" },
    };
    const project = await this.client.request<{ config: Record<string, string> }>("GET", `/1.0/projects/${encodeURIComponent(this.config.incusProject)}`);
    const paths = project.config["restricted.devices.disk.paths"]?.split(",").map((path) => path.trim()) ?? [];
    if (project.config.restricted !== "true" || project.config["restricted.devices.disk"] !== "allow" ||
        Object.values(devices).some((device) => !paths.includes(device.source!)))
      throw new Error("Host setup must explicitly allowlist this account's credential and Kilo directories in the restricted Incus project");
    return devices;
  }

  private async managedDevices(opts: IncusWorkerOptions): Promise<Record<string, IncusDevice>> {
    const runtime = new IncusManagedVolumeRuntime(this.config, this);
    const devices: Record<string, IncusDevice> = {};
    for (const v of opts.managedVolumes ?? []) {
      if (v.userId !== opts.userId || v.workerId !== opts.id || !v.attached || !v.seeded)
        throw new Error('Incus managed storage requires seeded, attached records for this worker');
      const key = runtime.deviceKey(v);
      if (devices[key]) throw new Error('Incus managed device keys collide; no compute was changed');
      if (Object.values(devices).some(d => d.path === v.target || d.path?.startsWith(v.target + '/') || v.target.startsWith(d.path + '/')))
        throw new Error('Incus managed targets overlap; no compute was changed');
      await runtime.ensureVolume(v);
      devices[key] = runtime.device(v);
    }
    return devices;
  }

  private async managedRestoreDevices(opts: IncusWorkerOptions): Promise<Record<string, IncusDevice>> {
    const runtime = new IncusManagedVolumeRuntime(this.config, this), devices: Record<string, IncusDevice> = {};
    if ((opts.managedVolumes?.length ?? 0) > 32) throw new Error('Managed restore exceeds the worker volume limit');
    const targets: string[] = [];
    for (const v of opts.managedVolumes ?? []) {
      if (v.userId !== opts.userId || v.workerId !== opts.id || !v.attached || v.incusLive || v.operation ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.id) || pathsOverlap(v.target, '/restore') ||
          !((v.state === 'pending' && !v.seeded) || (v.state === 'ready' && v.seeded)))
        throw new Error('Managed restore requires current attached records for the exact worker');
      const key = runtime.deviceKey(v);
      if (devices[key]) throw new Error('Managed restore device keys collide');
      if (Object.values(devices).some(d => d.source === v.dockerName)) throw new Error('Managed restore volume identity is duplicated');
      if (targets.some(target => target === v.target || target.startsWith(v.target + '/') || v.target.startsWith(target + '/')))
        throw new Error('Managed restore operational targets overlap');
      targets.push(v.target);
      devices[key] = { ...runtime.device(v), path: `/restore/managed/${v.id}/volume` };
    }
    return devices;
  }

  private async assertReady(): Promise<void> {
    const c = this.config;
    if (!c.incusEndpoint?.startsWith("https://") || !c.incusClientCertPath ||
        !c.incusClientKeyPath || !c.incusServerCertPath || !c.incusProject || c.incusProject === "default")
      throw new Error("Incus workers require HTTPS, verified server TLS, client credentials, and a dedicated project");
    if (!c.incusInternalGatewayUrl)
      throw new Error("INCUS_INTERNAL_GATEWAY_URL is required for VM to orchestrator communication");
    if (!c.dataDir || !c.incusNetwork || !c.incusStoragePool)
      throw new Error("Incus workers require installation data, configured worker network and storage pool");
    const readiness = await this.client.getReadiness();
    if (!readiness.ready) throw new Error("Incus worker runtime is unavailable");
    // Earlier 6.0 LTS exports restricted host paths with an implicit unmapped
    // user namespace. Do not compensate by granting host-root ID mappings or
    // unrestricted low-level options; use the upstream fixed share transport.
    const version = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(readiness.serverVersion);
    // LTS backports are not a numeric lower bound for older rolling releases:
    // 6.1–6.9 still have the defect; rolling 6.10 contains the fixed transport.
    if (!version || !(Number(version[1]) > 6 || (Number(version[1]) === 6 &&
        (Number(version[2]) >= 10 || (Number(version[2]) === 0 && Number(version[3] ?? 0) >= 5)))))
      throw new Error("Incus workers require patched Incus (6.0 LTS >=6.0.5 or >=6.10) and compatible Rust virtiofsd; run host setup/check");
    const project = await this.client.request<{ config: Record<string, string> }>(
      "GET", `/1.0/projects/${encodeURIComponent(c.incusProject)}`);
    if (project.config.restricted !== "true") throw new Error("Agentor Incus project must be restricted");
  }

  async preflightRecreation(opts: IncusWorkerOptions, dockerRequired = false): Promise<{ fingerprint: string; docker: boolean }> {
    await this.assertReady();
    this.validateOptions(opts);
    const storage = await this.storage();
    const source = await storage.imageIdentity(opts);
    if (!source) throw new Error('Incus worker image source is missing; preserve the original source before compute removal');
    const fingerprint = await this.resolveStoredImage(source);
    await this.accountDevices(opts);
    await incusHostMountLayout(this.config, opts, 'reconstruct-preflight');
    return { fingerprint, ...await storage.verifyExisting(opts, dockerRequired) };
  }

  private async resolveStoredImage(source: IncusWorkerImageIdentity): Promise<string> {
    try {
      const identity = incusImageIdentity(await this.client.getImage(source.fingerprint));
      if (!sameIncusImageSource(identity, source)) throw new Error('Incus cached worker image source does not match');
      return identity.fingerprint;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    // Cache fingerprints are not portable source authority. A re-import of
    // the exact conversion inputs may have a different artifact fingerprint.
    for (const image of await this.client.listImages()) {
      let identity: IncusWorkerImageIdentity;
      try { identity = incusImageIdentity(image); } catch { continue; }
      if (sameIncusImageSource(identity, source)) return identity.fingerprint;
    }
    throw new Error('Derived image for the worker immutable OCI source is unavailable; rebuild/import that source before retrying');
  }

  /** Upgrade older owned compute before archive, never infer its source from
   * the current mutable platform alias. Persistent data remains untouched. */
  async preserveRecreationSource(owner: IncusStorageOwner, incarnation: string): Promise<void> {
    const instance = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    const fingerprint = instance.config['volatile.base_image'];
    if (!fingerprint) throw new Error('Original Incus worker image identity is unavailable; explicit recovery is required');
    const image = incusImageIdentity(await this.client.getImage(fingerprint));
    const storage = await this.storage();
    await storage.verifyExisting(owner, !!instance.devices.docker);
    await storage.devices(owner, false, { docker: !!instance.devices.docker });
    await storage.recordImageIdentity(owner, image);
    await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
  }

  async prepareArchive(owner: IncusStorageOwner, incarnation: string): Promise<void> {
    if (!incarnation) throw new Error('Incus archive requires a verified runtime incarnation');
    try { await this.preserveRecreationSource(owner, incarnation); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      // A previous removal may have succeeded before archive persistence.
      // Retry only when canonical storage and already-recorded source survive;
      // absence of compute is never permission to allocate empty data.
      const storage = await this.storage();
      if (!await storage.imageIdentity(owner))
        throw new Error('Incus archived image source is missing; explicit recovery is required');
      await storage.verifyExisting(owner);
    }
  }

  /** Roll back interrupted replacement, never complete it using potentially
   * newer desired settings. A lost response is recoverable only by the nonce
   * written by our create request, authoritative owner and current UUID. */
  async rollbackRecreation(owner: IncusStorageOwner,
    marker: { nonce: string; originalIncarnation?: string; replacementIncarnation?: string; initialCreate?: true; importIncomplete?: true }):
    Promise<{ status: 'active' | 'archived'; incarnation?: string }> {
    if (!marker || typeof marker.nonce !== 'string' || !marker.nonce || marker.nonce.length > 128 ||
        [marker.originalIncarnation, marker.replacementIncarnation].some((id) =>
          id !== undefined && (typeof id !== 'string' || !id || id.length > 128)) ||
        (marker.initialCreate !== undefined && marker.initialCreate !== true) ||
        (marker.importIncomplete !== undefined && (marker.importIncomplete !== true || !marker.initialCreate)) ||
        (marker.initialCreate && marker.originalIncarnation !== undefined) ||
        (marker.originalIncarnation && marker.originalIncarnation === marker.replacementIncarnation))
      throw new Error('Incus recreation recovery marker is invalid');
    let instance: IncusInstance;
    try { instance = await this.client.getInstance(owner.containerName); }
    catch (error) {
      // Only an authoritative lookup404 proves missing compute. Do not turn
      // unavailable API/storage facts into permission to discard the marker.
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      const storage = await this.storage();
      if (marker.initialCreate) {
        // Only explicit first-create authority permits incomplete allocation.
        // Keep partial data/config; neither allocate nor delete anything.
        await storage.verifyPartialInitial(owner);
        return { status: 'archived' };
      }
      if (!await storage.imageIdentity(owner)) throw new Error('Incus recreation retained source is missing');
      await storage.verifyExisting(owner);
      return { status: 'archived' };
    }
    const uuid = instance.config['volatile.uuid'];
    if (!uuid || !await this.matchesWorkerIdentity(instance, owner.id, owner.userId))
      throw new Error('Incus recreation recovery instance identity is unavailable');
    if (uuid === marker.originalIncarnation) {
      await this.stop(owner, uuid);
      await this.assertOwned(owner.containerName, owner.id, owner.userId, uuid);
      return { status: 'active', incarnation: uuid };
    }
    const checkReplacement = async () => {
      const current = await this.assertOwned(owner.containerName, owner.id, owner.userId, uuid);
      if (current.config['user.agentor.recreation'] !== marker.nonce ||
          (marker.replacementIncarnation && marker.replacementIncarnation !== uuid))
        throw new Error('Incus recreation recovery replacement identity changed');
    };
    await checkReplacement();
    await this.stop(owner, uuid);
    // Revalidate nonce as well as UUID immediately before deletion.
    await checkReplacement();
    await this.client.deleteInstance(owner.containerName);
    return { status: 'archived' };
  }

  private async resolveImage(fingerprint?: string): Promise<string> {
    if (!fingerprint) {
      const alias = await this.client.getImageAlias(this.config.incusWorkerImage);
      if (alias.type !== 'virtual-machine') throw new Error('Incus worker image must be a virtual machine');
      fingerprint = alias.target;
    }
    const image = await this.client.getImage(fingerprint);
    if (image.type && image.type !== 'virtual-machine') throw new Error('Incus worker image must be a virtual machine');
    if (image.properties?.bootstrap_generation !== '3')
      throw new Error('Rebuild the derived Incus worker image with the current safe storage bootstrap');
    return fingerprint;
  }

  async create(opts: IncusWorkerOptions, existing?: { fingerprint: string; docker: boolean }): Promise<IncusInstance> {
    return this.createWorker(opts, existing);
  }

  /** Internal first-import primitive; caller persists the existing initialCreate
   * marker BEFORE this request and captures its returned UUID. No retry/adoption
   * of partially allocated destinations is permitted. */
  async createCanonicalRestore(opts: IncusWorkerOptions, source?: WorkerBackupRuntimeSource): Promise<IncusInstance> {
    if (!opts.recreationNonce || opts.start !== false)
      throw new Error('Incus restore requires durable nonce and stopped initial creation');
    this.validateOptions(opts);
    let fingerprint: string | undefined;
    let verifiedSource: WorkerBackupRuntimeSource | undefined;
    if (source) {
      const parsed = parseWorkerBackupRuntime({ version: 1, kind: 'incus-vm', source });
      if (parsed?.kind !== 'incus-vm') throw new Error('Invalid Incus restore source');
      // Portable descriptors (and backup provenance) never authorize another
      // owner's cached custom OCI image. Until authorized catalog conversion
      // is enabled, only the configured default OCI source can be reconstructed.
      // Older recipes for that same immutable userspace remain reusable.
      const authorized = incusImageIdentity(await this.client.getImage(await this.resolveImage()));
      if (parsed.source.sourceImageId !== authorized.sourceImageId || parsed.source.architecture !== authorized.architecture)
        throw Object.assign(new Error('The described restore OCI image is not authorized by the current default image; select an authorized replacement or workspace-only restore'),
          { statusCode: 409, code: 'INCUS_RESTORE_IMAGE_NOT_AUTHORIZED' });
      verifiedSource = parsed.source;
      for (const image of await this.client.listImages()) {
        let identity: IncusWorkerImageIdentity;
        try { identity = incusImageIdentity(image); } catch { continue; }
        if (sameIncusImageSource(identity, parsed.source)) { fingerprint = identity.fingerprint; break; }
      }
      if (!fingerprint) throw new Error('Derived image for the immutable restore source is unavailable');
    }
    return this.createWorker(opts, undefined, { fingerprint, source: verifiedSource });
  }

  private async createWorker(opts: IncusWorkerOptions, existing?: { fingerprint: string; docker: boolean },
    restore?: { fingerprint?: string; source?: WorkerBackupRuntimeSource }): Promise<IncusInstance> {
    await this.assertReady();
    // These features are integrated in the following storage/device phases.
    // Refuse them here rather than silently placing data on disposable rootfs.
    this.validateOptions(opts);
    if (opts.containerName !== `${this.config.containerPrefix}-${opts.id}`)
      throw new Error("Incus worker name must match its WorkerRecord identity");
    const storage = await this.storage();
    if (restore) await this.assertAbsentCompute(opts);
    const source = restore ? undefined : await storage.imageIdentity(opts);
    const fingerprint = restore ? await this.resolveImage(restore.fingerprint) : existing ? await this.resolveImage(existing.fingerprint)
      : source ? await this.resolveStoredImage(source) : await this.resolveImage();
    const identity = incusImageIdentity(await this.client.getImage(fingerprint));
    if (source && !sameIncusImageSource(source, identity)) throw new Error('Incus reconstruction image source changed');
    if (restore?.source && !sameIncusImageSource(restore.source, identity))
      throw new Error('Incus restore immutable image source changed before allocation');
    const account = restore ? {} : await this.accountDevices(opts);
    const restoreManaged = restore ? await this.managedRestoreDevices(opts) : undefined;
    const hostMounts = restore ? undefined : await incusHostMountLayout(this.config, opts, 'ensure');
    const persistent = restore ? await storage.freshRestoreDevices(opts)
      : await storage.devices(opts, opts.environmentJson.dockerEnabled, existing && { docker: existing.docker });
    await storage.recordImageIdentity(opts, identity);
    if (restore) for (const volume of opts.managedVolumes ?? [])
      await new IncusManagedVolumeRuntime(this.config, this).freshRestoreVolume(volume);
    const instance = await this.client.createInstance({
      name: opts.containerName, type: "virtual-machine", profiles: [],
      source: { type: "image", fingerprint },
      config: {
        "user.agentor.id": opts.id,
        "user.agentor.owner": opts.userId,
        "user.agentor.installation": await this.installationId(),
        "user.agentor.runtime-generation": "1",
        ...(hostMounts ? incusHostMountMetadata(hostMounts) : {}),
        ...(restore ? { 'user.agentor.restore': 'incomplete' } : {}),
        ...(opts.recreationNonce ? { 'user.agentor.recreation': opts.recreationNonce } : {}),
        "security.secureboot": "false",
        "boot.autostart": "false",
        ...(opts.memoryLimit ? { "limits.memory": opts.memoryLimit } : {}),
        ...(opts.cpuLimit ? { "limits.cpu": String(Math.max(1, Math.ceil(opts.cpuLimit))) } : {}),
      },
      devices: {
        ...persistent,
        ...account,
        ...(restoreManaged ?? await this.managedDevices(opts)),
        ...hostMounts?.devices,
        root: { type: "disk", path: "/", pool: this.config.incusStoragePool },
        ...(restore ? {} : { eth0: { type: "nic", name: "eth0", network: this.config.incusNetwork,
          "security.mac_filtering": "true", "security.ipv4_filtering": "true", "security.ipv6_filtering": "true" } }),
      },
    });
    if (opts.start !== false) await this.start(opts);
    return instance;
  }

  private async checkedExec(name: string, command: string[]): Promise<void> {
    const result = await this.client.exec(name, command);
    if (result.returnCode !== 0) throw new Error(`Incus worker bootstrap command failed (${command[0]}, exit ${result.returnCode})`);
  }

  /** Raw paths must be private import scratch, not caller-selected host files.
   * No account overlays or ordinary startup are allowed during extraction. The
   * existing worker/owner fence and initialCreate marker remain caller-owned. */
  async restoreCanonicalArchives(opts: IncusWorkerOptions, incarnation: string,
    payloads: { workspace?: string; agents?: string }, validateRecord: () => void | Promise<void>,
    signal?: AbortSignal, managedPayloads: Array<{ volume: StoredManagedVolume; archivePath: string }> = [],
    selectedPayloads: Array<{ path: string; archivePath: string }> = []): Promise<void> {
    if (!incarnation || !opts.recreationNonce) throw new Error('Incus restore requires exact initial creation authority');
    const storage = await this.storage();
    const managedRuntime = new IncusManagedVolumeRuntime(this.config, this);
    const managedDevices = await this.managedRestoreDevices(opts);
    const selectedPlans = planIncusSelectedRestore(selectedPayloads.map(item => item.path), {
      accountShares: !!opts.storageManager, hostTargets: (opts.mounts ?? []).map(item => item.target),
      managedTargets: (opts.managedVolumes ?? []).map(item => item.target),
    });
    // Raw names and unchanged byte paths are private importer staging, never
    // portable mount/device authority. Revalidate before starting compute.
    for (const item of selectedPayloads) await validateIncusSelectedRestoreArchive(item.archivePath, item.path, { signal });
    // Retain only the current bounded proof, never 32x64MiB buffers. Archives
    // were already checked before boot; rescan the exact private bytes at use.
    const selectedProof = async (item: { path: string; archivePath: string }, index: number) => {
      const { members } = await inspectIncusSelectedRestoreArchive(item.archivePath, item.path, { signal });
      if (members.reduce((bytes, member) => bytes + Buffer.byteLength(member.name) * 6 + 64, 0) > 64 * 1024 * 1024)
        throw new Error('Selected destination member proof exceeds limit');
      const proof = Buffer.from(JSON.stringify({ destination: selectedPlans[index]!.destination,
        wrapper: item.path.slice(item.path.lastIndexOf('/') + 1), members,
        mounts: ['/restore/workspace', '/restore/.agent-data',
          ...Object.values(managedDevices).map(device => device.path!)] }));
      if (proof.length > 64 * 1024 * 1024) throw new Error('Selected destination proof exceeds limit');
      const size = Buffer.alloc(4); size.writeUInt32BE(proof.length);
      return Buffer.concat([size, proof]);
    };
    if (managedPayloads.length !== (opts.managedVolumes?.length ?? 0) ||
        managedPayloads.some((item, index) => JSON.stringify(item.volume) !== JSON.stringify(opts.managedVolumes![index])))
      throw new Error('Managed restore payloads do not match the planned storage records');
    const expected = {
      root: { type: 'disk', path: '/', pool: this.config.incusStoragePool },
      workspace: { type: 'disk', pool: this.config.incusStoragePool,
        source: opts.containerName + '-workspace', path: '/restore/workspace' },
      agents: { type: 'disk', pool: this.config.incusStoragePool,
        source: opts.containerName + '-agents', path: '/restore/.agent-data' },
      ...managedDevices,
    };
    const sameMap = (actual: Record<string, IncusDevice>) =>
      Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => sameDevice(actual[key], value));
    const inspect = async () => {
      signal?.throwIfAborted();
      await validateRecord();
      const instance = await this.assertOwned(opts.containerName, opts.id, opts.userId, incarnation);
      if (instance.type !== 'virtual-machine' || instance.profiles?.length ||
          instance.config['user.agentor.recreation'] !== opts.recreationNonce ||
          instance.config['user.agentor.restore'] !== 'incomplete' || !sameMap(instance.devices) ||
          !sameMap(instance.expanded_devices ?? instance.devices) ||
          Object.keys(instance.config).some(key => key.startsWith('raw.')) ||
          Object.keys(instance.expanded_config ?? {}).some(key => key.startsWith('raw.')))
        throw new Error('Incus canonical restore layout or identity is ambiguous');
      return instance;
    };
    const before = await inspect();
    if (before.status !== 'Stopped') throw new Error('Incus canonical restore requires new stopped compute');
    const volumes: Array<{ inspect: () => Promise<IncusCustomVolume | undefined>; volume: IncusCustomVolume }> = [];
    const sources = [
      ...(['workspace', 'agents'] as const).map(role => ({ inspect: () => storage.inspectVolume(opts, role),
        validate: () => payloads[role] ? validateIncusCanonicalRestoreArchive(payloads[role]!, role, { signal }) : Promise.resolve() })),
      ...managedPayloads.map(({ volume, archivePath }) => ({ inspect: () => managedRuntime.inspectVolume(volume),
        validate: () => validatePortableManagedVolumeArchive(archivePath, { target: volume.target, signal, requirePosixUstar: true }) })),
    ];
    for (const source of sources) {
      const volume = await source.inspect();
      if (!volume || volume.project !== this.config.incusProject || !volume.created_at || !Number.isFinite(Date.parse(volume.created_at)) ||
          !Array.isArray(volume.used_by) || volume.used_by.length !== 1)
        throw new Error('Incus restore canonical volume authority is unavailable');
      const reference = new URL(volume.used_by[0]!, this.client.endpoint);
      if (reference.origin !== new URL(this.client.endpoint).origin || reference.username || reference.password ||
          reference.hash || reference.pathname !== `/1.0/instances/${opts.containerName}` ||
          reference.searchParams.getAll('project').length !== 1 || reference.searchParams.get('project') !== this.config.incusProject ||
          [...reference.searchParams.keys()].some(key => key !== 'project'))
        throw new Error('Incus restore storage reference is foreign');
      volumes.push({ inspect: source.inspect, volume });
      await source.validate();
    }
    let started = false;
    const stable = async () => {
      const instance = await inspect();
      if (instance.status !== (started ? 'Running' : 'Stopped'))
        throw new Error('Incus restore runtime state changed');
      const config = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      const computeConfig = (value: Record<string, string>) => config(Object.fromEntries(Object.entries(value)
        .filter(([key]) => !key.startsWith('volatile.') || ['volatile.uuid', 'volatile.base_image'].includes(key))));
      if (computeConfig(instance.config) !== computeConfig(before.config)) throw new Error('Incus restore compute configuration changed');
      for (const { inspect: inspectVolume, volume } of volumes) {
        const current = await inspectVolume();
        if (!current || current.created_at !== volume.created_at || current.project !== volume.project ||
            config(current.config) !== config(volume.config) ||
            JSON.stringify(current.used_by) !== JSON.stringify(volume.used_by))
          throw new Error('Incus restore private storage changed');
      }
      await validateRecord();
    };
    await stable();
    try {
      await this.client.startInstance(opts.containerName);
      started = true;
      const deadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        try { ready = (await this.client.exec(opts.containerName, ['true'])).returnCode === 0; } catch { /* boot */ }
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error('Incus canonical restore guest agent did not become ready');
      const extracts = [
        ...(['workspace', 'agents'] as const).map(role => ({ role, archivePath: payloads[role] })),
        ...managedPayloads.map(item => ({ role: `managed:${item.volume.id}`, archivePath: item.archivePath })),
      ];
      for (const { role, archivePath } of extracts) {
        await stable();
        if (!archivePath) {
          await this.checkedExec(opts.containerName, ['/usr/bin/python3', '-c', INCUS_CANONICAL_RESTORE_SCRIPT, role, 'empty']);
          await stable();
          continue;
        }
        const session = await this.client.execStream(opts.containerName,
          ['/usr/bin/python3', '-c', INCUS_CANONICAL_RESTORE_SCRIPT, role], {
            command: [],
            user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
            signal, timeoutMs: 30 * 60_000,
          });
        session.stdout.resume(); session.stderr.resume();
        try {
          await Promise.all([pipeline(createReadStream(archivePath), session.stdin, { signal }),
            session.result.then(code => { if (code !== 0) throw new Error(`Incus canonical ${role} extraction failed (exit ${code})`); })]);
          await stable();
        } finally { session.close(); }
      }
      for (const [index, item] of selectedPayloads.entries()) {
        await stable();
        const prefix = await selectedProof(item, index);
        await stable();
        const session = await this.client.execStream(opts.containerName,
          ['/usr/bin/python3', '-c', INCUS_SELECTED_RESTORE_SCRIPT], {
            command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
            signal, timeoutMs: 30 * 60_000,
          });
        session.stdout.resume(); session.stderr.resume();
        try {
          const framed = Readable.from((async function* () {
            yield prefix;
            for await (const chunk of createReadStream(item.archivePath)) yield chunk;
          })());
          await Promise.all([pipeline(framed, session.stdin, { signal }), session.result.then(code => {
            if (code !== 0) throw new Error(`Incus selected extraction failed (exit ${code}); verify destination ancestors and grants`);
          })]);
          await stable();
        } finally { session.close(); }
      }
      await stable();
      await storage.markPreserveOwnership(opts);
      await validateRecord();
    } catch (error) {
      // A start observer can fail while Incus still owns an operation. A
      // stopped read-back is not terminal proof: leave the initial-create
      // nonce quarantine intact rather than claim shutdown or retry start.
      if (!started) throw new AggregateError([error], 'Incus restore start is unconfirmed; destination remains quarantined');
      // A truncated archive/cancelled exec may have left a child process. Stop
      // exact destination compute before any subsequent rollback/storage use.
      try { await this.stop(opts, incarnation); }
      catch (stopError) { throw new AggregateError([error, stopError], 'Incus restore failed; destination shutdown is unconfirmed'); }
      throw error;
    }
  }

  /** Reattach current grants only after extraction has settled. The caller's
   * initial import marker stays incomplete through service health validation;
   * an unknown native PUT is never inferred complete from device read-back. */
  async finishCanonicalRestore(opts: IncusWorkerOptions, incarnation: string,
    validateRecord: () => void | Promise<void>): Promise<void> {
    if (!incarnation) throw new Error('Incus restore completion requires a captured incarnation');
    this.validateOptions(opts);
    await this.assertReady();
    const storage = await this.storage();
    const restoreDevices = await this.managedRestoreDevices(opts);
    if ((opts.managedVolumes ?? []).some(v => !v.seeded || v.state !== 'ready'))
      throw new Error('Managed restore data must be committed before activation');
    const expected = {
      ...restoreDevices,
      root: { type: 'disk', path: '/', pool: this.config.incusStoragePool },
      workspace: { type: 'disk', path: '/restore/workspace', pool: this.config.incusStoragePool, source: opts.containerName + '-workspace' },
      agents: { type: 'disk', path: '/restore/.agent-data', pool: this.config.incusStoragePool, source: opts.containerName + '-agents' },
    };
    const sameMap = (devices: Record<string, IncusDevice>) => Object.keys(devices).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => sameDevice(devices[key], value));
    const managedRuntime = new IncusManagedVolumeRuntime(this.config, this);
    const volumeBaselines = new Map<string, IncusCustomVolume>();
    await validateRecord();
    for (const record of opts.managedVolumes ?? []) {
      const volume = await managedRuntime.inspectVolume(record);
      if (!volume || volume.project !== this.config.incusProject || !volume.created_at ||
          !Number.isFinite(Date.parse(volume.created_at)) || volume.used_by.length !== 1)
        throw new Error('Managed restore storage authority is incomplete');
      const reference = new URL(volume.used_by[0]!, this.client.endpoint);
      if (reference.origin !== new URL(this.client.endpoint).origin || reference.username || reference.password || reference.hash ||
          reference.pathname !== `/1.0/instances/${opts.containerName}` ||
          reference.searchParams.getAll('project').length !== 1 || reference.searchParams.get('project') !== this.config.incusProject ||
          [...reference.searchParams.keys()].some(key => key !== 'project'))
        throw new Error('Managed restore storage reference is foreign');
      volumeBaselines.set(record.id, structuredClone(volume));
    }
    const check = async () => {
      await validateRecord();
      const instance = await this.assertOwned(opts.containerName, opts.id, opts.userId, incarnation);
      if (!opts.recreationNonce || instance.config['user.agentor.recreation'] !== opts.recreationNonce ||
          instance.config['user.agentor.restore'] !== 'incomplete' || instance.type !== 'virtual-machine' ||
          instance.profiles?.length || !sameMap(instance.devices) || !sameMap(instance.expanded_devices ?? instance.devices) ||
          Object.keys(instance.config).some(key => key.startsWith('raw.')) ||
          Object.keys(instance.expanded_config ?? {}).some(key => key.startsWith('raw.')) ||
          !await storage.preserveOwnership(opts))
        throw new Error('Incus canonical restore data or destination authority is incomplete');
      for (const record of opts.managedVolumes ?? []) {
        const baseline = volumeBaselines.get(record.id)!, current = await managedRuntime.inspectVolume(record);
        if (!current || current.project !== baseline.project || current.created_at !== baseline.created_at ||
            !isDeepStrictEqual(current.config, baseline.config) || !isDeepStrictEqual(current.used_by, baseline.used_by))
          throw new Error('Managed restore storage authority changed before activation');
      }
      await validateRecord();
      return instance;
    };
    const isolated = await check();
    if ((opts.managedVolumes?.length ?? 0) && isolated.status !== 'Running')
      throw new Error('Managed restore target validation requires the isolated running destination');
    for (const volume of opts.managedVolumes ?? []) {
      await managedRuntime.validateTarget(opts.userId, opts.id, `incus:${incarnation}`, volume.target);
      await check();
    }
    await this.stop(opts, incarnation);
    const stopped = await check();
    if (stopped.status !== 'Stopped') throw new Error('Incus restore destination shutdown is unconfirmed');
    const persistent = await storage.devices(opts, opts.environmentJson.dockerEnabled, { docker: false });
    const account = await this.accountDevices(opts), managed = await this.managedDevices(opts);
    const host = await incusHostMountLayout(this.config, opts, 'ensure');
    for (const volume of opts.managedVolumes ?? []) {
      if (Object.values({ ...persistent, ...account, ...host.devices }).some(device =>
        device.type === 'disk' && device.path && device.path !== '/' && pathsOverlap(device.path, volume.target)))
        throw new Error('Managed restore operational target overlaps a current storage grant');
    }
    const current = await check();
    await this.client.updateInstanceDevices(opts.containerName, {
      ...persistent, ...account, ...managed, ...host.devices,
      root: { type: 'disk', path: '/', pool: this.config.incusStoragePool },
      eth0: { type: 'nic', name: 'eth0', network: this.config.incusNetwork,
        'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' },
    }, undefined, current, { nonce: opts.recreationNonce!, hostMountMetadata: incusHostMountMetadata(host)['user.agentor.host-mounts'] });
    await validateRecord();
    const completed = await this.assertOwned(opts.containerName, opts.id, opts.userId, incarnation);
    if (completed.status !== 'Stopped' || completed.config['user.agentor.restore'] !== undefined ||
        completed.config['user.agentor.recreation'] !== opts.recreationNonce)
      throw new Error('Incus restore activation result is unavailable; retain the initial import fence');
    assertIncusHostMountLayout(completed, host);
    // start rechecks current private/layout/grants and actual image support
    // before pushing config or running the ownership helper/service.
    await this.start(opts, incarnation);
    await validateRecord();
  }

  /** Positive guest facts only. Timeout/transport failures are unknown, never
   * evidence that a running VM should be rebooted or its services restarted. */
  async inspectGuestReadiness(owner: IncusStorageOwner, incarnation: string): Promise<{
    bootId: string; provisioned: boolean; serviceReady: boolean;
  }> {
    if (!incarnation) throw new Error('Incus guest readiness requires a captured incarnation');
    const before = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    if (before.status !== 'Running') throw new Error('Incus readiness requires a running VM');
    const result = await this.client.exec(owner.containerName, ['timeout', '5', 'sh', '-c',
      // main is created before entrypoint's environment/local-variable phase.
      // Match that original account environment, not later app overrides.
      INCUS_GUEST_READINESS_SCRIPT, 'agentor-readiness', '/bin/bash', '-ec',
      'set -a; . /run/agentor/worker.env; set +a; exec /bin/sh -c "$1"',
      'agentor-main-probe', INCUS_MAIN_SESSION_PROBE]);
    if (result.returnCode !== 0) throw new Error('Incus guest readiness could not be verified');
    const parsed = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) ([01]) ([01])\s*$/.exec(result.stdout);
    if (!parsed) throw new Error('Incus guest readiness response is invalid');
    const after = await this.assertOwned(owner.containerName, owner.id, owner.userId, incarnation);
    if (after.status !== 'Running') throw new Error('Incus guest changed during readiness inspection');
    return { bootId: parsed[1]!, provisioned: parsed[2] === '1', serviceReady: parsed[3] === '1' };
  }

  async start(opts: IncusWorkerOptions, incarnation?: string,
    recovery: { leaveRunningOnFailure?: boolean } = {}): Promise<void> {
    this.validateOptions(opts);
    await this.assertReady();
    const name = opts.containerName;
    const instance = await this.assertOwned(name, opts.id, opts.userId, incarnation);
    if (instance.config['user.agentor.restore'] !== undefined)
      throw new Error('Incus restore destination is incomplete; normal worker startup is forbidden');
    if (instance.config['user.agentor.owner'] !== opts.userId)
      throw new Error('Incus worker account identity does not match');
    const state = await this.client.getInstanceState(name);
    const hostMounts = await incusHostMountLayout(this.config, opts, 'inspect', undefined, instance);
    assertIncusHostMountLayout(instance, hostMounts);
    const account = await this.accountDevices(opts);
    const managed = await this.managedDevices(opts);
    for (const [key, expected] of Object.entries(managed)) {
      if (!sameDevice(instance.devices[key], expected))
        throw new Error('Incus managed storage layout is missing or ambiguous; explicit recreation is required');
    }
    for (const [key, expected] of Object.entries(account)) {
      if (!sameDevice(instance.devices[key], expected))
        throw new Error("Incus account share layout is missing or ambiguous; rebuild required");
    }
    const storage = await this.storage();
    const preserveOwnership = await storage.preserveOwnership(opts);
    const persistent = await storage.devices(opts, opts.environmentJson.dockerEnabled, { docker: !!instance.devices.docker });
    for (const role of ["workspace", "agents"] as const) {
      if (!sameDevice(instance.devices[role], persistent[role]!))
        throw new Error("Incus persistent layout is missing or ambiguous; explicit recovery is required");
    }
    if (persistent.docker && !sameDevice(instance.devices.docker, persistent.docker)) {
      if (instance.devices.docker && (instance.devices.docker.source !== persistent.docker.source || instance.devices.docker.pool !== this.config.incusStoragePool))
        throw new Error("Incus Docker device identity is ambiguous");
      if (state.status === "Running") throw new Error("Restart the VM to attach native Docker storage");
      await this.client.updateInstanceDevices(name, { ...instance.devices, ...persistent }, undefined, instance);
    }
    if (state.status !== "Running") await this.client.startInstance(name);
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const result = await this.client.exec(name, ["true"]);
        if (result.returnCode === 0) { ready = true; break; }
      } catch { /* Agent becomes available after the guest has booted. */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("Incus worker agent did not become ready");
    try {
      await this.checkedExec(name, ["bash", "-ec", 'test "$(cat /usr/lib/agentor/bootstrap-generation)" = 3; mountpoint -q /workspace; mountpoint -q /home/agent/.agent-data']);
      // Bootstrap-generation3 images predating Host Mount integration used
      // -xdev alone, which still chowns nested mount roots. Refuse that image
      // before any ownership-repair service executes; never patch guest code.
      if (Object.keys(hostMounts.devices).length) {
        const supported = await this.client.exec(name, ['grep', '-Fq', '--', 'prune+=( -o -path "$literal" )',
          '/usr/lib/agentor/agentor-private-storage.sh']);
        if (supported.returnCode !== 0)
          throw new Error('Derived image predates safe host-mount ownership repair; rebuild the configured worker OCI image before starting');
      }
      if (preserveOwnership) {
        const supported = await this.client.exec(name, ['grep', '-Fxq', '--',
          'ownership_marker=/run/agentor/preserve-storage-ownership', '/usr/lib/agentor/agentor-private-storage.sh']);
        if (supported.returnCode !== 0)
          throw new Error('Derived image predates metadata-preserving storage startup; rebuild the configured worker OCI image before starting');
      }
      for (const v of opts.managedVolumes ?? [])
        await this.checkedExec(name, ['timeout', '15', 'mountpoint', '-q', '--', v.target]);
      for (const device of Object.values(hostMounts.devices))
        await this.checkedExec(name, ['timeout', '15', 'mountpoint', '-q', '--', device.path!]);
      await this.checkedExec(name, ["systemctl", "stop", "agentor-worker.service"]);
      await this.reprovisionManagedNetworks(opts, instance.config['volatile.uuid']!);
      if (Object.keys(account).length) {
        for (const device of Object.values(account)) await this.checkedExec(name, ["mountpoint", "-q", device.path!]);
        // Reproduce existing regular-file bind semantics. CLI atomic rename
        // then falls back to in-place writes; symlinks would break sharing.
        for (const mapping of AGENT_CREDENTIAL_MAPPINGS.filter((entry) => entry.fileBind !== false)) {
          await this.checkedExec(name, ["bash", "-ec", [
            'source="$1"; target="$2"', 'test -f "$source"', 'test ! -L "$source"', 'test "$(stat -c %h "$source")" = 1',
            // Replaced virtiofs files leave an unstatable pinned inode. Read
            // kernel mount metadata before touching the target, then detach
            // without canonicalizing it. Never force/lazily unmount a busy file.
            'if awk -v target="$target" \'$5 == target { mounted=1 } END { exit !mounted }\' /proc/self/mountinfo; then umount --internal-only --no-canonicalize -- "$target"; fi',
            'test ! -L "$target"',
            'mkdir -p "$(dirname "$target")"', 'if [ ! -e "$target" ]; then install -o 1000 -g 1000 -m 0600 /dev/null "$target"; fi',
            'test -f "$target"', 'mount --bind "$source" "$target"',
          ].join("; "), "agentor-bind", `/run/agentor/account-credentials/${mapping.fileName}`, mapping.containerPath]);
        }
      }
      await this.checkedExec(name, ["rm", "-f", "/tmp/worker-events", "/run/agentor/provisioned", "/run/agentor/worker.env",
        "/run/agentor/preserve-storage-ownership"]);
      await this.provision(opts, preserveOwnership);
      await this.checkedExec(name, ["systemctl", "stop", "docker", "docker.socket", "containerd", "agentor-docker-storage"]);
      if (opts.environmentJson.dockerEnabled) {
        await this.client.pushFile(name, "/run/agentor/docker-storage.json", JSON.stringify({
          serial: "incus_docker", volume: persistent.docker!.source,
          initialize: await storage.dockerInitializationAllowed(opts),
        }), { uid: 0, gid: 0, mode: 0o600 });
        await this.checkedExec(name, ["systemctl", "unmask", "docker", "docker.socket", "containerd", "agentor-docker-storage"]);
        await this.checkedExec(name, ["systemctl", "start", "agentor-docker-storage"]);
        await this.checkedExec(name, ["mountpoint", "-q", "/var/lib/docker"]);
        await storage.markDockerInitialized(opts);
      } else {
        await this.checkedExec(name, ["rm", "-f", "/run/agentor/docker-storage.json"]);
        // The local storage unit is gated by absent /run authorization. Unlike
        // vendor Docker units, masking it would overwrite an installed unit.
        await this.checkedExec(name, ["systemctl", "mask", "docker", "docker.socket", "containerd"]);
      }
      await this.checkedExec(name, ["systemctl", "start", "agentor-worker.service"]);
      await this.checkedExec(name, ["systemctl", "is-active", "--quiet", "agentor-worker.service"]);
      const workerDeadline = Date.now() + 120_000;
      let workerReady = false;
      while (Date.now() < workerDeadline) {
        await this.checkedExec(name, ["systemctl", "is-active", "--quiet", "agentor-worker.service"]);
        const result = await this.client.exec(name, ["grep", "-q", "^READY|", "/tmp/worker-events"]);
        if (result.returnCode === 0) { workerReady = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!workerReady) throw new Error("Incus worker service did not complete startup");
    } catch (error) {
      if (!recovery.leaveRunningOnFailure || state.status !== 'Running')
        await this.stop(opts, instance.config['volatile.uuid']).catch(() => {});
      throw error;
    }
  }

  private async provision(opts: IncusWorkerOptions, preserveOwnership = false): Promise<void> {
    const name = opts.containerName;
    await this.client.pushFile(name, "/run/agentor", "", { type: "directory", mode: 0o711 });
    if (preserveOwnership) await this.client.pushFile(name, '/run/agentor/preserve-storage-ownership',
      'agentor-preserve-storage-ownership-v1\n', { mode: 0o600, uid: 0, gid: 0 });
    const values: Record<string, string> = Object.fromEntries(renderUserEnvVars(opts.userEnv).map((line) => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const local = (opts.workerConfig ?? []).filter((entry) => entry.kind !== "secretFile")
      .map(({ key, value }) => ({ key, value }));
    values.WORKER_LOCAL_ENV = Buffer.from(JSON.stringify(local)).toString("base64");
    Object.assign(values, {
      ENVIRONMENT: JSON.stringify(opts.environmentJson),
      CAPABILITIES: JSON.stringify(opts.capabilitiesJson),
      INSTRUCTIONS: JSON.stringify(opts.instructionsJson),
      WORKER: JSON.stringify(opts.workerJson),
      ORCHESTRATOR_URL: this.config.incusInternalGatewayUrl,
      WORKER_CONTAINER_NAME: name, AGENTOR_RUNTIME_ROLE: "worker",
    });
    await this.client.pushFile(name, "/run/agentor-secrets", "", { type: "directory", mode: 0o711 });
    for (const file of opts.workerConfig ?? []) {
      if (file.kind !== "secretFile") continue;
      const parts = file.fileName?.split("/");
      if (!parts?.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")))
        throw new Error("Invalid worker secret-file name");
      let parent = "/run/agentor-secrets";
      for (const part of parts.slice(0, -1)) {
        parent += `/${part}`;
        await this.client.pushFile(name, parent, "", { type: "directory", mode: 0o711 });
      }
      await this.client.pushFile(name, `/run/agentor-secrets/${file.fileName}`, file.value,
        { mode: 0o600, uid: 1000, gid: 1000 });
    }
    await this.client.pushFile(name, "/home/agent/.ssh", "", { type: "directory", mode: 0o700, uid: 1000, gid: 1000 });
    await this.client.pushFile(name, "/home/agent/.ssh/authorized_keys", opts.sshAuthorizedKeys ?? "",
      { mode: 0o600, uid: 1000, gid: 1000 });
    // Publish service prerequisites only once all config/secrets/keys exist.
    await this.client.pushFile(name, "/run/agentor/worker.env", serializeIncusWorkerEnv(values),
      { mode: 0o640, uid: 0, gid: 1000 });
    await this.client.pushFile(name, "/run/agentor/provisioned", "agentor-runtime-v1\n", { mode: 0o600, uid: 0, gid: 0 });
  }

  async stop(target: string | IncusStorageOwner, incarnation?: string): Promise<void> {
    const name = typeof target === 'string' ? target : target.containerName;
    await this.assertOwned(name, typeof target === 'string' ? undefined : target.id,
      typeof target === 'string' ? undefined : target.userId, incarnation);
    const state = await this.client.getInstanceState(name);
    if (state.status !== "Stopped") await this.client.stopInstance(name, { timeout: 30 });
  }

  async refreshSshKeys(owner: IncusStorageOwner, content: string): Promise<void> {
    const instance = await this.assertOwned(owner.containerName, owner.id);
    if (instance.config["user.agentor.owner"] !== owner.userId)
      throw new Error("Incus worker account identity does not match");
    if ((await this.client.getInstanceState(owner.containerName)).status !== "Running") return;
    await this.client.pushFile(owner.containerName, "/home/agent/.ssh/authorized_keys", content,
      { mode: 0o600, uid: 1000, gid: 1000 });
  }

  async remove(target: string | IncusStorageOwner, incarnation?: string): Promise<void> {
    const name = typeof target === 'string' ? target : target.containerName;
    try {
      await this.stop(target, incarnation);
      await this.assertOwned(name, typeof target === 'string' ? undefined : target.id,
        typeof target === 'string' ? undefined : target.userId, incarnation);
      await this.client.deleteInstance(name);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
  }
}
