defineRouteMeta({ openAPI: { tags: ['Backups'], summary: 'Disconnect Google Drive backups', operationId: 'disconnectGoogleBackupProvider', responses: { 204: { description: 'Disconnected' }, 401: { description: 'Unauthorized' } } } });
import { requireAuth } from '../../../utils/auth-helpers';
import { useBackupManager } from '../../../utils/backup-manager';

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  await useBackupManager().disconnectGoogle(user.id);
  setResponseStatus(event, 204);
  return null;
});
