import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusOfflineArchiveHelper } from '../../orchestrator/server/utils/incus-offline-archive-helper';
import type { IncusClient, IncusCustomVolume, IncusInstance } from '../../orchestrator/server/utils/incus-client';
import type { IncusStorageOwner } from '../../orchestrator/server/utils/incus-worker-storage';

async function fixture(run: (f: {
  runtime: IncusWorkerRuntime; owner: IncusStorageOwner; incarnation: string; archive: string;
  instance: IncusInstance; volume: IncusCustomVolume; phases: string[];
  cores: Map<'workspace' | 'agents' | 'docker', IncusCustomVolume>;
  setHook: (hook: (phase: string) => void) => void;
  setExecFailure: (phase: string) => void;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-original-leaf-'));
  const config = { ...loadConfig(), dataDir: dir, containerPrefix: 'agentor-worker', incusProject: 'agentor',
    incusStoragePool: 'default', incusEndpoint: 'https://native.invalid:8443' };
  const id = randomUUID(), incarnation = randomUUID(), helper = 'abk-' + randomUUID();
  const owner = { id, userId: 'original-owner', containerName: config.containerPrefix + '-' + id };
  const instance = { name: owner.containerName, status: 'Stopped', type: 'virtual-machine', profiles: [],
    config: { 'volatile.uuid': incarnation, 'volatile.base_image': 'a'.repeat(64), 'user.agentor.worker': id },
    devices: { workspace: { type: 'disk', pool: 'default', source: owner.containerName + '-workspace', path: '/workspace' } } } as unknown as IncusInstance;
  const volume = { name: owner.containerName + '-workspace', type: 'custom', content_type: 'filesystem', project: 'agentor',
    created_at: new Date(0).toISOString(), config: { 'user.agentor.worker': id },
    used_by: ['/1.0/instances/' + owner.containerName + '?project=agentor'] } as unknown as IncusCustomVolume;
  const cores = new Map<'workspace' | 'agents' | 'docker', IncusCustomVolume>([
    ['workspace', volume],
    ['agents', { ...structuredClone(volume), name: owner.containerName + '-agents' }],
    ['docker', { ...structuredClone(volume), name: owner.containerName + '-docker', content_type: 'block' }],
  ]);
  instance.devices.docker = { type: 'disk', pool: 'default', source: owner.containerName + '-docker' };
  const phases: string[] = []; let hook = (_phase: string) => {}; let failedPhase: string | undefined;
  const client = {
    endpoint: config.incusEndpoint,
    getCustomVolume: async (_pool: string, name: string) => {
      const value = [...cores.values()].find(current => current.name === name);
      if (!value) throw Object.assign(new Error('Native volume missing'), { statusCode: 404 });
      return structuredClone(value);
    },
    getInstance: async () => ({ config: { 'volatile.base_image': 'a'.repeat(64) } }),
    execStream: async (name: string, command: string[]) => {
      expect(name).toBe(helper);
      const phase = command[0] === '/usr/bin/tar' ? 'tar' : command[0] === '/usr/bin/grep' ? 'feature'
        : command[0] === '/usr/bin/systemctl' ? command[1]! : command.at(-2)!;
      if (command[0] === '/usr/bin/systemctl') expect(command).toEqual(['/usr/bin/systemctl', phase,
        ...(phase === 'mask' ? ['--runtime'] : []), 'agentor-worker.service', 'docker.service', 'docker.socket', 'containerd.service']);
      phases.push(phase); hook(phase);
      const stdin = new PassThrough(); stdin.resume();
      const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end(); stderr.end();
      return { stdin, stdout, stderr, result: Promise.resolve(phase === failedPhase ? 1 : 0), close: () => {} };
    },
  } as unknown as IncusClient;
  const runtime = new IncusWorkerRuntime(config, client);
  const privateRuntime = runtime as unknown as {
    assertOwned: () => Promise<IncusInstance>; storage: () => Promise<unknown>;
    assertReady: () => Promise<void>;
  };
  privateRuntime.assertOwned = async () => structuredClone(instance);
  privateRuntime.storage = async () => ({ inspectVolume: async (_owner: IncusStorageOwner, role: 'workspace' | 'agents' | 'docker') => structuredClone(cores.get(role)),
    preserveOwnership: async () => false,
    markWorkspacePreserveOwnership: async () => {
      phases.push('ownership'); volume.config['user.agentor.workspace-preserve-ownership'] = 'true';
      return structuredClone(volume);
    } });
  privateRuntime.assertReady = async () => { phases.push('ready'); };
  runtime.inspectOfflineBackupStorage = async () => { phases.push('inventory'); return { docker: false, runtime: {} } as never; };
  runtime.assertWorkspaceReplacementSettled = async () => { phases.push('settled'); };
  const previous = IncusOfflineArchiveHelper.prototype.withGuest;
  IncusOfflineArchiveHelper.prototype.withGuest = async function <T>(...args: Parameters<IncusOfflineArchiveHelper['withGuest']>): Promise<T> {
    const [actualOwner, sources, validate, _signal, capture] = args;
    expect(actualOwner).toEqual(owner); expect(sources).toEqual({ workspaceRestore: true });
    phases.push('helper'); await validate();
    volume.used_by.push('/1.0/instances/' + helper + '?project=agentor');
    try { const result = await capture(helper, async () => { phases.push('helper-proof'); }); phases.push('writer-success'); return result as T; }
    finally { volume.used_by.pop(); hook('after-helper'); }
  };
  try {
    await mkdir(join(dir, 'source/workspace'), { recursive: true });
    await writeFile(join(dir, 'source/workspace/data'), 'original replacement');
    const archive = join(dir, 'workspace.tar.gz');
    execFileSync('tar', ['--format=pax', '--numeric-owner', '-C', join(dir, 'source'), '-czf', archive, 'workspace']);
    await run({ runtime, owner, incarnation, archive, instance, volume, cores, phases,
      setHook: value => { hook = value; }, setExecFailure: value => { failedPhase = value; } });
  } finally { IncusOfflineArchiveHelper.prototype.withGuest = previous; await rm(dir, { recursive: true, force: true }); }
}

test('native original leaf preserves compute and storage authority and settles only acknowledged prepare/extract/commit/finish', async () => {
  await fixture(async f => {
    const instance = structuredClone(f.instance), volume = structuredClone(f.volume); let checks = 0;
    await f.runtime.replaceOriginalWorkspace(f.owner, f.incarnation, f.archive, () => { checks++; });
    expect(f.phases.filter(phase => ['prepare', 'tar', 'commit', 'finish'].includes(phase))).toEqual(['prepare', 'tar', 'commit', 'finish']);
    expect(f.phases.indexOf('mask')).toBeLessThan(f.phases.indexOf('stop'));
    expect(f.phases.indexOf('stop')).toBeLessThan(f.phases.indexOf('prepare'));
    expect(f.phases.indexOf('writer-success')).toBeGreaterThan(f.phases.indexOf('finish'));
    expect(f.phases.indexOf('ownership')).toBeGreaterThan(f.phases.indexOf('commit'));
    expect(f.phases.indexOf('ownership')).toBeLessThan(f.phases.indexOf('finish'));
    expect(checks).toBeGreaterThan(10); expect(f.instance).toEqual(instance);
    expect(f.volume).toEqual({ ...volume, config: { ...volume.config, 'user.agentor.workspace-preserve-ownership': 'true' } });
  });
});

test('failed helper-only runtime mask or stop denies workspace preparation and preserves original authority', async () => {
  for (const phase of ['mask', 'stop']) await fixture(async f => {
    const before = structuredClone(f.instance), oldVolume = structuredClone(f.volume);
    f.setExecFailure(phase);
    await expect(f.runtime.replaceOriginalWorkspace(f.owner, f.incarnation, f.archive, () => {}))
      .rejects.toThrow('replacement acknowledgement failed');
    expect(f.phases).not.toContain('prepare'); expect(f.phases).not.toContain('tar'); expect(f.phases).not.toContain('writer-success');
    expect(f.instance).toEqual(before); expect(f.volume).toEqual(oldVolume);
  });
});

test('changed original UUID/layout or canonical volume incarnation stops writer before commit/finish acknowledgement', async () => {
  for (const change of ['uuid', 'layout', 'created', 'config', 'reference'] as const) await fixture(async f => {
    f.setHook(phase => { if (phase !== 'tar') return;
      if (change === 'uuid') f.instance.config['volatile.uuid'] = randomUUID();
      if (change === 'layout') f.instance.devices.workspace!.path = '/unexpected';
      if (change === 'created') f.volume.created_at = new Date().toISOString();
      if (change === 'config') f.volume.config['user.agentor.worker'] = randomUUID();
      if (change === 'reference') f.volume.used_by.push('/1.0/instances/foreign?project=agentor');
    });
    await expect(f.runtime.replaceOriginalWorkspace(f.owner, f.incarnation, f.archive, () => {})).rejects.toThrow(/authority changed|identity or layout changed/);
    expect(f.phases).not.toContain('commit'); expect(f.phases).not.toContain('finish'); expect(f.phases).not.toContain('writer-success');
  });
});

test('unchanged agents and Docker native identity and references are freshly fenced before commit and after helper cleanup', async () => {
  for (const role of ['agents', 'docker'] as const) for (const boundary of ['tar', 'after-helper'] as const)
    for (const changed of ['config', 'created', 'reference'] as const) await fixture(async f => {
      const other = f.cores.get(role)!;
      f.setHook(phase => { if (phase !== boundary) return;
        if (changed === 'config') other.config['user.agentor.owner'] = 'foreign';
        if (changed === 'created') other.created_at = new Date().toISOString();
        if (changed === 'reference') other.used_by.push('/1.0/instances/foreign?project=agentor');
      });
      await expect(f.runtime.replaceOriginalWorkspace(f.owner, f.incarnation, f.archive, () => {}))
        .rejects.toThrow('Original ' + role + ' native storage authority changed');
      if (boundary === 'tar') {
        expect(f.phases).not.toContain('commit'); expect(f.phases).not.toContain('finish'); expect(f.phases).not.toContain('writer-success');
      }
    });
});

test('intentional absent Docker authority is preserved and cannot become newly attached or ambiguous during workspace replacement', async () => {
  await fixture(async f => {
    const saved = f.cores.get('docker')!; f.cores.delete('docker'); delete f.instance.devices.docker;
    f.setHook(phase => { if (phase === 'tar') f.cores.set('docker', saved); });
    await expect(f.runtime.replaceOriginalWorkspace(f.owner, f.incarnation, f.archive, () => {}))
      .rejects.toThrow('Original Docker storage absence changed');
    expect(f.phases).not.toContain('commit'); expect(f.phases).not.toContain('writer-success');
  });
});

test('unknown commit result or cancelled owner authority never finishes or reports the workspace writer settled', async () => {
  for (const failure of ['commit', 'cancel', 'owner'] as const) await fixture(async f => {
    const controller = new AbortController(); let revoked = false;
    f.setHook(phase => { if (phase !== 'commit') return;
      if (failure === 'commit') throw new Error('lost commit acknowledgement');
      if (failure === 'cancel') controller.abort();
      if (failure === 'owner') revoked = true;
    });
    await expect(f.runtime.replaceOriginalWorkspace(f.owner, f.incarnation, f.archive, () => {
      if (revoked) throw new Error('Owner removed');
    }, controller.signal)).rejects.toThrow();
    expect(f.phases).not.toContain('finish'); expect(f.phases).not.toContain('writer-success');
  });
});

test('invalid gzip bytes are rejected before writable helper allocation', async () => {
  await fixture(async f => {
    await writeFile(f.archive, 'not a canonical gzip archive');
    await expect(f.runtime.replaceOriginalWorkspace(f.owner, f.incarnation, f.archive, () => {})).rejects.toThrow();
    expect(f.phases).not.toContain('helper');
  });
});

test('unproven original image or unsupported ownership feature rejects before workspace preparation', async () => {
  for (const reason of ['image', 'feature'] as const) await fixture(async f => {
    if (reason === 'image') f.instance.config['volatile.base_image'] = 'b'.repeat(64);
    else f.setHook(phase => { if (phase === 'feature') throw new Error('Accepted ownership feature absent'); });
    await expect(f.runtime.replaceOriginalWorkspace(f.owner, f.incarnation, f.archive, () => {})).rejects.toThrow();
    expect(f.phases).not.toContain('prepare'); expect(f.phases).not.toContain('tar'); expect(f.phases).not.toContain('writer-success');
  });
});

test('runtime startup refuses an unsettled replacement before readiness, storage or boot', async () => {
  await fixture(async f => {
    f.runtime.assertWorkspaceReplacementSettled = async () => { throw new Error('Writer receipt is unsettled'); };
    const options = { ...f.owner, userEnv: {}, environmentJson: { dockerEnabled: false }, capabilitiesJson: [], instructionsJson: [],
      workerJson: { id: f.owner.id }, dockerEnabled: false } as unknown as Parameters<IncusWorkerRuntime['start']>[0];
    await expect(f.runtime.start(options, f.incarnation)).rejects.toThrow('Writer receipt is unsettled');
    expect(f.phases).toEqual([]);
  });
});
