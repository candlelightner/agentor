import { test, expect } from '@playwright/test';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import type { Config } from '../../orchestrator/server/utils/config';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

async function fixture(run: (manager: ContainerManager, dataDir: string, info: any) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-native-backup-fence-'));
  const manager = new ContainerManager(new Proxy({}, { get: () => () => {
    throw new Error('Canonical native backup fence must not reach Docker');
  } }) as any, { dataDir, containerPrefix: 'worker' } as Config);
  const id = randomUUID(), store = new WorkerStore(dataDir); await store.init();
  manager.setWorkerStore(store);
  const info: any = { id, userId: 'backup-fence-owner', containerName: 'worker-' + id,
    containerId: 'incus:' + randomUUID(), runtimeKind: 'incus-vm', status: 'running', displayName: 'fence' };
  await store.upsert({ id, userId: info.userId, runtimeKind: 'incus-vm', status: 'active', displayName: 'fence' } as any);
  manager.registerExternal(info);
  manager.setIncusRuntime(new Proxy({}, { get: () => () => {
    throw new Error('Canonical backup fence must reject before guest/file/image operations');
  } }) as any);
  try { await run(manager, dataDir, info); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

test('unresolved canonical managed storage rejects export before staging or guest exec', async () => {
  await fixture(async (manager, dataDir, info) => {
    const managed = useManagedVolumeManager(), init = managed.init, assert = managed.assertLiveRecoveryResolved;
    const calls: string[] = [];
    managed.init = async () => { calls.push('init'); };
    managed.assertLiveRecoveryResolved = (owner, id) => {
      expect(owner).toBe(info.userId); expect(id).toBe(info.id); calls.push('fence');
      throw new Error('Unresolved cutover authority');
    };
    try {
      await expect(manager.exportWorker(info.id, { includeRootfs: false })).rejects.toThrow('Unresolved cutover authority');
      expect(calls).toEqual(['init', 'fence']);
      await expect(lstat(join(dataDir, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { managed.init = init; managed.assertLiveRecoveryResolved = assert; }
  });
});

test('native rootfs and not-yet-supported managed capture fail explicitly without legacy fallback', async () => {
  for (const option of ['rootfs', 'managed']) await fixture(async (manager, dataDir, info) => {
    await expect(manager.exportWorker(info.id, { includeRootfs: option === 'rootfs', includeManagedVolumes: option === 'managed' }))
      .rejects.toMatchObject({ code: option === 'rootfs' ? 'INCUS_DISPOSABLE_ROOTFS' : 'INCUS_ARCHIVE_CAPABILITY_PENDING' });
    await expect(lstat(join(dataDir, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('cached legacy handles cannot export durable native or archived records through Docker', async () => {
  for (const status of ['active', 'archived'] as const) await fixture(async (manager, dataDir, info) => {
    info.runtimeKind = 'legacy-docker'; info.containerId = 'cached-legacy';
    const store = new WorkerStore(dataDir); await store.init();
    await store.upsert({ ...store.get(info.userId, info.id)!, status });
    manager.setWorkerStore(store);
    await expect(manager.exportWorker(info.id, { includeRootfs: false })).rejects.toThrow('runtime authority disagree');
    await expect(lstat(join(dataDir, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
