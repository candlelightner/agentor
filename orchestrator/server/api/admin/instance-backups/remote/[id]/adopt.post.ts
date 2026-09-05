import { requireAdmin } from "../../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../../utils/instance-backup-manager";
import {
  acceptedInstanceBackupHttpJob,
  instanceBackupRequestId,
} from "../../../../../utils/instance-backup-http";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const body = await readBody<{ requestId?: string }>(event);
  try {
    const result = await useInstanceBackupManager().adopt(
      admin.user.id,
      getRouterParam(event, "id")!,
      instanceBackupRequestId(event, body?.requestId),
    );
    if ((result as any).alreadyAdopted) return result;
    setResponseStatus(event, 202);
    return acceptedInstanceBackupHttpJob(
      result as any,
      "Instance backup adoption started",
    );
  } catch (error: any) {
    throw createError({
      statusCode: error?.statusCode ?? 400,
      statusMessage:
        error instanceof Error ? error.message : "Instance backup adoption failed",
    });
  }
});
