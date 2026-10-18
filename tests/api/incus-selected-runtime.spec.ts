import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { INCUS_SELECTED_ARCHIVE_SCRIPT } from '../../orchestrator/server/utils/incus-selected-archive';
import type { Config } from '../../orchestrator/server/utils/config';

async function fixture(run: (f: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-selected-source-'));
  const owner = { id: randomUUID(), userId: 'selected-source-owner', containerName: '' };
  owner.containerName = 'worker-' + owner.id;
  const installation = await backupInstallationId(dir), incarnation = randomUUID(), boot = randomUUID();
  const config = { dataDir: dir, containerPrefix: 'worker', incusStoragePool: 'default', incusProject: 'agentor',
    incusEndpoint: 'https://native.invalid' } as Config;
  const instance: any = { name: owner.containerName, type: 'virtual-machine', status: 'Running', profiles: [],
    config: { 'user.agentor.id': owner.id, 'user.agentor.owner': owner.userId,
      'user.agentor.installation': installation, 'volatile.uuid': incarnation },
    devices: { root: { type: 'disk', pool: 'default', path: '/' } } };
  const volumes: Record<string, any> = {};
  for (const role of ['workspace', 'agents']) {
    const name = owner.containerName + '-' + role;
    volumes[name] = { name, type: 'custom', content_type: 'filesystem', project: 'agentor', created_at: '2026-10-05T12:00:00Z',
      used_by: ['/1.0/instances/' + owner.containerName + '?project=agentor'], config: {
        'user.agentor.installation': installation, 'user.agentor.id': owner.id, 'user.agentor.owner': owner.userId,
        'user.agentor.storage-role': role } };
    instance.devices[role] = { type: 'disk', pool: 'default', source: name,
      path: role === 'workspace' ? '/workspace' : '/home/agent/.agent-data' };
  }
  instance.expanded_devices = structuredClone(instance.devices);
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let resolve!: (code: number) => void, reject!: (error: Error) => void, closed = 0, recordChecks = 0;
  const result = new Promise<number>((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
  const state = { boot, bootFailure: false }, calls: any[] = [];
  const session = { stdin, stdout, stderr, result, close: () => {
    closed++; stdin.destroy(); stdout.destroy(); stderr.destroy(); reject(new Error('Selected stream closed'));
  } };
  const client: any = { endpoint: config.incusEndpoint,
    getInstance: async () => structuredClone(instance),
    getCustomVolume: async (_pool: string, name: string) => {
      if (!volumes[name]) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return structuredClone(volumes[name]);
    },
    exec: async (_name: string, command: string[]) => {
      expect(command).toEqual(['/usr/bin/cat', '/proc/sys/kernel/random/boot_id']);
      return { returnCode: state.bootFailure ? 1 : 0, stdout: state.boot + '\n', stderr: '' };
    },
    execStream: async (...args: any[]) => {
      calls.push(args); args[2].signal?.addEventListener('abort', () => session.close(), { once: true }); return session;
    },
  };
  const runtime = new IncusWorkerRuntime(config, client);
  try { await run({ owner, incarnation, instance, volumes, session, resolve, closed: () => closed,
    calls, state, checks: () => recordChecks, open: (path = '/tmp/selected', signal?: AbortSignal) =>
      runtime.openSelectedArchive(owner, incarnation, path, () => { recordChecks++; }, signal) }); }
  finally { session.close(); await rm(dir, { recursive: true, force: true }); }
}
async function collect(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}

test('selected source streaming is binary, unsourced, readonly and EOF waits for native plus boot proof', async () => fixture(async f => {
  const stream = await f.open(), reading = collect(stream); let ended = false;
  stream.on('end', () => { ended = true; });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0][1]).toEqual(['/usr/bin/python3', '-c', INCUS_SELECTED_ARCHIVE_SCRIPT, '/tmp/selected',
    JSON.stringify({ mounts: ['/', '/workspace', '/home/agent/.agent-data'], credentials: false })]);
  expect(f.calls[0][2]).toMatchObject({ user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  expect(f.session.stdin.writableEnded).toBe(true);
  const bytes = Buffer.from([0, 255, 128, 10]); f.session.stdout.end(bytes);
  await new Promise<void>(resolve => setImmediate(resolve)); expect(ended).toBe(false);
  f.resolve(0); expect(await reading).toEqual(bytes); expect(f.checks()).toBeGreaterThan(4);
}));

test('selected source rejects unknown, expanded, replaced or unowned disks before archive execution', async () => {
  const mutations = [
    (f: any) => { f.instance.devices.foreign = { type: 'disk', source: '/host/private', path: '/tmp/selected' }; },
    (f: any) => { f.instance.expanded_devices.foreign = { type: 'disk', source: '/host/private', path: '/tmp/selected' }; },
    (f: any) => { f.instance.devices.workspace.pool = 'foreign'; },
    (f: any) => { f.instance.expanded_devices.workspace.readonly = 'true'; },
    (f: any) => { f.instance.config['volatile.uuid'] = randomUUID(); },
    (f: any) => { f.instance.config['user.agentor.owner'] = 'foreign'; },
    (f: any) => { f.instance.status = 'Stopped'; },
    (f: any) => { f.instance.profiles.push('foreign'); },
    (f: any) => { f.instance.config['raw.qemu'] = '-virtfs foreign'; },
    (f: any) => { f.instance.expanded_config = { 'raw.qemu': '-virtfs foreign' }; },
    (f: any) => { f.volumes[f.owner.containerName + '-workspace'].used_by = ['/1.0/instances/foreign?project=agentor']; },
    (f: any) => { f.volumes[f.owner.containerName + '-workspace'].project = 'default'; },
    (f: any) => { f.volumes[f.owner.containerName + '-workspace'].created_at = ''; },
  ];
  for (const mutate of mutations) await fixture(async f => { mutate(f); await expect(f.open()).rejects.toThrow(); expect(f.calls).toEqual([]); });
});

test('selected EOF fails closed on reboot, metadata/reference drift, nonzero exit, cancellation and disconnect', async () => {
  for (const failure of ['reboot', 'metadata', 'references', 'layout', 'raw', 'exit', 'agent', 'abort']) await fixture(async f => {
    const controller = new AbortController(), stream = await f.open('/tmp/selected', controller.signal), reading = collect(stream);
    reading.catch(() => {});
    if (failure === 'abort') controller.abort();
    else {
      if (failure === 'reboot') f.state.boot = randomUUID();
      if (failure === 'metadata') f.volumes[f.owner.containerName + '-agents'].config.foreign = 'changed';
      if (failure === 'references') f.volumes[f.owner.containerName + '-agents'].used_by = [];
      if (failure === 'layout') f.instance.devices.foreign = { type: 'disk', source: '/foreign', path: '/tmp' };
      if (failure === 'raw') f.instance.config['raw.qemu'] = '-foreign';
      if (failure === 'agent') f.state.bootFailure = true;
      f.session.stdout.end('partial selected data'); f.resolve(failure === 'exit' ? 1 : 0);
    }
    await expect(reading).rejects.toThrow(); expect(stream.destroyed).toBe(true); expect(f.closed()).toBeGreaterThan(0);
  });
  await fixture(async f => { const stream = await f.open(); stream.destroy(); await new Promise(resolve => setImmediate(resolve)); expect(f.closed()).toBeGreaterThan(0); });
});
