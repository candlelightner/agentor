defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "Import recovery material", operationId: "importBackupRecoveryKey", responses: { 200: { description: "Fingerprint and matching discovered backups" }, 400: { description: "Invalid recovery material" }, 401: { description: "Unauthorized" } } } });
import { requireAuth } from "../../../utils/auth-helpers";
import { useBackupManager } from "../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  setPrivateNoStore(event);
  const body = await readBody<any>(event);
  if (!body || (typeof body.kit !== "string" && (typeof body.kit !== "object" || body.kit === null)))
    throw createError({ statusCode: 400, statusMessage: "Invalid recovery material" });
  try {
    return await useBackupManager().importRecoveryKit(user.id, body.kit);
  } catch (error: any) {
    if (error?.statusCode) throw error;
    // Do not echo user-supplied key material or parser details.
    throw createError({ statusCode: 400, statusMessage: "Invalid recovery material" });
  }
});

function setPrivateNoStore(event: any) {
  setResponseHeader(event, "Cache-Control", "no-store, private, max-age=0");
  setResponseHeader(event, "Pragma", "no-cache");
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");
}
