import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusOfflineArchiveHelper } from '../../orchestrator/server/utils/incus-offline-archive-helper';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';

async function fixture(archived: boolean, run: (f: any) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'incus-offline-source-test-'));
  const installation = await backupInstallationId(dataDir), id = randomUUID(), incarnation = randomUUID();
  const owner = { id, userId: 'offline-source-owner', containerName: 'worker-' + id };
  const config = { dataDir, containerPrefix: 'worker', incusStoragePool: 'pool', incusProject: 'agentor',
    incusEndpoint: 'https://native.invalid' } as Config;
  const image = { version: 1, sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64),
    architecture: 'amd64', converterVersion: 'v0.4.0', bootstrapGeneration: '3', fingerprint: 'c'.repeat(64) };
  const volumes: Record<string, any> = {}, devices: Record<string, any> = {};
  const ref = (name: string) => '/1.0/instances/' + name + '?project=agentor';
  for (const role of ['workspace', 'agents']) {
    const name = owner.containerName + '-' + role;
    devices[role] = { type: 'disk', pool: 'pool', source: name, path: role === 'workspace' ? '/workspace' : '/home/agent/.agent-data' };
    volumes[name] = { name, project: 'agentor', type: 'custom', content_type: 'filesystem',
      created_at: '2026-10-05T12:00:00Z', used_by: archived ? [] : [ref(owner.containerName)],
      config: { 'user.agentor.installation': installation, 'user.agentor.owner': owner.userId,
        'user.agentor.id': id, 'user.agentor.storage-role': role,
        ...(role === 'workspace' ? { 'user.agentor.image-source': JSON.stringify(image) } : {}) } };
  }
  const original: any = { name: owner.containerName, type: 'virtual-machine', status: 'Stopped', devices,
    config: { 'user.agentor.installation': installation, 'user.agentor.owner': owner.userId,
      'user.agentor.id': id, 'volatile.uuid': incarnation } };
  const calls: any[] = [], binary = Buffer.from([0,255,128,10]), controller = new AbortController();
  const control = { mutation: undefined as any, present: !archived, cleanupValidated: false };
  const client: any = {
    endpoint: config.incusEndpoint,
    getInstance: async () => { if (control.present) return structuredClone(original);
      throw Object.assign(new Error('absent'), { statusCode: 404 }); },
    getCustomVolume: async (_pool: string, name: string) => structuredClone(volumes[name]),
    execStream: async (name: string, command: string[]) => {
      calls.push(['exec', name, command]);
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      stdin.once('finish', () => { stdout.end(binary); stderr.end(); });
      const result = new Promise<number>(resolve => stdin.once('finish', () => {
        control.mutation?.(); resolve(0);
      }));
      return { stdin, stdout, stderr, result, close() {} };
    },
  };
  const previous = IncusOfflineArchiveHelper.prototype.withGuest;
  IncusOfflineArchiveHelper.prototype.withGuest = async function(owner, sources, assertSource, _signal, capture) {
    calls.push(['helper', owner, sources]); await assertSource();
    const name = 'abk-' + randomUUID();
    for (const volume of Object.values(volumes)) volume.used_by.push(ref(name));
    try { await assertSource(name); return await capture(name, async () => {}); }
    finally {
      for (const volume of Object.values(volumes)) volume.used_by = volume.used_by.filter((value: string) => value !== ref(name));
      await assertSource(); control.cleanupValidated = true;
    }
  };
  const runtime = new IncusWorkerRuntime(config, client);
  const workspace = join(dataDir, 'workspace.tar.gz'), agents = join(dataDir, 'agents.tar.gz');
  const capture = () => runtime.captureOfflineCanonical(owner, archived ? undefined : incarnation, async () => {},
    { workspace, agents, exclusions: ['/workspace/approved-host-overlay'], signal: controller.signal });
  try { await run({ calls, control, original, volumes, capture, workspace, agents, binary, controller }); }
  finally { IncusOfflineArchiveHelper.prototype.withGuest = previous; await rm(dataDir, { recursive: true, force: true }); }
}

test('stopped and archived canonical capture uses fixed offline roles and preserves raw binary gzip without Docker or source writes', async () => {
  for (const archived of [false, true]) await fixture(archived, async f => {
    const before = structuredClone(f.volumes), original = structuredClone(f.original);
    const result = await f.capture();
    expect(result.runtime.kind).toBe('incus-vm'); expect(result.runtime.source.sourceImageId).toBe('sha256:' + 'a'.repeat(64));
    expect(result.runtime.source.fingerprint).toBeUndefined();
    expect(gunzipSync(await readFile(f.workspace))).toEqual(f.binary);
    expect(gunzipSync(await readFile(f.agents))).toEqual(f.binary);
    expect(f.original).toEqual(original); expect(f.volumes).toEqual(before);
    const commands = f.calls.filter((call: any) => call[0] === 'exec');
    expect(commands.map((call: any) => call[2].slice(-3))).toEqual([
      ['workspace', '["/workspace/approved-host-overlay"]', 'offline'],
      ['agents', '["/workspace/approved-host-overlay"]', 'offline'],
    ]);
  });
});

test('production offline source proof remains usable after cancellation but rejects concurrent source drift', async () => {
  for (const drift of [false, true]) await fixture(false, async f => {
    const workspace = f.volumes[f.original.devices.workspace.source];
    f.control.mutation = () => {
      f.controller.abort(new Error('cancelled'));
      if (drift) workspace.created_at = '2026-10-05T13:00:00Z';
    };
    await expect(f.capture()).rejects.toThrow();
    expect(f.control.cleanupValidated).toBe(!drift);
    expect(workspace.used_by).toHaveLength(1);
  });
});

test('offline source preflight rejects running, foreign, missing-reference and duplicate-device authority before helper creation', async () => {
  for (const kind of ['running','foreign','missing-reference','duplicate-device','project']) await fixture(false, async f => {
    const workspace = f.volumes[f.original.devices.workspace.source];
    if (kind === 'running') f.original.status = 'Running';
    if (kind === 'foreign') workspace.config['user.agentor.owner'] = 'foreign';
    if (kind === 'missing-reference') workspace.used_by = [];
    if (kind === 'duplicate-device') f.original.devices.duplicate = { ...f.original.devices.workspace };
    if (kind === 'project') workspace.project = 'foreign';
    await expect(f.capture()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  await fixture(true, async f => {
    f.control.present = true;
    await expect(f.capture()).rejects.toThrow('unexpected compute'); expect(f.calls).toEqual([]);
  });
});

test('late original UUID, devices, volume generation, metadata and references cannot publish successful offline capture', async () => {
  for (const kind of ['uuid','devices','generation','metadata','reference']) await fixture(false, async f => {
    const workspace = f.volumes[f.original.devices.workspace.source];
    f.control.mutation = () => {
      if (kind === 'uuid') f.original.config['volatile.uuid'] = randomUUID();
      if (kind === 'devices') f.original.devices.workspace.readonly = 'true';
      if (kind === 'generation') workspace.created_at = '2026-10-05T13:00:00Z';
      if (kind === 'metadata') workspace.config['user.agentor.image-source'] = '{}';
      if (kind === 'reference') workspace.used_by.push('/1.0/instances/foreign?project=agentor');
    };
    await expect(f.capture()).rejects.toThrow();
    expect(f.calls.filter((call: any) => call[0] === 'exec')).toHaveLength(1);
  });
});
