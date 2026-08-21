defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Get fake upload diagnostics by backup job or legacy upload ID",
    operationId: "getFakeBackupUpload",
    responses: {
      200: {
        description:
          "Chunk diagnostics for an owner-scoped backup job ID or legacy upload ID",
      },
      401: { description: "Unauthorized" },
      404: { description: "Not found" },
    },
  },
});
import { requireAuth } from "../../../../utils/auth-helpers";
import { useBackupManager } from "../../../../utils/backup-manager";
export default defineEventHandler((e) => {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_FAKE_BACKUP_PROVIDER !== "true") throw createError({ statusCode: 404, statusMessage: "Not found" });
  const { user } = requireAuth(e);
  const d = useBackupManager().fakeDiagnostic(user.id, getRouterParam(e, "id")!);
  if (!d)
    throw createError({ statusCode: 404, statusMessage: "Upload not found" });
  return d;
});
