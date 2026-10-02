import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';
import * as userIds from '../../orchestrator/server/utils/user-id';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });
const unavailable = { statusCode: 503, code: 'INSTANCE_SNAPSHOT_MANAGED_VOLUMES_UNAVAILABLE' };
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
let directory: string;
test.beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'agentor-managed-inventory-')); });
test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false);
  await expect.poll(() => gate.activeOperations).toBe(0);
  await rm(directory, { recursive: true, force: true });
});
function manager() { return new ManagedVolumeManager(directory, {} as any); }

/** Real manager/store classes with only their filesystem boundary substituted;
 * no global filesystem patch or live service/Docker singleton is involved. */
async function missingReadManager(filesystem: Partial<typeof fs>) {
  const require = createRequire(import.meta.url);
  async function load(filename: string, modules: Record<string, unknown>) {
    const source = await readFile(new URL(`../../orchestrator/server/utils/${filename}`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const exports: Record<string, any> = {};
    runInNewContext(compiled, {
      exports, structuredClone, Buffer, process, setImmediate,
      useLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      require: (id: string) => modules[id] ?? (id.startsWith('node:') ? require(id) : Object.freeze({})),
    }, { timeout: 1000 });
    return exports;
  }
  const userStore = await load('user-scoped-store.ts', {
    'node:fs/promises': { ...fs, ...filesystem }, './user-id': userIds,
    './operation-deadline': { operationSettlement },
    './instance-snapshot-gate': { instanceControlPlaneCoordinator: gate },
  });
  const volumeStore = await load('managed-volume-store.ts', { './user-scoped-store': userStore });
  const managed = await load('managed-volume-manager.ts', {
    './managed-volume-store': volumeStore,
    './managed-volume-runtime': { ManagedVolumeRuntime: class {} },
    './instance-snapshot-gate': { instanceControlPlaneCoordinator: gate },
  });
  return new managed.ManagedVolumeManager(directory, {});
}

test('managed inventory refuses uninitialized state and never starts lazy loading under a cut', async () => {
  const m = manager(); let starts = 0;
  for (const store of [m.store, m.policies, m.recreations]) store.init = async () => { starts++; };
  const barrier = gate.begin('managed-unready', 'snapshot');
  try {
    expect(() => m.assertInitializedForInstanceSnapshot()).toThrow(expect.objectContaining(unavailable));
    expect(() => m.hasActiveOperationsForInstanceSnapshot()).toThrow(expect.objectContaining(unavailable));
    await expect(m.init()).rejects.toMatchObject({ statusCode: 423 });
    expect(starts).toBe(0); barrier.assertDrained();
  } finally { barrier.release(); }
});

test('ready managed inventory reads under a cut without conferring initialization admission', async () => {
  const m = manager(); await m.init();
  const barrier = gate.begin('managed-ready', 'snapshot');
  try {
    m.assertInitializedForInstanceSnapshot();
    expect(m.hasActiveOperationsForInstanceSnapshot()).toBe(false);
    await expect(m.init()).rejects.toMatchObject({ statusCode: 423 });
    barrier.assertDrained();
  } finally { barrier.release(); }
});

test('pending managed initialization retains late descendants and refuses inventory until drain', async () => {
  const m = manager(), entered = held(), release = held(); let wrote = false;
  m.store.init = async () => { entered.resolve(); await release.promise; await gate.run(() => { wrote = true; }); };
  m.policies.init = async () => {}; m.recreations.init = async () => {};
  const loading = m.init(); await entered.promise;
  const barrier = gate.begin('managed-pending', 'snapshot');
  try {
    expect(() => m.assertInitializedForInstanceSnapshot()).toThrow(expect.objectContaining(unavailable));
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await loading;
    await barrier.drain({ timeoutMs: 1000 }); m.assertInitializedForInstanceSnapshot();
    expect(wrote).toBe(true);
  } finally { release.resolve(); await loading; barrier.release(); }
});

test('a rejected initialization waits sibling work and never publishes ready state', async () => {
  const m = manager(), entered = held(), release = held(); let returned = false, siblingWrote = false;
  m.store.init = async () => { throw new Error('synthetic first failure'); };
  m.policies.init = async () => { entered.resolve(); await release.promise; await gate.run(() => { siblingWrote = true; }); };
  m.recreations.init = async () => {};
  const loading = m.init().catch(error => { returned = true; return error; }); await entered.promise;
  const barrier = gate.begin('managed-init-failure', 'snapshot');
  try {
    await new Promise<void>(yes => setImmediate(yes)); expect(returned).toBe(false);
    expect(() => barrier.assertDrained()).toThrow(); release.resolve();
    expect((await loading).message).toBe('synthetic first failure');
    await barrier.drain({ timeoutMs: 1000 }); expect(siblingWrote).toBe(true);
    expect(() => m.assertInitializedForInstanceSnapshot()).toThrow(expect.objectContaining(unavailable));
  } finally { release.resolve(); await loading; barrier.release(); }
});

for (const [root, filename] of [
  ['', 'managed-volumes.v1.json'], ['retained-storage', 'managed-volumes.v1.json'],
  ['', 'persistence-policies.v1.json'], ['', 'volume-recreations.v1.json'],
]) test(`managed inventory rejects quarantined ${root || 'ordinary'} ${filename} instead of omitting it`, async () => {
  const owner = join(directory, root, 'users', 'owner');
  await mkdir(owner, { recursive: true }); await writeFile(join(owner, filename), '{broken');
  const m = manager(); await m.init();
  const barrier = gate.begin('managed-quarantine', 'snapshot');
  try {
    expect(() => m.assertInitializedForInstanceSnapshot()).toThrow(expect.objectContaining(unavailable));
    expect(() => m.hasActiveOperationsForInstanceSnapshot()).toThrow(expect.objectContaining(unavailable));
    barrier.assertDrained();
  } finally { barrier.release(); }
});

for (const location of ['readdir', 'readFile'] as const)
for (const rejecting of [false, true]) test(`managed initialization retains frozen ${location} ENOENT through ${rejecting ? 'rejected' : 'resolved'} late settlement`, async () => {
  if (location === 'readFile') await mkdir(join(directory, 'users', 'owner'), { recursive: true });
  const release = held(), entered = held();
  const late = release.promise.then(() => { if (rejecting) throw new Error('synthetic late missing-file rejection'); });
  const absent = Object.freeze(Object.defineProperty(Object.assign(new Error('synthetic bounded absence'), { code: 'ENOENT' }), operationSettlement, { value: late }));
  const m = await missingReadManager({ [location]: async () => { entered.resolve(); throw absent; } });
  let returned = false;
  const loading = m.init().then(() => { returned = true; });
  await entered.promise;
  const barrier = gate.begin('managed-missing-late', 'snapshot');
  try {
    await new Promise<void>(yes => setImmediate(yes));
    expect(returned).toBe(false);
    expect(() => m.assertInitializedForInstanceSnapshot()).toThrow(expect.objectContaining(unavailable));
    expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await loading; await barrier.drain({ timeoutMs: 1000 });
    m.assertInitializedForInstanceSnapshot(); expect(m.store.list()).toEqual([]);
  } finally {
    release.resolve(); await loading; barrier.release();
  }
});

for (const rejecting of [false, true]) test(`missing-file recovery preserves owner quarantine until ${rejecting ? 'rejected' : 'resolved'} settlement`, async () => {
  const owner = join(directory, 'users', 'owner');
  await mkdir(owner, { recursive: true });
  await writeFile(join(owner, 'managed-volumes.v1.json'), '{broken');
  const release = held(), entered = held(); let missing = false;
  const late = release.promise.then(() => { if (rejecting) throw new Error('synthetic late missing-file rejection'); });
  const absent = Object.freeze(Object.defineProperty(Object.assign(new Error('synthetic bounded absence'), { code: 'ENOENT' }), operationSettlement, { value: late }));
  const m = await missingReadManager({ readFile: (async (...args: Parameters<typeof fs.readFile>) => {
    if (missing) { entered.resolve(); throw absent; }
    return fs.readFile(...args);
  }) as typeof fs.readFile });
  await m.init(); expect(m.store.hasUnavailableOwners()).toBe(true);
  missing = true; const loading = m.store.loadUser('owner'); await entered.promise;
  const barrier = gate.begin('managed-quarantine-late', 'snapshot');
  try {
    await new Promise<void>(yes => setImmediate(yes));
    expect(m.store.hasUnavailableOwners()).toBe(true);
    expect(() => m.assertInitializedForInstanceSnapshot()).toThrow(expect.objectContaining(unavailable));
    expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await loading; await barrier.drain({ timeoutMs: 1000 });
    expect(m.store.hasUnavailableOwners()).toBe(false); m.assertInitializedForInstanceSnapshot();
  } finally { release.resolve(); await loading; barrier.release(); }
});
