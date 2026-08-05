defineRouteMeta({ openAPI: {
  tags: ['Workspaces'], summary: 'Search offline workspace filenames', operationId: 'searchOfflineWorkspace',
  description: 'Case-insensitive filename search bounded to 10,000 examined entries and 500 results. Symlinks are never followed.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Case-insensitive filename query (1-200 characters)' }],
  responses: { 200: { description: 'Bounded search results' }, 400: { description: 'Invalid query' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Workspace not found' } },
} });

import { resolveOfflineWorkspace } from '../../../utils/workspace-api-access';
export default defineEventHandler(async (event) => {
  const { access } = await resolveOfflineWorkspace(event);
  const query = getQuery(event);
  return access.search(query.q, typeof query.path === 'string' ? query.path : '');
});
