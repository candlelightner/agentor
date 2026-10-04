import { test, expect } from '@playwright/test';
import { WorkerLifecycleCoordinator } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

const latch = () => {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
};

test('routing mutation occupancy distinguishes observation but includes queued mutations', async () => {
  const queue = new WorkerLifecycleCoordinator(), started = latch(), observation = latch(), mutation = latch();
  const read = queue.withWorker('worker', async () => { started.release(); await observation.promise; }, { runtimeSetup: true });
  await started.promise;
  expect(queue.isBusy('worker')).toBe(true); expect(queue.hasMutation('worker')).toBe(false);
  expect(queue.generation('worker')).toBe(0);
  const write = queue.withWorker('worker', () => mutation.promise);
  expect(queue.hasMutation('worker')).toBe(true); expect(queue.generation('worker')).toBe(1);
  observation.release(); await read;
  expect(queue.hasMutation('worker')).toBe(true);
  mutation.release(); await write;
  await expect.poll(() => queue.isBusy('worker')).toBe(false);
  expect(queue.hasMutation('worker')).toBe(false);
});

test('multiple mutations and late timeout settlement cannot clear route fences prematurely', async () => {
  const queue = new WorkerLifecycleCoordinator(), late = latch(), second = latch();
  const error = Object.assign(new Error('bounded timeout'), { [operationSettlement]: late.promise });
  const first = queue.withWorker('worker', async () => { throw error; });
  const next = queue.withWorker('worker', () => second.promise);
  await expect(first).rejects.toThrow('bounded timeout');
  expect(queue.hasMutation('worker')).toBe(true);
  expect(queue.hasMutation('unrelated')).toBe(false);
  late.release(); await new Promise((resolve) => setImmediate(resolve));
  expect(queue.hasMutation('worker')).toBe(true);
  second.release(); await next;
  await expect.poll(() => queue.isBusy('worker')).toBe(false);
  expect(queue.hasMutation('worker')).toBe(false);
});
