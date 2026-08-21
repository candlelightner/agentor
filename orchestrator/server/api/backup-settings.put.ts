defineRouteMeta({ openAPI: { tags: ['Backups'], summary: 'Update backup settings', operationId: 'putBackupSettings', responses: { 200: { description: 'Settings' }, 400: { description: 'Invalid' }, 401: { description: 'Unauthorized' } } } });
import { requireAuth } from '../utils/auth-helpers';
import { useBackupManager } from '../utils/backup-manager';

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const manager = useBackupManager();
  const body = await readBody<any>(event);
  const old = await manager.getConfig(user.id);
  const config = await manager.setConfig(user.id, {
    provider: body.providerId ?? old?.provider,
    enabled: body.enabled ?? old?.enabled,
    intervalMinutes: body.intervalMinutes ?? old?.intervalMinutes ?? Math.round((old?.intervalHours ?? 24) * 60),
    retentionCount: body.retentionCount ?? old?.retentionCount,
    selectedWorkspaceIds: body.selection === 'all' ? null : body.workspaceIds ?? old?.selectedWorkspaceIds,
    selectedPathsByWorkspace: body.selectedPathsByWorkspace ?? old?.selectedPathsByWorkspace,
  });
  return {
    providerId: config.provider,
    enabled: config.enabled,
    selection: config.selectedWorkspaceIds === null ? 'all' : 'selected',
    workspaceIds: config.selectedWorkspaceIds ?? [],
    selectedPathsByWorkspace: config.selectedPathsByWorkspace ?? {},
    intervalMinutes: config.intervalMinutes,
    retentionCount: config.retentionCount,
    nextRunAt: config.nextRunAt,
    lastAttemptAt: config.lastAttemptAt ?? null,
    lastSuccessAt: config.lastSuccessAt ?? null,
    lastError: config.lastError ?? null,
    consecutiveFailures: config.consecutiveFailures ?? 0,
  };
});
