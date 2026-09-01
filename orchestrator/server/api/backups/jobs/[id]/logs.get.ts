defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "Read bounded sanitized backup job logs", operationId: "getBackupJobLogs", responses: { 200: { description: "Incremental job logs" }, 401: { description: "Unauthorized" }, 403: { description: "Forbidden" }, 404: { description: "Not found" } } } });
import { requireAuth } from "../../../../utils/auth-helpers";
import { useBackupManager } from "../../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const job = await useBackupManager().getJob(getRouterParam(event, "id")!);
  if (!job) throw createError({ statusCode: 404, statusMessage: "Backup job not found" });
  if (user.role !== "admin" && job.userId !== user.id)
    throw createError({ statusCode: 404, statusMessage: "Backup job not found" });
  const query = getQuery(event);
  const after = Math.max(0, Math.floor(Number(query.after) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(query.limit) || 100)));
  return useBackupManager().getJobLogs(job.id, after, limit);
});
