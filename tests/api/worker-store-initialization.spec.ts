import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerStore, type WorkerRecord, type WorkerIncusMigration } from '../../orchestrator/server/utils/worker-store';
import { assertLegacyMigrationAuthority } from '../../orchestrator/server/utils/legacy-incus-migration-authority';
import { assertOriginalRestoreTarget } from '../../orchestrator/server/utils/backup-restore-helper';
import { PortableManagedVolumeRuntime } from '../../orchestrator/server/utils/portable-managed-volume-runtime';
import { useConfig, useWorkerStore } from '../../orchestrator/server/utils/services';
import { WorkerIncusMigrationService, type WorkerIncusMigrationDependencies } from '../../orchestrator/server/utils/worker-incus-migration-service';

const quiet = () => ({ info() {}, warn() {}, error() {}, debug() {} });
(globalThis as any).useLogger = quiet;
const worker = (userId = 'owner'): WorkerRecord => ({ id: randomUUID(), userId,
  displayName: 'Fixture', runtimeKind: 'legacy-docker', status: 'active',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
const pathFor = (dir: string, owner: string) => join(dir, 'users', owner, 'workers.json');
async function seed(dir: string, record: WorkerRecord) {
  await mkdir(join(dir, 'users', record.userId), { recursive: true });
  await writeFile(pathFor(dir, record.userId), JSON.stringify([record]));
}

// Delay after the real first disk read so an in-memory mutation can settle
// before a second caller asks to initialize the same store.
class GatedStore extends WorkerStore {
  reads = 0;
  entered!: () => void;
  readonly loaded = new Promise<void>(resolve => { this.entered = resolve; });
  release!: () => void;
  readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  override async loadUser(owner: string) {
    this.reads++;
    await super.loadUser(owner);
    this.entered();
    await this.gate;
  }
}

test('concurrent initialization shares the first load and preserves mutations made while it settles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-worker-init-flight-'));
  const record = worker(); const store = new GatedStore(dir);
  try {
    await seed(dir, record);
    const first = store.init(); await store.loaded;
    const changed = { ...store.get(record.userId, record.id)!, initScript: undefined, pendingRebuild: true };
    await store.upsert(changed);
    const repeated = Array.from({ length: 20 }, () => store.init());
    expect(repeated.every(promise => promise === first)).toBe(true);
    store.release(); await Promise.all([first, ...repeated]);
    expect(store.reads).toBe(1);
    expect(store.get(record.userId, record.id)).toEqual(changed);
    expect(Object.hasOwn(store.get(record.userId, record.id)!, 'initScript')).toBe(true);
    await store.init(); expect(store.reads).toBe(1);
  } finally { store.release(); await rm(dir, { recursive: true, force: true }); }
});

test('overall initialization failure is singleflight and can be retried after the directory is repaired', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-worker-init-retry-'));
  try {
    await writeFile(join(dir, 'users'), 'not a directory');
    const store = new WorkerStore(dir), first = store.init(), second = store.init();
    expect(second).toBe(first);
    const results = await Promise.allSettled([first, second]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    await rm(join(dir, 'users'));
    const record = worker(); await seed(dir, record);
    const retry = store.init(); expect(retry).not.toBe(first);
    expect(store.init()).toBe(retry);
    await retry; expect(store.get(record.userId, record.id)).toEqual(record);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an empty initial scan stays initialized; explicit reload and fresh authorization stores see new disk data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-worker-init-empty-'));
  try {
    const store = new WorkerStore(dir); await store.init();
    const record = worker(); await seed(dir, record);
    await store.init(); expect(store.list()).toEqual([]);
    const fresh = new WorkerStore(dir); await fresh.init();
    expect(fresh.get(record.userId, record.id)).toEqual(record);
    await store.loadUser(record.userId);
    expect(store.get(record.userId, record.id)).toEqual(record);
    await seed(dir, { ...record, displayName: 'Changed on disk' });
    await store.init(); expect(store.get(record.userId, record.id)?.displayName).toBe('Fixture');
    await store.loadUser(record.userId);
    expect(store.get(record.userId, record.id)?.displayName).toBe('Changed on disk');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('explicit reload still quarantines corrupt owners and recovers only after a valid reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-worker-init-quarantine-'));
  try {
    const bad = worker('broken-owner'), good = worker('healthy-owner');
    await seed(dir, bad); await seed(dir, good);
    const store = new WorkerStore(dir); await store.init();
    const corrupt = '[{"id":'; await writeFile(pathFor(dir, bad.userId), corrupt);
    await expect(store.loadUser(bad.userId)).rejects.toThrow();
    expect(() => store.get(bad.userId, bad.id)).toThrow('unavailable');
    expect(store.list()).toEqual([good]);
    await store.init();
    await expect(store.upsert(bad)).rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(pathFor(dir, bad.userId), 'utf8')).toBe(corrupt);
    await seed(dir, { ...bad, displayName: 'Repaired' });
    await store.init(); expect(() => store.get(bad.userId, bad.id)).toThrow('unavailable');
    await store.loadUser(bad.userId);
    expect(store.get(bad.userId, bad.id)?.displayName).toBe('Repaired');
    await store.upsert({ ...bad, displayName: 'Writable again' });
    expect(store.get(bad.userId, bad.id)?.displayName).toBe('Writable again');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a first scan isolates corrupt owners and explicit loadUser recovers without global rescans', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-worker-init-partial-'));
  try {
    const bad = worker('broken-owner'), good = worker('healthy-owner');
    await seed(dir, bad); await seed(dir, good);
    await writeFile(pathFor(dir, bad.userId), '{broken');
    const store = new WorkerStore(dir); await store.init();
    expect(store.list()).toEqual([good]);
    expect(() => store.get(bad.userId, bad.id)).toThrow('unavailable');
    await seed(dir, bad); await store.loadUser(bad.userId);
    expect(store.get(bad.userId, bad.id)).toEqual(bad);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('default migration status and controlled restore await the first shared bootstrap without Nitro', async () => {
  const store = useWorkerStore(), dir = useConfig().dataDir, record = worker('bootstrap-' + randomUUID());
  const originalLoad = store.loadUser, originalLogger = (globalThis as any).useLogger;
  // Playwright can reuse this module singleton after other specs. Recreate
  // only its pre-bootstrap state; the test still exercises the production
  // default lookup and real init/loadUser implementation against private disk.
  const initialization = (store as any).initialization;
  (store as any).initialization = undefined;
  let entered!: () => void, release!: () => void;
  const loaded = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await seed(dir, record);
    delete (globalThis as any).useLogger;
    store.loadUser = async owner => {
      await originalLoad.call(store, owner);
      if (owner === record.userId) { entered(); await gate; }
    };
    const service = new WorkerIncusMigrationService();
    const internals = service as unknown as { dependencies: WorkerIncusMigrationDependencies };
    // Only authorization is replaced. Default findWorker and store bootstrap
    // remain production code, with the actual first disk load paused midway.
    internals.dependencies = { ...internals.dependencies, isAdminUser: () => true };
    let settled = false;
    const status = service.status(record.id, { kind: 'admin-user', userId: 'fixture-admin' })
      .then(value => { settled = true; return value; });
    await loaded;
    const restore = assertOriginalRestoreTarget(record.userId, record.id).catch(error => error);
    await Promise.resolve(); expect(settled).toBe(false);
    release();
    expect(await status).toEqual({ kind: 'legacy-docker', phase: 'none', recoveryRequired: false, sourceRetained: false });
    // Missing live compute rejects restore, but durable metadata was loaded
    // rather than skipped because this process has no Nitro/services plugin.
    expect(await restore).toMatchObject({ statusCode: 409 });
    expect(store.get(record.userId, record.id)).toEqual(record);
  } finally {
    release(); store.loadUser = originalLoad; (globalThis as any).useLogger = originalLogger;
    await store.removeForUser(record.userId);
    if (initialization) (store as any).initialization = initialization;
  }
});

test('cross-owner live capture and restore admission preserve pending migration authority', async () => {
  const store = useWorkerStore(), dir = useConfig().dataDir;
  const source = worker('migration-' + randomUUID()), target = worker('backup-' + randomUUID());
  const originalLogger = (globalThis as any).useLogger;
  try {
    await store.init(); await store.upsert(target);
    await store.upsert({ ...source, status: 'archived', initScript: undefined });
    await store.unarchive(source.userId, source.id);
    const record = store.get(source.userId, source.id)!;
    let marker: WorkerIncusMigration = { nonce: randomUUID(), phase: 'preparing', source: {
      containerId: 'a'.repeat(64), createdAt: source.createdAt, imageId: 'sha256:' + 'b'.repeat(64), wasRunning: true } };
    marker = (await store.transitionIncusMigration(source.userId, source.id, undefined, marker)).incusMigration!;
    const inspected = { Id: marker.source.containerId, Created: marker.source.createdAt, Image: marker.source.imageId,
      Config: { Labels: { 'agentor.id': source.id } }, Mounts: [], State: { Running: false } } as any;
    const assertSource = () => assertLegacyMigrationAuthority({ current: store.get(source.userId, source.id),
      record, marker, source: inspected, actual: inspected, stopped: true, managed: () => [], sourceManaged: [] });
    expect(() => assertSource()).not.toThrow();
    const runtime = new PortableManagedVolumeRuntime(dir, {
      getContainer: () => ({ inspect: async () => ({ Id: 'fixture-container', State: { Running: true },
        Config: { Labels: { 'agentor.id': target.id } }, Mounts: [] }) }),
    } as any);
    // Real legacy capture coordinator, durable worker admission, empty managed
    // coverage and archive writer. The only Docker call is the source inspect.
    const outputPath = join(dir, 'init-race-' + randomUUID() + '.tar.gz');
    const result = await runtime.capture({ userId: target.userId, workerId: target.id,
      containerId: 'fixture-container', state: 'running', outputPath });
    expect(result.entries).toEqual([]); expect(result.bytes).toBeGreaterThan(0);
    expect(() => assertSource()).not.toThrow();
    expect(Object.hasOwn(store.get(source.userId, source.id)!, 'archivedAt')).toBe(true);
    expect(Object.hasOwn(store.get(source.userId, source.id)!, 'initScript')).toBe(true);
    await rm(outputPath);
    // The other live helper caller must likewise keep the source baseline.
    await expect(assertOriginalRestoreTarget(target.userId, target.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(() => assertSource()).not.toThrow();
    // Prove the guard still notices the exact disk-vs-memory distinction when
    // the operator explicitly requests a reload. No normalization/waiver.
    await store.loadUser(source.userId);
    expect(() => assertSource()).toThrow('fields=archivedAt,initScript');
    await store.clearIncusMigration(source.userId, source.id, marker);
  } finally {
    (globalThis as any).useLogger = originalLogger;
    await store.removeForUser(source.userId); await store.removeForUser(target.userId);
  }
});
