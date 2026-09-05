import { requireAdmin } from "../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../utils/instance-backup-manager";
import { instanceBackupHttpJob } from "../../../../utils/instance-backup-http";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const job = await useInstanceBackupManager().getJob(getRouterParam(event, "id")!);
  if (!job || job.userId !== admin.user.id)
    throw createError({ statusCode: 404, statusMessage: "Instance backup job not found" });
  return instanceBackupHttpJob(job);
});
