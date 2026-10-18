import type Docker from 'dockerode';
import { join } from 'node:path';
import type { Config } from './config';
import { IncusClient } from './incus-client';
import { IncusWorkerImageManager } from './incus-worker-image-manager';
import type { ImageCatalogCore } from './image-catalog-core';
import { incusImageIdentity } from './incus-worker-image';
import { incusConversionRecipeId, readCanonicalIncusBootstrap } from './incus-image-converter';
import { withOperationDeadline } from './operation-deadline';

/** Publish only a completely converted upstream default. Pulling by digest
 * preserves the old Docker tag throughout the potentially long conversion. */
export async function promoteNativeWorkerUpdate(config: Config, remoteDigest: string,
  docker: Pick<Docker, 'getImage'>, client: IncusClient, catalog: ImageCatalogCore,
  pull: (reference: string) => Promise<void>, validateAuthority: () => Promise<void>,
  bootstrapDirectory = join(process.cwd(), '.output/server/incus-bootstrap')): Promise<void> {
  const reference = config.workerImagePrefix + config.workerImage;
  if (reference.includes('@')) throw new Error('Native worker Apply requires a mutable WORKER_IMAGE tag; digest-only configuration must be updated explicitly');
  if (!/^[a-f0-9]{64}$/.test(config.incusConverterSeedFingerprint || ''))
    throw new Error('Native worker Apply requires INCUS_CONVERTER_SEED_FINGERPRINT');
  if (!/^sha256:[a-f0-9]{64}$/.test(remoteDigest)) throw new Error('Native worker update has no immutable registry digest');
  const separator = reference.lastIndexOf(':') > reference.lastIndexOf('/') ? reference.lastIndexOf(':') : reference.length;
  const repo = reference.slice(0, separator), tag = separator === reference.length ? 'latest' : reference.slice(separator + 1);
  if (!repo || !tag) throw new Error('Configured worker image tag is invalid');
  const staged = `${repo}@${remoteDigest}`;
  const inspect = (value: string) => withOperationDeadline(docker.getImage(value).inspect(), 8_000, 'Worker update OCI inspection');
  await validateAuthority();
  const previousAlias = await client.getImageAlias(config.incusWorkerImage);
  const previousImage = await inspect(reference);
  await pull(staged);
  const source = await inspect(staged);
  if (!/^sha256:[a-f0-9]{64}$/.test(source.Id) || source.Architecture !== 'amd64')
    throw new Error('Worker update requires an actual immutable amd64 OCI image');
  const current = async () => {
    await validateAuthority();
    const [candidate, configured] = await Promise.all([inspect(staged), inspect(reference)]);
    if (candidate.Id !== source.Id || candidate.Architecture !== 'amd64' || configured.Id !== previousImage.Id)
      throw new Error('Worker update OCI source or configured default changed');
  };
  const manager = new IncusWorkerImageManager(config, client, docker, catalog, bootstrapDirectory, config.incusConverterSeedFingerprint!);
  const binding = await manager.ensurePlatformDefault(source.Id, current);
  await current();
  const actual = incusImageIdentity(await client.getImage(binding.identity.fingerprint));
  const files = await readCanonicalIncusBootstrap(bootstrapDirectory);
  if (actual.sourceImageId !== source.Id || actual.fingerprint !== binding.identity.fingerprint ||
      actual.recipeId !== incusConversionRecipeId(source.Id, files) || actual.converterVersion !== 'v0.4.0')
    throw new Error('Worker update native image differs from its approved OCI and canonical recipe');
  await current();
  await client.promoteImageAlias(config.incusWorkerImage, previousAlias, actual.fingerprint);
  await validateAuthority();
  // Alias first, tag last: failure leaves the Docker update advertised. A
  // later explicit Apply reuses the settled conversion/alias acknowledgement.
  const published = async () => {
    const [configured, alias] = await Promise.all([inspect(reference), client.getImageAlias(config.incusWorkerImage)]);
    return configured.Id === source.Id && alias.target === actual.fingerprint;
  };
  try {
    await withOperationDeadline(docker.getImage(source.Id).tag({ repo, tag }), 30_000, 'Worker update default tag publication');
  } catch (error) {
    let observed = false;
    try { observed = await published(); } catch { /* Preserve the original ambiguous result. */ }
    if (!observed) throw error; // No automatic tag retry or compensating mutation.
  }
  if (!await published()) throw new Error('Worker update default publication was not observed');
}
