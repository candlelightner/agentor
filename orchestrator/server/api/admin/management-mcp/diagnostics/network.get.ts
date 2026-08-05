import { requireAdmin } from "../../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../../utils/admin-workspace-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  return useAdminWorkspaceStore().managementNetworkSecurity();
});
defineRouteMeta({
  openAPI: {
    tags: ["Internal"],
    summary: "Inspect diagnostic management-network isolation",
  },
});
