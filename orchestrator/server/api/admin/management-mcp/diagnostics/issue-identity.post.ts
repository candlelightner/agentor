import { requireAdmin } from "../../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../../utils/management-mcp-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  const b = await readBody<any>(e);
  try {
    const result = await useManagementMcpStore().issue(
      b?.workspaceId,
      Number(b?.ttlSeconds ?? 60),
    );
    setResponseStatus(e, 201);
    return result;
  } catch (x: any) {
    throw createError({
      statusCode: x?.statusCode || 400,
      statusMessage: x instanceof Error ? x.message : "Cannot issue identity",
    });
  }
});
defineRouteMeta({
  openAPI: {
    tags: ["Internal"],
    summary: "Issue a diagnostic short-lived MCP workload identity",
  },
});
