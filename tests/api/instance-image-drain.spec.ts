import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageCatalogManager } from '../../orchestrator/server/utils/image-catalog';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(Manager = ImageCatalogManager) {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-image-drain-'));
  let beforeWrite: (value: any) => Promise<void> = async () => {};
  let durable: any, writes = 0;
  const manager = new Manager(directory, async value => {
    await beforeWrite(value); durable = structuredClone(value); writes++;
  });
  await manager.init();
  const definition = await manager.create('owner', { name: 'drain', description: '',
    baseImage: 'agentor-worker:approved-test', dockerfileFragment: '', contextFiles: [] });
  return { manager, definition, directory, setWriter(fn: typeof beforeWrite) { beforeWrite = fn; },
    get durable() { return durable; }, get writes() { return writes; },
    async close() {
      await manager.simulateRestart();
      await Promise.allSettled([...(manager as any).definitionBuilds.values()]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// Execute the actual module with only inert Docker/services boundaries. Dynamic
// service imports must never reach real singleton state in test-worker tests.
async function testWorkerManager(service: { create(): Promise<{ id: string }>; remove(id: string): Promise<void> }) {
  const url = new URL('../../orchestrator/server/utils/image-catalog.ts', import.meta.url);
  const source = await readFile(url, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const modules: Record<string, unknown> = {
    './services': { useContainerManager: () => service },
    './instance-snapshot-gate': { instanceControlPlaneCoordinator: gate },
    './operation-deadline': { operationSettlement },
    dockerode: class {},
  };
  const require = createRequire(url), exports: Record<string, any> = {};
  runInNewContext(compiled, { exports, require: (id: string) => {
    if (Object.hasOwn(modules, id)) return modules[id];
    if (id.startsWith('node:') || id === 'tar-stream') return require(id);
    throw new Error(`Unexpected image test dependency: ${id}`);
  }, structuredClone, Buffer, process, setTimeout, clearTimeout }, { timeout: 1000 });
  return exports.ImageCatalogManager as typeof ImageCatalogManager;
}
test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false); await expect.poll(() => gate.activeOperations).toBe(0);
});

test('image catalog init and action admission reject without writes, job records or queue insertion', async () => {
  const f = await fixture(), before = f.writes, barrier = gate.begin('image-refusal', 'snapshot');
  try {
    for (const operation of [
      () => f.manager.init(), () => f.manager.create('owner', { name: 'blocked', baseImage: 'agentor-worker:approved-test', contextFiles: [] }),
      () => f.manager.startBuild(f.definition.id, 'owner', false, { builder: 'fake' }),
      () => f.manager.startValidation(f.definition.id, 'v1', 'owner', false),
      () => f.manager.startTestWorker(f.definition.id, 'v1', 'owner', false),
      () => f.manager.forgetOwner('owner'),
      () => f.manager.removeDefinition(f.definition.id, 'owner', false),
      () => f.manager.cleanup('owner', false),
    ]) {
      await expect(operation()).rejects.toMatchObject({ statusCode: 423 });
    }
    expect(f.writes).toBe(before); expect(f.manager.publicBuilds('owner', false)).toEqual([]);
    expect((f.manager as any).definitionBuilds.size).toBe(0); barrier.assertDrained();
  } finally { barrier.release(); await f.close(); }
});

test('detached fake builds reserve queued descendants before the snapshot barrier closes', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let held = false;
  f.setWriter(async state => {
    if (!held && state.builds.some((build: any) => build.status === 'running')) {
      held = true; entered.resolve(); await release.promise;
    }
  });
  const first = await f.manager.startBuild(f.definition.id, 'owner', false, { builder: 'fake', fakeDurationMs: 100 });
  await entered.promise;
  const queued = f.manager.startBuild(f.definition.id, 'owner', false, { builder: 'fake', fakeDurationMs: 100 });
  const barrier = gate.begin('image-detached', 'snapshot');
  try {
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    release.resolve(); const second = await queued;
    await barrier.drain({ timeoutMs: 3000 });
    expect(f.manager.publicBuild(first.id, 'owner', false).status).toBe('succeeded');
    expect(f.manager.publicBuild(second.id, 'owner', false).status).toBe('succeeded');
    expect(f.durable.definitions[0].versions).toHaveLength(2);
  } finally { release.resolve(); await queued; barrier.release(); await f.close(); }
});

test('cancel signal cannot settle a fake build while a resumed step is still pending', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  const original = (f.manager as any).mutate.bind(f.manager); let held = false;
  (f.manager as any).mutate = async (operation: any) => {
    const result = await original(operation);
    if (!held && f.manager.publicBuilds('owner', false).some(build => build.phase === 'preflight')) {
      held = true; entered.resolve(); await release.promise;
    }
    return result;
  };
  const build = await f.manager.startBuild(f.definition.id, 'owner', false, { builder: 'fake', fakeDurationMs: 100 });
  await entered.promise;
  expect((await f.manager.cancelBuild(build.id, 'owner', false)).status).toBe('cancelled');
  const writes = f.writes, barrier = gate.begin('image-cancel-step', 'snapshot');
  try {
    expect((f.manager as any).definitionBuilds.size).toBe(1);
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    release.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.manager.publicBuild(build.id, 'owner', false).status).toBe('cancelled');
    expect((f.manager as any).timers.size).toBe(0); expect(f.writes).toBe(writes);
  } finally { release.resolve(); barrier.release(); await f.close(); }
});

test('queued cancellation remains terminal when a later fake step reaches its mutation callback', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), stepQueued = deferred();
  const build = await f.manager.startBuild(f.definition.id, 'owner', false, { builder: 'fake', fakeDurationMs: 400 });
  await expect.poll(() => f.manager.publicBuild(build.id, 'owner', false).phase).toBe('preflight');
  const blocking = (f.manager as any).mutate(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const cancelled = f.manager.cancelBuild(build.id, 'owner', false);
  const original = (f.manager as any).mutate.bind(f.manager);
  (f.manager as any).mutate = (operation: any) => { stepQueued.resolve(); return original(operation); };
  await stepQueued.promise;
  const barrier = gate.begin('image-queued-cancel', 'snapshot');
  try {
    release.resolve(); await blocking; await cancelled; await barrier.drain({ timeoutMs: 1000 });
    expect(f.manager.publicBuild(build.id, 'owner', false).status).toBe('cancelled');
    expect(f.durable.builds[0].status).toBe('cancelled'); expect((f.manager as any).timers.size).toBe(0);
  } finally { release.resolve(); await Promise.allSettled([blocking, cancelled]); barrier.release(); await f.close(); }
});

test('terminalization persistence remains owned until its late error handling completes', async () => {
  const f = await fixture(), terminalizing = deferred(), release = deferred(); let failed = false;
  f.setWriter(async state => {
    if (!failed && state.builds.some((build: any) => build.status === 'running')) {
      failed = true; throw new Error('phase persistence failure');
    }
    if (state.builds.some((build: any) => build.status === 'failed')) {
      terminalizing.resolve(); await release.promise;
    }
  });
  const build = await f.manager.startBuild(f.definition.id, 'owner', false, { builder: 'fake' });
  await terminalizing.promise;
  const barrier = gate.begin('image-terminalization', 'snapshot');
  try {
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    release.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.manager.publicBuild(build.id, 'owner', false).status).toBe('failed');
    expect(f.durable.builds[0].status).toBe('failed');
  } finally { release.resolve(); barrier.release(); await f.close(); }
});

test('an older definition execution cannot remove a newer installed queue tail', async () => {
  const f = await fixture(), first = deferred(), second = deferred(), entered = deferred();
  (f.manager as any).enqueueDefinition('synthetic', () => first.promise);
  (f.manager as any).enqueueDefinition('synthetic', async () => { entered.resolve(); await second.promise; });
  const barrier = gate.begin('image-tail', 'snapshot');
  try {
    first.resolve(); await entered.promise; expect((f.manager as any).definitionBuilds.has('synthetic')).toBe(true);
    expect(() => barrier.assertDrained()).toThrow(); second.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect((f.manager as any).definitionBuilds.has('synthetic')).toBe(false);
  } finally { first.resolve(); second.resolve(); barrier.release(); await f.close(); }
});

async function retainedVersion(f: Awaited<ReturnType<typeof fixture>>) {
  const version = { version: 'v1', digest: `sha256:${'a'.repeat(64)}`, artifactTag: 'synthetic:retained',
    runtimeImage: 'synthetic:retained', baseImage: 'agentor-worker:approved-test', createdAt: new Date().toISOString(),
    readiness: 'ready', compatibility: { state: 'passed', coreState: 'passed', pluginState: 'passed',
      checks: [], requiredFailures: [], warnings: [], completedAt: new Date().toISOString() } };
  await (f.manager as any).mutate(() => { (f.manager as any).state.definitions[0].versions.push(version); });
  return version;
}

test('detached validation queued behind another execution retains its own admitted lifetime', async () => {
  const f = await fixture(), previous = deferred(), validating = deferred(), release = deferred();
  const version = await retainedVersion(f);
  (f.manager as any).enqueueDefinition(f.definition.id, () => previous.promise);
  (f.manager as any).runCompatibilityValidation = async () => {
    validating.resolve(); await release.promise;
    await gate.run(() => {}); return version.compatibility;
  };
  const build = await f.manager.startValidation(f.definition.id, 'v1', 'owner', false);
  const barrier = gate.begin('image-validation', 'snapshot');
  try {
    previous.resolve(); await validating.promise;
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.manager.publicBuild(build.id, 'owner', false).status).toBe('succeeded');
  } finally { previous.resolve(); release.resolve(); barrier.release(); await f.close(); }
});

test('cancelled queued test-worker job retires without entering worker creation', async () => {
  const f = await fixture(), previous = deferred(); await retainedVersion(f);
  (f.manager as any).enqueueDefinition(f.definition.id, () => previous.promise);
  const build = await f.manager.startTestWorker(f.definition.id, 'v1', 'owner', false);
  await f.manager.cancelBuild(build.id, 'owner', false);
  const barrier = gate.begin('image-test-worker', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); previous.resolve(); await barrier.drain({ timeoutMs: 1000 });
    const record = f.manager.publicBuild(build.id, 'owner', false);
    expect(record.status).toBe('cancelled'); expect(record.workerId).toBeUndefined();
    expect(f.durable.builds[0].status).toBe('cancelled');
  } finally { previous.resolve(); barrier.release(); await f.close(); }
});

test('simulated restart cannot release a fake step still returning from persistence', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  const original = (f.manager as any).mutate.bind(f.manager); let held = false;
  (f.manager as any).mutate = async (operation: any) => {
    const result = await original(operation);
    if (!held && f.manager.publicBuilds('owner', false).some(build => build.phase === 'preflight')) {
      held = true; entered.resolve(); await release.promise;
    }
    return result;
  };
  const build = await f.manager.startBuild(f.definition.id, 'owner', false, { builder: 'fake' });
  await entered.promise; await f.manager.simulateRestart();
  const barrier = gate.begin('image-restart-step', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.manager.publicBuild(build.id, 'owner', false).status).toBe('failed');
    expect(f.durable.builds[0].recovery).toBe('restart-failed-safe'); expect((f.manager as any).timers.size).toBe(0);
  } finally { release.resolve(); barrier.release(); await f.close(); }
});

for (const failure of [false, true]) test(`queued cancellation survives validation ${failure ? 'failure' : 'success'} completion`, async () => {
  const f = await fixture(), entered = deferred(), finish = deferred(), completionQueued = deferred();
  const version = await retainedVersion(f);
  (f.manager as any).runCompatibilityValidation = async () => {
    entered.resolve(); await finish.promise;
    if (failure) throw new Error('synthetic validator failure');
    return version.compatibility;
  };
  const build = await f.manager.startValidation(f.definition.id, 'v1', 'owner', false);
  await entered.promise;
  const held = deferred(), release = deferred();
  const blocking = (f.manager as any).mutate(async () => { held.resolve(); await release.promise; });
  await held.promise;
  const cancelled = f.manager.cancelBuild(build.id, 'owner', false);
  const original = (f.manager as any).mutate.bind(f.manager);
  (f.manager as any).mutate = (operation: any) => { completionQueued.resolve(); return original(operation); };
  finish.resolve(); await completionQueued.promise;
  const barrier = gate.begin(`validation-cancel-${failure}`, 'snapshot');
  try {
    release.resolve(); await blocking;
    expect((await cancelled).status).toBe('cancelled');
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.manager.publicBuild(build.id, 'owner', false).status).toBe('cancelled');
    expect(f.durable.builds[0].status).toBe('cancelled');
  } finally { finish.resolve(); release.resolve(); await Promise.allSettled([blocking, cancelled]); barrier.release(); await f.close(); }
});

for (const rejectSettlement of [false, true]) test(`image mutation queue waits failed writer's ${rejectSettlement ? 'rejected' : 'resolved'} settlement`, async () => {
  const f = await fixture(), entered = deferred();
  let settle!: () => void;
  const settlement = new Promise<void>((resolve, reject) => {
    settle = () => rejectSettlement ? reject(new Error('late failure')) : resolve();
  });
  let writes = 0;
  f.setWriter(async () => {
    if (++writes === 1) {
      entered.resolve();
      throw Object.assign(new Error('early writer failure'), { [operationSettlement]: settlement });
    }
  });
  const first = (f.manager as any).mutate(() => {});
  const failed = expect(first).rejects.toThrow('early writer failure');
  await entered.promise; await failed;
  const next = (f.manager as any).mutate(() => {});
  const barrier = gate.begin(`image-writer-settlement-${rejectSettlement}`, 'snapshot');
  try {
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(writes).toBe(1); settle(); await next;
    await barrier.drain({ timeoutMs: 1000 }); expect(writes).toBe(2);
  } finally { settle(); await Promise.allSettled([first, next]); barrier.release(); await f.close(); }
});

for (const failure of [false, true]) test(`queued cancellation survives test-worker ${failure ? 'creation failure' : 'publication and retains cleanup'}`, async () => {
  const entered = deferred(), finish = deferred(), completionQueued = deferred();
  const cleanup = deferred(), cleanupEntered = deferred(); const removed: string[] = [];
  const Manager = await testWorkerManager({
    create: async () => { entered.resolve(); await finish.promise;
      if (failure) throw new Error('synthetic create failure');
      return { id: 'synthetic-created-worker' }; },
    remove: async id => { removed.push(id); cleanupEntered.resolve(); await cleanup.promise; },
  });
  const f = await fixture(Manager); await retainedVersion(f);
  const build = await f.manager.startTestWorker(f.definition.id, 'v1', 'owner', false);
  await entered.promise;
  const held = deferred(), release = deferred();
  const blocking = (f.manager as any).mutate(async () => { held.resolve(); await release.promise; });
  await held.promise;
  const cancelled = f.manager.cancelBuild(build.id, 'owner', false);
  const original = (f.manager as any).mutate.bind(f.manager);
  (f.manager as any).mutate = (operation: any) => { completionQueued.resolve(); return original(operation); };
  finish.resolve(); await completionQueued.promise;
  const barrier = gate.begin(`test-worker-cancel-${failure}`, 'snapshot');
  try {
    release.resolve(); await blocking;
    expect((await cancelled).status).toBe('cancelled');
    if (!failure) {
      await cleanupEntered.promise;
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      expect(removed).toEqual(['synthetic-created-worker']); cleanup.resolve();
    }
    await barrier.drain({ timeoutMs: 1000 });
    const record = f.manager.publicBuild(build.id, 'owner', false);
    expect(record.status).toBe('cancelled'); expect(record.workerId).toBeUndefined();
    expect(f.durable.builds[0].status).toBe('cancelled');
    if (failure) expect(removed).toEqual([]);
  } finally { release.resolve(); finish.resolve(); cleanup.resolve(); await Promise.allSettled([blocking, cancelled]); barrier.release(); await f.close(); }
});
