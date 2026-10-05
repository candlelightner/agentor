/** Standalone controlled-helper imports only. Descriptive archive metadata
 * grants no worker, storage or runtime authority; existing adapters enforce it. */
export { IncusWorkerRuntime } from './server/utils/incus-worker-runtime';
export { IncusWorkerStorage } from './server/utils/incus-worker-storage';
export { IncusManagedVolumeRuntime } from './server/utils/incus-managed-volume-runtime';
export { prepareInstanceNativeVolumeArchive } from './server/utils/instance-backup-bundle';
export { WorkerStore } from './server/utils/worker-store';
export { ManagedVolumeStore } from './server/utils/managed-volume-store';

import { validateInstanceManifest } from './server/utils/instance-backup-bundle';
import type { InstanceBackupVolumeManifest } from './server/utils/instance-backup-types';
import type { WorkerRecord } from './server/utils/worker-store';
import { assertIncusLiveResolved, managedVolumeRuntimeKind, validatePersistenceTarget,
  type StoredManagedVolume } from './server/utils/managed-volume-store';
import { parseWorkerBackupRuntime, type WorkerBackupRuntimeSource } from './server/utils/worker-backup-runtime';
import { isDeepStrictEqual } from 'node:util';
import { incusManagedRestoreDevices } from './server/utils/incus-managed-volume-runtime';

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
