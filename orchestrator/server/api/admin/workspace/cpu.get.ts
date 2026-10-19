import { requireAdmin } from '../../../utils/auth-helpers';
import { useAdminWorkspaceStore } from '../../../utils/admin-workspace-store';

export default defineEventHandler(async event => {
  requireAdmin(event);
  return useAdminWorkspaceStore().getCpuSettings();
});

defineRouteMeta({ openAPI: { tags: ['Admin workspace'], summary: 'Read the effective administrative VM vCPU count and pending change' } });
