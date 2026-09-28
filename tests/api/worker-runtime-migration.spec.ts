import { test, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRuntimeMigration, RuntimeMigrationStore, type RuntimeMigrationInput } from '../../orchestrator/server/utils/worker-runtime-migration';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });
const SOURCE = 'a'.repeat(64), REPLACEMENT = 'b'.repeat(64), HELPER_IMAGE = `sha256:${'c'.repeat(64)}`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-runtime-migration-'));
  const store = new RuntimeMigrationStore(dir); await store.init();
  const events: string[] = [];
  const options: any[] = [];
  const volumes = new Map<string, any>([['worker-workspace', { Name: 'worker-workspace', Driver: 'local', Options: {}, Labels: {} }],
    ['worker-agents', { Name: 'worker-agents', Driver: 'local', Options: {}, Labels: {} }]]);
  const data = new Map([['worker-workspace', 'original workspace'], ['worker-agents', 'original agents']]);
  const containers = new Map<string, any>();
  const source = { Id: SOURCE, Name: '/agentor-worker-worker-1', Image: 'sha256:source',
    Config: { Image: 'worker:old', Hostname: SOURCE.slice(0, 12), Labels: { 'agentor.id': 'worker-1', 'agentor.managed': 'true' },
      Env: ['DOCKER_ENABLED=false'], Cmd: ['/entrypoint'], Entrypoint: ['/bin/bash'] },
    HostConfig: { Runtime: 'runc', Privileged: false, NetworkMode: 'agentor-net', RestartPolicy: { Name: 'unless-stopped' },
      Binds: ['worker-workspace:/workspace', 'worker-agents:/home/agent/.agent-data', '/data/user/kilo:/home/agent/.agent-data/.kilo/config'] },
    State: { Running: true, Paused: false },
    Mounts: [{ Type: 'volume', Name: 'worker-workspace', Source: '/daemon/workspace', Destination: '/workspace', RW: true },
      { Type: 'volume', Name: 'worker-agents', Source: '/daemon/agents', Destination: '/home/agent/.agent-data', RW: true },
      { Type: 'bind', Source: '/data/user/kilo', Destination: '/home/agent/.agent-data/.kilo/config', RW: true }],
    NetworkSettings: { Networks: { 'agentor-net': { Aliases: ['worker-1'] } } } };
  containers.set(SOURCE, source);
  let fail: 'create' | 'start' | 'validate' | 'commit' | 'restore' | 'timeout' | 'mount' | 'authority' | undefined;
  let restoredRecord: any; let committedRecord: any; let helperCounter = 0;
  let authorizeCount = 0, revokeAt = 0;
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
    commit: async (opts: any) => { events.push('rootfs-snapshot'); expect(find(id).State.Running).toBe(false); return { Id: 'snapshot' }; },
    remove: async () => { const c = find(id); if (!c) throw missing(); events.push(`remove:${c.Id}`); containers.delete(c.Id); },
  });
  const docker: any = {
    getContainer: handle,
    getVolume: (name: string) => ({ inspect: async () => { if (!volumes.has(name)) throw missing(); return volumes.get(name); },
      remove: async () => { events.push(`remove-volume:${name}`); volumes.delete(name); data.delete(name); } }),
    getImage: (name: string) => ({ inspect: async () => ({ Config: { Env: ['BAKED_SETTING=default'] } }),
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
      containers.set(id, { Id: id, Name: `/${opts.name}`, Config: { ...opts }, HostConfig: opts.HostConfig,
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
  const engine = new WorkerRuntimeMigration(docker, store, {
    authorize: async () => { events.push('authorize'); authorizeCount++; if (fail === 'authority' || authorizeCount === revokeAt) throw Object.assign(new Error('administrator revoked'), { statusCode: 403 }); },
    trustedHelperImage: async () => HELPER_IMAGE,
    assertAvailable: async () => { events.push('readiness'); },
    validate: async (id) => { events.push(`validate:${id}`); if (id === REPLACEMENT && (fail === 'validate' || fail === 'restore')) throw new Error('validation failure'); },
    commit: async (j) => { events.push('commit-policy'); if (fail === 'commit') throw new Error('persist failure'); committedRecord = j; },
    restore: async (j) => { events.push('restore-policy'); restoredRecord = j.sourceRecord; },
  });
  return { dir, engine, store, input, source, containers, volumes, data, options, events,
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
    expect(replacement.Image).toBe(j.snapshotImage);
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

for (const phase of ['create', 'start', 'validate', 'commit'] as const) test(`migration ${phase} failure restores original runtime and canonical storage`, async () => {
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
    f.source.Mounts.pop(); f.source.Config.Env = ['DOCKER_ENABLED=true'];
    await expect(f.engine.preflight(f.input)).rejects.toMatchObject({ code: 'KATA_DIND_NOT_VALIDATED' });
    expect(f.source.State.Running).toBe(true);
    expect(f.options).toEqual([]);
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
