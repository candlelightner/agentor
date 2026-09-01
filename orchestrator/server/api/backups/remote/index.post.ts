defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "Start remote provider discovery", operationId: "startBackupProviderDiscovery", responses: { 202: { description: "Discovery job accepted; poll /api/backup-jobs/{id} and /logs" }, 400: { description: "Invalid request" }, 401: { description: "Unauthorized" } } } });
import { requireAuth } from "../../../utils/auth-helpers";
import { useBackupManager } from "../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const body = await readBody<any>(event) ?? {};
  if (body.provider !== undefined && !["local", "fake", "google-drive"].includes(body.provider))
    throw createError({ statusCode: 400, statusMessage: "Invalid backup provider" });
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || body.requestId.length < 1 || body.requestId.length > 200 || /[\0\r\n]/.test(body.requestId)))
    throw createError({ statusCode: 400, statusMessage: "Invalid request identity" });
  try {
    const job = await useBackupManager().createDiscovery(user.id, body.provider, body.requestId);
    setResponseStatus(event, 202);
    return { jobId: job.id, status: job.status, next: { status: `/api/backup-jobs/${job.id}`, logs: `/api/backups/jobs/${job.id}/logs`, cancel: `/api/backup-jobs/${job.id}` } };
  } catch (error: any) {
    throw createError({ statusCode: error?.statusCode ?? 400, statusMessage: error?.message ?? "Unable to start provider discovery" });
  }
});
