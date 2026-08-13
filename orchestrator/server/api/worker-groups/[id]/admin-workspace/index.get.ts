import { requireResourceAccess } from "../../../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../../../utils/services";
import { useGroupAdminWorkspaceStore } from "../../../../utils/group-admin-workspace-store";
export default defineEventHandler(async (event) => {
  const group = useWorkerGroupStore().findById(getRouterParam(event, "id")!);
  requireResourceAccess(event, group, { allowGlobal: false });
  if (!group?.adminWorkspace)
    throw createError({
      statusCode: 404,
      statusMessage: "Group administrative workspace not provisioned",
    });
  return useGroupAdminWorkspaceStore().ensure(group.id);
});
