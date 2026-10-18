import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore, type WorkerRecord, type WorkerIncusMigration } from '../../orchestrator/server/utils/worker-store';
import type { Config } from '../../orchestrator/server/utils/config';
import type { ContainerInfo } from '../../orchestrator/shared/types';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

test('persisted pending migration fences ordinary lifecycle, export and runtime access without adopting a destination', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-migration-fence-'));
  try {
    const store = new WorkerStore(dataDir); await store.init();
    const record: WorkerRecord = { id: randomUUID(), userId: 'migration-owner', displayName: 'Original',
      status: 'active', runtimeKind: 'legacy-docker', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    await store.upsert(record);
    const marker: WorkerIncusMigration = { nonce: randomUUID(), phase: 'preparing', source: {
      containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), createdAt: record.createdAt, wasRunning: true,
    } };
    await store.transitionIncusMigration(record.userId, record.id, undefined, marker);
    const manager = new ContainerManager({} as any, { dataDir } as Config);
    (manager as any).workerStore = store;
    const info = { ...record, containerId: marker.source.containerId, containerName: 'agentor-worker-' + record.id,
      imageId: marker.source.imageId, imageName: 'original-source', status: 'running' } as ContainerInfo;
    manager.registerExternal(info);
    expect(manager.get(record.id)).toMatchObject({ runtimeKind: 'legacy-docker', status: 'error',
      runtimeDiagnostic: { code: 'WORKER_MIGRATION_RECOVERY_REQUIRED' } });
    expect(manager.list()[0]?.status).toBe('error'); expect(info.status).toBe('running');
    expect(() => (manager as any).assertOrdinaryMutation(info)).toThrow('migration is incomplete');
    expect(() => (manager as any).assertRunning(record.id)).toThrow();
    await expect(manager.exportWorkerWithLifecycleFenceHeld(record.id, { includeRootfs: false })).rejects.toMatchObject({ statusCode: 409 });
    expect((manager as any).containerInfoToWorkerRecord(info).incusMigration).toEqual(store.get(record.userId, record.id)?.incusMigration);
    expect(store.get(record.userId, record.id)?.runtimeKind).toBe('legacy-docker');
    await store.upsert({ ...store.get(record.userId, record.id)!, status: 'archived' });
    expect(manager.listArchived()[0]).not.toHaveProperty('incusMigration');
    await expect((manager as any).deleteArchivedUnlocked(record.userId, record.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(store.get(record.userId, record.id)?.deletionPending).toBeUndefined();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('validated retained migration permits ordinary use but cannot orphan source authority on permanent delete', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-migration-retained-'));
  try {
    const store = new WorkerStore(dataDir); await store.init();
    const record: WorkerRecord = { id: randomUUID(), userId: 'migration-owner', displayName: 'Original', status: 'active',
      runtimeKind: 'legacy-docker', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    await store.upsert(record);
    let marker: WorkerIncusMigration = { nonce: randomUUID(), phase: 'preparing', source: {
      containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), createdAt: record.createdAt, wasRunning: false,
    } };
    await store.transitionIncusMigration(record.userId, record.id, undefined, marker);
    marker = store.get(record.userId, record.id)!.incusMigration!;
    const next = { ...marker, phase: 'validated' as const, destinationIncarnation: randomUUID() };
    await store.transitionIncusMigration(record.userId, record.id, marker, next);
    await store.cutoverIncusMigration(record.userId, record.id, store.get(record.userId, record.id)!.incusMigration!);
    const manager = new ContainerManager({} as any, { dataDir } as Config); (manager as any).workerStore = store;
    const info = { ...record, runtimeKind: 'incus-vm', containerId: 'incus:' + next.destinationIncarnation,
      containerName: 'agentor-worker-' + record.id, imageId: 'native', imageName: 'native', status: 'running' } as ContainerInfo;
    manager.registerExternal(info);
    expect(manager.get(record.id)).toBe(info);
    expect(() => (manager as any).assertOrdinaryMutation(info)).not.toThrow();
    await expect((manager as any).removeUnlocked(record.id)).rejects.toThrow('Finalize retained');
    expect(store.get(record.userId, record.id)?.incusMigration?.phase).toBe('retained');
    expect(store.get(record.userId, record.id)?.runtimeKind).toBe('incus-vm');
    await store.upsert({ ...store.get(record.userId, record.id)!, status: 'archived' });
    (manager as any).recreateIncusWorker = async (snapshot: ContainerInfo) => {
      snapshot.status = 'running'; manager.registerExternal(snapshot); return snapshot;
    };
    const publicUnarchive = await (manager as any).unarchiveUnlocked(record.userId, record.id);
    expect(publicUnarchive).not.toHaveProperty('incusMigration');
    expect(manager.get(record.id)).not.toHaveProperty('incusMigration');
    expect(manager.list()[0]).not.toHaveProperty('incusMigration');
    expect(store.get(record.userId, record.id)?.incusMigration?.phase).toBe('retained');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
