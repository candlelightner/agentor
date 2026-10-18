import { requireResourceAccess } from "../../../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../../../utils/services";
import { useGroupAdminWorkspaceStore } from "../../../../utils/group-admin-workspace-store";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id")!;
  const authorize = () => requireResourceAccess(event, useWorkerGroupStore().findById(id), { allowGlobal: false });
  authorize();
  return useGroupAdminWorkspaceStore().getResources(id, authorize);
});

defineRouteMeta({ openAPI: { tags: ["Admin workspace"], summary: "Get administrative VM memory; changes apply on explicit Rebuild" } });
