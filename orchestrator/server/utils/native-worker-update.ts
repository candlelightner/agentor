import type Docker from 'dockerode';
import { join } from 'node:path';
import type { Config } from './config';
import { IncusClient } from './incus-client';
import { IncusWorkerImageManager } from './incus-worker-image-manager';
import type { ImageCatalogCore } from './image-catalog-core';
import { incusImageIdentity } from './incus-worker-image';
import { incusConversionRecipeId, readCanonicalIncusBootstrap } from './incus-image-converter';
import { resolveAdministrativeNativeBase } from './admin-native-image';
import type { ImageUpdateInfo } from '../../shared/types';
import { withOperationDeadline } from './operation-deadline';

/** Keep rebuild source bytes named when the mutable default moves. Docker's
 * normal dangling prune can remove digest-only images without a container. */
export async function retainNativeWorkerSource(docker: Pick<Docker, 'getImage'>, sourceImageId: string,
  validateAuthority: () => Promise<void>): Promise<string> {
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceImageId)) throw new Error('Native source retention requires an immutable OCI identity');
  const repo = 'agentor-native-source', tag = 'sha256-' + sourceImageId.slice(7), reference = `${repo}:${tag}`;
  const inspect = (value: string) => withOperationDeadline(docker.getImage(value).inspect(), 8_000, 'Native source retention inspection');
  const matches = (value: { Id: string; Architecture: string }) => value.Id === sourceImageId && value.Architecture === 'amd64';
  await validateAuthority();
  try {
    const existing = await inspect(reference);
    if (!matches(existing)) throw new Error('Native source retention tag conflicts with another image; no tag was changed');
    return reference;
  } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
  if (!matches(await inspect(sourceImageId))) throw new Error('Native source retention requires the exact local amd64 image');
  await validateAuthority();
  try {
    await withOperationDeadline(docker.getImage(sourceImageId).tag({ repo, tag }), 30_000, 'Native source retention tag');
  } catch (error) {
    let observed = false;
    try { observed = matches(await inspect(reference)); } catch { /* Preserve ambiguous acknowledgement. */ }
    if (!observed) throw error; // Observe only; never repeat a tag mutation automatically.
  }
  if (!matches(await inspect(reference))) throw new Error('Native source retention tag was not observed');
  return reference;
}

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
  const previousNative = incusImageIdentity(await client.getImage(previousAlias.target));
  if (previousNative.fingerprint !== previousAlias.target) throw new Error('Configured native default alias changed');
  await retainNativeWorkerSource(docker, previousImage.Id, validateAuthority);
  // A prior failed tag publication may already have promoted the alias. Only
  // matching configured OCI/native pairs grant historical default approval.
  if (previousNative.sourceImageId === previousImage.Id && previousImage.Architecture === 'amd64')
    await catalog.rememberApprovedDefaultImage(previousNative, validateAuthority);
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
  await catalog.rememberApprovedDefaultImage(actual, validateAuthority);
}

/** Readiness is part of update status: an orchestrator-only bootstrap change
 * still needs explicit native preparation even if the OCI registry tag agrees. */
export async function nativeWorkerUpdateStatus(config: Config, info: ImageUpdateInfo, docker: Pick<Docker, 'getImage'>,
  client: IncusClient, bootstrapDirectory = join(process.cwd(), '.output/server/incus-bootstrap')): Promise<ImageUpdateInfo> {
  try {
    const source = await withOperationDeadline(docker.getImage(config.workerImagePrefix + config.workerImage).inspect(), 8_000, 'Native update readiness OCI inspection');
    await resolveAdministrativeNativeBase(config, client, source.Id, bootstrapDirectory);
    return { ...info, nativeUpdateRequired: false };
  } catch {
    return { ...info, updateAvailable: true, nativeUpdateRequired: true };
  }
}
