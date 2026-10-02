import { createError, getHeader, type H3Event } from 'h3';
import type { SnapshotAdministrator } from './instance-snapshot-auth';
import type { PublicInstanceBackupJob } from './instance-backup-types';
import { instanceBackupHttpJob } from './instance-backup-http';

export interface InstanceBarrierHttpDependencies {
  jobId(): string | undefined;
  administrator(cookie: string | undefined): SnapshotAdministrator | null;
  trustedOrigin(origin: string | undefined): boolean;
  job(id: string, userId: string, cancel: boolean): PublicInstanceBackupJob | undefined;
}

/** Runs only OUTSIDE the application's ordinary hooks while admission is
 * closed. Synchronous identity/auth/job checks cannot interleave with another
 * request. Never dispatch to a normal route, lazy service or auth API. */
export function instanceBarrierHttp(event: H3Event, dependencies: InstanceBarrierHttpDependencies): unknown {
  const rawPath = event.node.req.url;
  if (event.method === 'GET' && rawPath === '/api/health') return { status: 'ok', controlPlane: 'locked' };
  const id = dependencies.jobId();
  if (!id || !['GET', 'DELETE'].includes(event.method) ||
      rawPath !== `/api/admin/instance-backups/jobs/${encodeURIComponent(id)}`)
    throw createError({ statusCode: 423, statusMessage: 'Instance control plane is temporarily locked' });
  const administrator = dependencies.administrator(getHeader(event, 'cookie'));
  if (!administrator) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  const cancel = event.method === 'DELETE';
  if (cancel && !dependencies.trustedOrigin(getHeader(event, 'origin')))
    throw createError({ statusCode: 403, statusMessage: 'Trusted Origin required for instance cancellation' });
  const job = dependencies.job(id, administrator.userId, cancel);
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Instance backup job not found' });
  return instanceBackupHttpJob(job);
}
