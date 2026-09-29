import { test, expect } from '@playwright/test';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RuntimeMigrationStore, WorkerRuntimeMigration, type RuntimeMigrationJournal } from '../../orchestrator/server/utils/worker-runtime-migration';
import type { MigrationJournalIO } from '../../orchestrator/server/utils/runtime-migration-durable-store';

const ERROR = 'WORKER_RUNTIME_MIGRATION_JOURNAL_UNAVAILABLE';
const SOURCE = 'a'.repeat(64);
const journalName = 'worker-runtime-migrations.v1.json';
function journal(workerId = 'worker-1', userId = 'owner-1'): RuntimeMigrationJournal {
  const operationId = 'operation-1', sourceName = 'agentor-' + workerId;
  return { version: 1, operationId, workerId, userId, phase: 'prepared',
    createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
    sourceId: SOURCE, sourceName, rollbackName: `${sourceName}-runtime-rollback-${operationId}`,
    sourceImage: 'worker:source', sourceImageId: `sha256:${'b'.repeat(64)}`, sourceRunning: false,
    sourceRestartPolicy: { Name: 'no' }, targetProfile: 'kata-qemu',
    sourceRecord: { id: workerId, userId, displayName: workerId, status: 'active', runtimeProfile: 'legacy-runc',
      createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z' },
    snapshotImage: `agentor-import-${workerId}:runtime-${operationId}`, mounts: [],
    helperImage: `sha256:${'c'.repeat(64)}`, expectedMounts: [], replacementMayHaveRun: false };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kata-migration-durability-'));
  const events: string[] = [], temporaries: string[] = [];
  let transaction = 0;
  let failStage = '', failTransaction = 0;
  let pauseStage = '', releasePause: (() => void) | undefined;
  let notifyPause: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => { notifyPause = resolve; });
  async function step(stage: string) {
    events.push(stage);
    if (stage === pauseStage) {
      notifyPause!();
      await new Promise<void>((resolve) => { releasePause = resolve; });
    }
    if (stage === failStage && (!failTransaction || transaction === failTransaction))
      throw Object.assign(new Error('Injected storage failure'), { code: 'EIO' });
  }
  const io: MigrationJournalIO = {
    mkdir: (path, options) => mkdir(path, options),
    unlink: (path) => unlink(path),
    rename: async (source, destination) => { await step('rename'); await rename(source, destination); },
    open: async (path, flags, mode) => {
      const directory = Boolean(flags & constants.O_DIRECTORY);
      if (!directory) { transaction++; temporaries.push(path); }
      const handle = await open(path, flags, mode);
      return {
        writeFile: async (data, options) => { await step('write'); await handle.writeFile(data, options); },
        sync: async () => {
          await step(!directory ? 'file-sync' : path === dir ? 'root-sync' : basename(path) === 'users' ? 'users-sync' : 'owner-sync');
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };
  const store = new RuntimeMigrationStore(dir, io);
  await store.init();
  return { dir, store, events, temporaries, paused,
    fail: (stage: string, nth = 0) => { failStage = stage; failTransaction = nth; },
    pause: (stage: string) => { pauseStage = stage; },
    resume: () => { pauseStage = ''; releasePause!(); },
    file: (owner = 'owner-1') => join(dir, 'users', owner, journalName),
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('first owner syncs directory ancestry, file and rename before acknowledging a mode0600 journal', async () => {
  const f = await fixture();
  try {
    await f.store.save(journal());
    expect(f.events).toEqual(['root-sync', 'users-sync', 'write', 'file-sync', 'rename', 'owner-sync']);
    expect((await stat(f.file())).mode & 0o777).toBe(0o600);
    expect(await readdir(join(f.dir, 'users', 'owner-1'))).toEqual([journalName]);
    const reopened = new RuntimeMigrationStore(f.dir); await reopened.init();
    expect(reopened.get('owner-1', 'worker-1')!.phase).toBe('prepared');
  } finally { await f.cleanup(); }
});

test('candidate changes remain invisible until directory sync finishes and inputs/outputs are detached', async () => {
  const f = await fixture();
  try {
    await f.store.save(journal());
    f.pause('owner-sync');
    const next = journal(); next.phase = 'committed';
    const saving = f.store.save(next);
    await f.paused;
    next.mounts.push({ type: 'volume', source: 'changed', target: '/workspace', backup: 'changed', copied: false });
    expect(f.store.get('owner-1', 'worker-1')!.phase).toBe('prepared');
    expect(f.store.pending()).toHaveLength(1);
    f.resume(); await saving;
    const result = f.store.get('owner-1', 'worker-1')!;
    expect(result.phase).toBe('committed'); expect(result.mounts).toEqual([]);
    result.phase = 'prepared';
    expect(f.store.get('owner-1', 'worker-1')!.phase).toBe('committed');
  } finally { await f.cleanup(); }
});

for (const stage of ['write', 'file-sync', 'rename', 'owner-sync', 'root-sync', 'users-sync']) {
  test(`${stage} failure sticks in quarantine and cannot be cleared by reload/init/retry`, async () => {
    const f = await fixture();
    try {
      await f.store.save(journal());
      f.fail(stage);
      const next = journal(); next.phase = 'stopped';
      await expect(f.store.save(next)).rejects.toMatchObject({ code: ERROR });
      const eventsAfterFailure = [...f.events];
      f.fail('');
      expect(() => f.store.get('owner-1', 'worker-1')).toThrow(/unavailable/);
      await expect(f.store.loadUser('owner-1')).rejects.toMatchObject({ code: ERROR });
      await f.store.init();
      await expect(f.store.save(journal())).rejects.toMatchObject({ code: ERROR });
      await expect(f.store.clear('owner-1', 'worker-1')).rejects.toMatchObject({ code: ERROR });
      expect(f.events).toEqual(eventsAfterFailure);
      expect(f.store.hasUnavailableOwners()).toBe(true);
      // This checks observed filesystem state, not simulated power-loss survival.
      const disk = JSON.parse(await readFile(f.file(), 'utf8'));
      expect(disk[0].phase).toBe(stage === 'owner-sync' ? 'stopped' : 'prepared');
    } finally { await f.cleanup(); }
  });
}

test('same-owner concurrent saves serialize whole candidates without losing either journal', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.store.save(journal('worker-1')), f.store.save(journal('worker-2'))]);
    expect(f.store.listForUser('owner-1').map((j) => j.workerId)).toEqual(['worker-1', 'worker-2']);
    expect(new Set(f.temporaries).size).toBe(2);
    const reopened = new RuntimeMigrationStore(f.dir); await reopened.init();
    expect(reopened.listForUser('owner-1')).toEqual(f.store.listForUser('owner-1'));
  } finally { await f.cleanup(); }
});

test('failed owner blocks queued saves while another owner can persist', async () => {
  const f = await fixture();
  try {
    f.fail('file-sync', 1);
    const results = await Promise.allSettled([f.store.save(journal()), f.store.save(journal('worker-2'))]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(f.temporaries).toHaveLength(1);
    f.fail(''); await f.store.save(journal('worker-3', 'owner-2'));
    expect(f.store.list().map((j) => j.workerId)).toEqual(['worker-3']);
    expect(f.store.hasUnavailableOwners()).toBe(true);
  } finally { await f.cleanup(); }
});

test('clear writes a durable empty tombstone and reopening does not revive the journal', async () => {
  const f = await fixture();
  try {
    await f.store.save(journal()); f.events.length = 0;
    await f.store.clear('owner-1', 'worker-1');
    expect(f.events).toEqual(['root-sync', 'users-sync', 'write', 'file-sync', 'rename', 'owner-sync']);
    expect(JSON.parse(await readFile(f.file(), 'utf8'))).toEqual([]);
    const reopened = new RuntimeMigrationStore(f.dir); await reopened.init();
    expect(reopened.get('owner-1', 'worker-1')).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('uncertain clear does not claim success or expose an authoritative old memory snapshot', async () => {
  const f = await fixture();
  try {
    await f.store.save(journal()); f.fail('owner-sync');
    await expect(f.store.clear('owner-1', 'worker-1')).rejects.toMatchObject({ code: ERROR });
    expect(JSON.parse(await readFile(f.file(), 'utf8'))).toEqual([]);
    expect(() => f.store.get('owner-1', 'worker-1')).toThrow(/unavailable/);
  } finally { await f.cleanup(); }
});

function engine(f: Awaited<ReturnType<typeof fixture>>, rejectDocker = false) {
  const j = journal(), mutations: string[] = [];
  const source = { Id: SOURCE, Name: '/' + j.sourceName, Image: j.sourceImageId,
    Config: { Image: j.sourceImage }, State: { Running: false }, Mounts: [],
    HostConfig: { RestartPolicy: { Name: 'no' } } };
  const docker: any = { getContainer: () => ({ update: async () => {
    mutations.push('update');
    expect(f.store.get('owner-1', 'worker-1')!.inFlightOperation).toBe('getContainer update');
    const persisted = JSON.parse(await readFile(f.file(), 'utf8'));
    expect(persisted[0].inFlightOperation).toBe('getContainer update');
    expect(f.events.at(-1)).toBe('owner-sync');
    if (rejectDocker) throw new Error('Definitive Docker rejection');
  } }) };
  const callbacks: any = { trustedHelperImage: async () => j.helperImage };
  const migration = new WorkerRuntimeMigration(docker, f.store, callbacks);
  migration.preflight = async () => ({ source, owned: [], plan: {} } as any);
  return { migration, mutations, input: { record: j.sourceRecord, sourceId: SOURCE, sourceName: j.sourceName,
    targetProfile: 'kata-qemu' as const, ownedBindings: [], sharedBindings: [] } };
}

for (const nth of [1, 2]) test(`journal persistence failure in transaction ${nth} prevents the first Docker mutation`, async () => {
  const f = await fixture();
  try {
    f.fail('file-sync', nth);
    const run = engine(f);
    await expect(run.migration.migrate(run.input)).rejects.toMatchObject({ code: ERROR });
    expect(run.mutations).toEqual([]);
    expect(f.temporaries).toHaveLength(nth);
  } finally { await f.cleanup(); }
});

for (const rejectDocker of [false, true]) test(`completion journal failure after ${rejectDocker ? 'rejected' : 'successful'} Docker mutation never retries or rolls back`, async () => {
  const f = await fixture();
  try {
    f.fail('owner-sync', 3);
    const run = engine(f, rejectDocker);
    await expect(run.migration.migrate(run.input)).rejects.toMatchObject({ code: ERROR });
    expect(run.mutations).toEqual(['update']);
    expect(f.temporaries).toHaveLength(3);
    expect(f.store.hasUnavailableOwners()).toBe(true);
  } finally { await f.cleanup(); }
});

test('reopening an uncertain completion rename without intent still requires explicit daemon reconciliation', async () => {
  const f = await fixture();
  try {
    f.fail('owner-sync', 3);
    const run = engine(f);
    await expect(run.migration.migrate(run.input)).rejects.toMatchObject({ code: ERROR });
    const reopened = new RuntimeMigrationStore(f.dir); await reopened.init();
    const j = reopened.get('owner-1', 'worker-1')!;
    expect(j.inFlightOperation).toBeUndefined();
    expect(reopened.hasUnavailableOwners()).toBe(false); // Quarantine is process-local.
    expect(reopened.requiresReconciliation(j.userId, j.workerId)).toBe(true);
    await reopened.save(j); // An ordinary save is not a settlement acknowledgement.
    expect(reopened.requiresReconciliation(j.userId, j.workerId)).toBe(true);
    const mutations: string[] = [];
    const migration = new WorkerRuntimeMigration({ getContainer: () => {
      mutations.push('getContainer'); throw new Error('unexpected Docker access');
    } } as any, reopened, {} as any);
    await expect(migration.recover(j)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN' });
    expect(mutations).toEqual([]);
    await reopened.recordReconciliation(j);
    expect(reopened.requiresReconciliation(j.userId, j.workerId)).toBe(false);
    await reopened.loadUser(j.userId);
    expect(reopened.requiresReconciliation(j.userId, j.workerId)).toBe(true);
  } finally { await f.cleanup(); }
});

test('quarantined owner prevents recovery and finalize even with detached terminal journals', async () => {
  const f = await fixture();
  try {
    const j = journal(); await f.store.save(j); f.fail('owner-sync');
    await expect(f.store.save(j)).rejects.toMatchObject({ code: ERROR });
    const migration = new WorkerRuntimeMigration({} as any, f.store, {} as any);
    await expect(migration.recover(j, true)).rejects.toMatchObject({ code: ERROR });
    j.phase = 'rolled-back';
    await expect(migration.recover(j, true)).rejects.toMatchObject({ code: ERROR });
    await expect(migration.finalize(j)).rejects.toMatchObject({ code: ERROR });
  } finally { await f.cleanup(); }
});

test('helper start completion persistence failure does not authorize helper removal', async () => {
  const f = await fixture();
  try {
    const j = journal();
    j.mounts = [{ type: 'volume', source: 'workspace', target: '/workspace',
      backup: `agentor-runtime-backup-${j.operationId}-0`, copied: false }];
    await f.store.save(j);
    const mutations: string[] = [];
    const docker: any = {
      getVolume: () => ({ inspect: async () => ({ Labels: {
        'agentor.runtime-migration': j.operationId, 'agentor.runtime-migration-worker': j.workerId,
        'agentor.runtime-migration-owner': j.userId } }) }),
      getContainer: () => ({ inspect: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); } }),
      createContainer: async () => { mutations.push('create'); return {
        start: async () => { mutations.push('start'); f.fail('owner-sync'); },
        wait: async () => { mutations.push('wait'); return { StatusCode: 0 }; },
        remove: async () => { mutations.push('remove'); },
      }; },
    };
    const migration = new WorkerRuntimeMigration(docker, f.store, {} as any);
    (migration as any).activeJournal = j;
    await expect((migration as any).copy(j, j.mounts[0], false)).rejects.toMatchObject({ code: ERROR });
    expect(mutations).toEqual(['create', 'start']);
    expect(f.store.hasUnavailableOwners()).toBe(true);
  } finally { await f.cleanup(); }
});

test('create result lost to completion persistence failure is recovered by exact deterministic identity after settlement', async () => {
  const f = await fixture();
  try {
    const j = journal(), replacementId = 'd'.repeat(64), snapshotId = `sha256:${'e'.repeat(64)}`;
    const mutations: string[] = [];
    const source: any = { Id: SOURCE, Name: '/' + j.sourceName, Image: j.sourceImageId,
      Config: { Image: j.sourceImage, Labels: { 'agentor.id': j.workerId }, Env: ['ENVIRONMENT={"dockerEnabled":false}'] },
      State: { Running: false }, Mounts: [], NetworkSettings: { Networks: {} },
      HostConfig: { RestartPolicy: { Name: 'no' } } };
    const containers = new Map<string, any>([[SOURCE, source]]);
    const handle = (id: string): any => {
      const find = () => {
        const value = [...containers.values()].find((c) => c.Id === id || c.Name === '/' + id);
        if (!value) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return value;
      };
      return { id, inspect: async () => structuredClone(find()),
        update: async () => { mutations.push('update:' + find().Id); },
        rename: async (opts: any) => { mutations.push('rename:' + find().Id); find().Name = '/' + opts.name; },
        remove: async () => { const c = find(); mutations.push('remove:' + c.Id); containers.delete(c.Id); },
        commit: async () => { mutations.push('commit'); return { Id: snapshotId }; } };
    };
    const docker: any = { getContainer: handle,
      getImage: (name: string) => ({ inspect: async () => ({ Id: name === j.sourceImageId ? name : snapshotId, Config: { Env: [] } }) }),
      createContainer: async (opts: any) => {
        mutations.push('create');
        containers.set(replacementId, { Id: replacementId, Name: '/' + opts.name, Config: opts,
          State: { Running: false }, HostConfig: opts.HostConfig, Mounts: [] });
        f.fail('owner-sync'); // Fail after create returned, not its durable intent.
        return handle(replacementId);
      } };
    const callbacks: any = { trustedHelperImage: async () => j.helperImage, authorize: async () => {}, restore: async () => {} };
    const migration = new WorkerRuntimeMigration(docker, f.store, callbacks);
    migration.preflight = async () => ({ source, owned: [], plan: {} } as any);
    await expect(migration.migrate({ record: j.sourceRecord, sourceId: SOURCE, sourceName: j.sourceName,
      targetProfile: 'kata-qemu', ownedBindings: [], sharedBindings: [] })).rejects.toMatchObject({ code: ERROR });
    expect(mutations.at(-1)).toBe('create');
    expect(containers.has(replacementId)).toBe(true);
    const reopened = new RuntimeMigrationStore(f.dir); await reopened.init();
    const retained = reopened.get(j.userId, j.workerId)!;
    expect(retained.replacementId).toBeUndefined();
    expect(retained.inFlightOperation).toBeUndefined();
    const recovery = new WorkerRuntimeMigration(docker, reopened, callbacks);
    const before = [...mutations];
    await expect(recovery.recover(retained)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN' });
    expect(mutations).toEqual(before);
    await recovery.recover(retained, true);
    expect(reopened.get(j.userId, j.workerId)).toMatchObject({ phase: 'rolled-back', replacementId });
    expect(containers.has(replacementId)).toBe(false);
    expect(containers.get(SOURCE).Name).toBe('/' + j.sourceName);
    expect(mutations.filter((operation) => operation === 'create')).toHaveLength(1);
  } finally { await f.cleanup(); }
});
