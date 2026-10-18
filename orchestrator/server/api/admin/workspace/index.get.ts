import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  return useAdminWorkspaceStore().getStatus();
});
defineRouteMeta({
  openAPI: {
    tags: ["Admin workspace"],
    summary: "Get the persistent administrative workspace status",
    responses: {
      200: { description: "Administrative workspace status, or null when not provisioned" },
      403: { description: "Administrator required" },
    },
  },
});
