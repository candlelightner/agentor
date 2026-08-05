defineRouteMeta({ openAPI: {
  tags: ['Workspaces'], summary: 'Browse an offline workspace', operationId: 'listOfflineWorkspaceFiles',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'path', in: 'query', required: false, schema: { type: 'string', default: '' } }],
  responses: { 200: { description: 'One-level directory listing' }, 400: { description: 'Invalid or escaping path' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Workspace or path not found' }, 409: { description: 'Path is not a directory' } },
} });

import { resolveOfflineWorkspace } from '../../../utils/workspace-api-access';
export default defineEventHandler(async (event) => {
  const { access } = await resolveOfflineWorkspace(event);
  const q = getQuery(event);
  return access.list(typeof q.path === 'string' ? q.path : '');
});
