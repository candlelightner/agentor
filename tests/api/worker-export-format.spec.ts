import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BUNDLE_FILES, extractBackupPathArchives, extractBundle, sanitizeBackupPathTarPayload, validateBackupPathTarPayload, validateGzipTarPayload, validateTarPayload, WORKER_EXPORT_VERSION } from '../../orchestrator/server/utils/worker-export';

type Entry = { name: string; body: Buffer; type?: string; linkname?: string };

async function tarBuffer(entries: Entry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${entry.body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, entry.body, Buffer.alloc((512 - (entry.body.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

function manifest(version: number, rootfs = true) {
  return Buffer.from(
    JSON.stringify({
      version,
      exportedAt: '2026-01-01T00:00:00.000Z',
      source: { id: 'source', displayName: 'source', containerName: 'source', imageName: 'agentor-worker' },
      worker: { displayName: 'imported', repos: [], mounts: [], initScript: '' },
      environment: { id: 'default', name: 'Default' },
      portMappings: [],
      domainMappings: [],
      contents: { rootfs, workspace: false, agents: false },
    }),
  );
}

async function withBundle(entries: Entry[], action: (bundle: string, destination: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-worker-export-format-'));
  try {
    const bundle = join(directory, 'bundle.tar');
    await writeFile(bundle, await tarBuffer(entries));
    await action(bundle, join(directory, 'extracted'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.describe('Worker export root filesystem format compatibility', () => {
  test('v2 accepts the transitional uncompressed rootfs.tar payload', async () => {
    const rawRootfs = await tarBuffer([{ name: 'etc/issue', body: Buffer.from('agentor\n') }]);
    await withBundle(
      [
        { name: BUNDLE_FILES.manifest, body: manifest(2) },
        { name: BUNDLE_FILES.legacyRootfs, body: rawRootfs },
      ],
      async (bundle, destination) => {
        const extracted = await extractBundle(bundle, destination);
        expect(extracted.manifest.version).toBe(2);
        expect(extracted.rootfsPath).toBe(join(destination, BUNDLE_FILES.legacyRootfs));
        expect(extracted.rootfsCompressed).toBe(false);
        await expect(validateTarPayload(extracted.rootfsPath!)).resolves.toBeUndefined();
      },
    );
  });

  test('v1 and current v3 accept gzip-compressed rootfs.tar.gz payloads', async () => {
    const rawRootfs = await tarBuffer([{ name: 'etc/issue', body: Buffer.from('legacy\n') }]);
    for (const version of [1, WORKER_EXPORT_VERSION])
      await withBundle(
        [
          { name: BUNDLE_FILES.manifest, body: manifest(version) },
          { name: BUNDLE_FILES.rootfs, body: gzipSync(rawRootfs) },
        ],
        async (bundle, destination) => {
          const extracted = await extractBundle(bundle, destination);
          expect(extracted.manifest.version).toBe(version);
          expect(extracted.rootfsPath).toBe(join(destination, BUNDLE_FILES.rootfs));
          expect(extracted.rootfsCompressed).toBe(true);
          await expect(validateGzipTarPayload(extracted.rootfsPath!)).resolves.toBeUndefined();
        },
      );
  });

  test('rejects ambiguous bundles carrying both root filesystem payload layouts', async () => {
    const rawRootfs = await tarBuffer([{ name: 'etc/issue', body: Buffer.from('x') }]);
    await withBundle(
      [
        { name: BUNDLE_FILES.manifest, body: manifest(2) },
        { name: BUNDLE_FILES.rootfs, body: rawRootfs },
        { name: BUNDLE_FILES.legacyRootfs, body: gzipSync(rawRootfs) },
      ],
      async (bundle, destination) => {
        await expect(extractBundle(bundle, destination)).rejects.toThrow('duplicate root filesystem payload');
      },
    );
  });

  test('rejects unsafe paths in an uncompressed root filesystem tar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentor-worker-export-unsafe-'));
    try {
      const payload = join(directory, 'rootfs.tar');
      await writeFile(payload, await tarBuffer([{ name: '../outside', body: Buffer.from('no') }]));
      await expect(validateTarPayload(payload)).rejects.toThrow('unsafe path');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('explicit backup path archives retain safe links, omit special entries, and reject write-through links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentor-backup-path-unsafe-'));
    try {
      const safe = join(directory, 'safe.tar'), output = join(directory, 'safe-output.tar');
      await writeFile(safe, await tarBuffer([
        { name: 'bin', body: Buffer.alloc(0), type: '2', linkname: 'usr/bin' },
        { name: 'usr', body: Buffer.alloc(0), type: '5' },
        { name: 'usr/bin', body: Buffer.alloc(0), type: '5' },
        { name: 'usr/bin/tool', body: Buffer.from('ok') },
        { name: 'device', body: Buffer.alloc(0), type: '3' },
        { name: 'pipe', body: Buffer.alloc(0), type: '6' },
      ]));
      await expect(sanitizeBackupPathTarPayload(safe, output, '/')).resolves.toEqual({ omittedSpecialEntries: 2 });
      const sanitized = await (await import('node:fs/promises')).readFile(output);
      expect(sanitized.includes(Buffer.from('usr/bin'))).toBe(true);
      expect(sanitized.includes(Buffer.from('device'))).toBe(false);

      for (const [index, entries] of [
        [{ name: 'dir/link', body: Buffer.alloc(0), type: '2', linkname: '../target' }, { name: 'dir/link/child', body: Buffer.from('x') }],
        [{ name: 'dir/child', body: Buffer.from('x') }, { name: 'dir', body: Buffer.alloc(0), type: '2', linkname: '../target' }],
        [{ name: 'one', body: Buffer.from('x') }, { name: 'two', body: Buffer.alloc(0), type: '1', linkname: '../outside' }],
        [{ name: '../escape', body: Buffer.from('x') }],
        [{ name: 'same', body: Buffer.from('x') }, { name: 'same', body: Buffer.from('y') }],
      ].entries()) {
        const payload = join(directory, `${index}.tar`);
        await writeFile(payload, await tarBuffer(entries));
        await expect(sanitizeBackupPathTarPayload(payload, `${payload}.out`, '/')).rejects.toThrow();
      }
      // Retain the old validator for legacy callers: it remains deliberately
      // strict; new backup paths use the sanitizer above.
      await expect(validateBackupPathTarPayload(safe)).rejects.toThrow('unsafe entry');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('explicit backup path archives retain Docker wrappers, settle malformed gzip, and observe aborts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentor-backup-path-boundaries-'));
    try {
      const selected = '/home/agent/.agent-data';
      const valid = join(directory, 'valid.tar');
      await writeFile(valid, await tarBuffer([
        { name: '.agent-data', body: Buffer.alloc(0), type: '5' },
        { name: '.agent-data/state.json', body: Buffer.from('{}') },
      ]));
      await expect(sanitizeBackupPathTarPayload(valid, `${valid}.out`, selected)).resolves.toEqual({ omittedSpecialEntries: 0 });

      const sibling = join(directory, 'sibling.tar');
      await writeFile(sibling, await tarBuffer([
        { name: '.ssh', body: Buffer.alloc(0), type: '5' },
        { name: '.ssh/authorized_keys', body: Buffer.from('attacker') },
      ]));
      await expect(sanitizeBackupPathTarPayload(sibling, `${sibling}.out`, selected)).rejects.toThrow('outside the selected path');

      const controller = new AbortController();
      controller.abort();
      await expect(sanitizeBackupPathTarPayload(valid, `${valid}.aborted`, selected, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

      const malformed = join(directory, 'malformed.tar.gz');
      await writeFile(malformed, Buffer.from('not a gzip stream'));
      await expect(extractBackupPathArchives(malformed, join(directory, 'extracted'), [{ path: selected, archive: 'paths/0.tar' }])).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects bundle versions newer than the supported format', async () => {
    await withBundle([{ name: BUNDLE_FILES.manifest, body: manifest(WORKER_EXPORT_VERSION + 1, false) }], async (bundle, destination) => {
      await expect(extractBundle(bundle, destination)).rejects.toThrow('newer than supported');
    });
  });
});
