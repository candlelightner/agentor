defineRouteMeta({ openAPI: { tags: ['Backups'], summary: 'Complete Google Drive backup OAuth', operationId: 'completeBackupGoogleOAuth', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { state: { type: 'string' }, code: { type: 'string' } }, required: ['state', 'code'] } } } }, responses: { 200: { description: 'Linked sanitized configuration' }, 400: { description: 'Invalid OAuth response' }, 401: { description: 'Unauthorized' } } } });
import { requireAuth } from '../../../../utils/auth-helpers';
import { useBackupManager } from '../../../../utils/backup-manager';

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const body = await readBody<{ state?: string; code?: string }>(event);
  if (!body?.state || !body.code) throw createError({ statusCode: 400, statusMessage: 'state and code are required' });
  try { return await useBackupManager().completeGoogleOAuth(user.id, body.state, body.code); }
  catch { throw createError({ statusCode: 400, statusMessage: 'Invalid or expired OAuth response' }); }
});
