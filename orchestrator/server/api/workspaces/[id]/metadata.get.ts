defineRouteMeta({ openAPI: {
  tags: ['Workspaces'], summary: 'Get offline workspace entry metadata', operationId: 'getOfflineWorkspaceFileMetadata',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: 'File metadata and permissions available from the storage backend' }, 400: { description: 'Invalid or escaping path' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' } },
} });

import { resolveOfflineWorkspace } from '../../../utils/workspace-api-access';
export default defineEventHandler(async (event) => {
  const { access } = await resolveOfflineWorkspace(event);
  const q = getQuery(event);
  return access.lstat(typeof q.path === 'string' ? q.path : '');
});
