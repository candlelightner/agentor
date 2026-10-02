import { expect, test } from '@playwright/test';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { withInstanceOperationDeadline } from '../../orchestrator/server/utils/instance-operation-deadline';
import { OperationDeadlineError, operationSettlement, type OperationFailureWithSettlement } from '../../orchestrator/server/utils/operation-deadline';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const label = 'Test coordinated operation';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function failureOf(promise: Promise<unknown>): Promise<OperationFailureWithSettlement> {
  return promise.then(() => { throw new Error('Expected operation rejection'); },
    error => error as OperationFailureWithSettlement);
}

test('admits before invoking thunk and returns its exact value with no retained lease', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), result = { identity: true };
  let linked!: AbortSignal;
  const actual = await withInstanceOperationDeadline(coordinator, signal => {
    expect(coordinator.activeOperations).toBe(1);
    expect(coordinator.mutationAllowed).toBe(true);
    linked = signal;
    return result;
  }, 1000, label);
  expect(actual).toBe(result); expect(linked.aborted).toBe(false);
  expect(coordinator.activeOperations).toBe(0);
});

for (const asynchronous of [false, true]) test(`preserves original operation error and retires child (async=${asynchronous})`, async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), error = new Error('original operation failure');
  const thunk = asynchronous ? async () => { throw error; } : () => { throw error; };
  await expect(withInstanceOperationDeadline(coordinator, thunk, 1000, label)).rejects.toBe(error);
  expect(coordinator.activeOperations).toBe(0);
});

test('preaborted signal retires pending fork without invoking thunk or inventing settlement', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(); let called = false;
  const error = await failureOf(withInstanceOperationDeadline(coordinator, () => { called = true; },
    1000, label, AbortSignal.abort()));
  expect(error).toBeInstanceOf(OperationDeadlineError);
  expect(error).toMatchObject({ code: 'OPERATION_ABORTED', data: { operation: label } });
  expect(error[operationSettlement]).toBeUndefined(); expect(called).toBe(false);
  expect(coordinator.activeOperations).toBe(0);
});

test('abort during admission but before deadline setup cancels the unused fork', async () => {
  const controller = new AbortController();
  class AbortingCoordinator extends InstanceControlPlaneCoordinator {
    override fork() { const child = super.fork(); controller.abort(); return child; }
  }
  const coordinator = new AbortingCoordinator(); let called = false;
  await expect(withInstanceOperationDeadline(coordinator, () => { called = true; },
    1000, label, controller.signal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  expect(called).toBe(false); expect(coordinator.activeOperations).toBe(0);
});

test('closed admission rejects before thunk execution and does not leave a fork', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), barrier = coordinator.begin('admission', 'snapshot');
  let called = false;
  try {
    await expect(withInstanceOperationDeadline(coordinator, () => { called = true; }, 1000, label))
      .rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    expect(called).toBe(false); expect(coordinator.activeOperations).toBe(0);
    barrier.assertDrained();
  } finally { barrier.release(); }
});

test('runtime promise input is rejected before admission; no retroactive registration', async () => {
  const coordinator = new InstanceControlPlaneCoordinator();
  // The public type intentionally has no Promise-input overload.
  // @ts-expect-error already-started promises must not be accepted
  await expect(withInstanceOperationDeadline(coordinator, Promise.resolve(1), 1000, label))
    .rejects.toThrow('unstarted operation thunk');
  expect(coordinator.activeOperations).toBe(0);
});

test('start refusal retires an otherwise pending fork and preserves original error', async () => {
  const error = new Error('synthetic start refusal');
  class RefusingCoordinator extends InstanceControlPlaneCoordinator {
    override fork(): ReturnType<InstanceControlPlaneCoordinator['fork']> {
      const child = super.fork();
      return { run: () => Promise.reject(error), cancel: child.cancel };
    }
  }
  const coordinator = new RefusingCoordinator(); let called = false;
  await expect(withInstanceOperationDeadline(coordinator, () => { called = true; }, 1000, label)).rejects.toBe(error);
  expect(called).toBe(false); expect(coordinator.activeOperations).toBe(0);
});

for (const rejects of [false, true]) test(`caught abort retains actual work and cleanup through drain (late reject=${rejects})`, async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), work = deferred(), cleanup = deferred();
  const cleanupStarted = deferred(), controller = new AbortController();
  const lateError = new Error('late operation failure'); let linked!: AbortSignal;
  let caught!: OperationFailureWithSettlement, mutated = false, cleaned = false;
  const writer = coordinator.run(async () => {
    try {
      await withInstanceOperationDeadline(coordinator, async signal => {
        linked = signal;
        try {
          await work.promise;
          await coordinator.run(() => { mutated = true; });
          if (rejects) throw lateError;
        } finally {
          cleanupStarted.resolve();
          await cleanup.promise;
          await coordinator.run(() => { cleaned = true; });
        }
      }, 1000, label, controller.signal);
    } catch (error) { caught = error as OperationFailureWithSettlement; return 'handled'; }
  });
  expect(coordinator.activeOperations).toBe(2);
  controller.abort();
  expect(await writer).toBe('handled');
  expect(caught).toMatchObject({ code: 'OPERATION_ABORTED' });
  expect(linked.aborted).toBe(true); expect(coordinator.activeOperations).toBe(1);
  let settled = false;
  void caught[operationSettlement]!.then(() => { settled = true; });
  const barrier = coordinator.begin('caught-abort', 'snapshot'); let drained = false;
  const draining = barrier.drain({ timeoutMs: 1000 }).then(() => { drained = true; });
  try {
    await expect(coordinator.run(() => { throw new Error('unrelated root ran'); }))
      .rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    work.resolve(); await cleanupStarted.promise;
    expect(mutated).toBe(true); expect(cleaned).toBe(false);
    expect(settled).toBe(false); expect(drained).toBe(false);
    expect(() => barrier.assertDrained()).toThrow();
    cleanup.resolve(); await draining; await caught[operationSettlement];
    expect(cleaned).toBe(true); expect(settled).toBe(true);
    expect(coordinator.activeOperations).toBe(0); barrier.assertDrained();
  } finally { work.resolve(); cleanup.resolve(); await draining; barrier.release(); }
});

test('caught real timer deadline returns before late nested mutation and preserves cleanup admission', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), work = deferred();
  let caught!: OperationFailureWithSettlement, mutated = false;
  const writer = coordinator.run(async () => {
    try {
      await withInstanceOperationDeadline(coordinator, async signal => {
        await work.promise; expect(signal.aborted).toBe(true);
        await coordinator.run(() => { mutated = true; });
      }, 5, label);
    } catch (error) { caught = error as OperationFailureWithSettlement; }
  });
  await writer;
  expect(caught).toMatchObject({ code: 'DOCKER_OPERATION_TIMEOUT', data: { timeoutMs: 5, operation: label } });
  expect(mutated).toBe(false); expect(coordinator.activeOperations).toBe(1);
  const barrier = coordinator.begin('caught-timeout', 'snapshot');
  work.resolve(); await barrier.drain({ timeoutMs: 1000 });
  expect(mutated).toBe(true); expect(coordinator.activeOperations).toBe(0);
  barrier.assertDrained(); barrier.release();
});

test('uncaught bounded error preserves settlement linkage and nested child context', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), work = deferred(), controller = new AbortController();
  let nested = false;
  const caller = coordinator.run(() => withInstanceOperationDeadline(coordinator, async () => {
    await work.promise; await coordinator.run(() => { nested = true; });
  }, 1000, label, controller.signal));
  controller.abort();
  const error = await failureOf(caller);
  expect(error).toMatchObject({ code: 'OPERATION_ABORTED' });
  expect(error[operationSettlement]).toBeInstanceOf(Promise);
  // Parent's legacy settlement tracking and explicit child are conservative,
  // independent lifetimes; only the child must remain live for nested writes.
  expect(coordinator.activeOperations).toBe(2);
  const barrier = coordinator.begin('uncaught', 'restore');
  work.resolve(); await barrier.drain({ timeoutMs: 1000 });
  expect(nested).toBe(true); expect(coordinator.activeOperations).toBe(0);
  barrier.assertDrained(); barrier.release();
});

test('caller abort during synchronous thunk startup is replayed and late rejection is observed', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), work = deferred(), controller = new AbortController();
  let linked!: AbortSignal;
  const caller = withInstanceOperationDeadline(coordinator, signal => {
    linked = signal; controller.abort(); return work.promise;
  }, 1000, label, controller.signal);
  const failure = await failureOf(caller);
  expect(failure).toMatchObject({ code: 'OPERATION_ABORTED' }); expect(linked.aborted).toBe(true);
  expect(coordinator.activeOperations).toBe(1);
  work.reject(new Error('observed late rejection'));
  await failure[operationSettlement]; await tick();
  expect(coordinator.activeOperations).toBe(0);
});

test('pre-registered detached cleanup is independently retained after operation return', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), cleanup = deferred();
  let child!: ReturnType<InstanceControlPlaneCoordinator['fork']>;
  await withInstanceOperationDeadline(coordinator, () => { child = coordinator.fork(); }, 1000, label);
  expect(coordinator.activeOperations).toBe(1);
  const barrier = coordinator.begin('detached', 'snapshot');
  const running = child.run(async () => { await cleanup.promise; await coordinator.run(() => {}); });
  expect(() => barrier.assertDrained()).toThrow();
  cleanup.resolve(); await running; await barrier.drain({ timeoutMs: 1000 });
  expect(coordinator.activeOperations).toBe(0); barrier.assertDrained(); barrier.release();
});

test('unregistered work cannot reuse child context after the actual thunk settles', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), later = deferred(); let unregistered!: Promise<unknown>;
  await withInstanceOperationDeadline(coordinator, () => {
    unregistered = later.promise.then(() => coordinator.run(() => 'not allowed'));
  }, 1000, label);
  const barrier = coordinator.begin('stale-child', 'snapshot');
  try {
    await barrier.drain({ timeoutMs: 1000 }); later.resolve();
    await expect(unregistered).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    expect(coordinator.activeOperations).toBe(0); barrier.assertDrained();
  } finally { barrier.release(); }
});

test('late rejected cleanup is observed and releases exactly its registered child', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(), cleanup = deferred(), controller = new AbortController();
  const unrelated = coordinator.fork(); let cleaned = false;
  const caller = withInstanceOperationDeadline(coordinator, async () => {
    try { return 'operation completed'; }
    finally {
      await cleanup.promise;
      await coordinator.run(() => { cleaned = true; });
      throw new Error('late cleanup failure');
    }
  }, 1000, label, controller.signal);
  controller.abort(); const failure = await failureOf(caller);
  expect(coordinator.activeOperations).toBe(2);
  const barrier = coordinator.begin('cleanup-failure', 'snapshot');
  cleanup.resolve(); await failure[operationSettlement]; await tick();
  expect(cleaned).toBe(true); expect(coordinator.activeOperations).toBe(1);
  expect(() => barrier.assertDrained()).toThrow();
  expect(unrelated.cancel()).toBe(true); await barrier.drain({ timeoutMs: 1000 });
  barrier.assertDrained(); barrier.release();
});
