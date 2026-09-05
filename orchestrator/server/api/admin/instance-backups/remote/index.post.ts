import { requireAdmin } from "../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../utils/instance-backup-manager";
import type { BackupProviderKind } from "../../../../utils/backup-types";
import {
  acceptedInstanceBackupHttpJob,
  instanceBackupRequestId,
} from "../../../../utils/instance-backup-http";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const body = await readBody<{ provider?: BackupProviderKind; requestId?: string }>(event);
  try {
    const job = await useInstanceBackupManager().discover(
      admin.user.id,
      body?.provider,
      instanceBackupRequestId(event, body?.requestId),
    );
    setResponseStatus(event, 202);
    return acceptedInstanceBackupHttpJob(
      job,
      "Instance backup discovery started",
    );
  } catch (error: any) {
    throw createError({
      statusCode: error?.statusCode ?? 400,
      statusMessage:
        error instanceof Error ? error.message : "Instance backup discovery failed",
    });
  }
});
