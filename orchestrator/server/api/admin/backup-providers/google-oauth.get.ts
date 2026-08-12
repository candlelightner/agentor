defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Get redacted installation Google backup OAuth configuration",
    operationId: "getGoogleBackupOAuthInstallationConfig",
    responses: { 200: { description: "Redacted configuration status" }, 401: { description: "Unauthorized" }, 403: { description: "Administrator required" } },
  },
});
import { requireAdmin } from "../../../utils/auth-helpers";
import { useGoogleBackupOAuthConfigStore } from "../../../utils/google-backup-oauth-config";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  return useGoogleBackupOAuthConfigStore().status();
});
