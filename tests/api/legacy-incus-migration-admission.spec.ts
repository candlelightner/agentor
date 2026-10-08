import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore, type WorkerRecord, type WorkerIncusMigration } from '../../orchestrator/server/utils/worker-store';
import type { Config } from '../../orchestrator/server/utils/config';
import type { ContainerInfo } from '../../orchestrator/shared/types';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-migration-admission-'));
  const store = new WorkerStore(dir); await store.init();
  const record: WorkerRecord = { id: randomUUID(), userId: 'migration-owner', displayName: 'Source',
    runtimeKind: 'legacy-docker', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  await store.upsert(record);
  const docker = new Proxy({}, { get: () => () => { throw new Error('Unexpected Docker operation before admission'); } });
  const manager = new ContainerManager(docker as any, { dataDir: dir } as Config);
  manager.setWorkerStore(store); (manager as any).storageManager = {};
  const info = { ...record, status: 'running', containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64),
    containerName: 'agentor-worker-' + record.id, imageName: 'configured-source' } as ContainerInfo;
  manager.registerExternal(info);
  return { dir, store, record, info, manager, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

for (const condition of ['native', 'archived', 'revoked', 'hardware', 'admin', 'migration'] as const)
  test(`migration rejects ${condition} before stopping source or allocating destination`, async () => {
    const f = await fixture();
    try {
      if (condition === 'native') await f.store.upsert({ ...f.record, runtimeKind: 'incus-vm' });
      if (condition === 'archived') await f.store.upsert({ ...f.record, status: 'archived' });
      if (condition === 'revoked') await f.store.upsert({ ...f.record, hostMountsRevoked: true });
      if (condition === 'hardware') await f.store.upsert({ ...f.record, hardwareDeviceIds: ['unimplemented-passthrough'] });
      if (condition === 'admin') f.info.administrativeKind = 'platform';
      if (condition === 'migration') await f.store.transitionIncusMigration(f.record.userId, f.record.id, undefined, {
        nonce: randomUUID(), phase: 'preparing', source: { containerId: f.info.containerId,
          imageId: f.info.imageId, createdAt: f.record.createdAt, wasRunning: true },
      });
      const before = f.store.get(f.record.userId, f.record.id);
      let checks = 0;
      await expect(f.manager.migrateLegacyWorker(f.record.id, async () => { checks++; })).rejects.toMatchObject({ statusCode: 409 });
      expect(checks).toBe(1); expect(f.info.status).toBe('running');
      expect(f.store.get(f.record.userId, f.record.id)).toEqual(before);
    } finally { await f.cleanup(); }
  });

test('migration revocation rejects before any Docker or durable mutation', async () => {
  const f = await fixture();
  try {
    const before = f.store.get(f.record.userId, f.record.id);
    await expect(f.manager.migrateLegacyWorker(f.record.id, async () => {
      throw Object.assign(new Error('Administrator authority revoked'), { statusCode: 403 });
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.store.get(f.record.userId, f.record.id)).toEqual(before);
  } finally { await f.cleanup(); }
});

test('private secret-aware rollback start does not waive a changed migration nonce or source ID', async () => {
  const f = await fixture();
  try {
    const marker: WorkerIncusMigration = { nonce: randomUUID(), phase: 'preparing', source: {
      containerId: f.info.containerId, imageId: f.info.imageId, createdAt: f.record.createdAt, wasRunning: true,
    } };
    await f.store.transitionIncusMigration(f.record.userId, f.record.id, undefined, marker);
    await expect((f.manager as any).restartUnlocked(f.record.id, true, { ...marker, nonce: randomUUID() }))
      .rejects.toThrow('rollback restart authority changed');
    f.info.containerId = 'c'.repeat(64);
    await expect((f.manager as any).restartUnlocked(f.record.id, true, marker))
      .rejects.toThrow('rollback restart authority changed');
    f.info.containerId = marker.source.containerId;
    await f.store.updateHostMountAccess(f.record.userId, f.record.id, [], true);
    await expect((f.manager as any).restartUnlocked(f.record.id, true, marker))
      .rejects.toThrow('rollback restart authority changed');
    await expect(f.manager.restart(f.record.id)).rejects.toMatchObject({ code: 'WORKER_MIGRATION_RECOVERY_REQUIRED' });
    expect(f.store.get(f.record.userId, f.record.id)?.incusMigration).toMatchObject({ ...marker });
  } finally { await f.cleanup(); }
});
