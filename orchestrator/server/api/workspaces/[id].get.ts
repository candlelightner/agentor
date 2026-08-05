defineRouteMeta({ openAPI: {
  tags: ['Workspaces'], summary: 'Get workspace storage metadata', operationId: 'getWorkspaceInventoryItem',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: 'Workspace metadata' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Workspace not found' } },
} });

import { resolveOfflineWorkspace } from '../../utils/workspace-api-access';
import { publicWorkspaceInventoryItem } from '../../utils/workspace-inventory';
export default defineEventHandler(async (event) => publicWorkspaceInventoryItem((await resolveOfflineWorkspace(event)).item));
