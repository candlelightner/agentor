import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { validateIncusDockerRestoreArchive, validateIncusCanonicalRestoreArchive,
  validateIncusSelectedRestoreArchive, validatePortableManagedVolumeArchive,
  extractIncusSelectedRestorePayload, extractIncusExplicitRestorePayload } from '../../orchestrator/server/utils/portable-managed-volume-archive';

type Item = { name: string; type?: string; body?: string | Buffer; link?: string;
  major?: number | Buffer; minor?: number | Buffer };
const root: Item = { name: 'docker/', type: '5' };
const file: Item = { name: 'docker/file', body: Buffer.from([0, 255, 128, 10]) };
const checksum = (header: Buffer) => {
  header.fill(32, 148, 156);
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
};
async function writeTar(path: string, items: Item[]) {
  const chunks: Buffer[] = [];
  for (const item of items) {
    const body = Buffer.from(item.body ?? ''), header = Buffer.alloc(512);
    header.write(item.name, 0, 100, 'utf8');
    for (const [offset, length, value] of [[100, 8, item.type === '5' ? 0o750 : 0o640],
      [108, 8, 12345], [116, 8, 23456], [124, 12, body.length], [136, 12, 100]])
      header.write(value!.toString(8).padStart(length! - 1, '0') + '\0', offset!, length!, 'ascii');
    header[156] = (item.type ?? '0').charCodeAt(0);
    if (item.link) header.write(item.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    for (const [offset, value] of [[329, item.major ?? 0], [337, item.minor ?? 0]] as const) {
      if (Buffer.isBuffer(value)) value.copy(header, offset, 0, 8);
      else header.write(value.toString(8).padStart(7, '0') + '\0', offset, 8, 'ascii');
    }
    checksum(header); chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
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
async function fixture(run: (directory: string, archive: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-docker-restore-codec-'));
  try { await run(directory, join(directory, 'archive.tar')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function payload(directory: string, items: Item[]) {
  const raw = join(directory, 'wrapper.tar'), compressed = join(directory, 'paths.tar.gz');
  await writeTar(raw, items); await writeFile(compressed, gzipSync(await readFile(raw))); return compressed;
}

test('real GNU PAX Docker regular data, links, binary xattrs and ACL metadata validate without repacking', async () => {
  await fixture(async (directory, archive) => {
    const stage = join(directory, 'stage'), docker = join(stage, 'docker'); await mkdir(docker, { recursive: true });
    await writeFile(join(docker, 'file'), Buffer.from([0, 255, 128, 10])); await chmod(join(docker, 'file'), 0o640);
    await link(join(docker, 'file'), join(docker, 'hard')); await symlink('/etc/example', join(docker, 'inert'));
    execFileSync('python3', ['-c', String.raw`
import os,struct,sys
p=sys.argv[1];os.setxattr(p,'user.binary',bytes([0,255,128,10,61,0]))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p,'system.posix_acl_access',acl)
`, join(docker, 'file')]);
    execFileSync('/usr/bin/tar', ['--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', stage, '-cf', archive, 'docker']);
    const bytes = await readFile(archive);
    await expect(validateIncusDockerRestoreArchive(archive)).resolves.toEqual({ entries: 4, expandedBytes: 4 });
    expect(await readFile(archive)).toEqual(bytes);
  });
});

test('GNU tar warns and omits Unix sockets without inventing a portable socket entry', async () => {
  await fixture(async (directory, archive) => {
    const stage = join(directory, 'stage'), docker = join(stage, 'docker'); await mkdir(docker, { recursive: true });
    await writeFile(join(docker, 'data'), 'ordinary-data');
    execFileSync('python3', ['-c',
      'import socket,sys; s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.bind(sys.argv[1]); s.close()',
      join(docker, 'daemon.sock')]);
    const captured = spawnSync('/usr/bin/tar', ['--format=pax', '--numeric-owner', '-C', stage, '-cf', archive, 'docker']);
    expect(captured.status, captured.stderr.toString()).toBe(0);
    expect(captured.stderr.toString()).toMatch(/daemon\.sock: socket ignored/);
    const bytes = await readFile(archive);
    await expect(validateIncusDockerRestoreArchive(archive)).resolves.toEqual({ entries: 2, expandedBytes: 13 });
    const names = spawnSync('/usr/bin/tar', ['-tf', archive], { encoding: 'utf8' });
    expect(names.status, names.stderr).toBe(0); expect(names.stdout.trim().split('\n')).toEqual(['docker/', 'docker/data']);
    expect(await readFile(archive)).toEqual(bytes);
  });
});

test('Docker-only whiteouts, nonzero character/block devices and FIFOs are bounded zero-payload archive bytes', async () => {
  await fixture(async (_directory, archive) => {
    await writeTar(archive, [root, file, { name: 'docker/hard', type: '1', link: 'docker/file' },
      { name: 'docker/inert', type: '2', link: '/guest/elsewhere' },
      { name: 'docker/overlay2/whiteout', type: '3' },
      { name: 'docker/volumes/null', type: '3', major: 1, minor: 3 },
      { name: 'docker/volumes/block', type: '4', major: 4095, minor: 1048575 },
      { name: 'docker/volumes/fifo', type: '6' }]);
    const bytes = await readFile(archive);
    await expect(validateIncusDockerRestoreArchive(archive)).resolves.toEqual({ entries: 8, expandedBytes: 4 });
    expect(await readFile(archive)).toEqual(bytes);
    // No archive is extracted and no device/FIFO is created by this suite.
  });
});

test('opaque binary overlay xattrs, ACLs and timestamps remain unchanged on Docker special entries', async () => {
  await fixture(async (_directory, archive) => {
    const binary = Buffer.from([0, 255, 128, 10, 61, 0]);
    await writeTar(archive, [root,
      { name: 'pax', type: 'x', body: Buffer.concat([pax('SCHILY.xattr.trusted.overlay.opaque', binary),
        pax('mtime', '100.123456789'), pax('SCHILY.acl.access', 'user::rw-,group::r--,other::---')]) },
      { name: 'docker/volumes/whiteout', type: '3' },
      { name: 'pax2', type: 'x', body: pax('SCHILY.xattr.user.binary', binary) }, file]);
    const bytes = await readFile(archive);
    await expect(validateIncusDockerRestoreArchive(archive)).resolves.toEqual({ entries: 3, expandedBytes: 4 });
    expect(await readFile(archive)).toEqual(bytes);
  });
});

test('Docker devices reject out-of-range/negative identities and nondevices cannot carry device numbers', async () => {
  await fixture(async (_directory, archive) => {
    const cases: Item[] = [
      { name: 'docker/device', type: '3', major: 4096 }, { name: 'docker/device', type: '4', minor: 1048576 },
      { name: 'docker/device', type: '3', major: Buffer.alloc(8, 255) },
      ...['0', '1', '2', '5', '6'].map(type => ({ name: 'docker/nondevice', type, major: 1,
        ...(type === '1' || type === '2' ? { link: 'docker/file' } : {}) })),
    ];
    for (const item of cases) {
      await writeTar(archive, [root, file, item]);
      await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(/device.*(invalid|negative)|invalid device/i);
    }
  });
});

test('ordinary POSIX headers may omit device fields but actual devices must carry parsed major/minor numbers', async () => {
  await fixture(async (_directory, archive) => {
    await writeTar(archive, [{ ...root, major: Buffer.alloc(8), minor: Buffer.alloc(8) },
      { ...file, major: Buffer.alloc(8), minor: Buffer.alloc(8) }]);
    await expect(validateIncusDockerRestoreArchive(archive)).resolves.toEqual({ entries: 2, expandedBytes: 4 });
    for (const type of ['3', '4']) for (const field of ['major', 'minor'] as const) {
      await writeTar(archive, [root, { name: 'docker/device', type, [field]: Buffer.alloc(8) }]);
      await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(/device.*invalid/);
    }
  });
});

test('all non-file entries require zero payload and all non-directory ancestors reject descendant writes in both orders', async () => {
  await fixture(async (_directory, archive) => {
    for (const type of ['1', '2', '3', '4', '5', '6']) {
      const item = { name: 'docker/entry', type, body: 'unexpected-data', ...(type === '1' || type === '2' ? { link: 'docker/file' } : {}) };
      await writeTar(archive, [root, file, item]); await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(/non-file.*data/);
    }
    for (const type of ['0', '1', '2', '3', '4', '6']) {
      const parent: Item = { name: 'docker/parent', type, ...(type === '1' || type === '2' ? { link: 'docker/file' } : {}) };
      const child = { name: 'docker/parent/child', body: 'data' };
      for (const pair of [[parent, child], [child, parent]]) {
        await writeTar(archive, [root, file, ...pair]);
        await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(/non-directory/);
      }
    }
  });
});

test('Docker wrapper/path/type duplicates and hardlinks cannot escape or reference later/nonregular entries', async () => {
  await fixture(async (_directory, archive) => {
    const cases: Item[][] = [[], [file], [{ name: 'docker', type: '2', link: '/etc' }],
      ...['workspace/file', 'docker-other/file', '/docker/file', './docker/file', 'docker/../escape',
        'docker//file', 'docker/./file', 'docker\\file', 'docker/control\n'].map(name => [root, { name, body: 'x' }]),
      [root, file, file], [root, file, { name: 'docker/file/', type: '5' }],
      [root, { name: 'docker/hard', type: '1', link: 'docker/file' }, file],
      ...['file', '/docker/file', '../file', 'workspace/file', 'docker/../file', 'docker/missing', 'docker/file/'].map(link =>
        [root, file, { name: 'docker/hard', type: '1', link }]),
      ...['2', '3', '4', '5', '6'].map(type => [root, { name: 'docker/target', type, ...(type === '2' ? { link: 'file' } : {}) },
        { name: 'docker/hard', type: '1', link: 'docker/target' }]),
    ];
    for (const items of cases) { await writeTar(archive, items); await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(); }
  });
});

test('Docker dialect does not admit sparse/global PAX, control metadata or header-prefix extractor disagreement', async () => {
  await fixture(async (_directory, archive) => {
    for (const type of ['S', 'g', 'L', 'K', '7', 's']) {
      await writeTar(archive, [root, { name: 'docker/unsupported', type }]);
      await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(/unsupported/);
    }
    for (const body of [...['GNU.sparse.map', 'GNU.sparse.name', 'size', 'SCHILY.realsize', 'SCHILY.fflags', 'SCHILY.devmajor'].map(key => pax(key, '1')),
      pax('path', 'docker/../escape'), pax('path', Buffer.from([255])), pax('linkpath', '/etc'),
      Buffer.concat([pax('path', 'docker/a'), pax('path', 'docker/b')])]) {
      await writeTar(archive, [root, { name: 'pax', type: 'x', body }, file]);
      await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow();
    }
    for (const dialect of ['v7', 'gnu']) {
      await writeTar(archive, [root, { name: 'entrypoint.sh', body: 'outside' }]);
      const bytes = await readFile(archive), header = bytes.subarray(512, 1024);
      header.fill(0, 257, 265); if (dialect === 'gnu') header.write('ustar  \0', 257, 8, 'ascii');
      header.write('docker', 345, 155, 'ascii'); checksum(header); await writeFile(archive, bytes);
      await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(/POSIX USTAR/);
    }
  });
});

test('selected, canonical and managed archive roles never acquire Docker special authority through accidental flags', async () => {
  await fixture(async (_directory, archive) => {
    for (const type of ['3', '4', '6']) {
      for (const wrapper of ['workspace', '.agent-data', 'selected', 'volume']) {
        await writeTar(archive, [{ name: wrapper + '/', type: '5' }, { name: wrapper + '/special', type }]);
        const flags = { allowDockerSpecials: true, requirePosixUstar: true } as any;
        const result = wrapper === 'workspace' || wrapper === '.agent-data'
          ? validateIncusCanonicalRestoreArchive(archive, wrapper === 'workspace' ? 'workspace' : 'agents', flags)
          : wrapper === 'selected' ? validateIncusSelectedRestoreArchive(archive, '/srv/selected', flags)
            : validatePortableManagedVolumeArchive(archive, flags);
        await expect(result).rejects.toThrow(/unsupported/);
      }
    }
  });
});

test('Docker codec bounds/cancellation/checksums/framing reject without mutating input bytes', async () => {
  await fixture(async (_directory, archive) => {
    await writeTar(archive, [root, file]); const bytes = await readFile(archive);
    await expect(validateIncusDockerRestoreArchive(archive, { maxEntries: 1 })).rejects.toThrow(/too many/);
    await expect(validateIncusDockerRestoreArchive(archive, { maxExpandedBytes: 3 })).rejects.toThrow(/size limit/);
    for (const maxEntries of [-1, NaN, 1.5]) await expect(validateIncusDockerRestoreArchive(archive, { maxEntries })).rejects.toThrow(/limits/);
    const controller = new AbortController(); controller.abort(new Error('cancelled Docker codec'));
    await expect(validateIncusDockerRestoreArchive(archive, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(await readFile(archive)).toEqual(bytes);
    for (const bad of [bytes.subarray(0, 513), bytes.subarray(0, bytes.length - 1024),
      Buffer.concat([bytes, Buffer.from([1])])]) {
      await writeFile(archive, bad); await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(/truncated|end marker|framing/);
    }
    const corrupt = Buffer.from(bytes); corrupt[0] = corrupt[0]! ^ 1; await writeFile(archive, corrupt);
    await expect(validateIncusDockerRestoreArchive(archive)).rejects.toThrow(/checksum/);
  });
});

test('explicit Docker wrapper stages mixed manifest unchanged raw special and binary PAX bytes, never extracting devices', async () => {
  await fixture(async (directory, archive) => {
    await writeTar(archive, [root,
      { name: 'pax', type: 'x', body: pax('SCHILY.xattr.user.binary', Buffer.from([0, 255, 128, 10])) }, file,
      { name: 'docker/whiteout', type: '3' }, { name: 'docker/device', type: '4', major: 7, minor: 4096 },
      { name: 'docker/fifo', type: '6' }]);
    const docker = await readFile(archive), selectedArchive = join(directory, 'selected.tar');
    await writeTar(selectedArchive, [{ name: 'selected/', type: '5' }, { name: 'selected/data', body: 'selected data' }]);
    const selected = await readFile(selectedArchive);
    const compressed = await payload(directory, [{ name: 'paths/7.tar', body: selected }, { name: 'paths/0.tar', body: docker }]);
    const original = await readFile(compressed), destination = join(directory, 'decoded');
    const result = await extractIncusExplicitRestorePayload(compressed,
      [{ path: '/var/lib/docker', archive: 'paths/0.tar' }, { path: '/tmp/selected', archive: 'paths/7.tar' }], destination);
    expect(result.map(item => item.path)).toEqual(['/var/lib/docker', '/tmp/selected']);
    expect(await readFile(result[0]!.archivePath)).toEqual(docker); expect(await readFile(result[1]!.archivePath)).toEqual(selected);
    expect((await readdir(destination)).sort()).toEqual(['paths-0.tar', 'paths-7.tar']);
    for (const item of result) expect((await lstat(item.archivePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(compressed)).toEqual(original);
  });
});

test('ordinary selected wrapper rejects all Docker data before allocation and never inherits special authority', async () => {
  await fixture(async (directory, archive) => {
    for (const [index, items] of [[root, file], [root, { name: 'docker/whiteout', type: '3' }]].entries()) {
      await writeTar(archive, items);
      const compressed = await payload(directory, [{ name: 'paths/0.tar', body: await readFile(archive) }]);
      const destination = join(directory, 'ordinary-' + index);
      await expect(extractIncusSelectedRestorePayload(compressed,
        [{ path: '/var/lib/docker', archive: 'paths/0.tar' }], destination, { allowDockerSpecials: true } as any)).rejects.toThrow(/manifest/);
      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await writeTar(archive, [{ name: 'selected/', type: '5' }, { name: 'selected/special', type: '3' }]);
    const compressed = await payload(directory, [{ name: 'paths/0.tar', body: await readFile(archive) }]);
    for (const [index, decode] of [extractIncusSelectedRestorePayload, extractIncusExplicitRestorePayload].entries()) {
      const destination = join(directory, 'nonguest-docker-' + index);
      await expect(decode(compressed, [{ path: '/tmp/selected', archive: 'paths/0.tar' }], destination)).rejects.toThrow(/unsupported/);
      expect(await readdir(destination)).toEqual([]);
    }
  });
});

test('explicit Docker manifest accepts only exact canonical path and rejects malformed selections before allocation', async () => {
  await fixture(async (directory, archive) => {
    await writeTar(archive, [root, file]);
    const compressed = await payload(directory, [{ name: 'paths/0.tar', body: await readFile(archive) }]);
    const entry = { path: '/var/lib/docker', archive: 'paths/0.tar' };
    const invalid = ['/var/lib/docker/', '/var/lib/docker/volumes', '/var/lib/docker/../docker',
      '/var/lib//docker', '/var/lib/docker\\volumes', 'var/lib/docker'];
    const manifests = [...invalid.map(path => [{ ...entry, path }]), [entry, entry],
      [{ ...entry, archive: '../paths/0.tar' }]];
    for (const [index, entries] of manifests.entries()) {
      const destination = join(directory, 'invalid-' + index);
      await expect(extractIncusExplicitRestorePayload(compressed, entries, destination)).rejects.toThrow(/manifest/);
      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

test('explicit Docker wrapper framing and inner validation failures clean only own staged bytes', async () => {
  await fixture(async (directory, archive) => {
    await writeTar(archive, [root, file]); const docker = await readFile(archive);
    const entries = [{ path: '/var/lib/docker', archive: 'paths/0.tar' }];
    const cases: Item[][] = [[], [{ name: 'paths/1.tar', body: docker }],
      [{ name: 'paths/0.tar', body: docker }, { name: 'paths/0.tar', body: docker }],
      [{ name: '../paths/0.tar', body: docker }], [{ name: 'paths/0.tar', type: '2', link: '/etc' }],
      [{ name: 'paths/0.tar', body: docker.subarray(0, 513) }]];
    for (const [index, items] of cases.entries()) {
      const compressed = await payload(directory, items), destination = join(directory, 'framing-' + index);
      await expect(extractIncusExplicitRestorePayload(compressed, entries, destination)).rejects.toThrow();
      expect(await readdir(destination)).toEqual([]);
    }
    await writeTar(archive, [{ name: 'workspace/', type: '5' }]);
    let compressed = await payload(directory, [{ name: 'paths/0.tar', body: await readFile(archive) }]);
    const wrongRoot = join(directory, 'wrong-root');
    await expect(extractIncusExplicitRestorePayload(compressed, entries, wrongRoot)).rejects.toThrow(/docker/);
    expect(await readdir(wrongRoot)).toEqual([]);
    await writeTar(archive, [{ name: 'not-selected/', type: '5' }]);
    compressed = await payload(directory, [{ name: 'paths/0.tar', body: docker }, { name: 'paths/1.tar', body: await readFile(archive) }]);
    const laterFailure = join(directory, 'later-failure');
    await expect(extractIncusExplicitRestorePayload(compressed, [...entries,
      { path: '/tmp/selected', archive: 'paths/1.tar' }], laterFailure)).rejects.toThrow(/selected/);
    expect(await readdir(laterFailure)).toEqual([]);
    const corrupt = join(directory, 'corrupt.gz'); await writeFile(corrupt, gzipSync(docker).subarray(0, 16));
    const corruptDestination = join(directory, 'corrupt');
    await expect(extractIncusExplicitRestorePayload(corrupt, entries, corruptDestination)).rejects.toThrow();
    expect(await readdir(corruptDestination)).toEqual([]);
    const occupied = join(directory, 'occupied'); await mkdir(occupied); await writeFile(join(occupied, 'keep'), 'retained');
    await expect(extractIncusExplicitRestorePayload(compressed, entries, occupied)).rejects.toThrow(/empty/);
    expect(await readFile(join(occupied, 'keep'), 'utf8')).toBe('retained');
    const cancelled = new AbortController(); cancelled.abort(new Error('explicit-Docker-cancelled'));
    const cancelledDestination = join(directory, 'cancelled');
    await expect(extractIncusExplicitRestorePayload(compressed, entries, cancelledDestination,
      { signal: cancelled.signal })).rejects.toThrow(/explicit-Docker-cancelled/);
    await expect(lstat(cancelledDestination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
