defineRouteMeta({ openAPI: {
  tags: ['Worker Configuration'], summary: 'Get worker-local configuration', operationId: 'getWorkerConfiguration',
  description: 'Returns worker-local variables and the names/configured state of secrets and secret files. Secret and file values are never returned.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: 'Sanitized worker-local configuration' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Worker not found' } },
} });

import { requireContainerAccess } from '../../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore } from '../../../../utils/services';
import { workerConfigurationResponse } from '../../../../utils/worker-config-response';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const worker = useContainerManager().get(id) ?? useWorkerStore().findById(id);
  requireContainerAccess(event, worker);
  return workerConfigurationResponse(worker!);
});
