import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateIncusCanonicalRestoreArchive, validatePortableManagedVolumeArchive } from '../../orchestrator/server/utils/portable-managed-volume-archive';

type Item = { name: string; type?: string; body?: string | Buffer; link?: string };
async function writeTar(path: string, items: Item[]) {
  const chunks: Buffer[] = [];
  for (const item of items) {
    const body = Buffer.from(item.body ?? ''), header = Buffer.alloc(512);
    header.write(item.name, 0, 100, 'utf8');
    for (const [offset, length, value] of [[100, 8, 0o640], [108, 8, 1000], [116, 8, 1000], [124, 12, body.length], [136, 12, 0]])
      header.write(value!.toString(8).padStart(length! - 1, '0') + '\0', offset!, length!, 'ascii');
    header.fill(32, 148, 156); header[156] = (item.type ?? '0').charCodeAt(0);
    if (item.link) header.write(item.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  await writeFile(path, Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function pax(key: string, value: string | Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(key + '='), Buffer.from(value), Buffer.from('\n')]);
  let length = body.length + 2;
  while (Buffer.byteLength(String(length)) + 1 + body.length !== length)
    length = Buffer.byteLength(String(length)) + 1 + body.length;
  return Buffer.concat([Buffer.from(length + ' '), body]);
}
async function fixture(run: (dir: string, archive: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-native-restore-tar-'));
  try { await run(dir, join(dir, 'archive.tar')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

for (const role of ['workspace', 'agents'] as const) test(`real GNU PAX ${role} retains binary metadata, roots and external guest symlinks unchanged`, async () => {
  await fixture(async (dir, archive) => {
    const root = role === 'workspace' ? 'workspace' : '.agent-data', stage = join(dir, 'stage'), source = join(stage, root);
    await mkdir(source, { recursive: true }); await chmod(source, 0o751);
    await writeFile(join(source, 'file'), Buffer.from([0, 255, 128, 10])); await chmod(join(source, 'file'), 0o640);
    await link(join(source, 'file'), join(source, 'hard'));
    await symlink('/home/agent/.claude/.credentials.json', join(source, 'absolute'));
    await symlink('../../home/agent/.config/shared', join(source, 'relative'));
    await symlink('/external/' + 'x'.repeat(150), join(source, 'long-link'));
    await writeFile(join(source, 'long-' + 'y'.repeat(110)), 'long PAX path');
    execFileSync('python3', ['-c', String.raw`
import os,struct,sys
p=sys.argv[1]
os.setxattr(p+'/file','user.binary',bytes([0,255,128,10,61,0]))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p+'/file','system.posix_acl_access',acl)
os.setxattr(p,'system.posix_acl_default',acl)
`, source]);
    execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', stage, '-cf', archive, root]);
    const original = await readFile(archive);
    await expect(validateIncusCanonicalRestoreArchive(archive, role)).resolves.toEqual({ entries: 7, expandedBytes: 17 });
    expect(await readFile(archive)).toEqual(original);
    const fresh = join(dir, 'fresh'); await mkdir(fresh);
    execFileSync('tar', ['--numeric-owner', '--same-owner', '--same-permissions', '--xattrs', '--xattrs-include=*', '--acls', '-C', fresh, '-xf', archive]);
    const restored = join(fresh, root), originalFile = await lstat(join(source, 'file')), restoredFile = await lstat(join(restored, 'file'));
    expect([restoredFile.uid, restoredFile.gid, restoredFile.mode & 0o7777]).toEqual([originalFile.uid, originalFile.gid, originalFile.mode & 0o7777]);
    expect((await lstat(restored)).mode & 0o7777).toBe((await lstat(source)).mode & 0o7777);
    expect((await lstat(join(restored, 'hard'))).ino).toBe(restoredFile.ino);
    expect(await readlink(join(restored, 'absolute'))).toBe('/home/agent/.claude/.credentials.json');
    expect(await readlink(join(restored, 'relative'))).toBe('../../home/agent/.config/shared');
    expect(await readlink(join(restored, 'long-link'))).toBe('/external/' + 'x'.repeat(150));
    execFileSync('python3', ['-c', String.raw`
import os,sys
a,b=sys.argv[1:]
for path,key in [('file','user.binary'),('file','system.posix_acl_access'),('','system.posix_acl_default')]:
 assert os.getxattr(a+'/'+path,key)==os.getxattr(b+'/'+path,key),(path,key)
assert os.stat(a+'/file').st_mtime_ns==os.stat(b+'/file').st_mtime_ns
`, source, restored]);
  });
});

test('canonical restoration rejects unsafe paths, root substitution and link writes in both orders', async () => {
  await fixture(async (_dir, archive) => {
    const root: Item = { name: 'workspace/', type: '5' }, file: Item = { name: 'workspace/file', body: 'x' };
    const attacks: Item[][] = [
      [], [file], [{ name: 'workspace', type: '2', link: '/etc' }],
      [root, { name: '.agent-data/file', body: 'x' }], [root, { name: 'workspace-other/file', body: 'x' }],
      ...['workspace/../etc/passwd', '/workspace/file', './workspace/file', 'workspace//file', 'workspace/./file', 'workspace\\file'].map(name => [root, { name, body: 'x' }]),
      [root, file, file], [root, file, { name: 'workspace/file/', type: '5' }],
      ...['2', '0', '1'].flatMap(type => {
        const parent: Item = { name: 'workspace/parent', type, ...(type !== '0' ? { link: 'workspace/file' } : {}) };
        const child: Item = { name: 'workspace/parent/child', body: 'x' };
        return [[root, file, parent, child], [root, file, child, parent]];
      }),
      [root, { name: 'workspace/empty', type: '2' }],
      [root, { name: 'workspace/control\n', body: 'x' }],
    ];
    for (const items of attacks) {
      await writeTar(archive, items);
      await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace')).rejects.toThrow(/root|path|symlink|duplicate|non-directory|string field/i);
    }
  });
});

test('hardlinks require an earlier regular file inside the same fixed role root', async () => {
  await fixture(async (_dir, archive) => {
    const root: Item = { name: '.agent-data/', type: '5' }, file: Item = { name: '.agent-data/file', body: 'x' };
    const cases = [
      [root, { name: '.agent-data/hard', type: '1', link: '.agent-data/file' }, file],
      ...['/etc/passwd', '../file', 'workspace/file', '.agent-data/../file', '.agent-data/file/', './.agent-data/file', '.agent-data/missing'].map(link => [root, file, { name: '.agent-data/hard', type: '1', link }]),
      [root, { name: '.agent-data/link', type: '2', link: 'file' }, { name: '.agent-data/hard', type: '1', link: '.agent-data/link' }],
      [root, { name: '.agent-data/dir/', type: '5' }, { name: '.agent-data/hard', type: '1', link: '.agent-data/dir' }],
      [root, file, { name: '.agent-data/hard', type: '1', link: '.agent-data/file' }, { name: '.agent-data/second', type: '1', link: '.agent-data/hard' }],
    ];
    for (const items of cases) {
      await writeTar(archive, items);
      await expect(validateIncusCanonicalRestoreArchive(archive, 'agents')).rejects.toThrow(/hardlink/i);
    }
  });
});

test('native validation retains managed-volume confinement and rejects tar extensions and PAX control attacks', async () => {
  await fixture(async (_dir, archive) => {
    await writeTar(archive, [{ name: 'volume/', type: '5' }, { name: 'volume/link', type: '2', link: '/etc/passwd' }]);
    await expect(validatePortableManagedVolumeArchive(archive)).rejects.toThrow(/symlink escapes/);
    const root: Item = { name: 'workspace/', type: '5' };
    for (const type of ['3', '4', '6', 'S', 'g', 'L', 'K']) {
      await writeTar(archive, [root, { name: 'workspace/special', type }]);
      await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace')).rejects.toThrow(/unsupported/);
    }
    const bodies = [
      ...['GNU.sparse.map', 'GNU.sparse.size', 'size', 'SCHILY.realsize', 'SCHILY.fflags'].map(key => pax(key, '1')),
      pax('path', 'workspace/../escape'), pax('path', Buffer.from([255, 128])),
      pax('linkpath', '/etc/passwd'), Buffer.concat([pax('path', 'workspace/file'), pax('path', 'workspace/duplicate')]),
      pax('SCHILY.acl.default', 'user::rw-\ngroup::r--\nother::---'),
    ];
    for (const body of bodies) {
      await writeTar(archive, [root, { name: 'pax', type: 'x', body }, { name: 'workspace/file', body: 'x' }]);
      await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace')).rejects.toThrow(/PAX|unsafe|metadata/i);
    }
  });
});

for (const role of ['workspace', 'agents'] as const) test(`V7 and GNU dialect prefixes cannot disguise outside-${role} writes`, async () => {
  await fixture(async (dir, archive) => {
    const root = role === 'workspace' ? 'workspace' : '.agent-data';
    for (const dialect of ['v7', 'gnu']) {
      await writeTar(archive, [{ name: root + '/', type: '5' }, { name: 'entrypoint.sh', body: 'outside fixed root' }]);
      const raw = await readFile(archive), header = raw.subarray(512, 1024);
      header.fill(0, 257, 265);
      if (dialect === 'gnu') header.write('ustar  \0', 257, 8, 'ascii');
      header.write(root, 345, 155, 'ascii');
      header.fill(32, 148, 156);
      header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      await writeFile(archive, raw);
      if (dialect === 'v7') {
        // Demonstrate the actual extractor disagreement only inside a fresh
        // temporary fixture. Never extract rejected bytes in production.
        const fresh = join(dir, 'v7-extractor-proof'); await mkdir(fresh);
        execFileSync('tar', ['-C', fresh, '-xf', archive]);
        await chmod(join(fresh, root), 0o700);
        expect(await readFile(join(fresh, 'entrypoint.sh'), 'utf8')).toBe('outside fixed root');
        await expect(lstat(join(fresh, root, 'entrypoint.sh'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(validateIncusCanonicalRestoreArchive(archive, role)).rejects.toThrow(/dialect|USTAR|magic/i);
    }
  });
});

test('role, cancellation, input type, framing and aggregate work remain bounded', async () => {
  await fixture(async (dir, archive) => {
    await writeTar(archive, [{ name: 'workspace/', type: '5' }, { name: 'workspace/file', body: 'data' }]);
    await expect(validateIncusCanonicalRestoreArchive(archive, 'other' as any)).rejects.toThrow(/role/);
    await expect(validateIncusCanonicalRestoreArchive(archive, 'agents')).rejects.toThrow(/outside/);
    await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace', { maxEntries: 1 })).rejects.toThrow(/too many/);
    await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace', { maxExpandedBytes: 3 })).rejects.toThrow(/size limit/);
    await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace', { maxEntries: -1 })).rejects.toThrow(/limits/);
    const controller = new AbortController(); controller.abort(new Error('cancelled-native-restore'));
    await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace', { signal: controller.signal })).rejects.toThrow(/cancelled-native-restore/);
    const alias = join(dir, 'alias.tar'); await symlink(archive, alias);
    await expect(validateIncusCanonicalRestoreArchive(alias, 'workspace')).rejects.toThrow(/regular file/);
    const original = await readFile(archive);
    const bad = Buffer.from(original); bad[0] ^= 1; await writeFile(archive, bad);
    await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace')).rejects.toThrow(/checksum/);
    await writeFile(archive, original.subarray(0, 513));
    await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace')).rejects.toThrow(/truncated/);
    await writeFile(archive, Buffer.concat([original, Buffer.from('unexpected')]));
    await expect(validateIncusCanonicalRestoreArchive(archive, 'workspace')).rejects.toThrow(/data after/);
  });
});
