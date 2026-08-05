defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Connect fake backup provider",
    operationId: "connectFakeBackupProvider",
    responses: {
      201: { description: "Connected" },
      401: { description: "Unauthorized" },
    },
  },
});
import { requireAuth } from "../../../utils/auth-helpers";
import { useBackupManager } from "../../../utils/backup-manager";
export default defineEventHandler(async (e) => {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_FAKE_BACKUP_PROVIDER !== "true") throw createError({ statusCode: 404, statusMessage: "Not found" });
  const u = requireAuth(e).user,
    b = await readBody<{ testMode?: boolean; chunkSize?: number }>(e);
  if (b?.testMode !== true)
    throw createError({
      statusCode: 400,
      statusMessage: "Fake provider requires explicit testMode",
    });
  const r = useBackupManager().connectFake(u.id, b.chunkSize);
  setResponseStatus(e, 201);
  return r;
});
