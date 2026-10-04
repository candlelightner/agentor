import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { useBackupManager } from '../../orchestrator/server/utils/backup-manager';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import type { Config } from '../../orchestrator/server/utils/config';

(globalThis as any).useLogger ??= () => ({ info() {}, error() {}, warn() {}, debug() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });

async function fixture(run: (manager: ContainerManager, store: WorkerStore, calls: string[], info: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-incus-archive-'));
  const calls: string[] = [];
  const manager = new ContainerManager(new Proxy({}, { get: () => () => { throw new Error('Docker must not be called'); } }) as any,
    { containerPrefix: 'agentor-worker', incusEnabled: false } as Config);
  const store = new WorkerStore(root); await store.init(); manager.setWorkerStore(store);
  (manager as any).assertOwnerExists = async () => {};
  const stamp = new Date().toISOString();
  const info: any = { id: 'archive-worker', userId: 'archive-owner', runtimeKind: 'incus-vm',
    status: 'running', containerId: 'incus:original-uuid', containerName: 'agentor-worker-archive-worker',
    desiredRuntimeStatus: 'running', displayName: 'archive', createdAt: stamp, updatedAt: stamp, pendingRebuild: true };
  await store.upsert({ ...(manager as any).containerInfoToWorkerRecord(info), status: 'active' });
  (manager as any).containers.set(info.id, info);
  (manager as any).assertIncusPersistenceReady = async () => { calls.push('persistence-preflight'); };
  manager.setIncusRuntime({ prepareArchive: async (owner: any, uuid: string) => {
    expect(owner.userId).toBe(info.userId); expect(uuid).toBe('original-uuid'); calls.push('source-preflight'); },
    remove: async (owner: any, uuid: string) => {
      expect(owner.id).toBe(info.id); expect(uuid).toBe('original-uuid'); calls.push('remove-compute'); },
    removeStorage: async () => { throw new Error('Archive must retain canonical volumes'); },
  } as any);
  try { await run(manager, store, calls, info); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('Incus archive removes only proven compute and retains pending configuration and worker record', async () => {
  await fixture(async (manager, store, calls, info) => {
    await manager.archive(info.id);
    expect(calls).toEqual(['persistence-preflight', 'source-preflight', 'remove-compute']);
    expect(manager.get(info.id)).toBeUndefined();
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'archived', runtimeKind: 'incus-vm',
      desiredRuntimeStatus: 'stopped', pendingRebuild: true });
  });
});

test('Incus archive persistence failure retains the captured incarnation for safe retry', async () => {
  await fixture(async (manager, store, calls, info) => {
    const archive = store.archive.bind(store);
    let failed = false;
    store.archive = async (...args) => { if (!failed) { failed = true; throw new Error('injected archive persistence failure'); } return archive(...args); };
    await expect(manager.archive(info.id)).rejects.toThrow('injected archive persistence failure');
    expect(manager.get(info.id)).toMatchObject({ containerId: 'incus:original-uuid', status: 'error' });
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'stopped' });
    await manager.archive(info.id);
    expect(calls.filter((call) => call === 'remove-compute')).toHaveLength(2);
    expect(store.get(info.userId, info.id)?.status).toBe('archived');
  });
});

test('Incus archive preflight failures leave original compute and metadata active', async () => {
  await fixture(async (manager, store, calls, info) => {
    (manager as any).incusRuntime.prepareArchive = async () => { throw new Error('ambiguous source/storage'); };
    await expect(manager.archive(info.id)).rejects.toThrow('ambiguous source/storage');
    expect(calls).toEqual(['persistence-preflight']);
    expect(manager.get(info.id)).toMatchObject({ status: 'running', containerId: 'incus:original-uuid' });
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'running' });
  });
});

test('Incus archive requires matching active durable authority before touching compute', async () => {
  for (const invalid of ['missing', 'legacy', 'archived', 'deleting']) {
    await fixture(async (manager, store, calls, info) => {
      if (invalid === 'missing') await store.delete(info.userId, info.id);
      else await store.upsert({ ...store.get(info.userId, info.id)!,
        runtimeKind: invalid === 'legacy' ? 'legacy-docker' : 'incus-vm',
        status: invalid === 'archived' ? 'archived' : 'active', deletionPending: invalid === 'deleting' });
      await expect(manager.archive(info.id)).rejects.toThrow('matching active durable worker record');
      expect(calls).toEqual([]);
    });
  }
});

test('Incus archive refuses unresolved selected-directory and managed-volume persistence', async () => {
  const manager = new ContainerManager({} as any, { incusEnabled: false } as Config);
  const backup = useBackupManager(), volumes = useManagedVolumeManager();
  const original = { config: backup.getConfig, init: volumes.init, blocked: volumes.isRecoveryBlocked,
    recreation: volumes.recreations.get, records: volumes.store.forWorker };
  let paths = ['/workspace', '/home/agent/.agent-data'];
  let attached = false;
  backup.getConfig = async () => ({ selectedPathsByWorkspace: { worker: paths } } as any);
  volumes.init = async () => {}; volumes.isRecoveryBlocked = () => false;
  volumes.recreations.get = () => undefined;
  volumes.store.forWorker = () => attached ? [{ attached: true } as any] : [];
  try {
    await (manager as any).assertIncusPersistenceReady({ id: 'worker', userId: 'owner' });
    for (const selection of [['/'], ['/', '/opt/project'], ['/opt/project'], ['/workspace/../opt/project'], ['/workspace/possible-symlink']]) {
      paths = selection;
      await expect((manager as any).assertIncusPersistenceReady({ id: 'worker', userId: 'owner' })).rejects.toThrow('selected-directory persistence');
    }
    paths = ['/workspace']; attached = true;
    await expect((manager as any).assertIncusPersistenceReady({ id: 'worker', userId: 'owner' })).rejects.toThrow('managed persistent storage');
  } finally {
    backup.getConfig = original.config; volumes.init = original.init; volumes.isRecoveryBlocked = original.blocked;
    volumes.recreations.get = original.recreation; volumes.store.forWorker = original.records;
  }
});

test('real production-manager archive retains canonical volumes, source and pending settings without Docker', async () => {
  test.skip(process.env.INCUS_ARCHIVE_TEST !== 'true', 'Explicit disposable Incus archive acceptance');
  test.setTimeout(600_000);
  const root = await mkdtemp(join(tmpdir(), 'agentor-incus-archive-live-'));
  const config = { dataDir: root, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase6-candidate',
    incusInternalGatewayUrl: 'http://10.159.68.1:3000', containerPrefix: 'agentor-worker', workerImage: 'agentor-worker:latest', workerImagePrefix: '' } as Config;
  const store = new WorkerStore(root); await store.init();
  const runtime = new IncusWorkerRuntime(config);
  const manager = new ContainerManager(new Proxy({}, { get: () => () => { throw new Error('Docker fallback'); } }) as any, config);
  manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  (manager as any).assertOwnerExists = async () => {};
  (manager as any).resolveGitIdentity = async () => ({ gitName: '', gitEmail: '' });
  (manager as any).resolveAuthorizedHostMounts = async () => undefined;
  (manager as any).resolveHardwareDeviceAccess = async () => undefined;
  (manager as any).resolveUserEnvAndBinds = async () => ({ userEnv: zeroUserEnvVars('archive-live-owner'), credentialBinds: [], groupSecrets: [] });
  (manager as any).resolveEnvironmentConfig = () => ({ dockerEnabled: false,
    environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '',
      exposeApis: { portMappings: true, domainMappings: true, usage: true } }, capabilitiesJson: [], instructionsJson: [] });
  try {
    const info = await (manager as any).createForOwner({ userId: 'archive-live-owner', displayName: 'archive acceptance' });
    const created = await runtime.client.exec(info.containerName, ['sh', '-ec',
      'echo retained-workspace > /workspace/archive-fixture; echo retained-agents > /home/agent/.agent-data/archive-fixture']);
    expect(created.returnCode).toBe(0);
    info.pendingRebuild = true;
    await store.upsert((manager as any).containerInfoToWorkerRecord(info));
    const before = await runtime.client.getCustomVolume(config.incusStoragePool, `${info.containerName}-workspace`);
    await manager.archive(info.id);
    await expect(runtime.client.getInstance(info.containerName)).rejects.toMatchObject({ statusCode: 404 });
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'archived', desiredRuntimeStatus: 'stopped', pendingRebuild: true });
    expect(manager.get(info.id)).toBeUndefined();
    for (const role of ['workspace', 'agents']) {
      const volume = await runtime.client.getCustomVolume(config.incusStoragePool, `${info.containerName}-${role}`);
      expect(volume.config['user.agentor.id']).toBe(info.id); expect(volume.used_by ?? []).toEqual([]);
    }
    const after = await runtime.client.getCustomVolume(config.incusStoragePool, `${info.containerName}-workspace`);
    expect(after.config['user.agentor.image-source']).toBe(before.config['user.agentor.image-source']);
  } finally {
    for (const worker of store.list()) {
      const owner = { id: worker.id, userId: worker.userId, containerName: manager.buildContainerName(worker.id) };
      await runtime.remove(owner); await runtime.removeStorage(owner);
    }
    await rm(root, { recursive: true, force: true });
  }
});
