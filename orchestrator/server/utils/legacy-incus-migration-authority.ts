import { isDeepStrictEqual } from 'node:util';
import type Docker from 'dockerode';
import type { WorkerRecord, WorkerIncusMigration } from './worker-store';
import type { StoredManagedVolume } from './managed-volume-store';
import { legacyMigrationMountIdentity } from './legacy-incus-migration-capture';

// Only schema names may enter diagnostics. Never reflect arbitrary persisted
// keys, labels, mount paths, IDs, configuration values or credentials.
const diagnosticFields = new Set<keyof WorkerRecord>([
  'id', 'userId', 'createdAt', 'runtimeKind', 'displayName', 'status', 'desiredRuntimeStatus',
  'archivedAt', 'deletionPending', 'incusRecreation', 'environmentId', 'excludedGlobalEnvVarKeys',
  'excludedGroupEnvVarKeys', 'workerSelfApiAccess', 'repos', 'mounts', 'hardwareDeviceIds',
  'initScript', 'pendingRebuild', 'hostMountsRevoked', 'hardwareDevicesRevoked', 'importedImage',
  'importCreatedEnvironmentId', 'imageDefinitionId', 'imageVersion', 'imageDigest', 'imageRuntimeReference',
]);
const baseline = (value: WorkerRecord) => {
  const { incusMigration, updatedAt, ...rest } = value;
  return rest;
};

/** Exact pre-cutover guard. Categories aid recovery without disclosing source
 * or configuration values. Presence of an undefined key remains significant. */
export function assertLegacyMigrationAuthority(input: {
  current: WorkerRecord | undefined; record: WorkerRecord; marker: WorkerIncusMigration;
  actual: Docker.ContainerInspectInfo; source: Docker.ContainerInspectInfo; stopped: boolean;
  managed: () => StoredManagedVolume[]; sourceManaged: StoredManagedVolume[];
}): void {
  const { current, record, marker, actual, source, stopped, managed, sourceManaged } = input;
  const fail = (category: string, changedFields?: string[]): never => {
    throw Object.assign(new Error('Legacy migration source, owner, configuration or storage authority changed' +
      ` [category=${category}${changedFields ? '; fields=' + changedFields.join(',') : ''}]`),
      { code: 'LEGACY_MIGRATION_AUTHORITY_CHANGED', category, ...(changedFields ? { changedFields } : {}) });
  };
  if (!current) return fail('record-missing');
  if (current.runtimeKind !== 'legacy-docker') fail('record-runtime');
  if (!isDeepStrictEqual(current.incusMigration, marker)) fail('migration-marker');
  const before = baseline(record), after = baseline(current);
  if (!isDeepStrictEqual(after, before)) {
    const fields = new Set<string>();
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (Object.hasOwn(before, key) !== Object.hasOwn(after, key) ||
          !isDeepStrictEqual(before[key as keyof typeof before], after[key as keyof typeof after]))
        fields.add(diagnosticFields.has(key as keyof WorkerRecord) ? key : 'other');
    }
    fail('record-baseline', [...fields].sort());
  }
  if (actual.Id !== source.Id) fail('source-id');
  if (actual.Created !== source.Created) fail('source-created');
  if (actual.Image !== source.Image) fail('source-image');
  if (!isDeepStrictEqual(legacyMigrationMountIdentity(actual.Mounts), legacyMigrationMountIdentity(source.Mounts))) fail('source-mounts');
  if (!isDeepStrictEqual(actual.Config.Labels, source.Config.Labels)) fail('source-labels');
  if (stopped && actual.State.Running) fail('source-running');
  if (!isDeepStrictEqual(managed(), sourceManaged)) fail('managed-records');
}
