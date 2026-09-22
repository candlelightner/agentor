import { test, expect } from '@playwright/test';
import { ResourceMonitor } from '../../orchestrator/server/utils/resource-monitor';
import { withWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

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

test('a stats failure from the current stable runtime still reports unknown health', async () => {
  const worker = { id: 'stats-current', containerId: 'current', containerName: 'stats-current', displayName: 'Stats', status: 'running' };
  let reports = 0;
  const monitor = new ResourceMonitor({ getContainerStats: async () => { throw new Error('Unresponsive task'); } } as any,
    { list: () => [worker], get: () => worker, reportRuntimeFailure: () => { reports++; } } as any);
  await (monitor as any).pollWorkers();
  expect(reports).toBe(1);
  expect((monitor as any).workers.get(worker.containerName).status).toBe('unknown');
});
