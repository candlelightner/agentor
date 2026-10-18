import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = await readBody(event);
  return useAdminWorkspaceStore().setResources(body?.memoryLimit);
});

defineRouteMeta({ openAPI: { tags: ["Admin workspace"], summary: "Set administrative VM memory; changes apply on explicit Rebuild" } });
