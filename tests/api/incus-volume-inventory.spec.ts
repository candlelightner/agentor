import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverIncusVolumes } from '../../orchestrator/server/utils/incus-volume-inventory';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { IncusWorkerStorage } from '../../orchestrator/server/utils/incus-worker-storage';
import { ManagedVolumeStore } from '../../orchestrator/server/utils/managed-volume-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';
import { IncusClient } from '../../orchestrator/server/utils/incus-client';
import { managedVolumeInventory, resolveManagedVolumeSizingResource, resolveManagedVolumeControlTarget } from '../../orchestrator/server/utils/managed-volume-inventory';
import { useConfig, useWorkerStore, useContainerManager } from '../../orchestrator/server/utils/services';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { useManagedVolumeSizingManager, ManagedVolumeSizingManager, INCUS_LIVE_VOLUME_SIZE_SCANNER, INCUS_PATH_VOLUME_SIZE_SCANNER } from '../../orchestrator/server/utils/managed-volume-sizing';
import { readBackupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { IncusVolumeSizeHelper } from '../../orchestrator/server/utils/incus-volume-size-helper';
import { isOperationHelperActive } from '../../orchestrator/server/utils/operation-helper-registry';

(globalThis as any).useLogger ??= () => ({ info() {}, error() {}, warn() {}, debug() {} });

async function fixture(run: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'incus-inventory-test-'));
  const config = { dataDir: root, containerPrefix: 'agentor-worker', incusProject: 'agentor', incusStoragePool: 'pool' } as Config;
  const installation = await backupInstallationId(root), id = randomUUID();
  const worker: any = { id, userId: 'owner', runtimeKind: 'incus-vm', status: 'active' };
  const name = `${config.containerPrefix}-${id}`;
  const store = new ManagedVolumeStore(root); await store.init();
  const v = await store.create('owner', id, '/opt/data', undefined, 'incus-vm');
  const physical = new Map<string, any>(), calls: string[] = [];
  const make = (name: string, content: string, identity: any) => ({ name, type: 'custom', content_type: content,
    project: 'agentor', created_at: '2026-01-02T12:00:00Z', used_by: [], config: {
      'user.agentor.installation': installation, 'user.agentor.owner': 'owner', 'user.agentor.id': id, ...identity } });
  physical.set(v.dockerName, make(v.dockerName, 'filesystem', { 'user.agentor.volume-id': v.id, 'user.agentor.target': v.target }));
  for (const role of ['workspace', 'agents', 'docker']) physical.set(`${name}-${role}`,
    make(`${name}-${role}`, role === 'docker' ? 'block' : 'filesystem', { 'user.agentor.storage-role': role }));
  const instance: any = { name, type: 'virtual-machine', status: 'Running', config: {
    'user.agentor.installation': installation, 'user.agentor.owner': 'owner', 'user.agentor.id': id, 'volatile.uuid': randomUUID() }, devices: {
      managed: { type: 'disk', source: v.dockerName, pool: 'pool', path: v.target },
      workspace: { type: 'disk', source: `${name}-workspace`, pool: 'pool', path: '/workspace' },
      agents: { type: 'disk', source: `${name}-agents`, pool: 'pool', path: '/home/agent/.agent-data' },
      docker: { type: 'disk', source: `${name}-docker`, pool: 'pool' },
    } };
  const client: any = new Proxy({ endpoint: 'https://incus.invalid',
    getCustomVolume: async (_pool: string, name: string) => {
      calls.push('volume:' + name); const value = physical.get(name);
      if (value instanceof Error) throw value;
      if (!value) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return structuredClone(value);
    }, getInstance: async () => { calls.push('instance'); return structuredClone(instance); },
  }, { get(target: any, key) { if (key in target) return target[key]; return () => { throw new Error('Unexpected mutation or Docker call: ' + String(key)); }; } });
  const managed = new IncusManagedVolumeRuntime(config, { client } as any);
  const discover = (workers = [worker], records = [v], extra: any = {}) =>
    discoverIncusVolumes(config, installation, workers, records, { managed, client, ...extra });
  try { await run({ config, installation, worker, v, physical, instance, client, managed, calls, discover, name }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('read-only discovery includes durable Incus managed and built-in data only, and never allocates missing storage', async () => {
  await fixture(async ({ discover, worker, v, physical, calls, name, client, config, installation }) => {
    const resources = await discover([worker, { ...worker, id: 'legacy', runtimeKind: undefined }], [v, { ...v, id: randomUUID(), storageRuntimeKind: undefined }]);
    expect(resources.size).toBe(4);
    for (const resource of resources.values()) expect(resource).toMatchObject({ status: 'present', live: false, attached: false });
    expect(calls).toHaveLength(4);
    physical.delete(`${name}-workspace`); physical.delete(v.dockerName);
    const missing = await discover();
    expect(missing.get(v.id)).toMatchObject({ status: 'missing' });
    expect([...missing.values()].find(r => r.purpose === 'workspace')?.status).toBe('missing');
    expect(await new IncusWorkerStorage(client, config, installation).inspectVolume(
      { id: worker.id, userId: worker.userId, containerName: name }, 'workspace')).toBeUndefined();
  });
});

test('per-resource missing, unavailable, foreign and quarantine observations cannot poison unrelated verified data', async () => {
  await fixture(async ({ discover, physical, v, name, worker, calls }) => {
    physical.set(`${name}-workspace`, Object.assign(new Error('transport'), { statusCode: 503 }));
    physical.get(`${name}-agents`).config['user.agentor.owner'] = 'foreign';
    physical.get(v.dockerName).created_at = '0001-01-01T00:00:00Z';
    const resources = await discover();
    expect(resources.get(v.id)?.status).toBe('quarantined');
    expect([...resources.values()].find(r => r.purpose === 'workspace')?.status).toBe('unavailable');
    expect([...resources.values()].find(r => r.purpose === 'agent-data')?.status).toBe('foreign');
    expect([...resources.values()].find(r => r.purpose === 'docker-in-docker')?.status).toBe('present');
    calls.length = 0;
    for (const marker of [{ deletionPending: true }, { incusRecreation: { nonce: randomUUID() } }]) {
      const quarantined = await discover([{ ...worker, ...marker }]);
      expect([...quarantined.values()].every(r => r.status === 'quarantined')).toBe(true);
    }
    expect(calls).toEqual([]);
    expect((await discover([worker], [{ ...v, incusLive: {} }])).get(v.id)?.status).toBe('quarantined');
    expect((await discover([worker], [v], { isRecoveryBlocked: () => true })).get(v.id)?.status).toBe('quarantined');
  });
});

test('live references require exact VM metadata, UUID, disk layout and current daemon state', async () => {
  await fixture(async ({ discover, physical, v, name, instance }) => {
    physical.get(v.dockerName).used_by = [`/1.0/instances/${name}?project=agentor`];
    expect((await discover()).get(v.id)).toMatchObject({ status: 'present', live: true, attached: true,
      instanceIncarnation: instance.config['volatile.uuid'] });
    for (const [field, wrong] of [['user.agentor.installation', randomUUID()], ['user.agentor.owner', 'foreign'],
      ['user.agentor.id', randomUUID()], ['volatile.uuid', 'invalid']]) {
      const old = instance.config[field]; instance.config[field] = wrong;
      expect((await discover()).get(v.id)).toMatchObject({ status: 'foreign', live: undefined, incarnation: undefined });
      instance.config[field] = old;
    }
    instance.devices.managed.path = '/opt/wrong';
    expect((await discover()).get(v.id)?.status).toBe('foreign'); instance.devices.managed.path = v.target;
    instance.status = 'Starting'; expect((await discover()).get(v.id)?.status).toBe('unavailable');
    instance.status = 'Stopped'; expect((await discover()).get(v.id)).toMatchObject({ status: 'present', live: false, attached: true });
  });
});

test('unknown or foreign references and missing durable worker authority never grant offline or live scan authority', async () => {
  await fixture(async ({ discover, physical, v, name }) => {
    for (const ref of ['/1.0/instances/foreign?project=agentor', `/1.0/instances/${name}?project=foreign`,
      `https://foreign.invalid/1.0/instances/${name}?project=agentor`, `/1.0/instances/${name}?project=agentor&unexpected=true`]) {
      physical.get(v.dockerName).used_by = [ref];
      const resource = (await discover()).get(v.id)!;
      expect(['foreign', 'unavailable']).toContain(resource.status);
      expect(resource.incarnation).toBeUndefined(); expect(resource.live).toBeUndefined();
    }
    physical.get(v.dockerName).used_by = [`/1.0/instances/${name}?project=agentor`];
    expect((await discover([], [v])).get(v.id)?.status).toBe('quarantined');
    physical.get(v.dockerName).used_by = undefined;
    expect((await discover()).get(v.id)).toMatchObject({ status: 'unavailable', incarnation: undefined, live: undefined });
    physical.get(v.dockerName).used_by = [];
    physical.get(v.dockerName).project = 'foreign';
    expect((await discover()).get(v.id)?.status).toBe('foreign');
    physical.get(v.dockerName).project = 'agentor';
    expect((await discover([], [{ ...v, retainedAfterAccountDeletion: true }])).get(v.id)).toMatchObject({
      status: 'present', live: false, ownerKey: 'platform' });
  });
});

test('cache hashes require positive creation identity and invalidate after physical recreation without using mutable size config', async () => {
  await fixture(async ({ discover, physical, v }) => {
    const first = (await discover()).get(v.id)!.incarnation;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    physical.get(v.dockerName).config.size = '20GiB';
    expect((await discover()).get(v.id)!.incarnation).toBe(first);
    physical.get(v.dockerName).created_at = '2026-01-03T12:00:00Z';
    expect((await discover()).get(v.id)!.incarnation).not.toBe(first);
    for (const created of ['', 'invalid', '1', '1970-01-01T00:00:00Z']) {
      physical.get(v.dockerName).created_at = created;
      expect((await discover()).get(v.id)).toMatchObject({ status: 'quarantined', incarnation: undefined });
    }
  });
});

async function integratedFixture(run: (f: any) => Promise<void>) {
  await fixture(async f => {
    const config = useConfig(), workers = useWorkerStore(), manager = useManagedVolumeManager();
    useContainerManager();
    const sizing = useManagedVolumeSizingManager();
    const original = { config: { ...config }, workerList: workers.list, init: manager.init,
      list: manager.store.list, forWorker: manager.store.forWorker, workerGet: workers.get, incus: (manager as any).incus, docker: manager.runtime.docker,
      sizingInit: sizing.init, client: IncusClient.fromConfig };
    Object.assign(config, f.config); workers.list = () => [f.worker]; manager.init = async () => {};
    manager.store.list = () => [f.v]; (manager as any).incus = f.managed;
    manager.store.forWorker = (owner, id) => owner === f.worker.userId && id === f.worker.id ? [f.v] : [];
    workers.get = (owner, id) => owner === f.worker.userId && id === f.worker.id ? f.worker : undefined;
    let dockerCalls = 0;
    (manager.runtime as any).docker = new Proxy({}, { get: () => async () => { dockerCalls++; throw new Error('Docker unavailable'); } });
    sizing.init = async () => {}; IncusClient.fromConfig = () => f.client;
    try { await run({ ...f, dockerCalls: () => dockerCalls }); }
    finally {
      Object.assign(config, original.config); workers.list = original.workerList;
      manager.init = original.init; manager.store.list = original.list; manager.store.forWorker = original.forWorker;
      workers.get = original.workerGet; (manager as any).incus = original.incus;
      (manager.runtime as any).docker = original.docker; sizing.init = original.sizingInit; IncusClient.fromConfig = original.client;
    }
  });
}

test('production resolver dispatches durable Incus identities without Docker probes and retains owner/subtree authority', async () => {
  await integratedFixture(async ({ worker, v, dockerCalls }) => {
    const resource = await resolveManagedVolumeSizingResource(v.id, { userId: worker.userId });
    expect(resource).toMatchObject({ runtimeKind: 'incus-vm', ownerKey: worker.userId, incus: { target: v.target, attached: false } });
    expect(await resolveManagedVolumeSizingResource(v.id, { userId: 'foreign' })).toBeUndefined();
    expect(await resolveManagedVolumeSizingResource(v.id, { userId: worker.userId, workerIds: new Set() })).toBeUndefined();
    expect(dockerCalls()).toBe(0);
    v.retainedAfterAccountDeletion = true;
    expect(await resolveManagedVolumeSizingResource(v.id, { userId: worker.userId })).toBeUndefined();
    expect(await resolveManagedVolumeSizingResource(v.id, { platform: true })).toMatchObject({ ownerKey: 'platform' });
  });
});

test('public Incus inventory does not turn Docker outage into missing VM data or expose private authority', async () => {
  await integratedFixture(async ({ v, worker }) => {
    const inventory = await managedVolumeInventory({ userId: worker.userId });
    expect(inventory.dockerAvailable).toBe(false);
    expect(inventory.volumes).toHaveLength(4);
    const managed = inventory.volumes.find(resource => resource.id === v.id)!;
    expect(managed).toMatchObject({ observed: 'unmounted', canMeasureSize: true, size: { reason: 'not-measured' } });
    for (const resource of inventory.volumes) {
      for (const privateField of ['dockerName', 'volume', 'incarnation', 'instanceIncarnation', 'incus', 'runtimeKind'])
        expect(resource).not.toHaveProperty(privateField);
      expect(resolveManagedVolumeControlTarget(resource.id)).toMatchObject({ userId: worker.userId, workerId: worker.id });
    }
    expect((await managedVolumeInventory({ userId: 'foreign' })).volumes).toEqual([]);
  });
});

test('missing installation identity is read-only unavailable, never regenerated or reinterpreted as Docker', async () => {
  await integratedFixture(async ({ config, v, dockerCalls, calls }) => {
    await rm(join(config.dataDir, 'backup-installation-id'));
    await expect(readBackupInstallationId(config.dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await resolveManagedVolumeSizingResource(v.id, { platform: true })).toBeUndefined();
    await expect(readBackupInstallationId(config.dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(dockerCalls()).toBe(0); expect(calls).toEqual([]);
  });
});

test('detached Incus storage with a now-legacy WorkerRecord is quarantined before either backend probe', async () => {
  await integratedFixture(async ({ worker, v, dockerCalls, calls }) => {
    worker.runtimeKind = 'legacy-docker';
    expect(await resolveManagedVolumeSizingResource(v.id, { platform: true })).toBeUndefined();
    expect(calls).toEqual([]); expect(dockerCalls()).toBe(0);
  });
});

test('live scanner accepts a separate literal path and preserves bounded metadata counting without following symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-live-scan-'));
  try {
    await writeFile(join(root, 'bytes'), 'five!'); await link(join(root, 'bytes'), join(root, 'hardlink'));
    await symlink('/etc', join(root, 'outside'));
    const output = execFileSync('node', ['-e', INCUS_PATH_VOLUME_SIZE_SCANNER, root]).toString();
    expect(JSON.parse(output.slice(output.indexOf('AGENTOR_VOLUME_SIZE ') + 20))).toMatchObject({ ok: true, logicalBytes: '5', entriesScanned: 4 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('active scanner validates the pinned mount source and never reopens a replaced root path', async () => {
  for (const change of ['wrong-source', 'rootfs', 'replace']) {
    const root = await mkdtemp(join(tmpdir(), 'incus-pinned-scan-'));
    try {
      await writeFile(join(root, 'original'), 'original');
      const type = change === 'rootfs' ? 'ext4' : 'virtiofs';
      const source = change === 'wrong-source' ? 'incus_foreign' : 'incus_workspace';
      // Local CI cannot mount virtiofs; only its mountinfo observation is
      // injected. All actual descriptor opening/traversal uses the real FS.
      let script = INCUS_LIVE_VOLUME_SIZE_SCANNER.replace("fs.readFileSync('/proc/self/mountinfo','utf8')",
        '`' + '${rootMount} 0 0:1 / ${ROOT} rw - ' + type + ' ' + source + ' rw`');
      if (change === 'replace') script = script.replace('count(fs.fstatSync(rootFd,{bigint:true}));',
        "fs.renameSync(ROOT,ROOT+'-original');fs.mkdirSync(ROOT);fs.writeFileSync(ROOT+'/replacement','wrong-volume');count(fs.fstatSync(rootFd,{bigint:true}));");
      const result = requireResult(script, root, 'filesystem', 'incus_workspace');
      expect(result.code).toBe(change === 'replace' ? 0 : 2);
      if (change === 'replace') expect(result.value).toMatchObject({ ok: true, logicalBytes: '8', entriesScanned: 2 });
      else expect(result.value.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(root + '-original', { recursive: true, force: true });
    }
  }
});

function requireResult(script: string, ...args: string[]) {
  try { return { code: 0, value: JSON.parse(execFileSync('node', ['-e', script, ...args]).toString().split('AGENTOR_VOLUME_SIZE ')[1]!) }; }
  catch (error: any) { return { code: error.status, value: JSON.parse(error.stdout.toString().split('AGENTOR_VOLUME_SIZE ')[1]!) }; }
}

async function scanFixture(run: (f: any) => Promise<void>) {
  await integratedFixture(async f => {
    const control = { output: 'AGENTOR_VOLUME_SIZE {"ok":true,"allocatedBytes":"8192","logicalBytes":"5000","entriesScanned":3}\n',
      stderr: '', code: 0, hold: false, opens: 0, closed: 0, command: [] as string[], options: undefined as any };
    f.client.execStream = async (_name: string, command: string[], options: any) => {
      control.opens++; control.command = command; control.options = options;
      const stdout = new PassThrough(), stderr = new PassThrough();
      let resolve!: (code: number) => void, reject!: (error: Error) => void, completed = false;
      const result = new Promise<number>((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
      const close = () => { control.closed++; if (!completed) { const error = new Error('cancelled'); stdout.destroy(error); stderr.destroy(error); reject(error); } };
      options.signal.addEventListener('abort', close, { once: true });
      const stdin = new Writable({ final(callback) {
        callback(); if (!control.hold) setImmediate(() => {
          completed = true; stdout.end(control.output); stderr.end(control.stderr); resolve(control.code);
        });
      }, write(_bytes, _encoding, callback) { callback(); } });
      stdout.on('error', () => {}); stderr.on('error', () => {});
      return { stdin, stdout, stderr, result, close };
    };
    f.managed.worker = new IncusWorkerRuntime(f.config, f.client);
    const manager = new ManagedVolumeSizingManager(f.config.dataDir, { docker: { listContainers: async () => [] } as any });
    const resource = { id: f.v.id, dockerName: f.v.dockerName, userId: f.worker.userId, workerId: f.worker.id,
      ownerKey: f.worker.userId, purpose: 'persistent-path', classification: 'managed' as const,
      incarnation: 'a'.repeat(64), live: true, runtimeKind: 'incus-vm' as const,
      incus: { target: f.v.target, deviceKey: 'managed', attached: true, contentType: 'filesystem' as const, instanceIncarnation: f.instance.config['volatile.uuid'] } };
    const start = () => manager.create(f.worker.userId, async () => resource, true);
    const terminal = async (id: string) => {
      await expect.poll(async () => (await manager.get(id))?.status, { timeout: 5000 }).toMatch(/succeeded|failed|cancelled/);
      return manager.get(id);
    };
    await run({ ...f, control, manager, resource, start, terminal });
  });
}

test('Incus sizing reuses the existing job/lifecycle fences without queue reentry or Docker fallback', async () => {
  await scanFixture(async ({ control, manager, resource, start, terminal, calls }) => {
    const job = await start(), result = await terminal(job.id);
    expect(result).toMatchObject({ status: 'succeeded', measurement: { allocatedBytes: 8192, logicalBytes: 5000, consistency: 'live-approximate' } });
    expect(control.opens).toBe(1); expect(control.closed).toBe(1);
    expect(control.command).toContain('systemd-run'); expect(control.command).toContain('MemoryMax=128M');
    expect(control.command).toContain(resource.incus.target); expect(control.command).toContain('timeout');
    expect(control.options).toMatchObject({ user: 0, group: 0, timeoutMs: 60_000 });
    expect(calls.filter((call: string) => call === 'instance').length).toBeGreaterThan(0);
    expect(manager.measurementFor(resource.id, resource.incarnation).state).toBe('known');
  });
});

test('Incus sizing cancels transport and never publishes cancelled, excessive-output or failed-process measurements', async () => {
  for (const failure of ['cancel', 'output', 'exit']) await scanFixture(async ({ control, manager, resource, start, terminal }) => {
    if (failure === 'cancel') control.hold = true;
    if (failure === 'output') control.stderr = 'x'.repeat(32769);
    if (failure === 'exit') control.code = 23;
    const job = await start();
    if (failure === 'cancel') { await expect.poll(() => control.opens).toBe(1); await manager.cancel(job.id); }
    expect((await terminal(job.id)).status).toBe(failure === 'cancel' ? 'cancelled' : 'failed');
    expect(manager.measurementFor(resource.id, resource.incarnation).state).toBe('unknown');
    await expect.poll(() => control.closed).toBeGreaterThan(0);
  });
});

test('stopped/detached, changed instance and quarantined Incus sources never open a scan over rootfs', async () => {
  for (const failure of ['stopped', 'detached', 'incarnation', 'intent', 'record']) await scanFixture(async f => {
    if (failure === 'stopped') f.resource.live = false;
    if (failure === 'detached') f.resource.incus.attached = false;
    if (failure === 'incarnation') f.instance.config['volatile.uuid'] = randomUUID();
    if (failure === 'intent') f.v.incusLive = { id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment: 'unknown' };
    if (failure === 'record') f.worker.runtimeKind = 'legacy-docker';
    const job = await f.start(); expect((await f.terminal(job.id)).status).toBe('failed');
    expect(f.control.opens).toBe(0); expect(f.dockerCalls()).toBe(0);
  });
});

test('offline scanner owns its cleanup handle before initial persistence and rechecks source before publication', async () => {
  for (const change of [false, true]) await integratedFixture(async f => {
    const manager = new ManagedVolumeSizingManager(f.config.dataDir, { docker: { listContainers: async () => [] } as any });
    const originalScan = IncusVolumeSizeHelper.prototype.scan, originalCleanup = IncusVolumeSizeHelper.prototype.cleanup;
    const persist = (manager as any).persistIncusHelper.bind(manager);
    let initialWrites = 0, cleanups = 0;
    (manager as any).persistIncusHelper = async (id: string, state: any) => {
      if (state) { expect(isOperationHelperActive(id)).toBe(true); initialWrites++; }
      await persist(id, state);
      await manager.cleanupStaleHelpers(); // interleave exactly after initial store publication
    };
    IncusVolumeSizeHelper.prototype.cleanup = async () => { cleanups++; };
    IncusVolumeSizeHelper.prototype.scan = async (id, _source, _state, save) => {
      expect(isOperationHelperActive(id)).toBe(true);
      await save(undefined);
      if (change) f.physical.get(f.v.dockerName).created_at = '2026-01-03T12:00:00Z';
      return 'AGENTOR_VOLUME_SIZE {"ok":true,"allocatedBytes":"8192","logicalBytes":"5000","entriesScanned":3}\n';
    };
    try {
      const job = await manager.create(f.worker.userId, async () => {
        const resource = await resolveManagedVolumeSizingResource(f.v.id, { userId: f.worker.userId });
        expect(resource).toBeTruthy(); return resource!;
      }, true);
      await expect.poll(async () => (await manager.get(job.id))?.status).toMatch(/succeeded|failed/);
      expect((await manager.get(job.id))?.status).toBe(change ? 'failed' : 'succeeded');
      expect(initialWrites).toBe(1); expect(cleanups).toBe(0);
      if (change) expect(manager.measurementFor(f.v.id, f.v.incarnation).state).toBe('unknown');
    } finally { IncusVolumeSizeHelper.prototype.scan = originalScan; IncusVolumeSizeHelper.prototype.cleanup = originalCleanup; }
  });
});
