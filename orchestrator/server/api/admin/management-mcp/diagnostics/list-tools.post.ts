import { requireAdmin } from "../../../../utils/auth-helpers";
import { useManagementMcpStore } from "../../../../utils/management-mcp-store";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = await readBody<{ credential?: unknown }>(event);
  await useManagementMcpStore().introspect(body?.credential);
  return useManagementMcpStore().listTools();
});

defineRouteMeta({
  openAPI: {
    tags: ["Internal"],
    summary: "List effective MCP tools for a diagnostic workload identity",
  },
});
