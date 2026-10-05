import type { Config } from "./config";
import type { DockerService } from "./docker";
import { IncusClient, type IncusInstance, type IncusDevice } from "./incus-client";
import { AGENT_CREDENTIAL_MAPPINGS } from "./user-credentials";
import { join } from "node:path";
import { renderUserEnvVars } from "./user-env-store";
import { backupInstallationId } from "./backup-installation";
import { IncusWorkerStorage, type IncusStorageOwner } from "./incus-worker-storage";
import { resolveIncusPrimaryLease } from "./incus-worker-network";
import type { ContainerStatus } from "../../shared/types";
import { IncusWorkerCommands } from "./incus-worker-commands";
import { withOwnerWorkerRuntimeSetup } from "./worker-lifecycle-coordinator";
import type { WorkerConfigRevision } from './worker-config-store';
import { incusImageIdentity, sameIncusImageSource, type IncusWorkerImageIdentity } from './incus-worker-image';
import { IncusManagedVolumeRuntime } from './incus-managed-volume-runtime';
import type { StoredManagedVolume } from './managed-volume-store';
import { incusManagedNetworkAuthority } from './incus-managed-network-identity';

export type IncusWorkerOptions = Parameters<DockerService["createWorkerContainer"]>[0] & {
  sshAuthorizedKeys?: string;
  configurationRevision?: WorkerConfigRevision;
  recreationNonce?: string;
  /** Authoritative internal records, never accepted from worker/user payloads. */
  managedVolumes?: StoredManagedVolume[];
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

  async matchesWorkerIdentity(instance: IncusInstance, workerId: string, userId?: string): Promise<boolean> {
    return instance.type === "virtual-machine" && instance.config["user.agentor.id"] === workerId &&
      instance.name === `${this.config.containerPrefix}-${workerId}` &&
      instance.config["user.agentor.installation"] === await this.installationId() &&
      (!userId || instance.config["user.agentor.owner"] === userId);
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
    if (opts.mounts?.length || opts.hardwareDevices?.length)
      throw new Error("Incus mounts and hardware require their feature integration");
    if (opts.credentialBinds?.length && !opts.storageManager)
      throw new Error("Incus account shares require authoritative platform storage");
    if (opts.dockerEnabled !== undefined && opts.dockerEnabled !== opts.environmentJson.dockerEnabled)
      throw new Error("Docker capability must match the resolved worker environment");
    if (opts.image) throw new Error("A custom OCI image requires its derived Incus image mapping");
  }

  private async accountDevices(opts: IncusWorkerOptions): Promise<Record<string, IncusDevice>> {
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
    marker: { nonce: string; originalIncarnation?: string; replacementIncarnation?: string; initialCreate?: true }):
    Promise<{ status: 'active' | 'archived'; incarnation?: string }> {
    if (!marker || typeof marker.nonce !== 'string' || !marker.nonce || marker.nonce.length > 128 ||
        [marker.originalIncarnation, marker.replacementIncarnation].some((id) =>
          id !== undefined && (typeof id !== 'string' || !id || id.length > 128)) ||
        (marker.initialCreate !== undefined && marker.initialCreate !== true) ||
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
    await this.assertReady();
    // These features are integrated in the following storage/device phases.
    // Refuse them here rather than silently placing data on disposable rootfs.
    this.validateOptions(opts);
    if (opts.containerName !== `${this.config.containerPrefix}-${opts.id}`)
      throw new Error("Incus worker name must match its WorkerRecord identity");
    const storage = await this.storage();
    const source = await storage.imageIdentity(opts);
    const fingerprint = existing ? await this.resolveImage(existing.fingerprint)
      : source ? await this.resolveStoredImage(source) : await this.resolveImage();
    const identity = incusImageIdentity(await this.client.getImage(fingerprint));
    if (source && !sameIncusImageSource(source, identity)) throw new Error('Incus reconstruction image source changed');
    const account = await this.accountDevices(opts);
    const persistent = await storage.devices(opts, opts.environmentJson.dockerEnabled,
      existing && { docker: existing.docker });
    await storage.recordImageIdentity(opts, identity);
    const instance = await this.client.createInstance({
      name: opts.containerName, type: "virtual-machine", profiles: [],
      source: { type: "image", fingerprint },
      config: {
        "user.agentor.id": opts.id,
        "user.agentor.owner": opts.userId,
        "user.agentor.installation": await this.installationId(),
        "user.agentor.runtime-generation": "1",
        ...(opts.recreationNonce ? { 'user.agentor.recreation': opts.recreationNonce } : {}),
        "security.secureboot": "false",
        "boot.autostart": "false",
        ...(opts.memoryLimit ? { "limits.memory": opts.memoryLimit } : {}),
        ...(opts.cpuLimit ? { "limits.cpu": String(Math.max(1, Math.ceil(opts.cpuLimit))) } : {}),
      },
      devices: {
        ...persistent,
        ...account,
        ...await this.managedDevices(opts),
        root: { type: "disk", path: "/", pool: this.config.incusStoragePool },
        eth0: { type: "nic", name: "eth0", network: this.config.incusNetwork,
          "security.mac_filtering": "true", "security.ipv4_filtering": "true", "security.ipv6_filtering": "true" },
      },
    });
    if (opts.start !== false) await this.start(opts);
    return instance;
  }

  private async checkedExec(name: string, command: string[]): Promise<void> {
    const result = await this.client.exec(name, command);
    if (result.returnCode !== 0) throw new Error(`Incus worker bootstrap command failed (${command[0]}, exit ${result.returnCode})`);
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
    if (instance.config['user.agentor.owner'] !== opts.userId)
      throw new Error('Incus worker account identity does not match');
    const state = await this.client.getInstanceState(name);
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
    const persistent = await storage.devices(opts, opts.environmentJson.dockerEnabled, { docker: !!instance.devices.docker });
    for (const role of ["workspace", "agents"] as const) {
      if (!sameDevice(instance.devices[role], persistent[role]!))
        throw new Error("Incus persistent layout is missing or ambiguous; explicit recovery is required");
    }
    if (persistent.docker && !sameDevice(instance.devices.docker, persistent.docker)) {
      if (instance.devices.docker && (instance.devices.docker.source !== persistent.docker.source || instance.devices.docker.pool !== this.config.incusStoragePool))
        throw new Error("Incus Docker device identity is ambiguous");
      if (state.status === "Running") throw new Error("Restart the VM to attach native Docker storage");
      await this.client.updateInstanceDevices(name, { ...instance.devices, ...persistent });
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
      for (const v of opts.managedVolumes ?? [])
        await this.checkedExec(name, ['timeout', '15', 'mountpoint', '-q', '--', v.target]);
      await this.checkedExec(name, ["systemctl", "stop", "agentor-worker.service"]);
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
      await this.checkedExec(name, ["rm", "-f", "/tmp/worker-events", "/run/agentor/provisioned", "/run/agentor/worker.env"]);
      await this.provision(opts);
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

  private async provision(opts: IncusWorkerOptions): Promise<void> {
    const name = opts.containerName;
    await this.client.pushFile(name, "/run/agentor", "", { type: "directory", mode: 0o711 });
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
