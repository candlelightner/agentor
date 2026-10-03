import { test, expect } from '@playwright/test';
import { ResourceMonitor } from '../../orchestrator/server/utils/resource-monitor';
import { withWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

let previousLogger: unknown;
let warnings: string[];
test.beforeEach(() => {
  previousLogger = (globalThis as any).useLogger;
  warnings = [];
  (globalThis as any).useLogger = () => ({ warn: (message: string) => { warnings.push(message); } });
});
test.afterEach(() => {
  if (previousLogger === undefined) delete (globalThis as any).useLogger;
  else (globalThis as any).useLogger = previousLogger;
});

test('a late stats failure from the old runtime cannot mark the replacement unknown', async () => {
  const worker = { id: 'stats-worker', containerId: 'original', containerName: 'stats-worker', displayName: 'Stats', status: 'running' };
  let reject!: (error: Error) => void;
  let reports = 0;
  const monitor = new ResourceMonitor({ getContainerStats: () => new Promise((_resolve, fail) => { reject = fail; }) } as any,
    { list: () => [worker], get: () => worker, reportRuntimeFailure: () => { reports++; } } as any);
  const poll = (monitor as any).pollWorkers();
  await withWorkerLifecycleMutation(worker.id, async () => { worker.containerId = 'replacement'; });
  reject(new Error('Original container was stopped for recreation'));
  await poll;
  expect(reports).toBe(0);
  expect((monitor as any).workers.size).toBe(0);
});

for (const failure of ['rejection', 'timeout']) test(`a stats ${failure} makes only metrics unknown and preserves worker lifecycle`, async () => {
  const worker = { id: 'stats-current', containerId: 'current', containerName: 'stats-current', displayName: 'Stats', status: 'running' };
  const before = { ...worker };
  let reports = 0;
  const monitor = new ResourceMonitor({ getContainerStats: async () => {
    if (failure === 'timeout') return new Promise(() => {});
    throw new Error('Unresponsive stats sample');
  } } as any, { list: () => [worker], get: () => worker, reportRuntimeFailure: () => {
    reports++;
    worker.status = 'unknown';
  } } as any);
  await (monitor as any).pollWorkers();
  expect(reports).toBe(0);
  expect(worker).toEqual(before);
  expect(monitor.getWorkerMetric(worker.id)).toMatchObject({
    workerId: worker.id, containerName: worker.containerName, status: 'unknown',
    cpuUtilization: 0, memoryUsedBytes: 0,
    error: 'Worker runtime metrics are unavailable. Retry the request.',
  });
  expect(warnings).toEqual([expect.stringContaining(failure === 'timeout'
    ? 'stats(stats-current) timed out after 10000ms' : 'Unresponsive stats sample')]);
});

test('metrics resume after a failed sample without lifecycle recovery', async () => {
  const worker = { id: 'stats-retry', containerId: 'current', containerName: 'stats-retry', displayName: 'Stats', status: 'running' };
  let samples = 0;
  let reports = 0;
  const monitor = new ResourceMonitor({ getContainerStats: async () => {
    if (++samples === 1) throw new Error('Transient stats failure');
    return {
      cpu_stats: { cpu_usage: { total_usage: 2 }, system_cpu_usage: 10 },
      precpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 5 },
      memory_stats: { usage: 128, limit: 256 },
    };
  } } as any, { list: () => [worker], get: () => worker, reportRuntimeFailure: () => { reports++; } } as any);
  await (monitor as any).pollWorkers();
  expect(monitor.getWorkerMetric(worker.id)?.status).toBe('unknown');
  await (monitor as any).pollWorkers();
  expect(samples).toBe(2);
  expect(reports).toBe(0);
  expect(worker.status).toBe('running');
  expect(monitor.getWorkerMetric(worker.id)).toMatchObject({ status: 'running', memoryUsedBytes: 128 });
  expect(monitor.getWorkerMetric(worker.id)?.error).toBeUndefined();
});
