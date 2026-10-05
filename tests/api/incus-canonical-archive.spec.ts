import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, lstat, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { INCUS_CANONICAL_ARCHIVE_SCRIPT } from '../../orchestrator/server/utils/incus-canonical-archive';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function runtimeFixture(run: (value: Awaited<ReturnType<typeof prepareRuntime>>) => Promise<void>) {
  const value = await prepareRuntime();
  try { await run(value); }
  finally { value.session.close(); await rm(value.dataDir, { recursive: true, force: true }); }
}

async function prepareRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-canonical-runtime-'));
  const installation = await backupInstallationId(dataDir), id = randomUUID(), incarnation = randomUUID();
  const owner = { id, userId: 'canonical-owner', containerName: 'worker-' + id };
  const config = { dataDir, containerPrefix: 'worker', incusStoragePool: 'default',
    incusProject: 'agentor', incusEndpoint: 'https://native.invalid' } as Config;
  const identity = { version: 1, sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64),
    architecture: 'amd64', converterVersion: 'pinned-v1', bootstrapGeneration: '3', fingerprint: 'c'.repeat(64) };
  const volumes: Record<string, any> = {}, devices: Record<string, any> = {};
  for (const role of ['workspace', 'agents']) {
    const name = owner.containerName + '-' + role;
    volumes[name] = { name, type: 'custom', content_type: 'filesystem', used_by: [
      '/1.0/instances/' + owner.containerName + '?project=agentor',
    ], config: { 'user.agentor.installation': installation, 'user.agentor.id': id,
      'user.agentor.owner': owner.userId, 'user.agentor.storage-role': role,
      ...(role === 'workspace' ? { 'user.agentor.image-source': JSON.stringify(identity) } : {}) } };
    devices[role] = { type: 'disk', pool: 'default', source: name,
      path: role === 'workspace' ? '/workspace' : '/home/agent/.agent-data' };
  }
  const instance: any = { name: owner.containerName, type: 'virtual-machine', status: 'Running', devices,
    config: { 'user.agentor.installation': installation, 'user.agentor.id': id,
      'user.agentor.owner': owner.userId, 'volatile.uuid': incarnation } };
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let resolve!: (code: number) => void, reject!: (error: Error) => void, closed = 0, validation = 0;
  const result = new Promise<number>((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
  const session = { stdin, stdout, stderr, result, close: (error = new Error('Archive session cancelled')) => {
    closed++; stdin.destroy(); stdout.destroy(); stderr.destroy(); reject(error);
  } };
  const executions: any[] = [];
  const client = {
    endpoint: config.incusEndpoint,
    getInstance: async () => structuredClone(instance),
    getCustomVolume: async (_pool: string, name: string) => {
      if (!volumes[name]) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return structuredClone(volumes[name]);
    },
    execStream: async (...args: any[]) => {
      executions.push(args);
      args[2].signal?.addEventListener('abort', () => session.close(new Error('Archive cancelled')), { once: true });
      return session;
    },
  };
  const runtime = new IncusWorkerRuntime(config, client as any);
  return { dataDir, owner, incarnation, identity, instance, volumes, runtime, session, executions,
    resolve, reject, closed: () => closed, validations: () => validation,
    validate: () => { validation++; },
    open: (role: 'workspace' | 'agents' = 'workspace', signal?: AbortSignal) =>
      runtime.openCanonicalArchive(owner, incarnation, role, () => { validation++; }, { exclusions: ['/workspace/host [share]*'], signal }) };
}

test('canonical runtime streams binary bytes, sends stdin EOF and waits for exit plus final proof before output EOF', async () => {
  await runtimeFixture(async f => {
    const output = await f.open(), closed = once(output, 'close'), received = collect(output);
    let ended = false; output.once('end', () => { ended = true; });
    expect(f.executions).toHaveLength(1);
    expect(f.executions[0][0]).toBe(f.owner.containerName);
    expect(f.executions[0][1]).toEqual(['/usr/bin/python3', '-c', INCUS_CANONICAL_ARCHIVE_SCRIPT,
      'workspace', JSON.stringify(['/workspace/host [share]*'])]);
    expect(f.executions[0][2]).toMatchObject({ user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    expect(f.session.stdin.writableEnded).toBe(true);
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    f.session.stdout.end(bytes);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ended).toBe(false); expect(f.validations()).toBe(2);
    f.resolve(0);
    expect(await received).toEqual(bytes);
    expect(f.validations()).toBe(4);
    await closed;
    expect(f.closed()).toBeGreaterThan(0);
  });
});

test('canonical runtime refuses wrong native incarnation, stopped compute, foreign volume and ambiguous source device before exec', async () => {
  const mutations = [
    (f: any) => { f.instance.config['volatile.uuid'] = 'foreign'; },
    (f: any) => { f.instance.status = 'Stopped'; },
    (f: any) => { f.volumes[f.instance.devices.workspace.source].config['user.agentor.owner'] = 'foreign'; },
    (f: any) => { f.instance.devices.workspace.source = 'foreign-volume'; },
    (f: any) => { f.instance.devices.workspace.pool = 'foreign-pool'; },
    (f: any) => { f.instance.devices.workspace.readonly = 'true'; },
    (f: any) => { delete f.volumes[f.instance.devices.workspace.source]; },
  ];
  for (const mutate of mutations) await runtimeFixture(async f => {
    mutate(f);
    await expect(f.open()).rejects.toThrow();
    expect(f.executions).toEqual([]);
  });
});

test('archive nonzero exit, output error, cancellation and late authority drift fail the stream rather than producing successful EOF', async () => {
  for (const failure of ['exit', 'stdout', 'abort', 'identity']) await runtimeFixture(async f => {
    const controller = new AbortController(), output = await f.open('workspace', controller.signal);
    const received = collect(output); received.catch(() => {});
    if (failure === 'stdout') f.session.stdout.destroy(new Error('binary channel failed'));
    else if (failure === 'abort') controller.abort();
    else {
      f.session.stdout.end(Buffer.from([0, 255]));
      if (failure === 'identity') f.instance.config['volatile.uuid'] = 'replaced-incarnation';
      f.resolve(failure === 'exit' ? 23 : 0);
    }
    await expect(received).rejects.toThrow();
    expect(output.destroyed).toBe(true); expect(f.closed()).toBeGreaterThan(0);
  });
  await runtimeFixture(async f => {
    const output = await f.open();
    const closed = once(output, 'close');
    output.destroy(); await closed;
    expect(f.closed()).toBeGreaterThan(0);
  });
});

test('runtime snapshot describes pinned conversion source without exporting native fingerprint or device authority', async () => {
  await runtimeFixture(async f => {
    expect(await f.runtime.backupRuntime(f.owner, f.incarnation)).toEqual({
      version: 1, kind: 'incus-vm', source: {
        sourceImageId: f.identity.sourceImageId, recipeId: f.identity.recipeId, architecture: 'amd64',
        converterVersion: 'pinned-v1', bootstrapGeneration: '3',
      },
    });
    delete f.volumes[f.instance.devices.workspace.source].config['user.agentor.image-source'];
    await expect(f.runtime.backupRuntime(f.owner, f.incarnation)).rejects.toThrow('immutable source');
  });
});

async function guestFixture(run: (value: {
  root: string; workspace: string; agents: string; mountinfo: string;
  execute: (role: string, exclusions?: string[], offline?: boolean) => ReturnType<typeof spawnSync>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-canonical-guest-'));
  const workspace = join(root, 'workspace'), agents = join(root, 'home/agent/.agent-data'), mountinfo = join(root, 'mountinfo');
  await Promise.all([mkdir(workspace), mkdir(agents, { recursive: true })]);
  const escape = (path: string) => path.replaceAll('\\', '\\134').replaceAll(' ', '\\040');
  await writeFile(mountinfo, [
    '1 0 8:1 / / rw - ext4 /dev/fixture rw',
    '2 1 0:99 / ' + escape(workspace) + ' rw - virtiofs workspace rw',
    '3 1 0:98 / ' + escape(agents) + ' rw - virtiofs agents rw',
  ].join('\n') + '\n');
  // Exact test-local fixed literals only. No production root/path parameter.
  const script = INCUS_CANONICAL_ARCHIVE_SCRIPT
    .replace('"workspace":"/workspace"', '"workspace":' + JSON.stringify(workspace))
    .replace('"agents":"/home/agent/.agent-data"', '"agents":' + JSON.stringify(agents))
    .replace('"/proc/self/mountinfo"', JSON.stringify(mountinfo));
  expect(script).not.toBe(INCUS_CANONICAL_ARCHIVE_SCRIPT);
  const execute = (role: string, exclusions: string[] = [], offline = false) =>
    spawnSync('python3', ['-c', script, role, JSON.stringify(exclusions), ...(offline ? ['offline'] : [])],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  try { await run({ root, workspace, agents, mountinfo, execute }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('guest GNU tar preserves binary xattrs, uid/gid, permissions and links while excluding literal nested overlays', async () => {
  await guestFixture(async f => {
    const file = join(f.workspace, 'private.bin'), share = join(f.workspace, 'host [share]*');
    await writeFile(file, Buffer.from([0, 255, 128, 10])); await chmod(file, 0o640);
    await link(file, join(f.workspace, 'private-hardlink'));
    await symlink('private.bin', join(f.workspace, 'private-symlink'));
    await mkdir(share); await writeFile(join(share, 'never-backup'), 'external data');
    await writeFile(join(f.workspace, 'host s'), 'private near-match');
    await writeFile(f.mountinfo, (await readFile(f.mountinfo, 'utf8')) +
      '4 2 0:97 / ' + share.replaceAll(' ', '\\040') + ' rw - virtiofs host rw\n');
    const attr = spawnSync('python3', ['-c', 'import os,sys; os.setxattr(sys.argv[1],"user.agentor_binary",bytes([0,255,128,10]))', file]);
    expect(attr.status, attr.stderr?.toString()).toBe(0);
    const result = f.execute('workspace');
    expect(result.status, result.stderr?.toString()).toBe(0);
    const archive = join(f.root, 'workspace.tar'), restored = join(f.root, 'restored');
    await writeFile(archive, result.stdout); await mkdir(restored);
    const extract = spawnSync('/usr/bin/tar', ['--xattrs', '--xattrs-include=*', '--numeric-owner', '-xpf', archive, '-C', restored]);
    expect(extract.status, extract.stderr?.toString()).toBe(0);
    const target = join(restored, 'workspace');
    expect(await readFile(join(target, 'private.bin'))).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(await readFile(join(target, 'host s'), 'utf8')).toBe('private near-match');
    await expect(lstat(join(target, 'host [share]*'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(join(target, 'private-symlink'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(target, 'private.bin'))).ino).toBe((await lstat(join(target, 'private-hardlink'))).ino);
    const before = await lstat(file), after = await lstat(join(target, 'private.bin'));
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    const inspect = spawnSync('python3', ['-c',
      'import json,os,sys,tarfile; t=tarfile.open(sys.argv[1]); m=t.getmember("workspace/private.bin"); print(json.dumps({"uid":m.uid,"gid":m.gid,"attr":list(os.getxattr(sys.argv[2],"user.agentor_binary"))}))',
      archive, join(target, 'private.bin')], { encoding: 'utf8' });
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)).toEqual({ uid: before.uid, gid: before.gid, attr: [0, 255, 128, 10] });
  });
});

test('offline guest archive refuses writable roots before emitting archive bytes', async () => {
  await guestFixture(async f => {
    const result = f.execute('workspace', [], true);
    expect(result.status).not.toBe(0); expect(result.stdout.length).toBe(0);
    expect(result.stderr.toString()).toContain('readonly, unprovisioned storage');
  });
});

test('agent archive excludes secrets, shared directories and old Kilo auth but retains worker state and literal near-matches', async () => {
  await guestFixture(async f => {
    for (const path of ['.claude', '.codex', '.gemini', '.kilo/config', '.kilo/shared-data', '.kilo/data'])
      await mkdir(join(f.agents, path), { recursive: true });
    for (const path of ['.claude/.credentials.json', '.codex/auth.json', '.gemini/oauth_creds.json',
      '.kilo/config/global.json', '.kilo/shared-data/provider.json', '.kilo/data/auth.json'])
      await writeFile(join(f.agents, path), 'secret-MUST-NOT-ENTER');
    await writeFile(join(f.agents, '.codex/sessions'), 'retained sessions');
    await writeFile(join(f.agents, '.kilo/data/history'), 'retained old worker history');
    await mkdir(join(f.agents, 'external [mount]*')); await writeFile(join(f.agents, 'external [mount]*/data'), 'external-MUST-NOT-ENTER');
    await writeFile(join(f.agents, 'external m'), 'private near-match');
    const result = f.execute('agents', [join(f.agents, 'external [mount]*')]);
    expect(result.status, result.stderr?.toString()).toBe(0);
    expect(result.stdout.includes(Buffer.from('MUST-NOT-ENTER'))).toBe(false);
    const archive = join(f.root, 'agents.tar'); await writeFile(archive, result.stdout);
    const listing = spawnSync('/usr/bin/tar', ['-tf', archive], { encoding: 'utf8' });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain('.agent-data/.codex/sessions');
    expect(listing.stdout).toContain('.agent-data/.kilo/data/history');
    expect(listing.stdout).toContain('.agent-data/external m');
    expect(listing.stdout).not.toContain('external [mount]*');
    expect(listing.stdout).not.toContain('.credentials.json');
    expect(listing.stdout).not.toContain('/auth.json');
    expect(listing.stdout).not.toContain('/oauth_creds.json');
    expect(listing.stdout).not.toContain('.kilo/config');
    expect(listing.stdout).not.toContain('.kilo/shared-data');
  });
});

test('canonical guest refuses symlinked or unmounted roots, malformed mount authority and root-covering exclusions before tar', async () => {
  await guestFixture(async f => {
    const mountinfo = await readFile(f.mountinfo);
    for (const value of ['', 'malformed\n', mountinfo.toString() + mountinfo.toString()]) {
      await writeFile(f.mountinfo, value);
      const result = f.execute('workspace');
      expect(result.status).not.toBe(0); expect(result.stdout.length).toBe(0);
    }
    await writeFile(f.mountinfo, mountinfo);
    for (const excluded of [[f.workspace], [f.root], ['/bad/../traversal']]) {
      const result = f.execute('workspace', excluded);
      expect(result.status).not.toBe(0); expect(result.stdout.length).toBe(0);
    }
    await rm(f.workspace, { recursive: true }); await symlink(f.agents, f.workspace);
    const result = f.execute('workspace');
    expect(result.status).not.toBe(0); expect(result.stdout.length).toBe(0);
  });
});
