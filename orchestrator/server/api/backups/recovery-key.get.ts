defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "Get recovery-key fingerprints", operationId: "getBackupRecoveryKeyStatus", responses: { 200: { description: "Fingerprints only" }, 401: { description: "Unauthorized" } } } });
import { requireAuth } from "../../utils/auth-helpers";
import { useBackupManager } from "../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  setPrivateNoStore(event);
  return useBackupManager().recoveryKeyStatus(user.id);
});

function setPrivateNoStore(event: any) {
  setResponseHeader(event, "Cache-Control", "no-store, private, max-age=0");
  setResponseHeader(event, "Pragma", "no-cache");
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");
}
