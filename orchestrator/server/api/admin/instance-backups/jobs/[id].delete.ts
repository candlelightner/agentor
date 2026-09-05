import { requireAdmin } from "../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../utils/instance-backup-manager";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const manager = useInstanceBackupManager();
  const job = await manager.getJob(getRouterParam(event, "id")!);
  if (!job || job.userId !== admin.user.id)
    throw createError({ statusCode: 404, statusMessage: "Instance backup job not found" });
  try {
    return await manager.cancel(job.id);
  } catch (error: any) {
    throw createError({
      statusCode: error?.statusCode ?? 400,
      statusMessage:
        error instanceof Error ? error.message : "Instance backup cancellation failed",
    });
  }
});
