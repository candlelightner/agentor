defineRouteMeta({ openAPI: {
  tags: ['Containers'], summary: 'Get recovery status', operationId: 'getWorkerRecovery',
  description: 'Read durable retry policy, attempt count and safe last failure without runtime probing.',
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
    return await manager.getRecovery(id);
  } catch (error) { rethrowAsHttpError(error); }
});
