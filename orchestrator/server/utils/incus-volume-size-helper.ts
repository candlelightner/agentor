import type { Config } from './config';
import { IncusClient, IncusRequestRejected, type IncusInstance, type IncusCustomVolume } from './incus-client';
import { incusImageIdentity } from './incus-worker-image';
import { volumeError } from './managed-volume-store';
import type { ManagedVolumeSizingResource } from './managed-volume-inventory';

/** Bounded per-size-job cleanup state, not worker/storage transaction state.
 * Original compute/devices are never changed by this helper. */
export interface IncusSizeHelperState {
  installation: string;
  copy: boolean;
  pending?: { kind: 'copy' | 'create'; operation?: string };
  instance?: string;
  copyCreatedAt?: string;
}

const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const missing = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;
const MAX_OUTPUT = 32 * 1024;

/** One trusted derived-image VM, no NIC, accounts, runtime config or services.
 * Incus block volumes cannot be referenced by two instances even read-only:
 * a stopped-referenced source therefore uses a disposable native block copy. */
export class IncusVolumeSizeHelper {
  constructor(private config: Config, private client = IncusClient.fromConfig(config)) {}
  private name(id: string) { if (!idPattern.test(id)) throw volumeError(409, 'Invalid size helper identity.'); return `asz-${id}`; }
  private copyName(id: string) { this.name(id); return `agentor-size-${id}`; }
  private metadata(id: string, state: IncusSizeHelperState) {
    if (!idPattern.test(state.installation)) throw volumeError(409, 'Size helper installation identity is unavailable.');
    return { 'user.agentor.installation': state.installation, 'user.agentor.helper': 'volume-size', 'user.agentor.operation': id };
  }
  private matches(config: Record<string, string>, id: string, state: IncusSizeHelperState) {
    return Object.entries(this.metadata(id, state)).every(([key, value]) => config[key] === value) &&
      !config['user.agentor.id'] && !config['user.agentor.storage-role'] && !config['user.agentor.volume-id'];
  }
  private async instance(id: string, state: IncusSizeHelperState): Promise<IncusInstance | undefined> {
    let instance: IncusInstance;
    try { instance = await this.client.getInstance(this.name(id)); } catch (error) { if (missing(error)) return; throw error; }
    if (instance.name !== this.name(id) || instance.type !== 'virtual-machine' || !this.matches(instance.config, id, state) ||
        !idPattern.test(instance.config['volatile.uuid'] ?? '') || state.instance && instance.config['volatile.uuid'] !== state.instance)
      throw volumeError(409, 'Size helper ownership changed; resources retained.');
    return instance;
  }
  private async copy(id: string, state: IncusSizeHelperState): Promise<IncusCustomVolume | undefined> {
    let volume: IncusCustomVolume;
    try { volume = await this.client.getCustomVolume(this.config.incusStoragePool, this.copyName(id)); }
    catch (error) { if (missing(error)) return; throw error; }
    if (volume.name !== this.copyName(id) || volume.project !== this.config.incusProject || volume.type !== 'custom' ||
        volume.content_type !== 'block' || !this.matches(volume.config, id, state) || !Array.isArray(volume.used_by) ||
        !Number.isFinite(Date.parse(volume.created_at)) || state.copyCreatedAt && volume.created_at !== state.copyCreatedAt)
      throw volumeError(409, 'Size helper copy ownership changed; resources retained.');
    return volume;
  }

  /** Known accepted work must be terminal before deleting its resources.
   * Missing acknowledgement/operation is never inferred from name read-back. */
  async cleanup(id: string, state: IncusSizeHelperState, persist: (next?: IncusSizeHelperState) => Promise<void>) {
    this.metadata(id, state);
    if (state.pending) {
      const operation = state.pending.operation;
      if (!operation || !/^\/1\.0\/operations\/[a-f0-9-]+$/.test(operation))
        throw volumeError(409, 'Size helper submission is ambiguous; resources retained for recovery.');
      const observed = await this.client.request<{ status: string; status_code: number }>('GET', operation);
      if (!['Success', 'Failure', 'Cancelled'].includes(observed.status) || observed.status_code < 200)
        throw volumeError(409, 'Size helper operation is still pending; resources retained for recovery.');
      state = { ...state, pending: undefined }; await persist(state);
    }
    let instance = await this.instance(id, state);
    if (instance) {
      if (instance.status === 'Running') await this.client.stopInstance(instance.name, { force: true });
      instance = await this.instance(id, state);
      if (instance?.status !== 'Stopped') throw volumeError(409, 'Size helper is not stopped; resources retained.');
      await this.client.deleteInstance(instance.name);
      if (await this.instance(id, state)) throw volumeError(409, 'Size helper removal is incomplete.');
    }
    if (state.copy) {
      const volume = await this.copy(id, state);
      if (volume) {
        if (volume.used_by.length) throw volumeError(409, 'Size helper copy is still referenced; resources retained.');
        await this.client.deleteCustomVolume(this.config.incusStoragePool, volume.name);
      }
    }
    await persist(undefined);
  }

  async scan(id: string, source: ManagedVolumeSizingResource, initial: IncusSizeHelperState,
    persist: (next?: IncusSizeHelperState) => Promise<void>, assertSource: () => Promise<void>,
    signal: AbortSignal, scanner: string): Promise<string> {
    if (source.runtimeKind !== 'incus-vm' || source.live || !source.incus)
      throw volumeError(409, 'Offline sizing requires verified stopped or detached Incus storage.');
    let state = initial;
    const save = async (next: IncusSizeHelperState) => { await persist(next); state = next; };
    const submit = async (kind: 'copy' | 'create', operation: (accepted: (path?: string) => Promise<void>) => Promise<unknown>) => {
      signal.throwIfAborted(); await save({ ...state, pending: { kind } });
      try { await operation(async path => save({ ...state, pending: path ? { kind, operation: path } : undefined })); }
      catch (error) {
        if (error instanceof IncusRequestRejected) await save({ ...state, pending: undefined });
        throw error;
      }
      await save({ ...state, pending: undefined }); signal.throwIfAborted();
    };
    const metadata = this.metadata(id, state), name = this.name(id);
    try {
      if (await this.instance(id, state) || state.copy && await this.copy(id, state))
        throw volumeError(409, 'Size helper already exists; recover it before retrying.');
      const alias = await this.client.getImageAlias(this.config.incusWorkerImage);
      const image = incusImageIdentity(await this.client.getImage(alias.target));
      await assertSource();
      let backing = source.dockerName;
      if (state.copy) {
        await submit('copy', accepted => this.client.copyCustomVolume(this.config.incusStoragePool, source.dockerName,
          this.copyName(id), metadata, accepted));
        const copy = await this.copy(id, state);
        if (!copy || copy.used_by.length) throw volumeError(409, 'Size helper copy is unavailable or referenced.');
        await save({ ...state, copyCreatedAt: copy.created_at });
        backing = copy.name;
      }
      await assertSource(); signal.throwIfAborted();
      const block = source.incus.contentType === 'block';
      await submit('create', accepted => this.client.createInstance({ name, type: 'virtual-machine', profiles: [],
        source: { type: 'image', fingerprint: image.fingerprint },
        config: { ...metadata, 'security.secureboot': 'false', 'boot.autostart': 'false', 'limits.cpu': '1', 'limits.memory': '1GiB' },
        devices: { root: { type: 'disk', path: '/', pool: this.config.incusStoragePool },
          [block ? 'docker' : 'scan']: { type: 'disk', source: backing, pool: this.config.incusStoragePool,
            readonly: 'true', ...(block ? {} : { path: '/volume' }) } },
      }, accepted));
      // Capture the exact incarnation before any guest operation or cleanup.
      const created = await this.instance(id, state);
      if (!created) throw volumeError(409, 'Size helper create is unavailable.');
      await save({ ...state, instance: created.config['volatile.uuid'] });
      await this.client.startInstance(name);
      const deadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < deadline) {
        signal.throwIfAborted(); await this.instance(id, state);
        try { ready = (await this.client.exec(name, ['true'])).returnCode === 0; } catch { /* agent not ready */ }
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw volumeError(409, 'Size helper guest agent did not become ready.');
      const session = await this.client.execStream(name, ['systemd-run', '--scope', '--quiet', '--collect',
        '-p', 'MemoryMax=128M', '-p', 'CPUQuota=50%', '-p', 'TasksMax=16', 'timeout', '--kill-after=2', '60',
        'bash', '-ec', INCUS_OFFLINE_SCAN_MOUNT, 'offline-size', block ? 'block' : 'filesystem', scanner],
      { command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, signal, timeoutMs: 65_000 });
      let bytes = 0;
      const capture = async (stream: NodeJS.ReadableStream) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) { const b = Buffer.from(chunk); bytes += b.length;
          if (bytes > MAX_OUTPUT) throw volumeError(409, 'Size helper returned excessive output.'); chunks.push(b); }
        return Buffer.concat(chunks).toString();
      };
      try {
        session.stdin.end();
        const [stdout, _stderr, code] = await Promise.all([capture(session.stdout), capture(session.stderr), session.result]);
        signal.throwIfAborted(); await this.instance(id, state);
        if (code !== 0) throw volumeError(409, 'Offline storage is not clean/readable; no data was changed.');
        return stdout;
      } finally { session.close(); }
    } finally { await this.cleanup(id, state, persist); }
  }
}

export const INCUS_OFFLINE_SCAN_MOUNT = String.raw`
test ! -e /run/agentor/provisioned
if systemctl is-active --quiet agentor-worker; then exit 1; fi
if systemctl is-active --quiet docker; then exit 1; fi
if test "$1" = block; then
 disk=$(for candidate in /dev/disk/by-id/*incus_docker*; do test -b "$candidate" || continue; readlink -f -- "$candidate"; done | sort -u)
 test -n "$disk"; test -b "$disk"; test "$(blockdev --getro "$disk")" = 1
 test "$(blkid -o value -s TYPE "$disk")" = ext4
 state=$(dumpe2fs -h "$disk" 2>/dev/null)
 printf '%s\n' "$state" | grep -Eq '^Filesystem state: +clean$'
 if printf '%s\n' "$state" | grep -Eq '^Filesystem features:.*needs_recovery'; then exit 1; fi
 mkdir -p /volume; mount -t ext4 -o ro,noload,nodev,nosuid,noexec -- "$disk" /volume
else
 test "$1" = filesystem
fi
mountpoint -q /volume
findmnt -n -o OPTIONS --mountpoint /volume | tr ',' '\n' | grep -qx ro
exec node --max-old-space-size=96 -e "$2" /volume "$1" incus_scan
`;
