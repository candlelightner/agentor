defineRouteMeta({ openAPI: { tags: ['Backups'], summary: 'Begin Google Drive backup OAuth', operationId: 'startBackupGoogleOAuth', responses: { 200: { description: 'Authorization challenge' }, 401: { description: 'Unauthorized' }, 503: { description: 'OAuth not configured' } } } });
import { requireAuth } from '../../../../utils/auth-helpers';
import { useBackupManager } from '../../../../utils/backup-manager';

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const clientId = process.env.GOOGLE_BACKUP_CLIENT_ID || '';
  const redirectUri = process.env.GOOGLE_BACKUP_REDIRECT_URI || '';
  if (!clientId || !redirectUri) throw createError({ statusCode: 503, statusMessage: 'Google Drive backup OAuth is not configured' });
  const { state } = await useBackupManager().beginGoogleOAuth(user.id, clientId, redirectUri);
  return { state, authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}` };
});
