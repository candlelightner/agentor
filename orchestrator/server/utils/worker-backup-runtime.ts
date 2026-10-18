import { validateIncusImageIdentity, type IncusWorkerImageIdentity } from './incus-worker-image';

export type WorkerBackupRuntimeSource = Pick<IncusWorkerImageIdentity,
  'sourceImageId' | 'recipeId' | 'architecture' | 'converterVersion' | 'bootstrapGeneration'>;

/** Portable description only. Restore authorization/policy belongs to the
 * trusted caller, never to this parsed bundle metadata. */
export type WorkerBackupRuntime =
  | { version: 1; kind: 'legacy-docker' }
  | { version: 1; kind: 'incus-vm'; source: WorkerBackupRuntimeSource };

function source(input: unknown): WorkerBackupRuntimeSource {
  const value = input as Partial<WorkerBackupRuntimeSource> | undefined;
  // The existing full-image validator also requires a native cache fingerprint.
  // Portable inputs intentionally lack it: validate the same immutable fields
  // directly rather than inventing a fingerprint to pass that validator.
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.sourceImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.sourceImageId) ||
      typeof value.recipeId !== 'string' || !/^[a-f0-9]{64}$/.test(value.recipeId) ||
      value.architecture !== 'amd64' || typeof value.converterVersion !== 'string' ||
      !/^[A-Za-z0-9._:@+-]{1,128}$/.test(value.converterVersion) || value.bootstrapGeneration !== '3')
    throw new Error('Invalid worker backup immutable runtime source');
  return { sourceImageId: value.sourceImageId, recipeId: value.recipeId, architecture: value.architecture,
    converterVersion: value.converterVersion, bootstrapGeneration: value.bootstrapGeneration };
}

/** Missing historical metadata remains missing. The old-backup legacy rule is
 * deliberately external; this function must not select a runtime. */
export function parseWorkerBackupRuntime(input: unknown): WorkerBackupRuntime | undefined {
  if (input === undefined) return undefined;
  const value = input as Partial<WorkerBackupRuntime>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1)
    throw new Error('Invalid worker backup runtime metadata');
  if (value.kind === 'legacy-docker') return { version: 1, kind: 'legacy-docker' };
  if (value.kind === 'incus-vm') return { version: 1, kind: 'incus-vm', source: source(value.source) };
  throw new Error('Invalid worker backup runtime kind');
}

/** Capture validated conversion inputs, never the derived image cache hint or
 * current instance/storage/network authority. */
export function snapshotIncusWorkerBackupRuntime(identity: IncusWorkerImageIdentity):
  Extract<WorkerBackupRuntime, { kind: 'incus-vm' }> {
  const validated = validateIncusImageIdentity(identity);
  return { version: 1, kind: 'incus-vm', source: source(validated) };
}
