import { requireResourceAccess } from "../../../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../../../utils/services";
import { useGroupAdminWorkspaceStore } from "../../../../utils/group-admin-workspace-store";
export default defineEventHandler(async (event) => {
  const group = useWorkerGroupStore().findById(getRouterParam(event, "id")!);
  const { user } = requireResourceAccess(event, group, { allowGlobal: false });
  if (!group!.adminWorkspace) setResponseStatus(event, 201);
  return useGroupAdminWorkspaceStore().ensure(group!.id, user.id);
});
