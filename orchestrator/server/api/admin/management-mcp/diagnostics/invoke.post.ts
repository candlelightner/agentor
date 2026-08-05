import { requireAdmin } from "../../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../../utils/management-mcp-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  const b = await readBody<any>(e);
  try {
    return await useManagementMcpStore().invoke(
      b?.credential,
      b?.tool,
      b?.arguments,
    );
  } catch (x: any) {
    throw createError({
      statusCode: x?.statusCode || 500,
      statusMessage: x instanceof Error ? x.message : "Invocation failed",
    });
  }
});
defineRouteMeta({
  openAPI: {
    tags: ["Internal"],
    summary: "Invoke the diagnostic management MCP transport",
  },
});
