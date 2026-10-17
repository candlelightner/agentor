import type { Config } from './config';
import type { IncusClient } from './incus-client';
import { incusImageIdentity } from './incus-worker-image';
import { readCanonicalIncusBootstrap, incusConversionRecipeId } from './incus-image-converter';

/** Callers inspect the server-configured approved OCI reference first. Neither
 * a portable source descriptor nor an admin image choice grants image authority. */
export async function resolveAdministrativeNativeBase(config: Pick<Config, 'incusWorkerImage'>,
  client: Pick<IncusClient, 'getImageAlias' | 'getImage'>, sourceImageId: string, bootstrapDirectory: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceImageId))
    throw new Error('Approved administrative OCI source identity is invalid');
  const alias = await client.getImageAlias(config.incusWorkerImage);
  const image = incusImageIdentity(await client.getImage(alias.target));
  const files = await readCanonicalIncusBootstrap(bootstrapDirectory);
  if (image.fingerprint !== alias.target || image.sourceImageId !== sourceImageId ||
      image.recipeId !== incusConversionRecipeId(sourceImageId, files) || image.converterVersion !== 'v0.4.0')
    throw new Error('Approved administrative native base does not match its exact OCI source and canonical bootstrap');
  return image;
}
