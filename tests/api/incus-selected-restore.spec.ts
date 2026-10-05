import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INCUS_SELECTED_RESTORE_SCRIPT, planIncusSelectedRestore } from '../../orchestrator/server/utils/incus-selected-restore';
import { inspectIncusSelectedRestoreArchive } from '../../orchestrator/server/utils/portable-managed-volume-archive';

const authority = { accountShares: false, hostTargets: [], managedTargets: [] };
const mountLine = (path: string, id: number) => `${id} 1 0:${id} / ${path.replaceAll(' ', '\\040')} rw - virtiofs private rw\n`;
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { maxBuffer: 8 * 1024 * 1024 });
  expect(result.status, result.stderr.toString()).toBe(0); return result;
};
async function fixture(callback: (f: {
  root: string; workspace: string; agents: string; mountinfo: string; provisioned: string; script: string;
  archive: (wrapper: string, prepare: (source: string) => Promise<void>) => Promise<{ path: string; bytes: Buffer }>;
  frame: (archive: string, selected: string, destination: string) => Promise<Buffer>;
  execute: (input: Buffer) => ReturnType<typeof spawnSync>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-selected-inverse-'));
  const workspace = join(root, 'restore/workspace'), agents = join(root, 'restore/.agent-data');
  const mountinfo = join(root, 'mountinfo'), provisioned = join(root, 'provisioned');
  await mkdir(workspace, { recursive: true }); await mkdir(agents);
  await writeFile(mountinfo, '1 0 8:1 / / rw - ext4 fixture rw\n' + mountLine(workspace, 2) + mountLine(agents, 3));
  const service = "result=subprocess.run(['/usr/bin/systemctl','is-active','--quiet',service],env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})";
  // Only exact fixed observation literals are replaced; extraction destinations
  // are local temporary fixtures, never actual /restore or account directories.
  const script = INCUS_SELECTED_RESTORE_SCRIPT
    .replace("open('/proc/self/mountinfo','rb')", 'open(' + JSON.stringify(mountinfo) + ",'rb')")
    .replace("'/run/agentor/provisioned'", JSON.stringify(provisioned))
    .replace("'/run/agentor/worker.env'", JSON.stringify(join(root, 'worker.env')))
    .replace(service, 'result=subprocess.CompletedProcess([],3)');
  expect(script).not.toContain(service); expect(script).not.toContain("open('/proc/self/mountinfo'");
  let serial = 0;
  const archive = async (wrapper: string, prepare: (source: string) => Promise<void>) => {
    const stage = join(root, 'stage-' + ++serial), source = join(stage, wrapper), path = join(root, `payload-${serial}.tar`);
    await mkdir(stage); await prepare(source);
    run('sudo', ['-n', '--', '/usr/bin/tar', '--format=pax', '--sort=name', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', stage, '-cf', path, wrapper]);
    return { path, bytes: await readFile(path) };
  };
  const frame = async (archive: string, selected: string, destination: string) => {
    const { members } = await inspectIncusSelectedRestoreArchive(archive, selected);
    const proof = Buffer.from(JSON.stringify({ destination, wrapper: selected.split('/').at(-1), mounts: [workspace, agents], members }));
    const size = Buffer.alloc(4); size.writeUInt32BE(proof.length);
    return Buffer.concat([size, proof, await readFile(archive)]);
  };
  const execute = (input: Buffer) => spawnSync('sudo', ['-n', '--', '/usr/bin/python3', '-c', script],
    { input, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  try { await callback({ root, workspace, agents, mountinfo, provisioned, script, archive, frame, execute }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('planner maps canonical descendants and fixed aliases while leaving ordinary application paths disposable', () => {
  expect(planIncusSelectedRestore(['/workspace/project', '/home/agent/.codex/sessions',
    '/home/agent/.local/state/kilo', '/home/agent/.cache/kilo/data', '/opt/app/settings.json'], authority)).toEqual([
    { path: '/workspace/project', resolved: '/workspace/project', destination: '/restore/workspace/project' },
    { path: '/home/agent/.codex/sessions', resolved: '/home/agent/.agent-data/.codex/sessions', destination: '/restore/.agent-data/.codex/sessions' },
    { path: '/home/agent/.local/state/kilo', resolved: '/home/agent/.agent-data/.kilo/state', destination: '/restore/.agent-data/.kilo/state' },
    { path: '/home/agent/.cache/kilo/data', resolved: '/home/agent/.agent-data/.kilo/cache/data', destination: '/restore/.agent-data/.kilo/cache/data' },
    { path: '/opt/app/settings.json', resolved: '/opt/app/settings.json', destination: '/opt/app/settings.json' },
  ]);
  expect(planIncusSelectedRestore(['/home/agent/.codex/auth.json'], authority)[0]!.destination)
    .toBe('/restore/.agent-data/.codex/auth.json');
  expect(planIncusSelectedRestore(['/home/agent/.local/state/kilo', '/home/agent/.cache/kilo'],
    { ...authority, accountShares: true })).toHaveLength(2);
});

test('planner rejects current grants after alias resolution, overlap aliases and protected bootstrap ancestors', () => {
  for (const path of ['/home/agent/.codex', '/home/agent/.codex/auth.json', '/home/agent/.claude/.credentials.json',
    '/home/agent/.config/kilo', '/home/agent/.local/share/kilo/auth.json'])
    expect(() => planIncusSelectedRestore([path], { ...authority, accountShares: true })).toThrow(/authority/);
  for (const kind of ['hostTargets', 'managedTargets'] as const)
    expect(() => planIncusSelectedRestore(['/home/agent/.codex/sessions'],
      { ...authority, [kind]: ['/home/agent/.agent-data/.codex'] })).toThrow(/authority/);
  for (const kind of ['hostTargets', 'managedTargets'] as const)
    expect(() => planIncusSelectedRestore(['/home/agent/.agent-data/.kilo/cache/data'],
      { ...authority, [kind]: ['/home/agent/.cache/kilo'] })).toThrow(/authority/);
  for (const paths of [
    ['/home/agent/.codex/sessions', '/home/agent/.agent-data/.codex/sessions'],
    ['/workspace/project', '/workspace/project/file'], ['/workspace/project', '/workspace/project'],
    ['/home/agent/.local/state/kilo', '/home/agent/.agent-data/.kilo/state/child'],
  ]) expect(() => planIncusSelectedRestore(paths, authority)).toThrow(/overlap/);
  for (const path of ['/', '/workspace', '/home/agent/.agent-data', '/home', '/home/agent', '/etc', '/usr/local',
    '/etc/systemd/system', '/etc/fstab', '/var', '/restore', '/restore/workspace/data', '/home/agent/.ssh',
    '/run/agentor/secrets', '/var/lib/docker/volumes', '/workspace/project/', 'relative', '/bad\\path'])
    expect(() => planIncusSelectedRestore([path], authority)).toThrow();
  expect(() => planIncusSelectedRestore(Array.from({ length: 33 }, (_, i) => '/opt/data-' + i), authority)).toThrow(/Too many/);
});

test('guest additive inverse preserves unchanged GNU binary PAX metadata and replaces leaf links without following them', async () => {
  await fixture(async f => {
    const archive = await f.archive('project', async source => {
      await mkdir(source); const file = join(source, 'data'); await writeFile(file, Buffer.from([0, 255, 128, 10]));
      await chmod(file, 0o644); await link(file, join(source, 'hard')); await symlink('/etc/example', join(source, 'inert'));
      run('python3', ['-c', String.raw`
import os,struct,sys
p=sys.argv[1];os.setxattr(p,'user.binary',bytes([0,255,128,10,61,0]))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,4,0xffffffff)])
os.setxattr(p,'system.posix_acl_access',acl)
`, file]);
      run('sudo', ['-n', '--', 'chown', '12345:23456', file]);
    });
    const destination = join(f.workspace, 'project'), outside = join(f.root, 'outside'); await mkdir(destination);
    await writeFile(outside, 'outside-must-remain'); await symlink(outside, join(destination, 'data'));
    await link(outside, join(destination, 'hard')); await symlink(outside, join(destination, 'inert'));
    await writeFile(join(destination, 'unselected'), 'retained-additive');
    const input = await f.frame(archive.path, '/workspace/project', destination), result = f.execute(input);
    expect(result.status, result.stderr.toString()).toBe(0); expect(await readFile(archive.path)).toEqual(archive.bytes);
    expect(await readFile(outside, 'utf8')).toBe('outside-must-remain');
    expect(await readFile(join(destination, 'data'))).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(await readFile(join(destination, 'unselected'), 'utf8')).toBe('retained-additive');
    expect((await lstat(join(destination, 'data'))).ino).toBe((await lstat(join(destination, 'hard'))).ino);
    expect(await readlink(join(destination, 'inert'))).toBe('/etc/example');
    const before = await lstat(join(f.root, 'stage-1/project/data')), after = await lstat(join(destination, 'data'));
    expect([after.uid, after.gid, after.mode & 0o7777]).toEqual([before.uid, before.gid, before.mode & 0o7777]);
    run('python3', ['-c', String.raw`
import os,sys
a,b=sys.argv[1:]
for key in ('user.binary','system.posix_acl_access'): assert os.getxattr(a,key)==os.getxattr(b,key)
assert os.stat(a).st_mtime_ns==os.stat(b).st_mtime_ns
`, join(f.root, 'stage-1/project/data'), join(destination, 'data')]);
  });
});

test('guest inverse rejects prior-payload symlink parents and existing directory leaf symlinks before writes', async () => {
  await fixture(async f => {
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'untouched');
    const archive = await f.archive('project', async source => { await mkdir(source); await writeFile(join(source, 'data'), 'must-not-write'); });
    await symlink(outside, join(f.workspace, 'alias'));
    for (const destination of [join(f.workspace, 'alias/project'), join(f.workspace, 'project')]) {
      if (destination.endsWith('/workspace/project')) await symlink(outside, destination);
      const denied = f.execute(await f.frame(archive.path, '/workspace/project', destination));
      expect(denied.status).not.toBe(0); expect(denied.stderr.toString()).toMatch(/ancestor|directory/);
      await expect(lstat(join(outside, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
  });
});

test('guest inverse Kilo remaps only member and hardlink names, not inert symlink values', async () => {
  await fixture(async f => {
    const archive = await f.archive('kilo', async source => {
      await mkdir(source); await writeFile(join(source, 'data'), 'state');
      await link(join(source, 'data'), join(source, 'hard')); await symlink('kilo/data', join(source, 'inert'));
    });
    const destination = join(f.agents, '.kilo/state'), input = await f.frame(archive.path, '/home/agent/.local/state/kilo', destination);
    const result = f.execute(input); expect(result.status, result.stderr.toString()).toBe(0);
    expect(await readFile(join(destination, 'data'), 'utf8')).toBe('state');
    expect((await lstat(join(destination, 'data'))).ino).toBe((await lstat(join(destination, 'hard'))).ino);
    expect(await readlink(join(destination, 'inert'))).toBe('kilo/data');
    await expect(lstat(join(f.agents, '.kilo/kilo'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(archive.path)).toEqual(archive.bytes);
  });
});

test('file over an existing directory rejects before replacing any earlier additive leaf', async () => {
  await fixture(async f => {
    const archive = await f.archive('project', async source => {
      await mkdir(source); await writeFile(join(source, 'aaa'), 'new'); await writeFile(join(source, 'data'), 'not-a-directory');
    });
    const destination = join(f.workspace, 'project'); await mkdir(join(destination, 'data'), { recursive: true });
    await writeFile(join(destination, 'aaa'), 'old-authoritative-leaf');
    const result = f.execute(await f.frame(archive.path, '/workspace/project', destination));
    expect(result.status).not.toBe(0); expect(result.stderr.toString()).toMatch(/existing directory/);
    expect(await readFile(join(destination, 'aaa'), 'utf8')).toBe('old-authoritative-leaf');
    expect((await lstat(join(destination, 'data'))).isDirectory()).toBe(true);
  });
});

test('framed prefix split across writes cannot consume binary raw tar bytes and truncated prefixes never create destination parents', async () => {
  await fixture(async f => {
    const archive = await f.archive('settings.bin', async source => { await writeFile(source, Buffer.from([0, 255, 128, 10, 61])); });
    const destination = join(f.workspace, 'new/settings.bin'), input = await f.frame(archive.path, '/workspace/new/settings.bin', destination);
    const child = spawn('sudo', ['-n', '--', '/usr/bin/python3', '-c', f.script]);
    child.stdin.on('error', () => { /* a guest rejection is asserted by exit status */ });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk.toString(); }); child.stdout.resume();
    const completed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const prefixEnd = 4 + input.readUInt32BE(0);
    let offset = 0;
    for (const end of [1, 2, 3, 4, 5, prefixEnd - 1, prefixEnd, prefixEnd + 511, input.length]) {
      child.stdin.write(input.subarray(offset, end)); offset = end;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    child.stdin.end(); expect(await completed, errors).toBe(0);
    expect(await readFile(destination)).toEqual(Buffer.from([0, 255, 128, 10, 61]));
    const untouched = join(f.workspace, 'never/settings.bin');
    const rejectedInput = await f.frame(archive.path, '/workspace/never/settings.bin', untouched);
    const rejectedPrefixEnd = 4 + rejectedInput.readUInt32BE(0);
    for (const bytes of [rejectedInput.subarray(0, 2), rejectedInput.subarray(0, rejectedPrefixEnd - 1), Buffer.from([4, 0, 0, 1])]) {
      const denied = f.execute(bytes); expect(denied.status).not.toBe(0); expect(denied.stderr.toString()).toMatch(/Truncated|limit/);
      await expect(lstat(join(f.workspace, 'never'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const truncated = f.execute(input.subarray(0, prefixEnd + 512));
    expect(truncated.status).not.toBe(0); expect(truncated.stderr.toString()).toMatch(/tar|Unexpected EOF/);
  });
});

test('guest proof refuses provisioned state, stacked/unknown mounts and noncanonical destinations before extraction', async () => {
  await fixture(async f => {
    const archive = await f.archive('project', async source => { await mkdir(source); await writeFile(join(source, 'data'), 'payload'); });
    const destination = join(f.workspace, 'project'), input = await f.frame(archive.path, '/workspace/project', destination);
    const original = await readFile(f.mountinfo);
    const active = spawnSync('sudo', ['-n', '--', '/usr/bin/python3', '-c',
      f.script.replace('result=subprocess.CompletedProcess([],3)', 'result=subprocess.CompletedProcess([],0)')],
      { input, timeout: 10_000 });
    expect(active.status).not.toBe(0); expect(active.stderr.toString()).toContain('services must be inactive');
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(f.provisioned, 'synthetic-provisioned-marker');
    let denied = f.execute(input); expect(denied.status).not.toBe(0); expect(denied.stderr.toString()).toContain('unprovisioned');
    await rm(f.provisioned);
    for (const observation of [Buffer.concat([original, Buffer.from(mountLine(f.workspace, 4))]),
      Buffer.concat([original, Buffer.from(mountLine(destination, 4))]), Buffer.from('malformed\n')]) {
      await writeFile(f.mountinfo, observation); denied = f.execute(input); expect(denied.status).not.toBe(0);
      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await writeFile(f.mountinfo, original);
    denied = f.execute(await f.frame(archive.path, '/workspace/project', destination + '/../project'));
    expect(denied.status).not.toBe(0); expect(denied.stderr.toString()).toContain('Invalid selected destination');
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
