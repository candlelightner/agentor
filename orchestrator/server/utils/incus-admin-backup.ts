import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './config';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { administrativeRuntimeOwner, validateAdminNativeState } from './admin-native-identity';
import type { IncusAdminWorkspaceRuntime } from './incus-admin-workspace-runtime';
import type { IncusCustomVolume } from './incus-client';
import { IncusOfflineArchiveHelper } from './incus-offline-archive-helper';
import { openIncusCanonicalArchive } from './incus-canonical-archive';
import { incusManagedRestoreDevices } from './incus-managed-volume-runtime';
import { writeGzipFile } from './worker-export';

const failure = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
export function assertAdministrativeSnapshotSettled(value: unknown): asserts value is AdministrativeWorkspaceRecord {
  const record = value as AdministrativeWorkspaceRecord;
  administrativeRuntimeOwner(record);
  validateAdminNativeState(record);
  if (record.nativeMigration && record.nativeMigration.phase !== 'retained' || record.nativeRuntime?.pending || record.nativeRuntime?.deleting || record.nativeRuntime?.selectedOperation)
    throw failure('Resolve administrative VM migration or lifecycle recovery before whole-instance backup');
  if (record.runtimeKind === 'incus-vm' && (!record.nativeRuntime?.incarnation ||
      record.nativeRuntime.storageReady !== true || record.nativeRuntime.storageInitialized !== true))
    throw failure('Administrative canonical storage is not ready for whole-instance backup');
}

/** A server-derived helper namespace accommodates bounded historical admin IDs.
 * Source authority always comes from the dedicated record and volume proofs;
 * ordinary-worker helper admission remains unchanged. */
export function administrativeArchiveHelperOwner(record: Readonly<AdministrativeWorkspaceRecord>) {
  const owner = administrativeRuntimeOwner(record), native = record.nativeRuntime;
  validateAdminNativeState(record);
  if (!native) throw failure('Administrative native backup identity is unavailable');
  const digest = createHash('sha256').update(JSON.stringify([
    'agentor-administrative-archive-v1', owner.kind, owner.groupId ?? '', owner.id])).digest('hex');
  return { id: `${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`,
    userId: 'admin-' + createHash('sha256').update(owner.userId).digest('hex').slice(0,32), containerName: native.name };
}

/** Caller holds the dedicated admin store transaction and instance snapshot
 * gate. Only existing stopped canonical roots are exposed, read-only, to the
 * established networkless helper; compute, source devices and data are retained. */
export class IncusAdminBackup {
  constructor(private config: Config, private runtime: IncusAdminWorkspaceRuntime,
    private helper?: Pick<IncusOfflineArchiveHelper, 'withGuest'>) {}

  async inspect(record: Readonly<AdministrativeWorkspaceRecord>) {
    assertAdministrativeSnapshotSettled(record);
    if (record.runtimeKind !== 'incus-vm' || record.status !== 'stopped')
      throw failure('Administrative native backup requires stopped native authority');
    await this.runtime.validateAuthority(record);
    const instance = await this.runtime.assertOwned(record);
    if (instance.status !== 'Stopped') throw failure('Stop administrative VM compute before backup');
    const native = record.nativeRuntime!;
    const volumes = {} as Record<'workspace' | 'agents', IncusCustomVolume>;
    for (const role of ['workspace', 'agents'] as const) {
      const volume = await this.runtime.storage.inspect(record, native, role);
      if (!volume || volume.project !== this.config.incusProject || !Number.isFinite(Date.parse(volume.created_at)) ||
          !Array.isArray(volume.used_by) || volume.used_by.length !== 1)
        throw failure('Administrative canonical storage identity or reference is ambiguous');
      volumes[role] = volume;
    }
    await this.runtime.validateAuthority(record);
    return { instance, volumes };
  }

  /** Detached seeded data remains portable without becoming an active VM ref. */
  async inspectSelected(record: Readonly<AdministrativeWorkspaceRecord>) {
    const result = await this.runtime.inspectSelectedStorage(record), owner = administrativeRuntimeOwner(record);
    const store = await this.runtime.storage.store();
    for (const value of store.forWorker(owner.userId, owner.id).filter(v => !v.attached && v.storageRuntimeKind === 'incus-vm')) {
      const volume = await this.runtime.storage.inspectDetachedSelectedVolume(record, value);
      if (!volume) continue;
      result.push({ record: structuredClone(value), volume });
    }
    const portable = result.map(item => ({ ...item.record, operation: undefined }));
    incusManagedRestoreDevices(owner, this.config.incusStoragePool, portable.filter(v => v.attached), portable.filter(v => !v.attached));
    await this.runtime.validateAuthority(record, record.nativeRuntime!.incarnation);
    return result;
  }

  async captureSelected(record: Readonly<AdministrativeWorkspaceRecord>, id: string, output: string, signal?: AbortSignal,
    options: { allowRunning?: true } = {}) {
    if (!options || Object.keys(options).some(key => key !== 'allowRunning') ||
        options.allowRunning !== undefined && options.allowRunning !== true) throw failure('Invalid administrative selected capture mode');
    return this.captureSelectedArchive(record, id, output, signal, options.allowRunning === true);
  }

  /** Portable backups include only the requested ready attached leaf. Pending
   * selections remain explicit-path data and do not weaken instance snapshots. */
  async capturePortableSelected(record: Readonly<AdministrativeWorkspaceRecord>, id: string, output: string, signal?: AbortSignal) {
    return this.captureSelectedArchive(record, id, output, signal, false, true);
  }

  private async captureSelectedArchive(record: Readonly<AdministrativeWorkspaceRecord>, id: string, output: string,
    signal?: AbortSignal, allowRunning = false, portable = false) {
    record = structuredClone(record);
    // Portable scheduled backups may explicitly accept best-effort live bytes;
    // whole-instance capture keeps the stopped-only default.
    if (allowRunning) {
      assertAdministrativeSnapshotSettled(record);
      if (record.runtimeKind !== 'incus-vm' || record.status !== 'running') throw failure('Administrative live capture requires running native authority');
      await this.runtime.validateAuthority(record);
    }
    const instance = allowRunning ? await this.runtime.assertOwned(record) : (await this.inspect(record)).instance;
    if (allowRunning && instance.status !== 'Running') throw failure('Administrative live capture state changed');
    let found;
    if (portable) {
      const value = (await this.runtime.storage.selectedRecords(record)).find(value => value.id === id);
      if (!value?.seeded || value.state !== 'ready' || value.operation && value.operation.stage !== 'complete')
        throw failure('Administrative portable selected archive requires ready seeded storage');
      const volume = await this.runtime.storage.inspectSelectedVolume(record, value);
      if (volume) found = { record: value, volume };
    } else found = (await this.inspectSelected(record)).find(item => item.record.id === id);
    if (!found) throw failure('Administrative selected archive identity is unavailable');
    const before = structuredClone(found.volume);
    const refs = (values: string[]) => values.map(ref => {
      const url = new URL(ref, this.runtime.client.endpoint);
      if (url.origin !== new URL(this.runtime.client.endpoint).origin || url.username || url.password || url.hash ||
          url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== this.config.incusProject ||
          [...url.searchParams.keys()].some(key => key !== 'project')) throw failure('Administrative selected reference is foreign');
      return url.pathname;
    }).sort();
    const baselineRefs = found.record.attached ? ['/1.0/instances/' + instance.name] : [];
    if (!isDeepStrictEqual(refs(before.used_by), baselineRefs)) throw failure('Administrative selected references are ambiguous');
    const assertSource = async (helperName?: string) => {
      await this.runtime.validateAuthority(record, record.nativeRuntime!.incarnation);
      if (portable && !isDeepStrictEqual((await this.runtime.storage.selectedRecords(record)).find(value => value.id === id), found.record))
        throw failure('Administrative portable selected record changed');
      const currentInstance = await this.runtime.client.getInstance(instance.name);
      if (!isDeepStrictEqual(currentInstance, instance)) throw failure('Administrative selected compute changed');
      const current = await this.runtime.client.getCustomVolume(this.config.incusStoragePool, before.name);
      if (!isDeepStrictEqual({ ...current, used_by: undefined }, { ...before, used_by: undefined }) ||
          !isDeepStrictEqual(refs(current.used_by), [...baselineRefs, ...(helperName ? ['/1.0/instances/' + helperName] : [])].sort()))
        throw failure('Administrative selected storage changed');
      await this.runtime.validateAuthority(record, record.nativeRuntime!.incarnation);
    };
    await assertSource();
    const helper = this.helper ?? new IncusOfflineArchiveHelper(this.config, this.runtime.client, record.nativeRuntime!.installationId);
    await helper.withGuest(administrativeArchiveHelperOwner(record), { managed: before.name }, assertSource, signal,
      async (name, assertHelper) => {
        const stream = await openIncusCanonicalArchive(this.runtime.client, name, 'managed', async () => {
          await assertHelper(); await assertSource(name);
        }, { exclusions: [], signal }, true);
        await writeGzipFile(stream, output, signal);
      });
    await assertSource();
    return structuredClone(found.record);
  }

  async capture(record: Readonly<AdministrativeWorkspaceRecord>,
    outputs: { workspace?: string; agents?: string }, options: { exclusions: string[]; signal?: AbortSignal }) {
    // Capture a private baseline; subsequent caller mutations cannot redefine it.
    record = structuredClone(record);
    const paths = { ...outputs };
    const selected = Object.values(paths);
    if (!selected.length || selected.some(path => typeof path !== 'string' || !path) || new Set(selected).size !== selected.length ||
        Object.keys(paths).some(role => role !== 'workspace' && role !== 'agents'))
      throw failure('Select distinct administrative canonical archive outputs');
    options = { ...options, exclusions: [...options.exclusions] };
    options.signal?.throwIfAborted();
    const { instance, volumes } = await this.inspect(record);
    const references = (values: string[]) => values.map(ref => {
      const url = new URL(ref, this.runtime.client.endpoint);
      if (url.origin !== new URL(this.runtime.client.endpoint).origin || url.username || url.password || url.hash ||
          url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== this.config.incusProject ||
          [...url.searchParams.keys()].some(key => key !== 'project'))
        throw failure('Administrative canonical source reference is foreign');
      return url.pathname;
    }).sort();
    for (const volume of Object.values(volumes))
      if (!isDeepStrictEqual(references(volume.used_by), [`/1.0/instances/${instance.name}`]))
        throw failure('Administrative canonical source references are ambiguous');
    const layout = (value: typeof instance) => ({ name: value.name, type: value.type, status: value.status,
      config: value.config, expanded_config: value.expanded_config, devices: value.devices,
      expanded_devices: value.expanded_devices, profiles: value.profiles });
    const assertSource = async (helperName?: string) => {
      await this.runtime.validateAuthority(record, record.nativeRuntime!.incarnation);
      const current = await this.runtime.client.getInstance(instance.name);
      if (!isDeepStrictEqual(layout(current), layout(instance)))
        throw failure('Administrative compute identity or layout changed during backup');
      for (const before of Object.values(volumes)) {
        const volume = await this.runtime.client.getCustomVolume(this.config.incusStoragePool, before.name);
        const expected = [`/1.0/instances/${instance.name}`, ...(helperName ? [`/1.0/instances/${helperName}`] : [])].sort();
        if (!Array.isArray(volume.used_by) || !isDeepStrictEqual(references(volume.used_by), expected) ||
            !isDeepStrictEqual({ ...volume, used_by: undefined }, { ...before, used_by: undefined }))
          throw failure('Administrative canonical storage authority changed during backup');
      }
      await this.runtime.validateAuthority(record, record.nativeRuntime!.incarnation);
    };
    await assertSource();
    const bytes = { workspace: 0, agents: 0 };
    const helper = this.helper ?? new IncusOfflineArchiveHelper(this.config, this.runtime.client, record.nativeRuntime!.installationId);
    await helper.withGuest(administrativeArchiveHelperOwner(record),
      { workspace: volumes.workspace.name, agents: volumes.agents.name }, assertSource, options.signal,
      async (name, assertHelper) => {
        const validate = async () => { await assertHelper(); await assertSource(name); };
        for (const role of ['workspace', 'agents'] as const) if (paths[role]) {
          const stream = await openIncusCanonicalArchive(this.runtime.client, name, role, validate, options, true);
          bytes[role] = await writeGzipFile(stream, paths[role]!, options.signal);
        }
      });
    await assertSource();
    await this.runtime.assertOwned(record);
    return { bytes, image: structuredClone(record.nativeRuntime!.image), overlayVersion: record.nativeRuntime!.overlayVersion,
      overlaySha256: record.nativeRuntime!.overlaySha256 };
  }
}
