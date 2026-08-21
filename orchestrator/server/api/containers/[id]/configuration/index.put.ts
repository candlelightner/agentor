defineRouteMeta({ openAPI: {
  tags: ['Worker Configuration'], summary: 'Replace worker-local configuration', operationId: 'putWorkerConfiguration',
  description: 'Atomically updates worker-local variables, encrypted secrets, and encrypted secret files. Omitted sections are preserved. Secret values are write-only.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { entries: { type: 'array', maxItems: 500, items: { type: 'object', properties: { kind: { type: 'string', enum: ['variable', 'secret', 'secretFile'] }, key: { type: 'string' }, value: { type: 'string', description: 'Write-only for secrets and secret files' }, fileName: { type: 'string' } }, required: ['kind', 'key', 'value'] } } }, required: ['entries'] } } } },
  responses: { 200: { description: 'Sanitized saved configuration' }, 400: { description: 'Validation error' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Worker not found' }, 503: { description: 'Stored worker or configuration state is unavailable' } },
} });

import { requireContainerAccess } from '../../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore } from '../../../../utils/services';
import { useWorkerConfigStore } from '../../../../utils/worker-config-store';
import { workerConfigurationResponse } from '../../../../utils/worker-config-response';
import { useWorkerProtectionLockStore } from '../../../../utils/worker-protection-lock';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const worker = useContainerManager().get(id) ?? useWorkerStore().findById(id);
  requireContainerAccess(event, worker);
  const body = await readBody<{ variables?: Array<{key:string;value:string}>; secrets?: Array<{key:string;value:string}>; secretFiles?: Array<{name:string;path:string;content:string}>; envFile?: string; deleteSecrets?: string[]; deleteSecretFiles?: string[] }>(event);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw createError({ statusCode: 400, statusMessage: 'Request body must be an object' });
  await useWorkerProtectionLockStore().verify(id, (body as any).lockPassword);
  const store = useWorkerConfigStore();
  try {
    await store.patch(worker!.userId, id, body);
    const persisted = await useWorkerStore().markPendingRebuild(worker!.userId, id);
    if (!persisted) throw new Error('Worker metadata is unavailable');
    // ContainerManager owns the live dashboard projection. Mutate it only
    // after WorkerStore persistence commits; never leak an uncommitted rebuild
    // marker through the object returned by ContainerManager.get().
    const live = useContainerManager().get(id);
    if (live?.userId === persisted.userId) {
      live.pendingRebuild = true;
      live.updatedAt = persisted.updatedAt;
    }
    return workerConfigurationResponse(live ?? persisted);
  } catch (err) {
    throw createError({
      statusCode:
        typeof (err as { statusCode?: unknown })?.statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 400,
      statusMessage: err instanceof Error ? err.message : 'Invalid worker configuration',
    });
  }
});
