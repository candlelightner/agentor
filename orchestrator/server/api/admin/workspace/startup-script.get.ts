import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  return useAdminWorkspaceStore().getStartupScript();
});

defineRouteMeta({
  openAPI: {
    tags: ["Admin workspace"],
    summary: "Get the platform-admin workspace startup script and application status",
    responses: {
      200: { description: "Startup script and namesafe runtime status" },
      403: { description: "Administrator required" },
      404: { description: "Administrative workspace not provisioned" },
    },
  },
});
