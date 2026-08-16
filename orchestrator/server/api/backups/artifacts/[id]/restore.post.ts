defineRouteMeta({
  openAPI: {
    tags: ['Backups'], summary: 'Restore encrypted backup into new workers', operationId: 'restoreBackup',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: {
      mode: { type: 'string', enum: ['new'] }, displayName: { type: 'string' },
      workspaceIds: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true, description: 'Optional non-empty, duplicate-free exact subset of artifact workspaces; omit to restore all members' } as any,
    } } } } },
    responses: { 201: { description: 'Restored new worker' }, 400: { description: 'Unsafe or invalid restore' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' }, 500: { description: 'Restore failed and one or more partially created workers require manual cleanup' } },
  },
});
import { requireAuth } from '../../../../utils/auth-helpers';
import { useBackupManager } from '../../../../utils/backup-manager';

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const manager = useBackupManager();
  const artifact = await manager.getArtifact(getRouterParam(event, 'id')!);
  if (!artifact) throw createError({ statusCode: 404, statusMessage: 'Backup artifact not found' });
  if (user.role !== 'admin' && artifact.userId !== user.id) throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  const body = (await readBody<{ mode?: 'new'; displayName?: string; workspaceIds?: string[] }>(event)) ?? {};
  if (body.mode !== undefined && body.mode !== 'new')
    throw createError({ statusCode: 400, statusMessage: 'Invalid restore mode' });
  if (body.displayName !== undefined && typeof body.displayName !== 'string')
    throw createError({ statusCode: 400, statusMessage: 'Invalid display name' });
  try {
    const worker = await manager.restore(artifact.userId, artifact, 'new', body.displayName, body.workspaceIds);
    setResponseStatus(event, 201);
    return worker;
  } catch (err) {
    const failure = err as Error & { statusCode?: number; data?: unknown };
    throw createError({
      statusCode: failure.statusCode ?? 400,
      statusMessage: failure.message || 'Restore failed',
      data: failure.data,
    });
  }
});
