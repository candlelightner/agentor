defineRouteMeta({
  openAPI: {
    tags: ["Instance backups"],
    summary: "Start a whole-instance disaster-recovery backup",
    responses: {
      202: { description: "Instance backup accepted" },
      401: { description: "Unauthorized" },
      403: { description: "Administrator required" },
      409: { description: "Installation is not quiescent" },
    },
  },
});

import { requireAdmin } from "../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../utils/instance-backup-manager";
import type { InstanceBackupOptions } from "../../../utils/instance-backup-types";
import type { BackupProviderKind } from "../../../utils/backup-types";
import {
  acceptedInstanceBackupHttpJob,
  instanceBackupRequestId,
} from "../../../utils/instance-backup-http";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const body = await readBody<{
    provider?: BackupProviderKind;
    options?: Partial<InstanceBackupOptions>;
    requestId?: string;
  }>(event);
  try {
    const job = await useInstanceBackupManager().create(
      admin.user.id,
      body?.provider,
      body?.options,
      instanceBackupRequestId(event, body?.requestId),
    );
    setResponseStatus(event, 202);
    return acceptedInstanceBackupHttpJob(job, "Instance backup started");
  } catch (error: any) {
    throw createError({
      statusCode: error?.statusCode ?? 400,
      statusMessage:
        error instanceof Error ? error.message : "Instance backup request failed",
    });
  }
});
