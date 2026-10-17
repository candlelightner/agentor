import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validatePortableManagedVolumeArchive, validateIncusCanonicalRestoreArchive,
  validateIncusDockerRestoreArchive, validateIncusSelectedRestoreArchive,
  MAX_PORTABLE_MANAGED_VOLUME_EXPANDED_BYTES,
} from '../../orchestrator/server/utils/portable-managed-volume-archive';

function header(name: string, size = 0, type = '0', link = ''): Buffer {
  const out = Buffer.alloc(512);
  out.write(name, 0, 100, 'utf8');
  for (const [offset, width, value] of [[100, 8, 0o640], [108, 8, 1000], [116, 8, 1000], [124, 12, size], [136, 12, 0]])
    out.write(value!.toString(8).padStart(width! - 1, '0') + '\0', offset!, width!, 'ascii');
  out.fill(32, 148, 156); out[156] = type.charCodeAt(0);
  if (link) out.write(link, 157, 100);
  out.write('ustar\0', 257, 6, 'ascii'); out.write('00', 263, 2, 'ascii');
  out.write([...out].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return out;
}
function pax(value: string | Buffer): Buffer {
  const body = Buffer.concat([Buffer.from('size='), Buffer.from(value), Buffer.from('\n')]);
  let size = body.length + 2;
  while (String(size).length + 1 + body.length !== size) size = String(size).length + 1 + body.length;
  return Buffer.concat([Buffer.from(`${size} `), body]);
}
function member(name: string, body: Buffer | string, rawSize = Buffer.byteLength(body), type = '0', link = ''): Buffer {
  const bytes = Buffer.from(body);
  return Buffer.concat([header(name, rawSize, type, link), bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function archive(root: string, value: string | Buffer, body: Buffer | string, rawSize = 0, type = '0'): Buffer {
  return Buffer.concat([header(root + '/', 0, '5'), member('PaxHeaders/large', pax(value), undefined, 'x'),
    member(root + '/large', body, rawSize, type, root + '/after'), member(root + '/after', 'after'), Buffer.alloc(1024)]);
}
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-pax-size-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

for (const root of ['workspace', '.agent-data', 'volume', 'docker'] as const)
  test(`bounded PAX size overrides zero raw header and preserves following ${root} member in validator and GNU extraction`, async () => {
    await fixture(async dir => {
      const path = join(dir, 'archive.tar'), body = Buffer.alloc(1025, 0x61), destination = join(dir, 'out');
      await writeFile(path, archive(root, String(body.length), body));
      const validate = root === 'workspace' || root === '.agent-data'
        ? () => validateIncusCanonicalRestoreArchive(path, root === 'workspace' ? 'workspace' : 'agents')
        : root === 'docker' ? () => validateIncusDockerRestoreArchive(path) : () => validatePortableManagedVolumeArchive(path, { requirePosixUstar: true });
      await expect(validate()).resolves.toEqual({ entries: 3, expandedBytes: 1030 });
      await expect(validateIncusSelectedRestoreArchive(path, '/' + root)).resolves.toEqual({ entries: 3, expandedBytes: 1030 });
      await mkdir(destination);
      execFileSync('tar', ['--numeric-owner', '--same-permissions', '-xf', path, '-C', destination]);
      expect(await readFile(join(destination, root, 'large'))).toEqual(body);
      expect(await readFile(join(destination, root, 'after'), 'utf8')).toBe('after');
    });
  });

test('zero PAX size overrides a larger raw header for body framing and GNU extraction', async () => {
  await fixture(async dir => {
    const path = join(dir, 'zero.tar'), destination = join(dir, 'out');
    await writeFile(path, archive('workspace', '0', '', 1024 * 1024));
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace')).resolves.toEqual({ entries: 3, expandedBytes: 5 });
    await mkdir(destination); execFileSync('tar', ['-xf', path, '-C', destination]);
    expect((await stat(join(destination, 'workspace/large'))).size).toBe(0);
    expect(await readFile(join(destination, 'workspace/after'), 'utf8')).toBe('after');
  });
});

test('PAX size rejects malformed, duplicate, excessive and non-file overrides without weakening TAR rules', async () => {
  await fixture(async dir => {
    const path = join(dir, 'invalid.tar');
    for (const value of ['', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '1\0', '9'.repeat(40), Buffer.from([0xb1]), String(MAX_PORTABLE_MANAGED_VOLUME_EXPANDED_BYTES + 1)]) {
      await writeFile(path, archive('workspace', value, 'x'));
      await expect(validateIncusCanonicalRestoreArchive(path, 'workspace')).rejects.toThrow(/PAX size/i);
    }
    const duplicate = Buffer.concat([header('workspace/', 0, '5'), member('pax', Buffer.concat([pax('1'), pax('2')]), undefined, 'x'), member('workspace/file', 'x'), Buffer.alloc(1024)]);
    await writeFile(path, duplicate);
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace')).rejects.toThrow(/duplicate key/i);
    for (const type of ['5', '2', '1', '3', '4', '6']) {
      await writeFile(path, archive('docker', '0', '', 0, type));
      await expect(validateIncusDockerRestoreArchive(path)).rejects.toThrow(/PAX size|hardlink/i);
    }
    await writeFile(path, archive('workspace', '1', 'x', 0, 'S'));
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace')).rejects.toThrow(/unsupported.*type/i);
  });
});

test('effective PAX size enforces aggregate limits, truncation and subsequent-member alignment', async () => {
  await fixture(async dir => {
    const path = join(dir, 'invalid.tar');
    await writeFile(path, archive('workspace', '1025', Buffer.alloc(1025)));
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace', { maxExpandedBytes: 1024 })).rejects.toThrow(/size limit/i);
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace', { maxExpandedBytes: 1029 })).rejects.toThrow(/size limit/i);
    await writeFile(path, archive('workspace', '4096', 'x'));
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace')).rejects.toThrow(/truncated/i);
    await writeFile(path, archive('workspace', '1', Buffer.alloc(1025, 0x61)));
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace')).rejects.toThrow(/checksum|tar header/i);
  });
});

test('exact 8 GiB PAX boundary scans a sparse TAR using positional reads and remains bounded', async () => {
  await fixture(async dir => {
    const path = join(dir, 'sparse.tar'), size = 8 * 1024 ** 3;
    const start = Buffer.concat([header('workspace/', 0, '5'), member('pax', pax(String(size)), undefined, 'x'), header('workspace/disk.raw')]);
    const after = member('workspace/after', 'after'), file = await open(path, 'wx');
    try {
      await file.write(start, 0, start.length, 0);
      await file.write(after, 0, after.length, start.length + size);
      await file.write(Buffer.alloc(1024), 0, 1024, start.length + size + after.length);
    } finally { await file.close(); }
    const info = await stat(path);
    expect(info.size).toBeGreaterThan(size);
    expect(info.blocks * 512).toBeLessThan(1024 * 1024);
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace')).resolves.toEqual({ entries: 3, expandedBytes: size + 5 });
    await expect(validateIncusCanonicalRestoreArchive(path, 'workspace', { maxExpandedBytes: size - 1 })).rejects.toThrow(/size limit/i);
    const listed = execFileSync('tar', ['-tf', path], { encoding: 'utf8', timeout: 10_000 });
    expect(listed.trim().split('\n')).toEqual(['workspace/', 'workspace/disk.raw', 'workspace/after']);
    expect((await stat(path)).blocks * 512).toBeLessThan(1024 * 1024);
  });
});
