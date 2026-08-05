defineRouteMeta({ openAPI: {
  tags: ['Workspaces'], summary: 'List workspace storage', operationId: 'listWorkspaceInventory',
  description: 'Lists workspace storage independently of worker runtime. Regular users see their own workspaces; administrators also see other users and discovered orphans.',
  responses: { 200: { description: 'Workspace inventory' }, 401: { description: 'Unauthorized' } },
} });

import { requireAuth } from '../../utils/auth-helpers';
import { listWorkspaceInventory, publicWorkspaceInventoryItem } from '../../utils/workspace-inventory';
import { useBackupManager } from '../../utils/backup-manager';

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const items = await listWorkspaceInventory(user.role === 'admin');
  const visible = user.role === 'admin' ? items : items.filter((item) => item.userId === user.id && item.state !== 'orphaned');
  const perOwner = new Map<string, Awaited<ReturnType<ReturnType<typeof useBackupManager>['list']>>>();
  return Promise.all(visible.map(async (item) => {
    const result = publicWorkspaceInventoryItem(item);
    if (!item.userId || !item.workerId) return result;
    let backups = perOwner.get(item.userId);
    if (!backups) { backups = await useBackupManager().list(item.userId); perOwner.set(item.userId, backups); }
    const latest = backups.jobs.filter((job) => (job.workspaceIds ?? [job.workspaceId]).includes(item.workerId!)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest) result.latestBackup = { status: latest.status, completedAt: latest.completedAt, error: latest.error };
    return result;
  }));
});
