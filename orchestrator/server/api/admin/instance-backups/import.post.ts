defineRouteMeta({
  openAPI: {
    tags: ["Instance backups"],
    summary: "Upload and asynchronously verify an instance recovery bundle",
    responses: {
      202: { description: "Verification accepted" },
      413: { description: "Upload exceeds the staging limit" },
    },
  },
});

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { requireAdmin } from "../../../utils/auth-helpers";
import { useConfig } from "../../../utils/services";
import { useInstanceBackupManager } from "../../../utils/instance-backup-manager";
import { MAX_BACKUP_PROVIDER_OBJECT_BYTES } from "../../../utils/backup-provider";
import { instanceBackupRequestId } from "../../../utils/instance-backup-http";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const contentLength = Number(getHeader(event, "content-length") ?? 0);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > MAX_BACKUP_PROVIDER_OBJECT_BYTES
  )
    throw createError({ statusCode: 413, statusMessage: "Invalid or oversized instance backup upload" });
  const directory = join(useConfig().dataDir, "instance-restore-staging");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `incoming-${randomUUID()}.backup`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > MAX_BACKUP_PROVIDER_OBJECT_BYTES
          ? new Error("Instance backup upload exceeds the staging limit")
          : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(event.node.req, limit, createWriteStream(path, { mode: 0o600 }));
    if (bytes !== contentLength)
      throw createError({ statusCode: 400, statusMessage: "Instance backup upload was interrupted" });
    const requestId = instanceBackupRequestId(
      event,
      getQuery(event).requestId,
    );
    const job = await useInstanceBackupManager().importUpload(
      admin.user.id,
      path,
      requestId,
    );
    setResponseStatus(event, 202);
    const id = encodeURIComponent(job.id);
    return {
      accepted: true,
      message: "Instance backup verification started",
      jobId: job.id,
      state: job.status,
      job,
      nextActions: {
        status: { method: "GET", endpoint: `/api/admin/instance-backups/jobs/${id}` },
        logs: { method: "GET", endpoint: `/api/admin/instance-backups/jobs/${id}/logs` },
        cancel: { method: "DELETE", endpoint: `/api/admin/instance-backups/jobs/${id}` },
      },
    };
  } catch (error: any) {
    throw createError({
      statusCode: error?.statusCode ?? (/size|limit|large/i.test(error?.message ?? "") ? 413 : 400),
      statusMessage:
        error instanceof Error ? error.message : "Instance backup upload failed",
    });
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
});
