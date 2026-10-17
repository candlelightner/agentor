import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { useGroupAdminWorkspaceStore } from '../../orchestrator/server/utils/group-admin-workspace-store';
import { useWorkerGroupStore } from '../../orchestrator/server/utils/services';
import { assertOrdinaryWorkerIdentity, isAdministrativeWorkspaceId } from '../../orchestrator/server/utils/ordinary-worker-identity';
import { withOwnerWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import type { Config } from '../../orchestrator/server/utils/config';
import type { ContainerInfo } from '../../orchestrator/shared/types';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
const platformId = randomUUID(), groupId = randomUUID(), owner = randomUUID();
const stamp = new Date(0).toISOString();
const denied = { statusCode: 409, code: 'ADMINISTRATIVE_WORKSPACE_LIFECYCLE_REQUIRED' };

test.beforeAll(async () => {
  // The modules config supplies a fresh private DATA_DIR before service imports.
  const dataDir = process.env.DATA_DIR!;
  expect(dataDir).toContain('agentor-incus-acceptance-');
  await mkdir(join(dataDir, 'admin'), { recursive: true });
  await writeFile(join(dataDir, 'admin/workspace.v1.json'), JSON.stringify({ schemaVersion: 1,
    id: platformId, kind: 'administrative', trusted: true, status: 'stopped', ownerId: owner,
    createdAt: stamp, updatedAt: stamp }));
  await useAdminWorkspaceStore().init();
  const groups = useWorkerGroupStore(); await groups.init();
  const group = await groups.create(owner, 'Real authoritative group');
  await groups.update(owner, group.id, { adminWorkspace: { schemaVersion: 1, id: groupId,
    kind: 'group-administrative', trusted: true, status: 'stopped', ownerId: owner, groupId: group.id,
    services: [], createdAt: stamp, updatedAt: stamp } });
  expect(useAdminWorkspaceStore().getRecord()?.id).toBe(platformId);
  expect(useGroupAdminWorkspaceStore().findByWorkspaceId(groupId)?.id).toBe(groupId);
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-admin-shadow-'));
  const store = new WorkerStore(dataDir); await store.init();
  let sideEffects = 0;
  const forbidden = new Proxy({}, { get() { return () => { sideEffects++; throw new Error('Unexpected compute/storage operation'); }; } });
  const manager = new ContainerManager(forbidden as any, { dataDir } as Config);
  manager.setWorkerStore(store); (manager as any).storageManager = forbidden;
  (manager as any).assertOwnerExists = async () => {};
  const record = (id: string, displayName: string, userId = owner): WorkerRecord => ({
    id, userId, displayName, status: 'archived', runtimeKind: 'legacy-docker',
    imageRuntimeReference: 'sha256:' + 'a'.repeat(64), createdAt: stamp, updatedAt: stamp,
  });
  return { dataDir, store, manager, record, sideEffects: () => sideEffects };
}

for (const kind of ['platform', 'group'] as const) {
  test(`${kind} authoritative ID is hidden and rejected before ordinary mutation with a cold runtime registry`, async () => {
    const f = await fixture(); const id = kind === 'platform' ? platformId : groupId;
    try {
      await f.store.upsert(f.record(id, kind === 'platform' ? 'ADMIN / ORCHESTRATOR' : 'GROUP ADMIN'));
      const before = await readFile(join(f.dataDir, 'users', owner, 'workers.json'), 'utf8');
      expect(f.manager.get(id)).toBeUndefined();
      expect(isAdministrativeWorkspaceId(id, owner)).toBe(true);
      expect(f.manager.listArchived()).toEqual([]);
      await expect(f.manager.unarchive(owner, id)).rejects.toMatchObject(denied);
      await expect(f.manager.deleteArchived(owner, id)).rejects.toMatchObject(denied);
      expect(() => (f.manager as any).assertOrdinaryMutation({ id, userId: owner })).toThrow('dedicated confirmed admin API');
      expect(await readFile(join(f.dataDir, 'users', owner, 'workers.json'), 'utf8')).toBe(before);
      expect(f.store.get(owner, id)?.deletionPending).toBeUndefined();
      await f.store.upsert({ ...f.store.get(owner, id)!, status: 'active' });
      const activeBefore = f.store.get(owner, id);
      await expect(f.manager.migrateLegacyWorker(id, async () => {})).rejects.toMatchObject(denied);
      expect(f.store.get(owner, id)).toEqual(activeBefore);
      expect(f.sideEffects()).toBe(0);
    } finally { await rm(f.dataDir, { recursive: true, force: true }); }
  });
}

test('same display names on foreign ordinary IDs remain visible and admitted', async () => {
  const f = await fixture(); const otherOwner = randomUUID();
  try {
    const records = ['ADMIN / ORCHESTRATOR', 'GROUP ADMIN'].map(name => f.record(randomUUID(), name, otherOwner));
    for (const record of records) await f.store.upsert(record);
    expect(f.manager.listArchived().map(record => record.id).sort()).toEqual(records.map(record => record.id).sort());
    const reached = new Error('ordinary admission sentinel');
    (f.manager as any).resolveAuthorizedHostMounts = async () => { throw reached; };
    for (const record of records) {
      expect(isAdministrativeWorkspaceId(record.id, otherOwner)).toBe(false);
      expect(() => assertOrdinaryWorkerIdentity(record.id, otherOwner)).not.toThrow();
      expect(() => (f.manager as any).assertOrdinaryMutation({ id: record.id, userId: otherOwner })).not.toThrow();
      await expect(f.manager.unarchive(otherOwner, record.id)).rejects.toBe(reached);
    }
    expect(f.sideEffects()).toBe(0);
  } finally { await rm(f.dataDir, { recursive: true, force: true }); }
});

test('ordinary reconciliation preserves shadow records and does not manufacture new ones', async () => {
  const f = await fixture();
  try {
    await f.store.upsert(f.record(platformId, 'Historical shadow'));
    const before = f.store.get(owner, platformId);
    for (const id of [platformId, groupId]) f.manager.registerExternal({ id, userId: owner,
      containerId: 'docker-' + id, containerName: 'admin-' + id, status: 'stopped',
      runtimeKind: 'legacy-docker', imageId: 'admin-image', imageName: 'admin',
      createdAt: stamp, administrativeKind: id === platformId ? 'platform' : 'group' } as ContainerInfo);
    await f.manager.reconcileWorkers();
    expect(f.store.get(owner, platformId)).toEqual(before);
    expect(f.store.get(owner, groupId)).toBeUndefined();
    expect(f.sideEffects()).toBe(0);
  } finally { await rm(f.dataDir, { recursive: true, force: true }); }
});

test('unavailable target-owner group authority fails closed before ordinary mutation', async () => {
  const f = await fixture(); const unavailableOwner = randomUUID(), id = randomUUID();
  const groups = useWorkerGroupStore();
  const directory = join(process.env.DATA_DIR!, 'users', unavailableOwner);
  try {
    await f.store.upsert(f.record(id, 'Group authority unavailable', unavailableOwner));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'worker-groups.json'), '{invalid');
    await expect(groups.loadUser(unavailableOwner)).rejects.toThrow();
    expect(() => isAdministrativeWorkspaceId(id, unavailableOwner)).toThrow('unavailable');
    expect(() => f.manager.listArchived()).toThrow('unavailable');
    await expect(f.manager.unarchive(unavailableOwner, id)).rejects.toMatchObject({ statusCode: 503 });
    await expect(f.manager.deleteArchived(unavailableOwner, id)).rejects.toMatchObject({ statusCode: 503 });
    await expect(f.manager.migrateLegacyWorker(id, async () => {})).rejects.toMatchObject({ statusCode: 503 });
    expect(f.store.get(unavailableOwner, id)?.deletionPending).toBeUndefined();
    expect(f.sideEffects()).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true }); await groups.loadUser(unavailableOwner);
    await rm(f.dataDir, { recursive: true, force: true });
  }
});

test('queued ordinary lifecycle rechecks an administrative identity assigned before admission', async () => {
  const f = await fixture(); const id = randomUUID();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const blocker = withOwnerWorkerLifecycleMutation(owner, id, async () => { entered(); await hold; });
  try {
    await f.store.upsert({ ...f.record(id, 'Ordinary at request time'), status: 'active' });
    f.manager.registerExternal({ id, userId: owner, containerId: 'docker-' + id,
      containerName: 'ordinary-' + id, status: 'stopped', runtimeKind: 'legacy-docker' } as ContainerInfo);
    await ready;
    const stopped = f.manager.stop(id);
    const group = await useWorkerGroupStore().create(owner, 'Identity assigned while queued');
    await useWorkerGroupStore().update(owner, group.id, { adminWorkspace: { id,
      kind: 'group-administrative', ownerId: owner, groupId: group.id } });
    const result = expect(stopped).rejects.toMatchObject(denied);
    release(); await blocker; await result;
    expect(f.sideEffects()).toBe(0);
    expect(f.store.get(owner, id)?.desiredRuntimeStatus).toBeUndefined();
  } finally { release(); await blocker; await rm(f.dataDir, { recursive: true, force: true }); }
});

test('archived unfinished migration rejects unarchive before compute or record changes', async () => {
  const f = await fixture(); const id = randomUUID();
  try {
    await f.store.upsert({ ...f.record(id, 'Ordinary interrupted migration'), status: 'active' });
    await f.store.transitionIncusMigration(owner, id, undefined, { nonce: randomUUID(), phase: 'preparing',
      source: { containerId: 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64), createdAt: stamp, wasRunning: false } });
    await f.store.upsert({ ...f.store.get(owner, id)!, status: 'archived' });
    const before = f.store.get(owner, id);
    await expect(f.manager.unarchive(owner, id)).rejects.toMatchObject({ statusCode: 409, code: 'WORKER_MIGRATION_RECOVERY_REQUIRED' });
    expect(f.store.get(owner, id)).toEqual(before); expect(f.sideEffects()).toBe(0);
  } finally { await rm(f.dataDir, { recursive: true, force: true }); }
});
