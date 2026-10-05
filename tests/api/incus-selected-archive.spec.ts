import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INCUS_SELECTED_ALIASES, INCUS_SELECTED_ARCHIVE_SCRIPT, nativeSelectedBackupPath } from '../../orchestrator/server/utils/incus-selected-archive';
import { validateIncusSelectedRestoreArchive } from '../../orchestrator/server/utils/portable-managed-volume-archive';

const escapeMount = (path: string) => path.replaceAll('\\', '\\134').replaceAll(' ', '\\040');
const mountLine = (path: string, id = 2) => `${id} 1 0:${id} / ${escapeMount(path)} rw - virtiofs fixture rw\n`;
async function fixture(run: (f: {
  root: string; source: string; mountinfo: string;
  execute: (selected?: string, proof?: unknown, aliases?: Record<string, string>) => ReturnType<typeof spawnSync>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-selected-guest-'));
  const source = join(root, 'selected'), mountinfo = join(root, 'mountinfo');
  await mkdir(source); await writeFile(mountinfo, '1 0 8:1 / / rw - ext4 fixture rw\n');
  const execute = (selected = source, proof: unknown = { mounts: ['/'], credentials: false }, aliases: Record<string, string> = {}) => {
    // Fixed test-local literals only, never production path overrides or real account directories.
    const script = INCUS_SELECTED_ARCHIVE_SCRIPT
      .replace('ALIASES=' + JSON.stringify(INCUS_SELECTED_ALIASES), 'ALIASES=' + JSON.stringify(aliases))
      .replace("open('/proc/self/mountinfo','rb')", 'open(' + JSON.stringify(mountinfo) + ",'rb')");
    expect(script).not.toBe(INCUS_SELECTED_ARCHIVE_SCRIPT);
    return spawnSync('sudo', ['-n', '--', '/usr/bin/python3', '-c', script, selected, JSON.stringify(proof)],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  };
  try { await run({ root, source, mountinfo, execute }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('native selection policy rejects disposable/ephemeral/Docker roots without rejecting explicit data paths', () => {
  for (const path of ['/', '/workspace/..'])
    expect(() => nativeSelectedBackupPath(path)).toThrow(/disposable/);
  for (const path of ['/proc', '/proc/self', '/sys/a', '/dev', '/run/agentor/secrets/key'])
    expect(() => nativeSelectedBackupPath(path)).toThrow(/Ephemeral/);
  for (const path of ['/var/lib/docker', '/var/lib/docker/volumes', '/var/lib/containerd/metadata'])
    expect(() => nativeSelectedBackupPath(path)).toThrow(/quiesced/);
  for (const path of ['', 'relative', '/bad\0path', '/bad\\path'])
    expect(() => nativeSelectedBackupPath(path)).toThrow();
  expect(nativeSelectedBackupPath('/workspace/project/')).toBe('/workspace/project');
  expect(nativeSelectedBackupPath('/home/agent/.codex/auth.json')).toBe('/home/agent/.codex/auth.json');
  expect(nativeSelectedBackupPath('/run-other/data')).toBe('/run-other/data');
  expect(nativeSelectedBackupPath('/var/lib/docker-other/data')).toBe('/var/lib/docker-other/data');
});

test('selected GNU PAX preserves binary metadata and explicit synthetic auth while omitting specials and literal nested mounts', async () => {
  await fixture(async f => {
    const file = join(f.source, 'auth.json'), share = join(f.source, 'guest [mount]*');
    const bytes = Buffer.from([0, 255, 128, 10]); await writeFile(file, bytes); await chmod(file, 0o640);
    await link(file, join(f.source, 'auth-hard')); await symlink('/etc/example', join(f.source, 'external'));
    await mkdir(share); await writeFile(join(share, 'never-backup'), 'excluded-synthetic-mount');
    await writeFile(join(f.source, 'guest m'), 'near-match');
    expect(spawnSync('mkfifo', [join(f.source, 'fifo')]).status).toBe(0);
    await writeFile(f.mountinfo, (await readFile(f.mountinfo, 'utf8')) + mountLine(share));
    const attr = spawnSync('python3', ['-c', String.raw`
import os,struct,sys
p=sys.argv[1]
os.setxattr(p,'user.binary',bytes([0,255,128,10,61,0]))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p,'system.posix_acl_access',acl)
`, file]); expect(attr.status, attr.stderr.toString()).toBe(0);
    const result = f.execute(); expect(result.status, result.stderr.toString()).toBe(0);
    const archive = join(f.root, 'selected.tar'), fresh = join(f.root, 'fresh');
    await writeFile(archive, result.stdout); await mkdir(fresh);
    await expect(validateIncusSelectedRestoreArchive(archive, f.source)).resolves.toEqual({ entries: 5, expandedBytes: bytes.length + 10 });
    const extracted = spawnSync('/usr/bin/tar', ['--numeric-owner', '--same-permissions', '--xattrs', '--xattrs-include=*', '--acls', '-C', fresh, '-xpf', archive]);
    expect(extracted.status, extracted.stderr.toString()).toBe(0);
    const restored = join(fresh, 'selected'), restoredFile = join(restored, 'auth.json');
    expect(await readFile(restoredFile)).toEqual(bytes);
    expect(await readFile(join(restored, 'guest m'), 'utf8')).toBe('near-match');
    expect((await lstat(join(restored, 'auth-hard'))).ino).toBe((await lstat(restoredFile)).ino);
    expect(await readlink(join(restored, 'external'))).toBe('/etc/example');
    for (const name of ['guest [mount]*', 'fifo']) await expect(lstat(join(restored, name))).rejects.toMatchObject({ code: 'ENOENT' });
    const before = await lstat(file), after = await lstat(restoredFile);
    expect([after.uid, after.gid, after.mode & 0o7777]).toEqual([before.uid, before.gid, before.mode & 0o7777]);
    const metadata = spawnSync('python3', ['-c', String.raw`
import os,sys
a,b=sys.argv[1:]
for key in ('user.binary','system.posix_acl_access'): assert os.getxattr(a,key)==os.getxattr(b,key)
assert os.stat(a).st_mtime_ns==os.stat(b).st_mtime_ns
`, file, restoredFile]); expect(metadata.status, metadata.stderr.toString()).toBe(0);
  });
});

test('fixed built-in alias maps only its exact recorded symlink and preserves explicit selected synthetic credentials', async () => {
  await fixture(async f => {
    const alias = join(f.root, '.codex'), target = join(f.source, '.codex');
    await mkdir(target); await writeFile(join(target, 'auth.json'), 'synthetic-opted-in'); await symlink(target, alias);
    const result = f.execute(alias, undefined, { [alias]: target });
    expect(result.status, result.stderr.toString()).toBe(0);
    const archive = join(f.root, 'alias.tar'); await writeFile(archive, result.stdout);
    await expect(validateIncusSelectedRestoreArchive(archive, alias)).resolves.toEqual({ entries: 2, expandedBytes: 18 });
    expect(result.stdout.includes(Buffer.from('synthetic-opted-in'))).toBe(true);
    await unlink(alias); await symlink(f.source, alias);
    const replaced = f.execute(alias, undefined, { [alias]: target });
    expect(replaced.status).not.toBe(0); expect(replaced.stdout.length).toBe(0);
    expect(replaced.stderr.toString()).toContain('alias identity changed');
    await unlink(alias); await mkdir(alias);
    expect(f.execute(alias, undefined, { [alias]: target }).status).not.toBe(0);
  });
});

test('Kilo fixed basename remapping changes members and hardlinks but not symlink values', async () => {
  await fixture(async f => {
    const alias = join(f.root, 'kilo'), target = join(f.source, 'config');
    await mkdir(target); await writeFile(join(target, 'data'), 'state');
    await link(join(target, 'data'), join(target, 'hard')); await symlink('config/data', join(target, 'link')); await symlink(target, alias);
    const result = f.execute(alias, undefined, { [alias]: target }); expect(result.status, result.stderr.toString()).toBe(0);
    const archive = join(f.root, 'kilo.tar'); await writeFile(archive, result.stdout);
    await expect(validateIncusSelectedRestoreArchive(archive, alias)).resolves.toEqual({ entries: 4, expandedBytes: 5 });
    const inspect = spawnSync('python3', ['-c', String.raw`
import json,sys,tarfile
t=tarfile.open(sys.argv[1]);print(json.dumps([(m.name,m.linkname) for m in t]))
`, archive], { encoding: 'utf8' }); expect(inspect.status, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)).toEqual([['kilo', ''], ['kilo/data', ''], ['kilo/hard', 'kilo/data'], ['kilo/link', 'config/data']]);
  });
});

test('missing/stacked native mounts and guest covering overlays fail before emitting bytes', async () => {
  await fixture(async f => {
    await writeFile(join(f.source, 'data'), 'private');
    const proof = { mounts: ['/', f.source], credentials: false };
    expect(f.execute(f.source, proof).status).not.toBe(0);
    const primary = await readFile(f.mountinfo, 'utf8');
    await writeFile(f.mountinfo, primary + mountLine(f.source) + mountLine(f.source, 3));
    const stacked = f.execute(f.source, proof); expect(stacked.status).not.toBe(0); expect(stacked.stdout.length).toBe(0);
    await writeFile(f.mountinfo, primary + mountLine(f.source));
    const unknown = f.execute(); expect(unknown.status).not.toBe(0); expect(unknown.stdout.length).toBe(0);
    expect(unknown.stderr.toString()).toContain('unapproved guest mount');
    const approved = f.execute(f.source, proof); expect(approved.status, approved.stderr.toString()).toBe(0);
  });
});

test('unreadable/missing selected leaves and arbitrary symlink ancestors fail but selected leaf symlinks stay inert', async () => {
  await fixture(async f => {
    const file = join(f.source, 'private'); await writeFile(file, 'root-only-synthetic');
    const locked = spawnSync('sudo', ['-n', '--', 'chown', '0:0', file]); expect(locked.status, locked.stderr.toString()).toBe(0);
    const mode = spawnSync('sudo', ['-n', '--', 'chmod', '000', file]); expect(mode.status, mode.stderr.toString()).toBe(0);
    const denied = f.execute(file); expect(denied.status).not.toBe(0); expect(denied.stdout.length).toBe(0);
    expect(denied.stderr.toString()).toContain('unreadable by agent');
    // Existing backup semantics test selected roots as agent, then archive as
    // root to preserve privileged descendants' bytes and numeric ownership.
    const parent = f.execute(); expect(parent.status, parent.stderr.toString()).toBe(0);
    expect(parent.stdout.includes(Buffer.from('root-only-synthetic'))).toBe(true);
    expect(f.execute(join(f.source, 'missing')).status).not.toBe(0);
    const alias = join(f.root, 'arbitrary'); await symlink(f.source, alias);
    const ancestor = f.execute(join(alias, 'private')); expect(ancestor.status).not.toBe(0); expect(ancestor.stdout.length).toBe(0);
    expect(ancestor.stderr.toString()).toContain('ancestor is a symlink');
    const readable = join(f.source, 'readable'); await writeFile(readable, 'data');
    const regular = f.execute(readable); expect(regular.status, regular.stderr.toString()).toBe(0);
    const fileArchive = join(f.root, 'file.tar'); await writeFile(fileArchive, regular.stdout);
    await expect(validateIncusSelectedRestoreArchive(fileArchive, readable)).resolves.toEqual({ entries: 1, expandedBytes: 4 });
    const leaf = join(f.source, 'inert'); await symlink('readable', leaf);
    const result = f.execute(leaf); expect(result.status, result.stderr.toString()).toBe(0);
    const archive = join(f.root, 'leaf.tar'); await writeFile(archive, result.stdout);
    await expect(validateIncusSelectedRestoreArchive(archive, leaf)).resolves.toEqual({ entries: 1, expandedBytes: 0 });
  });
});

test('guest source guards reject malformed proofs, nonportable aliases and invalid mount observation without bytes', async () => {
  await fixture(async f => {
    for (const selected of ['relative', '/', '/run/agentor/secrets', '/proc/self', '/var/lib/docker/volumes']) {
      const invalid = f.execute(selected); expect(invalid.status).not.toBe(0); expect(invalid.stdout.length).toBe(0);
    }
    for (const proof of [null, {}, { mounts: ['/'], credentials: false, arbitrary: true },
      { mounts: ['relative'], credentials: false }, { mounts: ['/'], credentials: 'false' },
      { mounts: ['/'], credentials: true }]) {
      const result = f.execute(f.source, proof); expect(result.status).not.toBe(0); expect(result.stdout.length).toBe(0);
    }
    const alias = join(f.root, 'alias'); await symlink('/run/agentor', alias);
    const forbidden = f.execute(alias, undefined, { [alias]: '/run/agentor' });
    expect(forbidden.status).not.toBe(0); expect(forbidden.stdout.length).toBe(0);
    expect(forbidden.stderr.toString()).toContain('Nonportable selected source');
    await writeFile(f.mountinfo, 'malformed\n'); expect(f.execute().status).not.toBe(0);
    await writeFile(f.mountinfo, Buffer.alloc(1024 * 1024 + 1, 32));
    const tooLarge = f.execute(); expect(tooLarge.status).not.toBe(0); expect(tooLarge.stdout.length).toBe(0);
    expect(tooLarge.stderr.toString()).toContain('exceeds limit');
  });
});
