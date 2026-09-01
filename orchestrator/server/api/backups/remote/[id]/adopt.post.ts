defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "Adopt a discovered provider backup", operationId: "adoptRemoteBackup", responses: { 202: { description: "Adoption job accepted; poll status and logs" }, 401: { description: "Unauthorized" }, 403: { description: "Forbidden" }, 404: { description: "Not found" } } } });
import { requireAuth } from "../../../../utils/auth-helpers";
import { useBackupManager } from "../../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const id = getRouterParam(event, "id")!;
  const remote = await useBackupManager().getRemoteBackup(id);
  if (!remote) throw createError({ statusCode: 404, statusMessage: "Remote backup not found" });
  if (user.role !== "admin" && remote.userId !== user.id)
    // Do not turn a provider-object/discovery ID into a cross-user existence
    // oracle. Admins retain their established support access.
    throw createError({ statusCode: 404, statusMessage: "Remote backup not found" });
  const body = await readBody<any>(event) ?? {};
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || body.requestId.length < 1 || body.requestId.length > 200 || /[\0\r\n]/.test(body.requestId)))
    throw createError({ statusCode: 400, statusMessage: "Invalid request identity" });
  try {
    // Admins may inspect another owner’s record, but adoption remains scoped to
    // that record owner; no caller-controlled owner ID crosses this boundary.
    const job = await useBackupManager().createAdoption(remote.userId, id, body.requestId);
    setResponseStatus(event, 202);
    return { jobId: job.id, status: job.status, next: { status: `/api/backup-jobs/${job.id}`, logs: `/api/backups/jobs/${job.id}/logs`, cancel: `/api/backup-jobs/${job.id}` } };
  } catch (error: any) {
    throw createError({ statusCode: error?.statusCode ?? 400, statusMessage: error?.message ?? "Unable to adopt remote backup" });
  }
});
