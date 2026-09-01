defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "List remotely discovered backups", operationId: "listRemoteBackups", responses: { 200: { description: "Owner-scoped remote backup descriptors" }, 401: { description: "Unauthorized" } } } });
import { requireAuth } from "../../../utils/auth-helpers";
import { useBackupManager } from "../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  return useBackupManager().listRemoteBackups(user.id);
});
