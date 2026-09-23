defineRouteMeta({ openAPI: { tags: ['Backups'], summary: 'Update backup settings', operationId: 'putBackupSettings', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { includeManagedVolumes: { type: 'boolean', default: false, description: 'Include eligible attached custom volumes; detached volumes are excluded and running capture is best-effort.' } } } } } }, responses: { 200: { description: 'Settings' }, 400: { description: 'Invalid' }, 401: { description: 'Unauthorized' } } } });
import { requireAuth } from '../utils/auth-helpers';
import { useBackupManager } from '../utils/backup-manager';

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const manager = useBackupManager();
  const body = await readBody<any>(event);
  if (body?.includeManagedVolumes !== undefined && typeof body.includeManagedVolumes !== 'boolean')
    throw createError({ statusCode: 400, statusMessage: 'includeManagedVolumes must be a boolean' });
  const old = await manager.getConfig(user.id);
  const config = await manager.setConfig(user.id, {
    provider: body.providerId ?? old?.provider,
    enabled: body.enabled ?? old?.enabled,
    intervalMinutes: body.intervalMinutes ?? old?.intervalMinutes ?? Math.round((old?.intervalHours ?? 24) * 60),
    retentionCount: body.retentionCount ?? old?.retentionCount,
    selectedWorkspaceIds: body.selection === 'all' ? null : body.workspaceIds ?? old?.selectedWorkspaceIds,
    selectedPathsByWorkspace: body.selectedPathsByWorkspace ?? old?.selectedPathsByWorkspace,
    persistSelectedDirectories: body.persistSelectedDirectories,
    includeManagedVolumes: body.includeManagedVolumes,
  });
  return {
    providerId: config.provider,
    enabled: config.enabled,
    selection: config.selectedWorkspaceIds === null ? 'all' : 'selected',
    workspaceIds: config.selectedWorkspaceIds ?? [],
    selectedPathsByWorkspace: config.selectedPathsByWorkspace ?? {},
    persistSelectedDirectories: config.persistSelectedDirectories ?? true,
    includeManagedVolumes: config.includeManagedVolumes,
    intervalMinutes: config.intervalMinutes,
    retentionCount: config.retentionCount,
    nextRunAt: config.nextRunAt,
    lastAttemptAt: config.lastAttemptAt ?? null,
    lastSuccessAt: config.lastSuccessAt ?? null,
    lastError: config.lastError ?? null,
    consecutiveFailures: config.consecutiveFailures ?? 0,
  };
});
