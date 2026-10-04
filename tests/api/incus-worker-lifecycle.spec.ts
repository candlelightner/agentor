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
import { workerLifecycleGeneration } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import type { Config } from '../../orchestrator/server/utils/config';
import { usePersistentBackupPathManager } from '../../orchestrator/server/utils/services';

(globalThis as any).useLogger ??= () => ({ info() {}, error() {}, warn() {}, debug() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).reassignWorkerMappings ??= async () => {};
(globalThis as any).cleanupWorkerMappings ??= async () => {};

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

test('archived Incus deletion retains managed handles without dispatching legacy Docker path cleanup', async () => {
  await fixture(async (manager, store, calls, info) => {
    await manager.archive(info.id);
    (manager as any).incusRuntime.removeStorage = async () => { calls.push('core-storage-delete'); };
    const legacy = usePersistentBackupPathManager(), original = legacy.removeWorkerVolumes;
    legacy.removeWorkerVolumes = async () => { throw new Error('Docker cleanup must not occur for Incus'); };
    try {
      await manager.deleteArchived(info.userId, info.id);
      expect(calls).toContain('core-storage-delete');
      expect(store.get(info.userId, info.id)).toBeUndefined();
    } finally { legacy.removeWorkerVolumes = original; }
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

test('failed Incus deletion withdraws running intent before shutdown and never resurrects late-stopped compute', async () => {
  await fixture(async (manager, store, calls, info) => {
    const runtime = (manager as any).incusRuntime;
    runtime.remove = async () => {
      expect(store.get(info.userId, info.id)?.desiredRuntimeStatus).toBe('stopped');
      calls.push('attempt-remove'); throw new Error('bounded shutdown failure');
    };
    await expect(manager.remove(info.id)).rejects.toThrow('bounded shutdown failure');
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'stopped' });
    expect(manager.get(info.id)?.containerId).toBe('incus:original-uuid');
    runtime.client = { getInstance: async () => ({ status: 'Stopped', config: { 'volatile.uuid': 'original-uuid' } }) };
    runtime.matchesWorkerIdentity = async () => true;
    runtime.start = async () => { throw new Error('Failed delete must not resurrect VM'); };
    await manager.reconcileIncusWorkers();
    expect(manager.get(info.id)?.status).toBe('stopped');
    expect(calls).toEqual(['attempt-remove']);
  });
});

test('Incus delete intent persistence failure never starts shutdown or storage cleanup', async () => {
  await fixture(async (manager, store, calls, info) => {
    store.setDesiredRuntimeStatus = async () => { throw new Error('intent write failed'); };
    await expect(manager.remove(info.id)).rejects.toThrow('intent write failed');
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'running' });
    expect(calls).toEqual([]);
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

test('Incus replacement reconciles selections before preparing and refuses unseeded managed data without source', async () => {
  const manager = new ContainerManager({} as any, { incusEnabled: false } as Config);
  const backup = useBackupManager(), volumes = useManagedVolumeManager();
  const original = { config: backup.getConfig, init: volumes.init, blocked: volumes.isRecoveryBlocked,
    recreation: volumes.recreations.get, records: volumes.store.forWorker,
    adopt: volumes.adoptIncusSelections, prepare: volumes.prepare };
  let paths = ['/workspace', '/home/agent/.agent-data'];
  let attached = false;
  backup.getConfig = async () => ({ selectedPathsByWorkspace: { worker: paths } } as any);
  volumes.init = async () => {}; volumes.isRecoveryBlocked = () => false;
  volumes.recreations.get = () => undefined;
  volumes.store.forWorker = () => attached ? [{ attached: true } as any] : [];
  const adopted: string[][] = [], prepared: string[] = [];
  volumes.adoptIncusSelections = async (worker, selected) => { expect(worker.containerId).toBe('incus:original'); adopted.push(selected!); };
  volumes.prepare = async worker => { prepared.push(worker.containerId); return []; };
  try {
    await (manager as any).assertIncusPersistenceReady({ id: 'worker', userId: 'owner' });
    for (const selection of [['/'], ['/', '/opt/project'], ['/opt/project'], ['/workspace/../opt/project'], ['/workspace/possible-symlink']]) {
      paths = selection;
      await (manager as any).assertIncusPersistenceReady({ id: 'worker', userId: 'owner', containerId: 'incus:original' }, true);
    }
    expect(adopted).toEqual([['/'], ['/'], ['/opt/project'], ['/opt/project'], ['/workspace/possible-symlink']]);
    expect(prepared).toHaveLength(5);
    await expect((manager as any).assertIncusPersistenceReady({ id: 'worker', userId: 'owner' }, true)).rejects.toThrow('captured source');
    paths = ['/workspace']; attached = true;
    await expect((manager as any).assertIncusPersistenceReady({ id: 'worker', userId: 'owner' })).rejects.toThrow('Persistence is pending');
  } finally {
    backup.getConfig = original.config; volumes.init = original.init; volumes.isRecoveryBlocked = original.blocked;
    volumes.recreations.get = original.recreation; volumes.store.forWorker = original.records;
    volumes.adoptIncusSelections = original.adopt; volumes.prepare = original.prepare;
  }
});

test('missing active Incus compute refuses unknown selected paths but archive and bounded rollback preserve backup-only selections', async () => {
  const manager = new ContainerManager({} as any, { incusEnabled: false } as Config);
  const backup = useBackupManager(), volumes = useManagedVolumeManager();
  const original = { config: backup.getConfig, init: volumes.init, blocked: volumes.isRecoveryBlocked,
    recreation: volumes.recreations.get, records: volumes.store.forWorker, mounts: volumes.mounts };
  let record: any = { status: 'active' }, paths = ['/opt/unknown'], known: any[] = [];
  manager.setWorkerStore({ get: () => record } as any);
  backup.getConfig = async () => ({ selectedPathsByWorkspace: { worker: paths } } as any);
  volumes.init = async () => {}; volumes.isRecoveryBlocked = () => false;
  volumes.recreations.get = () => undefined; volumes.store.forWorker = () => known;
  volumes.mounts = async () => [];
  const check = () => (manager as any).assertIncusPersistenceReady({ id: 'worker', userId: 'owner' });
  try {
    await expect(check()).rejects.toThrow('unrecorded selected path');
    record = { status: 'archived' }; await check();
    record = { status: 'active', incusRecreation: { nonce: 'bounded' } }; await check();
    record = { status: 'active' }; known = [{ target: '/opt/unknown', attached: false }]; await check();
    known = [];
    for (const backupOnly of ['/', '/etc', '/home/agent/.agent-data', '/workspace']) {
      paths = [backupOnly]; await check();
    }
    paths = ['/workspace/possible-symlink/child']; await expect(check()).rejects.toThrow('unrecorded selected path');
  } finally {
    backup.getConfig = original.config; volumes.init = original.init; volumes.isRecoveryBlocked = original.blocked;
    volumes.recreations.get = original.recreation; volumes.store.forWorker = original.records; volumes.mounts = original.mounts;
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

test('Incus managed-storage application uses applied bootstrap and never promotes pending configuration', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    (manager as any).incusOptionsForWorker = async (_info: any, applied: boolean) => {
      expect(applied).toBe(true);
      return { id: info.id, userId: info.userId, containerName: info.containerName };
    };
    await manager.applyManagedStorageUnlocked(info.id);
    expect(calls).not.toContain('applied');
    expect(manager.get(info.id)).toMatchObject({ status: 'running', pendingRebuild: true });
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', pendingRebuild: true, desiredRuntimeStatus: 'running' });
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

test('explicit Incus recovery replaces only captured compute with applied settings and leaves desired edits pending', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    const options = await (manager as any).incusOptionsForWorker();
    options.workerJson.initScript = 'applied-init';
    (manager as any).incusOptionsForWorker = async (_worker: any, applied: boolean) => {
      expect(applied).toBe(true); calls.push('applied-options'); return options;
    };
    const start = (manager as any).incusRuntime.start;
    (manager as any).incusRuntime.start = async (...args: any[]) => {
      await store.upsert({ ...store.get(info.userId, info.id)!, pendingRebuild: true, initScript: 'newer desired init' });
      await start(...args);
    };
    const recovered = await manager.recover(info.id);
    expect(calls).not.toContain('applied');
    expect(calls.filter((call) => call.startsWith('remove-'))).toEqual(['remove-original-uuid']);
    expect(recovered).toMatchObject({ status: 'running', containerId: 'incus:replacement-uuid',
      initScript: 'newer desired init', pendingRebuild: true });
    expect(options.workerJson.initScript).toBe('applied-init');
    expect(store.get(info.userId, info.id)).toMatchObject({ desiredRuntimeStatus: 'running', pendingRebuild: true });
  });
});

test('missing Incus compute is recreated only from authoritative absence, applied settings and existing persistence', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    (manager as any).containers.delete(info.id);
    const options = await (manager as any).incusOptionsForWorker();
    (manager as any).incusOptionsForWorker = async (_worker: any, applied: boolean) => {
      expect(applied).toBe(true); calls.push('applied-options'); return options;
    };
    let lookups = 0;
    (manager as any).incusRuntime.client = { getInstance: async () => {
      lookups++; throw Object.assign(new Error('missing compute'), { statusCode: 404 });
    } };
    await manager.reconcileIncusWorkers();
    expect(lookups).toBe(2);
    expect(calls).toEqual(['persistence-preflight', 'applied-options', 'preflight', 'create', 'start', 'plugins']);
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'running', pendingRebuild: true });
    expect(manager.get(info.id)).toMatchObject({ status: 'running', containerId: 'incus:replacement-uuid', pendingRebuild: true });
  });
});

test('applied recovery requires existing Docker data even when desired configuration disables Docker', async () => {
  await recreationFixture(async (manager, store, calls, info) => {
    (manager as any).containers.delete(info.id);
    const options = await (manager as any).incusOptionsForWorker();
    options.dockerEnabled = options.environmentJson.dockerEnabled = true;
    (manager as any).resolveEnvironmentConfig = () => ({ dockerEnabled: false });
    (manager as any).incusOptionsForWorker = async (_worker: any, applied: boolean) => { expect(applied).toBe(true); return options; };
    (manager as any).incusRuntime.client = { getInstance: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); } };
    (manager as any).incusRuntime.preflightRecreation = async (applied: any, dockerRequired: boolean) => {
      expect(applied.dockerEnabled).toBe(true); expect(dockerRequired).toBe(true);
      calls.push('required-docker-data'); throw new Error('applied Docker volume missing');
    };
    await manager.reconcileIncusWorkers();
    expect(calls).toEqual(['persistence-preflight', 'required-docker-data']);
    expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
  });
});

test('missing-compute recovery never allocates from unavailable facts, missing bootstrap/data, revoked access or stopped intent', async () => {
  for (const failure of ['lookup', 'foreign', 'late-conflict', 'bootstrap', 'data', 'revoked', 'stopped']) {
    await recreationFixture(async (manager, store, calls, info) => {
      (manager as any).containers.delete(info.id);
      let lookups = 0;
      (manager as any).incusRuntime.client = { getInstance: async () => {
        lookups++;
        if (failure === 'foreign' || (failure === 'late-conflict' && lookups === 2)) return { config: {} };
        throw Object.assign(new Error('lookup'), { statusCode: failure === 'lookup' ? 503 : 404 });
      } };
      if (failure === 'bootstrap') (manager as any).incusOptionsForWorker = async () => { throw new Error('missing applied bootstrap'); };
      if (failure === 'data') (manager as any).incusRuntime.preflightRecreation = async () => { throw new Error('missing canonical volume'); };
      if (failure === 'revoked' || failure === 'stopped') await store.upsert({ ...store.get(info.userId, info.id)!,
        hostMountsRevoked: failure === 'revoked', desiredRuntimeStatus: failure === 'stopped' ? 'stopped' : 'running' });
      await manager.reconcileIncusWorkers();
      expect(calls.some((call) => ['create', 'start', 'applied', 'remove-original-uuid'].includes(call))).toBe(false);
      expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
      expect(store.get(info.userId, info.id)?.pendingRebuild).toBe(true);
      expect(manager.get(info.id)).toBeUndefined();
    });
  }
});

test('Incus inventory keeps missing/foreign workers visible without UUID authority and never adopts or deletes orphans', async () => {
  await fixture(async (manager, store, calls, info) => {
    (manager as any).config.incusEndpoint = 'https://test.invalid';
    (manager as any).dockerService = { listContainers: async () => [] };
    const runtime = (manager as any).incusRuntime;
    runtime.client = { listInstances: async () => [
      { name: info.containerName, config: { 'user.agentor.id': info.id, foreign: 'true' } },
      { name: 'agentor-worker-orphan', config: { 'user.agentor.id': 'orphan' } },
    ] };
    runtime.matchesWorkerIdentity = async (instance: any) => !instance.config.foreign;
    await manager.sync();
    expect(manager.get(info.id)).toMatchObject({ status: 'unknown', containerId: info.containerName,
      runtimeDiagnostic: { code: 'INCUS_COMPUTE_UNVERIFIED' } });
    expect(manager.get('orphan')).toBeUndefined(); expect(calls).toEqual([]);
    expect(store.get(info.userId, info.id)?.pendingRebuild).toBe(true);
    runtime.client.listInstances = async () => [{ name: info.containerName, status: 'Running', config: { 'user.agentor.id': info.id } }];
    await manager.sync();
    expect(manager.get(info.id)).toMatchObject({ status: 'unknown', containerId: info.containerName });
    await store.archive(info.userId, info.id);
    runtime.client.listInstances = async () => [{ name: info.containerName, config: { 'user.agentor.id': info.id } }];
    await manager.sync();
    expect(manager.get(info.id)).toBeUndefined(); expect(calls).toEqual([]);
    expect(store.get(info.userId, info.id)?.status).toBe('archived');
  });
});

test('missing-compute diagnostic cannot be mistaken for captured incarnation or bypass foreign/API checks', async () => {
  for (const failure of ['foreign', 'unavailable']) await recreationFixture(async (manager, store, calls, info) => {
    (manager as any).config.incusEndpoint = 'https://test.invalid';
    (manager as any).dockerService = { listContainers: async () => [] };
    (manager as any).incusRuntime.client = { listInstances: async () => [], getInstance: async () => {
      if (failure === 'foreign') return { config: {} };
      throw Object.assign(new Error('unavailable'), { statusCode: 503 });
    } };
    await manager.sync();
    const unavailable = manager.get(info.id)!;
    expect(unavailable.containerId).toBe(info.containerName); expect(unavailable.status).toBe('unknown');
    await manager.reconcileIncusWorkers();
    expect(manager.get(info.id)?.runtimeDiagnostic?.operation).toBe('Incus missing compute recovery');
    await expect(manager.recover(info.id)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
  });
});

test('uncaptured Incus diagnostic handles cannot stop, restart or delete same-name compute or persistence', async () => {
  for (const action of ['stop', 'restart', 'remove'] as const) await fixture(async (manager, store, calls, info) => {
    info.containerId = info.containerName; info.status = 'unknown';
    const runtime = (manager as any).incusRuntime;
    runtime.stop = runtime.start = runtime.remove = runtime.removeStorage = async () => { calls.push('unsafe-mutation'); };
    await expect(manager[action](info.id)).rejects.toThrow('incarnation is unavailable');
    expect(calls).toEqual([]);
    expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'running' });
    expect(manager.get(info.id)?.status).toBe('unknown');
  });
});

async function reconciliationFixture(run: (manager: ContainerManager, store: WorkerStore, calls: string[], info: any, state: any) => Promise<void>) {
  await fixture(async (manager, store, calls, info) => {
    const state = { status: 'Running', bootId: 'first-boot', provisioned: true, serviceReady: true };
    const runtime = (manager as any).incusRuntime;
    runtime.client = { getInstance: async () => ({ status: state.status, config: { 'volatile.uuid': 'original-uuid' } }) };
    runtime.matchesWorkerIdentity = async () => true;
    runtime.inspectGuestReadiness = async () => ({ ...state });
    runtime.start = async (_opts: any, uuid: string, recovery: any) => {
      expect(uuid).toBe('original-uuid'); expect(recovery.leaveRunningOnFailure).toBe(true);
      calls.push('repair'); state.status = 'Running'; state.provisioned = state.serviceReady = true;
    };
    (manager as any).incusOptionsForWorker = async (_worker: any, applied: boolean) => {
      expect(applied).toBe(true); calls.push('applied-options'); return {};
    };
    (manager as any).reconcileWorkerPlugins = async () => {};
    const config = useWorkerConfigStore(), mark = config.markApplied;
    config.markApplied = async () => { throw new Error('Reboot recovery must not promote desired settings'); };
    try { await run(manager, store, calls, info, state); }
    finally { config.markApplied = mark; }
  });
}

test('interrupted-recreation reconciliation merges rollback without overwriting pending/revoked settings', async () => {
  for (const outcome of ['active', 'archived'] as const) await fixture(async (manager, store, calls, info) => {
    const marker = { nonce: 'operation-nonce', originalIncarnation: 'original-uuid' };
    await store.upsert({ ...store.get(info.userId, info.id)!, status: 'archived', incusRecreation: marker });
    (manager as any).incusRuntime.rollbackRecreation = async () => {
      calls.push('rollback');
      await store.upsert({ ...store.get(info.userId, info.id)!, initScript: 'newer desired',
        pendingRebuild: true, hostMountsRevoked: true, hardwareDevicesRevoked: true });
      return { status: outcome, incarnation: outcome === 'active' ? 'original-uuid' : undefined };
    };
    // Ordinary convergence must not repair or promote a rolled-back worker.
    (manager as any).incusRuntime.client = { getInstance: async () => ({ status: 'Stopped', config: { 'volatile.uuid': 'original-uuid' } }) };
    (manager as any).incusRuntime.matchesWorkerIdentity = async () => true;
    await manager.reconcileIncusWorkers();
    expect(store.get(info.userId, info.id)).toMatchObject({ status: outcome, desiredRuntimeStatus: 'stopped',
      pendingRebuild: true, initScript: 'newer desired', hostMountsRevoked: true, hardwareDevicesRevoked: true });
    expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
    expect(calls).toEqual(['persistence-preflight', 'rollback']);
    if (outcome === 'active') expect(manager.get(info.id)).toMatchObject({ status: 'stopped', containerId: 'incus:original-uuid' });
    else expect(manager.get(info.id)).toBeUndefined();
  });
});

test('interrupted-recreation persistence or lookup failure retains marker and runtime for safe retry', async () => {
  for (const initial of [false, true]) for (const failure of ['persist', 'lookup']) await fixture(async (manager, store, _calls, info) => {
    const marker = initial ? { nonce: 'operation-nonce', initialCreate: true as const, replacementIncarnation: 'original-uuid' }
      : { nonce: 'operation-nonce', originalIncarnation: 'original-uuid' };
    await store.upsert({ ...store.get(info.userId, info.id)!, incusRecreation: marker });
    (manager as any).incusRuntime.rollbackRecreation = async () => {
      if (failure === 'lookup') throw new Error('API unavailable');
      return { status: 'archived' };
    };
    const transition = store.transitionIncusRecreation.bind(store);
    if (failure === 'persist') store.transitionIncusRecreation = async () => { throw new Error('disk write failed'); };
    await manager.reconcileIncusWorkers();
    expect(store.get(info.userId, info.id)?.incusRecreation).toEqual(marker);
    expect(manager.get(info.id)?.containerId).toBe('incus:original-uuid');
    if (failure === 'persist') {
      store.transitionIncusRecreation = transition;
      await manager.reconcileIncusWorkers();
      expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
      expect(store.get(info.userId, info.id)?.status).toBe('archived');
    }
  });
});

test('queued rollback cannot clear a changed initial-create discriminator', async () => {
  await fixture(async (_manager, store, _calls, info) => {
    const marker = { nonce: 'same-nonce', initialCreate: true as const };
    await store.upsert({ ...store.get(info.userId, info.id)!, incusRecreation: marker });
    await store.upsert({ ...store.get(info.userId, info.id)!, incusRecreation: { nonce: marker.nonce } });
    await expect(store.transitionIncusRecreation(info.userId, info.id,
      { status: 'archived', desiredRuntimeStatus: 'stopped', incusRecreation: undefined }, undefined, marker))
      .rejects.toThrow('marker changed');
    expect(store.get(info.userId, info.id)?.incusRecreation).toEqual({ nonce: marker.nonce });
  });
});

test('queued recreation rollback cannot clear a changed marker or resurrect deleted authority', async () => {
  await fixture(async (_manager, store, _calls, info) => {
    const original = { nonce: 'old-nonce', originalIncarnation: 'original-uuid' };
    const change = { status: 'archived' as const, desiredRuntimeStatus: 'stopped' as const, incusRecreation: undefined };
    await store.upsert({ ...store.get(info.userId, info.id)!, incusRecreation: original });
    const changed = { ...original, nonce: 'new-nonce' };
    const results = await Promise.allSettled([
      store.upsert({ ...store.get(info.userId, info.id)!, incusRecreation: changed }),
      store.transitionIncusRecreation(info.userId, info.id, change, undefined, original),
    ]);
    expect(results[1]!.status).toBe('rejected');
    expect(store.get(info.userId, info.id)?.incusRecreation).toEqual(changed);
    await store.delete(info.userId, info.id);
    await expect(store.transitionIncusRecreation(info.userId, info.id, change, undefined, changed)).rejects.toThrow('authority');
    expect(store.get(info.userId, info.id)).toBeUndefined();
  });
});

async function initialCreationFixture(run: (manager: ContainerManager, store: WorkerStore, calls: string[], options: any) => Promise<void>) {
  await fixture(async (manager, store, calls, info) => {
    (manager as any).config.incusEnabled = true;
    (manager as any).resolveGitIdentity = async () => ({ gitName: '', gitEmail: '' });
    (manager as any).resolveAuthorizedHostMounts = async () => undefined;
    (manager as any).resolveHardwareDeviceAccess = async () => undefined;
    (manager as any).resolveUserEnvAndBinds = async () => ({ userEnv: zeroUserEnvVars(info.userId), credentialBinds: [], groupSecrets: [] });
    (manager as any).resolveEnvironmentConfig = () => ({ dockerEnabled: false,
      environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '', exposeApis: {} },
      capabilitiesJson: [], instructionsJson: [] });
    const runtime = (manager as any).incusRuntime;
    const state: any = {};
    runtime.create = async (options: any) => {
      state.options = options;
      expect(options.start).toBe(false);
      expect(store.get(options.userId, options.id)?.incusRecreation?.nonce).toBe(options.recreationNonce);
      expect(store.get(options.userId, options.id)?.incusRecreation?.initialCreate).toBe(true);
      calls.push('create-stopped');
      return { config: { 'volatile.uuid': 'initial-uuid', 'user.agentor.recreation': options.recreationNonce } };
    };
    runtime.matchesWorkerIdentity = async () => true;
    runtime.start = async (options: any, uuid: string) => {
      expect(uuid).toBe('initial-uuid');
      expect(store.get(options.userId, options.id)?.incusRecreation?.replacementIncarnation).toBe(uuid);
      calls.push('start-captured');
    };
    runtime.rollbackRecreation = async (_owner: any, marker: any) => {
      expect(marker.replacementIncarnation).toBe('initial-uuid'); expect(marker.nonce).toBe(state.options.recreationNonce);
      calls.push('rollback-captured'); return { status: 'archived' };
    };
    runtime.remove = runtime.removeStorage = async () => { throw new Error('Initial failure must not use name-only/data cleanup'); };
    const config = useWorkerConfigStore();
    const original = { desired: config.resolveDesiredRevision, mark: config.markApplied, remove: config.remove };
    config.resolveDesiredRevision = async () => ({ revision: undefined, values: [] });
    config.markApplied = async () => { calls.push('applied'); };
    config.remove = async () => { calls.push('remove-provisional-config'); };
    state.owner = info.userId;
    try { await run(manager, store, calls, state); }
    finally { config.resolveDesiredRevision = original.desired; config.markApplied = original.mark; config.remove = original.remove; }
  });
}

test('initial Incus create captures operation/UUID before start and merges pending edits without a final stale upsert', async () => {
  await initialCreationFixture(async (manager, store, calls, state) => {
    const runtime = (manager as any).incusRuntime, start = runtime.start;
    runtime.start = async (options: any, uuid: string) => {
      await start(options, uuid);
      await store.upsert({ ...store.get(options.userId, options.id)!, pendingRebuild: true, initScript: 'newer desired' });
    };
    const created = await (manager as any).createForOwner({ userId: state.owner, displayName: 'new' });
    expect(calls).toEqual(['create-stopped', 'start-captured', 'applied']);
    expect(created).toMatchObject({ containerId: 'incus:initial-uuid', status: 'running', pendingRebuild: true, initScript: 'newer desired' });
    expect(store.get(created.userId, created.id)?.incusRecreation).toBeUndefined();
    expect(store.get(created.userId, created.id)?.desiredRuntimeStatus).toBe('running');
  });
});

test('initial Incus creation fences concurrent inventory during boot and after a delayed response', async () => {
  for (const delayedInventory of [false, true]) await initialCreationFixture(async (manager, store, _calls, state) => {
    const runtime = (manager as any).incusRuntime;
    (manager as any).config.incusEndpoint = 'https://incus.invalid';
    (manager as any).dockerService = { listContainers: async () => [] };
    let releaseBoot!: () => void, bootEntered!: () => void;
    const boot = new Promise<void>((resolve) => { releaseBoot = resolve; });
    const entered = new Promise<void>((resolve) => { bootEntered = resolve; });
    const start = runtime.start;
    runtime.start = async (...args: any[]) => { await start(...args); bootEntered(); await boot; };
    let releaseInventory!: () => void, inventoryEntered!: () => void;
    const inventory = new Promise<void>((resolve) => { releaseInventory = resolve; });
    const listed = new Promise<void>((resolve) => { inventoryEntered = resolve; });
    runtime.client = { listInstances: async () => {
      // Capture the still-provisional record before completion clears its marker.
      const options = state.options;
      const instance = { name: options.containerName, status: 'Running', config: {
        'user.agentor.id': options.id, 'volatile.uuid': 'initial-uuid',
      } };
      inventoryEntered();
      if (delayedInventory) await inventory;
      return [instance];
    } };
    const creating = manager.create({ userId: state.owner, displayName: 'concurrent inventory' });
    await entered;
    const refreshing = manager.sync(); await listed;
    if (!delayedInventory) await refreshing;
    releaseBoot();
    const created = await creating;
    if (delayedInventory) { releaseInventory(); await refreshing; }
    expect(created.status).toBe('running');
    expect(manager.get(created.id)).toBe(created);
    expect(manager.get(created.id)?.status).toBe('running');
    expect(store.get(created.userId, created.id)?.incusRecreation).toBeUndefined();
    expect(store.get(created.userId, created.id)?.desiredRuntimeStatus).toBe('running');
    expect((manager as any).assertRunning(created.id)).toBe(created);
  });
});

test('initial Incus lost/conflict response or unproven identity retains marker, compute and persistence', async () => {
  for (const failure of ['conflict', 'lost-response', 'nonce', 'uuid', 'owner']) {
    await initialCreationFixture(async (manager, store, calls, state) => {
      const runtime = (manager as any).incusRuntime, create = runtime.create;
      runtime.create = async (options: any) => {
        const instance = await create(options);
        if (failure === 'conflict' || failure === 'lost-response') throw Object.assign(new Error('ambiguous create'), { statusCode: failure === 'conflict' ? 409 : 503 });
        if (failure === 'nonce') instance.config['user.agentor.recreation'] = 'wrong';
        if (failure === 'uuid') delete instance.config['volatile.uuid'];
        return instance;
      };
      if (failure === 'owner') runtime.matchesWorkerIdentity = async () => false;
      await expect((manager as any).createForOwner({ userId: state.owner })).rejects.toMatchObject({ code: 'WORKER_CREATE_CONTAINER_RETAINED' });
      const record = store.get(state.owner, state.options.id)!;
      expect(record.incusRecreation?.nonce).toBe(state.options.recreationNonce);
      expect(record.desiredRuntimeStatus).toBe('stopped');
      expect(calls).toEqual(['create-stopped']);
      expect(manager.get(record.id)?.status).toBe('error');
    });
  }
});

test('initial Incus UUID persistence/start/applied/final persistence failures roll back only proven compute and archive all data', async () => {
  for (const failure of ['uuid-persist', 'start', 'applied', 'completion']) {
    await initialCreationFixture(async (manager, store, calls, state) => {
      const runtime = (manager as any).incusRuntime;
      const transition = store.transitionIncusRecreation.bind(store);
      store.transitionIncusRecreation = async (...args) => {
        const change = args[2];
        if ((failure === 'uuid-persist' && change.incusRecreation?.replacementIncarnation) ||
            (failure === 'completion' && change.status === 'active' && !change.incusRecreation)) throw new Error('injected metadata failure');
        return transition(...args);
      };
      if (failure === 'start') runtime.start = async () => { throw new Error('injected start failure'); };
      const config = useWorkerConfigStore(), mark = config.markApplied;
      if (failure === 'applied') config.markApplied = async () => { throw new Error('injected applied failure'); };
      try {
        await expect((manager as any).createForOwner({ userId: state.owner })).rejects.toThrow('injected');
        const record = store.get(state.owner, state.options.id)!;
        expect(record).toMatchObject({ status: 'archived', desiredRuntimeStatus: 'stopped' });
        expect(record.incusRecreation).toBeUndefined();
        expect(calls).toContain('rollback-captured');
        expect(manager.get(record.id)).toBeUndefined();
      } finally { config.markApplied = mark; }
    });
  }
});

test('initial Incus pre-request failure cleans only provisional application metadata', async () => {
  await initialCreationFixture(async (manager, store, calls, state) => {
    useWorkerConfigStore().resolveDesiredRevision = async () => { throw new Error('injected configuration failure'); };
    await expect((manager as any).createForOwner({ userId: state.owner })).rejects.toThrow('injected configuration failure');
    expect(calls).toEqual(['remove-provisional-config']);
    expect(store.list()).toHaveLength(1); // only the independent pre-existing fixture
  });
});

test('initial Incus nonce-persistence failure makes no runtime request and removes only provisional metadata', async () => {
  await initialCreationFixture(async (manager, store, calls, state) => {
    store.transitionIncusRecreation = async () => { throw new Error('injected first marker failure'); };
    await expect((manager as any).createForOwner({ userId: state.owner })).rejects.toThrow('injected first marker failure');
    expect(calls).toEqual(['remove-provisional-config']);
    expect(store.list()).toHaveLength(1);
  });
});

test('initial captured rollback/removal or archive persistence failure retains recovery identity and configuration', async () => {
  for (const failure of ['rollback', 'archive']) await initialCreationFixture(async (manager, store, calls, state) => {
    const runtime = (manager as any).incusRuntime;
    runtime.start = async () => { throw new Error('injected startup failure'); };
    if (failure === 'rollback') runtime.rollbackRecreation = async () => { throw new Error('unknown removal outcome'); };
    if (failure === 'archive') {
      const transition = store.transitionIncusRecreation.bind(store);
      store.transitionIncusRecreation = async (...args) => {
        if (args[2].status === 'archived') throw new Error('archive disk failure');
        return transition(...args);
      };
    }
    await expect((manager as any).createForOwner({ userId: state.owner })).rejects.toMatchObject({ code: 'WORKER_CREATE_ROLLBACK_INCOMPLETE' });
    expect(store.get(state.owner, state.options.id)?.incusRecreation).toMatchObject({
      nonce: state.options.recreationNonce, replacementIncarnation: 'initial-uuid' });
    expect(manager.get(state.options.id)).toMatchObject({ status: 'error', containerId: 'incus:initial-uuid' });
    expect(calls).not.toContain('remove-provisional-config'); expect(calls).not.toContain('applied');
  });
});

test('healthy Incus reconciliation preserves VM/services and terminal lifecycle generation', async () => {
  await reconciliationFixture(async (manager, _store, calls, info) => {
    const generation = workerLifecycleGeneration(info.id);
    await manager.reconcileIncusWorkers();
    expect(calls).toEqual([]); expect(info.status).toBe('running'); expect(info.pendingRebuild).toBe(true);
    expect(workerLifecycleGeneration(info.id)).toBe(generation);
  });
});

test('positively missing Incus provisioning/service recovers applied settings without reboot or pending promotion', async () => {
  for (const missing of ['provisioned', 'serviceReady']) await reconciliationFixture(async (manager, store, calls, info, state) => {
    state[missing] = false;
    await manager.reconcileIncusWorkers();
    expect(calls).toEqual(['applied-options', 'repair']); expect(info.status).toBe('running');
    expect(state.bootId).toBe('first-boot'); expect(info.pendingRebuild).toBe(true);
    expect(store.get(info.userId, info.id)?.pendingRebuild).toBe(true);
  });
});

test('Incus readiness timeout, foreign identity and revoked access never cause start/stop/reboot', async () => {
  for (const failure of ['timeout', 'foreign', 'revoked']) await reconciliationFixture(async (manager, store, calls, info) => {
    if (failure === 'timeout') (manager as any).incusRuntime.inspectGuestReadiness = async () => { throw new Error('guest timed out'); };
    if (failure === 'foreign') (manager as any).incusRuntime.matchesWorkerIdentity = async () => false;
    if (failure === 'revoked') await store.upsert({ ...store.get(info.userId, info.id)!, hostMountsRevoked: true });
    await manager.reconcileIncusWorkers();
    expect(calls).toEqual([]); expect(manager.get(info.id)?.status).toBe('unknown');
  });
});

test('Incus boot changes and repair failures defer convergence without stopping a running guest', async () => {
  for (const failure of ['reboot', 'repair']) await reconciliationFixture(async (manager, _store, calls, info, state) => {
    state.provisioned = false;
    const start = (manager as any).incusRuntime.start;
    (manager as any).incusRuntime.start = async (...args: any[]) => {
      if (failure === 'repair') throw new Error('provider unavailable');
      await start(...args); state.bootId = 'newer-boot';
    };
    await manager.reconcileIncusWorkers();
    expect(calls).not.toContain('remove-compute'); expect(state.status).toBe('Running');
    expect(info.status).toBe('unknown'); expect(info.pendingRebuild).toBe(true);
  });
});

test('real production-manager archive retains canonical volumes, source and pending settings without Docker', async () => {
  test.skip(process.env.INCUS_ARCHIVE_TEST !== 'true' && process.env.INCUS_RECREATION_TEST !== 'true' &&
    process.env.INCUS_REBOOT_TEST !== 'true' && process.env.INCUS_RECREATION_RECOVERY_TEST !== 'true' &&
    process.env.INCUS_MISSING_RECOVERY_TEST !== 'true' && process.env.INCUS_INITIAL_CREATE_TEST !== 'true', 'Explicit disposable Incus lifecycle acceptance');
  test.setTimeout(900_000);
  const root = await mkdtemp(join(tmpdir(), 'agentor-incus-archive-live-'));
  const config = { dataDir: root, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase6-candidate',
    incusInternalGatewayUrl: 'http://10.159.68.1:3000', containerPrefix: 'agentor-worker', workerImage: 'agentor-worker:latest', workerImagePrefix: '' } as Config;
  const store = new WorkerStore(root); await store.init();
  let cleanupStore = store;
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
    let info = await (manager as any).createForOwner({ userId: 'archive-live-owner', displayName: 'archive acceptance',
      workerConfiguration: process.env.INCUS_REBOOT_TEST === 'true' || process.env.INCUS_MISSING_RECOVERY_TEST === 'true'
        ? { secrets: [{ key: 'BOOT_SECRET', value: 'applied' }] } : undefined });
    const created = await runtime.client.exec(info.containerName, ['sh', '-ec',
      'echo retained-workspace > /workspace/archive-fixture; echo retained-agents > /home/agent/.agent-data/archive-fixture']);
    expect(created.returnCode).toBe(0);
    expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
    if (process.env.INCUS_INITIAL_CREATE_TEST === 'true') {
      await manager.archive(info.id); // never allocate two root disks at once
      const create = runtime.create.bind(runtime);
      runtime.create = async (options, existing) => {
        await create(options, existing);
        throw Object.assign(new Error('accepted create response lost'), { statusCode: 503 });
      };
      try {
        await expect((manager as any).createForOwner({ userId: info.userId, displayName: 'lost initial response' }))
          .rejects.toMatchObject({ code: 'WORKER_CREATE_CONTAINER_RETAINED' });
      } finally { runtime.create = create; }
      const lost = store.list().find((record) => record.id !== info.id)!;
      const lostName = manager.buildContainerName(lost.id);
      expect(lost.incusRecreation?.replacementIncarnation).toBeUndefined();
      expect((await runtime.client.getInstance(lostName)).config['user.agentor.recreation']).toBe(lost.incusRecreation?.nonce);
      expect((await runtime.client.getInstanceState(lostName)).status).toBe('Stopped');
      const reloadedStore = new WorkerStore(root); await reloadedStore.init();
      const reloaded = new ContainerManager({ listContainers: async () => [] } as any, config);
      reloaded.setWorkerStore(reloadedStore); reloaded.setIncusRuntime(runtime);
      (reloaded as any).assertOwnerExists = async () => {};
      await reloaded.sync(); await reloaded.reconcileIncusWorkers();
      await expect(runtime.client.getInstance(lostName)).rejects.toMatchObject({ statusCode: 404 });
      expect(reloadedStore.get(lost.userId, lost.id)).toMatchObject({ status: 'archived', desiredRuntimeStatus: 'stopped' });
      expect(reloadedStore.get(lost.userId, lost.id)?.incusRecreation).toBeUndefined();
      // Captured create followed by startup failure uses immediate proven
      // rollback, retaining initial volumes/config instead of name cleanup.
      manager.setWorkerStore(reloadedStore);
      cleanupStore = reloadedStore;
      const start = runtime.start.bind(runtime);
      runtime.start = async () => { throw new Error('injected initial startup failure'); };
      try {
        await expect((manager as any).createForOwner({ userId: info.userId, displayName: 'captured initial failure' }))
          .rejects.toThrow('injected initial startup failure');
      } finally { runtime.start = start; }
      const failed = reloadedStore.list().find((record) => record.id !== info.id && record.id !== lost.id)!;
      expect(failed.status).toBe('archived'); expect(failed.incusRecreation).toBeUndefined();
      const failedName = manager.buildContainerName(failed.id);
      await expect(runtime.client.getInstance(failedName)).rejects.toMatchObject({ statusCode: 404 });
      for (const worker of [lost, failed]) for (const role of ['workspace', 'agents']) {
        const volume = await runtime.client.getCustomVolume(config.incusStoragePool, `${manager.buildContainerName(worker.id)}-${role}`);
        expect(volume.config['user.agentor.id']).toBe(worker.id); expect(volume.used_by ?? []).toEqual([]);
      }
      // A first create can fail before allocation, or after only workspace
      // allocation. Reload/reconcile must preserve partial state and config,
      // not leave an unrecoverable rebuild-style marker or fabricate roots.
      for (const allocation of ['none', 'workspace']) {
        let attemptedOptions: any;
        const createVolume = runtime.client.createCustomVolume.bind(runtime.client);
        if (allocation === 'workspace') runtime.client.createCustomVolume = async (pool, volume) => {
          if (volume.name.endsWith('-agents')) throw new Error('injected partial allocation');
          return createVolume(pool, volume);
        };
        runtime.create = async (options, existing) => {
          attemptedOptions = options;
          if (allocation === 'none') throw new Error('injected preallocation failure');
          return create(options, existing);
        };
        try {
          await expect((manager as any).createForOwner({ userId: info.userId, displayName: `initial ${allocation}`,
            workerConfiguration: { secrets: [{ key: 'PARTIAL_SECRET', value: `retained-${allocation}` }] } }))
            .rejects.toMatchObject({ code: 'WORKER_CREATE_CONTAINER_RETAINED' });
        } finally { runtime.create = create; runtime.client.createCustomVolume = createVolume; }
        expect(cleanupStore.get(info.userId, attemptedOptions.id)?.incusRecreation?.initialCreate).toBe(true);
        const partialStore = new WorkerStore(root); await partialStore.init();
        const recovery = new ContainerManager({ listContainers: async () => [] } as any, config);
        recovery.setWorkerStore(partialStore); recovery.setIncusRuntime(runtime);
        (recovery as any).assertOwnerExists = async () => {};
        await recovery.sync(); await recovery.reconcileIncusWorkers();
        expect(partialStore.get(info.userId, attemptedOptions.id)).toMatchObject({
          status: 'archived', desiredRuntimeStatus: 'stopped', displayName: `initial ${allocation}` });
        expect(partialStore.get(info.userId, attemptedOptions.id)?.incusRecreation).toBeUndefined();
        expect(await useWorkerConfigStore().resolveValues(info.userId, attemptedOptions.id))
          .toContainEqual(expect.objectContaining({ key: 'PARTIAL_SECRET', value: `retained-${allocation}` }));
        await expect(runtime.client.getInstance(attemptedOptions.containerName)).rejects.toMatchObject({ statusCode: 404 });
        await expect(runtime.preflightRecreation(attemptedOptions)).rejects.toThrow('source is missing');
        await expect(runtime.client.getCustomVolume(config.incusStoragePool, `${attemptedOptions.containerName}-agents`))
          .rejects.toMatchObject({ statusCode: 404 });
        if (allocation === 'workspace') {
          const workspace = await runtime.client.getCustomVolume(config.incusStoragePool, `${attemptedOptions.containerName}-workspace`);
          expect(workspace.config['user.agentor.id']).toBe(attemptedOptions.id); expect(workspace.used_by ?? []).toEqual([]);
        } else await expect(runtime.client.getCustomVolume(config.incusStoragePool, `${attemptedOptions.containerName}-workspace`))
          .rejects.toMatchObject({ statusCode: 404 });
        manager.setWorkerStore(partialStore); cleanupStore = partialStore;
      }
      return;
    }
    if (process.env.INCUS_MISSING_RECOVERY_TEST === 'true') {
      info.pendingRebuild = true; info.initScript = 'touch /workspace/unapplied-recovery-init';
      await store.upsert((manager as any).containerInfoToWorkerRecord(info));
      await useWorkerConfigStore().replace(info.userId, info.id, [{ kind: 'secret', key: 'BOOT_SECRET', value: 'unapplied' }]);
      const originalHandle = info.containerId;
      info = await manager.recover(info.id);
      expect(info.containerId).not.toBe(originalHandle); expect(info.pendingRebuild).toBe(true);
      const checkApplied = async (target: any) => {
        expect((await runtime.client.exec(target.containerName, ['bash', '-ec',
          'source /run/agentor/worker.env; test "$(printf %s "$WORKER_LOCAL_ENV" | base64 -d | jq -r \'.[] | select(.key == "BOOT_SECRET") | .value\')" = applied; test ! -e /workspace/unapplied-recovery-init; test "$(cat /workspace/archive-fixture)" = retained-workspace; test "$(cat /home/agent/.agent-data/archive-fixture)" = retained-agents'])).returnCode).toBe(0);
      };
      await checkApplied(info);
      const removedHandle = info.containerId;
      await runtime.remove(info, info.containerId.slice(6));
      const reloadedStore = new WorkerStore(root); await reloadedStore.init();
      const reloaded = new ContainerManager({ listContainers: async () => [] } as any, config);
      reloaded.setWorkerStore(reloadedStore); reloaded.setIncusRuntime(runtime);
      (reloaded as any).assertOwnerExists = async () => {};
      (reloaded as any).resolveAuthorizedHostMounts = async () => undefined;
      (reloaded as any).resolveHardwareDeviceAccess = async () => undefined;
      (reloaded as any).resolveUserEnvAndBinds = (manager as any).resolveUserEnvAndBinds;
      await reloaded.sync(); expect(reloaded.get(info.id)).toMatchObject({ status: 'unknown', containerId: info.containerName });
      await reloaded.reconcileIncusWorkers();
      const recovered = reloaded.get(info.id)!;
      expect(recovered.status).toBe('running'); expect(recovered.containerId).not.toBe(removedHandle);
      expect(recovered.pendingRebuild).toBe(true);
      expect(reloadedStore.get(info.userId, info.id)).toMatchObject({ status: 'active', pendingRebuild: true, desiredRuntimeStatus: 'running' });
      expect((await useWorkerConfigStore().resolveValues(info.userId, info.id))[0]!.value).toBe('unapplied');
      await checkApplied(recovered);
      return; // finally cleans only this test's newly-created runtime/volumes
    }
    if (process.env.INCUS_RECREATION_RECOVERY_TEST === 'true') {
      const originalUuid = info.containerId.slice(6);
      const marker = { nonce: 'live-interrupted-recreation', originalIncarnation: originalUuid };
      await store.upsert({ ...store.get(info.userId, info.id)!, incusRecreation: marker, pendingRebuild: true,
        initScript: 'touch /workspace/pending-recovery-init' });
      await manager.reconcileIncusWorkers();
      expect((await runtime.client.getInstance(info.containerName)).config['volatile.uuid']).toBe(originalUuid);
      expect((await runtime.client.getInstanceState(info.containerName)).status).toBe('Stopped');
      expect(store.get(info.userId, info.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'stopped', pendingRebuild: true });
      expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
      // Simulate crash after original removal and a successful create whose
      // response/UUID never reached the durable marker.
      const options = await (manager as any).incusOptionsForWorker(manager.get(info.id), false);
      const existing = await runtime.preflightRecreation(options);
      await runtime.remove(info, originalUuid);
      const replacement = await runtime.create({ ...options, start: false, recreationNonce: marker.nonce }, existing);
      await store.upsert({ ...store.get(info.userId, info.id)!, incusRecreation: { ...marker, nonce: 'wrong-nonce' } });
      await manager.reconcileIncusWorkers();
      expect((await runtime.client.getInstance(info.containerName)).config['volatile.uuid']).toBe(replacement.config['volatile.uuid']);
      expect(store.get(info.userId, info.id)?.incusRecreation?.nonce).toBe('wrong-nonce');
      await store.upsert({ ...store.get(info.userId, info.id)!, incusRecreation: marker });
      const reloadedStore = new WorkerStore(root); await reloadedStore.init();
      const reloaded = new ContainerManager({ listContainers: async () => [] } as any, config);
      reloaded.setWorkerStore(reloadedStore); reloaded.setIncusRuntime(runtime);
      (reloaded as any).assertOwnerExists = async () => {};
      await reloaded.sync(); await reloaded.reconcileIncusWorkers();
      await expect(runtime.client.getInstance(info.containerName)).rejects.toMatchObject({ statusCode: 404 });
      expect(reloadedStore.get(info.userId, info.id)).toMatchObject({ status: 'archived', desiredRuntimeStatus: 'stopped',
        pendingRebuild: true, initScript: 'touch /workspace/pending-recovery-init' });
      expect(reloadedStore.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
      // Simulate response loss after deletion: absent compute must converge
      // only through the existing, identity-verified canonical storage/source.
      await store.upsert({ ...reloadedStore.get(info.userId, info.id)!, incusRecreation: marker });
      await manager.reconcileIncusWorkers();
      expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
      expect(store.get(info.userId, info.id)?.pendingRebuild).toBe(true);
      info = await manager.unarchive(info.userId, info.id);
      expect((await runtime.client.exec(info.containerName, ['sh', '-ec',
        'test "$(cat /workspace/archive-fixture)" = retained-workspace; test "$(cat /home/agent/.agent-data/archive-fixture)" = retained-agents'])).returnCode).toBe(0);
    }
    if (process.env.INCUS_REBOOT_TEST === 'true') {
      const incarnation = info.containerId.slice(6);
      let original = await runtime.inspectGuestReadiness(info, incarnation);
      expect(original.provisioned && original.serviceReady).toBe(true);
      const servicePid = await runtime.client.exec(info.containerName, ['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service']);
      const reloadedStore = new WorkerStore(root); await reloadedStore.init();
      const reloaded = new ContainerManager({ listContainers: async () => [] } as any, config);
      reloaded.setWorkerStore(reloadedStore); reloaded.setIncusRuntime(new IncusWorkerRuntime(config));
      await reloaded.sync(); await reloaded.reconcileWorkers();
      expect(reloaded.get(info.id)?.status).toBe('running');
      expect((await runtime.client.exec(info.containerName, ['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service'])).stdout).toBe(servicePid.stdout);
      expect((await runtime.inspectGuestReadiness(info, incarnation)).bootId).toBe(original.bootId);
      const generation = workerLifecycleGeneration(info.id);
      await manager.reconcileIncusWorkers();
      expect(workerLifecycleGeneration(info.id)).toBe(generation);
      expect((await runtime.inspectGuestReadiness(info, incarnation)).bootId).toBe(original.bootId);
      info.pendingRebuild = true; info.initScript = 'touch /workspace/unapplied-init';
      await store.upsert((manager as any).containerInfoToWorkerRecord(info));
      await useWorkerConfigStore().replace(info.userId, info.id, [{ kind: 'secret', key: 'BOOT_SECRET', value: 'unapplied' }]);
      // Simulate an out-of-band VM stop, not an Agentor user stop: durable
      // running intent must survive and recover the applied, not pending,
      // configuration on the same captured instance.
      const stoppedBootId = original.bootId;
      await runtime.stop(info, incarnation);
      expect(store.get(info.userId, info.id)?.desiredRuntimeStatus).toBe('running');
      expect((await runtime.client.getInstanceState(info.containerName)).status).toBe('Stopped');
      await manager.reconcileIncusWorkers();
      expect(info).toMatchObject({ status: 'running', pendingRebuild: true, containerId: `incus:${incarnation}` });
      original = await runtime.inspectGuestReadiness(info, incarnation);
      expect(original.provisioned && original.serviceReady).toBe(true);
      expect(original.bootId).not.toBe(stoppedBootId);
      expect((await runtime.client.exec(info.containerName, ['bash', '-ec',
        'source /run/agentor/worker.env; test "$(printf %s "$WORKER_LOCAL_ENV" | base64 -d | jq -r \'.[] | select(.key == "BOOT_SECRET") | .value\')" = applied; test ! -e /workspace/unapplied-init'])).returnCode).toBe(0);
      await runtime.client.exec(info.containerName, ['sh', '-c', 'nohup sh -c "sleep 1; reboot" >/dev/null 2>&1 &']);
      let rebootId = '';
      await expect.poll(async () => {
        try {
          const probe = await runtime.inspectGuestReadiness(info, incarnation);
          if (probe.bootId !== original.bootId) { rebootId = probe.bootId; return !probe.provisioned; }
        } catch { /* guest agent is temporarily unavailable during legitimate reboot */ }
        return false;
      }, { timeout: 120_000, intervals: [1000, 2000] }).toBe(true);
      await manager.reconcileIncusWorkers();
      expect(info.status).toBe('running'); expect(info.pendingRebuild).toBe(true);
      const recovered = await runtime.inspectGuestReadiness(info, incarnation);
      expect(recovered).toMatchObject({ bootId: rebootId, provisioned: true, serviceReady: true });
      const applied = await runtime.client.exec(info.containerName, ['bash', '-ec',
        'source /run/agentor/worker.env; test "$(printf %s "$WORKER_LOCAL_ENV" | base64 -d | jq -r \'.[] | select(.key == "BOOT_SECRET") | .value\')" = applied; test ! -e /workspace/unapplied-init']);
      expect(applied.returnCode).toBe(0);
      expect((await useWorkerConfigStore().resolveValues(info.userId, info.id))[0]!.value).toBe('unapplied');
    }
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
    for (const worker of cleanupStore.list()) {
      const owner = { id: worker.id, userId: worker.userId, containerName: manager.buildContainerName(worker.id) };
      await runtime.remove(owner); await runtime.removeStorage(owner);
    }
    await rm(root, { recursive: true, force: true });
  }
});
