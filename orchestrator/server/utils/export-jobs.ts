import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ExportJobStore, type ExportJobRecord } from './export-job-store';
import { useWorkerConfigStore } from './worker-config-store';

const SUCCESS_RETENTION_MS = 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 40 * 1024 * 1024 * 1024;
const MAX_RUNNING_JOBS = 2;
const MAX_PENDING_PER_USER = 5;

export type PublicExportJob = Omit<ExportJobRecord, 'userId'> & {
  downloadReady: boolean;
};

export interface ExportJobManagerOptions {
  store?: ExportJobStore;
  removeArtifact?: (path: string) => Promise<void>;
  resolveMissingSecrets?: (userId: string, workerId: string) => Promise<string[]>;
  ownerCleanupTimeoutMs?: number;
}

function now(): string {
  return new Date().toISOString();
}

function safeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (/not found/i.test(message)) return 'Worker not found';
  if (/running or stopped|exportable state/i.test(message)) return 'Worker is not in an exportable state';
  if (/insufficient temporary storage/i.test(message)) return 'Insufficient temporary storage for export';
  if (/artifact exceeds the size limit/i.test(message)) return 'Export artifact exceeds the configured size limit';
  return 'Export failed. Check server logs for details.';
}

async function readDirIfExists(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export class ExportJobManager {
  private readonly store: ExportJobStore;
  private readonly artifactsDir: string;
  private initPromise?: Promise<void>;
  private activeStreams = new Map<string, Readable>();
  private controllers = new Map<string, AbortController>();
  private runningJobs = new Set<string>();
  private activeTasks = new Map<string, Promise<void>>();
  private ownerQueues = new Map<string, Promise<void>>();
  private jobQueues = new Map<string, Promise<void>>();
  private closedOwners = new Set<string>();
  private cleanupTimer?: NodeJS.Timeout;
  private readonly artifactRemover: (path: string) => Promise<void>;
  private readonly resolveMissingSecrets: (userId: string, workerId: string) => Promise<string[]>;
  private readonly ownerCleanupTimeoutMs: number;

  constructor(
    dataDir: string,
    private readonly exportWorker: (workerId: string, opts: {
      includeRootfs: boolean;
      signal?: AbortSignal;
      onProgress?: (update: { phase: string; progress: number; bytesProcessed: number }) => void | Promise<void>;
    }) => Promise<{ stream: Readable; filename: string }>,
    private readonly logError: (message: string) => void,
    options: ExportJobManagerOptions = {},
  ) {
    this.store = options.store ?? new ExportJobStore(dataDir);
    this.artifactsDir = join(dataDir, 'export-artifacts');
    this.artifactRemover = options.removeArtifact ?? ((path) => rm(path, { force: true }));
    this.ownerCleanupTimeoutMs = Math.max(1, options.ownerCleanupTimeoutMs ?? 30_000);
    this.resolveMissingSecrets = options.resolveMissingSecrets ?? (async (userId, workerId) =>
      (await useWorkerConfigStore().resolveValues(userId, workerId))
        .filter((entry) => entry.kind !== 'variable').map((entry) => entry.key));
  }

  async init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true, mode: 0o700 });
    await this.store.init();

    const knownArtifactIds = new Set(this.store.list().map((job) => `${job.id}.tar`));
    for (const name of await readDirIfExists(this.artifactsDir)) {
      if (name.endsWith('.tar') && !knownArtifactIds.has(name)) {
        await this.artifactRemover(join(this.artifactsDir, name));
      }
    }

    // A hard kill cannot run ContainerManager's stream cleanup handlers. Sweep
    // only its uniquely-prefixed export scratch directories on startup.
    const tmpDir = join(this.artifactsDir, '..', 'tmp');
    for (const name of await readDirIfExists(tmpDir)) {
      if (name.startsWith('export-')) await rm(join(tmpDir, name), { recursive: true, force: true });
    }

    // Work cannot safely resume inside ContainerManager after a process restart.
    // Preserve the record but fail it explicitly and remove any partial artifact.
    for (const job of this.store.list()) {
      if (job.status === 'queued' || job.status === 'running') {
        const stamp = now();
        const failed: ExportJobRecord = {
          ...job,
          status: 'failed', phase: 'failed',
          error: 'Export was interrupted by an orchestrator restart. Start a new export.',
          updatedAt: stamp, completedAt: stamp,
          expiresAt: new Date(Date.now() + TERMINAL_RETENTION_MS).toISOString(),
        };
        await this.removeArtifact(job.id);
        await this.store.save(failed);
      }
    }
    await this.cleanupExpired();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((error) =>
        this.logError(`[export-jobs] cleanup failed: ${error instanceof Error ? error.message : error}`),
      );
    }, 15 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  async create(userId: string, workerId: string, includeRootfs = false): Promise<PublicExportJob> {
    await this.init();
    return this.withOwner(userId, async () => {
      this.assertOwnerOpen(userId);
      const pending = this.store.listForUser(userId)
        .filter((item) => item.status === 'queued' || item.status === 'running');
      if (pending.some((item) => item.workerId === workerId)) {
        const err = new Error('An export is already active for this worker') as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      if (pending.length >= MAX_PENDING_PER_USER) {
        const err = new Error('Too many export jobs are queued') as Error & { statusCode?: number };
        err.statusCode = 429;
        throw err;
      }
      const missingSecrets = await this.resolveMissingSecrets(userId, workerId);
      this.assertOwnerOpen(userId);
      const stamp = now();
      const job: ExportJobRecord = {
        id: randomUUID(), userId, workerId, includeRootfs,
        status: 'queued', phase: 'queued', progress: 0, bytesProcessed: 0,
        createdAt: stamp, updatedAt: stamp, missingSecrets,
      };
      await this.store.save(job);
      setImmediate(() => this.dispatch());
      return this.toPublic(job);
    });
  }

  async get(id: string): Promise<ExportJobRecord | undefined> {
    await this.init();
    await this.cleanupExpired();
    return this.store.findById(id);
  }

  async cancel(job: ExportJobRecord): Promise<PublicExportJob> {
    await this.init();
    return this.withJob(job.id, async () => {
      const current = this.store.findById(job.id);
      if (!current) throw new Error('Export job not found');
      if (current.status === 'succeeded' || current.status === 'failed')
        return this.toPublic(current);
      if (current.status !== 'cancelled') {
        const stamp = now();
        const cancelled: ExportJobRecord = {
          ...current,
          status: 'cancelled', phase: 'cancelled', updatedAt: stamp,
          completedAt: stamp,
          expiresAt: new Date(Date.now() + TERMINAL_RETENTION_MS).toISOString(),
        };
        await this.store.save(cancelled);
      }
      this.controllers.get(job.id)?.abort(new Error('Export cancelled'));
      this.activeStreams.get(job.id)?.destroy(new Error('Export cancelled'));
      await this.removeArtifact(job.id);
      this.dispatch();
      return this.toPublic(this.store.findById(job.id)!);
    });
  }

  async openArtifact(job: ExportJobRecord): Promise<{ stream: Readable; size: number; filename: string }> {
    await this.init();
    if (job.status !== 'succeeded') throw new Error('Export artifact is not ready');
    const path = this.artifactPath(job.id);
    const info = await stat(path);
    return {
      stream: createReadStream(path),
      size: info.size,
      filename: job.filename || 'worker-export.tar',
    };
  }

  listUserIds(): string[] {
    return this.store.listUserIds();
  }

  async removeForUser(userId: string): Promise<number> {
    this.closedOwners.add(userId);
    await this.init();
    return this.withOwner(userId, async () => {
      const jobs = this.store.listForUser(userId);
      for (const job of jobs) {
        this.controllers.get(job.id)?.abort(new Error('Export owner removed'));
        this.activeStreams.get(job.id)?.destroy(new Error('Export owner removed'));
      }
      await this.drainOwnerTasks(
        jobs.map((job) => this.activeTasks.get(job.id)).filter((task): task is Promise<void> => Boolean(task)),
      );
      for (const job of jobs)
        await this.withJob(job.id, () => this.removeArtifact(job.id));
      return this.store.removeForUser(userId);
    });
  }

  toPublic(job: ExportJobRecord): PublicExportJob {
    const { userId: _userId, ...publicJob } = job;
    return { ...publicJob, downloadReady: job.status === 'succeeded' };
  }

  private dispatch(): void {
    if (this.runningJobs.size >= MAX_RUNNING_JOBS) return;
    const runningWorkers = new Set(
      [...this.runningJobs]
        .map((id) => this.store.findById(id)?.workerId)
        .filter((workerId): workerId is string => Boolean(workerId)),
    );
    const next = this.store.list().find((candidate) =>
      candidate.status === 'queued' && !this.closedOwners.has(candidate.userId) &&
      !runningWorkers.has(candidate.workerId));
    if (!next) return;
    this.runningJobs.add(next.id);
    const task = this.run(next.id).catch((err) => {
      this.logError(`[export-jobs] unexpected runner failure for job ${next.id}: ${err instanceof Error ? err.message : err}`);
    }).finally(() => {
      this.runningJobs.delete(next.id);
      this.activeTasks.delete(next.id);
      this.controllers.delete(next.id);
      this.dispatch();
    });
    this.activeTasks.set(next.id, task);
    if (this.runningJobs.size < MAX_RUNNING_JOBS) this.dispatch();
  }

  private async run(id: string): Promise<void> {
    const queued = this.store.findById(id);
    if (!queued || queued.status !== 'queued' || this.closedOwners.has(queued.userId)) return;
    // Register cancellation before the first await or published running state;
    // DELETE can now abort every preparation phase without a race window.
    const controller = new AbortController();
    this.controllers.set(queued.id, controller);
    try {
      const startedAt = now();
      const job = await this.transition(id, (current) => {
        if (current.status !== 'queued') return;
        Object.assign(current, {
          status: 'running', phase: 'preparing', startedAt,
          updatedAt: startedAt, progress: 1,
        });
      });
      if (!job || job.status !== 'running') return;
      const fsInfo = await statfs(this.artifactsDir);
      const freeBytes = fsInfo.bavail * fsInfo.bsize;
      if (!Number.isFinite(freeBytes) || freeBytes < MIN_FREE_BYTES) {
        throw new Error('Insufficient temporary storage for export');
      }
      if (this.store.findById(id)?.status === 'cancelled' || controller.signal.aborted) return;
      const result = await this.exportWorker(job.workerId, {
        includeRootfs: job.includeRootfs,
        signal: controller.signal,
        onProgress: async (update) => {
          await this.transition(id, (current) => {
            if (current.status !== 'running') return;
            current.phase = update.phase as ExportJobRecord['phase'];
            current.progress = update.progress;
            current.bytesProcessed = update.bytesProcessed;
            current.updatedAt = now();
          });
        },
      });
      if (controller.signal.aborted || this.closedOwners.has(job.userId) || this.store.findById(id)?.status === 'cancelled') {
        result.stream.destroy();
        return;
      }

      await this.transition(id, (current) => {
        if (current.status !== 'running') return;
        current.phase = 'writing-artifact';
        current.progress = 90;
        current.filename = result.filename;
        current.updatedAt = now();
      });

      this.activeStreams.set(job.id, result.stream);
      let artifactBytes = 0;
      let bytesProcessed = this.store.findById(id)?.bytesProcessed ?? 0;
      let bytesAtLastPersist = bytesProcessed;
      const counter = new Transform({
        transform: (chunk, _encoding, callback) => {
          const length = Buffer.byteLength(chunk);
          artifactBytes += length;
          bytesProcessed += length;
          if (artifactBytes > MAX_ARTIFACT_BYTES) {
            callback(new Error('Export artifact exceeds the size limit'));
            return;
          }
          if (bytesProcessed - bytesAtLastPersist >= 64 * 1024 * 1024) {
            bytesAtLastPersist = bytesProcessed;
            this.transition(id, (current) => {
              if (current.status !== 'running') return;
              current.bytesProcessed = bytesProcessed;
              current.updatedAt = now();
            }).then(() => callback(null, chunk), callback);
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(result.stream, counter, createWriteStream(this.artifactPath(job.id), { mode: 0o600 }));
      this.activeStreams.delete(job.id);
      if (this.store.findById(id)?.status === 'cancelled') {
        await this.removeArtifact(job.id);
        return;
      }

      const completedAt = now();
      await this.transition(id, (current) => {
        if (current.status !== 'running') return;
        Object.assign(current, {
          status: 'succeeded', phase: 'complete', progress: 100,
          bytesProcessed, updatedAt: completedAt, completedAt,
          expiresAt: new Date(Date.now() + SUCCESS_RETENTION_MS).toISOString(),
        });
      });
    } catch (err) {
      this.activeStreams.delete(id);
      let cleanupError: unknown;
      try {
        await this.removeArtifact(id);
      } catch (error) {
        cleanupError = error;
      }
      if (this.store.findById(id)?.status === 'cancelled') {
        if (cleanupError) throw cleanupError;
        return;
      }
      const completedAt = now();
      const failed = await this.transition(id, (current) => {
        if (current.status === 'cancelled') return;
        Object.assign(current, {
          status: 'failed', phase: 'failed', progress: 0,
          error: safeFailure(err), updatedAt: completedAt, completedAt,
          expiresAt: new Date(Date.now() + TERMINAL_RETENTION_MS).toISOString(),
        });
      });
      this.logError(`[export-jobs] job ${id} failed for worker ${failed?.workerId ?? queued.workerId}: ${err instanceof Error ? err.message : err}`);
      if (cleanupError) throw cleanupError;
    }
  }

  private artifactPath(id: string): string {
    return join(this.artifactsDir, `${id}.tar`);
  }

  private async removeArtifact(id: string): Promise<void> {
    await this.artifactRemover(this.artifactPath(id));
  }

  private async drainOwnerTasks(tasks: Promise<void>[]): Promise<void> {
    if (!tasks.length) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(tasks).then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(
              new Error('Export owner cleanup exceeded the deadline'),
              { statusCode: 503, code: 'EXPORT_OWNER_CLEANUP_TIMEOUT' },
            )),
            this.ownerCleanupTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async cleanupExpired(): Promise<void> {
    const cutoff = Date.now();
    for (const job of this.store.list()) {
      if (!job.expiresAt || Date.parse(job.expiresAt) > cutoff) continue;
      await this.withJob(job.id, async () => {
        const current = this.store.findById(job.id);
        if (!current?.expiresAt || Date.parse(current.expiresAt) > Date.now()) return;
        this.activeStreams.get(job.id)?.destroy();
        this.activeStreams.delete(job.id);
        await this.removeArtifact(job.id);
        await this.store.remove(current.userId, current.id);
      });
    }
  }

  private assertOwnerOpen(userId: string): void {
    if (this.closedOwners.has(userId))
      throw Object.assign(new Error('Export owner is no longer available'), { statusCode: 409 });
  }

  private withOwner<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    return this.withQueue(this.ownerQueues, userId, operation);
  }

  private withJob<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    return this.withQueue(this.jobQueues, jobId, operation);
  }

  private withQueue<T>(
    queues: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    queues.set(key, tail);
    void tail.finally(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return result;
  }

  private transition(
    id: string,
    operation: (job: ExportJobRecord) => void,
  ): Promise<ExportJobRecord | undefined> {
    return this.withJob(id, async () => {
      const current = this.store.findById(id);
      if (!current) return undefined;
      const next = structuredClone(current);
      operation(next);
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      await this.store.save(next);
      return next;
    });
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const controller of this.controllers.values()) controller.abort(new Error('Orchestrator stopping'));
    for (const stream of this.activeStreams.values()) stream.destroy(new Error('Orchestrator stopping'));
    this.controllers.clear();
    this.activeStreams.clear();
  }
}
