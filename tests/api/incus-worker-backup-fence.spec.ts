import { test, expect } from '@playwright/test';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import type { Config } from '../../orchestrator/server/utils/config';
import { Readable } from 'node:stream';
import { withWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

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
  for (const includeManagedVolumes of [false, true]) await fixture(async (manager, dataDir, info) => {
    const managed = useManagedVolumeManager(), init = managed.init, assert = managed.assertLiveRecoveryResolved;
    const calls: string[] = [];
    managed.init = async () => { calls.push('init'); };
    managed.assertLiveRecoveryResolved = (owner, id) => {
      expect(owner).toBe(info.userId); expect(id).toBe(info.id); calls.push('fence');
      throw new Error('Unresolved cutover authority');
    };
    try {
      await expect(manager.exportWorker(info.id, { includeRootfs: false, includeManagedVolumes })).rejects.toThrow('Unresolved cutover authority');
      expect(calls).toEqual(['init', 'fence']);
      await expect(lstat(join(dataDir, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { managed.init = init; managed.assertLiveRecoveryResolved = assert; }
  });
});

test('native disposable rootfs capture fails explicitly without legacy fallback', async () => {
  await fixture(async (manager, dataDir, info) => {
    await expect(manager.exportWorker(info.id, { includeRootfs: true, includeManagedVolumes: true }))
      .rejects.toMatchObject({ code: 'INCUS_DISPOSABLE_ROOTFS' });
    await expect(lstat(join(dataDir, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('selected native getter refuses missing lifecycle admission and incomplete or revoked records before native exec', async () => {
  for (const kind of ['admission', 'incomplete', 'revoked', 'stopped']) await fixture(async (manager, dataDir, info) => {
    if (kind === 'admission') {
      await expect(manager.getSelectedBackupArchiveWithLifecycleFenceHeld(info.id, '/tmp/selected')).rejects.toThrow('lifecycle admission');
      return;
    }
    const store = new WorkerStore(dataDir); await store.init();
    await store.upsert({ ...store.get(info.userId, info.id)!,
      ...(kind === 'incomplete' ? { incusRecreation: { nonce: randomUUID(), initialCreate: true, importIncomplete: true } }
        : kind === 'revoked' ? { hostMountsRevoked: true } : {}) });
    manager.setWorkerStore(store);
    if (kind === 'stopped') info.status = 'stopped';
    await withWorkerLifecycleMutation(info.id, () => expect(manager.getSelectedBackupArchiveWithLifecycleFenceHeld(info.id, '/tmp/selected'))
      .rejects.toThrow('settled running worker'));
  });
});

test('selected native getter captures durable records and existing source layout without environment or storage ensure', async () => {
  await fixture(async (manager, dataDir, info) => {
    const store = new WorkerStore(dataDir); await store.init(); manager.setWorkerStore(store);
    (manager as any).incusOptionsForWorker = () => { throw new Error('Capture must not resolve/ensure runtime environment'); };
    let calls = 0;
    manager.setIncusRuntime({ openSelectedArchive: async (owner: any, uuid: string, path: string, validate: () => void) => {
      calls++; expect(owner).toMatchObject({ id: info.id, userId: info.userId, containerName: info.containerName, mounts: [], managedVolumes: [] });
      expect(uuid).toBe(info.containerId.slice(6)); expect(path).toBe('/tmp/selected'); validate();
      await store.upsert({ ...store.get(info.userId, info.id)!, hostMountsRevoked: true });
      expect(validate).toThrow('authority changed');
      return Readable.from([Buffer.from([0,255,128,10])]);
    } } as any);
    await withWorkerLifecycleMutation(info.id, async () => {
      const stream = await manager.getSelectedBackupArchiveWithLifecycleFenceHeld(info.id, '/tmp/selected');
      const chunks = []; for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0,255,128,10]));
    });
    expect(calls).toBe(1);
  });
});

test('exact native Docker selection shares existing admission but never enters the ordinary selected or legacy archive backend', async () => {
  await fixture(async (manager, _dataDir, info) => {
    let calls = 0;
    manager.setIncusRuntime({ openDockerArchive: async (owner: any, uuid: string, validate: () => void, signal?: AbortSignal) => {
      calls++; expect(owner).toMatchObject({ id: info.id, userId: info.userId, containerName: info.containerName, mounts: [], managedVolumes: [] });
      expect(uuid).toBe(info.containerId.slice(6)); expect(signal).toBeUndefined(); validate();
      return Readable.from([Buffer.from([0,255,128,10])]);
    }, openSelectedArchive: () => { throw new Error('Docker data must not enter selected tree walker'); } } as any);
    await expect(manager.getSelectedBackupArchiveWithLifecycleFenceHeld(info.id, '/var/lib/docker')).rejects.toThrow('lifecycle admission');
    expect(calls).toBe(0);
    await withWorkerLifecycleMutation(info.id, async () => {
      for (const path of ['/var/lib/docker/volumes', '/var/lib/docker/overlay2'])
        await expect(manager.getSelectedBackupArchiveWithLifecycleFenceHeld(info.id, path)).rejects.toMatchObject({ code: 'INCUS_DOCKER_BACKUP_REQUIRED' });
      const stream = await manager.getSelectedBackupArchiveWithLifecycleFenceHeld(info.id, '/var/lib/docker/');
      const chunks = []; for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0,255,128,10]));
    });
    expect(calls).toBe(1);
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

test('offline native Docker backup requires lifecycle admission and settled stopped or archived authority without repair', async () => {
  for (const archived of [false, true]) await fixture(async (manager, dataDir, info) => {
    const store = new WorkerStore(dataDir); await store.init(); manager.setWorkerStore(store);
    if (archived) {
      manager.unregisterExternal(info.id); await store.upsert({ ...store.get(info.userId, info.id)!, status: 'archived' });
    } else info.status = 'stopped';
    let calls = 0;
    manager.setIncusRuntime({ captureOfflineDocker: async (owner: any, uuid: string | undefined, validate: () => void, options: any) => {
      calls++; expect(owner).toEqual({ id: info.id, userId: info.userId, containerName: info.containerName });
      expect(uuid).toBe(archived ? undefined : info.containerId.slice(6)); expect(options.archivePath).toBe('/tmp/owned-archive.tar');
      expect(options.maxBytes).toBe(100 * 1024 ** 3); validate();
      await store.upsert({ ...store.get(info.userId, info.id)!, hostMountsRevoked: true });
      expect(validate).toThrow('authority changed'); return 1024;
    } } as any);
    await expect(manager.captureOfflineDockerBackupWithLifecycleFenceHeld(info.id, '/tmp/owned-archive.tar')).rejects.toThrow('lifecycle admission');
    expect(calls).toBe(0);
    await withWorkerLifecycleMutation(info.id, async () => {
      expect(await manager.captureOfflineDockerBackupWithLifecycleFenceHeld(info.id, '/tmp/owned-archive.tar')).toBe(1024);
      await expect(manager.captureOfflineDockerBackupWithLifecycleFenceHeld(info.id, '/tmp/owned-archive.tar')).rejects.toThrow('settled stopped/archived');
    });
    expect(calls).toBe(1);
  });
});
