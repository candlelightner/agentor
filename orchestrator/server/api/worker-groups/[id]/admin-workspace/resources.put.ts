import { requireResourceAccess } from "../../../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../../../utils/services";
import { useGroupAdminWorkspaceStore } from "../../../../utils/group-admin-workspace-store";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id")!;
  const authorize = () => requireResourceAccess(event, useWorkerGroupStore().findById(id), { allowGlobal: false });
  authorize();
  const body = await readBody(event);
  return useGroupAdminWorkspaceStore().setResources(id, body?.memoryLimit, authorize);
});

defineRouteMeta({ openAPI: { tags: ["Admin workspace"], summary: "Set administrative VM memory; changes apply on explicit Rebuild" } });
