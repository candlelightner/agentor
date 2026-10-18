import type { StoredManagedVolume } from './managed-volume-store';
import { persistentPathVolumeName } from './persistent-backup-paths';
import { incusManagedRestoreDevices } from './incus-managed-volume-runtime';

/** Explicit migration is the only place that may translate historical Docker
 * names. Keep source records unchanged for capture/CAS/rollback and receipts;
 * the fresh native copies use the existing strict managed-volume contract. */
export function prepareLegacyManagedMigration(
  owner: { id: string; userId: string },
  sources: readonly StoredManagedVolume[],
): StoredManagedVolume[] {
  const ids = new Set<string>(), names = new Set<string>();
  const result = sources.map(source => {
    if (source.userId !== owner.userId || source.workerId !== owner.id ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(source.id) ||
        source.storageRuntimeKind !== undefined && source.storageRuntimeKind !== 'legacy-docker' ||
        source.seeded !== true || typeof source.attached !== 'boolean' ||
        source.state !== (source.attached ? 'ready' : 'detached') ||
        source.operation && source.operation.stage !== 'complete' || source.liveContainerId ||
        source.previousRestartPolicy || source.incusLive || source.retainedAfterAccountDeletion ||
        !['persistent-path', 'legacy-backup-path'].includes(source.purpose))
      throw new Error('Legacy managed migration requires exact settled source authority');
    const expected = source.purpose === 'legacy-backup-path'
      ? persistentPathVolumeName(owner.id, source.target) : `agentor-persist-${source.id}`;
    if (source.dockerName !== expected || ids.has(source.id) || names.has(source.dockerName))
      throw new Error('Legacy managed migration source name or identity is ambiguous');
    ids.add(source.id); names.add(source.dockerName);
    const { operation: _completedHistory, ...copy } = structuredClone(source);
    return { ...copy, purpose: 'persistent-path' as const, dockerName: `agentor-persist-${source.id}`,
      storageRuntimeKind: 'incus-vm' as const, seeded: false, state: 'pending' as const };
  });
  // Includes protected path, overlap, duplicate-device and native naming checks.
  // Reject before inspecting/stopping/capturing source or creating scratch.
  // The exact XDG parent additionally requires its canonical link in the archive.
  incusManagedRestoreDevices(owner, 'migration-preflight', result.filter(v => v.attached), result.filter(v => !v.attached));
  return result;
}
