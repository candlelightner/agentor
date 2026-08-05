import { requireAdmin } from "../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../utils/management-mcp-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  return useManagementMcpStore().listAudit(Number(getQuery(e).limit) || 100);
});
defineRouteMeta({
  openAPI: {
    tags: ["Management MCP"],
    summary: "List sanitized management MCP audit events",
    responses: {
      200: { description: "Audit events" },
      403: { description: "Administrator required" },
    },
  },
});
