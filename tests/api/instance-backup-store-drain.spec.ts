import { expect, test } from '@playwright/test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupStore } from '../../orchestrator/server/utils/backup-store';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

(globalThis as any).useLogger = () => ({ error() {}, warn() {}, info() {}, debug() {} });
const stamp = '2026-01-01T00:00:00.000Z';
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const directory = () => mkdtemp(join(tmpdir(), 'agentor-backup-store-drain-'));
const target = (dir: string, owner = 'owner') => join(dir, 'users', owner, 'backups.json');
function job(id: string, userId = 'owner') {
  return { schemaVersion: 1 as const, id, userId, workspaceId: 'worker', provider: 'local' as const,
    status: 'failed' as const, phase: 'failed' as const, progress: 0, bytesProcessed: 0,
    createdAt: stamp, updatedAt: stamp, attempt: 1 };
}
function remote() {
  return { schemaVersion: 1 as const, id: 'remote', userId: 'owner', provider: 'fake' as const,
    providerObjectId: 'remote-object', discoveredAt: stamp, lastSeenAt: stamp,
    remote: { objectId: 'remote-object', size: 1 } };
}
async function seed(dir: string, value: unknown, owner = 'owner') {
  await mkdir(join(dir, 'users', owner), { recursive: true });
  await writeFile(target(dir, owner), JSON.stringify(value));
}
test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false);
  await expect.poll(() => gate.activeOperations).toBe(0);
});

test('closed admission refuses initialization and all writers before queues, revisions or drafts change', async () => {
  const dir = await directory(), store = new BackupStore(dir);
  const snapshot = store.get('owner');
  let mutated = false;
  const barrier = gate.begin('backup-store-closed', 'snapshot');
  try {
    for (const operation of [() => store.init(), () => store.save('owner', snapshot),
      () => store.update('owner', () => { mutated = true; }), () => store.forget('owner'),
      () => store.upsertRemoteBackup('owner', remote())])
      await expect(operation()).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    expect(mutated).toBe(false);
    expect((store as any).initialized).toBeUndefined();
    expect((store as any).queues.size).toBe(0);
    expect((store as any).revisions.size).toBe(0);
    expect((store as any).closedUsers.size).toBe(0);
    expect(store.all()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    expect(() => store.assertInitializedForInstanceSnapshot()).toThrow('not initialized');
    barrier.assertDrained();
  } finally { barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('initialized-only lookup is nonwriting under the cut while ordinary init remains rejected', async () => {
  const dir = await directory(), store = new BackupStore(dir);
  await seed(dir, { schemaVersion: 1, jobs: [job('old-job')], artifacts: [] });
  const bytes = await readFile(target(dir)), stat = await lstat(target(dir));
  try {
    await store.init();
    const barrier = gate.begin('backup-store-read-only', 'restore');
    try {
      store.assertInitializedForInstanceSnapshot();
      expect(store.get('owner').jobs[0]).toMatchObject({ id: 'old-job', includeManagedVolumes: false });
      expect(store.findJob('old-job')?.id).toBe('old-job');
      expect(store.userIds()).toEqual(['owner']);
      await expect(store.init()).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
      expect(await readFile(target(dir))).toEqual(bytes);
      const after = await lstat(target(dir));
      expect([after.ino, after.mode, after.mtimeMs, after.ctimeMs]).toEqual([stat.ino, stat.mode, stat.mtimeMs, stat.ctimeMs]);
      barrier.assertDrained();
    } finally { barrier.release(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pending initialization remains unready and prevents drain until its private load finishes', async () => {
  const dir = await directory(), store = new BackupStore(dir), entered = deferred(), release = deferred();
  const load = (store as any).load.bind(store);
  (store as any).load = async () => { entered.resolve(); await release.promise; await load(); };
  const loading = store.init(); await entered.promise;
  const barrier = gate.begin('backup-store-initializing', 'snapshot');
  try {
    expect(() => store.assertInitializedForInstanceSnapshot()).toThrow('not initialized');
    expect(() => barrier.assertDrained()).toThrow();
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    release.resolve(); await loading; await barrier.drain({ timeoutMs: 1000 });
    store.assertInitializedForInstanceSnapshot();
  } finally { release.resolve(); await loading; barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('failed initial load never becomes ready and preserves exposed rejected settlement accounting', async () => {
  const dir = await directory(), store = new BackupStore(dir), late = deferred();
  const failure = Object.assign(new Error('load failed'), { [operationSettlement]: late.promise });
  let loads = 0;
  (store as any).load = async () => { loads++; throw failure; };
  try {
    await expect(store.init()).rejects.toBe(failure);
    const barrier = gate.begin('backup-store-init-failed', 'restore');
    try {
      expect(() => store.assertInitializedForInstanceSnapshot()).toThrow('not initialized');
      expect(() => barrier.assertDrained()).toThrow();
      late.reject(new Error('late load failure')); await barrier.drain({ timeoutMs: 1000 });
      expect(() => store.assertInitializedForInstanceSnapshot()).toThrow('not initialized');
    } finally { late.resolve(); barrier.release(); }
    await expect(store.init()).rejects.toBe(failure);
    expect(loads).toBe(1);
  } finally { late.resolve(); await rm(dir, { recursive: true, force: true }); }
});

test('accepted owner writes retain private drafts and drain in order without blocking a sibling owner', async () => {
  const dir = await directory(), store = new BackupStore(dir), entered = deferred(), release = deferred();
  await store.update('owner', draft => { draft.jobs.push(job('initial')); });
  const persist = (store as any).persistSnapshot.bind(store); let writes = 0;
  (store as any).persistSnapshot = async (owner: string, revision: number, value: unknown) => {
    if (owner === 'owner' && ++writes === 1) { entered.resolve(); await release.promise; }
    await persist(owner, revision, value);
  };
  const first = store.update('owner', draft => { draft.jobs.push(job('first')); }); await entered.promise;
  const second = store.update('owner', draft => { draft.jobs.push(job('second')); });
  await store.update('sibling', draft => { draft.jobs.push(job('sibling-job', 'sibling')); });
  const barrier = gate.begin('backup-store-queued', 'snapshot');
  try {
    expect(store.get('owner').jobs.map(value => value.id)).toEqual(['initial']);
    expect(store.get('sibling').jobs[0]?.id).toBe('sibling-job');
    expect(writes).toBe(1); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await Promise.all([first, second]); await barrier.drain({ timeoutMs: 1000 });
    expect(store.get('owner').jobs.map(value => value.id)).toEqual(['initial', 'first', 'second']);
    expect(JSON.parse(await readFile(target(dir), 'utf8')).jobs.map((value: any) => value.id)).toEqual(['initial', 'first', 'second']);
    expect((store as any).queues.size).toBe(0);
  } finally { release.resolve(); await Promise.all([first, second]); barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`failed writer retains ${outcome === 'resolve' ? 'resolving' : 'rejecting'} settlement before forget and cannot resurrect a closed owner`, async () => {
    const dir = await directory(), store = new BackupStore(dir), late = deferred();
    await store.update('owner', draft => { draft.jobs.push(job('initial')); });
    const persist = (store as any).persistSnapshot.bind(store);
    const failure = Object.assign(new Error('bounded write failure'), { [operationSettlement]: late.promise });
    let writes = 0;
    (store as any).persistSnapshot = async (...args: unknown[]) => { if (++writes === 1) throw failure; await persist(...args); };
    try {
      await expect(store.update('owner', draft => { draft.jobs.push(job('failed')); })).rejects.toBe(failure);
      let forgotten = false, mutated = false;
      const forgetting = store.forget('owner').then(() => { forgotten = true; });
      const following = store.update('owner', () => { mutated = true; }).catch(error => error);
      await turn(); expect(forgotten).toBe(false);
      expect(store.get('owner').jobs.map(value => value.id)).toEqual(['initial']);
      const barrier = gate.begin(`backup-store-late-${outcome}`, 'snapshot');
      try {
        await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
        if (outcome === 'resolve') late.resolve(); else late.reject(new Error('late write rejected'));
        await forgetting; expect(await following).toMatchObject({ statusCode: 410 });
        await barrier.drain({ timeoutMs: 1000 });
        expect(mutated).toBe(false); expect(writes).toBe(1);
        expect(store.get('owner').jobs).toEqual([]);
        expect((store as any).queues.size).toBe(0);
        expect((store as any).revisions.has('owner')).toBe(false);
        await expect(lstat(target(dir))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { late.resolve(); await Promise.all([forgetting, following]); barrier.release(); }
    } finally { late.resolve(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('mutations and forget wait for initial load instead of overwriting or reviving loaded state', async () => {
  const dir = await directory(), store = new BackupStore(dir), entered = deferred(), release = deferred();
  await seed(dir, { schemaVersion: 1, jobs: [job('historical')], artifacts: [] });
  await seed(dir, { schemaVersion: 1, jobs: [job('forgotten', 'deleted')], artifacts: [] }, 'deleted');
  const load = (store as any).load.bind(store);
  (store as any).load = async () => { entered.resolve(); await release.promise; await load(); };
  const loading = store.init(); await entered.promise;
  const updating = store.update('owner', draft => { draft.jobs.push(job('new')); });
  const forgetting = store.forget('deleted');
  const barrier = gate.begin('backup-store-init-order', 'snapshot');
  try {
    release.resolve(); await Promise.all([loading, updating, forgetting]); await barrier.drain({ timeoutMs: 1000 });
    expect(store.get('owner').jobs.map(value => value.id)).toEqual(['historical', 'new']);
    expect(store.get('deleted').jobs).toEqual([]);
    expect(store.userIds()).toEqual(['owner']);
    await expect(lstat(target(dir, 'deleted'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release.resolve(); await Promise.all([loading, updating, forgetting]); barrier.release(); await rm(dir, { recursive: true, force: true }); }
});

test('failed forget preserves owner memory and allows exact retry without poisoning its queue', async () => {
  const dir = await directory(), store = new BackupStore(dir);
  try {
    await store.update('owner', draft => { draft.jobs.push(job('retained')); });
    await rm(target(dir)); await mkdir(target(dir));
    await expect(store.forget('owner')).rejects.toThrow();
    expect(store.get('owner').jobs[0]?.id).toBe('retained');
    expect((store as any).closedUsers.has('owner')).toBe(false);
    await rm(target(dir), { recursive: true });
    await store.forget('owner');
    expect((store as any).closedUsers.has('owner')).toBe(true);
    await expect(store.save('owner', store.get('owner'))).rejects.toMatchObject({ statusCode: 410 });
    expect((store as any).queues.size).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt-owner quarantine survives admission while independent owners and explicit forgetting still work', async () => {
  const dir = await directory(), store = new BackupStore(dir);
  await mkdir(join(dir, 'users', 'broken'), { recursive: true }); await writeFile(target(dir, 'broken'), '{');
  try {
    await store.init(); store.assertInitializedForInstanceSnapshot();
    expect(() => store.get('broken')).toThrow('unavailable');
    await expect(store.update('broken', () => {})).rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(target(dir, 'broken'), 'utf8')).toBe('{');
    await store.update('owner', draft => { draft.jobs.push(job('healthy')); });
    expect(store.userIds().sort()).toEqual(['broken', 'owner']);
    await store.forget('broken');
    expect(store.get('broken').jobs).toEqual([]);
    await expect(store.update('broken', () => {})).rejects.toMatchObject({ statusCode: 410 });
    expect(store.get('owner').jobs[0]?.id).toBe('healthy');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restart preserves historical backup compatibility, deletion tombstones and adopted discovery identity', async () => {
  const dir = await directory(), store = new BackupStore(dir);
  const artifact = { schemaVersion: 1, id: 'artifact', userId: 'owner', workspaceId: 'worker', provider: 'local',
    providerObjectId: 'object', createdAt: stamp, size: 1, sha256: '0'.repeat(64), missingSecrets: [], deletionPending: true };
  await seed(dir, { schemaVersion: 1, jobs: [job('legacy')], artifacts: [artifact],
    remoteBackups: [{ ...remote(), adoptedArtifactId: 'artifact' }] });
  try {
    await store.init();
    const refreshed = await store.upsertRemoteBackup('owner', { ...remote(), id: 'new-id', lastSeenAt: '2026-01-02T00:00:00.000Z' });
    expect(refreshed).toMatchObject({ id: 'remote', adoptedArtifactId: 'artifact', discoveredAt: stamp });
    await store.update('owner', draft => { draft.jobs.push(job('later')); });
    const reopened = new BackupStore(dir); await reopened.init();
    expect(reopened.get('owner').jobs.map(value => value.id)).toEqual(['legacy', 'later']);
    expect(reopened.findArtifact('artifact')).toMatchObject({ deletionPending: true, includeManagedVolumes: false });
    expect(reopened.get('owner').remoteBackups).toEqual([refreshed]);
    const clone = reopened.get('owner'); clone.jobs.length = 0;
    expect(reopened.get('owner').jobs).toHaveLength(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
