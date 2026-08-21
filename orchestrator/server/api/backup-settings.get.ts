defineRouteMeta({ openAPI: { tags: ['Backups'], summary: 'Get backup settings', operationId: 'getBackupSettings', responses: { 200: { description: 'Settings' }, 401: { description: 'Unauthorized' } } } });
import { requireAuth } from '../utils/auth-helpers';
import { useBackupManager } from '../utils/backup-manager';

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const config = await useBackupManager().getConfig(user.id);
  return publicSettings(config);
});

function publicSettings(config: any) {
  return {
    providerId: config?.provider ?? 'local',
    enabled: config?.enabled ?? false,
    selection: config?.selectedWorkspaceIds === null ? 'all' : 'selected',
    workspaceIds: config?.selectedWorkspaceIds ?? [],
    selectedPathsByWorkspace: config?.selectedPathsByWorkspace ?? {},
    intervalMinutes: config?.intervalMinutes ?? Math.round((config?.intervalHours ?? 24) * 60),
    retentionCount: config?.retentionCount ?? 7,
    nextRunAt: config?.enabled ? config?.nextRunAt ?? null : null,
    lastAttemptAt: config?.lastAttemptAt ?? null,
    lastSuccessAt: config?.lastSuccessAt ?? null,
    lastError: config?.lastError ?? null,
    consecutiveFailures: config?.consecutiveFailures ?? 0,
  };
}
