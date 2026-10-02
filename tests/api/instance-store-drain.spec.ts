import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserScopedJsonStore } from '../../orchestrator/server/utils/user-scoped-store';
import { PluginDefinitionStore } from '../../orchestrator/server/utils/plugin-definition-store';
import { GitImageStore } from '../../orchestrator/server/utils/git-image-store';
import { GitImageCatalogManager } from '../../orchestrator/server/utils/git-image-manager';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

(globalThis as any).useLogger = () => ({ error() {}, warn() {}, info() {}, debug() {} });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
type Row = { id: string; userId: string; value: number };
class Store extends UserScopedJsonStore<string, Row> {
  beforeWrite: (userId: string) => Promise<void> = async () => {};
  constructor(directory: string) { super(directory, 'rows.json', row => row.id); }
  save(userId: string, value: number) { return this.setItem(userId, { id: 'row', userId, value }); }
  removeAll() { return this.removeWhere(() => true); }
  override async persistUser(userId: string) { await this.beforeWrite(userId); await super.persistUser(userId); }
}
async function directory() { return mkdtemp(join(tmpdir(), 'agentor-store-drain-')); }
test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false);
  await expect.poll(() => gate.activeOperations).toBe(0);
});

test('closed admission blocks store init/load/mutations before queue or memory changes', async () => {
  const dir = await directory(), store = new Store(dir), git = new GitImageStore(join(dir, 'git'));
  const platform = new PluginDefinitionStore(dir), manager = new GitImageCatalogManager(git);
  const barrier = gate.begin('store-closed', 'snapshot');
  try {
    for (const operation of [() => store.init(), () => store.loadUser('owner'), () => store.save('owner', 1),
      () => store.removeForUser('owner'), () => store.removeAll(), () => platform.init(), () => platform.seedBuiltIns([]),
      () => git.init(), () => git.persist(), () => git.transaction(() => { throw new Error('must not execute'); }),
      () => manager.forgetOwner('owner')])
      await expect(operation()).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    expect(store.list()).toEqual([]); expect((store as any).saveQueues.size).toBe(0);
    expect((manager as any).ownerQueues.size).toBe(0); expect((git as any).initialized).toBeUndefined(); barrier.assertDrained();
  } finally { barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('accepted per-owner queued writes complete through a closed barrier', async () => {
  const dir = await directory(), store = new Store(dir), entered = deferred(), release = deferred(); let writes = 0;
  store.beforeWrite = async () => { if (++writes === 1) { entered.resolve(); await release.promise; } };
  const first = store.save('owner', 1); await entered.promise; const second = store.save('owner', 2);
  const barrier = gate.begin('store-queued', 'snapshot');
  try {
    expect(writes).toBe(1); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await Promise.all([first, second]); await barrier.drain({ timeoutMs: 1000 });
    expect(JSON.parse(await readFile(join(dir, 'users/owner/rows.json'), 'utf8'))[0].value).toBe(2);
    expect((store as any).saveQueues.size).toBe(0);
  } finally { release.resolve(); barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('per-owner error settlement delays its next queue item but not unrelated owners', async () => {
  const dir = await directory(), store = new Store(dir), late = deferred(); let failed = false, ownerWrites = 0;
  await store.save('owner', 0);
  const failure = Object.assign(new Error('bounded writer failure'), { [operationSettlement]: late.promise });
  store.beforeWrite = async owner => { if (owner === 'owner') { ownerWrites++; if (!failed) { failed = true; throw failure; } } };
  try {
    await expect(store.save('owner', 1)).rejects.toBe(failure);
    expect(store.get('owner', 'row')?.value).toBe(0);
    const queued = store.save('owner', 2); await store.save('other', 3); await turn();
    expect(ownerWrites).toBe(1); expect(store.get('other', 'row')?.value).toBe(3);
    const barrier = gate.begin('store-late', 'snapshot');
    try {
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      late.reject(new Error('late writer failed')); await queued; await barrier.drain({ timeoutMs: 1000 });
      expect(store.get('owner', 'row')?.value).toBe(2);
    } finally { late.resolve(); barrier.release(); }
  } finally { late.resolve(); await rm(dir, { recursive: true, force: true }); }
});

test('removeWhere retains logical admission while moving between owner queues', async () => {
  const dir = await directory(), store = new Store(dir), entered = deferred(), release = deferred();
  await store.save('owner-a', 1); await store.save('owner-b', 2);
  store.beforeWrite = async owner => { if (owner === 'owner-a') { entered.resolve(); await release.promise; } };
  const removing = store.removeAll(); await entered.promise; const barrier = gate.begin('store-remove-all', 'snapshot');
  try {
    release.resolve(); expect(await removing).toBe(2); await barrier.drain({ timeoutMs: 1000 }); expect(store.list()).toEqual([]);
  } finally { release.resolve(); barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('reload joins the owner queue and cannot overwrite an in-flight committed mutation', async () => {
  const dir = await directory(), store = new Store(dir), entered = deferred(), release = deferred();
  await store.save('owner', 0);
  store.beforeWrite = async () => { entered.resolve(); await release.promise; };
  const saving = store.save('owner', 1); await entered.promise;
  let loaded = false; const loading = store.loadUser('owner').then(() => { loaded = true; });
  const barrier = gate.begin('store-reload', 'snapshot');
  try {
    await turn(); expect(loaded).toBe(false);
    release.resolve(); await Promise.all([saving, loading]); await barrier.drain({ timeoutMs: 1000 });
    expect(store.get('owner', 'row')?.value).toBe(1);
  } finally { release.resolve(); barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('queued reload preserves corrupt-owner quarantine and independent owner availability', async () => {
  const dir = await directory(), store = new Store(dir);
  await mkdir(join(dir, 'users/broken'), { recursive: true }); await writeFile(join(dir, 'users/broken/rows.json'), '{');
  try {
    await store.init(); expect(() => store.get('broken', 'row')).toThrow('unavailable');
    await expect(store.save('broken', 1)).rejects.toMatchObject({ statusCode: 503 });
    await store.save('healthy', 2); expect(store.get('healthy', 'row')?.value).toBe(2);
    expect(await readFile(join(dir, 'users/broken/rows.json'), 'utf8')).toBe('{');
    await store.removeForUser('broken'); expect(store.get('broken', 'row')).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('platform queue drains accepted seeds and reload without nested-queue deadlock', async () => {
  const dir = await directory(), store = new PluginDefinitionStore(dir), entered = deferred(), release = deferred();
  const persist = (store as any).persistPlatform.bind(store); let writes = 0;
  (store as any).persistPlatform = async () => { if (++writes === 1) { entered.resolve(); await release.promise; } await persist(); };
  const first = store.seedBuiltIns([]); await entered.promise;
  const second = store.seedBuiltIns([]), loading = store.init(); const barrier = gate.begin('platform-queued', 'snapshot');
  try {
    release.resolve(); await Promise.all([first, second, loading]); await barrier.drain({ timeoutMs: 1000 });
    expect(writes).toBe(2); expect(store.list()).toEqual([]);
  } finally { release.resolve(); barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('platform persistence rollback waits exposed late settlement before next write', async () => {
  const dir = await directory(), store = new PluginDefinitionStore(dir), late = deferred(); let writes = 0;
  const previous = (store as any).platform;
  const failure = Object.assign(new Error('platform failure'), { [operationSettlement]: late.promise });
  (store as any).persistPlatform = async () => { if (++writes === 1) throw failure; };
  try {
    await expect(store.seedBuiltIns([])).rejects.toBe(failure); expect((store as any).platform).toBe(previous);
    const next = store.seedBuiltIns([]); await turn(); expect(writes).toBe(1);
    late.reject(new Error('late denied')); await next; expect(writes).toBe(2);
  } finally { late.resolve(); await rm(dir, { recursive: true, force: true }); }
});

test('Git init and accepted transactions serialize startup write through barrier close', async () => {
  const dir = await directory(), entered = deferred(), release = deferred(); let writes = 0;
  const store = new GitImageStore(dir, async () => { if (++writes === 1) { entered.resolve(); await release.promise; } });
  const init = store.init(); await entered.promise;
  const tx = store.transaction(() => { store.state.links.owner = []; }); const barrier = gate.begin('git-init', 'snapshot');
  try {
    release.resolve(); await Promise.all([init, tx]); await barrier.drain({ timeoutMs: 1000 });
    expect(writes).toBe(2); expect(store.state.links).toEqual({ owner: [] });
  } finally { release.resolve(); barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('Git transaction rollback, reads and subsequent persist retain exposed failure settlement', async () => {
  const dir = await directory(), late = deferred(); let writes = 0;
  const failure = Object.assign(new Error('git write timeout'), { [operationSettlement]: late.promise });
  const store = new GitImageStore(dir, async () => { if (++writes === 2) throw failure; });
  try {
    await store.init(); await expect(store.transaction(() => { store.state.links.failed = []; })).rejects.toBe(failure);
    expect(store.state.links).toEqual({}); let observed = false;
    const reading = store.read(() => { observed = true; return structuredClone(store.state.links); });
    const writing = store.persist(); await turn(); expect(writes).toBe(2); expect(observed).toBe(false);
    const barrier = gate.begin('git-late-write', 'snapshot');
    try {
      late.reject(new Error('late git write rejected')); expect(await reading).toEqual({}); await writing;
      await barrier.drain({ timeoutMs: 1000 }); expect(writes).toBe(3);
    } finally { late.resolve(); barrier.release(); }
  } finally { late.resolve(); await rm(dir, { recursive: true, force: true }); }
});

test('Git owner queue keeps remote-wait descendants admitted without blocking another owner', async () => {
  const dir = await directory(), store = new GitImageStore(dir, async () => {}), manager = new GitImageCatalogManager(store);
  await store.init(); const entered = deferred(), release = deferred(); let second = false;
  const first = (manager as any).withOwner('a', async () => { entered.resolve(); await release.promise; await store.transaction(() => { store.state.links.a = []; }); });
  await entered.promise;
  const queued = (manager as any).withOwner('a', async () => { second = true; await store.transaction(() => { store.state.links.b = []; }); });
  await (manager as any).withOwner('other', async () => { await store.transaction(() => { store.state.links.other = []; }); });
  expect(second).toBe(false); const barrier = gate.begin('git-owner-queue', 'snapshot');
  try {
    release.resolve(); await Promise.all([first, queued]); await barrier.drain({ timeoutMs: 1000 });
    expect(store.state.links).toEqual({ other: [], a: [], b: [] }); expect((manager as any).ownerQueues.size).toBe(0);
  } finally { release.resolve(); barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('Git owner queue outcome-neutral late rejection does not strand the next owner operation', async () => {
  const dir = await directory(), manager = new GitImageCatalogManager(new GitImageStore(dir)), late = deferred();
  const failure = Object.assign(new Error('owner bounded failure'), { [operationSettlement]: late.promise }); let ran = false;
  try {
    await expect((manager as any).withOwner('a', async () => { throw failure; })).rejects.toBe(failure);
    const queued = (manager as any).withOwner('a', async () => { ran = true; }); await turn(); expect(ran).toBe(false);
    late.reject(new Error('late owner failure')); await queued; expect(ran).toBe(true);
  } finally { late.resolve(); await rm(dir, { recursive: true, force: true }); }
});
