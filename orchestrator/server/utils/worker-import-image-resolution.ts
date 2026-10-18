import { isSafeUserId } from './user-id';
import type { WorkerImportOptions } from './container';

/** Public recovery choice only: no runtime grants or raw image references. */
export function parseWorkerImportImageResolution(input: unknown): WorkerImportOptions['imageResolution'] {
  if (input === undefined) return undefined;
  const invalid = () => Object.assign(new Error('Invalid import image resolution; choose an acknowledged workspace-only import or a catalog replacement'), { statusCode: 400 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const value = input as Record<string, unknown>, keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw invalid();
  const fields = (keys as string[]).sort().join(',');
  if (value.mode === 'workspace-only' && fields === 'acknowledged,mode' && value.acknowledged === true)
    return { mode: 'workspace-only' };
  if (value.mode === 'replacement' && fields === 'imageDefinitionId,imageVersion,mode' &&
      typeof value.imageDefinitionId === 'string' && value.imageDefinitionId.length <= 200 && isSafeUserId(value.imageDefinitionId) &&
      typeof value.imageVersion === 'string' && value.imageVersion.length <= 100 &&
      value.imageVersion.trim() === value.imageVersion && value.imageVersion.length > 0 && !/[\0\r\n]/.test(value.imageVersion))
    return { mode: 'replacement', imageDefinitionId: value.imageDefinitionId, imageVersion: value.imageVersion };
  throw invalid();
}

export const WORKER_IMPORT_IMAGE_RESOLUTION_SCHEMA = {
  description: 'Optional explicit image recovery for a bundle: ignore captured rootfs with workspace-only acknowledgement, or select an authorized existing catalog image. This never selects runtime type.',
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['mode', 'acknowledged'],
      properties: { mode: { const: 'workspace-only' }, acknowledged: { const: true } } },
    { type: 'object', additionalProperties: false, required: ['mode', 'imageDefinitionId', 'imageVersion'],
      properties: { mode: { const: 'replacement' }, imageDefinitionId: { type: 'string', minLength: 1, maxLength: 200 },
        imageVersion: { type: 'string', minLength: 1, maxLength: 100 } } },
  ],
};
