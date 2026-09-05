defineRouteMeta({
  openAPI: {
    tags: ["Instance backups"],
    summary: "Start a staged whole-instance restore",
    responses: {
      202: { description: "Restore accepted" },
      400: { description: "Explicit confirmations are missing" },
      403: { description: "Administrator required" },
      409: { description: "Restore preflight is blocked" },
    },
  },
});

import { requireAdmin } from "../../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../../utils/instance-backup-manager";
import type { InstanceRestoreOptions } from "../../../../../utils/instance-backup-types";
import {
  acceptedInstanceBackupHttpJob,
  instanceBackupRequestId,
} from "../../../../../utils/instance-backup-http";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const body = await readBody<{
    options?: Partial<InstanceRestoreOptions>;
    requestId?: string;
  }>(event);
  try {
    const job = await useInstanceBackupManager().restore(
      admin.user.id,
      getRouterParam(event, "id")!,
      body?.options ?? {},
      instanceBackupRequestId(event, body?.requestId),
    );
    setResponseStatus(event, 202);
    return acceptedInstanceBackupHttpJob(job, "Instance restore started");
  } catch (error: any) {
    throw createError({
      statusCode: error?.statusCode ?? 400,
      statusMessage:
        error instanceof Error ? error.message : "Instance restore request failed",
      ...(error?.data ? { data: error.data } : {}),
    });
  }
});
