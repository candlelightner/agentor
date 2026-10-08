import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerStore, type WorkerRecord, type WorkerIncusMigration } from '../../orchestrator/server/utils/worker-store';

const stamp = '2026-10-08T12:00:00.000000000Z';
class FixtureStore extends WorkerStore {
  fail = false;
  protected override async persistUser(userId: string): Promise<void> {
    if (this.fail) throw new Error('Controlled migration persistence failure');
    return super.persistUser(userId);
  }
}
async function fixture(run: (f: { store: FixtureStore; record: WorkerRecord; marker: WorkerIncusMigration; path: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'worker-incus-migration-store-'));
  const store = new FixtureStore(root); await store.init();
  const record: WorkerRecord = { id: randomUUID(), userId: 'migration-owner', status: 'active', displayName: 'Migration source',
    createdAt: stamp, updatedAt: stamp, desiredRuntimeStatus: 'running', environmentId: 'existing-environment',
    initScript: 'keep configuration', pendingRebuild: true, excludedGlobalEnvVarKeys: ['EXISTING'],
    imageDefinitionId: randomUUID(), imageVersion: 'v1', imageDigest: 'sha256:' + 'b'.repeat(64),
    mounts: [{ source: '/srv/approved', target: '/srv/shared', readOnly: true }] };
  await store.upsert(record);
  const marker: WorkerIncusMigration = { nonce: randomUUID(), phase: 'preparing',
    source: { containerId: 'a'.repeat(64), createdAt: stamp, imageId: 'sha256:' + 'b'.repeat(64), wasRunning: true } };
  try { await run({ store, record, marker, path: join(root, 'users', record.userId, 'workers.json') }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('old absent runtime and migration metadata remains legacy; absent proof arrays normalize empty', async () => {
  await fixture(async ({ store, record, marker, path }) => {
    await writeFile(path, JSON.stringify([record])); await store.loadUser(record.userId);
    expect(store.get(record.userId, record.id)).toMatchObject({ runtimeKind: 'legacy-docker' });
    expect(store.get(record.userId, record.id)?.incusMigration).toBeUndefined();
    const opened = await store.transitionIncusMigration(record.userId, record.id, undefined, marker);
    expect(opened.incusMigration).toEqual({ ...marker, sourceVolumes: [], sourceDirectories: [] });
    marker.source.containerId = 'c'.repeat(64);
    expect(store.get(record.userId, record.id)?.incusMigration?.source.containerId).toBe('a'.repeat(64));
  });
});

test('malformed, excessive or rootfs-like migration metadata fails on upsert and durable load without rewriting it', async () => {
  await fixture(async ({ store, record, marker, path }) => {
    const attacks: unknown[] = [null, { ...marker, nonce: 'not-a-uuid' }, { ...marker, phase: 'unknown' },
      { ...marker, currentIp: '10.0.0.2' }, { ...marker, source: { ...marker.source, containerId: ['a'.repeat(64)] } },
      { ...marker, source: { ...marker.source, createdAt: 'unknown', wasRunning: 'true' } },
      { ...marker, phase: 'validated' }, { ...marker, destinationIncarnation: 'foreign' },
      { ...marker, sourceVolumes: null }, { ...marker, sourceDirectories: {} },
      { ...marker, sourceVolumes: Array.from({ length: 36 }, (_, i) => ({ name: 'owned-' + i, createdAt: stamp })) },
      { ...marker, sourceVolumes: [{ name: 'same', createdAt: stamp }, { name: 'same', createdAt: stamp }] },
      ...['/', '/srv/../root', '//srv/data'].map(path => ({ ...marker, sourceDirectories: [{ path, dev: 1, ino: 2 }] })),
      { ...marker, sourceDirectories: [{ path: '/srv/source', dev: 0.5, ino: Number.MAX_SAFE_INTEGER + 1 }] }];
    for (const attack of attacks)
      await expect(store.upsert({ ...record, incusMigration: attack as WorkerIncusMigration })).rejects.toThrow(/migration marker/);
    expect(store.get(record.userId, record.id)?.incusMigration).toBeUndefined();
    const bytes = JSON.stringify([{ ...record, incusMigration: attacks[1] }]); await writeFile(path, bytes);
    await expect(store.loadUser(record.userId)).rejects.toThrow(/migration marker/);
    expect(() => store.get(record.userId, record.id)).toThrow(/unavailable for this owner/);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
});

test('only validated captured destination cutover changes runtime authority and all other configuration survives', async () => {
  await fixture(async ({ store, record, marker }) => {
    let current = (await store.transitionIncusMigration(record.userId, record.id, undefined, marker)).incusMigration!;
    await expect(store.cutoverIncusMigration(record.userId, record.id, current)).rejects.toThrow(/validated captured/);
    const incarnation = randomUUID();
    for (const phase of ['source-stopped', 'destination-created', 'validating', 'validated'] as const) {
      const next = { ...current, phase, ...(phase === 'source-stopped' ? {} : { destinationIncarnation: incarnation }) };
      current = (await store.transitionIncusMigration(record.userId, record.id, current, next)).incusMigration!;
      expect(store.get(record.userId, record.id)?.runtimeKind).toBe('legacy-docker');
    }
    const committed = await store.cutoverIncusMigration(record.userId, record.id, current);
    expect(committed).toMatchObject({ runtimeKind: 'incus-vm', incusMigration: { ...current, phase: 'retained' } });
    const { runtimeKind: _kind, incusMigration: _migration, updatedAt: _updated, ...configuration } = committed;
    const { updatedAt: _oldUpdated, ...original } = record; expect(configuration).toEqual(original);
    await expect(store.clearIncusMigration(record.userId, record.id, committed.incusMigration!)).rejects.toThrow(/pre-cutover/);
    await expect(store.transitionIncusMigration(record.userId, record.id, committed.incusMigration!, marker)).rejects.toThrow(/Legacy migration/);
    const finalized = await store.clearRetainedIncusMigration(record.userId, record.id, committed.incusMigration!);
    expect(finalized.runtimeKind).toBe('incus-vm'); expect(finalized.incusMigration).toBeUndefined();
  });
});

test('validated migration drops only old disposable imported rootfs authority and preserves stopped intent', async () => {
  await fixture(async ({ store, record, marker }) => {
    await store.upsert({ ...record, desiredRuntimeStatus: 'stopped', importedImage: 'agentor-import-old-rootfs' });
    const opened = await store.transitionIncusMigration(record.userId, record.id, undefined, marker);
    const validated = await store.transitionIncusMigration(record.userId, record.id, opened.incusMigration!,
      { ...opened.incusMigration!, phase: 'validated', destinationIncarnation: randomUUID() });
    const migrated = await store.cutoverIncusMigration(record.userId, record.id, validated.incusMigration!);
    expect(migrated.importedImage).toBeUndefined(); expect(migrated.desiredRuntimeStatus).toBe('stopped');
    expect(migrated.incusMigration?.source).toEqual(marker.source);
    expect(migrated.displayName).toBe(record.displayName); expect(migrated.userId).toBe(record.userId);
  });
});

test('nonce, source facts and captured incarnation cannot be overwritten or removed through stale transitions/upsert', async () => {
  await fixture(async ({ store, record, marker }) => {
    const opened = await store.transitionIncusMigration(record.userId, record.id, undefined, { ...marker,
      sourceVolumes: [{ name: 'source-workspace', createdAt: stamp }], sourceDirectories: [{ path: '/srv/source-agents', dev: 1, ino: 2 }] });
    const current = opened.incusMigration!;
    for (const next of [{ ...current, nonce: randomUUID() }, { ...current, source: { ...current.source, imageId: 'sha256:' + 'c'.repeat(64) } },
      { ...current, sourceVolumes: [] }, { ...current, sourceDirectories: [{ path: '/srv/source-agents', dev: 1, ino: 3 }] }])
      await expect(store.transitionIncusMigration(record.userId, record.id, current, next)).rejects.toThrow(/source or captured/);
    await expect(store.clearIncusMigration(record.userId, record.id, { ...current, nonce: randomUUID() })).rejects.toThrow(/pre-cutover/);
    await expect(store.upsert({ ...opened, incusMigration: undefined })).rejects.toThrow(/guarded transition/);
    await expect(store.upsert({ ...opened, incusMigration: { ...current, source: { ...current.source, containerId: 'c'.repeat(64) } } }))
      .rejects.toThrow(/guarded transition/);
    const created = (await store.transitionIncusMigration(record.userId, record.id, current,
      { ...current, phase: 'destination-created', destinationIncarnation: randomUUID() })).incusMigration!;
    await expect(store.transitionIncusMigration(record.userId, record.id, created, { ...created, destinationIncarnation: randomUUID() })).rejects.toThrow(/captured destination/);
    await expect(store.cutoverIncusMigration(record.userId, record.id, current)).rejects.toThrow(/authority changed/);
    expect(store.get(record.userId, record.id)?.runtimeKind).toBe('legacy-docker');
    const cleared = await store.clearIncusMigration(record.userId, record.id, created);
    expect(cleared.runtimeKind).toBe('legacy-docker'); expect(cleared.incusMigration).toBeUndefined();
  });
});

test('35 exact source proofs are allowed and marker writes roll back on persistence failure', async () => {
  await fixture(async ({ store, record, marker }) => {
    const sourceVolumes = Array.from({ length: 32 }, (_, i) => ({ name: 'owned-' + i, createdAt: stamp }));
    const sourceDirectories = Array.from({ length: 3 }, (_, i) => ({ path: '/srv/owned-' + i, dev: 1, ino: 10 + i }));
    const opened = await store.transitionIncusMigration(record.userId, record.id, undefined, { ...marker, sourceVolumes, sourceDirectories });
    const current = opened.incusMigration!; store.fail = true;
    await expect(store.transitionIncusMigration(record.userId, record.id, current, { ...current, phase: 'source-stopped' })).rejects.toThrow(/persistence failure/);
    expect(store.get(record.userId, record.id)?.incusMigration).toEqual(current);
    await expect(store.clearIncusMigration(record.userId, record.id, current)).rejects.toThrow(/persistence failure/);
    expect(store.get(record.userId, record.id)?.incusMigration).toEqual(current); store.fail = false;
    const changed = { ...store.get(record.userId, record.id)!, displayName: 'Concurrent ordinary config' }; await store.upsert(changed);
    const cleared = await store.clearIncusMigration(record.userId, record.id, current); expect(cleared.displayName).toBe(changed.displayName);
  });
});

test('migration opening excludes native workers, deletion and unrelated recreation guards', async () => {
  await fixture(async ({ store, record, marker }) => {
    for (const change of [{ runtimeKind: 'incus-vm' as const }, { deletionPending: true }, { incusRecreation: { nonce: 'other' } }]) {
      await store.upsert({ ...record, ...change });
      await expect(store.transitionIncusMigration(record.userId, record.id, undefined, marker)).rejects.toThrow(/authority is unavailable/);
      expect(store.get(record.userId, record.id)?.incusMigration).toBeUndefined();
    }
  });
});

test('migration projections and upsert input never alias durable source/phase/proof arrays', async () => {
  await fixture(async ({ store, record, marker, path }) => {
    const input: WorkerRecord = { ...record, incusMigration: { ...marker,
      sourceVolumes: [{ name: 'source-workspace', createdAt: stamp }], sourceDirectories: [{ path: '/srv/owned', dev: 1, ino: 2 }] } };
    await store.upsert(input); const bytes = await readFile(path, 'utf8');
    const expected = structuredClone(store.get(record.userId, record.id)!.incusMigration!);
    input.incusMigration!.source.containerId = 'c'.repeat(64); input.incusMigration!.phase = 'validated';
    input.incusMigration!.sourceVolumes!.push({ name: 'foreign', createdAt: stamp });
    for (const projected of [store.get(record.userId, record.id)!, store.list()[0]!, store.listForUser(record.userId)[0]!, store.findById(record.id)!]) {
      projected.incusMigration!.source.imageId = 'sha256:' + 'c'.repeat(64); projected.incusMigration!.phase = 'validated';
      projected.incusMigration!.destinationIncarnation = randomUUID(); projected.incusMigration!.sourceDirectories![0]!.ino++;
      projected.incusMigration!.sourceVolumes!.pop();
    }
    expect(store.get(record.userId, record.id)!.incusMigration).toEqual(expected);
    await expect(store.cutoverIncusMigration(record.userId, record.id, { ...expected, phase: 'validated', destinationIncarnation: randomUUID() }))
      .rejects.toThrow(/authority changed/);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
});

for (const stage of ['preparing', 'cutover'] as const) test(`queued ordinary setters preserve ${stage} migration authority and deletion remains fenced`, async () => {
  const setters: Array<{ name: string; apply: (store: WorkerStore, record: WorkerRecord) => Promise<unknown> }> = [
    { name: 'desired', apply: (store, record) => store.setDesiredRuntimeStatus(record.userId, record.id, 'stopped') },
    { name: 'mounts', apply: (store, record) => store.updateHostMountAccess(record.userId, record.id, [], true) },
    { name: 'devices', apply: (store, record) => store.updateHardwareDeviceAccess(record.userId, record.id, [], true) },
    { name: 'deletion', apply: (store, record) => store.markDeletionPending(record.userId, record.id) },
  ];
  for (const setter of setters) await fixture(async ({ store, record, marker }) => {
    let migrate: Promise<WorkerRecord>;
    if (stage === 'preparing') migrate = store.transitionIncusMigration(record.userId, record.id, undefined, marker);
    else {
      const opened = await store.transitionIncusMigration(record.userId, record.id, undefined, marker);
      const validated = await store.transitionIncusMigration(record.userId, record.id, opened.incusMigration!,
        { ...opened.incusMigration!, phase: 'validated', destinationIncarnation: randomUUID() });
      migrate = store.cutoverIncusMigration(record.userId, record.id, validated.incusMigration!);
    }
    // Deliberately invoke before the queued migration mutation runs. The old
    // read-before-setItem implementation captured the previous authority here.
    const changing = setter.apply(store, record).then(() => undefined, (error: unknown) => error);
    const migrated = await migrate, result = await changing;
    const current = store.get(record.userId, record.id)!;
    expect(current.incusMigration).toEqual(migrated.incusMigration);
    expect(current.runtimeKind).toBe(stage === 'cutover' ? 'incus-vm' : 'legacy-docker');
    expect(current.deletionPending).not.toBe(true); expect(current.status).toBe('active');
    if (setter.name === 'deletion') expect(result).toBeInstanceOf(Error);
    else {
      expect(result).toBeUndefined();
      if (setter.name === 'desired') expect(current.desiredRuntimeStatus).toBe('stopped');
      if (setter.name === 'mounts') { expect(current.mounts).toBeUndefined(); expect(current.hostMountsRevoked).toBe(true); }
      if (setter.name === 'devices') { expect(current.hardwareDeviceIds).toBeUndefined(); expect(current.hardwareDevicesRevoked).toBe(true); }
    }
  });
});
