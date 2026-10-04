import type { IncusImage } from './incus-client';

/** Immutable conversion inputs, plus a reconstructable cache hint. No mutable
 * alias, VM UUID, runtime IP or physical device is reconstruction authority. */
export interface IncusWorkerImageIdentity {
  version: 1;
  sourceImageId: string;
  recipeId: string;
  architecture: 'amd64';
  converterVersion: string;
  bootstrapGeneration: '3';
  fingerprint: string;
}

export function validateIncusImageIdentity(value: unknown): IncusWorkerImageIdentity {
  const v = value as IncusWorkerImageIdentity | undefined;
  if (!v || v.version !== 1 || typeof v.sourceImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.sourceImageId) ||
      typeof v.recipeId !== 'string' || !/^[a-f0-9]{64}$/.test(v.recipeId) || v.architecture !== 'amd64' ||
      typeof v.converterVersion !== 'string' || !/^[A-Za-z0-9._:@+-]{1,128}$/.test(v.converterVersion) ||
      v.bootstrapGeneration !== '3' || typeof v.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.fingerprint))
    throw new Error('Incus immutable worker image metadata is missing or invalid; explicit image recovery is required');
  return { version: 1, sourceImageId: v.sourceImageId, recipeId: v.recipeId, architecture: v.architecture,
    converterVersion: v.converterVersion, bootstrapGeneration: v.bootstrapGeneration, fingerprint: v.fingerprint };
}

export function incusImageIdentity(image: IncusImage): IncusWorkerImageIdentity {
  if (image.type !== 'virtual-machine') throw new Error('Incus worker image must be a virtual machine');
  const p = image.properties ?? {};
  return validateIncusImageIdentity({ version: 1, sourceImageId: p.source_image_id, recipeId: p.recipe_id,
    architecture: p.source_architecture, converterVersion: p.converter_version,
    bootstrapGeneration: p.bootstrap_generation, fingerprint: image.fingerprint });
}

export function sameIncusImageSource(a: IncusWorkerImageIdentity, b: IncusWorkerImageIdentity): boolean {
  return a.sourceImageId === b.sourceImageId && a.recipeId === b.recipeId && a.architecture === b.architecture &&
    a.converterVersion === b.converterVersion && a.bootstrapGeneration === b.bootstrapGeneration;
}
