import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  return useAdminWorkspaceStore().ensure();
});
defineRouteMeta({
  openAPI: {
    tags: ["Admin workspace"],
    summary: "Get the persistent administrative workspace status",
    responses: {
      200: { description: "Administrative workspace status" },
      403: { description: "Administrator required" },
    },
  },
});
