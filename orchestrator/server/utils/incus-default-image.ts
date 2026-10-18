import type Docker from 'dockerode';
import type { Config } from './config';
import type { IncusClient } from './incus-client';
import type { ImageCatalogCore } from './image-catalog-core';
import { IncusWorkerImageManager } from './incus-worker-image-manager';
import { incusImageIdentity, sameIncusImageBase, sameIncusImageSource, type IncusWorkerImageIdentity } from './incus-worker-image';
import { incusConversionRecipeId, readCanonicalIncusBootstrap } from './incus-image-converter';
import { parseWorkerBackupRuntime, type WorkerBackupRuntimeSource } from './worker-backup-runtime';
import { withOperationDeadline } from './operation-deadline';

/** The current operator default or an exact private historical approval grants
 * the OCI source. Portable descriptors and native image properties alone do not. */
export async function resolveDefaultIncusImage(config: Config, client: IncusClient, docker: Pick<Docker, 'getImage'>,
  catalog: ImageCatalogCore, bootstrapDirectory: string, validate: () => Promise<void>,
  stored?: IncusWorkerImageIdentity, described?: WorkerBackupRuntimeSource, refreshBootstrap = false): Promise<IncusWorkerImageIdentity> {
  await validate();
  const source = stored ?? (described && (parseWorkerBackupRuntime({ version: 1, kind: 'incus-vm', source: described }) as { source: WorkerBackupRuntimeSource }).source);
  const historical = source && await catalog.hasApprovedDefaultImage(source, validate);
  let current: IncusWorkerImageIdentity | undefined;
  if (!historical) {
    const alias = await client.getImageAlias(config.incusWorkerImage);
    current = incusImageIdentity(await client.getImage(alias.target));
    const oci = await withOperationDeadline(docker.getImage(config.workerImagePrefix + config.workerImage).inspect(), 8_000, 'Approved default OCI inspection');
    if (current.fingerprint !== alias.target || current.sourceImageId !== oci.Id || oci.Architecture !== 'amd64')
      throw new Error('Configured default image differs from its approved OCI source');
    await validate();
    if (source && !sameIncusImageBase(source, current))
      throw Object.assign(new Error('Immutable image source has no current or historical default approval'),
        { statusCode: 409, code: 'INCUS_RESTORE_IMAGE_NOT_AUTHORIZED' });
    await catalog.rememberApprovedDefaultImage(current, validate);
  }
  const approved = source ?? current!;
  const files = await readCanonicalIncusBootstrap(bootstrapDirectory);
  const recipe = incusConversionRecipeId(approved.sourceImageId, files);
  if (!source) {
    if (current!.recipeId !== recipe || current!.converterVersion !== 'v0.4.0')
      throw new Error('Native default bootstrap needs worker Apply after the orchestrator update');
    return current!;
  }
  const wanted = refreshBootstrap ? { ...approved, recipeId: recipe } : approved;
  const candidates = stored ? [await client.getImage(stored.fingerprint).catch(error => {
    if (error.statusCode === 404) return undefined; throw error;
  }), ...await client.listImages()] : await client.listImages();
  for (const image of candidates) {
    if (!image) continue;
    let identity: IncusWorkerImageIdentity;
    try { identity = incusImageIdentity(image); } catch { continue; }
    if (sameIncusImageSource(identity, wanted)) {
      await validate();
      if (refreshBootstrap) await catalog.rememberApprovedDefaultImage(identity, validate);
      return identity;
    }
  }
  if (stored && !refreshBootstrap) throw new Error('Derived image for the worker immutable OCI source is unavailable');
  // A rebuild can refresh bootstrap, and a restore can reconstruct a missing
  // artifact, only from this SAME previously approved immutable OCI.
  const manager = new IncusWorkerImageManager(config, client, docker, catalog, bootstrapDirectory, config.incusConverterSeedFingerprint || '');
  const binding = await manager.ensurePlatformDefault(approved.sourceImageId, validate);
  if (!sameIncusImageBase(approved, binding.identity) || binding.identity.recipeId !== recipe)
    throw new Error('Historical default reconstruction changed the immutable OCI source');
  await validate();
  await catalog.rememberApprovedDefaultImage(binding.identity, validate);
  return binding.identity;
}
