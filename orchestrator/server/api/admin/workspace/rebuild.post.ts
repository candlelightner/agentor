import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";
export default defineEventHandler(async (e) => {
  const admin = requireAdmin(e);
  return useAdminWorkspaceStore().rebuild(admin.user.id);
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
