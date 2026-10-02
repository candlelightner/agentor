import { expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { BackupStore } from '../../orchestrator/server/utils/backup-store';
import { BackupKeyring } from '../../orchestrator/server/utils/backup-keyring';
import * as deadlines from '../../orchestrator/server/utils/operation-deadline';
import * as instanceDeadlines from '../../orchestrator/server/utils/instance-operation-deadline';
import * as gateModule from '../../orchestrator/server/utils/instance-snapshot-gate';
import * as userIds from '../../orchestrator/server/utils/user-id';

const gate = gateModule.instanceControlPlaneCoordinator;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(initialize = true, filesystem: Partial<typeof fs> = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'agentor-backup-drain-'));
  const source = await fs.readFile(new URL('../../orchestrator/server/utils/backup-manager.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const logs: string[] = [], exports: Record<string, any> = {};
  const modules: Record<string, unknown> = {
    'node:fs/promises': { ...fs, ...filesystem },
    './services': { useConfig: () => ({ dataDir: directory }), useLogger: () => ({
      error: (value: string) => logs.push(value), warn: (value: string) => logs.push(value), info: () => {},
    }) },
    './backup-store': { BackupStore }, './backup-keyring': { BackupKeyring },
    './user-id': userIds,
    './backup-provider': { FakeBackupProvider: class {}, LocalBackupProvider: class {}, GoogleDriveBackupProvider: class {} },
    './operation-deadline': deadlines, './instance-operation-deadline': instanceDeadlines,
    './instance-snapshot-gate': gateModule,
  };
  const require = createRequire(import.meta.url);
  runInNewContext(compiled, { exports, require: (id: string) => modules[id] ?? (id.startsWith('node:') ? require(id) : Object.freeze({})),
    structuredClone, Buffer, process, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
  }, { timeout: 1000 });
  const manager = new exports.BackupManager({ dataDir: directory, providerCleanupTimeoutMs: 10 });
  manager.tickSchedules = async () => {};
  if (initialize) {
    await manager.init();
    await new Promise<void>(resolve => setImmediate(resolve));
    await manager.tickInFlight;
  }
  return { manager, directory, logs, async close() {
    manager.stop(); await manager.tickInFlight;
    await Promise.allSettled([...manager.activeTasks.values()].flatMap((tasks: any) => [...tasks]));
    await fs.rm(directory, { recursive: true, force: true });
  } };
}
test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false);
  await expect.poll(() => gate.activeOperations).toBe(0);
});

test('backup roots reject before lazy initialization, owner mutation or queue insertion', async () => {
  const f = await fixture(false); const barrier = gate.begin('backup-refused', 'snapshot');
  try {
    for (const operation of [
      () => f.manager.init(), () => f.manager.getConfig('owner'), () => f.manager.forgetUser('owner'),
      () => f.manager.createDiscovery('owner'), () => f.manager.prepareInstanceRecoveryMaterial(),
      () => f.manager.importRecoveryKit('owner', 'invalid'),
    ]) await expect(operation()).rejects.toMatchObject({ statusCode: 423 });
    expect(f.manager.initialized).toBeUndefined(); expect(f.manager.pending).toEqual([]);
    expect(f.manager.forgottenUsers.size).toBe(0); expect(await fs.readdir(f.directory)).toEqual([]);
    barrier.assertDrained();
  } finally { barrier.release(); await f.close(); }
});

test('backup excluded preflight rejects pending/failed startup and never lazily initializes', async () => {
  const f = await fixture(false), entered = deferred(), release = deferred();
  try {
    await expect(f.manager.hasActiveOperationsForInstanceSnapshot()).rejects.toMatchObject({ statusCode: 503 });
    expect(f.manager.initialized).toBeUndefined();
    f.manager.retryPendingProviderDeletes = async () => { entered.resolve(); await release.promise; throw new Error('startup cleanup failed'); };
    const loading = f.manager.init(); const failed = expect(loading).rejects.toThrow('startup cleanup failed');
    await entered.promise; const barrier = gate.begin('backup-pending-init', 'snapshot');
    try {
      await expect(f.manager.hasActiveOperationsForInstanceSnapshot()).rejects.toMatchObject({ statusCode: 503 });
      expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await failed;
      await barrier.drain({ timeoutMs: 1000 });
      await expect(f.manager.hasActiveOperationsForInstanceSnapshot()).rejects.toMatchObject({ statusCode: 503 });
      expect(f.manager.scheduleTimer).toBeUndefined();
    } finally { release.resolve(); await failed; barrier.release(); }
  } finally { release.resolve(); await f.close(); }
});

test('stopping during backup initialization cannot install or restart a schedule timer', async () => {
  const f = await fixture(false), entered = deferred(), release = deferred(); let ticks = 0;
  f.manager.retryPendingProviderDeletes = async () => { entered.resolve(); await release.promise; };
  f.manager.tickSchedules = async () => { ticks++; };
  const loading = f.manager.init(); await entered.promise; f.manager.stop();
  try {
    release.resolve(); await loading; f.manager.triggerScheduleTick();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.manager.scheduleTimer).toBeUndefined(); expect(ticks).toBe(0);
  } finally { release.resolve(); await loading; await f.close(); }
});

test('failed startup staging cleanup waits for every sibling removal before retiring', async () => {
  const entered = deferred(), release = deferred(); let removals = 0, returned = false;
  const f = await fixture(false, { rm: async () => {
    if (++removals === 1) throw new Error('synthetic removal failure');
    if (removals === 4) entered.resolve();
    await release.promise;
  } });
  // Real initialize() dispatches cleanup for an interrupted restore, with no
  // provider or Docker operations. Only the file-removal boundary is synthetic.
  await f.manager.store.init();
  await f.manager.store.update('owner', (data: any) => {
    data.jobs.push({ id: 'interrupted', userId: 'owner', operation: 'restore', status: 'running' });
  });
  const loading = f.manager.init().catch((error: unknown) => { returned = true; return error; });
  await entered.promise; const barrier = gate.begin('backup-init-siblings', 'snapshot');
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); expect((await loading).message).toBe('synthetic removal failure');
    await barrier.drain({ timeoutMs: 1000 });
    await expect(f.manager.hasActiveOperationsForInstanceSnapshot()).rejects.toMatchObject({ statusCode: 503 });
  } finally { release.resolve(); await loading; barrier.release(); await f.close(); }
});

test('backup queue reserves each descendant before dispatch and owns final bookkeeping', async () => {
  const f = await fixture(), first = deferred(), second = deferred(), entered = deferred(); let writes = 0;
  f.manager.maxConcurrent = 1;
  f.manager.enqueue('first', 'owner', () => first.promise);
  f.manager.enqueue('second', 'owner', async () => { entered.resolve(); await second.promise; await gate.run(() => { writes++; }); });
  const barrier = gate.begin('backup-descendants', 'snapshot');
  try {
    expect(gate.activeOperations).toBe(2);
    expect(() => f.manager.enqueue('new', 'owner', async () => {})).toThrow();
    first.resolve(); await entered.promise; expect(() => barrier.assertDrained()).toThrow();
    second.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(writes).toBe(1); expect(f.manager.active).toBe(0); expect(f.manager.activeTasks.size).toBe(0);
    await expect(f.manager.hasActiveOperationsForInstanceSnapshot()).resolves.toBe(false);
  } finally { first.resolve(); second.resolve(); barrier.release(); await f.close(); }
});

test('backup acceptance retains admission between durable job claim and detached queue insertion', async () => {
  const f = await fixture(), claimed = deferred(), release = deferred(), executing = deferred(), finish = deferred();
  f.manager.providers.set('local', { discover: async () => ({ objects: [] }) });
  const claim = f.manager.claimStartJob.bind(f.manager);
  f.manager.claimStartJob = async (job: any) => { const result = await claim(job); claimed.resolve(); await release.promise; return result; };
  f.manager.runDiscovery = async (job: any) => {
    executing.resolve(); await finish.promise;
    await f.manager.store.update('owner', (data: any) => { data.jobs.find((item: any) => item.id === job.id).status = 'succeeded'; });
  };
  const accepting = f.manager.createDiscovery('owner', 'local', 'discovery-request'); await claimed.promise;
  const barrier = gate.begin('backup-acceptance', 'snapshot');
  try {
    expect(f.manager.pending).toEqual([]); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); const job = await accepting; await executing.promise;
    expect(() => barrier.assertDrained()).toThrow(); finish.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.manager.store.findJob(job.id).status).toBe('succeeded');
  } finally { release.resolve(); finish.resolve(); await accepting; barrier.release(); await f.close(); }
});

for (const rejectSettlement of [false, true]) test(`backup awaited queue retains exposed ${rejectSettlement ? 'rejected' : 'resolved'} settlement after caller failure`, async () => {
  const f = await fixture(); let settle!: () => void;
  const settlement = new Promise<void>((resolve, reject) => { settle = () => rejectSettlement ? reject(new Error('late failure')) : resolve(); });
  const pending = f.manager.enqueueAndWait('failed', 'owner', async () => {
    throw Object.assign(new Error('early failure'), { [deadlines.operationSettlement]: settlement });
  });
  await expect(pending).rejects.toThrow('early failure');
  const barrier = gate.begin('backup-queue-settlement', 'snapshot');
  try {
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(f.manager.active).toBe(1); settle(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.manager.active).toBe(0); expect(f.manager.activeTasks.size).toBe(0);
  } finally { settle(); barrier.release(); await f.close(); }
});

test('shutdown cancels only undispatched backup leases and running task still owns cleanup', async () => {
  const f = await fixture(), running = deferred(); f.manager.maxConcurrent = 1;
  f.manager.enqueue('running', 'owner', () => running.promise);
  const queued = f.manager.enqueueAndWait('queued', 'owner', async () => { throw new Error('Cancelled task ran'); });
  const rejected = expect(queued).rejects.toThrow('shutting down'); f.manager.stop();
  const barrier = gate.begin('backup-shutdown', 'snapshot');
  try {
    await rejected; expect(f.manager.pending).toEqual([]); expect(gate.activeOperations).toBe(1);
    running.resolve(); await barrier.drain({ timeoutMs: 1000 });
  } finally { running.resolve(); await rejected; barrier.release(); await f.close(); }
});

test('backup schedule tick owns descendants and clears its busy state before retirement', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let ticks = 0;
  f.manager.tickSchedules = async () => { ticks++; entered.resolve(); await release.promise; await gate.run(() => {}); };
  f.manager.triggerScheduleTick(); await entered.promise;
  const barrier = gate.begin('backup-tick', 'snapshot');
  try {
    f.manager.triggerScheduleTick(); expect(ticks).toBe(1); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await barrier.drain({ timeoutMs: 1000 }); expect(f.manager.tickInFlight).toBeUndefined();
    await expect(f.manager.hasActiveOperationsForInstanceSnapshot()).resolves.toBe(false);
  } finally { release.resolve(); barrier.release(); await f.close(); }
});

for (const rejects of [false, true]) test(`caught provider cleanup deadline retains late ${rejects ? 'failure' : 'success'} and nested writes`, async () => {
  const f = await fixture(), release = deferred(); let writes = 0;
  try {
    await expect(f.manager.runProviderCleanup('Synthetic cleanup', async () => {
      await release.promise; await gate.run(() => { writes++; });
      if (rejects) throw new Error('late provider failure');
    })).rejects.toMatchObject({ code: 'BACKUP_PROVIDER_CLEANUP_TIMEOUT' });
    const barrier = gate.begin('backup-provider-late', 'snapshot');
    try {
      expect(() => barrier.assertDrained()).toThrow(); expect(writes).toBe(0);
      release.resolve(); await barrier.drain({ timeoutMs: 1000 }); expect(writes).toBe(1);
    } finally { release.resolve(); barrier.release(); }
  } finally { release.resolve(); await f.close(); }
});

test('real backup manager restore bridge reads prepared keyring under drained barrier without normalization', async () => {
  const f = await fixture();
  const previousKey = process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  try {
    const current = await f.manager.resolveInstanceRecoveryMaterial('owner');
    await f.manager.prepareInstanceRecoveryMaterial();
    const paths = ['worker-config.key', 'backup-keyring.json'].map(name => join(f.directory, name));
    for (const path of paths) await fs.chmod(path, 0o640);
    const before = await Promise.all(paths.map(path => fs.readFile(path)));
    const barrier = gate.begin('backup-prepared-keys', 'restore');
    try {
      await barrier.drain({ timeoutMs: 1000 });
      expect(await f.manager.resolveInstanceRecoveryMaterialForRestore('owner', current.fingerprint)).toEqual(current);
      expect(await f.manager.resolveInstanceRecoveryMaterialForRestore('other-owner', current.fingerprint)).toBeUndefined();
      await expect(f.manager.resolveInstanceRecoveryMaterial('owner', current.fingerprint)).rejects.toMatchObject({ statusCode: 423 });
      for (const [index, path] of paths.entries()) {
        expect(await fs.readFile(path)).toEqual(before[index]); expect((await fs.stat(path)).mode & 0o777).toBe(0o640);
      }
      f.manager.forgottenUsers.add('owner');
      await expect(f.manager.resolveInstanceRecoveryMaterialForRestore('owner', current.fingerprint))
        .rejects.toMatchObject({ code: 'BACKUP_OWNER_UNAVAILABLE' });
      barrier.assertDrained();
    } finally { barrier.release(); }
  } finally {
    if (previousKey === undefined) delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
    else process.env.WORKER_CONFIG_ENCRYPTION_KEY = previousKey;
    await f.close();
  }
});

test('restore bridge refuses unprepared keyring and missing crypto material without regenerating it', async () => {
  const f = await fixture(); const previousKey = process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  try {
    await expect(f.manager.resolveInstanceRecoveryMaterialForRestore('owner', `sha256:${'a'.repeat(64)}`))
      .rejects.toThrow('initialized before');
    const current = await f.manager.resolveInstanceRecoveryMaterial('owner');
    await fs.unlink(join(f.directory, 'worker-config.key'));
    const barrier = gate.begin('backup-missing-key', 'restore');
    try {
      await barrier.drain({ timeoutMs: 1000 });
      await expect(f.manager.resolveInstanceRecoveryMaterialForRestore('owner', current.fingerprint)).rejects.toThrow('key is unavailable');
      await expect(fs.stat(join(f.directory, 'worker-config.key'))).rejects.toMatchObject({ code: 'ENOENT' });
      barrier.assertDrained();
    } finally { barrier.release(); }
  } finally {
    if (previousKey === undefined) delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
    else process.env.WORKER_CONFIG_ENCRYPTION_KEY = previousKey;
    await f.close();
  }
});
