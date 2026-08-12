defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Delete container',
    description: 'Removes a worker container and all of its volumes (workspace, agents, and DinD), plus its port/domain mappings.',
    operationId: 'deleteContainer',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Container ID' }],
    responses: {
      200: { description: 'Container deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
      404: { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { useContainerManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { rethrowAsHttpError } from '../../../utils/http-errors';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  try {
    const cm = useContainerManager();
    requireContainerAccess(event, cm.get(id));
    const body = await readBody<any>(event);
    await useWorkerProtectionLockStore().verify(id, body?.lockPassword);
    await cm.remove(id);
    await useWorkerProtectionLockStore().removeForDeletedWorker(id);
    return { ok: true };
  } catch (err) {
    rethrowAsHttpError(err);
  }
});
