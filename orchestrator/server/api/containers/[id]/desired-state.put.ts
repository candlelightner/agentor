defineRouteMeta({ openAPI: {
  tags: ['Containers'], summary: 'Set desired runtime state', operationId: 'setWorkerDesiredState',
  description: 'Persist desiredRuntimeStatus running or stopped with confirmed true, even when observation is unknown. Warning: intent does not confirm runtime state. Protection locks apply.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: 'Requested policy or intent; observed runtime state is independent' }, 400: { description: 'Invalid retry limit, desired state or missing confirmation' }, 403: { description: 'Access denied' }, 404: { description: 'Worker not found' }, 423: { description: 'Protection lock required' } },
} });

import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useContainerManager } from '../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';
import { rethrowAsHttpError } from '../../../utils/http-errors';

export default defineEventHandler(async event => {
  try {
    const id = getRouterParam(event, 'id')!, manager = useContainerManager();
    requireContainerAccess(event, manager.get(id));
    const body = await readBody(event);
    await useWorkerProtectionLockStore().verify(id, body?.lockPassword);
    if (body?.confirmed !== true) throw createError({ statusCode: 400, statusMessage: 'Confirm the warning: changing desired state does not confirm runtime state' });
    return await manager.setDesiredState(id, body?.desiredRuntimeStatus);
  } catch (error) { rethrowAsHttpError(error); }
});
