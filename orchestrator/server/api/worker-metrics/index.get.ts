defineRouteMeta({
  openAPI: {
    tags: ['Metrics'],
    summary: 'List per-worker metrics',
    description:
      'Returns live per-worker resource metrics for every running worker the caller owns (admins see all). Workers that are not running are omitted.',
    operationId: 'listWorkerMetrics',
    responses: {
      200: {
        description: 'Per-worker metrics',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkerMetricsStatus' } } },
      },
      401: { description: 'Unauthorized' },
    },
    $global: {
      components: {
        schemas: {
          WorkerMetrics: {
            type: 'object',
            properties: {
              workerId: { type: 'string' },
              containerName: { type: 'string' },
              displayName: { type: 'string' },
              status: { type: 'string' },
              cpuUtilization: { type: 'number', description: '0-100 of host capacity for Docker or allocated vCPU capacity for VMs' },
              cpuCapacity: { type: 'string', enum: ['host', 'worker'] },
              memoryUsedBytes: { type: 'number', description: 'Raw bytes. guest-htop excludes guest buffers and reclaimable cache; error/status indicate unavailable or stale samples.' },
              memoryAccounting: { type: 'string', enum: ['guest-htop'] },
              memoryLimitBytes: { type: 'number', description: 'Guest MemTotal for VMs, not configured allocation or host VM overhead. Docker cgroup limit otherwise.' },
              memoryUtilization: { type: 'number' },
              diskUsedBytes: { type: 'number', description: 'Durable /workspace + agent-data usage from a bounded in-worker sample' },
              netRxBytesPerSec: { type: 'number' },
              netTxBytesPerSec: { type: 'number' },
              blkReadBytesPerSec: { type: 'number' },
              blkWriteBytesPerSec: { type: 'number' },
              lastChecked: { type: ['string', 'null'], format: 'date-time', description: 'Sampling timestamp, null if unsampled. Samples expire after 30 seconds; reads do not refresh it.' },
              error: { type: 'string' },
            },
          },
          WorkerMetricsStatus: {
            type: 'object',
            properties: {
              workers: { type: 'array', items: { $ref: '#/components/schemas/WorkerMetrics' } },
            },
          },
        },
      },
    },
  },
});

import { useResourceMonitor, useContainerManager } from '../../utils/services';
import { requireAuth } from '../../utils/auth-helpers';

export default defineEventHandler((event) => {
  const { user } = requireAuth(event);
  const all = useResourceMonitor().getWorkerMetricsStatus().workers;
  if (user.role === 'admin') return { workers: all };
  const mgr = useContainerManager();
  const workers = all.filter((m) => mgr.get(m.workerId)?.userId === user.id);
  return { workers };
});
