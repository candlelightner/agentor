defineRouteMeta({ openAPI: {
  tags: ['Worker Configuration'], summary: 'Replace worker-local configuration', operationId: 'putWorkerConfiguration',
  description: 'Atomically updates worker-local variables, encrypted secrets, and encrypted secret files. Omitted sections are preserved. Secret values are write-only.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { entries: { type: 'array', maxItems: 500, items: { type: 'object', properties: { kind: { type: 'string', enum: ['variable', 'secret', 'secretFile'] }, key: { type: 'string' }, value: { type: 'string', description: 'Write-only for secrets and secret files' }, fileName: { type: 'string' } }, required: ['kind', 'key', 'value'] } } }, required: ['entries'] } } } },
  responses: { 200: { description: 'Sanitized saved configuration' }, 400: { description: 'Validation error' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Worker not found' } },
} });

import { requireContainerAccess } from '../../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore } from '../../../../utils/services';
import { useWorkerConfigStore } from '../../../../utils/worker-config-store';
import { workerConfigurationResponse } from '../../../../utils/worker-config-response';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const worker = useContainerManager().get(id) ?? useWorkerStore().findById(id);
  requireContainerAccess(event, worker);
  const body = await readBody<{ variables?: Array<{key:string;value:string}>; secrets?: Array<{key:string;value:string}>; secretFiles?: Array<{name:string;path:string;content:string}>; envFile?: string; deleteSecrets?: string[]; deleteSecretFiles?: string[] }>(event);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw createError({ statusCode: 400, statusMessage: 'Request body must be an object' });
  const store = useWorkerConfigStore();
  try {
    await store.patch(worker!.userId, id, body);
    worker!.pendingRebuild = true;
    const persisted = useWorkerStore().findById(id);
    if (persisted) {
      persisted.pendingRebuild = true;
      persisted.updatedAt = new Date().toISOString();
      await useWorkerStore().upsert(persisted);
    }
    return workerConfigurationResponse(worker!);
  } catch (err) { throw createError({ statusCode: 400, statusMessage: err instanceof Error ? err.message : 'Invalid worker configuration' }); }
});
