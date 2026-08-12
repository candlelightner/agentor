defineRouteMeta({ openAPI: { tags: ["Admin"], summary: "Inspect practical Agentor storage usage", operationId: "inspectAgentorStorage", responses: { 200: { description: "Storage inventory" }, 401: { description: "Unauthorized" }, 403: { description: "Administrator required" } } } });
import { requireAdmin } from "../../utils/auth-helpers";
import { useStorageVisibilityManager } from "../../utils/storage-visibility";
export default defineEventHandler(async (event) => { requireAdmin(event); return useStorageVisibilityManager().inspect(); });
