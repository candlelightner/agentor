defineRouteMeta({ openAPI: { tags: ['Backups'], summary: 'List account-authorized backup workspaces', operationId: 'listBackupWorkspaces', responses: { 200: { description: 'Ordinary and dedicated administrative workspace options' }, 401: { description: 'Unauthorized' }, 503: { description: 'Workspace authority unavailable' } } } });
import { requireAuth } from '../../utils/auth-helpers';
import { useBackupManager } from '../../utils/backup-manager';
export default defineEventHandler(event => useBackupManager().listWorkspaces(requireAuth(event).user.id));
