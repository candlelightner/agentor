import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buffer } from 'node:stream/consumers';
import { sanitizeBackupPathTarGzip } from '../../orchestrator/server/utils/worker-export';
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { InstanceBackupManager } from '../../orchestrator/server/utils/instance-backup-manager';
import type { BackupManager } from '../../orchestrator/server/utils/backup-manager';
import { FakeBackupProvider } from '../../orchestrator/server/utils/backup-provider';
import { backupKeyFingerprint } from '../../orchestrator/server/utils/backup-keyring';
import { decryptInstanceBackup } from '../../orchestrator/server/utils/instance-backup-crypto';
import { inspectInstanceBundle } from '../../orchestrator/server/utils/instance-backup-bundle';
import { compressBackupStream } from '../../orchestrator/server/utils/backup-compression';

let root = '';
test.beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'backup-compression-')); });
test.afterEach(async () => { await rm(root, { recursive: true, force: true }); });

for (const implementation of ['node', 'pigz'] as const) {
  test(`level-six ${implementation} output is standard gzip with exact bytes and private permissions`, async () => {
    test.skip(implementation === 'pigz' && !existsSync('/usr/bin/pigz'), 'Optional parallel gzip is unavailable');
    const bytes = randomBytes(2 * 1024 * 1024), output = join(root, 'archive.gz');
    const size = await compressBackupStream(Readable.from([bytes]), output, {
      pigzPath: implementation === 'node' ? null : '/usr/bin/pigz', threads: 4,
    });
    expect(size).toBe((await stat(output)).size);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(gunzipSync(await readFile(output))).toEqual(bytes);
    execFileSync('gzip', ['-t', output]);
  });
}

test('compression source errors and missing compressors remove partial artifacts', async () => {
  for (const pigzPath of [null, '/usr/bin/pigz', join(root, 'missing-pigz')]) {
    if (pigzPath === '/usr/bin/pigz' && !existsSync(pigzPath)) continue;
    const output = join(root, 'failed-' + String(pigzPath).replaceAll('/', '-') + '.gz');
    const source = Readable.from((async function* () { yield randomBytes(256 * 1024); throw new Error('source failure'); })());
    await expect(compressBackupStream(source, output, { pigzPath })).rejects.toThrow();
    expect(existsSync(output)).toBe(false);
    expect(source.destroyed).toBe(true);
  }
});

test('existing outputs are preserved and pre-aborted compression never creates an artifact', async () => {
  const output = join(root, 'existing.gz');
  await writeFile(output, 'retained');
  await expect(compressBackupStream(Readable.from(['new']), output)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(output, 'utf8')).toBe('retained');
  const controller = new AbortController(); controller.abort();
  await expect(compressBackupStream(Readable.from(['new']), join(root, 'cancel.gz'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(existsSync(join(root, 'cancel.gz'))).toBe(false);
});

test('cancellation kills even a SIGTERM-ignoring compressor and waits for exit before cleanup', async () => {
  const executable = join(root, 'blocked-compressor'), pidFile = join(root, 'child.pid'), output = join(root, 'cancel.gz');
  await writeFile(executable, '#!/usr/bin/env node\n' +
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
    "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);\n", { mode: 0o700 });
  const source = new PassThrough(), controller = new AbortController();
  const pending = compressBackupStream(source, output, { pigzPath: executable, signal: controller.signal });
  pending.catch(() => {});
  try {
    source.write(Buffer.alloc(4096));
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    const pid = Number(await readFile(pidFile, 'utf8'));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(output)).toBe(false);
    expect(source.destroyed).toBe(true);
  } finally { controller.abort(); await pending.catch(() => {}); }
});

test('nonzero compressor exit rejects, settles its input, and removes its partial output', async () => {
  const executable = join(root, 'failed-compressor'), output = join(root, 'exit.gz');
  await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("partial"); process.exit(12);\n', { mode: 0o700 });
  const source = new PassThrough();
  await expect(compressBackupStream(source, output, { pigzPath: executable })).rejects.toThrow();
  expect(source.destroyed).toBe(true);
  expect(existsSync(output)).toBe(false);
});

const tar = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('tar-stream');
async function rawTar(entries: Array<{ name: string; type?: string; linkname?: string; body?: Buffer; mode?: number }>) {
  const pack = tar.pack(), result = buffer(pack);
  for (const entry of entries) await new Promise<void>((resolve, reject) => {
    const body = entry.body ?? Buffer.alloc(0);
    pack.entry({ ...entry, type: entry.type ?? 'file', size: body.length,
      uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtime: new Date('2026-01-01T00:00:00Z') },
      body, (error: Error | null) => error ? reject(error) : resolve());
  });
  pack.finalize(); return result;
}

for (const implementation of ['node', 'pigz'] as const) {
  test(`streamed ${implementation} sanitizer round-trip preserves files, metadata and safe links without TAR staging`, async () => {
    test.skip(implementation === 'pigz' && !existsSync('/usr/bin/pigz'), 'Optional parallel gzip is unavailable');
    const body = randomBytes(128 * 1024);
    const raw = await rawTar([{ name: 'source', type: 'directory', mode: 0o750 },
      { name: 'source/data', body, mode: 0o640 }, { name: 'source/hard', type: 'link', linkname: 'source/data' },
      { name: 'source/link', type: 'symlink', linkname: 'data' }, { name: 'source/special', type: 'character-device' }]);
    const output = join(root, 'volume.gz'), progress: number[] = [];
    expect(await sanitizeBackupPathTarGzip({ source: Readable.from([raw]), destination: output, selectedPath: '/',
      compression: { pigzPath: implementation === 'node' ? null : '/usr/bin/pigz' }, onBytes: bytes => progress.push(bytes) }))
      .toEqual({ omittedSpecialEntries: 1 });
    expect(progress.at(-1)).toBe(raw.length);
    expect(progress.every((bytes, index) => index === 0 || bytes > progress[index - 1]!)).toBe(true);
    expect(await readdir(root)).toEqual(['volume.gz']);
    const restored = join(root, 'restored'); await mkdir(restored);
    execFileSync('tar', ['-xzf', output, '-C', restored]);
    expect(await readFile(join(restored, 'source/data'))).toEqual(body);
    expect((await stat(join(restored, 'source/data'))).mode & 0o777).toBe(0o640);
    expect((await stat(join(restored, 'source/data'))).mtime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((await stat(join(restored, 'source/hard'))).ino).toBe((await stat(join(restored, 'source/data'))).ino);
    expect((await lstat(join(restored, 'source/link'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(restored, 'source/link'))).toBe('data');
    expect(existsSync(join(restored, 'source/special'))).toBe(false);
  });
}

test('streamed malformed, traversal and truncated TARs reject and remove partial compressed output', async () => {
  const valid = await rawTar([{ name: 'source/file', body: randomBytes(4096) }]);
  const traversal = await rawTar([{ name: '../outside', body: Buffer.from('escape') }]);
  for (const [index, raw] of [Buffer.from('malformed'), valid.subarray(0, 513), traversal].entries()) {
    const output = join(root, `bad-${index}.gz`), source = Readable.from([raw]);
    await expect(sanitizeBackupPathTarGzip({ source, destination: output, selectedPath: '/' })).rejects.toThrow();
    expect(existsSync(output)).toBe(false); expect(source.destroyed).toBe(true);
  }
});

test('mid-stream sanitizer cancellation stops source and compressor and removes the compressed partial', async () => {
  const raw = await rawTar([{ name: 'source/file', body: randomBytes(256 * 1024) }]);
  for (const pigzPath of [null, '/usr/bin/pigz']) {
    if (pigzPath && !existsSync(pigzPath)) continue;
    const controller = new AbortController(), source = Readable.from([raw]), output = join(root, 'cancel-stream.gz');
    await expect(sanitizeBackupPathTarGzip({ source, destination: output, selectedPath: '/', signal: controller.signal,
      compression: { pigzPath }, onBytes: () => controller.abort() })).rejects.toThrow();
    expect(existsSync(output)).toBe(false); expect(source.destroyed).toBe(true);
  }
});

test('instance manager streams two mocked Docker volumes through encrypted backup and content-verified tar restore', async () => {
  const markerA = randomBytes(64 * 1024), markerB = randomBytes(64 * 1024);
  const sources = new Map([
    ['agentor-fixture-a', await rawTar([{ name: 'source', type: 'directory' }, { name: 'source/data', body: markerA, mode: 0o640 }])],
    ['agentor-fixture-b', await rawTar([{ name: 'source', type: 'directory' }, { name: 'source/data', body: markerB, mode: 0o600 }])],
  ]);
  const removed: string[] = [];
  let releaseCapture!: () => void;
  const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
  const docker: any = {
    getVolume: () => ({ inspect: async () => ({}) }),
    getContainer: () => ({ inspect: async () => ({ Config: { Image: 'immutable-fixture-image' } }) }),
    createContainer: async (options: any) => {
      const name = options.HostConfig.Mounts[0].Source;
      return { start: async () => {}, getArchive: async () => Readable.from((async function* () {
        const raw = sources.get(name)!; yield raw.subarray(0, 32768);
        if (name.endsWith('-a')) await captureGate;
        yield raw.subarray(32768);
      })()),
        remove: async () => { removed.push(name); } };
    },
  };
  const provider = new FakeBackupProvider(join(root, 'provider'));
  const material = Buffer.alloc(32, 43).toString('base64');
  const manager = new InstanceBackupManager({ dataDir: join(root, 'data'), docker,
    backupManager: { instanceBackupProvider: () => provider, resolveInstanceRecoveryMaterial: async () =>
      ({ material, fingerprint: backupKeyFingerprint(material) }) } as unknown as BackupManager,
    authSnapshot: async destination => { await writeFile(destination, 'consistent auth fixture'); },
    preflightCreate: async () => {}, inventory: async () => ({
      volumes: [...sources.keys()].map(name => ({ name, kind: 'worker-workspace' as const, ownerId: 'owner', workerId: name })),
      plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
      hostMounts: { configuredPaths: [], contentsIncluded: false as const },
      images: { definitions: 0, immutableDigests: [], layersIncluded: false as const },
      storage: { mode: 'volume' as const, containerPrefix: 'agentor-fixture' },
    }),
  });
  const previousHostname = process.env.HOSTNAME;
  process.env.HOSTNAME = 'isolated-orchestrator-fixture';
  try {
    const job = await manager.create('owner', 'fake', { includeDockerVolumes: true });
    await expect.poll(async () => (await manager.getJob(job.id))?.volumeProgress?.uncompressedBytes ?? 0).toBeGreaterThan(0);
    expect((await manager.getJob(job.id))?.volumeProgress).toMatchObject({ name: 'agentor-fixture-a', index: 1, count: 2,
      phase: 'sanitizing-compressing', expectedBytes: null, percentage: null, etaSeconds: null });
    expect((await manager.list('owner')).jobs[0]?.volumeProgress?.uncompressedBytes).toBeGreaterThan(0);
    releaseCapture();
    await expect.poll(async () => (await manager.getJob(job.id))?.status).toMatch(/succeeded|failed|cancelled/);
    expect(await manager.getJob(job.id)).toMatchObject({ status: 'succeeded' });
    expect((await manager.getJob(job.id))?.volumeProgress).toBeUndefined();
    await (manager as any).tasks.get(job.id);
    expect(removed.sort()).toEqual([...sources.keys()].sort());
    const artifacts = (await manager.list('owner')).artifacts;
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0]!;
    const encrypted = join(root, 'download.enc'), plain = join(root, 'download.tar');
    await provider.download('owner', artifact.providerObjectId, encrypted);
    await decryptInstanceBackup(encrypted, plain, material, artifact.sha256);
    const inspected = await inspectInstanceBundle(plain, join(root, 'inspected'));
    expect(inspected.volumeArchives.size).toBe(2);
    for (const [index, [name, archive]] of [...inspected.volumeArchives].entries()) {
      const destination = join(root, `restored-${index}`); await mkdir(destination);
      execFileSync('tar', ['-xzf', archive, '-C', destination]);
      expect(await readFile(join(destination, 'source/data'))).toEqual(name.endsWith('-a') ? markerA : markerB);
      expect((await stat(join(destination, 'source/data'))).mode & 0o777).toBe(name.endsWith('-a') ? 0o640 : 0o600);
    }
    expect(await readdir(join(root, 'data/instance-restore-staging'))).toEqual([]);
  } finally {
    releaseCapture();
    manager.stop();
    if (previousHostname === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = previousHostname;
  }
});

test('Docker snapshot failure and mid-stream cancellation settle helper cleanup and remove partial output', async () => {
  const raw = await rawTar([{ name: 'source/data', body: randomBytes(8192) }]);
  const previousHostname = process.env.HOSTNAME;
  process.env.HOSTNAME = 'isolated-snapshot-fixture';
  try {
    for (const mode of ['malformed', 'source-error', 'cancel'] as const) {
      let removed = false;
      const controller = new AbortController(), output = join(root, mode + '.gz');
      const docker: any = { getVolume: () => ({ inspect: async () => ({}) }),
        getContainer: () => ({ inspect: async () => ({ Config: { Image: 'fixture' } }) }),
        createContainer: async () => ({ start: async () => {}, remove: async () => { removed = true; },
          getArchive: async () => mode === 'source-error' ? Readable.from((async function* () {
            yield raw.subarray(0, 1024); throw new Error('injected Docker source failure');
          })()) : Readable.from([mode === 'malformed' ? Buffer.from('bad tar') : raw]) }),
      };
      const manager = new InstanceBackupManager({ dataDir: join(root, mode), docker, backupManager: {} as BackupManager });
      await expect((manager as any).snapshotVolume('agentor-fixture', output, controller.signal,
        mode === 'cancel' ? () => controller.abort() : undefined)).rejects.toThrow();
      expect(removed).toBe(true); expect(existsSync(output)).toBe(false);
    }
  } finally { if (previousHostname === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = previousHostname; }
});
