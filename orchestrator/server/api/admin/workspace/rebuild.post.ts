import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  return useAdminWorkspaceStore().rebuild();
});
defineRouteMeta({
  openAPI: {
    tags: ["Admin workspace"],
    summary: "Rebuild the trusted administrative overlay",
    responses: {
      200: { description: "Administrative workspace status" },
      403: { description: "Administrator required" },
    },
  },
});
