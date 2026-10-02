import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ExportJobStore, type ExportJobRecord } from './export-job-store';
import { useWorkerConfigStore } from './worker-config-store';
import { instanceControlPlaneCoordinator, instanceMutationBlocked } from './instance-snapshot-gate';
import { operationSettlement, type OperationFailureWithSettlement } from './operation-deadline';

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

// `finished()` may reject on error before an asynchronous _destroy callback
// closes the resource. These Node streams must actually close before their
// lifetime (and any artifact cleanup) can settle. An unconfirmed close holds
// the drain; neither cancellation nor an error is evidence of resource release.
function streamClosed(stream: Readable | Transform | ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise(resolve => {
    const closed = () => {
      if (!stream.closed) return;
      stream.off('close', closed);
      stream.off('error', failed);
      resolve();
    };
    const failed = () => { stream.destroy(); };
    stream.on('close', closed);
    stream.on('error', failed);
    closed();
  });
}

export class ExportJobManager {
  private readonly store: ExportJobStore;
  private readonly artifactsDir: string;
  private initPromise?: Promise<void>;
  private activeStreams = new Map<string, Readable>();
  private controllers = new Map<string, AbortController>();
  private runningJobs = new Set<string>();
  private activeTasks = new Map<string, Promise<void>>();
  private queuedLifetimes = new Map<string, ReturnType<typeof instanceControlPlaneCoordinator.fork>>();
  private accepting = true;
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
      includeManagedVolumes: boolean;
      signal?: AbortSignal;
      onProgress?: (update: { phase: string; progress: number; bytesProcessed: number }) => void | Promise<void>;
    }) => Promise<{ stream: Readable; filename: string; settlement?: Promise<void> }>,
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
    return instanceControlPlaneCoordinator.run(async () => {
      if (!this.initPromise) this.initPromise = this.initialize();
      return this.initPromise;
    });
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
    if (!this.accepting) return;
    this.cleanupTimer = setInterval(() => instanceControlPlaneCoordinator.withoutOperationContext(() => {
      if (!this.accepting) return;
      if (instanceMutationBlocked()) return;
      void this.cleanupExpired().catch((error) =>
        this.logError(`[export-jobs] cleanup failed: ${error instanceof Error ? error.message : error}`),
      );
    }), 15 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  async create(
    userId: string,
    workerId: string,
    includeRootfs = false,
    includeManagedVolumes = false,
  ): Promise<PublicExportJob> {
    return instanceControlPlaneCoordinator.run(() => this.createAdmitted(userId, workerId, includeRootfs, includeManagedVolumes));
  }

  private async createAdmitted(userId: string, workerId: string, includeRootfs: boolean, includeManagedVolumes: boolean): Promise<PublicExportJob> {
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
        id: randomUUID(), userId, workerId, includeRootfs, includeManagedVolumes,
        status: 'queued', phase: 'queued', progress: 0, bytesProcessed: 0,
        createdAt: stamp, updatedAt: stamp, missingSecrets,
      };
      await this.store.save(job);
      // stop()/owner removal may land during persistence. Do not strand a
      // never-dispatched lease or advertise an accepted job after shutdown.
      try { this.assertOwnerOpen(userId); }
      catch (error) {
        await this.transition(job.id, current => {
          const stamp = now();
          Object.assign(current, { status: 'cancelled', phase: 'cancelled',
            updatedAt: stamp, completedAt: stamp,
            expiresAt: new Date(Date.now() + TERMINAL_RETENTION_MS).toISOString() });
        });
        throw error;
      }
      // Register before dispatch can outlive the accepting HTTP/MCP request.
      this.queuedLifetimes.set(job.id, instanceControlPlaneCoordinator.fork());
      setImmediate(() => this.dispatch());
      return this.toPublic(job);
    });
  }

  async get(id: string): Promise<ExportJobRecord | undefined> {
    return instanceControlPlaneCoordinator.run(() => this.getAdmitted(id));
  }
  private async getAdmitted(id: string): Promise<ExportJobRecord | undefined> {
    await this.init();
    await this.cleanupExpired();
    return this.store.findById(id);
  }

  async cancel(job: ExportJobRecord): Promise<PublicExportJob> {
    return instanceControlPlaneCoordinator.run(() => this.cancelAdmitted(job));
  }
  private async cancelAdmitted(job: ExportJobRecord): Promise<PublicExportJob> {
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
      this.queuedLifetimes.get(job.id)?.cancel();
      this.queuedLifetimes.delete(job.id);
      this.dispatch();
      return this.toPublic(this.store.findById(job.id)!);
    });
  }

  async openArtifact(job: ExportJobRecord): Promise<{ stream: Readable; size: number; filename: string }> {
    return instanceControlPlaneCoordinator.run(() => this.openArtifactAdmitted(job));
  }
  private async openArtifactAdmitted(job: ExportJobRecord): Promise<{ stream: Readable; size: number; filename: string }> {
    await this.init();
    if (job.status !== 'succeeded') throw new Error('Export artifact is not ready');
    const path = this.artifactPath(job.id);
    const info = await stat(path);
    const lifetime = instanceControlPlaneCoordinator.fork();
    let stream: ReturnType<typeof createReadStream>;
    try { stream = createReadStream(path); }
    catch (error) { lifetime.cancel(); throw error; }
    void lifetime.run(() => streamClosed(stream)).catch(() => {});
    return {
      stream,
      size: info.size,
      filename: job.filename || 'worker-export.tar',
    };
  }

  listUserIds(): string[] {
    return this.store.listUserIds();
  }

  hasActiveOperationsForInstanceSnapshot(): boolean {
    return (
      this.runningJobs.size > 0 ||
      this.activeTasks.size > 0 ||
      this.queuedLifetimes.size > 0 ||
      this.controllers.size > 0
    );
  }

  async removeForUser(userId: string): Promise<number> {
    return instanceControlPlaneCoordinator.run(() => this.removeForUserAdmitted(userId));
  }
  private async removeForUserAdmitted(userId: string): Promise<number> {
    this.closedOwners.add(userId);
    await this.init();
    return this.withOwner(userId, async () => {
      const jobs = this.store.listForUser(userId);
      for (const job of jobs) {
        this.queuedLifetimes.get(job.id)?.cancel();
        this.queuedLifetimes.delete(job.id);
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
    if (!this.accepting || this.runningJobs.size >= MAX_RUNNING_JOBS) return;
    const runningWorkers = new Set(
      [...this.runningJobs]
        .map((id) => this.store.findById(id)?.workerId)
        .filter((workerId): workerId is string => Boolean(workerId)),
    );
    const next = this.store.list().find((candidate) =>
      candidate.status === 'queued' && !this.closedOwners.has(candidate.userId) &&
      !runningWorkers.has(candidate.workerId));
    if (!next) return;
    const lifetime = this.queuedLifetimes.get(next.id);
    // Loaded queued jobs are terminalized during initialization. Never invent
    // fresh admission for an unknown/unregistered job during a cut.
    if (!lifetime) return;
    this.queuedLifetimes.delete(next.id);
    this.runningJobs.add(next.id);
    const task = lifetime.run(() => this.run(next.id)).catch((err) => {
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
    let producerSettlement: Promise<void> | undefined;
    let producerFailure: Error | undefined;
    const streams: Array<{ stream: Readable | Transform | ReturnType<typeof createWriteStream>; closed: Promise<void> }> = [];
    const track = <T extends Readable | Transform | ReturnType<typeof createWriteStream>>(stream: T): T => {
      streams.push({ stream, closed: streamClosed(stream) });
      return stream;
    };
    const settleStreams = async () => {
      for (const { stream } of streams) stream.destroy();
      await Promise.all(streams.map(({ closed }) => closed));
      await producerSettlement;
    };
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
        includeManagedVolumes: job.includeManagedVolumes,
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
      // Production exporters expose hidden producer/temp cleanup settlement.
      // Legacy injected callbacks without it must own all work in the stream.
      // Settlement is evidence that work stopped, not evidence of success.
      // Observe failure once, then keep finally/cleanup outcome-neutral so a
      // rejected producer cannot skip artifact deletion or retire a running job.
      producerSettlement = result.settlement?.catch(error => {
        producerFailure = error instanceof Error ? error : new Error('Export producer cleanup failed');
      });
      track(result.stream);
      this.activeStreams.set(job.id, result.stream);
      if (controller.signal.aborted || this.closedOwners.has(job.userId) || this.store.findById(id)?.status === 'cancelled') {
        await settleStreams();
        if (producerFailure) throw producerFailure;
        return;
      }

      await this.transition(id, (current) => {
        if (current.status !== 'running') return;
        current.phase = 'writing-artifact';
        current.progress = 90;
        current.filename = result.filename;
        current.updatedAt = now();
      });

      let artifactBytes = 0;
      let bytesProcessed = this.store.findById(id)?.bytesProcessed ?? 0;
      let bytesAtLastPersist = bytesProcessed;
      const counter = track(new Transform({
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
      }));
      const output = track(createWriteStream(this.artifactPath(job.id), { mode: 0o600 }));
      await pipeline(result.stream, counter, output);
      await settleStreams();
      if (producerFailure) throw producerFailure;
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
      // The runner owns the actual exported work, not the accepting response.
      // Its caught timeout must not retire the lease before late writes settle.
      await Promise.resolve((err as OperationFailureWithSettlement)?.[operationSettlement]).catch(() => {});
      await settleStreams();
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
    } finally {
      await settleStreams();
      this.activeStreams.delete(id);
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
    return instanceControlPlaneCoordinator.run(() => this.cleanupExpiredAdmitted());
  }
  private async cleanupExpiredAdmitted(): Promise<void> {
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
    if (!this.accepting) throw Object.assign(new Error('Export manager is stopping'), { statusCode: 503 });
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
    return instanceControlPlaneCoordinator.run(() => this.withAdmittedQueue(queues, key, operation));
  }
  private withAdmittedQueue<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
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
    this.accepting = false;
    for (const lifetime of this.queuedLifetimes.values()) lifetime.cancel();
    this.queuedLifetimes.clear();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const controller of this.controllers.values()) controller.abort(new Error('Orchestrator stopping'));
    for (const stream of this.activeStreams.values()) stream.destroy(new Error('Orchestrator stopping'));
    // Active tasks retain their controllers/streams and drain ownership until
    // the actual runner and destruction callbacks have settled.
  }
}
