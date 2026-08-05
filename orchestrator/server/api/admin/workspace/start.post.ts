import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  return useAdminWorkspaceStore().setStatus("running");
});
defineRouteMeta({
  openAPI: {
    tags: ["Admin workspace"],
    summary: "Start the administrative workspace",
    responses: {
      200: { description: "Administrative workspace status" },
      403: { description: "Administrator required" },
    },
  },
});
