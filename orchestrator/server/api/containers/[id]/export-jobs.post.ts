defineRouteMeta({
  openAPI: {
    $global: {
      components: {
        schemas: {
          ExportJob: {
            type: 'object',
            required: ['id', 'workerId', 'includeRootfs', 'includeManagedVolumes', 'status', 'phase', 'progress', 'bytesProcessed', 'createdAt', 'updatedAt', 'downloadReady'],
            properties: {
              id: { type: 'string', format: 'uuid' }, workerId: { type: 'string', format: 'uuid' }, includeRootfs: { type: 'boolean' },
              includeManagedVolumes: { type: 'boolean', description: 'Include eligible attached custom managed volumes. Detached volumes are excluded.' },
              status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }, phase: { type: 'string' },
              progress: { type: 'number', minimum: 0, maximum: 100 }, bytesProcessed: { type: 'integer', minimum: 0 },
              createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
              startedAt: { type: 'string', format: 'date-time' }, completedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' },
              filename: { type: 'string' }, error: { type: 'string' }, downloadReady: { type: 'boolean' },
            },
          },
        },
      },
    },
    tags: ['Containers'],
    summary: 'Start an asynchronous worker export',
    description: 'Queues a durable worker export and returns its job immediately. Workspace and worker agent data are included; root filesystem and attached custom managed-volume capture are independent explicit options.',
    operationId: 'createWorkerExportJob',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' },
    ],
    requestBody: {
      required: false,
      content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: {
        includeRootfs: { type: 'boolean', default: false },
        includeManagedVolumes: { type: 'boolean', default: false, description: 'Include eligible attached custom volumes; running capture is best-effort and detached volumes remain excluded.' },
      } } } },
    },
    responses: {
      202: { description: 'Export job queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExportJob' } } } },
      400: { description: 'Invalid request' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
      404: { description: 'Worker not found' },
      409: { description: 'Worker is not running or stopped' },
      429: { description: 'Too many export jobs are queued for this user' },
    },
  },
});

import { useContainerManager, useExportJobManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { rethrowAsHttpError } from '../../../utils/http-errors';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const worker = useContainerManager().get(id);
  const { user } = requireContainerAccess(event, worker);
  if (worker!.status !== 'running' && worker!.status !== 'stopped') {
    throw createError({ statusCode: 409, statusMessage: 'Worker must be running or stopped to export' });
  }
  const body: { includeRootfs?: unknown; includeManagedVolumes?: unknown } =
    (await readBody<{ includeRootfs?: unknown; includeManagedVolumes?: unknown }>(event).catch(() => undefined)) ?? {};
  if (body.includeRootfs !== undefined && typeof body.includeRootfs !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'includeRootfs must be a boolean' });
  }
  if (body.includeManagedVolumes !== undefined && typeof body.includeManagedVolumes !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'includeManagedVolumes must be a boolean' });
  }
  try {
    const job = await useExportJobManager().create(
      user.id,
      id,
      body.includeRootfs ?? false,
      body.includeManagedVolumes ?? false,
    );
    setResponseStatus(event, 202);
    return job;
  } catch (err) {
    rethrowAsHttpError(err);
  }
});
