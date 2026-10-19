import { requireResourceAccess } from '../../../../utils/auth-helpers';
import { useWorkerGroupStore } from '../../../../utils/services';
import { useGroupAdminWorkspaceStore } from '../../../../utils/group-admin-workspace-store';
import { useWorkerProtectionLockStore } from '../../../../utils/worker-protection-lock';

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!;
  const authorize = () => requireResourceAccess(event, useWorkerGroupStore().findById(id), { allowGlobal: false });
  authorize();
  const workspaceId = useWorkerGroupStore().findById(id)?.adminWorkspace?.id;
  if (!workspaceId) throw createError({ statusCode: 404, statusMessage: 'Group administrative workspace not provisioned' });
  const body = await readBody(event);
  await useWorkerProtectionLockStore().verify(workspaceId, body?.lockPassword);
  authorize();
  return useGroupAdminWorkspaceStore().setCpuCount(id, body?.vcpuCount, authorize, workspaceId);
});

defineRouteMeta({ openAPI: { tags: ['Group admin workspace'], summary: 'Update a stopped group administrative VM vCPU count, or reconcile its pending CPU change' } });
