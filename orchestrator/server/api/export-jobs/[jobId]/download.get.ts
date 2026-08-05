defineRouteMeta({
  openAPI: {
    tags: ['Export Jobs'],
    summary: 'Download a completed export artifact',
    operationId: 'downloadExportJob',
    parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'Worker export tar stream', content: { 'application/x-tar': { schema: { type: 'string', format: 'binary' } } } }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Job or artifact not found' }, 409: { description: 'Job has not succeeded' } },
  },
});

import { requireAuth, canAccessResource } from '../../../utils/auth-helpers';
import { useExportJobManager } from '../../../utils/services';

export default defineEventHandler(async (event) => {
  const ctx = requireAuth(event);
  const manager = useExportJobManager();
  const job = await manager.get(getRouterParam(event, 'jobId')!);
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Export job not found' });
  if (!canAccessResource(ctx, job, { allowGlobal: false })) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden: you do not own this export job' });
  }
  if (job.status !== 'succeeded') {
    throw createError({ statusCode: 409, statusMessage: 'Export artifact is not ready' });
  }
  let artifact: Awaited<ReturnType<typeof manager.openArtifact>>;
  try {
    artifact = await manager.openArtifact(job);
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Export artifact not found' });
  }
  setResponseHeaders(event, {
    'Content-Type': 'application/x-tar',
    'Content-Disposition': `attachment; filename="${artifact.filename}"`,
    'Content-Length': String(artifact.size),
    'Cache-Control': 'private, no-store',
  });
  // Stop reading the retained artifact promptly when an authenticated client
  // disconnects. The artifact remains available until normal job expiry.
  event.node.res.once('close', () => artifact.stream.destroy());
  return sendStream(event, artifact.stream);
});
