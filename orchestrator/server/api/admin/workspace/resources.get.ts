import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  return useAdminWorkspaceStore().getResources();
});

defineRouteMeta({ openAPI: { tags: ["Admin workspace"], summary: "Get administrative VM memory; changes apply on explicit Rebuild" } });
