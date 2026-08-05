import { requireAdmin } from "../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../utils/management-mcp-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  return useManagementMcpStore().getPolicy();
});
defineRouteMeta({
  openAPI: {
    tags: ["Management MCP"],
    summary: "Get effective management MCP policy",
    responses: {
      200: { description: "Effective policy and sources" },
      403: { description: "Administrator required" },
    },
  },
});
