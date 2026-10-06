import { constants, type Stats } from 'node:fs';
import { open, lstat, mkdir, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import * as tar from 'tar-stream';
import { INCUS_CONVERSION_RAW_BYTES, type IncusConvertedRaw } from './incus-image-converter';
import type { IncusClient, IncusImage } from './incus-client';

export interface IncusImageArtifactHooks {
  validateAuthority: () => Promise<void>;
  acknowledgeImport: (acknowledgement: Readonly<{ pending: boolean; operation?: string; fingerprint?: string }>) => Promise<void>;
}

/** Parent-only normalization/publication transport. No guest qcow, metadata,
 * filesystem/partition parser, mount/chroot or guest-selected host path/tool.
 * Root hooks bind these artifacts to the removed converter and existing job. */
export async function normalizeAndImportIncusImage(client: IncusClient, raw: IncusConvertedRaw,
  trustedScratchDirectory: string, hooks: IncusImageArtifactHooks, signal?: AbortSignal): Promise<IncusImage> {
  raw = structuredClone(raw);
  const active = async () => { signal?.throwIfAborted(); await hooks.validateAuthority(); signal?.throwIfAborted(); };
  if (!/^sha256:[a-f0-9]{64}$/.test(raw.sourceImageId) || !/^[a-f0-9]{64}$/.test(raw.recipeId) ||
      raw.rawBytes !== INCUS_CONVERSION_RAW_BYTES || raw.rawIdentity.size !== raw.rawBytes ||
      !Number.isSafeInteger(raw.rawIdentity.dev) || !Number.isSafeInteger(raw.rawIdentity.ino) ||
      basename(raw.rawPath) !== 'disk.raw' || !/^incus-image-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(basename(dirname(raw.rawPath))) ||
      trustedScratchDirectory !== join(dirname(raw.rawPath), 'normalized'))
    throw new Error('Trusted VM normalization requires exact converter RAW identity and fixed scratch');
  await active();
  const parent = await lstat(dirname(raw.rawPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.())
    throw new Error('Converter RAW scratch is not a private owned directory');
  let input: FileHandle | undefined, qcow: FileHandle | undefined, metadata: FileHandle | undefined;
  const qcowPath = join(trustedScratchDirectory, 'disk.qcow2'), metadataPath = join(trustedScratchDirectory, 'metadata.tar.gz');
  let qcowIdentity: Stats | undefined, metadataIdentity: Stats | undefined, normalizedIdentity: Stats | undefined;
  const sameFile = (current: Stats, expected: Pick<Stats, 'dev' | 'ino' | 'size'>) =>
    current.isFile() && current.dev === expected.dev && current.ino === expected.ino && current.size === expected.size &&
    current.uid === process.getuid?.() && (current.mode & 0o777) === 0o600 && current.nlink === 1;
  const removeFile = async (path: string, expected: Stats | Pick<Stats, 'dev' | 'ino' | 'size'>) => {
    if (!sameFile(await lstat(path), expected)) throw new Error('Derived artifact cleanup identity changed; files retained');
    await unlink(path);
  };
  try {
    input = await open(raw.rawPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameFile(await input.stat(), raw.rawIdentity)) throw new Error('Converter RAW inode/ownership/size changed');
    await mkdir(trustedScratchDirectory, { mode: 0o700 }); // Exclusive, never adopt another/previous artifact directory.
    normalizedIdentity = await lstat(trustedScratchDirectory);
    if (!normalizedIdentity.isDirectory() || normalizedIdentity.isSymbolicLink() ||
        normalizedIdentity.uid !== process.getuid?.() || (normalizedIdentity.mode & 0o777) !== 0o700)
      throw new Error('Normalization scratch identity is unavailable');
    qcow = await open(qcowPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await active();
    // Fixed raw input format is security-critical. Source bytes never select
    // a qemu driver, backing file, partition/filesystem parser or extra argv.
    const child = spawn('qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', '-c', '/proc/self/fd/3', '/proc/self/fd/4'],
      { stdio: ['ignore', 'ignore', 'pipe', input.fd, qcow.fd] });
    let stderr = Buffer.alloc(0), interrupted: Error | undefined;
    child.stderr?.on('data', (chunk: Buffer) => { stderr = chunk.length >= 8192 ? Buffer.from(chunk.subarray(-8192))
      : Buffer.concat([stderr, chunk]).subarray(-8192); });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const finished = new Promise<void>((resolve, reject) => { child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(interrupted ?? new Error(`Trusted RAW normalization failed (exit ${code}): ${stderr.toString('utf8')}`))); });
    const stop = (reason: Error) => { interrupted ??= reason;
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    const abort = () => stop(new Error('Trusted RAW normalization cancelled'));
    const timer = setTimeout(() => stop(new Error('Trusted RAW normalization deadline exceeded')), 20 * 60_000); timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    try { await finished; if (interrupted) throw interrupted; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    if (!sameFile(await input.stat(), raw.rawIdentity)) throw new Error('Converter RAW identity changed during normalization');
    await qcow.sync(); qcowIdentity = await qcow.stat(); await qcow.close(); qcow = undefined;
    if (!sameFile(await lstat(qcowPath), qcowIdentity) || qcowIdentity.size <= 0)
      throw new Error('Trusted qcow output identity is unavailable');
    await input.close(); input = undefined;
    await removeFile(raw.rawPath, raw.rawIdentity); // Known normalization complete; release reconstructable RAW disk space.
    const properties: Record<string, string> = {
      description: `Agentor Worker VM (Derived from ${raw.sourceImageId})`, os: 'ubuntu', release: 'noble',
      source_image: raw.sourceImageId, source_image_id: raw.sourceImageId, recipe_id: raw.recipeId,
      source_architecture: 'amd64', bootstrap_generation: '3', converter_version: 'v0.4.0',
    };
    const created = Math.floor(Date.now() / 1000);
    const yaml = `architecture: "x86_64"\ncreation_date: ${created}\nproperties:\n` +
      Object.entries(properties).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join('') + 'type: "virtual-machine"\n';
    metadata = await open(metadataPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const archive = tar.pack();
    archive.entry({ name: 'metadata.yaml', type: 'file', uid: 0, gid: 0, mode: 0o644, size: Buffer.byteLength(yaml),
      mtime: new Date(created * 1000) }, yaml); archive.finalize();
    const output = metadata.createWriteStream({ autoClose: false });
    try {
      await pipeline(archive, createGzip(), output, { signal });
      await metadata.sync(); metadataIdentity = await metadata.stat();
    } finally {
      // FileHandle.close waits on this stream's reference. Explicit stream
      // destruction closes/releases the handle even with autoClose:false;
      // sync/stat must therefore precede it on success, never follow it.
      if (!output.closed) { const closed = once(output, 'close'); output.destroy(); await closed; }
    }
    metadata = undefined;
    await active();
    if (!sameFile(await lstat(qcowPath), qcowIdentity) || !sameFile(await lstat(metadataPath), metadataIdentity))
      throw new Error('Trusted image artifact identity changed before import');
    await hooks.acknowledgeImport({ pending: true }); await active();
    let acceptedOperation: string | undefined;
    const image = await client.importImage(metadataPath, qcowPath, async operation => {
      acceptedOperation = operation;
      await hooks.acknowledgeImport({ pending: true, ...(operation ? { operation } : {}) });
    }, signal);
    // Capture known native resource even after revocation; that private receipt
    // grants cleanup evidence, not permission to publish or dispatch again.
    await hooks.acknowledgeImport({ pending: false, ...(acceptedOperation ? { operation: acceptedOperation } : {}), fingerprint: image.fingerprint });
    if (image.type !== 'virtual-machine' || image.architecture !== 'x86_64' || !/^[a-f0-9]{64}$/.test(image.fingerprint) ||
        Object.entries(properties).some(([key, value]) => image.properties?.[key] !== value))
      throw new Error('Imported VM metadata disagrees with trusted parent identity; retain private job/artifacts');
    await active();
    await removeFile(metadataPath, metadataIdentity); await removeFile(qcowPath, qcowIdentity);
    const currentDirectory = await lstat(trustedScratchDirectory);
    if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.dev !== normalizedIdentity.dev ||
        currentDirectory.ino !== normalizedIdentity.ino || currentDirectory.uid !== process.getuid?.() || (currentDirectory.mode & 0o777) !== 0o700)
      throw new Error('Normalization cleanup directory identity changed');
    await rmdir(trustedScratchDirectory); // Nonrecursive: an unexpected file is retained, never selected for deletion.
    return image;
  } finally { await Promise.all([input?.close(), qcow?.close(), metadata?.close()]); }
}
