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
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import type { Config } from '../../orchestrator/server/utils/config';

(globalThis as any).useLogger ??= () => ({ info() {}, error() {}, warn() {}, debug() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).reassignWorkerMappings ??= async () => {};

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

test('queued archive/unarchive transitions never clobber pending config or reinsert deleted records', async () => {
  for (const transition of ['archive', 'unarchive'] as const) await fixture(async (_manager, store, _calls, info) => {
    await store.upsert({ ...store.get(info.userId, info.id)!, pendingRebuild: false });
    await Promise.all([store.markPendingRebuild(info.userId, info.id), store[transition](info.userId, info.id)]);
    expect(store.get(info.userId, info.id)?.pendingRebuild).toBe(true);
    const deleted = await Promise.allSettled([store.delete(info.userId, info.id), store[transition](info.userId, info.id)]);
    expect(deleted[0]!.status).toBe('fulfilled');
    expect(deleted[1]!.status).toBe('rejected');
    expect(store.get(info.userId, info.id)).toBeUndefined();
  });
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

async function recreationFixture(run: (manager: ContainerManager, store: WorkerStore, calls: string[], info: any) => Promise<void>) {
  await fixture(async (manager, store, calls, info) => {
    (manager as any).resolveAuthorizedHostMounts = async () => undefined;
    (manager as any).resolveHardwareDeviceAccess = async () => undefined;
    (manager as any).reconcileWorkerPlugins = async () => { calls.push('plugins'); };
    const opts: any = { id: info.id, userId: info.userId, containerName: info.containerName,
      userEnv: zeroUserEnvVars(info.userId), dockerEnabled: false,
      environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '', exposeApis: {} },
      capabilitiesJson: [], instructionsJson: [], workerJson: { id: info.id, displayName: '', repos: [], initScript: '', gitName: '', gitEmail: '' } };
    (manager as any).incusOptionsForWorker = async () => opts;
    const runtime = (manager as any).incusRuntime;
    runtime.preflightRecreation = async () => { calls.push('preflight'); return { fingerprint: 'pinned', docker: false }; };
    runtime.create = async (options: any, existing: any) => {
      expect(options.start).toBe(false); expect(existing.fingerprint).toBe('pinned');
      expect(store.get(info.userId, info.id)?.incusRecreation?.nonce).toBe(options.recreationNonce);
      calls.push('create');
      return { config: { 'volatile.uuid': 'replacement-uuid', 'user.agentor.recreation': options.recreationNonce } };
    };
    runtime.matchesWorkerIdentity = async () => true;
    runtime.start = async (_options: any, uuid: string) => {
      expect(uuid).toBe('replacement-uuid');
      expect(store.get(info.userId, info.id)?.incusRecreation?.replacementIncarnation).toBe(uuid);
      calls.push('start');
    };
    runtime.remove = async (_owner: any, uuid: string) => {
      expect(['original-uuid', 'replacement-uuid']).toContain(uuid); calls.push(`remove-${uuid}`);
    };
    const configStore = useWorkerConfigStore(), mark = configStore.markApplied;
    configStore.markApplied = async () => { calls.push('applied'); };
    try { await run(manager, store, calls, info); }
    finally { configStore.markApplied = mark; }
  });
}

test('Incus rebuild preflights before original removal and captures replacement UUID before start', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    const replacement = await manager.rebuild(info.id);
    expect(calls).toEqual(['persistence-preflight', 'source-preflight', 'preflight', 'remove-original-uuid', 'create', 'start', 'applied', 'plugins']);
    expect(replacement).toMatchObject({ containerId: 'incus:replacement-uuid', status: 'running', pendingRebuild: false });
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'running', pendingRebuild: false });
    expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
  });
});

test('Incus unarchive reconstructs existing storage without original-compute removal', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    await store.archive(info.userId, info.id); (manager as any).containers.delete(info.id);
    await manager.unarchive(info.userId, info.id);
    expect(calls).toEqual(['persistence-preflight', 'preflight', 'create', 'start', 'applied', 'plugins']);
    expect(store.get(info.userId, info.id)?.status).toBe('active');
  });
});

test('Incus rebuild preflight failures never stop/delete original compute', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    (manager as any).incusRuntime.preflightRecreation = async () => { throw new Error('missing canonical data'); };
    await expect(manager.rebuild(info.id)).rejects.toThrow('missing canonical data');
    expect(calls).toEqual(['persistence-preflight', 'source-preflight']);
    expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
    expect(manager.get(info.id)?.status).toBe('running');
  });
});

test('Incus create conflict/lost response never name-cleans ambiguous compute and remains durably quarantined', async () => {
  for (const statusCode of [409, 503]) await recreationFixture(async (manager, store, calls, info) => {
    (manager as any).incusRuntime.create = async () => { calls.push('ambiguous-create'); throw Object.assign(new Error('lost/conflict'), { statusCode }); };
    await expect(manager.rebuild(info.id)).rejects.toMatchObject({ code: 'WORKER_RECREATE_CONTAINER_RETAINED' });
    expect(calls.filter((call) => call.startsWith('remove-'))).toEqual(['remove-original-uuid']);
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'stopped', pendingRebuild: true });
    expect(store.get(info.userId, info.id)?.incusRecreation?.nonce).toBeTruthy();
    await expect(manager.restart(info.id)).rejects.toThrow('explicit recovery');
  });
});

test('Incus provisioning failure removes only captured replacement and retains archived configuration/data', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    (manager as any).incusRuntime.start = async () => { throw new Error('provision failed'); };
    await expect(manager.rebuild(info.id)).rejects.toThrow('provision failed');
    expect(calls.filter((call) => call.startsWith('remove-'))).toEqual(['remove-original-uuid', 'remove-replacement-uuid']);
    expect(calls).not.toContain('applied');
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'archived', pendingRebuild: true, desiredRuntimeStatus: 'stopped' });
    expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
    expect(manager.get(info.id)).toBeUndefined();
  });
});

test('configuration edits during Incus replacement keep desired revision and pending marker on success/failure', async () => {
  for (const fail of [false, true]) await recreationFixture(async (manager, store, calls, info) => {
    const config = useWorkerConfigStore(), resolve = config.resolveDesiredRevision;
    const oldRevision = { userId: info.userId, workerId: info.id, updatedAt: 'same-millisecond',
      entries: [{ kind: 'variable' as const, key: 'COLOR', value: 'old' }] };
    const newer = { ...oldRevision, entries: [{ kind: 'variable' as const, key: 'COLOR', value: 'new' }] };
    const options = await (manager as any).incusOptionsForWorker();
    options.configurationRevision = oldRevision;
    options.workerConfig = oldRevision.entries;
    config.resolveDesiredRevision = async () => ({ revision: newer, values: newer.entries });
    const start = (manager as any).incusRuntime.start;
    (manager as any).incusRuntime.start = async (...args: any[]) => {
      await store.markPendingRebuild(info.userId, info.id);
      manager.get(info.id)!.pendingRebuild = true;
      if (fail) throw new Error('failed after concurrent edit');
      await start(...args);
    };
    try {
      if (fail) await expect(manager.rebuild(info.id)).rejects.toThrow('failed after concurrent edit');
      else {
        const replacement = await manager.rebuild(info.id);
        expect(replacement.pendingRebuild).toBe(true);
      }
      expect(store.get(info.userId, info.id)?.pendingRebuild).toBe(true);
      expect((await config.resolveDesiredRevision(info.userId, info.id)).values[0]!.value).toBe('new');
      expect(options.workerConfig[0].value).toBe('old');
    } finally { config.resolveDesiredRevision = resolve; }
  });
});

test('Incus removal or archive-persistence ambiguity retains durable original recovery identity', async () => {
  for (const failure of ['remove', 'archive']) await recreationFixture(async (manager, store, calls, info) => {
    if (failure === 'remove') (manager as any).incusRuntime.remove = async () => { throw new Error('remove ambiguity'); };
    else store.archive = async () => { throw new Error('archive persistence ambiguity'); };
    await expect(manager.rebuild(info.id)).rejects.toThrow('ambiguity');
    expect(store.get(info.userId, info.id)?.incusRecreation).toMatchObject({ originalIncarnation: 'original-uuid' });
    expect(store.get(info.userId, info.id)?.desiredRuntimeStatus).toBe('stopped');
    expect(calls).not.toContain('create');
    await expect(manager.restart(info.id)).rejects.toThrow('explicit recovery');
  });
});

test('Incus rebuild does not clear newer account/group/environment configuration pending during boot', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    const options = await (manager as any).incusOptionsForWorker();
    let bootFinished = false;
    (manager as any).incusOptionsForWorker = async () => bootFinished ? { ...options,
      userEnv: { ...options.userEnv, envVars: [{ key: 'ACCOUNT', value: 'new' }] },
      workerConfig: [{ kind: 'secret', key: 'GROUP', value: 'new' }],
      environmentJson: { ...options.environmentJson, envVars: 'COLOR=new' } } : options;
    const start = (manager as any).incusRuntime.start;
    (manager as any).incusRuntime.start = async (...args: any[]) => { await start(...args); bootFinished = true; };
    const replacement = await manager.rebuild(info.id);
    expect(replacement.pendingRebuild).toBe(true);
    expect(store.get(info.userId, info.id)?.pendingRebuild).toBe(true);
  });
});

test('real production-manager archive retains canonical volumes, source and pending settings without Docker', async () => {
  test.skip(process.env.INCUS_ARCHIVE_TEST !== 'true' && process.env.INCUS_RECREATION_TEST !== 'true', 'Explicit disposable Incus lifecycle acceptance');
  test.setTimeout(900_000);
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
    let info = await (manager as any).createForOwner({ userId: 'archive-live-owner', displayName: 'archive acceptance' });
    const created = await runtime.client.exec(info.containerName, ['sh', '-ec',
      'echo retained-workspace > /workspace/archive-fixture; echo retained-agents > /home/agent/.agent-data/archive-fixture']);
    expect(created.returnCode).toBe(0);
    if (process.env.INCUS_RECREATION_TEST === 'true') {
      const oldHandle = info.containerId;
      info.initScript = 'echo applied-rebuild > /workspace/rebuild-applied'; info.pendingRebuild = true;
      await store.upsert((manager as any).containerInfoToWorkerRecord(info));
      await useWorkerConfigStore().replace(info.userId, info.id, [{ kind: 'secret', key: 'REBUILD_SECRET', value: 'live-revision' }]);
      info = await manager.rebuild(info.id);
      expect(info.containerId).not.toBe(oldHandle); expect(info.status).toBe('running');
      expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
      const retained = await runtime.client.exec(info.containerName, ['sh', '-ec',
        'test "$(cat /workspace/archive-fixture)" = retained-workspace; test "$(cat /home/agent/.agent-data/archive-fixture)" = retained-agents; test "$(cat /workspace/rebuild-applied)" = applied-rebuild']);
      expect(retained.returnCode).toBe(0);
      expect((await useWorkerConfigStore().resolveAppliedValues(info.userId, info.id))[0]!.value).toBe('live-revision');
    }
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
    if (process.env.INCUS_RECREATION_TEST === 'true') {
      info = await manager.unarchive(info.userId, info.id);
      expect(info.status).toBe('running'); expect(info.pendingRebuild).toBe(false);
      const retained = await runtime.client.exec(info.containerName, ['sh', '-ec',
        'test "$(cat /workspace/archive-fixture)" = retained-workspace; test "$(cat /home/agent/.agent-data/archive-fixture)" = retained-agents; systemctl is-active --quiet agentor-worker']);
      expect(retained.returnCode).toBe(0);
    }
  } finally {
    for (const worker of store.list()) {
      const owner = { id: worker.id, userId: worker.userId, containerName: manager.buildContainerName(worker.id) };
      await runtime.remove(owner); await runtime.removeStorage(owner);
    }
    await rm(root, { recursive: true, force: true });
  }
});
