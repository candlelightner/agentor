import { test, expect } from '@playwright/test';
import { isWorkerMetricAvailable, withWorkerMetricFreshness } from '../../orchestrator/shared/worker-metrics';
import { ResourceMonitor } from '../../orchestrator/server/utils/resource-monitor';
import { ManagementStatusDomain } from '../../orchestrator/server/utils/management-status-domain';
import { useContainerManager, useResourceMonitor } from '../../orchestrator/server/utils/services';
import { formatBytes } from '../../orchestrator/app/utils/format';

const now = Date.parse('2026-01-01T00:01:00Z');
(globalThis as any).useLogger ??= () => ({ warn() {} });
const sample = (): any => ({ workerId: 'fixture-worker', containerName: 'fixture-runtime', displayName: 'Fixture',
  status: 'running', cpuCapacity: 'worker', cpuUtilization: 25, memoryAccounting: 'guest-htop',
  memoryUsedBytes: 1024, memoryLimitBytes: 4096, memoryUtilization: 25, diskUsedBytes: 0,
  netRxBytesPerSec: 0, netTxBytesPerSec: 0, blkReadBytesPerSec: 0, blkWriteBytesPerSec: 0,
  lastChecked: new Date(now).toISOString() });

test('stale, missing, invalid and unavailable samples never become current on read', () => {
  expect(isWorkerMetricAvailable(sample(), now)).toBe(true);
  for (const patch of [{ lastChecked: null }, { lastChecked: 'invalid' },
    { lastChecked: new Date(now - 30_001).toISOString() }, { lastChecked: new Date(now + 30_001).toISOString() },
    { status: 'unknown' }, { error: 'Unavailable' }]) {
    const metric = { ...sample(), ...patch };
    expect(isWorkerMetricAvailable(metric, now)).toBe(false);
    const aged = withWorkerMetricFreshness(metric, now);
    expect(aged.lastChecked).toBe(metric.lastChecked);
    expect(aged.memoryUsedBytes).toBe(metric.memoryUsedBytes);
    expect(isWorkerMetricAvailable(aged, now)).toBe(false);
  }
  expect(formatBytes(1024 ** 3, true)).toBe('1.0 GiB');
  expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
});

test('monitor expires stored metrics and MCP preserves accounting, age and capacity', async () => {
  const metric = sample(), worker: any = { id: metric.workerId, containerName: metric.containerName,
    containerId: 'fixture-incarnation', status: 'running', userId: 'fixture-owner' };
  const monitor = new ResourceMonitor({} as any, { get: () => worker } as any);
  (monitor as any).workers.set(metric.containerName, metric);
  (monitor as any).incarnations.set(metric.containerName, worker.containerId);
  expect(monitor.getWorkerMetric(worker.id)).toMatchObject({ status: 'unknown', lastChecked: metric.lastChecked });
  expect(monitor.getWorkerMetricsStatus().workers).toHaveLength(1);
  const adapter = new ManagementStatusDomain({ metrics: monitor, containers: { get: () => worker }, workers: { findById: () => undefined } } as any);
  const result = (await adapter.execute('workers.metrics.get', { workerId: worker.id })).result as any;
  expect(result).toMatchObject({ status: 'unknown', memoryAccounting: 'guest-htop', cpuCapacity: 'worker',
    lastChecked: metric.lastChecked, memoryUsedBytes: 1024, memoryLimitBytes: 4096, memoryUtilization: 25 });
});

test('single-worker API reports unsampled RAM explicitly and authorizes access first', async () => {
  const containers = useContainerManager(), monitor = useResourceMonitor();
  const savedGet = containers.get, savedMetric = monitor.getWorkerMetric;
  const globals = globalThis as any;
  const values = { defineRouteMeta: () => {}, defineEventHandler: (handler: any) => handler, getRouterParam: () => 'fixture-worker' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  try {
    containers.get = (() => ({ id: 'fixture-worker', userId: 'owner', containerName: 'fixture', status: 'running' })) as any;
    let reads = 0;
    monitor.getWorkerMetric = () => { reads++; return undefined; };
    Object.assign(globals, values);
    const route = (await import('../../orchestrator/server/api/containers/[id]/metrics.get')).default as any;
    expect(() => route({ context: {} })).toThrow();
    expect(reads).toBe(0);
    const result = route({ context: { auth: { user: { id: 'owner', role: 'user' }, session: {} } } });
    expect(result).toMatchObject({ status: 'unknown', lastChecked: null, memoryUsedBytes: 0 });
    expect(result.error).toContain('not been sampled');
  } finally {
    containers.get = savedGet; monitor.getWorkerMetric = savedMetric;
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key];
    }
  }
});

test('failed sampling preserves the last reading timestamp instead of turning it into a fresh zero', async () => {
  const metric = sample(), worker: any = { id: metric.workerId, containerName: metric.containerName,
    containerId: 'fixture-incarnation', status: 'running', runtimeKind: 'incus-vm' };
  const monitor = new ResourceMonitor({} as any, { get: () => worker, list: () => [worker],
    incusWorkerMetrics: async () => { throw new Error('Unavailable'); } } as any);
  (monitor as any).workers.set(metric.containerName, metric);
  (monitor as any).incarnations.set(metric.containerName, worker.containerId);
  await (monitor as any).pollWorkers();
  expect(monitor.getWorkerMetric(worker.id)).toMatchObject({ status: 'unknown',
    lastChecked: metric.lastChecked, memoryUsedBytes: metric.memoryUsedBytes });
});
