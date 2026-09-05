import type { H3Event } from "h3";
import type { PublicInstanceBackupJob } from "./instance-backup-types";

/** Use the standard retry header when supplied, while preserving the existing
 * body field for dashboard and older API clients. A disagreement is rejected
 * instead of assigning one transport identity to surprising arguments. */
export function instanceBackupRequestId(
  event: H3Event,
  bodyRequestId: unknown,
): string | undefined {
  const header = getHeader(event, "idempotency-key");
  if (
    header !== undefined &&
    bodyRequestId !== undefined &&
    header !== bodyRequestId
  )
    throw createError({
      statusCode: 400,
      statusMessage:
        "Idempotency-Key header and requestId body field must match when both are supplied",
    });
  const value = header ?? bodyRequestId;
  return value === undefined || value === null || value === ""
    ? undefined
    : String(value);
}

export function instanceBackupHttpJob(job: PublicInstanceBackupJob) {
  const id = encodeURIComponent(job.id);
  const active = job.status === "queued" || job.status === "running";
  const cancellable =
    active && !(job.operation === "restore" && job.phase === "applying");
  return {
    ...job,
    nextActions: {
      status: {
        method: "GET",
        endpoint: `/api/admin/instance-backups/jobs/${id}`,
      },
      logs: {
        method: "GET",
        endpoint: `/api/admin/instance-backups/jobs/${id}/logs`,
      },
      ...(cancellable
        ? {
            cancel: {
              method: "DELETE",
              endpoint: `/api/admin/instance-backups/jobs/${id}`,
            },
          }
        : {}),
    },
  };
}

export function acceptedInstanceBackupHttpJob(
  job: PublicInstanceBackupJob,
  message: string,
) {
  return {
    accepted: true,
    message,
    jobId: job.id,
    state: job.status,
    job: instanceBackupHttpJob(job),
    nextActions: instanceBackupHttpJob(job).nextActions,
  };
}
