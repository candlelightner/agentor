import { requireResourceAccess } from '../../../../utils/auth-helpers';
import { useWorkerGroupStore } from '../../../../utils/services';
import { useGroupAdminWorkspaceStore } from '../../../../utils/group-admin-workspace-store';

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!;
  const authorize = () => requireResourceAccess(event, useWorkerGroupStore().findById(id), { allowGlobal: false });
  authorize();
  return useGroupAdminWorkspaceStore().getCpuSettings(id, authorize);
});

defineRouteMeta({ openAPI: { tags: ['Group admin workspace'], summary: 'Read the effective group administrative VM vCPU count and pending change' } });
