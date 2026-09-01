defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "Inspect a remotely discovered backup", operationId: "getRemoteBackup", responses: { 200: { description: "Remote backup descriptor" }, 401: { description: "Unauthorized" }, 403: { description: "Forbidden" }, 404: { description: "Not found" } } } });
import { requireAuth } from "../../../utils/auth-helpers";
import { useBackupManager } from "../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const remote = await useBackupManager().getRemoteBackup(getRouterParam(event, "id")!);
  if (!remote) throw createError({ statusCode: 404, statusMessage: "Remote backup not found" });
  if (user.role !== "admin" && remote.userId !== user.id)
    // A guessed provider/discovery ID must not reveal that another account
    // has a backup at all. Treat foreign records exactly like absent ones.
    throw createError({ statusCode: 404, statusMessage: "Remote backup not found" });
  return remote;
});
