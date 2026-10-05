import { test, expect } from '@playwright/test';
import { WorkerLifecycleCoordinator, withOwnerLifecycleMutation, withOwnerWorkerLifecycleMutation,
  withWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { WorkerGroupNetworkCoordinator } from '../../orchestrator/server/utils/worker-group-manager';
import { randomUUID } from 'node:crypto';
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

test('only active same-owner context reenters; independent requests and expired detached contexts queue', async () => {
  const queue = new WorkerLifecycleCoordinator(), entered = latch(), release = latch(), detached = latch();
  let late!: Promise<void>, lateStarted = false, independentStarted = false;
  await queue.withOwner('owner', async () => {
    await queue.withOwner('owner', async () => {});
    late = detached.promise.then(() => queue.withOwner('owner', async () => { lateStarted = true; }));
  });
  const current = queue.withOwner('owner', async () => { entered.release(); await release.promise; });
  await entered.promise;
  const independent = queue.withOwner('owner', async () => { independentStarted = true; });
  detached.release();
  await new Promise(resolve => setImmediate(resolve));
  expect(lateStarted).toBe(false); expect(independentStarted).toBe(false);
  await queue.withOwner('other-owner', async () => {});
  release.release(); await Promise.all([current, independent, late]);
  expect(lateStarted).toBe(true); expect(independentStarted).toBe(true);
});

test('network and lifecycle batches consistently take owner before group before worker without reentry', async () => {
  const owner = randomUUID(), worker = randomUUID(), groups = new WorkerGroupNetworkCoordinator({} as any);
  const entered = latch(), release = latch(), order: string[] = [];
  const batch = withOwnerLifecycleMutation(owner, () => groups.withOwner(owner, async () => {
    order.push('batch-group'); entered.release(); await release.promise;
    await withWorkerLifecycleMutation(worker, async () => { order.push('batch-worker'); });
  }));
  await entered.promise;
  const request = groups.withOwner(owner, async () => {
    order.push('request-group');
    await withOwnerWorkerLifecycleMutation(owner, worker, async () => { order.push('request-worker'); });
  });
  await new Promise(resolve => setImmediate(resolve));
  expect(order).toEqual(['batch-group']);
  release.release(); await Promise.all([batch, request]);
  expect(order).toEqual(['batch-group', 'batch-worker', 'request-group', 'request-worker']);
});

test('late worker timeout retains worker fence without indefinitely blocking its owner siblings', async () => {
  const owner = randomUUID(), worker = randomUUID(), sibling = randomUUID(), late = latch();
  const timeout = Object.assign(new Error('bounded timeout'), { [operationSettlement]: late.promise });
  const first = withOwnerWorkerLifecycleMutation(owner, worker, async () => { throw timeout; });
  await expect(first).rejects.toThrow('bounded timeout');
  await withOwnerWorkerLifecycleMutation(owner, sibling, async () => {});
  let retried = false;
  const retry = withOwnerWorkerLifecycleMutation(owner, worker, async () => { retried = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(retried).toBe(false);
  late.release(); await retry;
  expect(retried).toBe(true);
});

test('an active owner context does not make the worker queue reentrant', async () => {
  const queue = new WorkerLifecycleCoordinator(); let inner!: Promise<void>, ran = false;
  await queue.withOwner('owner', () => queue.withWorker('worker', async () => {
    inner = queue.withWorker('worker', async () => { ran = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(ran).toBe(false);
  }));
  await inner; expect(ran).toBe(true);
});
