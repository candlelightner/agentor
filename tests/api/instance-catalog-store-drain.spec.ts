import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultsStore } from '../../orchestrator/server/utils/defaults-store';
import { BuiltInAndUserStore, type BuiltInAndUserItem } from '../../orchestrator/server/utils/built-in-and-user-store';
import { HostMountStore } from '../../orchestrator/server/utils/host-mount-store';
import { HardwareDeviceStore } from '../../orchestrator/server/utils/hardware-device-store';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';

function held() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const log = { info() {}, warn() {}, error() {} };
let previousLogger: unknown;
test.beforeEach(() => { previousLogger = (globalThis as any).useLogger; (globalThis as any).useLogger = () => log; });
test.afterEach(async () => {
  try {
    await expect.poll(() => gate.activeOperations).toBe(0);
    expect(gate.barrierActive).toBe(false);
  } finally { (globalThis as any).useLogger = previousLogger; }
});

class TestDefaults extends DefaultsStore<{ id: string }> {
  beforePersist = async () => {};
  protected override async persist() { await this.beforePersist(); return super.persist(); }
  persistDirect() { return super.persist(); }
}
class TestBuiltIns extends BuiltInAndUserStore<BuiltInAndUserItem, { id: string; name: string }> {
  constructor(directory: string) { super(directory, 'test-built-ins.json', 'test'); }
  snapshotBuiltIn(item: { id: string; name: string }, now: string): BuiltInAndUserItem {
    return { ...item, builtIn: true, userId: null, createdAt: now, updatedAt: now };
  }
  defaultsForTest() { return this.defaults; }
  updateForTest(id: string, patch: Partial<BuiltInAndUserItem>) { return this.updateUserItem(id, patch); }
  createForTest(item: BuiltInAndUserItem) { return this.setItem(item.userId!, item); }
}

test('defaults roots reject before in-memory replacement or persistence and admitted write drains', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-defaults-drain-'));
  const store = new TestDefaults(directory, 'defaults.json', item => item.id), entered = held(), release = held();
  try {
    await store.replace([{ id: 'original' }]);
    const closed = gate.begin('defaults-closed', 'snapshot');
    try {
      for (const operation of [() => store.init(), () => store.replace([{ id: 'denied' }]), () => store.persistDirect()])
        await expect(operation()).rejects.toMatchObject({ statusCode: 423 });
      expect(store.list()).toEqual([{ id: 'original' }]); closed.assertDrained();
    } finally { closed.release(); }
    store.beforePersist = async () => { entered.resolve(); await release.promise; };
    const writing = store.replace([{ id: 'admitted' }]); await entered.promise;
    const barrier = gate.begin('defaults-write', 'snapshot');
    try {
      expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await writing;
      await barrier.drain({ timeoutMs: 1000 });
      expect(JSON.parse(await readFile(join(directory, 'defaults/defaults.json'), 'utf8'))).toEqual([{ id: 'admitted' }]);
    } finally { release.resolve(); await writing; barrier.release(); }
  } finally { release.resolve(); await rm(directory, { recursive: true, force: true }); }
});

test('built-in initialization retains admission across defaults load and later owner load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-built-in-init-'));
  const store = new TestBuiltIns(directory), entered = held(), release = held(); let ownerLoaded = false;
  await mkdir(join(directory, 'users/owner'), { recursive: true });
  store.defaultsForTest().init = async () => { entered.resolve(); await release.promise; };
  store.loadUser = async () => { await gate.run(() => { ownerLoaded = true; }); };
  const loading = store.init(); await entered.promise;
  const barrier = gate.begin('built-in-init', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await loading;
    await barrier.drain({ timeoutMs: 1000 }); expect(ownerLoaded).toBe(true);
  } finally { release.resolve(); await loading; barrier.release(); await rm(directory, { recursive: true, force: true }); }
});

test('built-in seed/update/delete admission preserves immutable defaults and user identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-built-in-writes-'));
  const store = new TestBuiltIns(directory);
  try {
    await store.init(); await store.seedBuiltIns([{ id: 'builtin', name: 'Builtin' }]);
    await store.createForTest({ id: 'user', name: 'User', userId: 'owner', builtIn: false, createdAt: 'original', updatedAt: 'original' });
    const barrier = gate.begin('built-in-closed', 'snapshot');
    try {
      for (const operation of [() => store.seedBuiltIns([]), () => store.updateForTest('user', { name: 'Denied' }), () => store.delete('user')])
        await expect(operation()).rejects.toMatchObject({ statusCode: 423 });
      expect(store.list()).toHaveLength(2); barrier.assertDrained();
    } finally { barrier.release(); }
    await expect(store.delete('builtin')).rejects.toThrow('Cannot delete built-in');
    await expect(store.updateForTest('builtin', { name: 'Bad' })).rejects.toThrow('Cannot modify built-in');
    await store.updateForTest('user', { name: 'Updated', builtIn: true, userId: 'other', id: 'other', createdAt: 'other' });
    expect(store.getById('user')).toMatchObject({ name: 'Updated', builtIn: false, userId: 'owner', createdAt: 'original' });
    await store.delete('user'); expect(store.list().map(item => item.id)).toEqual(['builtin']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const candidate = { kind: 'gpu' as const, selector: 'synthetic-gpu', name: 'Synthetic GPU', deviceNodes: ['/dev/synthetic'], groupIds: [44] };
async function catalogFixture(kind: 'host' | 'hardware') {
  const directory = await mkdtemp(join(tmpdir(), `agentor-${kind}-catalog-drain-`));
  let discoveries = 0;
  const groups = { listForUser: () => [] }, workers = { get: () => undefined };
  const store = kind === 'host'
    ? new HostMountStore(directory, () => '/synthetic-agentor-data', groups as any, workers as any)
    : new HardwareDeviceStore(directory, async () => { discoveries++; return [candidate]; }, groups as any, workers as any);
  const create = (suffix = '') => kind === 'host'
    ? (store as HostMountStore).createPath({ name: `Synthetic${suffix}`, sourcePath: `/synthetic-volume${suffix}` })
    : (store as HardwareDeviceStore).approveDevice({ selector: candidate.selector, name: `Synthetic${suffix}` });
  const remove = (id: string) => kind === 'host' ? (store as HostMountStore).deletePath(id) : (store as HardwareDeviceStore).deleteDevice(id);
  return { directory, store, create, remove, discoveries: () => discoveries, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

for (const kind of ['host', 'hardware'] as const) {
  test(`${kind} catalog closes admission before parallel initialization or approval discovery`, async () => {
    const f = await catalogFixture(kind); let catalogLoads = 0;
    (f.store as any).loadCatalog = async () => { catalogLoads++; };
    const barrier = gate.begin('catalog-closed', 'snapshot');
    try {
      await expect(f.store.init()).rejects.toMatchObject({ statusCode: 423 });
      await expect(f.create()).rejects.toMatchObject({ statusCode: 423 });
      expect(catalogLoads).toBe(0); expect(f.discoveries()).toBe(0); barrier.assertDrained();
    } finally { barrier.release(); await f.cleanup(); }
  });

  for (const failing of ['catalog', 'owners']) test(`${kind} initialization waits for sibling load when ${failing} fails`, async () => {
    const f = await catalogFixture(kind), entered = held(), release = held(); let completed = false, returned = false;
    const original = new Error('synthetic catalog failure');
    if (failing === 'catalog') {
      await mkdir(join(f.directory, 'users/owner'), { recursive: true });
      f.store.loadUser = async () => { entered.resolve(); await release.promise; await gate.run(() => { completed = true; }); };
      (f.store as any).loadCatalog = async () => { throw original; };
    } else {
      await writeFile(join(f.directory, 'users'), 'not a directory');
      (f.store as any).loadCatalog = async () => { entered.resolve(); await release.promise; await gate.run(() => { completed = true; }); };
    }
    const loading = f.store.init().catch(error => { returned = true; return error; }); await entered.promise;
    const barrier = gate.begin('catalog-init-failure', 'snapshot');
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(returned).toBe(false); expect(() => barrier.assertDrained()).toThrow();
      release.resolve(); const error = await loading;
      if (failing === 'catalog') expect(error).toBe(original); else expect(error.code).toBe('ENOTDIR');
      await barrier.drain({ timeoutMs: 1000 }); expect(completed).toBe(true);
    } finally { release.resolve(); await loading; barrier.release(); await f.cleanup(); }
  });

  test(`${kind} catalog queue retains accepted successor through failed write rollback`, async () => {
    const f = await catalogFixture(kind), entered = held(), release = held(); await f.store.init();
    const persist = (f.store as any).persistCatalog.bind(f.store); let writes = 0;
    (f.store as any).persistCatalog = async () => {
      if (++writes === 1) { entered.resolve(); await release.promise; throw new Error('synthetic write failure'); }
      await persist();
    };
    const first = f.create('first'); const failed = expect(first).rejects.toThrow('synthetic write failure');
    await entered.promise; const next = f.create('second'); const barrier = gate.begin('catalog-queue', 'snapshot');
    try {
      expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await failed; const saved = await next;
      await barrier.drain({ timeoutMs: 1000 }); expect(f.store.listCatalog().map(item => item.id)).toEqual([saved.id]);
    } finally { release.resolve(); await Promise.allSettled([first, next]); barrier.release(); await f.cleanup(); }
  });

  test(`${kind} deletion keeps one logical lifetime through catalog write and grant cascade`, async () => {
    const f = await catalogFixture(kind), entered = held(), release = held(); await f.store.init();
    const item = await f.create(); await f.store.setEntitlement('owner', item.id, true);
    const removeWhere = (f.store as any).removeWhere.bind(f.store);
    (f.store as any).removeWhere = async (predicate: any) => { entered.resolve(); await release.promise; return removeWhere(predicate); };
    const deleting = f.remove(item.id); await entered.promise;
    const barrier = gate.begin('catalog-delete', 'snapshot');
    try {
      expect(f.store.listCatalog()).toEqual([]); expect(f.store.list()).toHaveLength(1);
      expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await deleting;
      await barrier.drain({ timeoutMs: 1000 }); expect(f.store.list()).toEqual([]);
    } finally { release.resolve(); await deleting; barrier.release(); await f.cleanup(); }
  });

  test(`${kind} initialization preserves owner quarantine and never overwrites corrupt catalog bytes`, async () => {
    const f = await catalogFixture(kind); await f.store.init();
    try {
      const item = await f.create(); await f.store.setEntitlement('owner', item.id, true);
      const grantsFile = join(f.directory, 'users/owner', kind === 'host' ? 'host-mount-grants.json' : 'hardware-device-grants.json');
      await writeFile(grantsFile, '{'); await f.store.init();
      expect(() => f.store.listForUser('owner')).toThrow('unavailable');
      expect(f.store.listCatalog().map(value => value.id)).toEqual([item.id]);
      expect(await readFile(grantsFile, 'utf8')).toBe('{');
      const catalogFile = join(f.directory, 'admin', kind === 'host' ? 'host-mount-paths.v1.json' : 'hardware-devices.v1.json');
      await writeFile(catalogFile, '{'); await expect(f.store.init()).rejects.toThrow();
      expect(() => f.store.listCatalog()).toThrow('unavailable');
      expect(await readFile(catalogFile, 'utf8')).toBe('{');
    } finally { await f.cleanup(); }
  });
}

test('hardware approval admitted before a delayed synthetic discovery retains catalog publication', async () => {
  const f = await catalogFixture('hardware'), entered = held(), release = held(); await f.store.init();
  (f.store as any).discoverHardware = async () => { entered.resolve(); await release.promise; return [candidate]; };
  const approving = f.create(); await entered.promise; const barrier = gate.begin('hardware-approval', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); const saved = await approving;
    await barrier.drain({ timeoutMs: 1000 }); expect(f.store.listCatalog()[0]?.id).toBe(saved.id);
  } finally { release.resolve(); await approving; barrier.release(); await f.cleanup(); }
});
