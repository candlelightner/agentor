defineRouteMeta({
  openAPI: {
    tags: ['Export Jobs'],
    summary: 'Get an export job',
    operationId: 'getExportJob',
    parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'Export job status', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExportJob' } } } }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Job not found' } },
  },
});

import { requireAuth, canAccessResource } from '../../utils/auth-helpers';
import { useExportJobManager } from '../../utils/services';

export default defineEventHandler(async (event) => {
  const ctx = requireAuth(event);
  const manager = useExportJobManager();
  const job = await manager.get(getRouterParam(event, 'jobId')!);
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Export job not found' });
  if (!canAccessResource(ctx, job, { allowGlobal: false })) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden: you do not own this export job' });
  }
  return manager.toPublic(job);
});
