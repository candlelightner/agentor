import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = await readBody(event);
  return useAdminWorkspaceStore().setStartupScript(body?.startupScript);
});

defineRouteMeta({
  openAPI: {
    tags: ["Admin workspace"],
    summary: "Set the platform-admin workspace startup script",
    description:
      "Stores a non-secret script. A running workspace is not interrupted; the next explicit start or rebuild applies it to disposable compute while preserving persistent data.",
    responses: {
      200: { description: "Saved startup script and pending-application status" },
      400: { description: "Invalid or oversized startup script" },
      403: { description: "Administrator required" },
      404: { description: "Administrative workspace not provisioned" },
    },
  },
});
