import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ExportJobManager } from '../../orchestrator/server/utils/export-jobs';
import { ExportJobStore } from '../../orchestrator/server/utils/export-job-store';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { withOperationDeadline } from '../../orchestrator/server/utils/operation-deadline';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(
  exportWorker: ConstructorParameters<typeof ExportJobManager>[1] = async () => ({ stream: Readable.from(['export']), filename: 'worker.tar' }),
  options: ConstructorParameters<typeof ExportJobManager>[3] = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-export-drain-'));
  const store = new ExportJobStore(directory), errors: string[] = [];
  const manager = new ExportJobManager(directory, exportWorker, message => errors.push(message), {
    store, resolveMissingSecrets: async () => [], ...options,
  });
  await manager.init();
  return { directory, store, manager, errors, async close() {
    manager.stop();
    await expect.poll(() => manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
    await rm(directory, { recursive: true, force: true });
  } };
}
function heldStream() {
  const entered = deferred(), released = deferred(); let destroyedDone = false;
  const stream = new Readable({ read() {}, destroy(error, callback) {
    entered.resolve(); void released.promise.then(() => { destroyedDone = true; callback(error); });
  } });
  return { stream, entered, released, get destroyedDone() { return destroyedDone; } };
}
test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false);
  await expect.poll(() => gate.activeOperations).toBe(0);
});

test('accepted queued exports dispatch as admitted children through a closed barrier', async () => {
  const held = deferred(), entered = deferred(); let calls = 0, writes = 0;
  const f = await fixture(async (_worker, options) => {
    if (++calls === 2) entered.resolve();
    await held.promise;
    await options.onProgress?.({ phase: 'workspace', progress: 50, bytesProcessed: 6 });
    await gate.run(() => { writes++; });
    return { stream: Readable.from(['export']), filename: 'worker.tar' };
  });
  let barrier: ReturnType<typeof gate.begin> | undefined;
  try {
    const jobs = await Promise.all(['one', 'two', 'three'].map(worker => f.manager.create('owner', worker)));
    await entered.promise;
    barrier = gate.begin('export-queued', 'snapshot');
    expect(() => barrier!.assertDrained()).toThrow();
    await expect(f.manager.create('owner', 'new')).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    await expect(f.manager.get(jobs[0]!.id)).rejects.toMatchObject({ statusCode: 423 });
    held.resolve(); await barrier.drain({ timeoutMs: 2000 });
    expect(calls).toBe(3); expect(writes).toBe(3);
    for (const job of jobs) expect(f.store.findById(job.id)?.status).toBe('succeeded');
  } finally { held.resolve(); barrier?.release(); await f.close(); }
});

test('stop during initial persistence terminalizes admission without stranding a queued lease', async () => {
  const f = await fixture(), entered = deferred(), held = deferred();
  const save = f.store.save.bind(f.store);
  f.store.save = async job => { if (job.status === 'queued') { entered.resolve(); await held.promise; } await save(job); };
  const create = f.manager.create('owner', 'worker');
  await entered.promise;
  const barrier = gate.begin('export-shutdown', 'snapshot');
  try {
    f.manager.stop(); held.resolve();
    await expect(create).rejects.toMatchObject({ statusCode: 503 });
    await barrier.drain({ timeoutMs: 1000 });
    expect((f.manager as any).queuedLifetimes.size).toBe(0);
    expect(f.store.list()[0]?.status).toBe('cancelled');
  } finally { held.resolve(); barrier.release(); await f.close(); }
});

test('owner removal during initial save cancels admission and leaves no detached dispatch', async () => {
  const f = await fixture(), entered = deferred(), held = deferred();
  const save = f.store.save.bind(f.store);
  f.store.save = async job => { if (job.status === 'queued') { entered.resolve(); await held.promise; } await save(job); };
  const create = f.manager.create('owner', 'worker');
  await entered.promise;
  const removed = f.manager.removeForUser('owner'), barrier = gate.begin('export-owner', 'snapshot');
  try {
    held.resolve(); await expect(create).rejects.toMatchObject({ statusCode: 409 });
    expect(await removed).toBe(1); await barrier.drain({ timeoutMs: 1000 });
    expect(f.store.list()).toEqual([]);
  } finally { held.resolve(); barrier.release(); await f.close(); }
});

test('cancelled export returning a late stream retains its asynchronous destruction', async () => {
  const started = deferred(), returnStream = deferred(), source = heldStream();
  const f = await fixture(async () => { started.resolve(); await returnStream.promise; return { stream: source.stream, filename: 'worker.tar' }; });
  let barrier: ReturnType<typeof gate.begin> | undefined;
  try {
    const job = await f.manager.create('owner', 'worker'); await started.promise;
    await f.manager.cancel(f.store.findById(job.id)!);
    barrier = gate.begin('export-cancel', 'snapshot');
    returnStream.resolve(); await source.entered.promise;
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(source.destroyedDone).toBe(false);
    source.released.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(source.destroyedDone).toBe(true); expect(f.store.findById(job.id)?.status).toBe('cancelled');
  } finally { returnStream.resolve(); source.released.resolve(); barrier?.release(); await f.close(); }
});

test('artifact-phase persistence failure closes the already-returned stream before cleanup', async () => {
  const source = heldStream(), started = deferred(); let cleaned = false;
  const f = await fixture(async () => { started.resolve(); return { stream: source.stream, filename: 'worker.tar' }; }, {
    removeArtifact: async () => { cleaned = true; },
  });
  const save = f.store.save.bind(f.store);
  f.store.save = async job => { if (job.phase === 'writing-artifact') throw new Error('persistence failed'); await save(job); };
  let barrier: ReturnType<typeof gate.begin> | undefined;
  try {
    const job = await f.manager.create('owner', 'worker'); await started.promise; await source.entered.promise;
    barrier = gate.begin('export-persist-failed', 'snapshot');
    expect(cleaned).toBe(false); expect(() => barrier!.assertDrained()).toThrow();
    source.released.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(cleaned).toBe(true); expect(f.store.findById(job.id)?.status).toBe('failed');
  } finally { source.released.resolve(); barrier?.release(); await f.close(); }
});

test('standalone stream error cannot release export lifetime before delayed destruction', async () => {
  const source = heldStream(); let cleaned = false;
  const f = await fixture(async () => ({ stream: source.stream, filename: 'worker.tar' }), {
    removeArtifact: async () => { cleaned = true; },
  });
  let barrier: ReturnType<typeof gate.begin> | undefined;
  try {
    await f.manager.create('owner', 'worker');
    await expect.poll(() => source.stream.listenerCount('data')).toBeGreaterThan(0);
    barrier = gate.begin('export-error', 'snapshot');
    source.stream.emit('error', new Error('standalone read failure'));
    await source.entered.promise;
    source.stream.emit('close'); // A notification without actual closure is not proof.
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(cleaned).toBe(false); source.released.resolve();
    await barrier.drain({ timeoutMs: 1000 }); expect(cleaned).toBe(true);
  } finally { source.released.resolve(); barrier?.release(); await f.close(); }
});

test('caught producer deadline retains actual settlement and then artifact cleanup writes', async () => {
  const entered = deferred(), held = deferred(), cleaning = deferred(), cleanup = deferred();
  let settled = false;
  const f = await fixture(async () => {
    entered.resolve();
    await withOperationDeadline(async () => { await held.promise; await gate.run(() => { settled = true; }); }, 10, 'Synthetic export');
    throw new Error('deadline expected');
  }, { removeArtifact: async () => { cleaning.resolve(); await cleanup.promise; await gate.run(() => {}); } });
  let barrier: ReturnType<typeof gate.begin> | undefined;
  try {
    const job = await f.manager.create('owner', 'worker'); await entered.promise;
    barrier = gate.begin('export-deadline', 'snapshot');
    await expect(barrier.drain({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(f.store.findById(job.id)?.status).toBe('running'); expect(settled).toBe(false);
    held.resolve(); await cleaning.promise; expect(settled).toBe(true);
    expect(() => barrier!.assertDrained()).toThrow(); cleanup.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.store.findById(job.id)?.status).toBe('failed');
  } finally { held.resolve(); cleanup.resolve(); barrier?.release(); await f.close(); }
});

for (const cancel of [false, true]) test(`export waits for explicit hidden producer/temp cleanup settlement (cancel=${cancel})`, async () => {
  const entered = deferred(), held = deferred();
  const f = await fixture(async () => {
    entered.resolve();
    return { stream: Readable.from(['export']), filename: 'worker.tar', settlement: held.promise };
  });
  let barrier: ReturnType<typeof gate.begin> | undefined;
  try {
    const job = await f.manager.create('owner', 'worker'); await entered.promise;
    if (cancel) await f.manager.cancel(f.store.findById(job.id)!);
    barrier = gate.begin(`export-hidden-${cancel}`, 'snapshot');
    await expect(barrier.drain({ timeoutMs: 25 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    held.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.store.findById(job.id)?.status).toBe(cancel ? 'cancelled' : 'succeeded');
  } finally { held.resolve(); barrier?.release(); await f.close(); }
});

for (const failure of ['success-path', 'artifact-persistence', 'cancelled'] as const)
  test(`rejected producer settlement cannot skip final cleanup (${failure})`, async () => {
    const entered = deferred(), returned = deferred(), cleanup = deferred(); let artifactCleanups = 0;
    const f = await fixture(async () => {
      entered.resolve(); await returned.promise;
      return { stream: Readable.from(['export']), filename: 'worker.tar', settlement: cleanup.promise };
    }, { removeArtifact: async path => { artifactCleanups++; await rm(path, { force: true }); } });
    const save = f.store.save.bind(f.store);
    f.store.save = async job => {
      if (failure === 'artifact-persistence' && job.phase === 'writing-artifact') throw new Error('metadata persistence failed');
      await save(job);
    };
    let barrier: ReturnType<typeof gate.begin> | undefined;
    try {
      const job = await f.manager.create('owner', 'worker'); await entered.promise;
      if (failure === 'cancelled') await f.manager.cancel(f.store.findById(job.id)!);
      const cleanupsBeforeResult = artifactCleanups;
      barrier = gate.begin(`export-reject-${failure}`, 'snapshot');
      returned.resolve();
      await expect.poll(() => (f.manager as any).activeStreams.size).toBe(1);
      expect(() => barrier!.assertDrained()).toThrow();
      cleanup.reject(new Error('producer cleanup rejected'));
      await barrier.drain({ timeoutMs: 1000 });
      expect(f.store.findById(job.id)?.status).toBe(failure === 'cancelled' ? 'cancelled' : 'failed');
      expect(artifactCleanups).toBeGreaterThan(cleanupsBeforeResult);
      expect((f.manager as any).activeStreams.size).toBe(0);
      await expect.poll(() => f.manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
    } finally { returned.resolve(); cleanup.resolve(); barrier?.release(); await f.close(); }
  });

test('expiry cleanup remains admitted across artifact removal and durable metadata deletion', async () => {
  const held = deferred(), entered = deferred();
  const f = await fixture(undefined, { removeArtifact: async () => { entered.resolve(); await held.promise; } });
  await f.store.save({ id: 'expired', userId: 'owner', workerId: 'worker', includeRootfs: false, includeManagedVolumes: false,
    status: 'failed', phase: 'failed', progress: 0, bytesProcessed: 0, createdAt: '2000-01-01', updatedAt: '2000-01-01', expiresAt: '2000-01-01' });
  const operation = (f.manager as any).cleanupExpired(); await entered.promise;
  const barrier = gate.begin('export-expiry', 'snapshot');
  try {
    await expect((f.manager as any).cleanupExpired()).rejects.toMatchObject({ statusCode: 423 });
    expect(() => barrier.assertDrained()).toThrow(); held.resolve(); await operation;
    await barrier.drain({ timeoutMs: 1000 }); expect(f.store.list()).toEqual([]);
  } finally { held.resolve(); await operation; barrier.release(); await f.close(); }
});

test('downloaded artifact owns its file descriptor through actual closure', async () => {
  const f = await fixture(); let stream: Readable | undefined;
  let barrier: ReturnType<typeof gate.begin> | undefined;
  try {
    const job = await f.manager.create('owner', 'worker');
    await expect.poll(() => f.store.findById(job.id)?.status).toBe('succeeded');
    const result = await f.manager.openArtifact(f.store.findById(job.id)!); stream = result.stream;
    barrier = gate.begin('export-download', 'snapshot');
    expect(result.size).toBe(6); expect(() => barrier!.assertDrained()).toThrow();
    stream.destroy(); await barrier.drain({ timeoutMs: 1000 }); expect(stream.closed).toBe(true);
  } finally { stream?.destroy(); barrier?.release(); await f.close(); }
});

test('stop while initialization awaits does not install a cleanup timer afterward', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-export-init-')), entered = deferred(), held = deferred();
  const store = new ExportJobStore(directory), init = store.init.bind(store);
  store.init = async () => { entered.resolve(); await held.promise; await init(); };
  const manager = new ExportJobManager(directory, async () => { throw new Error('must not export'); }, () => {}, {
    store, resolveMissingSecrets: async () => [],
  });
  const operation = manager.init(); await entered.promise;
  const barrier = gate.begin('export-init', 'snapshot');
  try {
    manager.stop(); held.resolve(); await operation; await barrier.drain({ timeoutMs: 1000 });
    expect((manager as any).cleanupTimer).toBeUndefined();
    barrier.release(); await expect(manager.create('owner', 'worker')).rejects.toMatchObject({ statusCode: 503 });
  } finally { held.resolve(); await operation; barrier.release(); manager.stop(); await rm(directory, { recursive: true, force: true }); }
});
