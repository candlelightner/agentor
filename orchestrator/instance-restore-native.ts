/** Standalone controlled-helper imports only. Descriptive archive metadata
 * grants no worker, storage or runtime authority; existing adapters enforce it. */
export { IncusWorkerRuntime } from './server/utils/incus-worker-runtime';
export { IncusWorkerStorage } from './server/utils/incus-worker-storage';
export { IncusManagedVolumeRuntime } from './server/utils/incus-managed-volume-runtime';
export { prepareInstanceNativeVolumeArchive } from './server/utils/instance-backup-bundle';
export { instanceBundleFilename } from './server/utils/instance-backup-bundle';
export { WorkerStore } from './server/utils/worker-store';
export { ManagedVolumeStore } from './server/utils/managed-volume-store';
export { WorkerConfigStore } from './server/utils/worker-config-store-core';
export { StorageManager } from './server/utils/storage';
export { loadConfig } from './server/utils/config';
export { zeroUserEnvVars } from './server/utils/user-env-store';
export { readBackupInstallationId } from './server/utils/backup-installation';
export { ImageCatalogCore } from './server/utils/image-catalog-core';
export { IncusWorkerImageManager } from './server/utils/incus-worker-image-manager';

import { validateInstanceManifest } from './server/utils/instance-backup-bundle';
import type { InstanceBackupVolumeManifest } from './server/utils/instance-backup-types';
import type { WorkerRecord } from './server/utils/worker-store';
import { assertIncusLiveResolved, managedVolumeRuntimeKind, validatePersistenceTarget,
  type StoredManagedVolume } from './server/utils/managed-volume-store';
import { parseWorkerBackupRuntime, type WorkerBackupRuntimeSource } from './server/utils/worker-backup-runtime';
import { isDeepStrictEqual } from 'node:util';
import { incusManagedRestoreDevices } from './server/utils/incus-managed-volume-runtime';
import { IncusWorkerRuntime, type IncusWorkerOptions } from './server/utils/incus-worker-runtime';
import { IncusManagedVolumeRuntime } from './server/utils/incus-managed-volume-runtime';
import { WorkerStore } from './server/utils/worker-store';
import { ManagedVolumeStore } from './server/utils/managed-volume-store';
import type { Config } from './server/utils/config';
import type { IncusCustomVolume } from './server/utils/incus-client';

/** Private, one-helper-run acknowledgement evidence. Never serialized into a
 * bundle or used to recover/adopt a lost submission from a name lookup. */
export interface InstanceNativeRestoreReceipt {
  attempted: boolean;
  unsettled: boolean;
  incarnation?: string;
  marker: NonNullable<WorkerRecord['incusRecreation']>;
  volumes: Map<string, IncusCustomVolume>;
  /** Exact acknowledged installed records, not a portable/native authority. */
  worker?: WorkerRecord;
  managed?: StoredManagedVolume[];
}

/** The existing controlled helper owns the exclusive stopped control-plane
 * fence. This is only its native apply leaf: accepted fresh allocation, raw
 * extraction, record publication and stopped promotion, not another copier,
 * helper, freezer or recovery framework. Completion of the whole job must
 * precede removal of the ordinary worker's importIncomplete fence. */
export async function applyInstanceNativeRestoreGroup(input: {
  config: Config; group: InstanceNativeRestoreGroup; options: IncusWorkerOptions;
  archives: ReadonlyMap<string, string>; receipt: InstanceNativeRestoreReceipt;
  validateJob: () => Promise<void>;
}): Promise<void> {
  const { config, group, options, archives, receipt, validateJob } = input;
  if (receipt.attempted || receipt.unsettled || receipt.incarnation || receipt.volumes.size ||
      !receipt.marker.initialCreate || !receipt.marker.importIncomplete ||
      receipt.marker.originalIncarnation || receipt.marker.replacementIncarnation ||
      receipt.marker.nonce !== options.recreationNonce || options.start !== false ||
      options.id !== group.workerId || options.userId !== group.userId)
    throw new Error('Invalid controlled native initial-restore authority');
  const runtime = new IncusWorkerRuntime(config), managedRuntime = new IncusManagedVolumeRuntime(config, runtime);
  await validateJob();
  const workers = new WorkerStore(config.dataDir);
  let managed = new ManagedVolumeStore(config.dataDir);
  await Promise.all([workers.init(), managed.init()]);
  if (group.worker && !isDeepStrictEqual(workers.get(group.userId, group.workerId), group.worker) ||
      !group.worker && workers.findById(group.workerId))
    throw new Error('Installed native worker authority differs from the staged snapshot');
  let expectedWorker: WorkerRecord | undefined = group.worker ? { ...structuredClone(group.worker), status: 'active' as const,
    desiredRuntimeStatus: 'stopped' as const, incusRecreation: structuredClone(receipt.marker) } : undefined;
  // Hold the existing initial-import fence BEFORE records or native allocation.
  if (expectedWorker) { await workers.upsert(expectedWorker); expectedWorker = workers.get(group.userId, group.workerId)!; }
  receipt.worker = structuredClone(expectedWorker);
  const records: StoredManagedVolume[] = [];
  for (const item of group.managed) {
    await validateJob();
    managed = new ManagedVolumeStore(config.dataDir); await managed.init();
    if (!isDeepStrictEqual(managed.get(group.userId, item.record.id), item.record))
      throw new Error('Installed native managed authority differs from the staged snapshot');
    const pending = { ...item.record, seeded: false, state: 'pending' as const };
    delete pending.operation;
    await managed.save(pending);
    records.push(structuredClone(managed.get(group.userId, item.record.id)!));
  }
  options.managedVolumes = records.filter(v => v.attached);
  receipt.managed = structuredClone(managed.forWorker(group.userId, group.workerId));
  const validate = async () => {
    await validateJob();
    // init isolates corrupt owners but does not evict removed owner directories
    // from an already-loaded store. Fresh readers cannot bless stale caches.
    const currentWorkers = new WorkerStore(config.dataDir), currentManaged = new ManagedVolumeStore(config.dataDir);
    await Promise.all([currentWorkers.init(), currentManaged.init()]);
    if (expectedWorker ? !isDeepStrictEqual(currentWorkers.get(group.userId, group.workerId), expectedWorker)
        : !!currentWorkers.findById(group.workerId))
      throw new Error('Controlled native worker restore authority changed');
    if (!isDeepStrictEqual(currentManaged.forWorker(group.userId, group.workerId).sort((a, b) => a.id.localeCompare(b.id)),
        [...receipt.managed!].sort((a, b) => a.id.localeCompare(b.id))))
      throw new Error('Controlled native managed restore authority changed');
  };
  await validate();
  const payload = (descriptor?: InstanceBackupVolumeManifest) => {
    if (!descriptor) return undefined;
    const path = archives.get(descriptor.name);
    if (!path) throw new Error('Verified native restore archive is missing');
    return path;
  };
  const core = { workspace: payload(group.core.workspace), agents: payload(group.core.agents) };
  const docker = payload(group.core.docker);
  const managedPayloads = group.managed.map((item, index) => ({ volume: records[index]!, archivePath: payload(item.descriptor)! }));
  await runtime.preflightCanonicalRestore(options, group.source, records.filter(v => !v.attached));
  await validate();
  receipt.attempted = true; receipt.unsettled = true;
  const created = await runtime.createCanonicalRestore(options, group.source, !!docker, records.filter(v => !v.attached));
  // Capture the acknowledged UUID before any fallible store/metadata read.
  receipt.incarnation = created.config['volatile.uuid'];
  if (!receipt.incarnation || created.config['user.agentor.recreation'] !== receipt.marker.nonce ||
      !await runtime.matchesWorkerIdentity(created, group.workerId, group.userId))
    throw new Error('Controlled native create acknowledgement lacks exact authority');
  receipt.unsettled = false;
  receipt.marker.replacementIncarnation = receipt.incarnation;
  if (expectedWorker) {
    await workers.transitionIncusRecreation(group.userId, group.workerId,
      { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: receipt.marker });
    expectedWorker = workers.get(group.userId, group.workerId)!;
    receipt.worker = structuredClone(expectedWorker);
  }
  for (const record of records) {
    const volume = await managedRuntime.inspectVolume(record);
    if (!volume || !volume.created_at) throw new Error('Acknowledged native managed creation identity is unavailable');
    receipt.volumes.set(record.id, structuredClone(volume));
  }
  await validate();
  receipt.unsettled = true;
  await runtime.restoreCanonicalArchives(options, receipt.incarnation, core, validate, undefined,
    managedPayloads.filter(item => item.volume.attached), docker ? [{ path: '/var/lib/docker', archivePath: docker }] : [],
    managedPayloads.filter(item => !item.volume.attached));
  receipt.unsettled = false;
  if (!group.worker) {
    // Historical/deleted-owner data never gets a synthetic WorkerRecord or
    // account partition. Temporary compute/core cleanup precedes publication.
    await validate(); receipt.unsettled = true;
    await runtime.remove(options, receipt.incarnation); await runtime.removeStorage(options);
    receipt.unsettled = false;
  }
  for (let index = 0; index < records.length; index++) {
    await validate(); const record = records[index]!;
    if (!group.worker) {
      const current = await managedRuntime.inspectVolume(record), baseline = receipt.volumes.get(record.id)!;
      if (!current || current.used_by.length || current.project !== baseline.project || current.type !== baseline.type ||
          current.content_type !== baseline.content_type || current.created_at !== baseline.created_at ||
          !isDeepStrictEqual(current.config, baseline.config))
        throw new Error('Detached native data authority changed before publication');
    }
    await managed.save({ ...record, seeded: true, state: record.attached ? 'ready' : 'detached' });
    records[index] = structuredClone(managed.get(group.userId, record.id)!);
    receipt.managed = structuredClone(managed.forWorker(group.userId, group.workerId));
  }
  options.managedVolumes = records.filter(v => v.attached);
  if (expectedWorker) {
    await validate(); receipt.unsettled = true;
    await runtime.finishCanonicalRestore(options, receipt.incarnation, validate, 'stopped', records.filter(v => !v.attached));
    receipt.unsettled = false;
    if (group.worker!.status === 'archived') {
      await validate(); receipt.unsettled = true;
      await runtime.remove(options, receipt.incarnation); // Disposable compute only; canonical core stays.
      receipt.unsettled = false;
    }
  }
  await validate(); // Worker import fence intentionally remains until whole-job completion.
}

/** Call BEFORE rollbackData. A lost native acknowledgement cannot authorize
 * deleting restored records or resubmitting an operation. No name adoption. */
export async function rollbackInstanceNativeRestoreGroup(config: Config, group: InstanceNativeRestoreGroup,
  options: IncusWorkerOptions, receipt: InstanceNativeRestoreReceipt, validateJob: () => Promise<void>): Promise<void> {
  if (!receipt.attempted) return;
  if (receipt.unsettled || !receipt.incarnation || receipt.volumes.size !== group.managed.length)
    throw new Error('Unsettled native restore retains installed authority and rollback data');
  const runtime = new IncusWorkerRuntime(config), managedRuntime = new IncusManagedVolumeRuntime(config, runtime);
  const validate = async () => {
    await validateJob();
    const workers = new WorkerStore(config.dataDir), managed = new ManagedVolumeStore(config.dataDir);
    await Promise.all([workers.init(), managed.init()]);
    if (!receipt.managed || (receipt.worker ? !isDeepStrictEqual(workers.get(group.userId, group.workerId), receipt.worker)
        : !!workers.findById(group.workerId)) ||
        !isDeepStrictEqual(managed.forWorker(group.userId, group.workerId).sort((a, b) => a.id.localeCompare(b.id)),
          [...receipt.managed].sort((a, b) => a.id.localeCompare(b.id))))
      throw new Error('Installed native rollback authority changed; all data was retained');
    return managed;
  };
  await validate();
  receipt.unsettled = true;
  await runtime.rollbackRecreation(options, receipt.marker);
  await validate();
  await runtime.removeStorage(options);
  receipt.unsettled = false;
  for (const item of group.managed) {
    const managed = await validate();
    const record = managed.get(group.userId, item.record.id), baseline = receipt.volumes.get(item.record.id)!;
    if (!record || record.dockerName !== item.record.dockerName || record.workerId !== group.workerId)
      throw new Error('Native managed rollback record changed');
    const current = await managedRuntime.inspectVolume(record);
    if (!current || current.used_by.length || current.project !== baseline.project || current.type !== baseline.type ||
        current.content_type !== baseline.content_type || current.created_at !== baseline.created_at ||
        !isDeepStrictEqual(current.config, baseline.config))
      throw new Error('Native managed rollback creation identity changed');
    receipt.unsettled = true;
    await validate();
    await managedRuntime.delete(record);
    receipt.unsettled = false;
  }
}

export interface InstanceNativeRestoreGroup {
  workerId: string;
  userId: string;
  /** Absent for historical/deleted-owner data: never invent a WorkerRecord. */
  worker?: WorkerRecord;
  source?: WorkerBackupRuntimeSource;
  core: Partial<Record<'workspace' | 'agents' | 'docker', InstanceBackupVolumeManifest>>;
  managed: Array<{ record: StoredManagedVolume; descriptor: InstanceBackupVolumeManifest }>;
}

/** Pure admission for the existing controlled helper, BEFORE replacing DATA_DIR
 * or allocating anything. Joins validated logical roles to the staged durable
 * records. No endpoint, device, operation or snapshot UUID becomes authority.
 * Destination absence/image availability remain fresh native runtime proofs. */
export function planInstanceNativeRestore(manifestValue: unknown, workers: WorkerRecord[],
  managedVolumes: StoredManagedVolume[], restoreFilesystemData = true): InstanceNativeRestoreGroup[] {
  const manifest = validateInstanceManifest(manifestValue);
  if (!Array.isArray(workers) || !Array.isArray(managedVolumes) ||
      workers.length > 100_000 || managedVolumes.length > 100_000 || typeof restoreFilesystemData !== 'boolean')
    throw new Error('Invalid staged instance restore records');
  const groups = new Map<string, InstanceNativeRestoreGroup>();
  const workerRecords = new Map<string, WorkerRecord>(), volumeRecords = new Map<string, StoredManagedVolume>();
  const nativeManagedNames = new Set<string>(), expectedManaged = new Map<string, number>();
  let hasNativeRecords = false;
  const identity = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const group = (workerId: string, userId: string) => {
    if (!identity(workerId) || !identity(userId)) throw new Error('Invalid native restore record identity');
    const existing = groups.get(workerId);
    if (existing && existing.userId !== userId) throw new Error('Native restore worker ownership is ambiguous');
    if (existing) return existing;
    const created: InstanceNativeRestoreGroup = { workerId, userId, core: {}, managed: [] };
    groups.set(workerId, created); return created;
  };
  for (const worker of workers) {
    if (!worker || !identity(worker.id) || !identity(worker.userId) || workerRecords.has(worker.id) ||
        worker.runtimeKind !== undefined && !['legacy-docker', 'incus-vm'].includes(worker.runtimeKind))
      throw new Error('Invalid or duplicate staged WorkerRecord');
    workerRecords.set(worker.id, worker);
    if (worker.runtimeKind !== 'incus-vm') continue; // Historical missing runtime stays legacy.
    hasNativeRecords = true;
    if (!['active', 'archived'].includes(worker.status) || worker.deletionPending || worker.incusRecreation !== undefined ||
        worker.desiredRuntimeStatus !== undefined && !['running', 'stopped'].includes(worker.desiredRuntimeStatus))
      throw new Error('Resolve native worker lifecycle before restoring an instance');
    group(worker.id, worker.userId).worker = structuredClone(worker);
  }
  for (const volume of managedVolumes) {
    if (!volume || !identity(volume.userId) || !identity(volume.workerId) ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(volume.id) || volumeRecords.has(volume.id) ||
        volume.storageRuntimeKind !== undefined && !['legacy-docker', 'incus-vm'].includes(volume.storageRuntimeKind))
      throw new Error('Invalid or duplicate staged managed volume');
    volumeRecords.set(volume.id, volume);
    const worker = workerRecords.get(volume.workerId), native = managedVolumeRuntimeKind(volume) === 'incus-vm';
    if (worker && (worker.userId !== volume.userId || (worker.runtimeKind === 'incus-vm') !== native))
      throw new Error('Worker and managed storage runtime authority disagree');
    if (!native) continue;
    hasNativeRecords = true;
    nativeManagedNames.add(volume.dockerName);
    assertIncusLiveResolved(volume); validatePersistenceTarget(volume.target);
    if (volume.dockerName !== 'agentor-persist-' + volume.id || volume.purpose !== 'persistent-path' ||
        typeof volume.attached !== 'boolean' || typeof volume.seeded !== 'boolean' ||
        volume.incusLive !== undefined ||
        volume.liveContainerId !== undefined || volume.previousRestartPolicy !== undefined ||
        volume.retainedAfterAccountDeletion === true && volume.attached ||
        volume.operation !== undefined && volume.operation?.stage !== 'complete' ||
        volume.seeded && volume.state !== (volume.attached ? 'ready' : 'detached') ||
        !volume.seeded && !['pending', 'detached'].includes(volume.state) ||
        !worker && volume.attached)
      throw new Error('Resolve native managed storage before restoring an instance');
    // Unseeded records with no canonical data remain unseeded, not silently allocated.
    if (volume.seeded) {
      group(volume.workerId, volume.userId);
      expectedManaged.set(volume.workerId, (expectedManaged.get(volume.workerId) ?? 0) + 1);
    }
  }
  for (const descriptor of manifest.volumes) {
    const runtime = descriptor.runtime;
    if (!runtime) {
      if (descriptor.workerId && workerRecords.get(descriptor.workerId)?.runtimeKind === 'incus-vm' ||
          nativeManagedNames.has(descriptor.name))
        throw new Error('Native logical data cannot use a legacy Docker descriptor');
      continue;
    }
    const selected = groups.get(descriptor.workerId!);
    if (!selected || selected.userId !== descriptor.ownerId)
      throw new Error('Native descriptor has no exact staged owner/worker authority');
    if (runtime.role === 'managed') {
      const record = volumeRecords.get(runtime.managedVolumeId);
      if (!record || managedVolumeRuntimeKind(record) !== 'incus-vm' || !record.seeded ||
          record.userId !== selected.userId || record.workerId !== selected.workerId ||
          record.dockerName !== descriptor.name || record.target !== runtime.target)
        throw new Error('Native managed descriptor does not match its canonical record');
      selected.managed.push({ record: structuredClone(record), descriptor: structuredClone(descriptor) });
    } else {
      if (!selected.worker || selected.core[runtime.role]) throw new Error('Native core role is missing or duplicated');
      const parsed = parseWorkerBackupRuntime({ version: 1, kind: 'incus-vm', source: runtime.source });
      if (!parsed || parsed.kind !== 'incus-vm' || selected.source && !isDeepStrictEqual(selected.source, parsed.source))
        throw new Error('Native core roles disagree on immutable OCI source');
      selected.source = parsed.source; selected.core[runtime.role] = structuredClone(descriptor);
    }
  }
  if (hasNativeRecords && manifest.formatVersion !== 2)
    throw new Error('Historical instance backups cannot grant native runtime authority');
  if (groups.size && (!restoreFilesystemData ||
      !manifest.options.includeDockerVolumes || !manifest.options.includeWorkers))
    throw new Error('Native instance restore requires the selected canonical filesystem data');
  for (const selected of groups.values()) {
    if (selected.worker && (!selected.core.workspace || manifest.options.includeAgentData && !selected.core.agents))
      throw new Error('Canonical native worker data is missing from the instance backup');
    if (selected.worker) {
      const workspace = selected.core.workspace!.runtime;
      const dockerData = workspace?.role === 'workspace' ? workspace.dockerData : undefined;
      if (selected.core.docker ? dockerData === false : dockerData !== false)
        throw new Error('Canonical native Docker data is missing or its absence is unproven');
    }
    if ((expectedManaged.get(selected.workerId) ?? 0) !== selected.managed.length)
      throw new Error('Canonical native managed data is missing from the instance backup');
    // Completed source operation metadata is descriptive, never replayed. Reuse
    // the inverse's pure layout admission before ANY destination mutation.
    const records = selected.managed.map(item => ({ ...item.record, operation: undefined }));
    incusManagedRestoreDevices({ id: selected.workerId, userId: selected.userId }, '',
      records.filter(v => v.attached), records.filter(v => !v.attached));
  }
  return [...groups.values()];
}
