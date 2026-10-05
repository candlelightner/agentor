import type { Config } from './config';
import type { IncusInstance, IncusCustomVolume, IncusDevice } from './incus-client';
import { IncusWorkerRuntime } from './incus-worker-runtime';
import { backupInstallationId } from './backup-installation';
import { managedVolumeRuntimeKind, pathsOverlap, validatePersistenceTarget, volumeError, assertIncusLiveResolved, type StoredManagedVolume } from './managed-volume-store';
import type { IncusStorageOwner } from './incus-worker-storage';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IncusOfflineArchiveHelper } from './incus-offline-archive-helper';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
      if (v.seeded || v.incusLive) throw volumeError(409, 'Required persistent volume is missing. Restore it first; no empty replacement was created.');
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

  /** Fixed readonly helper capture; no source provisioning, lifecycle change,
   * allocation/repair, freezer or weakening of general volume validation. */
  async captureArchive(v: StoredManagedVolume, options: { state: 'running' | 'stopped' | 'archived';
    handle?: string; archivePath: string; maxBytes: number; signal?: AbortSignal },
    validateRecords: () => void | Promise<void>) {
    assertIncusLiveResolved(v); this.validateRecord(v);
    if (!v.attached || !v.seeded || v.state !== 'ready' || v.operation && v.operation.stage !== 'complete' ||
        !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
      throw volumeError(409, 'Managed archive source is not settled canonical storage.');
    const owner = this.owner(v), key = this.deviceKey(v);
    const absent = async () => {
      try { await this.worker.client.getInstance(owner.containerName); }
      catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return; throw error; }
      throw volumeError(409, 'Archived managed capture has unexpected compute.');
    };
    const original = options.state === 'archived' ? undefined
      : await this.inspect(v.userId, v.workerId, options.handle ?? '');
    if (!original) {
      if (options.handle) throw volumeError(409, 'Archived managed capture has a stale compute handle.');
      await absent();
    } else if (original.status !== (options.state === 'running' ? 'Running' : 'Stopped'))
      throw volumeError(409, 'Managed capture compute state changed.');
    const before = await this.inspectVolume(v);
    if (!before || before.project !== this.config.incusProject || !before.created_at ||
        !Number.isFinite(Date.parse(before.created_at)))
      throw volumeError(409, 'Managed capture storage identity is unavailable.');
    if (original) for (const devices of [original.devices, original.expanded_devices ?? original.devices]) {
      const sources = Object.entries(devices).filter(([, device]) => device.type === 'disk' &&
        device.pool === this.config.incusStoragePool && device.source === v.dockerName);
      if (!this.matchesDevice(devices[key], v) || sources.length !== 1 || sources[0]?.[0] !== key)
        throw volumeError(409, 'Managed capture source attachment is ambiguous.');
    }
    const references = (values: string[]) => values.map(ref => {
      const url = new URL(ref, this.worker.client.endpoint);
      if (url.origin !== new URL(this.worker.client.endpoint).origin || url.username || url.password || url.hash ||
          url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== this.config.incusProject ||
          [...url.searchParams.keys()].some(key => key !== 'project'))
        throw volumeError(409, 'Managed archive reference is foreign.');
      return url.pathname;
    }).sort();
    const baseline = original ? [`/1.0/instances/${owner.containerName}`] : [];
    if (JSON.stringify(references(before.used_by)) !== JSON.stringify(baseline))
      throw volumeError(409, 'Managed archive source references are ambiguous.');
    const configuration = (config: Record<string, string>) => JSON.stringify(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
    const assertSource = async (helperName?: string) => {
      // Do not consult AbortSignal here: known helper removal still needs a
      // source proof after cancellation, before clearing its private receipt.
      await validateRecords();
      if (original) {
        const current = await this.inspect(v.userId, v.workerId, options.handle!);
        if (current.status !== original.status || JSON.stringify(current.devices) !== JSON.stringify(original.devices) ||
            JSON.stringify(current.expanded_devices) !== JSON.stringify(original.expanded_devices))
          throw volumeError(409, 'Managed archive source compute changed.');
      } else await absent();
      const current = await this.worker.client.getCustomVolume(this.config.incusStoragePool, v.dockerName);
      const expected = [...baseline, ...(helperName ? [`/1.0/instances/${helperName}`] : [])].sort();
      if (current.name !== before.name || current.project !== before.project || current.type !== before.type ||
          current.content_type !== before.content_type || current.created_at !== before.created_at ||
          configuration(current.config) !== configuration(before.config) || !Array.isArray(current.used_by) ||
          JSON.stringify(references(current.used_by)) !== JSON.stringify(expected))
        throw volumeError(409, 'Managed archive source authority changed.');
      await validateRecords();
    };
    await assertSource();
    let bytes = 0;
    await new IncusOfflineArchiveHelper(this.config, this.worker.client, await this.installationId())
      .withGuest(owner, { managed: v.dockerName }, assertSource, options.signal, async (name, assertHelper) => {
        const validate = async () => { await assertHelper(); await assertSource(name); };
        const stream = await this.worker.openOfflineManagedArchive(name, validate, options.signal);
        await pipeline(stream, new Transform({ transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(bytes > options.maxBytes ? new Error('Managed archive exceeds aggregate byte limit') : null, chunk);
        } }), createWriteStream(options.archivePath, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
      });
    await assertSource(); return bytes;
  }

  private async exec(userId: string, workerId: string, handle: string, command: string[]) {
    const before = await this.inspect(userId, workerId, handle);
    if (before.status !== 'Running') throw volumeError(409, 'Start the retained VM before validating its persistence path.');
    const result = await this.worker.client.exec(before.name, command);
    await this.inspect(userId, workerId, handle);
    if (result.returnCode !== 0) throw Object.assign(
      volumeError(409, 'Incus persistence directory validation or copy failed. Original data was retained.'),
      { guestExitCode: result.returnCode, guestStep: command[0] === 'timeout' ? command[2] : command[0] });
    return result.stdout;
  }

  /** Called under the existing lifecycle fence: do not use workerCommands,
   * which would reacquire that queue. Files and leaf symlinks are backup-only;
   * missing/unreadable paths and changed source incarnations fail closed. */
  async isSelectionDirectory(userId: string, workerId: string, handle: string, target: string, allowMissing = false) {
    const before = await this.inspect(userId, workerId, handle);
    if (before.status !== 'Running') throw volumeError(409, 'Start the retained VM before changing directory selections.');
    const result = await this.worker.client.exec(before.name, ['timeout', '15', 'python3', '-c',
      INCUS_SELECTION_DIRECTORY_CHECK, target], { command: [], user: 1000, group: 1000 });
    await this.inspect(userId, workerId, handle);
    if (result.returnCode === 0 && allowMissing && result.stdout.trim() === 'missing') return false;
    if (result.returnCode !== 0 || !['directory', 'backup-only'].includes(result.stdout.trim()))
      throw volumeError(409, 'Backup selection is missing or unreadable. Previous configuration was retained.');
    return result.stdout.trim() === 'directory';
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
    assertIncusLiveResolved(v);
    if (v.seeded) throw volumeError(409, 'Populated volumes cannot be removed as staging.');
    const found = await this.inspectVolume(v);
    if (!found) return;
    if (found.used_by?.length) throw volumeError(409, 'Staging volume is still attached. Retained compute must be inspected first.');
    await this.worker.client.deleteCustomVolume(this.config.incusStoragePool, v.dockerName);
  }

  async delete(v: StoredManagedVolume) {
    assertIncusLiveResolved(v);
    const found = await this.inspectVolume(v);
    if (!found) return;
    if (found.used_by?.length) throw volumeError(409, 'Volume is still referenced by an Incus instance; it was not deleted.');
    await this.worker.client.deleteCustomVolume(this.config.incusStoragePool, v.dockerName);
  }

  /** Selection-time preflight snapshot, not canonical backing: applications
   * continue writing the original directory. seed() MUST recopy it before a
   * later rebuild/archive discards that root. Hotplug needs no VM reboot. */
  async stageSelection(handle: string, v: StoredManagedVolume) {
    assertIncusLiveResolved(v);
    this.validateRecord(v);
    if (v.seeded) throw volumeError(409, 'Canonical managed data cannot be overwritten by a backup selection.');
    await this.validateTarget(v.userId, v.workerId, handle, v.target);
    const instance = await this.inspect(v.userId, v.workerId, handle);
    const key = this.deviceKey(v), staging = `/run/agentor-volume-seed/${v.id}`;
    if (instance.devices[key]) throw volumeError(409, 'Selection staging has an existing device. Recover it before retrying.');
    // A previous provisional copy is never canonical. Start with an empty,
    // exact-owned detached staging volume so deleted files cannot reappear.
    try { await this.removeStaging(v); await this.ensureVolume(v); }
    catch (error) { throw this.ambiguousStaging(error); }
    try {
      try {
        const attachTo = await this.inspect(v.userId, v.workerId, handle);
        if (attachTo.devices[key]) throw new Error('Selection staging device changed before attachment.');
        await this.worker.client.updateInstanceDevices(attachTo.name, { ...attachTo.devices,
          [key]: { ...this.device(v), path: staging } }, undefined, attachTo);
      } catch (error) { throw this.ambiguousStaging(error); }
      await this.exec(v.userId, v.workerId, handle, ['timeout', '15', 'mountpoint', '-q', '--', staging]);
      await this.exec(v.userId, v.workerId, handle, ['timeout', '150', 'bash', '-ec', INCUS_PERSISTENCE_COPY,
        'selection-copy', v.target, staging]);
    } finally {
      try {
        // Even a lost successful attach response must be inspected. Never
        // replace whatever now owns the name/device with a stale device map.
        const current = await this.inspect(v.userId, v.workerId, handle);
        const device = current.devices[key];
        if (device) {
          const expected = { ...this.device(v), path: staging };
          if (Object.keys(device).length !== Object.keys(expected).length ||
              Object.entries(expected).some(([field, value]) => device[field] !== value))
            throw volumeError(409, 'Selection staging identity changed. Compute and storage were retained.');
          const devices = { ...current.devices }; delete devices[key];
          await this.worker.client.updateInstanceDevices(current.name, devices, undefined, current);
        }
        const detached = await this.inspect(v.userId, v.workerId, handle);
        if (detached.devices[key]) throw new Error('Selection staging device was not removed.');
        const found = await this.inspectVolume(v);
        if (found?.used_by.length) throw volumeError(409, 'Selection staging is still referenced. Recover it before retrying.');
      } catch (error) { throw this.ambiguousStaging(error); }
    }
  }

  private ambiguousStaging(error: unknown) {
    return Object.assign(volumeError(409, 'Incus selection staging operation is ambiguous. Its recovery record, storage and original directory were retained.'),
      { incusStagingAmbiguous: true, cause: error });
  }

  private async liveProof(handle: string, v: StoredManagedVolume, marker: string, seconds = 15) {
    const intent = v.incusLive!;
    return JSON.parse(await this.exec(v.userId, v.workerId, handle, ['timeout', String(seconds + 2), 'python3', '-I', '-c',
      INCUS_LIVE_PROOF, intent.id, intent.bootId, marker, String(seconds)])) as Record<string, unknown>;
  }
  private async liveSignal(handle: string, v: StoredManagedVolume, marker: string) {
    await this.exec(v.userId, v.workerId, handle, ['python3', '-I', '-c', INCUS_LIVE_SIGNAL,
      v.incusLive!.id, v.incusLive!.bootId, marker]);
  }

  /** Existing owner/worker fence is held by the caller. No ordinary exec
   * adapter may run while the guest agent is exempt from the freezer. */
  async mountLive(handle: string, initial: StoredManagedVolume, persist: (v: StoredManagedVolume) => Promise<void>) {
    assertIncusLiveResolved(initial); this.validateRecord(initial);
    if (!initial.attached) throw volumeError(409, 'Reattach the volume before live application.');
    let instance = await this.validateTarget(initial.userId, initial.workerId, handle, initial.target, initial.seeded ? initial : undefined);
    const key = this.deviceKey(initial);
    if (initial.seeded && this.matchesDevice(instance.devices[key], initial)) {
      await this.ensureVolume(initial);
      await this.exec(initial.userId, initial.workerId, handle, ['mountpoint', '-q', '--', initial.target]);
      return;
    }
    if (instance.devices[key]) throw volumeError(409, 'Live persistence device conflicts with retained compute.');
    // Provisional selection copies are not canonical. Never reuse their stale
    // bytes when live adoption follows continued rootfs writes/deletions.
    if (!initial.seeded) await this.removeStaging(initial);
    await this.ensureVolume(initial);
    const helpers = await Promise.all(['incus-volume-live-helper.py', 'volume-mount-helper.py'].map(trustedLiveHelper));
    const bootId = (await this.exec(initial.userId, initial.workerId, handle, ['cat', '/proc/sys/kernel/random/boot_id'])).trim();
    const incarnation = handle.slice(6), uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    if (!uuid.test(bootId) || !uuid.test(incarnation)) throw volumeError(409, 'Live guest boot or incarnation is unavailable.');
    const agent = (await this.exec(initial.userId, initial.workerId, handle, ['systemctl', 'show', '-p', 'MainPID', '--value', 'incus-agent'])).trim();
    if (!/^[1-9][0-9]*$/.test(agent) || agent === '1') throw volumeError(409, 'Incus guest agent PID is unavailable.');
    let v = structuredClone(initial);
    const save = async (next: StoredManagedVolume) => { await persist(next); v = structuredClone(next); };
    await save({ ...v, incusLive: { id: randomUUID(), incarnation, bootId, attachment: 'not-submitted' } });
    try {
      const path = `/run/agentor/live-volumes/${v.incusLive!.id}`;
      await this.exec(v.userId, v.workerId, handle, ['install', '-d', '-m', '700', '--', path]);
      for (const [index, name] of ['incus-volume-live-helper.py', 'volume-mount-helper.py'].entries())
        await this.worker.client.pushFile(instance.name, `${path}/${name}`, helpers[index]!, { mode: 0o600 });
      await this.exec(v.userId, v.workerId, handle, ['bash', '-ec',
        'umask 077; nohup python3 -I "$1/incus-volume-live-helper.py" "$2" "$3" "$4" "$5" "$6" >"$1/log" 2>&1 </dev/null &',
        'agentor-live-volume', path, v.target, v.seeded ? 'seeded' : 'new', agent, bootId, v.incusLive!.id]);
      await this.liveProof(handle, v, 'armed');
      await this.liveSignal(handle, v, 'begin');
      const ready = await this.liveProof(handle, v, 'ready', 120);
      if (ready.sourceSynced !== true) throw volumeError(409, 'Original live source sync was not proven.');
      await this.liveSignal(handle, v, 'request-attach');
      await this.liveProof(handle, v, 'attach-armed');
      // This write precedes the only canonical attachment submission. Lost
      // response/ack persistence is never permission to resend or detach it.
      await save({ ...v, incusLive: { ...v.incusLive!, attachment: 'unknown' } });
      instance = await this.inspect(v.userId, v.workerId, handle);
      if (instance.devices[key]) throw volumeError(409, 'Canonical device changed before live attachment.');
      await this.worker.client.updateInstanceDevices(instance.name, { ...instance.devices, [key]: this.device(v) }, async operation => {
        await save({ ...v, incusLive: { ...v.incusLive!, attachment: operation ? 'accepted' : 'settled', operation } });
      }, instance);
      await save({ ...v, incusLive: { ...v.incusLive!, attachment: 'settled' } });
      instance = await this.inspect(v.userId, v.workerId, handle);
      if (!this.matchesDevice(instance.devices[key], v)) throw volumeError(409, 'Canonical live attachment is not authoritative.');
      await this.exec(v.userId, v.workerId, handle, ['timeout', '15', 'bash', '-ec',
        'until mountpoint -q -- "$1"; do sleep .05; done', 'live-mount-ready', v.target]);
      await this.liveSignal(handle, v, 'mount-settled');
      await this.liveProof(handle, v, 'copied', 120);
      await save({ ...v, seeded: true }); // Data authority BEFORE writer release.
      await this.liveSignal(handle, v, 'release');
      await this.liveProof(handle, v, 'restored');
      await save({ ...v, incusLive: undefined });
    } catch (error) {
      // Recovery only consumes acknowledged terminal operations and proven
      // durable data. Any ambiguity retains both sources and the quarantine.
      try { await this.recoverLive(v, persist); }
      catch { /* retained intent fences all ordinary lifecycle and commands */ }
      throw Object.assign(volumeError(409, 'Live persistence failed. Original and volume data were retained; retry storage recovery before changing compute.'), { cause: error });
    }
  }

  /** Bounded per-volume recovery, also used after Orchestrator restart. Unknown
   * submission or uncommitted data after a different boot cannot be adopted. */
  async recoverLive(initial: StoredManagedVolume, persist: (v: StoredManagedVolume) => Promise<void>) {
    if (!initial.incusLive) return;
    this.validateRecord(initial);
    let v = structuredClone(initial), intent = v.incusLive!, handle = `incus:${intent.incarnation}`;
    const save = async (next: StoredManagedVolume) => { await persist(next); v = structuredClone(next); intent = v.incusLive!; };
    let instance = await this.inspect(v.userId, v.workerId, handle);
    const key = this.deviceKey(v), found = await this.inspectVolume(v);
    if (!found) throw volumeError(409, 'Live recovery volume is missing; no replacement was allocated.');
    if (intent.attachment === 'unknown') throw volumeError(409, 'Live device submission has unknown authority. Both sources remain quarantined.');
    if (intent.attachment === 'accepted') {
      // Observe the exact operation. Failure is terminal too, but timeout,
      // missing operation and transport failure do not establish settlement.
      try { await this.worker.client.waitForOperation(intent.operation!); }
      catch {
        const operation = await this.worker.client.request<{ status: string }>('GET', intent.operation!);
        if (operation.status !== 'Failure' && operation.status !== 'Success')
          throw volumeError(409, 'Live device operation is not terminal; data remains quarantined.');
      }
      await save({ ...v, incusLive: { ...intent, attachment: 'settled' } });
      instance = await this.inspect(v.userId, v.workerId, handle);
    }
    if (instance.devices[key] && !this.matchesDevice(instance.devices[key], v))
      throw volumeError(409, 'Live recovery device identity changed. All data was retained.');
    if (intent.attachment === 'not-submitted') {
      if (instance.devices[key] || found.used_by.length) throw volumeError(409, 'Unsubmitted live recovery unexpectedly has an attachment.');
      if (instance.status === 'Running') {
        let restored = false;
        try { await this.liveProof(handle, v, 'safe-original'); restored = true; }
        catch {
          if (v.seeded) throw volumeError(409, 'Seeded reattachment restoration is unresolved. Data remains quarantined.');
          // Without independent no-thaw containment, wait for restoration.
          await this.liveProof(handle, v, 'frozen-source');
        }
        if (restored) { await save({ ...v, incusLive: undefined }); return; }
        await this.worker.client.stopInstance(instance.name, { force: true });
      }
      instance = await this.inspect(v.userId, v.workerId, handle);
      const after = await this.inspectVolume(v);
      if (instance.status !== 'Stopped' || instance.devices[key] || !after || after.used_by.length)
        throw volumeError(409, 'Unsubmitted live recovery is not contained and detached.');
      // No canonical submission occurred. Both fresh staging and an existing
      // seeded volume stay unchanged; reattachment can be retried later.
      await save({ ...v, incusLive: undefined });
      return;
    }
    if (v.seeded) {
      if (!this.matchesDevice(instance.devices[key], v)) throw volumeError(409, 'Committed live volume lost its canonical attachment.');
      if (instance.status === 'Running') {
        // Once release happened, the earlier copy sync is stale: writers may
        // have dirty canonical bytes. Never power-cut them to clear metadata.
        // Same-boot restored proof permits a non-disruptive final commit retry;
        // another boot or incomplete restoration stays quarantined.
        await this.liveProof(handle, v, 'restored');
        await this.exec(v.userId, v.workerId, handle, ['mountpoint', '-q', '--', v.target]);
      } else if (instance.status !== 'Stopped') throw volumeError(409, 'Committed live recovery compute state is ambiguous.');
      await save({ ...v, incusLive: undefined });
      return;
    }
    if (!intent.rollback) {
      // Before a cold stop, prove the synced original and all original writers
      // still frozen in this exact boot. A stopped/rebooted guest has lost the
      // ephemeral proof and therefore stays quarantined instead of guessing.
      if (instance.status !== 'Running') throw volumeError(409, 'Uncommitted live source has lost its boot proof. Both copies were retained.');
      await this.liveProof(handle, v, 'frozen-source');
    }
    if (intent.rollback && instance.status !== 'Stopped')
      throw volumeError(409, 'Contained rollback compute was restarted unexpectedly. Data remains quarantined.');
    if (instance.status === 'Running') await this.worker.client.stopInstance(instance.name, { force: true });
    instance = await this.inspect(v.userId, v.workerId, handle);
    if (instance.status !== 'Stopped') throw volumeError(409, 'Live recovery compute is not cold-contained.');
    if (!v.seeded && !intent.rollback) await save({ ...v, incusLive: { ...intent, rollback: true } });
    if (instance.devices[key]) {
      const devices = { ...instance.devices }; delete devices[key];
      await save({ ...v, incusLive: { ...intent, attachment: 'unknown', operation: undefined } });
      await this.worker.client.updateInstanceDevices(instance.name, devices, async operation => {
        await save({ ...v, incusLive: { ...intent, attachment: operation ? 'accepted' : 'settled', operation } });
      }, instance);
      await save({ ...v, incusLive: { ...intent, attachment: 'settled' } });
    }
    instance = await this.inspect(v.userId, v.workerId, handle);
    const after = await this.inspectVolume(v);
    if (instance.status !== 'Stopped' || (!v.seeded && (instance.devices[key] || !after || after.used_by.length)))
      throw volumeError(409, 'Live recovery device/reference settlement is not authoritative.');
    await save({ ...v, incusLive: undefined });
  }

  /** Retain the original root until the metadata-faithful copy AND seeded
   * store write succeed. Lost responses leave exact-owned staging for retry.
   * Standard Agentor units are quiesced by an unprovisioned new boot; arbitrary
   * guest-created boot units are not a VM-wide snapshot guarantee. */
  async seed(handle: string, v: StoredManagedVolume, commitSeeded: () => Promise<void>) {
    assertIncusLiveResolved(v);
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
      await this.worker.client.updateInstanceDevices(owner.containerName, devices, undefined, instance);
      instance = await this.inspect(v.userId, v.workerId, handle);
    }
    await this.removeStaging(v);
    await this.ensureVolume(v);
    await this.worker.client.updateInstanceDevices(owner.containerName, { ...instance.devices, [key]: stageDevice }, undefined, instance);
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

async function trustedLiveHelper(name: string) {
  for (const directory of ['.output/server', '.', '../orchestrator']) {
    try { return await readFile(join(process.cwd(), directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw volumeError(503, 'Trusted live persistence helper is missing from the Orchestrator installation.');
}

export const INCUS_LIVE_SIGNAL = String.raw`
import pathlib,re,sys
operation,boot,marker=sys.argv[1:]
assert re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',operation)
assert marker in ('begin','request-attach','mount-settled','release')
assert pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()==boot
(pathlib.Path('/run/agentor/live-volumes')/operation/marker).touch(mode=0o600)
`;

export const INCUS_LIVE_PROOF = String.raw`
import json,pathlib,re,sys,time
operation,boot,marker,seconds=sys.argv[1:]
assert re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',operation)
state=pathlib.Path('/run/agentor/live-volumes')/operation
def read(name):
 value=json.loads((state/name).read_text());assert value['bootId']==boot;return value
assert pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()==boot
if marker=='safe-original':
 assert not (state/'attach-armed').exists();read('restored');result={'safe':True}
elif marker=='frozen-source':
 ready=read('ready');assert ready['sourceSynced'] is True
 # Before attachment is armed, the watchdog may safely thaw on timeout.
 # Such a proof cannot authorize a later power cut of resumed writers.
 read('attach-armed')
 assert not (state/'released').exists() and not (state/'release').exists()
 root=pathlib.Path('/sys/fs/cgroup');exempt=root/('agentor-live-'+operation)
 assert exempt.is_dir()
 for group in root.iterdir():
  if group.is_dir() and group!=exempt:assert 'frozen 1' in (group/'cgroup.events').read_text()
 for pid in (root/'cgroup.procs').read_text().split():
  try:value=(pathlib.Path('/proc')/pid/'stat').read_text()
  except FileNotFoundError:continue
  assert int(value[value.rindex(')')+2:].split()[6]) & 0x00200000
 result={'safe':True}
else:
 assert marker in ('armed','ready','attach-armed','copied','restored')
 deadline=time.monotonic()+min(120,float(seconds))
 while not (state/marker).exists():
  assert not (state/'error').exists() and not (state/'watchdog-error').exists()
  assert time.monotonic()<deadline
  time.sleep(.05)
 result=read(marker)
assert pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()==boot
print(json.dumps(result))
`;

export const INCUS_SELECTION_DIRECTORY_CHECK = String.raw`
import os, stat, sys
p=sys.argv[1]
try: info=os.lstat(p)
except FileNotFoundError:
    print('missing'); sys.exit(0)
directory=stat.S_ISDIR(info.st_mode)
if directory:
    current=''
    for component in p[1:].split('/')[:-1]:
        current += '/' + component
        if not stat.S_ISDIR(os.lstat(current).st_mode): raise RuntimeError('Directory selection has a symlink ancestor')
    if not os.access(p, os.R_OK | os.X_OK): raise PermissionError('Selection is not readable')
print('directory' if directory else 'backup-only')
`;

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
