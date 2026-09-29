import { expect, test } from "@playwright/test";
import { ContainerManager as ActualContainerManager } from "../../orchestrator/server/utils/container";
import { mkdtemp, rm, mkdir, open, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeMigrationStore } from '../../orchestrator/server/utils/worker-runtime-migration';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { OperationDeadlineError } from "../../orchestrator/server/utils/operation-deadline";
import { withWorkerLifecycleMutation } from "../../orchestrator/server/utils/worker-lifecycle-coordinator";

(globalThis as any).useLogCollector ??= () => ({
  detach() {},
  attach: async () => undefined,
});
(globalThis as any).useLogger ??= () => ({
  error() {},
  warn() {},
  info() {},
  debug() {},
});

let dataDir: string;
test.beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'container-runtime-holds-')); });
test.afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });
class ContainerManager extends ActualContainerManager {
  constructor(docker: any, config: any) { super(docker, { ...config, dataDir }); }
}

test("managed runtimes without authoritative worker records stay quarantined", async () => {
  const errors: string[] = [];
  (globalThis as any).useLogger = () => ({
    error(message: string) { errors.push(message); },
    warn() {},
    info() {},
    debug() {},
  });
  const docker = {
    listContainers: async () => [{
      Id: "docker-container-id",
      Names: ["/agentor-worker-worker-missing"],
      Image: "agentor-worker:latest",
      ImageID: "sha256:image",
      State: "running",
      Labels: { "agentor.id": "worker-missing" },
    }],
  };
  const manager = new ContainerManager(
    docker as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [],
    findById: () => undefined,
  } as any);

  await manager.sync();

  expect(manager.list()).toEqual([]);
  expect(errors).toEqual([
    expect.stringContaining("authoritative worker record worker-missing is unavailable"),
  ]);
});

function workerRecord() {
  return {
    id: "worker-1",
    userId: "owner-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    displayName: "Worker 1",
    status: "active" as const,
  };
}

function dockerWorker() {
  return {
    Id: "docker-worker-1",
    Names: ["/agentor-worker-worker-1"],
    Image: "agentor-worker:latest",
    ImageID: "sha256:image",
    State: "running",
    Labels: { "agentor.id": "worker-1" },
  };
}

test('uncertain durable worker write prevents subsequent removal through a retained live handle', async () => {
  let failSync = false;
  const workers = new WorkerStore(dataDir, { mkdir, rename, unlink, open: async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    return { writeFile: (data, options) => handle.writeFile(data, options), close: () => handle.close(),
      sync: async () => { if (failSync) throw new Error('injected fsync failure'); await handle.sync(); } };
  } });
  await workers.init(); await workers.upsert(workerRecord());
  const mutations: string[] = [];
  const manager = new ContainerManager({ removeContainer: async () => { mutations.push('remove'); } }, { containerPrefix: 'agentor-worker' });
  manager.setWorkerStore(workers);
  (manager as any).assertOwnerExists = async () => {};
  (manager as any).containers.set('worker-1', { ...workerRecord(), containerId: 'docker-worker-1', containerName: 'agentor-worker-worker-1' });
  failSync = true;
  await expect(workers.upsert({ ...workerRecord(), displayName: 'changed settings' })).rejects.toMatchObject({ code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  await expect(manager.remove('worker-1')).rejects.toMatchObject({ code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  await expect(manager.removeWorkersForDeletedOwner('owner-1')).rejects.toMatchObject({ code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  expect(mutations).toEqual([]);
});

test('settings edit preserves durable pending rebuild and unrelated settings absent from stale live state', async () => {
  const workers = new WorkerStore(dataDir); await workers.init();
  await workers.upsert({ ...workerRecord(), runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin',
    repos: [{ provider: 'github', url: 'example/current' }] });
  await workers.markPendingRebuild('owner-1', 'worker-1');
  const manager = new ContainerManager({}, {}); manager.setWorkerStore(workers);
  const info = { ...workerRecord(), runtimeProfile: 'legacy-runc', status: 'running', pendingRebuild: false, containerId: 'original' };
  Object.defineProperty(info, 'legacyPrivilegeGrant', { value: 'admin', configurable: true, writable: true, enumerable: false });
  (manager as any).containers.set(info.id, info);
  await (manager as any).updateSettingsForOwner(info.id, { displayName: 'Updated label' });
  expect(workers.get('owner-1', 'worker-1')).toMatchObject({ displayName: 'Updated label', pendingRebuild: true, legacyPrivilegeGrant: 'admin',
    repos: [{ provider: 'github', url: 'example/current' }] });
  expect(info).toMatchObject({ displayName: 'Updated label', pendingRebuild: true, repos: [{ provider: 'github', url: 'example/current' }] });
});

test('uncertain final recreation record write retains replacement without automatic Docker rollback', async () => {
  const mutations: string[] = [];
  const manager = new ContainerManager({ removeContainer: async () => { mutations.push('remove'); } }, {});
  const info = { ...workerRecord(), containerId: 'replacement', containerName: 'agentor-worker-worker-1', status: 'running' };
  const error = Object.assign(new Error('fsync failed'), { code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  await expect((manager as any).rollbackFailedRecreation(info, info.containerId, error)).rejects.toBe(error);
  expect(mutations).toEqual([]);
  expect(manager.get(info.id)).toMatchObject({ containerId: 'replacement', status: 'unknown' });
});

test('uncertain deletion marker prevents post-container data cleanup', async () => {
  const mutations: string[] = [];
  const manager = new ContainerManager({ removeContainer: async () => { mutations.push('remove-compute'); } }, {});
  const info = { ...workerRecord(), containerId: 'replacement', containerName: 'agentor-worker-worker-1', status: 'running' };
  (manager as any).containers.set(info.id, info);
  manager.setWorkerStore({ get: () => workerRecord(), markDeletionPending: async () => {
    throw Object.assign(new Error('fsync failed'), { code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  } } as any);
  manager.setStorageManager({ removeWorkerWorkspace: async () => { mutations.push('delete-data'); } } as any);
  await expect((manager as any).removeUnlocked(info.id)).rejects.toMatchObject({ code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  expect(mutations).toEqual(['remove-compute']);
  expect(manager.get(info.id)).toBeDefined();
});

for (const lateDirty of [false, true]) test(`pre-upgrade archived worker preserves absent profile and ${lateDirty ? 'newer' : 'applied'} configuration debt`, async () => {
  const workers = new WorkerStore(dataDir); await workers.init();
  const record = { ...workerRecord(), status: 'archived' as const, desiredRuntimeStatus: 'stopped' as const };
  await workers.upsert(record);
  const created: any[] = [];
  const manager = new ContainerManager({ assertWorkerRuntimeAvailable: async () => {},
    createWorkerContainer: async (options: unknown) => {
      created.push(options);
      if (lateDirty) await workers.markPendingRebuild(record.userId, record.id);
      return { id: 'replacement' };
    },
  }, { containerPrefix: 'agentor-worker', workerImagePrefix: '', workerImage: 'worker:latest' });
  manager.setWorkerStore(workers);
  const narrow = manager as any;
  narrow.resolveAuthorizedHostMounts = async () => [];
  narrow.resolveHardwareDeviceAccess = async () => [];
  narrow.resolveEnvironmentConfig = () => ({});
  narrow.deriveLimits = () => ({ dockerEnabled: false });
  narrow.resolveGitIdentity = async () => ({});
  narrow.resolveUserEnvAndBinds = async () => ({ credentialBinds: [], groupSecrets: [] });
  narrow.persistentBackupPathMounts = async () => [];
  const previous = (globalThis as any).reassignWorkerMappings;
  (globalThis as any).reassignWorkerMappings = async () => {};
  try {
    await expect(narrow.unarchiveUnlocked(record.userId, record.id)).resolves.toMatchObject({ containerId: 'replacement', status: 'running' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ runtimeProfile: 'legacy-runc', dockerEnabled: false });
    expect(created[0].legacyPrivilegeGrant).toBeUndefined();
    expect(workers.get(record.userId, record.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'running' });
    expect(workers.get(record.userId, record.id)!.runtimeProfile).toBeUndefined();
    expect(workers.get(record.userId, record.id)!.pendingRebuild).toBe(lateDirty);
    expect(manager.get(record.id)!.pendingRebuild).toBe(lateDirty);
  } finally { (globalThis as any).reassignWorkerMappings = previous; }
});

test('rebuild completion uses the runtime tuple after immutable snapshot backfill', async () => {
  const workers = new WorkerStore(dataDir); await workers.init();
  const reference = 'agentor-import-worker-1:runtime-old';
  const imageId = `sha256:${'e'.repeat(64)}`;
  const record = { ...workerRecord(), runtimeProfile: 'legacy-runc' as const, importedImage: reference, pendingRebuild: true };
  await workers.upsert(record);
  const removed: string[] = [];
  const manager = new ContainerManager({ assertWorkerRuntimeAvailable: async () => {},
    stopContainer: async () => {}, removeContainer: async (id: string) => { removed.push(id); },
    createWorkerContainer: async () => ({ id: 'replacement' }),
  }, { containerPrefix: 'agentor-worker', workerImagePrefix: '', workerImage: 'worker:latest' });
  manager.setWorkerStore(workers);
  const narrow = manager as any;
  const info = { ...record, status: 'running', containerId: 'a'.repeat(64), containerName: 'agentor-worker-worker-1',
    imageName: reference, imageId };
  narrow.containers.set(record.id, info);
  narrow.resolveAuthorizedHostMounts = async () => [];
  narrow.resolveHardwareDeviceAccess = async () => [];
  narrow.resolveEnvironmentConfig = () => ({});
  narrow.deriveLimits = () => ({ dockerEnabled: false });
  narrow.resolveGitIdentity = async () => ({});
  narrow.resolveUserEnvAndBinds = async () => ({ credentialBinds: [], groupSecrets: [] });
  narrow.persistentBackupPathMounts = async () => [];
  narrow.reconcileManagedNetworksForWorker = async () => {};
  narrow.reconcileWorkerPlugins = async () => {};
  narrow.inspectRuntimeSnapshotSource = async () => ({ Id: info.containerId, Name: '/' + info.containerName, Image: imageId,
    Config: { Image: reference, Labels: { 'agentor.managed': 'true', 'agentor.id': record.id } },
    HostConfig: { Runtime: 'runc', Privileged: false } });
  narrow.runtimeSnapshotDocker = () => ({ getImage: () => ({ modem: { dial: (_options: unknown, callback: any) => callback(null, { Id: imageId }) } }) });
  const previous = (globalThis as any).reassignWorkerMappings;
  (globalThis as any).reassignWorkerMappings = async () => {};
  try {
    await expect(narrow.rebuildUnlocked(record.id)).resolves.toMatchObject({ containerId: 'replacement', pendingRebuild: false });
    expect(removed).toEqual(['a'.repeat(64)]);
    expect(workers.get(record.userId, record.id)).toMatchObject({ status: 'active', pendingRebuild: false,
      runtimeSnapshotIdentity: { reference, imageId } });
  } finally { (globalThis as any).reassignWorkerMappings = previous; }
});

for (const phase of ['committed', 'rolled-back'] as const) test(`startup sync loads historical ${phase} hold before legacy runtime backfill`, async () => {
  const record = workerRecord();
  const journals = new RuntimeMigrationStore(dataDir); await journals.init();
  await journals.save({ version: 1, operationId: 'operation', workerId: record.id, userId: record.userId, phase,
    createdAt: record.createdAt, updatedAt: record.updatedAt, sourceId: 'a'.repeat(64),
    sourceName: 'agentor-worker-worker-1', rollbackName: 'agentor-worker-worker-1-runtime-rollback-operation',
    sourceImage: 'worker:source', sourceImageId: `sha256:${'b'.repeat(64)}`, sourceRunning: false,
    sourceRestartPolicy: { Name: 'no' }, targetProfile: 'kata-qemu', sourceRecord: record,
    snapshotImage: 'agentor-import-worker-1:runtime-operation', mounts: [],
    helperImage: `sha256:${'c'.repeat(64)}`, expectedMounts: [], replacementMayHaveRun: false });
  const writes: string[] = [];
  const manager = new ContainerManager({ listContainers: async () => [dockerWorker()],
    inspectContainerRuntime: async () => ({ status: 'running', running: true, runtime: 'runc', privileged: true }),
    probeContainerTask: async () => {},
  }, { containerPrefix: 'agentor-worker' });
  manager.setWorkerStore({ list: () => [record], findById: () => record,
    get: () => record, hasUnavailableOwners: () => false,
    capturePreexistingRuntime: async () => { writes.push('grant'); },
    setDesiredRuntimeStatus: async () => { writes.push('desired'); },
  } as any);
  await manager.sync();
  expect(manager.get(record.id)).toBeUndefined();
  expect(writes).toEqual([]);
  expect(await manager.hasPendingRuntimeMigrations()).toBe(true);
  const inventory = await manager.runtimeMigrationInventory();
  expect(inventory).toHaveLength(1);
  expect(inventory[0]).toMatchObject({ workerId: record.id, displayName: record.displayName, phase,
    reconciliationRequired: true, workerRecordTransitionPending: false });
  expect(inventory[0]).not.toHaveProperty('sourceRecord');
  expect(inventory[0]).not.toHaveProperty('mounts');
  expect(inventory[0]).not.toHaveProperty('userId');
  expect(manager.list()).toEqual([]);
});

for (const unavailable of ['worker', 'journal']) test(`migration inventory visibly rejects unavailable ${unavailable} owner partitions`, async () => {
  const manager = new ContainerManager({}, {});
  manager.setWorkerStore({ hasUnavailableOwners: () => unavailable === 'worker' } as any);
  (manager as any).runtimeMigrationStore = { init: async () => {}, hasUnavailableOwners: () => unavailable === 'journal',
    list: () => { throw new Error('must not silently omit unavailable owners'); } };
  await expect(manager.runtimeMigrationInventory()).rejects.toMatchObject({ statusCode: 503,
    code: unavailable === 'worker' ? 'WORKER_RECORD_STORE_UNAVAILABLE' : 'WORKER_RUNTIME_MIGRATION_JOURNAL_UNAVAILABLE' });
});

test('a late runtime probe overlapping recreation cannot repopulate the stale status cache', async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const manager = new ContainerManager({
    inspectContainerRuntime: () => ++calls === 1
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ status: 'running', running: true }),
    probeContainerTask: async () => undefined,
  } as any, { containerPrefix: 'agentor-worker' } as any);
  let observation!: Promise<unknown>;
  await withWorkerLifecycleMutation('storage-probe-race', async () => {
    observation = (manager as any).observeRuntime('replacement-runtime', 'storage-probe-race');
  });
  finish({ status: 'created', running: false });
  await observation;
  expect(await (manager as any).observeRuntime('replacement-runtime', 'storage-probe-race')).toMatchObject({ status: 'running' });
  expect(calls).toBe(2);
});

test("legacy workers persist desired running state after a verified task observation", async () => {
  const saved: string[] = [];
  const record = workerRecord();
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => ({
        status: "running",
        running: true,
        restartPolicy: "unless-stopped",
        secretHandshakeRequired: false,
      }),
      probeContainerTask: async () => undefined,
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
    setDesiredRuntimeStatus: async (_owner: string, _id: string, desired: string) => {
      saved.push(desired);
    },
  } as any);

  await manager.sync();

  expect(manager.get("worker-1")).toMatchObject({
    status: "running",
    desiredRuntimeStatus: "running",
  });
  expect(saved).toEqual(["running"]);
});

test('pre-profile privileged legacy worker captures grant from Docker inspection', async () => {
  const record = workerRecord();
  const captures: boolean[] = [];
  const manager = new ContainerManager({
    listContainers: async () => [dockerWorker()],
    inspectContainerRuntime: async () => ({ status: 'running', running: true,
      runtime: 'runc', privileged: true, restartPolicy: 'unless-stopped',
      secretHandshakeRequired: false }),
    probeContainerTask: async () => undefined,
  } as any, { containerPrefix: 'agentor-worker' } as any);
  manager.setWorkerStore({
    list: () => [record], findById: () => record,
    setDesiredRuntimeStatus: async () => undefined,
    capturePreexistingRuntime: async (_owner: string, _id: string, privileged: boolean) => {
      captures.push(privileged);
    },
  } as any);
  await manager.sync();
  expect(manager.get('worker-1')).toMatchObject({
    runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'preexisting',
  });
  expect(JSON.stringify(manager.get('worker-1'))).not.toContain('legacyPrivilegeGrant');
  expect(captures).toEqual([true]);
});

test('failed first inspection retains missing profile until privilege can be verified', async () => {
  let record: any = workerRecord();
  let fail = true;
  const manager = new ContainerManager({
    listContainers: async () => [dockerWorker()],
    inspectContainerRuntime: async () => {
      if (fail) throw new Error('inspection unavailable');
      return { status: 'running', running: true, runtime: 'runc', privileged: true,
        restartPolicy: 'no', secretHandshakeRequired: false };
    },
    probeContainerTask: async () => undefined,
  } as any, { containerPrefix: 'agentor-worker' } as any);
  const captures: boolean[] = [];
  manager.setWorkerStore({ list: () => [record], findById: () => record,
    capturePreexistingRuntime: async (_owner: string, _id: string, privileged: boolean) => captures.push(privileged),
    setDesiredRuntimeStatus: async () => undefined,
  } as any);
  await manager.sync();
  record = (manager as any).containerInfoToWorkerRecord(manager.get('worker-1'));
  expect(record.runtimeProfile).toBeUndefined();
  fail = false;
  (manager as any).runtimeObservations.clear();
  await manager.sync();
  expect(captures).toEqual([true]);
  expect(manager.get('worker-1')).toMatchObject({ runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'preexisting' });
});

test('failed health probe retains successful legacy privilege inspection', async () => {
  const record = workerRecord();
  const captures: boolean[] = [];
  const manager = new ContainerManager({
    listContainers: async () => [dockerWorker()],
    inspectContainerRuntime: async () => ({ status: 'running', running: true,
      runtime: 'runc', privileged: true, restartPolicy: 'no', secretHandshakeRequired: false }),
    probeContainerTask: async () => { throw new Error('health failed'); },
  } as any, { containerPrefix: 'agentor-worker' } as any);
  manager.setWorkerStore({ list: () => [record], findById: () => record,
    capturePreexistingRuntime: async (_owner: string, _id: string, privileged: boolean) => captures.push(privileged),
    setDesiredRuntimeStatus: async () => undefined,
  } as any);
  await manager.sync();
  expect(captures).toEqual([true]);
  expect(manager.get('worker-1')).toMatchObject({ status: 'unknown', runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'preexisting' });
});

test('restored legacy records cannot regain privileged authority from Docker inventory', async () => {
  const record = { ...workerRecord(), runtimeRestoreApprovalRequired: true };
  const captures: boolean[] = [];
  const manager = new ContainerManager({
    listContainers: async () => [dockerWorker()],
    inspectContainerRuntime: async () => ({ status: 'running', running: true,
      runtime: 'runc', privileged: true, restartPolicy: 'no', secretHandshakeRequired: false }),
    probeContainerTask: async () => undefined,
  } as any, { containerPrefix: 'agentor-worker' } as any);
  manager.setWorkerStore({ list: () => [record], findById: () => record,
    capturePreexistingRuntime: async (_owner: string, _id: string, privileged: boolean) => captures.push(privileged),
    setDesiredRuntimeStatus: async () => undefined,
  } as any);
  await manager.sync();
  expect(captures).toEqual([]);
  const worker = manager.get('worker-1')!;
  expect(worker.legacyPrivilegeGrant).toBeUndefined();
  expect(worker.runtimeRestoreApprovalRequired).toBe(true);
  expect((manager as any).containerInfoToWorkerRecord(worker).runtimeRestoreApprovalRequired).toBe(true);
  await expect((manager as any).restartUnlocked('worker-1')).rejects.toMatchObject({ code: 'WORKER_RUNTIME_RESTORE_APPROVAL_REQUIRED' });
  await expect((manager as any).rebuildUnlocked('worker-1')).rejects.toMatchObject({ code: 'WORKER_RUNTIME_RESTORE_APPROVAL_REQUIRED' });
  await expect((manager as any).recoverUnlocked('worker-1')).rejects.toMatchObject({ code: 'WORKER_RUNTIME_RESTORE_APPROVAL_REQUIRED' });
});

for (const phase of ['committed', 'rolled-back']) test(`retained ${phase} migration requires finalization before every worker recreation path`, async () => {
  const manager = new ContainerManager({} as any, { containerPrefix: 'agentor-worker' } as any);
  (manager as any).containers.set('worker-1', { ...workerRecord(), containerId: 'replacement', containerName: 'agentor-worker-worker-1', runtimeProfile: 'kata-qemu' });
  (manager as any).runtimeMigrationStore = { init: async () => {}, get: () => ({ phase }), isBlocked: () => false };
  manager.setWorkerStore({ get: () => ({ ...workerRecord(), status: 'archived' }) } as any);
  for (const method of ['rebuildUnlocked', 'recoverUnlocked', 'archiveUnlocked', 'applyManagedStorageUnlocked'])
    await expect((manager as any)[method]('worker-1')).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_FINALIZE_REQUIRED' });
  await expect((manager as any).unarchiveUnlocked('owner-1', 'worker-1'))
    .rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_FINALIZE_REQUIRED' });
});

for (const phase of ['committed', 'rolled-back']) test(`permanent worker deletion requires explicit ${phase} migration finalization`, async () => {
  const events: string[] = [];
  const manager = new ContainerManager({ removeContainer: async () => {
    events.push('remove-active'); throw new Error('stop test after ordered removal');
  } } as any, { containerPrefix: 'agentor-worker' } as any);
  (manager as any).containers.set('worker-1', { ...workerRecord(), containerId: 'replacement', containerName: 'agentor-worker-worker-1' });
  (manager as any).runtimeMigrationStore = { init: async () => {}, get: () => ({ phase }), isBlocked: () => false };
  (manager as any).runtimeMigrationEngine = () => ({ finalize: async () => { events.push('finalize'); } });
  await expect((manager as any).removeUnlocked('worker-1')).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_FINALIZE_REQUIRED' });
  expect(events).toEqual([]);
});

test('runtime mismatch is quarantined without adopting Docker privilege', async () => {
  const record = { ...workerRecord(), runtimeProfile: 'kata-qemu' as const };
  const manager = new ContainerManager({
    listContainers: async () => [{ ...dockerWorker(), Labels: {
      'agentor.id': 'worker-1', 'agentor.runtime-profile': 'kata-qemu',
    } }],
    inspectContainerRuntime: async () => ({ status: 'running', running: true,
      runtime: 'runc', privileged: true, restartPolicy: 'unless-stopped',
      secretHandshakeRequired: false }),
    probeContainerTask: async () => undefined,
  } as any, { containerPrefix: 'agentor-worker' } as any);
  manager.setWorkerStore({ list: () => [record], findById: () => record } as any);
  await manager.sync();
  expect(manager.get('worker-1')).toMatchObject({
    status: 'unknown', runtimeDiagnostic: { code: 'WORKER_RUNTIME_MISMATCH' },
  });
});

test('privileged Kata inventory is quarantined even with the correct runtime alias', async () => {
  const record = { ...workerRecord(), runtimeProfile: 'kata-qemu' as const };
  const manager = new ContainerManager({
    listContainers: async () => [{ ...dockerWorker(), Labels: {
      'agentor.id': 'worker-1', 'agentor.runtime-profile': 'kata-qemu',
    } }],
    inspectContainerRuntime: async () => ({ status: 'running', running: true,
      runtime: 'agentor-kata-qemu', privileged: true, restartPolicy: 'no',
      secretHandshakeRequired: false }),
    probeContainerTask: async () => undefined,
  } as any, { containerPrefix: 'agentor-worker' } as any);
  manager.setWorkerStore({ list: () => [record], findById: () => record } as any);
  await manager.sync();
  expect(manager.get('worker-1')).toMatchObject({
    status: 'unknown', runtimeDiagnostic: { code: 'WORKER_RUNTIME_MISMATCH' },
  });
  await expect((manager as any).rebuildUnlocked('worker-1'))
    .rejects.toMatchObject({ code: 'WORKER_RUNTIME_MISMATCH' });
});

test("legacy crash-looping workers retain running intent for managed bootstrap recovery", async () => {
  const saved: string[] = [];
  const record = workerRecord();
  const restarting = { ...dockerWorker(), State: "restarting" };
  const manager = new ContainerManager(
    {
      listContainers: async () => [restarting],
      inspectContainerRuntime: async () => ({
        status: "restarting",
        running: false,
        restartPolicy: "unless-stopped",
        secretHandshakeRequired: true,
      }),
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
    setDesiredRuntimeStatus: async (_owner: string, _id: string, desired: string) => {
      saved.push(desired);
    },
  } as any);

  await manager.sync();

  expect(manager.get("worker-1")).toMatchObject({
    status: "starting",
    desiredRuntimeStatus: "running",
  });
  expect(saved).toEqual(["running"]);
});

test("a directly started secret worker is unknown until its bootstrap handshake exists", async () => {
  const record = {
    ...workerRecord(),
    desiredRuntimeStatus: "running" as const,
  };
  let secretAwareProbe = false;
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => ({
        status: "running",
        running: true,
        restartPolicy: "unless-stopped",
        secretHandshakeRequired: true,
      }),
      probeContainerTask: async (
        _containerId: string,
        secretHandshakeRequired: boolean,
      ) => {
        secretAwareProbe = secretHandshakeRequired;
        throw Object.assign(
          new Error("Worker secret bootstrap handshake is unavailable"),
          {
            code: "WORKER_SECRET_BOOTSTRAP_REQUIRED",
            data: { operation: "Docker worker task probe" },
          },
        );
      },
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
  } as any);

  await manager.sync();

  expect(secretAwareProbe).toBe(true);
  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown",
    desiredRuntimeStatus: "running",
    runtimeDiagnostic: {
      code: "WORKER_SECRET_BOOTSTRAP_REQUIRED",
      operation: "Docker worker task probe",
      retryable: true,
    },
  });
});

test("a failed live-task probe exposes unknown rather than stale running health", async () => {
  const record = workerRecord();
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => ({
        status: "running",
        running: true,
        restartPolicy: "unless-stopped",
        secretHandshakeRequired: false,
      }),
      probeContainerTask: async () => {
        throw new OperationDeadlineError(
          "DOCKER_OPERATION_TIMEOUT",
          "Docker worker task probe",
          10_000,
        );
      },
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
    setDesiredRuntimeStatus: async () => {
      throw new Error("unknown observations must not become desired state");
    },
  } as any);

  await manager.sync();

  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown",
    runtimeDiagnostic: {
      code: "DOCKER_OPERATION_TIMEOUT",
      operation: "Docker worker task probe",
      retryable: true,
    },
  });
});

test("sync cannot overwrite a lifecycle replacement with its older Docker snapshot", async () => {
  const record = workerRecord();
  let releaseInspection!: () => void;
  let inspecting = false;
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => {
        inspecting = true;
        await new Promise<void>((resolve) => { releaseInspection = resolve; });
        return {
          status: "running",
          running: true,
          restartPolicy: "unless-stopped",
          secretHandshakeRequired: false,
        };
      },
      probeContainerTask: async () => undefined,
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
    setDesiredRuntimeStatus: async () => undefined,
  } as any);
  (manager as any).containers.set("worker-1", {
    id: "worker-1",
    userId: "owner-1",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    containerId: "docker-worker-1",
    containerName: "agentor-worker-worker-1",
    displayName: "Worker 1",
    imageName: "agentor-worker:latest",
    imageId: "sha256:old",
    status: "running",
  });

  const syncing = manager.sync();
  await expect.poll(() => inspecting).toBe(true);

  await withWorkerLifecycleMutation("worker-1", async () => {
    // This models a completed rebuild/recovery that replaced the disposable
    // Docker object while sync still owns the earlier list response.
    (manager as any).containers.set("worker-1", {
      ...(manager as any).containers.get("worker-1"),
      containerId: "docker-worker-replacement",
      imageId: "sha256:replacement",
      status: "starting",
    });
  });
  releaseInspection();
  await syncing;

  expect(manager.get("worker-1")).toMatchObject({
    containerId: "docker-worker-replacement",
    imageId: "sha256:replacement",
    status: "starting",
  });
});

for (const delayedPhase of ['list', 'inspect', 'missing']) test(`sync starting during recreation preserves completed state after delayed ${delayedPhase}`, async () => {
  const record = { ...workerRecord(), desiredRuntimeStatus: 'running' };
  let release!: () => void;
  let entered = false;
  const delay = () => { entered = true; return new Promise<void>((resolve) => { release = resolve; }); };
  const manager = new ContainerManager({
    listContainers: async () => { if (delayedPhase !== 'inspect') await delay(); return delayedPhase === 'missing' ? [] : [dockerWorker()]; },
    inspectContainerRuntime: async () => { if (delayedPhase === 'inspect') await delay(); return { status: 'created', running: false }; },
  } as any, { containerPrefix: 'agentor-worker' } as any);
  manager.setWorkerStore({ list: () => [record], findById: () => record } as any);
  const current = { ...record, containerId: 'docker-worker-1', containerName: 'agentor-worker-worker-1', status: 'starting' };
  (manager as any).containers.set(record.id, current);
  let syncing!: Promise<void>;
  await withWorkerLifecycleMutation(record.id, async () => {
    syncing = manager.sync();
    await expect.poll(() => entered).toBe(true);
    current.status = 'running';
  });
  release();
  await syncing;
  expect(manager.get(record.id)?.status).toBe('running');
});

test("sync never revives an archived worker from an older Docker list response", async () => {
  const record = workerRecord();
  let releaseInspection!: () => void;
  let inspecting = false;
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => {
        inspecting = true;
        await new Promise<void>((resolve) => { releaseInspection = resolve; });
        return { status: "running", running: true, restartPolicy: "no", secretHandshakeRequired: false };
      },
      probeContainerTask: async () => undefined,
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({ list: () => [record], findById: () => record } as any);
  const syncing = manager.sync();
  await expect.poll(() => inspecting).toBe(true);
  await withWorkerLifecycleMutation("worker-1", async () => {
    (record as any).status = "archived";
    (manager as any).containers.delete("worker-1");
  });
  releaseInspection();
  await syncing;
  expect(manager.get("worker-1")).toBeUndefined();
});

test("a failed secret bootstrap is recoverable by stop/start without rebuilding", async () => {
  const record = { ...workerRecord(), desiredRuntimeStatus: "running" as const };
  let bootstrapAttempts = 0;
  let bootstrapAvailable = false;
  let starts = 0;
  let stops = 0;
  let creates = 0;
  let pluginReconciles = 0;
  const docker = {
    updateContainerRestartPolicy: async () => undefined,
    inspectContainerRuntime: async () => ({
      status: "exited",
      running: false,
      restartPolicy: "no",
      secretHandshakeRequired: true,
    }),
    startContainer: async () => { starts++; },
    restartContainer: async () => { throw new Error("unexpected restart"); },
    materializeWorkerSecretFiles: async () => {
      bootstrapAttempts++;
      if (!bootstrapAvailable) throw new Error("injected transient provider outage");
    },
    stopContainer: async () => { stops++; },
    probeContainerTask: async () => undefined,
    createWorkerContainer: async () => { creates++; },
  };
  const manager = new ContainerManager(
    docker as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    get: () => record,
    setDesiredRuntimeStatus: async () => record,
  } as any);
  // Production lifecycle entry points revalidate the owner through auth. This
  // focused unit test deliberately supplies only Docker/store doubles, so keep
  // it independent of the native SQLite addon used by the auth module.
  (manager as any).assertOwnerExists = async () => undefined;
  (manager as any).containers.set("worker-1", {
    id: "worker-1",
    userId: "owner-1",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    containerId: "docker-worker-1",
    containerName: "agentor-worker-worker-1",
    displayName: "Worker 1",
    imageName: "agentor-worker:latest",
    imageId: "sha256:image",
    status: "stopped",
    desiredRuntimeStatus: "running",
  });
  (manager as any).resolveUserEnvAndBinds = async () => ({
    userEnv: { userId: "owner-1", envVars: [] },
    credentialBinds: [],
    groupSecrets: [{ kind: "secret", key: "GROUP_TOKEN", value: "runtime-only" }],
  });
  (manager as any).reconcileWorkerPlugins = async () => { pluginReconciles++; };

  await expect(manager.restart("worker-1")).rejects.toMatchObject({
    statusCode: 503,
    code: "WORKER_SECRET_BOOTSTRAP_FAILED",
    data: {
      phase: "secret-bootstrap",
      retryable: true,
      volumesPreserved: true,
    },
  });
  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown",
    desiredRuntimeStatus: "running",
  });
  expect(bootstrapAttempts).toBe(3);
  expect(stops).toBe(1);

  // The normal lifecycle path must recover the existing immutable container;
  // no rebuild or replacement is needed after the provider becomes available.
  await manager.stop("worker-1");
  expect(manager.get("worker-1")).toMatchObject({
    status: "stopped",
    desiredRuntimeStatus: "stopped",
  });
  bootstrapAvailable = true;
  await manager.restart("worker-1");
  expect(manager.get("worker-1")).toMatchObject({ status: "running" });
  expect(starts).toBe(2);
  expect(stops).toBe(2);
  expect(creates).toBe(0);
  expect(pluginReconciles).toBe(1);
});

function restartFixture(profile: "kata-qemu" | "legacy-runc" = "kata-qemu", running = true) {
  const events: string[] = [];
  const record = { ...workerRecord(), runtimeProfile: profile, desiredRuntimeStatus: "running" as const };
  const secrets = [{ kind: "secret", key: "GROUP_TOKEN", value: "test-runtime-only" }];
  const docker = {
    updateContainerRestartPolicy: async (id: string, sensitive: boolean) => {
      expect(id).toBe("docker-worker-1");
      expect(sensitive).toBe(true);
      events.push("policy");
    },
    inspectContainerRuntime: async () => {
      events.push("inspect");
      return { running, runtime: profile === "kata-qemu" ? "agentor-kata-qemu" : "runc", privileged: false };
    },
    stopContainer: async (id: string) => { expect(id).toBe("docker-worker-1"); events.push("stop"); },
    startContainer: async (id: string) => { expect(id).toBe("docker-worker-1"); events.push("start"); },
    restartContainer: async (id: string) => { expect(id).toBe("docker-worker-1"); events.push("restart"); },
    materializeWorkerSecretFiles: async (id: string, values: unknown[]) => {
      expect(id).toBe("docker-worker-1");
      expect(values).toEqual(secrets);
      events.push("bootstrap");
    },
    probeContainerTask: async (id: string, sensitive: boolean) => {
      expect(id).toBe("docker-worker-1");
      expect(sensitive).toBe(true);
      events.push("probe");
    },
  };
  const manager = new ContainerManager(docker as any, { containerPrefix: "agentor-worker" } as any);
  manager.setWorkerStore({
    get: () => record,
    setDesiredRuntimeStatus: async (_owner: string, _id: string, desired: string) => {
      expect(desired).toBe("running");
      events.push("desired-running");
      return record;
    },
  } as any);
  // Keep the real public lifecycle fence while isolating the auth database.
  (manager as any).assertOwnerExists = async () => undefined;
  (manager as any).containers.set(record.id, {
    ...record, containerId: "docker-worker-1", containerName: "agentor-worker-worker-1",
    imageName: "agentor-worker:latest", imageId: "sha256:image", status: running ? "running" : "stopped",
  });
  (manager as any).resolveUserEnvAndBinds = async () => ({
    userEnv: { userId: record.userId, envVars: [] }, credentialBinds: [], groupSecrets: secrets,
  });
  (manager as any).reconcileWorkerPlugins = async () => { events.push("plugins"); };
  return { manager, docker, events };
}

test("running Kata restart awaits stop inside the lifecycle fence before start and secret bootstrap", async () => {
  const { manager, docker, events } = restartFixture();
  let stopped!: () => void;
  let enteredStop!: () => void;
  const stopEntered = new Promise<void>((resolve) => { enteredStop = resolve; });
  docker.stopContainer = async () => {
    events.push("stop");
    enteredStop();
    await new Promise<void>((resolve) => { stopped = resolve; });
  };
  const restarting = manager.restart("worker-1");
  await stopEntered;
  let nextMutationEntered = false;
  const nextMutation = withWorkerLifecycleMutation("worker-1", async () => { nextMutationEntered = true; });
  await Promise.resolve();
  expect(nextMutationEntered).toBe(false);
  expect(events).toEqual(["desired-running", "policy", "inspect", "stop"]);
  stopped();
  await restarting;
  await nextMutation;
  expect(events).toEqual(["desired-running", "policy", "inspect", "stop", "start", "bootstrap", "probe", "plugins"]);
  expect(manager.get("worker-1")).toMatchObject({ status: "running", desiredRuntimeStatus: "running", runtimeProfile: "kata-qemu" });
});

for (const ambiguous of [false, true]) {
  test(`Kata restart does not start after ${ambiguous ? "an ambiguous" : "a definitive"} stop failure`, async () => {
    const { manager, docker, events } = restartFixture();
    const failure = ambiguous
      ? new OperationDeadlineError("DOCKER_OPERATION_TIMEOUT", "Docker worker stop", 30_000)
      : new Error("injected stop failure");
    docker.stopContainer = async () => { events.push("stop"); throw failure; };
    await expect(manager.restart("worker-1")).rejects.toBe(failure);
    expect(events).toEqual(["desired-running", "policy", "inspect", "stop"]);
    expect(manager.get("worker-1")).toMatchObject({ status: "unknown", desiredRuntimeStatus: "running" });
    if (ambiguous) expect(manager.get("worker-1")?.runtimeDiagnostic?.code).toBe("DOCKER_OPERATION_TIMEOUT");
  });
}

test("Kata restart start failure stays unknown and never bootstraps or reports running", async () => {
  const { manager, docker, events } = restartFixture();
  const failure = new Error("injected start failure");
  docker.startContainer = async () => { events.push("start"); throw failure; };
  await expect(manager.restart("worker-1")).rejects.toBe(failure);
  expect(events).toEqual(["desired-running", "policy", "inspect", "stop", "start"]);
  expect(manager.get("worker-1")).toMatchObject({ status: "unknown", desiredRuntimeStatus: "running" });
});

test("Kata restart ambiguous start timeout stays unknown without secret bootstrap", async () => {
  const { manager, docker, events } = restartFixture();
  const failure = new OperationDeadlineError("DOCKER_OPERATION_TIMEOUT", "Docker worker start", 30_000);
  docker.startContainer = async () => { events.push("start"); throw failure; };
  await expect(manager.restart("worker-1")).rejects.toBe(failure);
  expect(events).toEqual(["desired-running", "policy", "inspect", "stop", "start"]);
  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown", desiredRuntimeStatus: "running",
    runtimeDiagnostic: { code: "DOCKER_OPERATION_TIMEOUT" },
  });
});

test("running legacy workers retain Docker's combined restart path", async () => {
  const { manager, events } = restartFixture("legacy-runc");
  await manager.restart("worker-1");
  expect(events).toEqual(["desired-running", "policy", "inspect", "restart", "bootstrap", "probe", "plugins"]);
  expect(manager.get("worker-1")).toMatchObject({ status: "running", runtimeProfile: "legacy-runc" });
});

test("running privileged legacy worker retains its explicit grant and combined restart", async () => {
  const { manager, docker, events } = restartFixture("legacy-runc");
  (manager.get("worker-1") as any).legacyPrivilegeGrant = "admin";
  docker.inspectContainerRuntime = async () => {
    events.push("inspect");
    return { running: true, runtime: "runc", privileged: true };
  };
  await manager.restart("worker-1");
  expect(events).toEqual(["desired-running", "policy", "inspect", "restart", "bootstrap", "probe", "plugins"]);
  expect(manager.get("worker-1")).toMatchObject({
    status: "running", runtimeProfile: "legacy-runc", legacyPrivilegeGrant: "admin",
  });
});

test("stopped Kata workers start directly without a redundant stop or combined restart", async () => {
  const { manager, events } = restartFixture("kata-qemu", false);
  await manager.restart("worker-1");
  expect(events).toEqual(["desired-running", "policy", "inspect", "start", "bootstrap", "probe", "plugins"]);
  expect(manager.get("worker-1")).toMatchObject({ status: "running", desiredRuntimeStatus: "running" });
});

test("one unresponsive runtime does not block reconciliation of another worker", async () => {
  const records = [
    { ...workerRecord(), id: "worker-1", desiredRuntimeStatus: "running" as const },
    { ...workerRecord(), id: "worker-2", desiredRuntimeStatus: "running" as const },
  ];
  const inspected: string[] = [];
  const manager = new ContainerManager(
    {
      inspectContainerRuntime: async (containerId: string) => {
        inspected.push(containerId);
        if (containerId === "docker-worker-1")
          throw new OperationDeadlineError(
            "DOCKER_OPERATION_TIMEOUT",
            "Docker worker inspection",
            8_000,
          );
        return {
          status: "running",
          running: true,
          restartPolicy: "unless-stopped",
          secretHandshakeRequired: false,
        };
      },
      updateContainerRestartPolicy: async () => undefined,
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    get: (_owner: string, id: string) => records.find((item) => item.id === id),
    upsert: async () => undefined,
    listActive: () => records,
    listArchived: () => [],
  } as any);
  for (const [index, record] of records.entries())
    (manager as any).containers.set(record.id, {
      id: record.id,
      userId: record.userId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      containerId: `docker-worker-${index + 1}`,
      containerName: `agentor-worker-${record.id}`,
      displayName: record.displayName,
      imageName: "agentor-worker:latest",
      imageId: "sha256:image",
      status: "running",
      desiredRuntimeStatus: "running",
    });
  (manager as any).resolveUserEnvAndBinds = async () => ({
    userEnv: { userId: "owner-1", envVars: [] },
    credentialBinds: [],
    groupSecrets: [],
  });

  await manager.reconcileWorkers();

  expect(inspected).toEqual(["docker-worker-1", "docker-worker-2"]);
  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown",
    runtimeDiagnostic: { code: "DOCKER_OPERATION_TIMEOUT" },
  });
  expect(manager.get("worker-2")).toMatchObject({ status: "running" });
});
