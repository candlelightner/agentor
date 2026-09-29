import { test, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile, open, rename, unlink, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRuntimeMigration, RuntimeMigrationStore, migrationTargetRuntime, type RuntimeMigrationInput } from '../../orchestrator/server/utils/worker-runtime-migration';
import { WorkerStore, workerRuntimeProjection, sameWorkerRuntimeProjection } from '../../orchestrator/server/utils/worker-store';
import type { WorkerStoreIO } from '../../orchestrator/server/utils/worker-durable-store';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });
const SOURCE = 'a'.repeat(64), REPLACEMENT = 'b'.repeat(64), HELPER_IMAGE = `sha256:${'c'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'d'.repeat(64)}`;

async function fixture(durableRecords = false) {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-runtime-migration-'));
  const store = new RuntimeMigrationStore(dir); await store.init();
  const events: string[] = [];
  let workerFailure: { transition: 'commit' | 'restore'; stage: 'file-sync' | 'owner-sync' } | undefined;
  let transition: 'commit' | 'restore' | undefined;
  const workerIO: WorkerStoreIO = {
    mkdir: (path, options) => mkdir(path, options), rename, unlink,
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      const stage = flags & constants.O_DIRECTORY ? (path === join(dir, 'users', 'owner-1') ? 'owner-sync' : 'ancestry-sync') : 'file-sync';
      return { writeFile: (data, options) => handle.writeFile(data, options), close: () => handle.close(),
        sync: async () => {
          if (workerFailure?.transition === transition && workerFailure?.stage === stage)
            throw Object.assign(new Error('injected worker persistence failure'), { code: 'EIO' });
          await handle.sync();
        } };
    },
  };
  const workers = new WorkerStore(dir, workerIO); await workers.init();
  const options: any[] = [];
  const volumes = new Map<string, any>([['worker-workspace', { Name: 'worker-workspace', Driver: 'local', Options: {}, Labels: {} }],
    ['worker-agents', { Name: 'worker-agents', Driver: 'local', Options: {}, Labels: {} }]]);
  const data = new Map([['worker-workspace', 'original workspace'], ['worker-agents', 'original agents']]);
  const containers = new Map<string, any>();
  const source = { Id: SOURCE, Name: '/agentor-worker-worker-1', Image: 'sha256:source',
    Config: { Image: 'worker:old', Hostname: SOURCE.slice(0, 12), Labels: { 'agentor.id': 'worker-1', 'agentor.managed': 'true' },
      Env: ['ENVIRONMENT={"dockerEnabled":false,"networkMode":"full","envVars":""}'], Cmd: ['/entrypoint'], Entrypoint: ['/bin/bash'] },
    HostConfig: { Runtime: 'runc', Privileged: false, NetworkMode: 'agentor-net', RestartPolicy: { Name: 'unless-stopped' },
      Binds: ['worker-workspace:/workspace', 'worker-agents:/home/agent/.agent-data', '/data/user/kilo:/home/agent/.agent-data/.kilo/config'] },
    State: { Running: true, Paused: false },
    Mounts: [{ Type: 'volume', Name: 'worker-workspace', Source: '/daemon/workspace', Destination: '/workspace', RW: true },
      { Type: 'volume', Name: 'worker-agents', Source: '/daemon/agents', Destination: '/home/agent/.agent-data', RW: true },
      { Type: 'bind', Source: '/data/user/kilo', Destination: '/home/agent/.agent-data/.kilo/config', RW: true }],
    NetworkSettings: { Networks: { 'agentor-net': { Aliases: ['worker-1'] } } } };
  containers.set(SOURCE, source);
  let fail: 'create' | 'start' | 'validate' | 'commit' | 'restore' | 'timeout' | 'mount' | 'image' | 'authority' | undefined;
  let restoredRecord: any; let committedRecord: any; let helperCounter = 0;
  let snapshotTagId = SNAPSHOT_ID;
  let authorizeCount = 0, revokeAt = 0;
  let beforeValidation: (() => Promise<void>) | undefined;
  const find = (id: string) => [...containers.values()].find((c) => c.Id === id || c.Name === `/${id}`);
  const missing = () => Object.assign(new Error('not found'), { statusCode: 404 });
  const handle = (id: string): any => ({ id,
    inspect: async () => { const c = find(id); if (!c) throw missing(); return structuredClone(c); },
    update: async (opts: any) => { const c = find(id); if (!c) throw missing(); c.HostConfig.RestartPolicy = opts.RestartPolicy; },
    stop: async () => { const c = find(id); if (!c) throw missing(); events.push(`stop:${c.Id}`); c.State.Running = false; },
    start: async () => {
      const c = find(id); if (!c) throw missing(); events.push(`start:${c.Id}`);
      if (c.Id === REPLACEMENT) {
        if (fail === 'start') throw new Error('start failure');
        data.set('worker-workspace', 'replacement workspace'); data.set('worker-agents', 'replacement agents');
        if (fail === 'timeout') { c.State.Running = true; throw Object.assign(new Error('transport timed out'), { code: 'ETIMEDOUT' }); }
      }
      if (c.helper) {
        const src = c.HostConfig.Mounts.find((m: any) => m.Target === '/source').Source;
        const dst = c.HostConfig.Mounts.find((m: any) => m.Target === '/target').Source;
        if (fail === 'restore' && dst === 'worker-workspace') throw new Error('restore copy failed');
        data.set(dst, data.get(src)!); events.push(`copy:${src}:${dst}`);
      }
      c.State.Running = true; c.State.StartedAt = '2026-09-28T00:00:00Z';
    },
    wait: async () => ({ StatusCode: 0 }),
    rename: async (opts: any) => { const c = find(id); if (!c) throw missing(); events.push(`rename:${c.Id}`); c.Name = `/${opts.name}`; },
    commit: async (opts: any) => { events.push('rootfs-snapshot'); expect(find(id).State.Running).toBe(false); return { Id: SNAPSHOT_ID }; },
    remove: async () => { const c = find(id); if (!c) throw missing(); events.push(`remove:${c.Id}`); containers.delete(c.Id); },
  });
  const docker: any = {
    getContainer: handle,
    getVolume: (name: string) => ({ inspect: async () => { if (!volumes.has(name)) throw missing(); return volumes.get(name); },
      remove: async () => { events.push(`remove-volume:${name}`); volumes.delete(name); data.delete(name); } }),
    getImage: (name: string) => ({ inspect: async () => ({ Id: name.startsWith('agentor-import-') ? snapshotTagId : name,
      Config: { Env: ['BAKED_SETTING=default'] } }),
      remove: async () => { events.push(`remove-image:${name}`); } }),
    createVolume: async (opts: any) => { volumes.set(opts.Name, { ...opts, Driver: 'local' }); return {}; },
    listContainers: async (opts: any) => [...containers.values()].filter((c) => c.Mounts.some((m: any) => m.Name === opts.filters.volume[0])).map((c) => ({ Id: c.Id })),
    createContainer: async (opts: any) => {
      options.push(opts);
      const helper = opts.name.startsWith('agentor-runtime-copy-');
      if (!helper && fail === 'create') throw new Error('create failure');
      const id = helper ? (++helperCounter).toString(16).padStart(64, '0') : REPLACEMENT;
      const mounts = helper ? opts.HostConfig.Mounts.map((m: any) => ({ Type: m.Type, Name: m.Type === 'volume' ? m.Source : undefined,
        Source: m.Source, Destination: m.Target, RW: !m.ReadOnly })) : structuredClone(source.Mounts);
      if (!helper && fail === 'mount') mounts[mounts.length - 1]!.RW = false;
      containers.set(id, { Id: id, Name: `/${opts.name}`, Image: !helper && fail === 'image' ? 'sha256:wrong' : opts.Image,
        Config: { ...opts }, HostConfig: opts.HostConfig,
        State: { Running: false }, Mounts: mounts, NetworkSettings: source.NetworkSettings, helper });
      return handle(id);
    },
  };
  const input: RuntimeMigrationInput = { record: { id: 'worker-1', userId: 'owner-1', displayName: 'Worker', status: 'active',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', runtimeProfile: 'legacy-runc' },
    sourceId: SOURCE, sourceName: 'agentor-worker-worker-1', targetProfile: 'kata-qemu',
    ownedBindings: [{ source: 'worker-workspace', target: '/workspace', type: 'volume' },
      { source: 'worker-agents', target: '/home/agent/.agent-data', type: 'volume' }],
    sharedBindings: [{ source: '/data/user/kilo', target: '/home/agent/.agent-data/.kilo/config' }] };
  if (durableRecords) await workers.upsert(input.record);
  const createEngine = (journalStore = store, workerStore = workers) => new WorkerRuntimeMigration(docker, journalStore, {
    authorize: async () => { events.push('authorize'); authorizeCount++; if (fail === 'authority' || authorizeCount === revokeAt) throw Object.assign(new Error('administrator revoked'), { statusCode: 403 }); },
    trustedHelperImage: async () => HELPER_IMAGE,
    assertAvailable: async () => { events.push('readiness'); },
    validate: async (id) => { events.push(`validate:${id}`); if (id === REPLACEMENT) await beforeValidation?.(); if (id === REPLACEMENT && (fail === 'validate' || fail === 'restore')) throw new Error('validation failure'); },
    commit: async (j) => {
      events.push('commit-policy'); if (fail === 'commit') throw new Error('persist failure');
      if (durableRecords) {
        transition = 'commit';
        await workerStore.transitionRuntimeMigration({ userId: j.userId, workerId: j.workerId,
          expected: workerRuntimeProjection(j.sourceRecord), target: migrationTargetRuntime(j) });
        transition = undefined;
      }
      committedRecord = j;
    },
    restore: async (j) => {
      events.push('restore-policy');
      if (durableRecords) {
        transition = 'restore';
        await workerStore.transitionRuntimeMigration({ userId: j.userId, workerId: j.workerId,
          expected: j.snapshotIdentity ? migrationTargetRuntime(j) : workerRuntimeProjection(j.sourceRecord),
          target: workerRuntimeProjection(j.sourceRecord) });
        transition = undefined;
      }
      restoredRecord = j.sourceRecord;
    },
    assertRecord: async (j, expected, durable) => {
      if (!durableRecords) return;
      events.push('assert-record');
      const current = workerStore.get(j.userId, j.workerId);
      const source = workerRuntimeProjection(j.sourceRecord);
      const target = j.snapshotIdentity ? migrationTargetRuntime(j) : undefined;
      if (!current || current.status !== 'active' || current.deletionPending || current.runtimeRestoreApprovalRequired ||
          !(expected !== 'target' && sameWorkerRuntimeProjection(current, source) ||
            expected !== 'source' && target && sameWorkerRuntimeProjection(current, target)))
        throw Object.assign(new Error('worker record mismatch'), { code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
      if (durable) await workerStore.transitionRuntimeMigration({ userId: j.userId, workerId: j.workerId,
        expected: workerRuntimeProjection(current), target: workerRuntimeProjection(current) });
    },
    publish: (_j, phase) => { events.push(`publish:${phase}`); },
  });
  const engine = createEngine();
  return { dir, engine, store, workers, createEngine, input, source, containers, volumes, data, options, events,
    workerFailure: (value: typeof workerFailure) => { workerFailure = value; },
    beforeValidation: (hook: () => Promise<void>) => { beforeValidation = hook; },
    repointSnapshot: (id: string) => { snapshotTagId = id; },
    revokeAt: (count: number) => { revokeAt = count; },
    fail: (value: typeof fail) => { fail = value; }, get restoredRecord() { return restoredRecord; },
    get committedRecord() { return committedRecord; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('migration snapshots stopped rootfs and worker storage, preserves shared account binds, then commits after validation', async () => {
  const f = await fixture();
  try {
    const { plan } = await f.engine.preflight(f.input);
    expect(plan.sharedAccountState).toBe('preserved-shared-bindings-not-rewound');
    expect(f.events).toEqual(['readiness']);
    const j = await f.engine.migrate(f.input);
    expect(j.phase).toBe('committed');
    expect(f.events.indexOf(`validate:${REPLACEMENT}`)).toBeLessThan(f.events.indexOf('commit-policy'));
    expect(f.containers.get(SOURCE).State.Running).toBe(false);
    expect(f.containers.get(SOURCE).Name).toBe(`/${j.rollbackName}`);
    expect(f.data.get(j.mounts[0]!.backup)).toBe('original workspace');
    expect(f.options.filter((o) => o.name.startsWith('agentor-runtime-copy-')).every((o) => o.Image === HELPER_IMAGE)).toBe(true);
    const replacement = f.options.find((o) => o.name === f.input.sourceName);
    expect(j.snapshotIdentity).toEqual({ reference: j.snapshotImage, imageId: SNAPSHOT_ID });
    expect(f.store.get('owner-1', 'worker-1')!.snapshotIdentity).toEqual(j.snapshotIdentity);
    expect(replacement.Image).toBe(SNAPSHOT_ID);
    expect(replacement.HostConfig).toMatchObject({ Runtime: 'agentor-kata-qemu', Privileged: false });
    expect(replacement.HostConfig.Binds).toContain('/data/user/kilo:/home/agent/.agent-data/.kilo/config');
    expect(f.options.filter((o) => o.name.startsWith('agentor-runtime-copy-')).flatMap((o) => o.HostConfig.Mounts)
      .some((m) => m.Source === '/data/user/kilo')).toBe(false);
  } finally { await f.cleanup(); }
});

test('standard secret tmpfs is recreated as ephemeral state while persistent storage is copied', async () => {
  const f = await fixture();
  try {
    (f.source.HostConfig as any).Tmpfs = { '/run/agentor-secrets': 'rw,nosuid,nodev,noexec' };
    f.source.Mounts.push({ Type: 'tmpfs', Source: '', Destination: '/run/agentor-secrets', RW: true } as any);
    const { plan } = await f.engine.preflight(f.input);
    expect(plan.mounts).toContainEqual({ target: '/run/agentor-secrets', kind: 'ephemeral' });
    const j = await f.engine.migrate(f.input);
    expect(j.phase).toBe('committed');
    expect(j.mounts.map((m) => m.target)).not.toContain('/run/agentor-secrets');
  } finally { await f.cleanup(); }
});

for (const stage of ['file-sync', 'owner-sync'] as const) test(`uncertain worker commit ${stage} retains durable intent without rollback or publication`, async () => {
  const f = await fixture(true);
  try {
    f.workerFailure({ transition: 'commit', stage });
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
    expect(f.events.slice(f.events.indexOf('commit-policy'))).toEqual(['commit-policy']);
    expect(f.source.State.Running).toBe(false);
    expect(f.containers.has(REPLACEMENT)).toBe(true);
    const journals = new RuntimeMigrationStore(f.dir); await journals.init();
    const workers = new WorkerStore(f.dir); await workers.init();
    const j = journals.get('owner-1', 'worker-1')!;
    expect(j.workerRecordIntent).toBe('commit');
    expect(j.phase).toBe('validated');
    expect(workers.get('owner-1', 'worker-1')!.runtimeProfile).toBe(stage === 'owner-sync' ? 'kata-qemu' : 'legacy-runc');
    const engine = f.createEngine(journals, workers);
    await expect(engine.recover(j)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN' });
    f.workerFailure(undefined);
    await engine.recover(j, true);
    expect(journals.get('owner-1', 'worker-1')!.phase).toBe('rolled-back');
    expect(workers.get('owner-1', 'worker-1')!.runtimeProfile).toBe('legacy-runc');
  } finally { await f.cleanup(); }
});

test('uncertain worker restore cannot restart the original or publish rollback', async () => {
  const f = await fixture(true);
  try {
    f.fail('validate'); f.workerFailure({ transition: 'restore', stage: 'owner-sync' });
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_RECOVERY_REQUIRED',
      rollback: { code: 'WORKER_RECORD_STORE_UNAVAILABLE' } });
    expect(f.events.slice(f.events.indexOf('restore-policy'))).toEqual(['restore-policy']);
    expect(f.source.State.Running).toBe(false);
    expect(f.store.get('owner-1', 'worker-1')!.workerRecordIntent).toBe('restore');
  } finally { await f.cleanup(); }
});

for (const mutation of ['missing', 'runtime-conflict'] as const) test(`${mutation} worker record prevents the first automatic rollback Docker mutation`, async () => {
  const f = await fixture(true);
  try {
    f.fail('validate');
    f.beforeValidation(async () => {
      if (mutation === 'missing') await f.workers.delete('owner-1', 'worker-1');
      else await f.workers.upsert({ ...f.input.record, importedImage: 'unrelated-image' }, {
        expectedRuntime: workerRuntimeProjection(f.input.record),
      });
    });
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_RECOVERY_REQUIRED',
      rollback: { code: 'WORKER_RECORD_RUNTIME_CONFLICT' } });
    expect(f.events.slice(f.events.indexOf(`validate:${REPLACEMENT}`))).toEqual([`validate:${REPLACEMENT}`, 'assert-record']);
    expect(f.containers.get(REPLACEMENT).State.Running).toBe(true);
    expect(f.source.State.Running).toBe(false);
  } finally { await f.cleanup(); }
});

test('runtime migration commit preserves concurrently queued pendingRebuild metadata', async () => {
  const f = await fixture(true);
  try {
    f.beforeValidation(async () => { await f.workers.markPendingRebuild('owner-1', 'worker-1'); });
    await f.engine.migrate(f.input);
    expect(f.workers.get('owner-1', 'worker-1')).toMatchObject({ runtimeProfile: 'kata-qemu', pendingRebuild: true });
  } finally { await f.cleanup(); }
});

test('worker-write interruption requires exact Docker identity before clearing loaded reconciliation', async () => {
  const f = await fixture(true);
  try {
    f.workerFailure({ transition: 'commit', stage: 'owner-sync' });
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
    f.containers.get(REPLACEMENT).Mounts[0].Name = 'foreign-volume';
    const journals = new RuntimeMigrationStore(f.dir); await journals.init();
    const workers = new WorkerStore(f.dir); await workers.init();
    const j = journals.get('owner-1', 'worker-1')!;
    const before = await readFile(join(f.dir, 'users/owner-1/worker-runtime-migrations.v1.json'), 'utf8');
    f.events.length = 0;
    await expect(f.createEngine(journals, workers).recover(j, true)).rejects.toThrow(/mounts differ/);
    expect(f.events).toEqual(['assert-record']);
    expect(journals.requiresReconciliation(j.userId, j.workerId)).toBe(true);
    expect(await readFile(join(f.dir, 'users/owner-1/worker-runtime-migrations.v1.json'), 'utf8')).toBe(before);
  } finally { await f.cleanup(); }
});

test('terminal journal failure after durable worker transition cannot publish or roll back', async () => {
  const f = await fixture(true);
  try {
    const save = f.store.save.bind(f.store);
    f.store.save = async (j) => {
      if (j.phase === 'committed') throw Object.assign(new Error('terminal journal uncertain'), { code: 'WORKER_RUNTIME_MIGRATION_JOURNAL_UNAVAILABLE' });
      return save(j);
    };
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_JOURNAL_UNAVAILABLE' });
    expect(f.workers.get('owner-1', 'worker-1')!.runtimeProfile).toBe('kata-qemu');
    expect(f.store.get('owner-1', 'worker-1')!.workerRecordIntent).toBe('commit');
    expect(f.events.slice(f.events.indexOf('commit-policy'))).toEqual(['commit-policy']);
    expect(f.containers.has(REPLACEMENT)).toBe(true);
    expect(f.source.State.Running).toBe(false);
  } finally { await f.cleanup(); }
});

for (const phase of ['committed', 'rolled-back'] as const) test(`reopened ${phase} evidence needs exact worker and Docker reconciliation before finalization`, async () => {
  const f = await fixture(true);
  try {
    if (phase === 'rolled-back') {
      f.fail('validate');
      await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_ROLLED_BACK' });
    } else await f.engine.migrate(f.input);
    const journals = new RuntimeMigrationStore(f.dir); await journals.init();
    const workers = new WorkerStore(f.dir); await workers.init();
    const j = journals.get('owner-1', 'worker-1')!;
    const engine = f.createEngine(journals, workers);
    expect(journals.isBlocked(j.userId, j.workerId)).toBe(true);
    await expect(engine.finalize(j)).rejects.toThrow(/recovery/);
    await expect(engine.recover(j)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN' });
    await engine.recover(j, true);
    expect(journals.isBlocked(j.userId, j.workerId)).toBe(false);
    await engine.finalize(j);
    expect(journals.get(j.userId, j.workerId)).toBeUndefined();
  } finally { await f.cleanup(); }
});

for (const mismatch of ['profile', 'image', 'owner', 'mount', 'recreated-source'] as const) test(`loaded terminal ${mismatch} mismatch preserves record and all rollback evidence`, async () => {
  const f = await fixture(true);
  try {
    if (mismatch === 'recreated-source') {
      f.fail('validate');
      await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_ROLLED_BACK' });
      const recreated = { ...f.source, Id: 'e'.repeat(64) };
      f.containers.delete(SOURCE); f.containers.set(recreated.Id, recreated);
    } else {
      await f.engine.migrate(f.input);
      const active = f.containers.get(REPLACEMENT);
      if (mismatch === 'profile') {
        const current = f.workers.get('owner-1', 'worker-1')!;
        await f.workers.upsert({ ...current, runtimeProfile: 'legacy-runc' }, { expectedRuntime: workerRuntimeProjection(current) });
      } else if (mismatch === 'image') active.Image = 'sha256:wrong';
      else if (mismatch === 'owner') active.Config.Labels['agentor.owner-id'] = 'other-owner';
      else active.Mounts[0].Name = 'other-volume';
    }
    const before = await readFile(join(f.dir, 'users/owner-1/workers.json'), 'utf8');
    const journals = new RuntimeMigrationStore(f.dir); await journals.init();
    const workers = new WorkerStore(f.dir); await workers.init();
    const j = journals.get('owner-1', 'worker-1')!;
    const engine = f.createEngine(journals, workers);
    f.events.length = 0;
    await expect(engine.recover(j, true)).rejects.toThrow();
    await expect(engine.finalize(j)).rejects.toThrow();
    expect(f.events.filter((e) => e !== 'assert-record')).toEqual([]);
    expect(await readFile(join(f.dir, 'users/owner-1/workers.json'), 'utf8')).toBe(before);
    expect(journals.isBlocked(j.userId, j.workerId)).toBe(true);
    expect(j.mounts.every((m) => f.volumes.has(m.backup))).toBe(true);
  } finally { await f.cleanup(); }
});

for (const phase of ['create', 'image', 'start', 'validate', 'commit'] as const) test(`migration ${phase} failure restores original runtime and canonical storage`, async () => {
  const f = await fixture();
  try {
    f.fail(phase);
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_ROLLED_BACK' });
    expect(f.source.State.Running).toBe(true);
    expect(f.source.Name).toBe(`/${f.input.sourceName}`);
    expect(f.data.get('worker-workspace')).toBe('original workspace');
    expect(f.data.get('worker-agents')).toBe('original agents');
    expect(f.restoredRecord.runtimeProfile).toBe('legacy-runc');
    expect(f.containers.has(SOURCE)).toBe(true);
    expect(f.containers.has(REPLACEMENT)).toBe(false);
    if (phase === 'image') expect(f.events).not.toContain(`start:${REPLACEMENT}`);
    const j = f.store.get('owner-1', 'worker-1')!;
    expect(j.phase).toBe('rolled-back');
    expect(j.mounts.every((m) => f.volumes.has(m.backup))).toBe(true);
  } finally { await f.cleanup(); }
});

test('interrupted replacement rolls back on recovery and never deletes the source based on replacement existence', async () => {
  const f = await fixture();
  try {
    const j = await f.engine.migrate(f.input);
    j.phase = 'replacement'; await f.store.save(j);
    await f.engine.recover(j);
    expect(f.store.get('owner-1', 'worker-1')!.phase).toBe('rolled-back');
    expect(f.containers.has(SOURCE)).toBe(true);
    expect(f.data.get('worker-workspace')).toBe('original workspace');
  } finally { await f.cleanup(); }
});

test('failed volume restoration retains journal and all recovery evidence; explicit retry resumes rollback', async () => {
  const f = await fixture();
  try {
    f.fail('restore');
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_RECOVERY_REQUIRED' });
    const j = f.store.get('owner-1', 'worker-1')!;
    expect(j.phase).toBe('recovery-required');
    expect(f.source.State.Running).toBe(false);
    expect(f.containers.has(REPLACEMENT)).toBe(true);
    expect(j.mounts.every((m) => f.volumes.has(m.backup))).toBe(true);
    f.fail(undefined); await f.engine.recover(j);
    expect(f.store.get('owner-1', 'worker-1')!.phase).toBe('rolled-back');
    expect(f.source.State.Running).toBe(true);
  } finally { await f.cleanup(); }
});

test('preflight refuses unapproved writable mounts and Kata DinD before stopping source', async () => {
  const f = await fixture();
  try {
    f.source.Mounts.push({ Type: 'bind', Source: '/external', Destination: '/external', RW: true } as any);
    await expect(f.engine.preflight(f.input)).rejects.toThrow(/rollback policy/);
    f.source.Mounts.pop(); f.source.Config.Env = ['ENVIRONMENT={"dockerEnabled":true}'];
    await expect(f.engine.preflight(f.input)).rejects.toMatchObject({ code: 'KATA_DIND_NOT_VALIDATED' });
    expect(f.source.State.Running).toBe(true);
    expect(f.options).toEqual([]);
  } finally { await f.cleanup(); }
});

for (const [name, env, code] of [
  ['normal structured DinD', ['ENVIRONMENT={"dockerEnabled":true}'], 'KATA_DIND_NOT_VALIDATED'],
  ['historical DinD', ['DOCKER_ENABLED=true'], 'KATA_DIND_NOT_VALIDATED'],
  ['matching structured/historical DinD', ['ENVIRONMENT={"dockerEnabled":true}', 'DOCKER_ENABLED=true'], 'KATA_DIND_NOT_VALIDATED'],
  ['missing configuration', [], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['malformed JSON', ['ENVIRONMENT={'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['empty JSON', ['ENVIRONMENT='], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['null JSON', ['ENVIRONMENT=null'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['array JSON', ['ENVIRONMENT=[]'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['boolean JSON', ['ENVIRONMENT=false'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['string true', ['ENVIRONMENT={"dockerEnabled":"true"}'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['number value', ['ENVIRONMENT={"dockerEnabled":1}'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['duplicate structured fields', ['ENVIRONMENT={"dockerEnabled":false}', 'ENVIRONMENT={"dockerEnabled":true}'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['identical duplicated fields', ['ENVIRONMENT={}', 'ENVIRONMENT={}'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['duplicate historical fields', ['DOCKER_ENABLED=false', 'DOCKER_ENABLED=false'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['invalid historical flag', ['DOCKER_ENABLED='], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['contradictory fields', ['ENVIRONMENT={"dockerEnabled":true}', 'DOCKER_ENABLED=false'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['reverse contradictory fields', ['ENVIRONMENT={"dockerEnabled":false}', 'DOCKER_ENABLED=true'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['custom environment override', [`ENVIRONMENT=${JSON.stringify({ dockerEnabled: false, envVars: 'ENVIRONMENT={"dockerEnabled":true}' })}`], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['custom local payload override', [`ENVIRONMENT=${JSON.stringify({ dockerEnabled: false, envVars: 'WORKER_LOCAL_ENV=payload' })}`], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['local environment override', ['ENVIRONMENT={"dockerEnabled":false}', `WORKER_LOCAL_ENV=${Buffer.from(JSON.stringify([{ key: 'ENVIRONMENT', value: '{"dockerEnabled":true}' }])).toString('base64')}`], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['malformed local payload', ['ENVIRONMENT={"dockerEnabled":false}', 'WORKER_LOCAL_ENV=invalid'], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
  ['assignment-shaped local key', ['ENVIRONMENT={"dockerEnabled":false}', `WORKER_LOCAL_ENV=${Buffer.from(JSON.stringify([{ key: 'ENVIRONMENT={"dockerEnabled":true,"x":"', value: '"}' }])).toString('base64')}`], 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN'],
] as const) test(`migration rejects ${name} before journal or Docker mutations`, async () => {
  const f = await fixture();
  try {
    f.source.Config.Env = [...env];
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code });
    expect(f.events).toEqual([]);
    expect(f.options).toEqual([]);
    expect(f.store.get('owner-1', 'worker-1')).toBeUndefined();
    expect(f.source.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
    expect(f.source.State.Running).toBe(true);
    expect(f.volumes.size).toBe(2);
    expect(f.containers.size).toBe(1);
  } finally { await f.cleanup(); }
});

for (const [name, value] of [['absent', undefined], ['null', null], ['non-array', {}], ['non-string entry', [42]]] as const)
  test(`migration rejects ${name} inspected Env without leaking payloads`, async () => {
    const f = await fixture();
    try {
      (f.source.Config as any).Env = value;
      await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN' });
      expect(f.events).toEqual([]);
      expect(f.options).toEqual([]);
      expect(f.store.get('owner-1', 'worker-1')).toBeUndefined();
      expect(f.source.State.Running).toBe(true);
      expect(f.source.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
      expect(f.volumes.size).toBe(2);
    } finally { await f.cleanup(); }
  });

test('uncertain source configuration diagnostics do not disclose runtime values', async () => {
  const f = await fixture();
  try {
    f.source.Config.Env = ['ENVIRONMENT={SECRET-CANARY-NOT-LOGGED'];
    await expect(f.engine.migrate(f.input)).rejects.not.toThrow(/SECRET-CANARY-NOT-LOGGED/);
  } finally { await f.cleanup(); }
});

for (const [name, env] of [
  ['explicit structured false', ['ENVIRONMENT={"dockerEnabled":false}']],
  ['missing structured property', ['ENVIRONMENT={}']],
  ['null structured property', ['ENVIRONMENT={"dockerEnabled":null}']],
  ['historical false', ['DOCKER_ENABLED=false']],
  ['matching structured/historical false', ['ENVIRONMENT={"dockerEnabled":false}', 'DOCKER_ENABLED=false']],
  ['ordinary local settings', ['ENVIRONMENT={"dockerEnabled":false}', `WORKER_LOCAL_ENV=${Buffer.from(JSON.stringify([{ key: 'EXAMPLE', value: 'kept' }])).toString('base64')}`]],
] as const) test(`migration preserves ${name} and disables target Kata privilege`, async () => {
  const f = await fixture();
  try {
    f.source.Config.Env = [...env];
    const j = await f.engine.migrate(f.input);
    expect(j.phase).toBe('committed');
    const replacement = f.options.find((o) => o.name === f.input.sourceName);
    expect(replacement.HostConfig).toMatchObject({ Runtime: 'agentor-kata-qemu', Privileged: false });
    expect(replacement.Env).toEqual(env);
  } finally { await f.cleanup(); }
});

test('explicit legacy target retains inspected structured DinD semantics', async () => {
  const f = await fixture();
  try {
    f.input.record.runtimeProfile = 'kata-qemu';
    f.input.targetProfile = 'legacy-runc';
    f.source.HostConfig.Runtime = 'agentor-kata-qemu';
    f.source.Config.Env = ['ENVIRONMENT={"dockerEnabled":true}'];
    const j = await f.engine.migrate(f.input);
    expect(j.phase).toBe('committed');
    expect(f.options.find((o) => o.name === f.input.sourceName).HostConfig).toMatchObject({ Runtime: 'runc', Privileged: true });
  } finally { await f.cleanup(); }
});

test('restored authority metadata and changed rollback mount sources fail closed', async () => {
  const f = await fixture();
  try {
    await expect(f.engine.preflight({ ...f.input, record: { ...f.input.record, runtimeRestoreApprovalRequired: true } }))
      .rejects.toMatchObject({ code: 'WORKER_RUNTIME_RESTORE_APPROVAL_REQUIRED' });
    const j = await f.engine.migrate(f.input);
    j.phase = 'replacement'; j.mounts[0]!.source = 'foreign-volume'; await f.store.save(j);
    await expect(f.engine.recover(j)).rejects.toThrow(/no longer matches/);
    expect(f.store.get('owner-1', 'worker-1')!.phase).toBe('recovery-required');
    expect(f.containers.has(SOURCE)).toBe(true);
  } finally { await f.cleanup(); }
});

test('ambiguous Docker outcome does not restore or delete until operator establishes daemon quiescence', async () => {
  const f = await fixture();
  try {
    f.fail('timeout');
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN' });
    const j = f.store.get('owner-1', 'worker-1')!;
    expect(j.uncertainOperation).toBe(true);
    expect(f.source.State.Running).toBe(false);
    expect(f.containers.get(REPLACEMENT).State.Running).toBe(true);
    expect(f.restoredRecord).toBeUndefined();
    const before = [...f.events];
    await expect(f.engine.recover(j)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN' });
    expect(f.events).toEqual(before);
    f.fail(undefined); await f.engine.recover(j, true);
    expect(f.data.get('worker-workspace')).toBe('original workspace');
    expect(f.source.State.Running).toBe(true);
  } finally { await f.cleanup(); }
});

test('replacement shared mount access mode mismatch triggers rollback before policy commit', async () => {
  const f = await fixture();
  try {
    f.fail('mount');
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_ROLLED_BACK' });
    expect(f.committedRecord).toBeUndefined();
    expect(f.data.get('worker-workspace')).toBe('original workspace');
  } finally { await f.cleanup(); }
});

test('finalization removes retained evidence without deleting active rootfs or canonical volumes', async () => {
  const f = await fixture();
  try {
    const j = await f.engine.migrate(f.input);
    await f.engine.finalize(j);
    expect(f.store.get('owner-1', 'worker-1')).toBeUndefined();
    expect(f.containers.has(SOURCE)).toBe(false);
    expect(f.containers.has(REPLACEMENT)).toBe(true);
    expect(f.volumes.has('worker-workspace')).toBe(true);
    expect(f.data.get('worker-workspace')).toBe('replacement workspace');
    expect(j.mounts.every((m) => !f.volumes.has(m.backup))).toBe(true);
    expect(f.events.some((e) => e.startsWith('remove-image:'))).toBe(false);
  } finally { await f.cleanup(); }
});

test('rolled-back finalization never deletes an image reached through a repointed snapshot tag', async () => {
  const f = await fixture();
  try {
    f.fail('create');
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_ROLLED_BACK' });
    const journal = f.store.get('owner-1', 'worker-1')!;
    f.repointSnapshot(`sha256:${'e'.repeat(64)}`);
    await expect(f.engine.finalize(journal)).rejects.toThrow(/reference changed/);
    expect(f.events.some((event) => event.startsWith('remove-image:'))).toBe(false);
    expect(f.store.get('owner-1', 'worker-1')).toBeDefined();
  } finally { await f.cleanup(); }
});

test('corrupt migration owner is quarantined without hiding healthy-owner pending work', async () => {
  const f = await fixture();
  try {
    const j = await f.engine.migrate(f.input); j.phase = 'replacement'; await f.store.save(j);
    await mkdir(join(f.dir, 'users', 'corrupt-owner'), { recursive: true });
    await writeFile(join(f.dir, 'users', 'corrupt-owner', 'worker-runtime-migrations.v1.json'), '{invalid');
    const reopened = new RuntimeMigrationStore(f.dir); await reopened.init();
    expect(reopened.pending().map((pending) => pending.workerId)).toEqual(['worker-1']);
    expect(reopened.hasUnavailableOwners()).toBe(true);
    expect(() => reopened.isBlocked('corrupt-owner', 'worker-2')).toThrow(/unavailable/);
  } finally { await f.cleanup(); }
});

test('durable mutation intent after process death requires operator confirmation before recovery', async () => {
  const f = await fixture();
  try {
    const j = await f.engine.migrate(f.input);
    j.phase = 'replacement'; j.inFlightOperation = 'getContainer start'; await f.store.save(j);
    const before = [...f.events];
    await expect(f.engine.recover(j)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN' });
    expect(f.events).toEqual(before);
    await expect(f.engine.finalize(j)).rejects.toThrow(/recovery/);
    await f.engine.recover(j, true);
    expect(f.source.State.Running).toBe(true);
    expect(f.data.get('worker-workspace')).toBe('original workspace');
  } finally { await f.cleanup(); }
});

for (const stage of [1, 2, 3]) test(`administrator revocation at migration authorization stage ${stage} rolls back before publication`, async () => {
  const f = await fixture();
  try {
    f.revokeAt(stage);
    await expect(f.engine.migrate(f.input)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_MIGRATION_ROLLED_BACK' });
    expect(f.committedRecord).toBeUndefined();
    expect(f.source.State.Running).toBe(true);
    expect(f.data.get('worker-workspace')).toBe('original workspace');
  } finally { await f.cleanup(); }
});
