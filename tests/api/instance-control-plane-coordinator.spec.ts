import { expect, test } from '@playwright/test';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('close admission synchronously, then drain both halves of an admitted mutation', async () => {
  const gate = new InstanceControlPlaneCoordinator(), next = deferred();
  const values = { first: 0, second: 0 };
  const writer = gate.run(async () => { values.first = 1; await next.promise; values.second = 1; });
  expect(gate.activeOperations).toBe(1);
  const barrier = gate.begin('snapshot', 'snapshot');
  let ran = false, drained = false;
  await expect(gate.run(() => { ran = true; })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
  const waiting = barrier.drain({ timeoutMs: 1000 }).then(() => { drained = true; });
  expect(drained).toBe(false); expect(ran).toBe(false);
  expect(() => barrier.assertDrained()).toThrow();
  next.resolve(); await writer; await waiting; barrier.assertDrained();
  expect(values).toEqual({ first: 1, second: 1 }); expect(gate.activeOperations).toBe(0);
  barrier.release(); await gate.run(() => { ran = true; }); expect(ran).toBe(true);
});

test('admitted nested writes remain legal during drain without admitting unrelated roots', async () => {
  const gate = new InstanceControlPlaneCoordinator(), resume = deferred(), child = deferred();
  const started = deferred();
  const parent = gate.run(async () => {
    await resume.promise; expect(gate.mutationAllowed).toBe(true);
    await gate.run(async () => { started.resolve(); await child.promise; });
  });
  const barrier = gate.begin('job', 'restore');
  expect(gate.mutationAllowed).toBe(false);
  const waiting = barrier.drain({ timeoutMs: 1000 });
  resume.resolve(); await started.promise; expect(gate.activeOperations).toBe(2);
  child.resolve(); await parent; await waiting; barrier.assertDrained(); barrier.release();
});

test('explicitly forked queued work survives parent completion and keeps drain pending', async () => {
  const gate = new InstanceControlPlaneCoordinator(), held = deferred();
  const child = await gate.run(() => gate.fork());
  expect(gate.activeOperations).toBe(1);
  const barrier = gate.begin('job', 'snapshot');
  let drained = false;
  const waiting = barrier.drain({ timeoutMs: 1000 }).then(() => { drained = true; });
  const running = child.run(async () => { await held.promise; await gate.run(() => {}); });
  expect(child.cancel()).toBe(false); expect(drained).toBe(false);
  held.resolve(); await running; await waiting;
  await expect(child.run(() => {})).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_LEASE_STALE' });
  barrier.release();
});

test('an unstarted fork can be cancelled once, never replayed', async () => {
  const gate = new InstanceControlPlaneCoordinator(), child = gate.fork();
  const barrier = gate.begin('job', 'snapshot');
  expect(gate.activeOperations).toBe(1); expect(child.cancel()).toBe(true); expect(child.cancel()).toBe(false);
  await expect(child.run(() => {})).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_LEASE_STALE' });
  await barrier.drain({ timeoutMs: 1000 }); barrier.assertDrained(); barrier.release();
});

test('stale inherited async context cannot admit unregistered delayed work', async () => {
  const gate = new InstanceControlPlaneCoordinator(), delayed = deferred();
  let late!: Promise<unknown>;
  await gate.run(() => {
    // Deliberately not forked; this is the integration bug the guard detects.
    late = delayed.promise.then(() => gate.run(() => 'unsafe'));
  });
  const barrier = gate.begin('job', 'snapshot');
  await barrier.drain({ timeoutMs: 1000 });
  delayed.resolve();
  await expect(late).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
  expect(gate.activeOperations).toBe(0); barrier.assertDrained(); barrier.release();
});

for (const rejects of [false, true]) test(`bounded caller failure retains lifetime until actual settlement (reject=${rejects})`, async () => {
  const gate = new InstanceControlPlaneCoordinator(), settled = deferred();
  const failure = Object.assign(new Error('deadline'), { [operationSettlement]: settled.promise });
  await expect(gate.run(async () => { throw failure; })).rejects.toBe(failure);
  expect(gate.activeOperations).toBe(1);
  const barrier = gate.begin('job', 'snapshot');
  let drained = false;
  const waiting = barrier.drain({ timeoutMs: 1000 }).then(() => { drained = true; });
  expect(drained).toBe(false);
  if (rejects) settled.reject(new Error('late failure')); else settled.resolve();
  await waiting; expect(gate.activeOperations).toBe(0); barrier.release();
});

test('bounded parent rejection does not discard independently forked cleanup', async () => {
  const gate = new InstanceControlPlaneCoordinator(), settled = deferred(), cleaned = deferred();
  let cleanup!: ReturnType<InstanceControlPlaneCoordinator['fork']>;
  await expect(gate.run(async () => {
    cleanup = gate.fork();
    throw Object.assign(new Error('deadline'), { [operationSettlement]: settled.promise });
  })).rejects.toThrow('deadline');
  const barrier = gate.begin('job', 'snapshot');
  const cleanupTask = cleanup.run(() => cleaned.promise);
  settled.resolve(); await Promise.resolve(); expect(gate.activeOperations).toBe(1);
  expect(() => barrier.assertDrained()).toThrow();
  cleaned.resolve(); await cleanupTask; await barrier.drain({ timeoutMs: 1000 }); barrier.release();
});

test('drain timeout does not erase active writers, release barrier, or permit snapshot', async () => {
  const gate = new InstanceControlPlaneCoordinator(), next = deferred();
  const writing = gate.run(() => next.promise), barrier = gate.begin('job', 'snapshot');
  await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
  expect(gate.activeOperations).toBe(1); expect(gate.barrierActive).toBe(true);
  expect(() => barrier.assertDrained()).toThrow();
  next.resolve(); await writing; await barrier.drain({ timeoutMs: 1000 }); barrier.release();
});

for (const before of [false, true]) test(`drain abort preserves operation accounting (already aborted=${before})`, async () => {
  const gate = new InstanceControlPlaneCoordinator(), held = deferred(), controller = new AbortController();
  const writer = gate.run(() => held.promise), barrier = gate.begin('job', 'restore');
  if (before) controller.abort();
  const waiting = barrier.drain({ timeoutMs: 1000, signal: controller.signal });
  if (!before) controller.abort();
  await expect(waiting).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_ABORTED' });
  expect(gate.activeOperations).toBe(1); expect(gate.barrierActive).toBe(true);
  held.resolve(); await writer; barrier.assertDrained(); barrier.release();
});

test('duplicate acquisition is rejected and stale release cannot unlock a later same-job barrier', async () => {
  const gate = new InstanceControlPlaneCoordinator(), first = gate.begin('job', 'snapshot');
  expect(() => gate.begin('job', 'snapshot')).toThrow(); expect(() => gate.begin('other', 'restore')).toThrow();
  first.release(); const second = gate.begin('job', 'snapshot'); first.release();
  expect(gate.barrierActive).toBe(true);
  await expect(first.drain({ timeoutMs: 1000 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_STALE' });
  expect(() => first.assertDrained()).toThrow(); await second.drain({ timeoutMs: 1000 }); second.release();
});

test('releasing a barrier rejects its pending drain and keeps outstanding writers accounted', async () => {
  const gate = new InstanceControlPlaneCoordinator(), held = deferred();
  const writer = gate.run(() => held.promise), barrier = gate.begin('job', 'snapshot');
  const waiting = barrier.drain({ timeoutMs: 1000 }); barrier.release();
  await expect(waiting).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_STALE' });
  expect(gate.activeOperations).toBe(1); held.resolve(); await writer;
});

test('draining from a live admitted scope is rejected before self-deadlock', async () => {
  const gate = new InstanceControlPlaneCoordinator();
  await gate.run(async () => {
    const barrier = gate.begin('job', 'restore');
    await expect(barrier.drain({ timeoutMs: 1000 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_SELF' });
    barrier.release();
  });
  expect(gate.activeOperations).toBe(0);
});

test('synchronous throw and ordinary rejection retire only their own scopes', async () => {
  const gate = new InstanceControlPlaneCoordinator(), other = gate.fork();
  await expect(gate.run(() => { throw new Error('sync'); })).rejects.toThrow('sync');
  await expect(gate.run(async () => { throw new Error('async'); })).rejects.toThrow('async');
  expect(gate.activeOperations).toBe(1); other.cancel(); expect(gate.activeOperations).toBe(0);
});

test('coordinators do not share admission, contexts or barriers', async () => {
  const first = new InstanceControlPlaneCoordinator(), second = new InstanceControlPlaneCoordinator();
  const barrier = second.begin('job', 'snapshot');
  await first.run(async () => { await expect(second.run(() => {})).rejects.toThrow(); });
  await barrier.drain({ timeoutMs: 1000 }); barrier.release();
});

test('invalid barrier identity, kind and drain deadlines fail without releasing admission', async () => {
  const gate = new InstanceControlPlaneCoordinator();
  expect(() => gate.begin('../bad', 'snapshot')).toThrow();
  expect(() => gate.begin('job', 'other' as any)).toThrow(); expect(gate.barrierActive).toBe(false);
  const barrier = gate.begin('job', 'snapshot');
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 300001])
    await expect(barrier.drain({ timeoutMs })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_INVALID' });
  expect(gate.barrierActive).toBe(true); barrier.release();
});
