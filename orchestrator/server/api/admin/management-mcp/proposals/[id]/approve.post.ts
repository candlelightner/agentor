import { requireAdmin } from "../../../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../../../utils/management-mcp-store";
export default defineEventHandler(async (e) => {
  const a = requireAdmin(e);
  try {
    return await useManagementMcpStore().approve(
      getRouterParam(e, "id")!,
      a.user.id,
    );
  } catch (x: any) {
    throw createError({
      statusCode: x?.statusCode || 500,
      statusMessage: x instanceof Error ? x.message : "Approval failed",
    });
  }
});
defineRouteMeta({
  openAPI: {
    tags: ["Management MCP"],
    summary: "Approve or reject a management change proposal",
    responses: {
      200: { description: "Updated proposal" },
      403: { description: "Trusted dashboard administrator required" },
    },
  },
});
