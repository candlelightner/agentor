import { expect, test } from '@playwright/test';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { WorkerStore, workerRuntimeProjection, sameWorkerRuntimeProjection, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { isWorkerRecordPersistenceError, type WorkerStoreIO } from '../../orchestrator/server/utils/worker-durable-store';

const ERROR = 'WORKER_RECORD_STORE_UNAVAILABLE';
function worker(id = 'worker-1', userId = 'owner-1'): WorkerRecord {
  return { id, userId, status: 'active', displayName: id, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
    runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin', pendingRebuild: false };
}
function target(id = 'worker-1') {
  const reference = `agentor-import-${id}:runtime-operation-1`;
  return { runtimeProfile: 'kata-qemu' as const, importedImage: reference,
    runtimeSnapshotIdentity: { reference, imageId: `sha256:${'a'.repeat(64)}` } };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'worker-durability-'));
  const events: string[] = [], temporary: string[] = [];
  let failStage = '', pauseStage = '', release!: () => void, entered!: () => void;
  let paused = new Promise<void>(resolve => { entered = resolve; });
  async function step(stage: string) {
    events.push(stage);
    if (stage === pauseStage) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    if (stage === failStage) throw Object.assign(new Error('Injected filesystem uncertainty'), { code: 'EIO' });
  }
  const io: WorkerStoreIO = {
    mkdir: async (path, options) => { await step(basename(path) === 'users' ? 'mkdir-users' : 'mkdir-owner'); return mkdir(path, options); },
    unlink,
    rename: async (source, destination) => { await step('rename'); await rename(source, destination); },
    open: async (path, flags, mode) => {
      const directory = Boolean(flags & constants.O_DIRECTORY);
      const label = !directory ? 'file' : path === dir ? 'root' : basename(path) === 'users' ? 'users' : 'owner';
      await step('open-' + label);
      if (!directory) temporary.push(path);
      const handle = await open(path, flags, mode);
      return {
        writeFile: async (data, options) => { await step('write'); await handle.writeFile(data, options); },
        sync: async () => { await step('sync-' + label); await handle.sync(); },
        close: async () => { await handle.close(); await step('close-' + label); },
      };
    },
  };
  const store = new WorkerStore(dir, io); await store.init();
  return { dir, store, events, temporary, file: (user = 'owner-1') => join(dir, 'users', user, 'workers.json'),
    fail: (stage: string) => { failStage = stage; },
    pause: (stage: string) => { pauseStage = stage; paused = new Promise(resolve => { entered = resolve; }); return paused; },
    resume: () => { pauseStage = ''; release(); },
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function transition(store: WorkerStore, original = worker()) {
  return store.transitionRuntimeMigration({ userId: original.userId, workerId: original.id,
    expected: workerRuntimeProjection(original), target: target(original.id) });
}

test('settings queued behind a durable pending rebuild merge only supplied fields', async () => {
  const f = await fixture();
  try {
    const original = { ...worker(), repos: [{ provider: 'github' as const, url: 'example/keep' }] };
    await f.store.upsert(original);
    const paused = f.pause('sync-owner');
    const marking = f.store.markPendingRebuild(original.userId, original.id);
    await paused;
    const settings = f.store.updateSettings(original.userId, original.id, { displayName: 'New label' }, workerRuntimeProjection(original));
    f.resume(); await marking;
    expect(await settings).toMatchObject({ displayName: 'New label', pendingRebuild: true, repos: original.repos });
    const reopened = new WorkerStore(f.dir); await reopened.init();
    expect(reopened.get(original.userId, original.id)).toMatchObject({ displayName: 'New label', pendingRebuild: true, repos: original.repos });
    await expect(f.store.updateSettings(original.userId, original.id, { pendingRebuild: false } as any, original)).rejects.toMatchObject({ code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
  } finally { await f.cleanup(); }
});

test('recreation completion preserves a newer repeated dirty signal and queue-current metadata', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); await f.store.markPendingRebuild('owner-1', 'worker-1');
    const applied = f.store.get('owner-1', 'worker-1')!;
    const paused = f.pause('sync-owner');
    const dirty = f.store.markPendingRebuild('owner-1', 'worker-1'); await paused;
    const finish = f.store.completeRecreation('owner-1', 'worker-1', workerRuntimeProjection(applied), applied.configurationRevision!);
    f.resume(); await dirty;
    expect(await finish).toMatchObject({ pendingRebuild: true, configurationRevision: 2 });
    await expect(f.store.upsert({ ...applied, displayName: 'stale', pendingRebuild: false }))
      .rejects.toMatchObject({ code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
    const current = f.store.get('owner-1', 'worker-1')!;
    expect(await f.store.completeRecreation('owner-1', 'worker-1', current, current.configurationRevision!))
      .toMatchObject({ pendingRebuild: false, configurationRevision: 2 });
    const reopened = new WorkerStore(f.dir); await reopened.init();
    expect(reopened.get('owner-1', 'worker-1')).toMatchObject({ pendingRebuild: false, configurationRevision: 2 });
  } finally { await f.cleanup(); }
});

test('configuration revision rejects invalid persisted values and dirty-signal overflow', async () => {
  const f = await fixture();
  try {
    for (const configurationRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(f.store.upsert({ ...worker(), configurationRevision })).rejects.toThrow(/Invalid worker record/);
    await f.store.upsert({ ...worker(), configurationRevision: Number.MAX_SAFE_INTEGER });
    await expect(f.store.markPendingRebuild('owner-1', 'worker-1')).rejects.toMatchObject({ code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
    expect(f.store.get('owner-1', 'worker-1')!.configurationRevision).toBe(Number.MAX_SAFE_INTEGER);
  } finally { await f.cleanup(); }
});

test('first worker write fsyncs ancestry, file, rename and directory before acknowledging mode0600 array', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker());
    expect(f.events).toEqual(['open-root', 'mkdir-users', 'open-users', 'sync-root', 'mkdir-owner', 'open-owner', 'sync-users',
      'open-file', 'write', 'sync-file', 'close-file', 'rename', 'sync-owner', 'close-owner', 'close-users', 'close-root']);
    expect((await stat(f.file())).mode & 0o777).toBe(0o600);
    expect(await readdir(join(f.dir, 'users', 'owner-1'))).toEqual(['workers.json']);
    expect(JSON.parse(await readFile(f.file(), 'utf8'))).toEqual([worker()]);
    const reopened = new WorkerStore(f.dir); await reopened.init();
    expect(reopened.get('owner-1', 'worker-1')).toEqual(worker());
  } finally { await f.cleanup(); }
});

test('worker candidate is invisible until final directory close and input/output values are detached', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker());
    const paused = f.pause('close-root'), next = { ...worker(), displayName: 'after' };
    const saving = f.store.upsert(next); await paused;
    next.displayName = 'external mutation';
    expect(f.store.get('owner-1', 'worker-1')!.displayName).toBe('worker-1');
    expect(f.store.listActive()[0]!.displayName).toBe('worker-1');
    f.resume(); await saving;
    const read = f.store.get('owner-1', 'worker-1')!; read.displayName = 'external read';
    expect(f.store.findById('worker-1')!.displayName).toBe('after');
  } finally { await f.cleanup(); }
});

for (const stage of ['open-root', 'mkdir-users', 'open-users', 'sync-root', 'mkdir-owner', 'open-owner', 'sync-users',
  'open-file', 'write', 'sync-file', 'close-file', 'rename', 'sync-owner', 'close-owner', 'close-users', 'close-root']) {
  test(`${stage} uncertainty quarantines owner across reload, init, retry and explicit owner removal`, async () => {
    const f = await fixture();
    try {
      await f.store.upsert(worker()); await f.store.upsert(worker('sibling'));
      f.fail(stage);
      await expect(f.store.setDesiredRuntimeStatus('owner-1', 'worker-1', 'stopped')).rejects.toMatchObject({ code: ERROR });
      f.fail(''); const events = [...f.events];
      expect(() => f.store.get('owner-1', 'worker-1')).toThrow(/unavailable/);
      expect(f.store.list()).toEqual([]); expect(f.store.listUserIds()).toContain('owner-1');
      await expect(f.store.loadUser('owner-1')).rejects.toMatchObject({ code: ERROR });
      await f.store.init();
      await expect(f.store.upsert(worker())).rejects.toMatchObject({ code: ERROR });
      await expect(f.store.delete('owner-1', 'worker-1')).rejects.toMatchObject({ code: ERROR });
      await expect(f.store.removeForUser('owner-1')).rejects.toMatchObject({ code: ERROR });
      expect(f.events).toEqual(events);
      expect(f.store.hasUnavailableOwners()).toBe(true);
      const disk = JSON.parse(await readFile(f.file(), 'utf8'));
      expect(disk).toHaveLength(2);
      expect(disk.find((value: WorkerRecord) => value.id === 'sibling')).toEqual(worker('sibling'));
      expect(isWorkerRecordPersistenceError({ code: ERROR })).toBe(true);
      expect(isWorkerRecordPersistenceError({ code: 'EIO' })).toBe(false);
    } finally { await f.cleanup(); }
  });
}

test('queued same-owner writes stop after uncertainty while another owner remains writable', async () => {
  const f = await fixture();
  try {
    const paused = f.pause('sync-file'); f.fail('sync-file');
    const first = f.store.upsert(worker()); await paused;
    const second = f.store.upsert(worker('sibling'));
    const results = Promise.allSettled([first, second]); f.resume();
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(f.temporary).toHaveLength(1);
    f.fail(''); await f.store.upsert(worker('other-worker', 'other-owner'));
    expect(f.store.list().map(record => record.userId)).toEqual(['other-owner']);
  } finally { await f.cleanup(); }
});

test('concurrent successful writes retain siblings with unique temp files and serialize reload', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.store.upsert(worker()), f.store.upsert(worker('sibling'))]);
    const paused = f.pause('sync-owner');
    const saving = f.store.setDesiredRuntimeStatus('owner-1', 'worker-1', 'stopped'); await paused;
    let loaded = false; const loading = f.store.loadUser('owner-1').then(() => { loaded = true; });
    await Promise.resolve(); expect(loaded).toBe(false);
    f.resume(); await Promise.all([saving, loading]);
    expect(f.store.listForUser('owner-1')).toHaveLength(2);
    expect(f.store.get('owner-1', 'worker-1')!.desiredRuntimeStatus).toBe('stopped');
    expect(new Set(f.temporary).size).toBe(f.temporary.length);
  } finally { await f.cleanup(); }
});

test('last-worker and explicit owner deletion use durable empty tombstones with backward-compatible arrays', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); await f.store.delete('owner-1', 'worker-1');
    expect(JSON.parse(await readFile(f.file(), 'utf8'))).toEqual([]);
    expect(f.store.listUserIds()).toEqual([]);
    await f.store.upsert(worker()); await f.store.upsert(worker('sibling'));
    expect(await f.store.removeForUser('owner-1')).toBe(2);
    expect(JSON.parse(await readFile(f.file(), 'utf8'))).toEqual([]);
    const reopened = new WorkerStore(f.dir); await reopened.init();
    expect(reopened.list()).toEqual([]); expect(reopened.listUserIds()).toEqual([]);
  } finally { await f.cleanup(); }
});

test('uncertain tombstone is unavailable in-process; reopening observed empty JSON is not a Docker reconciliation proof', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); f.fail('sync-owner');
    await expect(f.store.delete('owner-1', 'worker-1')).rejects.toMatchObject({ code: ERROR });
    expect(JSON.parse(await readFile(f.file(), 'utf8'))).toEqual([]);
    expect(() => f.store.get('owner-1', 'worker-1')).toThrow(/unavailable/);
    const reopened = new WorkerStore(f.dir); await reopened.init();
    expect(reopened.hasUnavailableOwners()).toBe(false);
    expect(reopened.get('owner-1', 'worker-1')).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('corrupt-load quarantine preserves bytes until explicit owner cleanup durably writes its tombstone', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, 'users', 'owner-1'), { recursive: true });
    await writeFile(f.file(), '[broken'); await f.store.init();
    await expect(f.store.upsert(worker())).rejects.toMatchObject({ code: ERROR });
    expect(await readFile(f.file(), 'utf8')).toBe('[broken');
    expect(await f.store.removeForUser('owner-1')).toBe(0);
    expect(await readFile(f.file(), 'utf8')).toBe('[]\n');
    expect(f.store.hasUnavailableOwners()).toBe(false);
    expect(f.store.listUserIds()).toEqual([]);
  } finally { await f.cleanup(); }
});

test('a failed corrupt-owner tombstone becomes sticky write uncertainty rather than another deletion retry', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, 'users', 'owner-1'), { recursive: true }); await writeFile(f.file(), '[broken');
    await f.store.init(); f.fail('sync-owner');
    await expect(f.store.removeForUser('owner-1')).rejects.toMatchObject({ code: ERROR });
    f.fail(''); await expect(f.store.removeForUser('owner-1')).rejects.toMatchObject({ code: ERROR });
  } finally { await f.cleanup(); }
});

test('migration transition preserves latest non-runtime metadata and every sibling', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); await f.store.upsert(worker('sibling'));
    const before = worker();
    await f.store.markPendingRebuild('owner-1', 'worker-1');
    await f.store.setDesiredRuntimeStatus('owner-1', 'worker-1', 'stopped');
    await f.store.upsert({ ...f.store.get('owner-1', 'worker-1')!, displayName: 'new label', environmentId: 'new-env' });
    const migrated = await transition(f.store, before);
    expect(migrated).toMatchObject({ ...target(), pendingRebuild: true, desiredRuntimeStatus: 'stopped', displayName: 'new label', environmentId: 'new-env' });
    expect(migrated.legacyPrivilegeGrant).toBeUndefined();
    expect(f.store.get('owner-1', 'sibling')).toEqual(worker('sibling'));
    const restored = await f.store.transitionRuntimeMigration({ userId: 'owner-1', workerId: 'worker-1', expected: target(), target: workerRuntimeProjection(before) });
    expect(restored).toMatchObject({ runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin', pendingRebuild: true, environmentId: 'new-env' });
    expect(restored.importedImage).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('partial updates queued behind runtime transition read the committed runtime tuple in their transaction', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); const paused = f.pause('sync-owner');
    const migrating = transition(f.store); await paused;
    const updates = [f.store.setDesiredRuntimeStatus('owner-1', 'worker-1', 'stopped'),
      f.store.markPendingRebuild('owner-1', 'worker-1'),
      f.store.updateHostMountAccess('owner-1', 'worker-1', [], true),
      f.store.updateHardwareDeviceAccess('owner-1', 'worker-1', ['device-1'], true)];
    f.resume(); await Promise.all([migrating, ...updates]);
    expect(f.store.get('owner-1', 'worker-1')).toMatchObject({ ...target(), desiredRuntimeStatus: 'stopped',
      pendingRebuild: true, hostMountsRevoked: true, hardwareDevicesRevoked: true, hardwareDeviceIds: ['device-1'] });
  } finally { await f.cleanup(); }
});

test('stale full upsert queued behind runtime transition cannot revert tuple or restore hold', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); const paused = f.pause('sync-owner');
    const migrating = transition(f.store); await paused;
    const stale = f.store.upsert({ ...worker(), displayName: 'stale' });
    const rejected = expect(stale).rejects.toMatchObject({ code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
    f.resume(); await migrating; await rejected;
    expect(f.store.get('owner-1', 'worker-1')).toMatchObject(target());
    expect(f.store.hasUnavailableOwners()).toBe(false);
    await f.store.upsert({ ...worker('held'), runtimeRestoreApprovalRequired: true });
    await expect(f.store.upsert(worker('held'))).rejects.toMatchObject({ code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
  } finally { await f.cleanup(); }
});

test('explicit guarded admin writes permit exact trusted transitions but reject stale guards and missing records', async () => {
  const f = await fixture();
  try {
    const legacy = worker(); delete legacy.runtimeProfile; delete legacy.legacyPrivilegeGrant;
    legacy.runtimeRestoreApprovalRequired = true; await f.store.upsert(legacy);
    await f.store.upsert(worker(), { expectedRuntime: workerRuntimeProjection(legacy), expectedRestoreApprovalRequired: true });
    expect(f.store.get('owner-1', 'worker-1')).toEqual(worker());
    await expect(f.store.upsert(worker(), { expectedRuntime: workerRuntimeProjection(legacy), expectedRestoreApprovalRequired: true })).rejects.toMatchObject({ code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
    await f.store.delete('owner-1', 'worker-1');
    await expect(f.store.upsert(worker(), { expectedRuntime: workerRuntimeProjection(worker()) })).rejects.toMatchObject({ code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
    expect(f.store.get('owner-1', 'worker-1')).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('guarded runtime admin/backfill writes preserve metadata changed while the caller held a snapshot', async () => {
  const f = await fixture();
  try {
    const original = worker(); original.runtimeRestoreApprovalRequired = true;
    await f.store.upsert(original);
    await f.store.markPendingRebuild('owner-1', 'worker-1');
    await f.store.upsert({ ...f.store.get('owner-1', 'worker-1')!, displayName: 'current label', environmentId: 'current-env' });
    const next = { ...original, runtimeRestoreApprovalRequired: undefined };
    await f.store.upsert(next, { expectedRuntime: workerRuntimeProjection(original), expectedRestoreApprovalRequired: true });
    expect(f.store.get('owner-1', 'worker-1')).toMatchObject({ pendingRebuild: true, displayName: 'current label', environmentId: 'current-env' });
    expect(f.store.get('owner-1', 'worker-1')!.runtimeRestoreApprovalRequired).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('legacy enrollment is explicit, queue-local and cannot clear restore/deletion holds', async () => {
  const f = await fixture();
  try {
    const original = worker(); delete original.runtimeProfile; delete original.legacyPrivilegeGrant;
    await f.store.upsert(original); await f.store.markPendingRebuild('owner-1', 'worker-1');
    await expect(f.store.upsert(worker())).rejects.toMatchObject({ code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
    expect(await f.store.capturePreexistingRuntime('owner-1', 'worker-1', true)).toMatchObject({
      runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'preexisting', pendingRebuild: true });
    const held = { ...original, id: 'held', runtimeRestoreApprovalRequired: true };
    await f.store.upsert(held);
    expect(await f.store.capturePreexistingRuntime('owner-1', 'held', true)).toEqual(held);
    expect(await f.store.capturePreexistingRuntime('owner-1', 'missing', true)).toBeUndefined();
    await f.store.upsert({ ...original, id: 'deleting', deletionPending: true });
    expect((await f.store.capturePreexistingRuntime('owner-1', 'deleting', true))!.runtimeProfile).toBeUndefined();
  } finally { await f.cleanup(); }
});

for (const state of ['missing', 'archived', 'deletion', 'restore-hold', 'runtime-conflict']) test(`migration CAS rejects ${state} without mutation or resurrection`, async () => {
  const f = await fixture();
  try {
    if (state !== 'missing') {
      const value = worker();
      if (state === 'archived') value.status = 'archived';
      if (state === 'deletion') value.deletionPending = true;
      if (state === 'restore-hold') value.runtimeRestoreApprovalRequired = true;
      if (state === 'runtime-conflict') value.importedImage = 'unrelated:local';
      await f.store.upsert(value);
    }
    const before = f.store.list(), events = [...f.events];
    await expect(transition(f.store)).rejects.toBeTruthy();
    expect(f.store.list()).toEqual(before); expect(f.events).toEqual(events);
    expect(f.store.hasUnavailableOwners()).toBe(false);
  } finally { await f.cleanup(); }
});

test('idempotent migration CAS still establishes a durability barrier and ordered snapshot equality', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); await transition(f.store); f.events.length = 0;
    await transition(f.store);
    expect(f.events).toContain('sync-owner'); expect(f.events).toContain('sync-file');
    expect(sameWorkerRuntimeProjection({}, { runtimeProfile: 'legacy-runc' })).toBe(false);
    expect(sameWorkerRuntimeProjection(target(), { runtimeSnapshotIdentity: { imageId: target().runtimeSnapshotIdentity.imageId,
      reference: target().importedImage }, importedImage: target().importedImage, runtimeProfile: 'kata-qemu' })).toBe(true);
    const reopened = new WorkerStore(f.dir); await reopened.init();
    expect(sameWorkerRuntimeProjection(reopened.get('owner-1', 'worker-1')!, target())).toBe(true);
  } finally { await f.cleanup(); }
});

test('invalid snapshot identity is rejected before persistence without quarantining a healthy owner', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); const before = [...f.events];
    const invalid = target(); invalid.runtimeSnapshotIdentity.imageId = 'sha256:invalid';
    await expect(f.store.transitionRuntimeMigration({ userId: 'owner-1', workerId: 'worker-1', expected: worker(), target: invalid })).rejects.toThrow('snapshot identity');
    expect(f.events).toEqual(before); expect(f.store.hasUnavailableOwners()).toBe(false);
  } finally { await f.cleanup(); }
});

test('partial lifecycle writes preserve migrated tuple and deletionPending cannot be silently cleared', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(worker()); await transition(f.store);
    await f.store.archive('owner-1', 'worker-1'); await f.store.unarchive('owner-1', 'worker-1');
    expect(f.store.get('owner-1', 'worker-1')).toMatchObject(target());
    await f.store.markDeletionPending('owner-1', 'worker-1'); await f.store.archive('owner-1', 'worker-1');
    await expect(f.store.unarchive('owner-1', 'worker-1')).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.store.upsert({ ...f.store.get('owner-1', 'worker-1')!, deletionPending: false })).rejects.toMatchObject({ statusCode: 409 });
    const paused = f.pause('sync-owner'), deleting = f.store.delete('owner-1', 'worker-1'); await paused;
    const marking = f.store.markPendingRebuild('owner-1', 'worker-1'); f.resume(); await deleting;
    expect(await marking).toBeUndefined(); expect(f.store.list()).toEqual([]);
  } finally { await f.cleanup(); }
});

for (const boundary of ['file', 'owner', 'users']) test(`load refuses ${boundary} symlink without adopting outside worker bytes`, async () => {
  const f = await fixture();
  try {
    const outside = join(f.dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'workers.json'), JSON.stringify([worker()]));
    if (boundary === 'users') await symlink(outside, join(f.dir, 'users'));
    else {
      await mkdir(join(f.dir, 'users'));
      if (boundary === 'owner') await symlink(outside, join(f.dir, 'users', 'owner-1'));
      else { await mkdir(join(f.dir, 'users', 'owner-1')); await symlink(join(outside, 'workers.json'), f.file()); }
    }
    await expect(f.store.loadUser('owner-1')).rejects.toMatchObject({ code: ERROR });
    expect(f.store.list()).toEqual([]);
    expect(JSON.parse(await readFile(join(outside, 'workers.json'), 'utf8'))).toEqual([worker()]);
  } finally { await f.cleanup(); }
});
