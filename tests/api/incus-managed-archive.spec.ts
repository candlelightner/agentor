import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusOfflineArchiveHelper } from '../../orchestrator/server/utils/incus-offline-archive-helper';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { PortableManagedVolumeRuntime } from '../../orchestrator/server/utils/portable-managed-volume-runtime';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { useConfig, useWorkerStore } from '../../orchestrator/server/utils/services';
import type { Config } from '../../orchestrator/server/utils/config';
import type { IncusClient, IncusInstance, IncusCustomVolume } from '../../orchestrator/server/utils/incus-client';
import type { StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';

type State = 'running' | 'stopped' | 'archived';

async function fixture(state: State, run: (f: any) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'incus-managed-archive-'));
  const installation = await backupInstallationId(dataDir), workerId = randomUUID(), incarnation = randomUUID();
  const config = { dataDir, containerPrefix: 'worker', incusStoragePool: 'pool', incusProject: 'agentor',
    incusEndpoint: 'https://native.invalid' } as Config;
  const record: StoredManagedVolume = { id: randomUUID(), userId: randomUUID(), workerId,
    name: 'models', target: '/opt/models', purpose: 'persistent-path', attached: true,
    seeded: true, state: 'ready', storageRuntimeKind: 'incus-vm', dockerName: '',
    createdAt: '2026-10-05T12:00:00.000Z', updatedAt: '2026-10-05T12:00:00.000Z' };
  record.dockerName = 'agentor-persist-' + record.id;
  const name = 'worker-' + workerId, reference = (instance: string) => `/1.0/instances/${instance}?project=agentor`;
  const volume = { name: record.dockerName, project: 'agentor', type: 'custom', content_type: 'filesystem',
    created_at: '2026-10-05T12:00:00Z', used_by: state === 'archived' ? [] : [reference(name)],
    config: { 'user.agentor.installation': installation, 'user.agentor.owner': record.userId,
      'user.agentor.id': workerId, 'user.agentor.volume-id': record.id, 'user.agentor.target': record.target } } as IncusCustomVolume;
  const original = { name, type: 'virtual-machine', status: state === 'running' ? 'Running' : 'Stopped',
    config: { 'user.agentor.installation': installation, 'user.agentor.owner': record.userId,
      'user.agentor.id': workerId, 'volatile.uuid': incarnation }, devices: {}, expanded_devices: {} } as IncusInstance;
  const calls: any[] = [], controller = new AbortController(), binary = Buffer.from([0, 255, 128, 10, 13, 0]);
  const control = { present: state !== 'archived', mutation: undefined as (() => void) | undefined,
    cleanupValidated: false, proofs: 0, maxBytes: 4096, recordError: false };
  const client: Pick<IncusClient, 'endpoint' | 'getInstance' | 'getCustomVolume' | 'execStream'> = {
    endpoint: config.incusEndpoint,
    getInstance: async () => {
      if (!control.present) throw Object.assign(new Error('absent'), { statusCode: 404 });
      return structuredClone(original);
    },
    getCustomVolume: async (_pool, source) => {
      expect(source).toBe(record.dockerName); return structuredClone(volume);
    },
    execStream: async (instance, command, options) => {
      calls.push(['exec', instance, command, options]);
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const result = new Promise<number>(resolve => stdin.once('finish', () => {
        stdout.end(binary); stderr.end(Buffer.from('diagnostic'));
        control.mutation?.(); resolve(0);
      }));
      return { stdin, stdout, stderr, result, close() { calls.push(['close']); } };
    },
  };
  const worker = new IncusWorkerRuntime(config, client as IncusClient);
  const runtime = new IncusManagedVolumeRuntime(config, worker), key = runtime.deviceKey(record);
  original.devices[key] = runtime.device(record); original.expanded_devices = structuredClone(original.devices);
  const previous = IncusOfflineArchiveHelper.prototype.withGuest;
  IncusOfflineArchiveHelper.prototype.withGuest = async function(owner, sources, assertSource, signal, capture) {
    calls.push(['helper', owner, sources]); await assertSource();
    const helperName = 'abk-' + randomUUID(); volume.used_by.push(reference(helperName));
    try {
      await assertSource(helperName);
      return await capture(helperName, async () => { signal?.throwIfAborted(); });
    } finally {
      volume.used_by = volume.used_by.filter(value => value !== reference(helperName));
      await assertSource(); control.cleanupValidated = true;
    }
  };
  const archivePath = join(dataDir, 'managed.tar');
  const capture = () => runtime.captureArchive(record, { state,
    handle: state === 'archived' ? undefined : 'incus:' + incarnation,
    archivePath, maxBytes: control.maxBytes, signal: controller.signal }, async () => {
      control.proofs++; if (control.recordError) throw new Error('record authority changed');
    });
  try { await run({ runtime, record, volume, original, key, calls, capture, archivePath, binary, control, controller, reference }); }
  finally { IncusOfflineArchiveHelper.prototype.withGuest = previous; await rm(dataDir, { recursive: true, force: true }); }
}

test('running, stopped and archived managed capture preserves raw bytes using only the fixed offline managed role', async () => {
  for (const state of ['running', 'stopped', 'archived'] as State[]) await fixture(state, async f => {
    const before = structuredClone(f.volume), original = structuredClone(f.original);
    expect(await f.capture()).toBe(f.binary.length);
    expect(await readFile(f.archivePath)).toEqual(f.binary);
    expect(f.volume).toEqual(before); expect(f.original).toEqual(original);
    const helper = f.calls.find((call: any) => call[0] === 'helper');
    expect(helper[2]).toEqual({ managed: f.record.dockerName });
    const exec = f.calls.find((call: any) => call[0] === 'exec');
    expect(exec[1]).toMatch(/^abk-/); expect(exec[2].slice(-3)).toEqual(['managed', '[]', 'offline']);
    expect(exec[3]).toMatchObject({ user: 0, group: 0, cwd: '/', timeoutMs: 600_000 });
    expect(f.control.cleanupValidated).toBe(true); expect(f.control.proofs).toBeGreaterThan(4);
  });
});

test('managed source preflight rejects unsettled, foreign and ambiguous storage before helper creation', async () => {
  for (const kind of ['pending', 'unseeded', 'owner', 'project', 'volume-id', 'target', 'reference-origin',
    'reference-project', 'reference-extra-query', 'reference-duplicate', 'reference-missing', 'duplicate-device', 'expanded-device', 'uuid'])
    await fixture('stopped', async f => {
      if (kind === 'pending') f.record.incusLive = { id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment: 'unknown' };
      if (kind === 'unseeded') f.record.seeded = false;
      if (kind === 'owner') f.volume.config['user.agentor.owner'] = 'foreign';
      if (kind === 'project') f.volume.project = 'foreign';
      if (kind === 'volume-id') f.volume.config['user.agentor.volume-id'] = randomUUID();
      if (kind === 'target') f.volume.config['user.agentor.target'] = '/opt/foreign';
      if (kind === 'reference-origin') f.volume.used_by = ['https://foreign.invalid' + f.volume.used_by[0]];
      if (kind === 'reference-project') f.volume.used_by[0] += '&project=foreign';
      if (kind === 'reference-extra-query') f.volume.used_by[0] += '&extra=true';
      if (kind === 'reference-duplicate') f.volume.used_by.push(f.volume.used_by[0]);
      if (kind === 'reference-missing') f.volume.used_by = [];
      if (kind === 'duplicate-device') f.original.devices.extra = { ...f.original.devices[f.key] };
      if (kind === 'expanded-device') f.original.expanded_devices[f.key].readonly = 'true';
      if (kind === 'uuid') f.original.config['volatile.uuid'] = randomUUID();
      await expect(f.capture()).rejects.toThrow(); expect(f.calls).toEqual([]);
    });
  await fixture('archived', async f => {
    f.control.present = true;
    await expect(f.capture()).rejects.toThrow('unexpected compute'); expect(f.calls).toEqual([]);
  });
});

test('late native UUID, devices, status, full metadata, generation and reference drift cannot publish success', async () => {
  for (const kind of ['uuid', 'device', 'expanded-device', 'status', 'generation', 'config', 'reference', 'record'])
    await fixture('running', async f => {
      f.control.mutation = () => {
        if (kind === 'uuid') f.original.config['volatile.uuid'] = randomUUID();
        if (kind === 'device') f.original.devices[f.key].path = '/opt/foreign';
        if (kind === 'expanded-device') f.original.expanded_devices[f.key].readonly = 'true';
        if (kind === 'status') f.original.status = 'Stopped';
        if (kind === 'generation') f.volume.created_at = '2026-10-05T13:00:00Z';
        if (kind === 'config') f.volume.config['user.unrelated'] = 'changed';
        if (kind === 'reference') f.volume.used_by.push('/1.0/instances/foreign?project=agentor');
        if (kind === 'record') f.control.recordError = true;
      };
      await expect(f.capture()).rejects.toThrow();
      expect(f.calls.filter((call: any) => call[0] === 'exec')).toHaveLength(1);
      expect(f.control.cleanupValidated).toBe(false);
      expect(f.volume.used_by.some((ref: string) => ref.includes('/abk-'))).toBe(false);
    });
});

test('byte-limit failure and cancellation retain usable source proof for exact helper cleanup', async () => {
  for (const kind of ['limit', 'cancel']) await fixture('stopped', async f => {
    if (kind === 'limit') f.control.maxBytes = f.binary.length - 1;
    else f.control.mutation = () => f.controller.abort(new Error('cancelled'));
    await expect(f.capture()).rejects.toThrow();
    expect(f.control.cleanupValidated).toBe(true);
    expect(f.volume.used_by).toEqual([f.reference(f.original.name)]);
  });
});

test('native portable dispatch proves archived absence even with zero or noneligible records and never calls Docker', async () => {
  const logger = (globalThis as any).useLogger;
  (globalThis as any).useLogger = () => ({ info() {}, debug() {}, warn() {}, error() {} });
  const config = useConfig(), workers = useWorkerStore(), managed = useManagedVolumeManager();
  await workers.init(); await managed.init();
  const previous = (managed as any).incus;
  const userId = randomUUID(), workerId = randomUUID(), dataDir = await mkdtemp(join(tmpdir(), 'native-portable-dispatch-'));
  let dockerCalls = 0, helperCalls = 0;
  const docker = new Proxy({}, { get() { dockerCalls++; throw new Error('Docker must not be touched'); } });
  const runtime = new PortableManagedVolumeRuntime(dataDir, docker as any);
  const source: Pick<IncusClient, 'getInstance'> = { getInstance: async () => { throw new Error('unused'); } };
  (managed as any).incus = { worker: { client: source }, inspectVolume: async () => { helperCalls++; throw new Error('ineligible'); } };
  try {
    await workers.upsert({ id: workerId, userId, displayName: 'native fixture', status: 'archived', runtimeKind: 'incus-vm',
      createdAt: '2026-10-05T12:00:00.000Z', updatedAt: '2026-10-05T12:00:00.000Z' });
    for (const kind of ['zero', 'detached', 'legacy-backup-path']) {
      if (kind !== 'zero') {
        const v = await managed.store.create(userId, workerId, '/opt/' + kind, kind, 'incus-vm');
        await managed.store.save({ ...v, attached: kind !== 'detached', state: kind === 'detached' ? 'detached' : 'ready',
          seeded: true, purpose: kind === 'legacy-backup-path' ? 'legacy-backup-path' : 'persistent-path' });
      }
      source.getInstance = async () => ({ name: `${config.containerPrefix}-${workerId}` } as any);
      await expect(runtime.captureWithLifecycleFenceHeld({ userId, workerId, state: 'archived',
        outputPath: join(dataDir, 'managed.tar.gz') })).rejects.toThrow('unexpected compute');
      source.getInstance = async () => { throw Object.assign(new Error('native unavailable'), { statusCode: 503 }); };
      await expect(runtime.captureWithLifecycleFenceHeld({ userId, workerId, state: 'archived',
        outputPath: join(dataDir, 'managed.tar.gz') })).rejects.toThrow('native unavailable');
    }
    source.getInstance = async () => { throw Object.assign(new Error('absent'), { statusCode: 404 }); };
    const result = await runtime.captureWithLifecycleFenceHeld({ userId, workerId, state: 'archived',
      outputPath: join(dataDir, 'managed.tar.gz') });
    expect(result.entries).toEqual([]); expect(result.consistency).toBe('offline-read-only');
    expect(result.exclusions.map(item => item.reason).sort()).toEqual(['detached', 'legacy-backup-path']);
    expect(result.localPersistence.every(item => item.included === false)).toBe(true);
    expect(dockerCalls).toBe(0); expect(helperCalls).toBe(0);
  } finally {
    (managed as any).incus = previous;
    await managed.store.removeForUser(userId); await workers.removeForUser(userId);
    if (logger === undefined) delete (globalThis as any).useLogger; else (globalThis as any).useLogger = logger;
    await rm(dataDir, { recursive: true, force: true });
  }
});
