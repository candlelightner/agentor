defineRouteMeta({ openAPI: {
  tags: ['Worker Configuration'], summary: 'Preview effective worker configuration', operationId: 'previewEffectiveWorkerConfiguration',
  description: 'Shows configuration names, source scopes, override precedence, and non-secret values. Secret values from every scope remain masked.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: 'Effective source-aware configuration preview' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Worker not found' } },
} });

import { requireContainerAccess } from '../../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore } from '../../../../utils/services';
import { workerConfigurationResponse } from '../../../../utils/worker-config-response';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const worker = useContainerManager().get(id) ?? useWorkerStore().findById(id);
  requireContainerAccess(event, worker);
  const response = await workerConfigurationResponse(worker!);
  return { precedence: response.precedence, entries: response.effective };
});
