defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Complete Google OAuth test flow",
    operationId: "callbackGoogleBackupOAuth",
    responses: {
      302: { description: "Connected" },
      400: { description: "Invalid state" },
      401: { description: "Unauthorized" },
    },
  },
});
import { requireAuth } from "../../../../utils/auth-helpers";
import { useBackupManager } from "../../../../utils/backup-manager";
export default defineEventHandler(async (e) => {
  const u = requireAuth(e).user,
    q = getQuery(e);
  if (typeof q.state !== "string" || typeof q.code !== "string")
    throw createError({
      statusCode: 400,
      statusMessage: "state and code required",
    });
  try {
    await useBackupManager().completeGoogleOAuth(
      u.id,
      q.state,
      q.code,
    );
    setResponseStatus(e, 302);
    setHeader(e, "Location", "/");
    return null;
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid or expired OAuth state",
    });
  }
});
