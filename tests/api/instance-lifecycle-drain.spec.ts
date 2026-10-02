import { expect, test } from '@playwright/test';
import {
  WorkerLifecycleCoordinator, withOwnerWorkerLifecycleMutation,
  withOwnerLifecycleMutation, withWorkerLifecycleMutation,
} from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { withInstanceOperationDeadline } from '../../orchestrator/server/utils/instance-operation-deadline';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

function held() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
test.afterEach(async () => {
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(gate.barrierActive).toBe(false);
});

test('direct lifecycle roots reject before acquiring queue or changing generation', async () => {
  const coordinator = new WorkerLifecycleCoordinator(), barrier = gate.begin('lifecycle-new', 'snapshot');
  try {
    await expect(coordinator.withWorker('worker', async () => { throw new Error('must not execute'); }))
      .rejects.toMatchObject({ statusCode: 423 });
    expect(coordinator.currentSequence()).toBe(0); expect(coordinator.isBusy('worker')).toBe(false);
    for (const invoke of [
      () => withOwnerLifecycleMutation('owner', async () => {}),
      () => withWorkerLifecycleMutation('worker', async () => {}),
      () => withOwnerWorkerLifecycleMutation('owner', 'worker', async () => {}),
    ]) await expect(invoke()).rejects.toMatchObject({ statusCode: 423 });
    await barrier.drain({ timeoutMs: 1000 });
  } finally { barrier.release(); }
});

test('snapshot drains queued owner/worker work including writes after awaited boundaries', async () => {
  const first = held(), second = held(), entered = held(); const values: string[] = [];
  const one = withOwnerWorkerLifecycleMutation('owner', 'worker', async () => {
    values.push('first-before'); entered.resolve(); await first.promise;
    await gate.run(() => { values.push('first-after'); });
  });
  const two = withOwnerWorkerLifecycleMutation('owner', 'worker', async () => {
    values.push('second-before'); await second.promise;
    await gate.run(() => { values.push('second-after'); });
  });
  await entered.promise; const barrier = gate.begin('lifecycle-queued', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); first.resolve(); await one;
    expect(() => barrier.assertDrained()).toThrow(); second.resolve(); await two;
    await barrier.drain({ timeoutMs: 1000 });
    expect(values).toEqual(['first-before', 'first-after', 'second-before', 'second-after']);
  } finally { first.resolve(); second.resolve(); await Promise.all([one, two]); barrier.release(); }
});

test('a failed queued lifecycle operation cannot release its admitted successor', async () => {
  const coordinator = new WorkerLifecycleCoordinator(), release = held(); let written = false;
  const one = coordinator.withWorker('worker', async () => { throw new Error('synthetic failure'); });
  const rejected = expect(one).rejects.toThrow('synthetic failure');
  const two = coordinator.withWorker('worker', async () => { await release.promise; written = true; });
  const barrier = gate.begin('lifecycle-error', 'snapshot');
  try {
    await rejected; expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await two; await barrier.drain({ timeoutMs: 1000 }); expect(written).toBe(true);
  } finally { release.resolve(); await two; barrier.release(); }
});

test('lifecycle timeout releases caller but retains actual mutation and descendant cleanup', async () => {
  const release = held(), entered = held(); let cleaned = false;
  const operation = withOwnerWorkerLifecycleMutation('owner', 'timeout-worker', () =>
    withInstanceOperationDeadline(gate, async () => {
      entered.resolve(); await release.promise;
      await gate.run(() => { cleaned = true; });
    }, 10, 'Synthetic lifecycle'));
  const rejected = expect(operation).rejects.toMatchObject({ code: 'DOCKER_OPERATION_TIMEOUT' });
  await entered.promise; const barrier = gate.begin('lifecycle-timeout', 'snapshot');
  try {
    await rejected;
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(cleaned).toBe(false); release.resolve(); await barrier.drain({ timeoutMs: 1000 }); expect(cleaned).toBe(true);
  } finally { release.resolve(); await rejected; barrier.release(); }
});

test('rejected late settlement releases queue accounting without an unhandled tail rejection', async () => {
  const coordinator = new WorkerLifecycleCoordinator(), entered = held();
  let reject!: (error: Error) => void;
  const settlement = new Promise<void>((_yes, no) => { reject = no; });
  const original = Object.assign(new Error('bounded failure'), { [operationSettlement]: settlement });
  const first = coordinator.withWorker('worker', async () => { entered.resolve(); throw original; });
  const failed = expect(first).rejects.toBe(original);
  let successorRan = false;
  const second = coordinator.withWorker('worker', async () => { successorRan = true; });
  await entered.promise; const barrier = gate.begin('lifecycle-rejected-settlement', 'snapshot');
  try {
    await failed; expect(successorRan).toBe(false); expect(() => barrier.assertDrained()).toThrow();
    reject(new Error('actual client operation failed'));
    await second; await barrier.drain({ timeoutMs: 1000 });
    await new Promise<void>(resolve => setImmediate(resolve)); // Flush rejected promise reporting.
    expect(successorRan).toBe(true); expect(coordinator.isBusy('worker')).toBe(false);
  } finally { reject(new Error('test cleanup')); await failed; await second; barrier.release(); }
});
