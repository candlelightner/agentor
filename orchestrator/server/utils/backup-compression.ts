import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export interface BackupCompressionOptions {
  signal?: AbortSignal;
  /** Null explicitly chooses the portable Node gzip fallback. */
  pigzPath?: string | null;
  threads?: number;
}

/** Bounded streaming level-6 gzip. A destination is exclusive and remains
 * private staging until the caller validates/publishes its enclosing backup.
 * Every failure awaits both pipelines and the child exit before removing it. */
export async function compressBackupStream(
  source: Readable,
  destination: string,
  options: BackupCompressionOptions = {},
): Promise<number> {
  options.signal?.throwIfAborted();
  const threads = options.threads ?? Math.min(4, availableParallelism());
  if (!Number.isInteger(threads) || threads < 1 || threads > 32)
    throw new Error('Backup compression thread count must be between 1 and 32');
  const executable = options.pigzPath === undefined
    ? existsSync('/usr/bin/pigz') ? '/usr/bin/pigz' : null : options.pigzPath;
  // Never truncate an existing artifact or remove it after a failed open.
  const file = await open(destination, 'wx', 0o600);
  const output = file.createWriteStream();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 1000);
    killTimer.unref();
  };
  const operations: Promise<unknown>[] = [];
  try {
    if (executable) {
      child = spawn(executable, ['-6', '-c', '-p', String(threads)], { stdio: ['pipe', 'pipe', 'ignore'] });
      closed = new Promise(resolve => child!.once('close', () => resolve()));
      const exited = new Promise<void>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('close', (code, childSignal) => code === 0 ? resolve() :
          reject(new Error(`Backup compression failed (${childSignal ?? `exit ${code}`})`)));
      });
      signal.addEventListener('abort', terminate, { once: true });
      if (signal.aborted) terminate();
      operations.push(pipeline(source, child.stdin!, { signal }), pipeline(child.stdout!, output, { signal }), exited);
    } else {
      operations.push(pipeline(source, createGzip({ level: 6 }), output, { signal }));
    }
    await Promise.all(operations);
    return (await stat(destination)).size;
  } catch (error) {
    controller.abort();
    terminate();
    source.destroy();
    output.destroy();
    await Promise.allSettled(operations);
    await closed;
    await file.close().catch(() => {});
    await rm(destination, { force: true });
    throw error;
  } finally {
    signal.removeEventListener('abort', terminate);
    if (killTimer) clearTimeout(killTimer);
    await file.close().catch(() => {});
  }
}
