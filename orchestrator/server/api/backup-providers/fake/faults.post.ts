defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Configure one-shot fake provider fault",
    operationId: "configureFakeBackupFault",
    responses: {
      200: { description: "Configured" },
      401: { description: "Unauthorized" },
    },
  },
});
import { requireAuth } from "../../../utils/auth-helpers";
import { useBackupManager } from "../../../utils/backup-manager";
export default defineEventHandler(async (e) => {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_FAKE_BACKUP_PROVIDER !== "true") throw createError({ statusCode: 404, statusMessage: "Not found" });
  const { user } = requireAuth(e);
  const b = await readBody<{ failUploadChunk?: number; failCount?: number }>(e);
  useBackupManager().setFakeFault(user.id, b.failUploadChunk ?? 0, b.failCount ?? 0);
  return { configured: true };
});
