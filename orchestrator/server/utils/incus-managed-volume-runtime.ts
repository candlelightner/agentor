import type { Config } from './config';
import type { IncusInstance, IncusCustomVolume, IncusDevice } from './incus-client';
import { IncusWorkerRuntime } from './incus-worker-runtime';
import { backupInstallationId } from './backup-installation';
import { managedVolumeRuntimeKind, pathsOverlap, validatePersistenceTarget, volumeError, type StoredManagedVolume } from './managed-volume-store';
import type { IncusStorageOwner } from './incus-worker-storage';

/** Managed paths keep their existing store/policy. This adapter owns only the
 * Incus filesystem and retained-compute seeding operations, not a second
 * lifecycle/recovery coordinator. */
export class IncusManagedVolumeRuntime {
  private installation?: Promise<string>;
  constructor(private config: Config, readonly worker = new IncusWorkerRuntime(config)) {}
  private installationId() { return this.installation ??= backupInstallationId(this.config.dataDir); }
  private owner(v: StoredManagedVolume): IncusStorageOwner {
    return { id: v.workerId, userId: v.userId, containerName: `${this.config.containerPrefix}-${v.workerId}` };
  }
  private validateRecord(v: StoredManagedVolume) {
    if (managedVolumeRuntimeKind(v) !== 'incus-vm' || v.purpose !== 'persistent-path' ||
        !/^[a-f0-9-]{36}$/.test(v.id) || v.dockerName !== `agentor-persist-${v.id}` ||
        v.liveContainerId || v.previousRestartPolicy)
      throw volumeError(409, 'Managed storage backend or recovery identity is ambiguous. Data was retained.');
    validatePersistenceTarget(v.target);
    if (pathsOverlap(v.target, '/workspace'))
      throw volumeError(409, 'Workspace already has canonical persistence; overlapping managed storage is not allowed.');
  }
  // QEMU's virtiofs socket includes project/instance/device names (108 byte limit).
  // Short-key collisions are rejected before changing compute.
  deviceKey(v: StoredManagedVolume) { this.validateRecord(v); return `m${v.id.replaceAll('-', '').slice(0, 6)}`; }
  device(v: StoredManagedVolume): IncusDevice {
    this.validateRecord(v);
    return { type: 'disk', pool: this.config.incusStoragePool, source: v.dockerName, path: v.target };
  }
  matchesDevice(device: IncusDevice | undefined, v: StoredManagedVolume) {
    const expected = this.device(v);
    return !!device && Object.keys(device).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => device[key] === value);
  }

  async inspectVolume(v: StoredManagedVolume): Promise<IncusCustomVolume | undefined> {
    this.validateRecord(v);
    let found: IncusCustomVolume;
    try { found = await this.worker.client.getCustomVolume(this.config.incusStoragePool, v.dockerName); }
    catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return; throw error; }
    const c = found.config, owner = this.owner(v);
    if (found.name !== v.dockerName || found.type !== 'custom' || found.content_type !== 'filesystem' ||
        c['user.agentor.installation'] !== await this.installationId() || c['user.agentor.owner'] !== v.userId ||
        c['user.agentor.id'] !== v.workerId || c['user.agentor.volume-id'] !== v.id || c['user.agentor.target'] !== v.target)
      throw volumeError(409, 'Incus managed volume ownership, type or target does not match its durable record.');
    if (!Array.isArray(found.used_by))
      throw volumeError(503, 'Incus did not return authoritative managed-volume references. Data was retained.');
    for (const reference of found.used_by) {
      const url = new URL(reference, this.worker.client.endpoint);
      if (url.pathname !== `/1.0/instances/${owner.containerName}` || url.searchParams.get('project') !== this.config.incusProject)
        throw volumeError(409, 'Incus managed volume is referenced by another runtime. Data was retained.');
    }
    return found;
  }

  async ensureVolume(v: StoredManagedVolume) {
    let found = await this.inspectVolume(v);
    if (!found) {
      if (v.seeded) throw volumeError(409, 'Required persistent volume is missing. Restore it first; no empty replacement was created.');
      await this.worker.client.createCustomVolume(this.config.incusStoragePool, {
        name: v.dockerName, content_type: 'filesystem', config: {
          'user.agentor.installation': await this.installationId(), 'user.agentor.owner': v.userId,
          'user.agentor.id': v.workerId, 'user.agentor.volume-id': v.id, 'user.agentor.target': v.target,
        },
      });
      found = await this.inspectVolume(v);
    }
    if (!found) throw volumeError(503, 'Incus managed volume was not created.');
    return found;
  }

  async inspect(userId: string, workerId: string, handle: string): Promise<IncusInstance> {
    const incarnation = handle.startsWith('incus:') ? handle.slice(6) : '';
    const instance = await this.worker.client.getInstance(`${this.config.containerPrefix}-${workerId}`);
    if (!incarnation || instance.config['volatile.uuid'] !== incarnation ||
        !await this.worker.matchesWorkerIdentity(instance, workerId, userId))
      throw volumeError(409, 'Incus managed-storage source ownership or incarnation changed. Data was retained.');
    return instance;
  }

  private async exec(userId: string, workerId: string, handle: string, command: string[]) {
    const before = await this.inspect(userId, workerId, handle);
    if (before.status !== 'Running') throw volumeError(409, 'Start the retained VM before validating its persistence path.');
    const result = await this.worker.client.exec(before.name, command);
    await this.inspect(userId, workerId, handle);
    if (result.returnCode !== 0) throw volumeError(409, 'Incus persistence directory validation or copy failed. Original data was retained.');
    return result.stdout;
  }

  async validateTarget(userId: string, workerId: string, handle: string, target: string, allow?: StoredManagedVolume) {
    validatePersistenceTarget(target);
    const instance = await this.inspect(userId, workerId, handle);
    for (const [key, device] of Object.entries(instance.expanded_devices ?? instance.devices)) {
      if (device.type !== 'disk' || !device.path || device.path === '/') continue;
      if (allow && key === this.deviceKey(allow) && this.matchesDevice(device, allow)) continue;
      if (pathsOverlap(device.path, target)) throw volumeError(409, 'Persistent target overlaps an existing Incus disk attachment.');
    }
    await this.exec(userId, workerId, handle, ['timeout', '15', 'python3', '-c', INCUS_PERSISTENCE_TARGET_CHECK,
      target, allow && this.matchesDevice(instance.devices[this.deviceKey(allow)], allow) ? target : '']);
    return instance;
  }

  async removeStaging(v: StoredManagedVolume) {
    if (v.seeded) throw volumeError(409, 'Populated volumes cannot be removed as staging.');
    const found = await this.inspectVolume(v);
    if (!found) return;
    if (found.used_by?.length) throw volumeError(409, 'Staging volume is still attached. Retained compute must be inspected first.');
    await this.worker.client.deleteCustomVolume(this.config.incusStoragePool, v.dockerName);
  }

  async delete(v: StoredManagedVolume) {
    const found = await this.inspectVolume(v);
    if (!found) return;
    if (found.used_by?.length) throw volumeError(409, 'Volume is still referenced by an Incus instance; it was not deleted.');
    await this.worker.client.deleteCustomVolume(this.config.incusStoragePool, v.dockerName);
  }

  /** Retain the original root until the metadata-faithful copy AND seeded
   * store write succeed. Lost responses leave exact-owned staging for retry.
   * Standard Agentor units are quiesced by an unprovisioned new boot; arbitrary
   * guest-created boot units are not a VM-wide snapshot guarantee. */
  async seed(handle: string, v: StoredManagedVolume, commitSeeded: () => Promise<void>) {
    this.validateRecord(v);
    if (v.seeded) { await this.ensureVolume(v); return; }
    const owner = this.owner(v), incarnation = handle.startsWith('incus:') ? handle.slice(6) : '';
    let instance = await this.inspect(v.userId, v.workerId, handle);
    const key = this.deviceKey(v), staging = `/run/agentor-volume-seed/${v.id}`;
    const stageDevice: IncusDevice = { ...this.device(v), path: staging };
    const priorDevice = instance.devices[key];
    if (priorDevice && JSON.stringify(Object.entries(priorDevice).sort()) !== JSON.stringify(Object.entries(stageDevice).sort()))
      throw volumeError(409, 'Incus staging device conflicts with retained compute. Data was retained.');
    // Validate source before stopping on the first attempt. A stopped retry
    // is booted below only after proving the staging attachment identity.
    if (instance.status === 'Running') await this.validateTarget(v.userId, v.workerId, handle, v.target);
    await this.worker.stop(owner, incarnation);
    instance = await this.inspect(v.userId, v.workerId, handle);
    if (priorDevice) {
      await this.ensureVolume(v); // Validate the attachment before detaching it.
      const devices = { ...instance.devices }; delete devices[key];
      await this.worker.client.updateInstanceDevices(owner.containerName, devices);
      instance = await this.inspect(v.userId, v.workerId, handle);
    }
    await this.removeStaging(v);
    await this.ensureVolume(v);
    await this.worker.client.updateInstanceDevices(owner.containerName, { ...instance.devices, [key]: stageDevice });
    await this.inspect(v.userId, v.workerId, handle);
    try {
      await this.worker.client.startInstance(owner.containerName);
      const deadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < deadline) {
        try { if ((await this.worker.client.exec(owner.containerName, ['true'])).returnCode === 0) { ready = true; break; } }
        catch { /* incus-agent is available only after boot */ }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw volumeError(503, 'Retained Incus guest agent did not become ready. Data was retained.');
      await this.exec(v.userId, v.workerId, handle, ['timeout', '15', 'bash', '-ec',
        'test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; mountpoint -q "$1"', 'seed-preflight', staging]);
      await this.validateTarget(v.userId, v.workerId, handle, v.target);
      await this.exec(v.userId, v.workerId, handle, ['timeout', '150', 'bash', '-ec', INCUS_PERSISTENCE_COPY,
        'seed-copy', v.target, staging]);
      // The callback writes only seeded authority. It must not apply pending
      // image/environment/bootstrap settings or remove the retained source.
      await commitSeeded();
    } finally {
      await this.worker.stop(owner, incarnation);
    }
  }
}

export const INCUS_PERSISTENCE_TARGET_CHECK = String.raw`
import os, stat, sys, re
target, allowed = sys.argv[1:]
current = ''
for component in target[1:].split('/'):
    current += '/' + component
    try: info = os.lstat(current)
    except FileNotFoundError: break
    if not stat.S_ISDIR(info.st_mode): raise RuntimeError('Persistent paths require directories without symlink components')
with open('/proc/self/mountinfo') as mounts:
    for line in mounts:
        mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4])
        if mount == '/' or mount == allowed: continue
        if mount == target or mount.startswith(target + '/') or target.startswith(mount + '/'):
            raise RuntimeError('Persistent path overlaps a guest-observed mount')
`;

export const INCUS_PERSISTENCE_COPY = String.raw`
set -o pipefail
if test -d "$1"; then
 tar --format=pax --xattrs --xattrs-include='*' --acls --numeric-owner -cpf - -C "$1" . |
 tar --xattrs --xattrs-include='*' --acls --numeric-owner -xpf - -C "$2"
else
 test ! -e "$1" && test ! -L "$1"
 chown 1000:1000 "$2"; chmod 755 "$2"
fi
sync -f "$2"
`;
