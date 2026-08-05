import { requireAdmin } from "../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../utils/management-mcp-store";
export default defineEventHandler(async (e) => {
  const a = requireAdmin(e);
  try {
    return await useManagementMcpStore().updatePolicy(
      (await readBody<any>(e))?.groups,
      a.user.id,
    );
  } catch (x) {
    throw createError({
      statusCode: 400,
      statusMessage: x instanceof Error ? x.message : "Invalid policy",
    });
  }
});
defineRouteMeta({
  openAPI: {
    tags: ["Management MCP"],
    summary: "Update the fail-closed management MCP allowlist",
    responses: {
      200: { description: "Updated policy" },
      403: { description: "Administrator required" },
    },
  },
});
