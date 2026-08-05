import { requireAdmin } from "../../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../../utils/management-mcp-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  try {
    return await useManagementMcpStore().immutableUpdate(
      getRouterParam(e, "id")!,
    );
  } catch (x: any) {
    throw createError({
      statusCode: x?.statusCode || 500,
      statusMessage: x instanceof Error ? x.message : "Update failed",
    });
  }
});
defineRouteMeta({
  openAPI: {
    tags: ["Management MCP"],
    summary: "Apply an approved immutable management change",
    responses: {
      200: { description: "Applied proposal" },
      403: { description: "Administrator required" },
      409: { description: "Proposal is not approved or is stale" },
    },
  },
});
