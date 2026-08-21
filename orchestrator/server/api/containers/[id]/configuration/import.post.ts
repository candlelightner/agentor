defineRouteMeta({ openAPI: {
  tags: ['Worker Configuration'], summary: 'Import KEY=value worker configuration', operationId: 'importWorkerConfigurationDotEnv',
  description: 'Imports dotenv or bulk KEY=value text as variables or masked secrets. Imported names replace matching worker-local names and preserve all others.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' }, kind: { type: 'string', enum: ['variable', 'secret'], default: 'variable' } }, required: ['content'] } } } },
  responses: { 200: { description: 'Sanitized merged configuration' }, 400: { description: 'Invalid dotenv, duplicate, reserved, or invalid name' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Worker not found' }, 503: { description: 'Stored worker or configuration state is unavailable' } },
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
  const body = await readBody<{ content?: unknown; kind?: unknown }>(event);
  await useWorkerProtectionLockStore().verify(id, (body as any)?.lockPassword);
  if (typeof body?.content !== 'string' || (body.kind !== undefined && body.kind !== 'variable' && body.kind !== 'secret')) throw createError({ statusCode: 400, statusMessage: 'content must be text and kind must be variable or secret' });
  const store = useWorkerConfigStore();
  try {
    await store.importDotEnv(worker!.userId, id, body.content, body.kind === 'secret' ? 'secret' : 'variable');
    const persisted = await useWorkerStore().markPendingRebuild(worker!.userId, id);
    if (!persisted) throw new Error('Worker metadata is unavailable');
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
      statusMessage: err instanceof Error ? err.message : 'Invalid dotenv input',
    });
  }
});
