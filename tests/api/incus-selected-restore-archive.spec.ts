import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateIncusSelectedRestoreArchive } from '../../orchestrator/server/utils/portable-managed-volume-archive';

type Item = { name: string; type?: string; body?: string | Buffer; link?: string };
async function writeTar(path: string, items: Item[]) {
  const chunks: Buffer[] = [];
  for (const item of items) {
    const body = Buffer.from(item.body ?? ''), header = Buffer.alloc(512);
    header.write(item.name, 0, 100, 'utf8');
    for (const [offset, length, value] of [[100, 8, item.type === '5' ? 0o750 : 0o640], [108, 8, 1000], [116, 8, 1000], [124, 12, body.length], [136, 12, 0]])
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
  const dir = await mkdtemp(join(tmpdir(), 'agentor-selected-restore-tar-'));
  try { await run(dir, join(dir, 'archive.tar')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

for (const selected of ['/home/agent/.codex', '/']) test(`GNU PAX selected ${selected} preserves opted-in credentials and binary metadata without repacking`, async () => {
  await fixture(async (dir, archive) => {
    const stage = join(dir, 'stage'), wrapper = selected === '/' ? '.' : '.codex', source = join(stage, wrapper);
    await mkdir(source, { recursive: true }); await chmod(source, 0o751);
    // Synthetic fixture only: explicit selection must not silently redact it.
    const credential = Buffer.from('{"fixture":"explicit synthetic credential"}');
    await writeFile(join(source, 'auth.json'), credential); await chmod(join(source, 'auth.json'), 0o640);
    await link(join(source, 'auth.json'), join(source, 'auth-hard'));
    await symlink('/home/agent/shared', join(source, 'external'));
    await writeFile(join(source, 'long-' + 'x'.repeat(110)), 'long PAX entry');
    execFileSync('python3', ['-c', String.raw`
import os,struct,sys
p=sys.argv[1]
os.setxattr(p+'/auth.json','user.binary',bytes([0,255,128,10,61,0]))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p+'/auth.json','system.posix_acl_access',acl)
os.setxattr(p,'system.posix_acl_default',acl)
`, source]);
    execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', stage, '-cf', archive, wrapper]);
    const raw = await readFile(archive);
    await expect(validateIncusSelectedRestoreArchive(archive, selected)).resolves.toEqual({ entries: 5, expandedBytes: credential.length + 14 });
    expect(await readFile(archive)).toEqual(raw);
    const fresh = join(dir, 'fresh'); await mkdir(fresh);
    execFileSync('tar', ['--numeric-owner', '--same-owner', '--same-permissions', '--xattrs', '--xattrs-include=*', '--acls', '-C', fresh, '-xf', archive]);
    const restored = join(fresh, wrapper), before = await lstat(join(source, 'auth.json')), after = await lstat(join(restored, 'auth.json'));
    expect(await readFile(join(restored, 'auth.json'))).toEqual(credential);
    expect([after.uid, after.gid, after.mode & 0o7777]).toEqual([before.uid, before.gid, before.mode & 0o7777]);
    expect((await lstat(join(restored, 'auth-hard'))).ino).toBe(after.ino);
    expect(await readlink(join(restored, 'external'))).toBe('/home/agent/shared');
    execFileSync('python3', ['-c', String.raw`
import os,sys
a,b=sys.argv[1:]
for path,key in [('auth.json','user.binary'),('auth.json','system.posix_acl_access'),('','system.posix_acl_default')]:
 assert os.getxattr(a+'/'+path,key)==os.getxattr(b+'/'+path,key),(path,key)
assert os.stat(a+'/auth.json').st_mtime_ns==os.stat(b+'/auth.json').st_mtime_ns
`, source, restored]);
  });
});

test('selected file and symlink wrappers are valid without inventing a directory root', async () => {
  await fixture(async (dir, archive) => {
    const stage = join(dir, 'stage'); await mkdir(stage);
    const content = 'synthetic explicitly selected auth.json'; await writeFile(join(stage, 'auth.json'), content, { mode: 0o600 });
    execFileSync('tar', ['--format=pax', '--numeric-owner', '-C', stage, '-cf', archive, 'auth.json']);
    const raw = await readFile(archive);
    await expect(validateIncusSelectedRestoreArchive(archive, '/home/agent/.codex/auth.json')).resolves.toEqual({ entries: 1, expandedBytes: content.length });
    expect(await readFile(archive)).toEqual(raw);
    await writeTar(archive, [{ name: 'selected', type: '2', link: '/etc/config' }]);
    await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).resolves.toEqual({ entries: 1, expandedBytes: 0 });
  });
});

test('guest-root member ./ prefixes normalize independently without permitting path aliases or duplicate root entries', async () => {
  await fixture(async (_dir, archive) => {
    await writeTar(archive, [{ name: './', type: '5' }, { name: 'file', body: 'data' }, { name: './hard', type: '1', link: './file' },
      { name: './dir/', type: '5' }, { name: 'dir/link', type: '2', link: '../file' }]);
    await expect(validateIncusSelectedRestoreArchive(archive, '/')).resolves.toEqual({ entries: 5, expandedBytes: 4 });
    for (const items of [
      [{ name: './', type: '5' }, { name: '.', type: '5' }],
      [{ name: 'file', body: 'a' }, { name: './file', body: 'b' }],
      [{ name: './file/', body: 'x' }],
      ...['././', './.', 'dir//'].map(name => [{ name, type: '5' }]),
      [{ name: './dir/', type: '5' }, { name: 'dir', body: 'x' }],
      ...['././file', 'dir/./file', 'dir//file', '../file', '/file'].map(name => [{ name, body: 'x' }]),
    ]) {
      await writeTar(archive, items);
      await expect(validateIncusSelectedRestoreArchive(archive, '/')).rejects.toThrow();
    }
  });
});

test('selected wrappers cannot write siblings, traverse paths or write below links/non-directories in either order', async () => {
  await fixture(async (_dir, archive) => {
    const root: Item = { name: 'selected/', type: '5' }, file: Item = { name: 'selected/file', body: 'x' };
    const attacks: Item[][] = [
      ...['sibling', 'selected-other/file', 'selected/../escape', '/selected/file', './selected/file', 'selected//file', 'selected/./file', 'selected\\file'].map(name => [root, { name, body: 'x' }]),
      [root, { name: 'selected/file/', body: 'x' }],
      [root, file, file], [root, file, { name: 'selected/file/', type: '5' }],
      ...['2', '0', '1'].flatMap(type => {
        const parent: Item = { name: 'selected/parent', type, ...(type !== '0' ? { link: type === '2' ? '/etc' : 'selected/file' } : {}) }, child: Item = { name: 'selected/parent/child', body: 'x' };
        return [[root, file, parent, child], [root, file, child, parent]];
      }),
    ];
    for (const items of attacks) { await writeTar(archive, items); await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).rejects.toThrow(); }
  });
});

test('inert external symlinks cannot lexically climb above guest / and hardlinks require earlier rooted regular data', async () => {
  await fixture(async (_dir, archive) => {
    const root: Item = { name: 'selected/', type: '5' }, file: Item = { name: 'selected/file', body: 'x' };
    for (const target of ['/etc/config', '../outside', '../../elsewhere']) {
      await writeTar(archive, [root, { name: 'selected/link', type: '2', link: target }]);
      await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).resolves.toMatchObject({ entries: 2 });
    }
    for (const target of ['../../../above', '/../../above', '', 'bad\\target', 'bad\ntarget']) {
      await writeTar(archive, [root, { name: 'selected/link', type: '2', link: target }]);
      await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).rejects.toThrow();
    }
    const hardCases: Item[][] = [
      [root, { name: 'selected/hard', type: '1', link: 'selected/file' }, file],
      ...['file', '/srv/selected/file', 'other/file', 'selected/../file', 'selected/missing', 'selected/file/'].map(link => [root, file, { name: 'selected/hard', type: '1', link }]),
      [root, { name: 'selected/link', type: '2', link: 'file' }, { name: 'selected/hard', type: '1', link: 'selected/link' }],
      [root, { name: 'selected/dir/', type: '5' }, { name: 'selected/hard', type: '1', link: 'selected/dir' }],
    ];
    for (const items of hardCases) { await writeTar(archive, items); await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).rejects.toThrow(); }
  });
});

test('selected restore rejects tar dialect disagreement, specials and PAX path/link/control manipulation', async () => {
  await fixture(async (_dir, archive) => {
    const root: Item = { name: 'selected/', type: '5' };
    for (const type of ['3', '4', '6', 'S', 'g', 'L', 'K']) {
      await writeTar(archive, [root, { name: 'selected/special', type }]);
      await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).rejects.toThrow(/unsupported/);
    }
    for (const body of [
      ...['GNU.sparse.map', 'size', 'SCHILY.realsize', 'SCHILY.fflags'].map(key => pax(key, '1')),
      pax('path', 'sibling'), pax('path', 'selected/../escape'), pax('path', Buffer.from([255])),
      Buffer.concat([pax('path', 'selected/a'), pax('path', 'selected/b')]), pax('linkpath', '/etc/config'),
    ]) {
      await writeTar(archive, [root, { name: 'pax', type: 'x', body }, { name: 'selected/file', body: 'x' }]);
      await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).rejects.toThrow();
    }
    for (const dialect of ['v7', 'gnu']) {
      await writeTar(archive, [root, { name: 'entrypoint.sh', body: 'outside' }]);
      const raw = await readFile(archive), header = raw.subarray(512, 1024);
      header.fill(0, 257, 265); if (dialect === 'gnu') header.write('ustar  \0', 257, 8, 'ascii');
      header.write('selected', 345, 155, 'ascii'); header.fill(32, 148, 156);
      header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      await writeFile(archive, raw);
      await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).rejects.toThrow(/POSIX USTAR/);
    }
  });
});

test('selected path, cancellation, limits and framing fail without altering raw source bytes', async () => {
  await fixture(async (_dir, archive) => {
    await writeTar(archive, [{ name: 'selected/', type: '5' }, { name: 'selected/file', body: 'data' }]);
    const raw = await readFile(archive);
    for (const selected of ['', 'relative', '/unsafe\0path', '/bad\\path', null])
      await expect(validateIncusSelectedRestoreArchive(archive, selected as any)).rejects.toThrow();
    await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected', { maxEntries: 1 })).rejects.toThrow(/too many/);
    await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected', { maxExpandedBytes: 3 })).rejects.toThrow(/size limit/);
    await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected', { maxEntries: -1 })).rejects.toThrow(/limits/);
    const controller = new AbortController(); controller.abort(new Error('cancelled selected archive'));
    await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected', { signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(await readFile(archive)).toEqual(raw);
    await writeFile(archive, raw.subarray(0, 513));
    await expect(validateIncusSelectedRestoreArchive(archive, '/srv/selected')).rejects.toThrow(/truncated/);
  });
});
