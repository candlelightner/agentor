import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, chmod, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { IncusOfflineArchiveHelper } from '../../orchestrator/server/utils/incus-offline-archive-helper';
import { IncusRequestRejected } from '../../orchestrator/server/utils/incus-client';
import { isOperationHelperActive, registerOperationHelper } from '../../orchestrator/server/utils/operation-helper-registry';
import type { Config } from '../../orchestrator/server/utils/config';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

async function fixture(run: (fixture: any) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'incus-offline-backup-test-'));
  const directory = join(dataDir, 'incus-backup-helpers'), installation = randomUUID();
  const owner = { id: randomUUID(), userId: randomUUID(), containerName: 'original-worker' };
  const sources = { workspace: 'canonical-workspace', agents: 'canonical-agents' };
  const calls: any[] = [], controller = new AbortController();
  let instance: any, copied: any;
  const originalDocker = { name: 'canonical-docker', project: 'agentor', type: 'custom', content_type: 'block',
    created_at: '2026-01-01T00:00:00Z', config: { 'volatile.uuid': randomUUID(), size: '5GiB' },
    used_by: ['/1.0/instances/original-worker?project=agentor'], bytes: 'persisted Docker bytes' };
  const control = { failure: '', terminal: 'Success', operationMissing: false, capture: undefined as any,
    source: undefined as any, acceptedPersistenceFailure: false, cancelledAfterCreate: false,
    cancelledAfterCopy: false };
  const receipt = async () => {
    const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
    return names.length ? JSON.parse(await readFile(join(directory, names[0]), 'utf8')) : undefined;
  };
  const absent = () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); };
  const mutate = async (kind: string, accepted: any, action: () => void) => {
    calls.push([kind]);
    expect((await receipt()).pending).toEqual({ kind });
    action();
    if (control.failure === `unknown-${kind}`) throw new Error('lost acknowledgement');
    if (control.acceptedPersistenceFailure) await chmod(directory, 0o500);
    await accepted('/1.0/operations/' + randomUUID());
    expect((await receipt()).pending.kind).toBe(kind);
    if (control.failure === `pending-${kind}`) throw new Error('wait timed out');
  };
  const client: any = {
    endpoint: 'https://incus.test',
    getImageAlias: async () => ({ target: 'a'.repeat(64) }),
    getImage: async () => ({ type: 'virtual-machine', fingerprint: 'a'.repeat(64), properties: {
      source_image_id: 'sha256:' + 'b'.repeat(64), recipe_id: 'c'.repeat(64), source_architecture: 'amd64',
      converter_version: 'v0.4.0', bootstrap_generation: '3' } }),
    getInstance: async (name: string) => { calls.push(['inspect', name]); return instance ? structuredClone(instance) : absent(); },
    createInstance: async (spec: any, accepted: any) => {
      calls.push(['spec', spec]);
      if (spec.devices.docker && copied) {
        expect((await receipt()).copy).toEqual({ created_at: copied.created_at, config: copied.config });
        expect((await receipt()).pending).toEqual({ kind: 'create' });
      }
      if (control.failure === 'rejected-create') { calls.push(['create']); throw new IncusRequestRejected('denied', 403, 403); }
      await mutate('create', accepted, () => { instance = { ...spec, status: 'Stopped',
        config: { ...spec.config, 'volatile.uuid': randomUUID(), 'volatile.base_image': spec.source.fingerprint } };
        if (copied) copied.used_by = [`/1.0/instances/${spec.name}?project=agentor`]; });
      if (control.cancelledAfterCreate) controller.abort(new Error('cancelled'));
      return structuredClone(instance);
    },
    startInstance: async (_name: string, accepted: any) => mutate('start', accepted, () => { instance.status = 'Running'; }),
    stopInstance: async (_name: string, _options: any, accepted: any) => mutate('stop', accepted, () => { instance.status = 'Stopped'; }),
    deleteInstance: async (_name: string, accepted: any) => mutate('delete', accepted, () => {
      instance = undefined;
      if (copied) copied.used_by = copied.used_by.filter((reference: string) =>
        reference !== `/1.0/instances/${_name}?project=agentor`);
    }),
    getCustomVolume: async (pool: string, name: string) => {
      calls.push(['volume', pool, name]);
      if (name === originalDocker.name) return structuredClone(originalDocker);
      return copied && copied.name === name ? structuredClone(copied) : absent();
    },
    copyCustomVolume: async (pool: string, source: string, name: string, config: any, accepted: any) => {
      calls.push(['copy-spec', pool, source, name, config]);
      if (control.failure === 'rejected-copy') { calls.push(['copy']); throw new IncusRequestRejected('copy denied', 403, 403); }
      await mutate('copy', accepted, () => { copied = { name, project: 'agentor', type: 'custom', content_type: 'block',
        created_at: '2026-02-01T00:00:00Z', config: { ...config, size: '5GiB', 'volatile.uuid': randomUUID() },
        used_by: [], bytes: originalDocker.bytes }; });
      if (control.cancelledAfterCopy) controller.abort(new Error('cancelled after copy'));
    },
    deleteCustomVolume: async (_pool: string, name: string, accepted: any) => {
      expect(name).toBe(copied?.name); expect(copied?.used_by).toEqual([]);
      return mutate('delete-copy', accepted, () => { copied = undefined; });
    },
    request: async () => control.operationMissing ? absent() : { status: control.terminal, status_code: control.terminal === 'Running' ? 103 : 200 },
    execStream: async (_name: string, command: string[]) => {
      calls.push(['exec', command]); return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        result: Promise.resolve(0), close() { calls.push(['close']); } };
    },
  };
  const helper = new IncusOfflineArchiveHelper({ dataDir, incusStoragePool: 'pool', incusProject: 'agentor', incusWorkerImage: 'trusted-helper' } as Config, client, installation);
  const invoke = (selected: any = sources) => helper.withGuest(owner, selected, async (name?: string) => {
    calls.push(['source', name]); if (control.source) await control.source(name);
  }, controller.signal, async (name: string, assertHelper: () => Promise<void>) => {
    calls.push(['capture', name]);
    expect(isOperationHelperActive((await receipt()).id)).toBe(true);
    return control.capture ? control.capture(name, assertHelper) : 'archive';
  });
  try { await run({ helper, invoke, owner, sources, calls, control, receipt, directory, controller,
    getInstance: () => instance, setInstance: (value: any) => { instance = value; },
    getCopy: () => copied, getOriginalDocker: () => originalDocker }); }
  finally { await chmod(directory, 0o700).catch(() => {}); await rm(dataDir, { recursive: true, force: true }); }
}

test('offline archive helper is pinned, networkless and read-only with exact receipt cleanup', async () => {
  await fixture(async ({ invoke, calls, receipt, sources, owner }) => {
    expect(await invoke()).toBe('archive'); expect(await receipt()).toBeUndefined();
    const spec = calls.find((item: any) => item[0] === 'spec')[1];
    expect(spec.source).toEqual({ type: 'image', fingerprint: 'a'.repeat(64) });
    expect(spec.profiles).toEqual([]);
    expect(spec.devices).toEqual({ root: { type: 'disk', path: '/', pool: 'pool' },
      workspace: { type: 'disk', source: sources.workspace, pool: 'pool', path: '/workspace', readonly: 'true' },
      agents: { type: 'disk', source: sources.agents, pool: 'pool', path: '/home/agent/.agent-data', readonly: 'true' } });
    expect(spec.config['user.agentor.id']).toBeUndefined();
    expect(calls.filter((item: any) => ['create', 'start', 'stop', 'delete'].includes(item[0])).map((item: any) => item[0]))
      .toEqual(['create', 'start', 'stop', 'delete']);
    expect(calls.filter((item: any) => item[0] === 'source').map((item: any) => item[1]))
      .toEqual([undefined, undefined, spec.name, spec.name, undefined]);
    expect(calls.filter((item: any) => item[0] === 'inspect').every((item: any) => item[1] !== owner.containerName)).toBe(true);
    expect(calls.find((item: any) => item[0] === 'exec')[1]).toEqual(['true']);
  });
});

test('managed capture permits only the fixed readonly volume layout, not mixed or caller-selected paths', async () => {
  await fixture(async ({ invoke, calls, receipt }) => {
    expect(await invoke({ managed: 'canonical-managed' })).toBe('archive');
    expect(await receipt()).toBeUndefined();
    const spec = calls.find((item: any) => item[0] === 'spec')[1];
    expect(spec.profiles).toEqual([]);
    expect(spec.devices).toEqual({ root: { type: 'disk', path: '/', pool: 'pool' },
      managed: { type: 'disk', source: 'canonical-managed', pool: 'pool', path: '/volume', readonly: 'true' } });
  });
  for (const sources of [{ managed: 'canonical-managed', path: '/etc' },
    { managed: 'canonical-managed', workspace: 'canonical-workspace', agents: 'canonical-agents' },
    { managed: '../foreign' }]) await fixture(async ({ invoke, calls }) => {
    await expect(invoke(sources)).rejects.toThrow('malformed');
    expect(calls.some((item: any) => item[0] === 'create')).toBe(false);
  });
});

test('lost acknowledgement of every mutation is retained and blocks a second helper', async () => {
  for (const kind of ['create', 'start', 'stop', 'delete']) await fixture(async ({ invoke, control, receipt, calls }) => {
    control.failure = `unknown-${kind}`;
    await expect(invoke()).rejects.toThrow();
    expect((await receipt()).pending).toEqual({ kind });
    const before = calls.filter((item: any) => ['create', 'start', 'stop', 'delete'].includes(item[0])).length;
    await expect(invoke()).rejects.toThrow('Unresolved');
    expect(calls.filter((item: any) => ['create', 'start', 'stop', 'delete'].includes(item[0]))).toHaveLength(before);
  });
});

test('nonterminal and expired accepted operations never authorize more helper mutations', async () => {
  for (const kind of ['create', 'start', 'stop', 'delete']) for (const expired of [false, true])
    await fixture(async ({ invoke, control, receipt, calls }) => {
      control.failure = `pending-${kind}`; control.terminal = 'Running'; control.operationMissing = expired;
      await expect(invoke()).rejects.toThrow();
      expect((await receipt()).pending).toEqual({ kind, operation: expect.stringMatching(/^\/1\.0\/operations\//) });
      const mutations = calls.filter((item: any) => ['create', 'start', 'stop', 'delete'].includes(item[0]));
      expect(mutations[mutations.length - 1][0]).toBe(kind);
    });
});

test('definitive create rejection clears only attempted receipt; safe cancellation removes captured helper', async () => {
  for (const cancelled of [false, true]) await fixture(async ({ invoke, control, receipt, calls }) => {
    if (cancelled) control.cancelledAfterCreate = true; else control.failure = 'rejected-create';
    await expect(invoke()).rejects.toThrow(); expect(await receipt()).toBeUndefined();
    expect(calls.some((item: any) => item[0] === 'capture')).toBe(false);
    expect(calls.some((item: any) => item[0] === 'delete')).toBe(cancelled);
    expect(calls.some((item: any) => item[0] === 'start')).toBe(false);
  });
});

test('final source proof errors cannot return archive and cleanup excludes the removed helper', async () => {
  for (const cleanupFails of [false, true]) await fixture(async ({ invoke, control, receipt, calls }) => {
    let helperProofs = 0, sourceProofs = 0;
    control.source = async (name?: string) => {
      if (name && ++helperProofs === 2) throw new Error('final source changed');
      if (!name && ++sourceProofs === 3 && cleanupFails) throw new Error('cleanup source changed');
    };
    await expect(invoke()).rejects.toThrow(cleanupFails ? 'cleanup source changed' : 'final source changed');
    expect(calls.some((item: any) => item[0] === 'delete')).toBe(true);
    expect(!!await receipt()).toBe(cleanupFails);
  });
});

test('foreign UUID, image, profiles, raw config or writable devices prohibit capture success and cleanup', async () => {
  for (const drift of ['uuid', 'image', 'profiles', 'readonly', 'worker', 'nic', 'raw', 'expanded-raw', 'limits', 'stopped'])
    await fixture(async ({ invoke, control, getInstance, receipt, calls }) => {
      control.capture = async (_name: string, check: () => Promise<void>) => {
        const instance = getInstance();
        if (drift === 'uuid') instance.config['volatile.uuid'] = randomUUID();
        if (drift === 'image') instance.config['volatile.base_image'] = 'e'.repeat(64);
        if (drift === 'profiles') instance.profiles = ['default'];
        if (drift === 'readonly') instance.devices.workspace.readonly = 'false';
        if (drift === 'worker') instance.config['user.agentor.id'] = randomUUID();
        if (drift === 'nic') instance.devices.eth0 = { type: 'nic', network: 'foreign-network' };
        if (drift === 'raw') instance.config['raw.qemu'] = '-netdev user,id=hidden';
        if (drift === 'expanded-raw') instance.expanded_config = { ...instance.config, 'raw.qemu': '-netdev user,id=hidden' };
        if (drift === 'limits') instance.config['limits.memory'] = '8GiB';
        if (drift === 'stopped') instance.status = 'Stopped';
        await check(); return 'archive';
      };
      await expect(invoke()).rejects.toThrow(drift === 'stopped' ? 'not running' : 'isolation changed');
      expect(!!await receipt()).toBe(drift !== 'stopped');
      if (drift !== 'stopped') expect(calls.some((item: any) => item[0] === 'stop' || item[0] === 'delete')).toBe(false);
      else expect(calls.some((item: any) => item[0] === 'delete')).toBe(true);
    });
});

test('accepted receipt persistence failure keeps unknown authority instead of cleanup', async () => {
  await fixture(async ({ invoke, control, receipt, calls }) => {
    control.acceptedPersistenceFailure = true;
    await expect(invoke()).rejects.toThrow('acknowledgement is unknown');
    expect((await receipt()).pending).toEqual({ kind: 'create' });
    expect(calls.some((item: any) => item[0] === 'start' || item[0] === 'delete')).toBe(false);
  });
});

test('same-owner claim is synchronous; malformed, symlink and FIFO recovery remain quarantined', async () => {
  await fixture(async ({ invoke, control, receipt, calls }) => {
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const active = new Promise<void>(resolve => { entered = resolve; });
    control.capture = async () => { entered(); await hold; return 'archive'; };
    const first = invoke(); await active;
    try { await expect(invoke()).rejects.toThrow('already owns'); } finally { release(); }
    expect(await first).toBe('archive'); expect(await receipt()).toBeUndefined();
    expect(calls.filter((item: any) => item[0] === 'create')).toHaveLength(1);
  });
  for (const mode of ['malformed', 'symlink', 'fifo']) await fixture(async ({ invoke, directory, calls }) => {
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, randomUUID() + '.json');
    if (mode === 'malformed') await writeFile(path, '{}', { mode: 0o600 });
    if (mode === 'symlink') await symlink('/dev/null', path);
    if (mode === 'fifo') {
      const { execFileSync } = await import('node:child_process'); execFileSync('mkfifo', ['-m', '600', path]);
    }
    await expect(invoke()).rejects.toThrow();
    expect(calls.some((item: any) => item[0] === 'create')).toBe(false);
  });
});

test('different worker tolerates only exact active temporary receipts; inactive and malformed ones remain quarantined', async () => {
  await fixture(async ({ helper, invoke, owner, sources, control, receipt, directory, calls }) => {
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const active = new Promise<void>(resolve => { entered = resolve; });
    control.capture = async () => { entered(); await hold; return 'archive'; };
    const first = invoke(); await active;
    const operationId = (await receipt()).id;
    const other = { ...owner, id: randomUUID(), containerName: 'different-worker' };
    const second = () => helper.withGuest(other, { workspace: sources.workspace + '-second', agents: sources.agents + '-second' },
      async () => {}, undefined, async () => 'unused');
    // Reproduce exactly the production writer's jobUUID.nonceUUID.tmp path,
    // including its not-yet-complete content before write/sync/rename finishes.
    const temporary = join(directory, `${operationId}.${randomUUID()}.tmp`);
    const malformed = join(directory, `${operationId}.not-a-uuid.tmp`);
    try {
      expect(isOperationHelperActive(operationId)).toBe(true);
      await writeFile(temporary, '{', { mode: 0o600 });
      await writeFile(malformed, '{', { mode: 0o600 });
      const before = calls.filter((item: any) => item[0] === 'create').length;
      await expect(second()).rejects.toThrow('operator inspection');
      expect(calls.filter((item: any) => item[0] === 'create')).toHaveLength(before);
      await unlink(malformed);
      // Native rejection is deliberate: reaching create proves independent
      // discovery completed, without replacing the first mock incarnation.
      control.failure = 'rejected-create';
      await expect(second()).rejects.toThrow('denied');
      expect(calls.filter((item: any) => item[0] === 'create')).toHaveLength(before + 1);
      expect(await readFile(temporary, 'utf8')).toBe('{');
    } finally { release(); }
    expect(await first).toBe('archive');
    expect(isOperationHelperActive(operationId)).toBe(false);
    const beforeInactive = calls.filter((item: any) => item[0] === 'create').length;
    await expect(second()).rejects.toThrow('operator inspection');
    expect(calls.filter((item: any) => item[0] === 'create')).toHaveLength(beforeInactive);
    expect(await readFile(temporary, 'utf8')).toBe('{');
  });
});

test('a peer receipt or temporary that vanishes after enumeration is skipped only after local ENOENT proof', async () => {
  for (const kind of ['receipt', 'temporary']) await fixture(async ({ invoke, directory, calls }) => {
    await mkdir(directory, { mode: 0o700 });
    const peer = randomUUID(), filename = kind === 'receipt' ? `${peer}.json` : `${peer}.${randomUUID()}.tmp`;
    await writeFile(join(directory, filename), '{}', { mode: 0o600 });
    const releasePeer = registerOperationHelper(peer), original = fsPromises.opendir;
    let disappeared = false;
    // Test-local builtin replacement controls the exact enumeration→open
    // interleaving, without a runtime hook or timing-dependent cleanup sleep.
    fsPromises.opendir = (async (...args: Parameters<typeof original>) => {
      const real = await original(...args);
      return { async *[Symbol.asyncIterator]() {
        for await (const item of real) {
          if (item.name === filename) {
            await unlink(join(directory, filename)); releasePeer(); disappeared = true;
          }
          yield item;
        }
      } } as Awaited<ReturnType<typeof original>>;
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      expect(await invoke()).toBe('archive');
      expect(disappeared).toBe(true);
      expect(calls.filter((item: any) => item[0] === 'create')).toHaveLength(1);
    } finally { fsPromises.opendir = original; syncBuiltinESMExports(); releasePeer(); }
  });
});

test('Docker direct source is a fixed readonly block device with no copy, NIC or caller-selected mount path', async () => {
  await fixture(async ({ invoke, calls, receipt, getOriginalDocker }) => {
    const original = structuredClone(getOriginalDocker());
    expect(await invoke({ docker: 'canonical-docker', copy: false })).toBe('archive');
    const spec = calls.find((item: any) => item[0] === 'spec')[1];
    expect(spec.profiles).toEqual([]);
    expect(spec.devices).toEqual({ root: { type: 'disk', path: '/', pool: 'pool' },
      docker: { type: 'disk', source: 'canonical-docker', pool: 'pool', readonly: 'true' } });
    expect(calls.some((item: any) => ['copy', 'delete-copy'].includes(item[0]))).toBe(false);
    expect(getOriginalDocker()).toEqual(original); expect(await receipt()).toBeUndefined();
  });
  for (const sources of [{ docker: 'canonical-docker' }, { docker: '../foreign', copy: false },
    { docker: 'canonical-docker', copy: 'true' }, { docker: 'canonical-docker', copy: false, path: '/var/lib/docker' },
    { docker: 'canonical-docker', copy: true, managed: 'canonical-managed' }]) await fixture(async ({ invoke, calls }) => {
    await expect(invoke(sources)).rejects.toThrow('malformed');
    expect(calls.some((item: any) => ['copy', 'create'].includes(item[0]))).toBe(false);
  });
});

test('stopped Docker copy acknowledgement precedes helper create and cleanup removes helper before its exact copy', async () => {
  await fixture(async ({ invoke, calls, receipt, owner, control, getCopy, getOriginalDocker }) => {
    const original = structuredClone(getOriginalDocker());
    control.capture = async (name: string, check: () => Promise<void>) => {
      await check(); const state = await receipt(), copy = getCopy();
      expect(state.copy).toEqual({ created_at: copy.created_at, config: copy.config });
      expect(copy.bytes).toBe(original.bytes);
      expect(copy.config).toMatchObject({ 'user.agentor.helper': 'offline-backup-copy',
        'user.agentor.operation': state.id, 'user.agentor.worker': owner.id,
        'user.agentor.owner': owner.userId, 'user.agentor.source': 'canonical-docker' });
      expect(copy.used_by).toEqual([`/1.0/instances/${name}?project=agentor`]);
      expect(getOriginalDocker()).toEqual(original); return 'Docker archive';
    };
    // A copied source must never require the helper in the original volume's references.
    control.source = async () => { expect(getOriginalDocker()).toEqual(original); };
    expect(await invoke({ docker: 'canonical-docker', copy: true })).toBe('Docker archive');
    const spec = calls.find((item: any) => item[0] === 'spec')[1], copyCall = calls.find((item: any) => item[0] === 'copy-spec');
    expect(copyCall.slice(1, 4)).toEqual(['pool', 'canonical-docker', spec.devices.docker.source]);
    expect(spec.devices).toEqual({ root: { type: 'disk', path: '/', pool: 'pool' },
      docker: { type: 'disk', source: copyCall[3], pool: 'pool', readonly: 'true' } });
    expect(calls.filter((item: any) => ['copy', 'create', 'start', 'stop', 'delete', 'delete-copy'].includes(item[0]))
      .map((item: any) => item[0])).toEqual(['copy', 'create', 'start', 'stop', 'delete', 'delete-copy']);
    expect(getCopy()).toBeUndefined(); expect(await receipt()).toBeUndefined(); expect(getOriginalDocker()).toEqual(original);
  });
});

test('lost, unresolved or expired Docker copy and removal acknowledgements quarantine without adoption or resubmission', async () => {
  for (const kind of ['copy', 'delete-copy']) for (const mode of ['unknown', 'running', 'expired', 'terminal'])
    await fixture(async ({ invoke, control, receipt, calls, getOriginalDocker }) => {
      const original = structuredClone(getOriginalDocker());
      control.failure = `${mode === 'unknown' ? 'unknown' : 'pending'}-${kind}`;
      control.terminal = mode === 'terminal' ? 'Success' : 'Running'; control.operationMissing = mode === 'expired';
      await expect(invoke({ docker: 'canonical-docker', copy: true })).rejects.toThrow();
      const state = await receipt(); expect(state.pending.kind).toBe(kind);
      if (mode === 'unknown') expect(state.pending.operation).toBeUndefined();
      else expect(state.pending.operation).toMatch(/^\/1\.0\/operations\//);
      if (kind === 'copy') expect(calls.some((item: any) => item[0] === 'create')).toBe(false);
      const before = calls.filter((item: any) => ['copy', 'create', 'start', 'stop', 'delete', 'delete-copy'].includes(item[0]));
      expect(before[before.length - 1][0]).toBe(kind);
      await expect(invoke({ docker: 'canonical-docker', copy: true })).rejects.toThrow('Unresolved');
      expect(calls.filter((item: any) => ['copy', 'create', 'start', 'stop', 'delete', 'delete-copy'].includes(item[0])))
        .toEqual(before);
      expect(getOriginalDocker()).toEqual(original);
    });
});

test('Docker copy project, type, creation, configuration and reference drift retain nonauthoritative copy', async () => {
  for (const drift of ['project', 'type', 'content', 'created', 'config', 'uuid', 'foreign-reference', 'extra-reference'])
    await fixture(async ({ invoke, control, receipt, calls, getCopy, getOriginalDocker }) => {
      const original = structuredClone(getOriginalDocker());
      control.capture = async (_name: string, check: () => Promise<void>) => {
        const copy = getCopy();
        if (drift === 'project') copy.project = 'foreign';
        if (drift === 'type') copy.type = 'image';
        if (drift === 'content') copy.content_type = 'filesystem';
        if (drift === 'created') copy.created_at = '2026-03-01T00:00:00Z';
        if (drift === 'config') copy.config['raw.mount.options'] = 'rw';
        if (drift === 'uuid') copy.config['volatile.uuid'] = randomUUID();
        if (drift === 'foreign-reference') copy.used_by = ['https://foreign.test/1.0/instances/foreign?project=agentor'];
        if (drift === 'extra-reference') copy.used_by.push('/1.0/instances/foreign?project=agentor');
        await check(); return 'unsafe';
      };
      await expect(invoke({ docker: 'canonical-docker', copy: true })).rejects.toThrow(/copy .*changed|reference is foreign/);
      expect(await receipt()).toBeDefined(); expect(getCopy()).toBeDefined();
      expect(calls.some((item: any) => item[0] === 'delete-copy')).toBe(false);
      expect(getOriginalDocker()).toEqual(original);
    });
});

test('Docker cancellation after copy or capture removes only acknowledged copy; definitive rejection clears reservation', async () => {
  for (const stage of ['copy', 'capture', 'rejected']) await fixture(async ({ invoke, control, receipt, calls, controller, getOriginalDocker }) => {
    const original = structuredClone(getOriginalDocker());
    if (stage === 'copy') control.cancelledAfterCopy = true;
    if (stage === 'rejected') control.failure = 'rejected-copy';
    if (stage === 'capture') control.capture = async (_name: string, check: () => Promise<void>) => {
      controller.abort(new Error('capture cancelled')); await check(); return 'unsafe';
    };
    await expect(invoke({ docker: 'canonical-docker', copy: true })).rejects.toThrow();
    expect(await receipt()).toBeUndefined(); expect(getOriginalDocker()).toEqual(original);
    expect(calls.filter((item: any) => item[0] === 'delete-copy')).toHaveLength(stage === 'rejected' ? 0 : 1);
    expect(calls.filter((item: any) => item[0] === 'create')).toHaveLength(stage === 'capture' ? 1 : 0);
    expect(calls.filter((item: any) => item[0] === 'delete')).toHaveLength(stage === 'capture' ? 1 : 0);
  });
});
