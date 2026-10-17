import { managedVolumeRuntimeKind, pathsOverlap, validateStoredPersistenceTarget, volumeError, type StoredManagedVolume } from './managed-volume-store';

export function incusManagedVolumeDeviceKey(v: StoredManagedVolume): string {
  if (managedVolumeRuntimeKind(v) !== 'incus-vm' || v.purpose !== 'persistent-path' ||
      !/^[a-f0-9-]{36}$/.test(v.id) || v.dockerName !== `agentor-persist-${v.id}` ||
      v.liveContainerId || v.previousRestartPolicy)
    throw volumeError(409, 'Managed storage backend or recovery identity is ambiguous. Data was retained.');
  validateStoredPersistenceTarget(v.target);
  if (pathsOverlap(v.target, '/workspace'))
    throw volumeError(409, 'Workspace already has canonical persistence; overlapping managed storage is not allowed.');
  return `m${v.id.replaceAll('-', '').slice(0, 6)}`;
}

