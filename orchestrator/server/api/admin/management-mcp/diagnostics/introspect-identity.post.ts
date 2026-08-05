import { requireAdmin } from "../../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../../utils/management-mcp-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  const b = await readBody<any>(e);
  try {
    return await useManagementMcpStore().introspect(
      b?.credential,
      b?.workspaceId,
    );
  } catch (x: any) {
    throw createError({
      statusCode: x?.statusCode || 401,
      statusMessage: x instanceof Error ? x.message : "Invalid identity",
    });
  }
});
defineRouteMeta({
  openAPI: {
    tags: ["Internal"],
    summary: "Inspect a diagnostic MCP workload identity",
  },
});
