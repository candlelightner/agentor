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

export class ExportJobManager {
  private readonly store: ExportJobStore;
  private readonly artifactsDir: string;
  private initPromise?: Promise<void>;
  private activeStreams = new Map<string, Readable>();
  private controllers = new Map<string, AbortController>();
  private runningJobs = new Set<string>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    dataDir: string,
    private readonly exportWorker: (workerId: string, opts: {
      includeRootfs: boolean;
      signal?: AbortSignal;
      onProgress?: (update: { phase: string; progress: number; bytesProcessed: number }) => void | Promise<void>;
    }) => Promise<{ stream: Readable; filename: string }>,
    private readonly logError: (message: string) => void,
  ) {
    this.store = new ExportJobStore(dataDir);
    this.artifactsDir = join(dataDir, 'export-artifacts');
  }

  async init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true, mode: 0o700 });
    await this.store.init();

    const knownArtifactIds = new Set(this.store.list().map((job) => `${job.id}.tar`));
    for (const name of await readdir(this.artifactsDir).catch(() => [] as string[])) {
      if (name.endsWith('.tar') && !knownArtifactIds.has(name)) {
        await rm(join(this.artifactsDir, name), { force: true }).catch(() => {});
      }
    }

    // A hard kill cannot run ContainerManager's stream cleanup handlers. Sweep
    // only its uniquely-prefixed export scratch directories on startup.
    const tmpDir = join(this.artifactsDir, '..', 'tmp');
    for (const name of await readdir(tmpDir).catch(() => [] as string[])) {
      if (name.startsWith('export-')) await rm(join(tmpDir, name), { recursive: true, force: true }).catch(() => {});
    }

    // Work cannot safely resume inside ContainerManager after a process restart.
    // Preserve the record but fail it explicitly and remove any partial artifact.
    for (const job of this.store.list()) {
      if (job.status === 'queued' || job.status === 'running') {
        const stamp = now();
        job.status = 'failed';
        job.phase = 'failed';
        job.error = 'Export was interrupted by an orchestrator restart. Start a new export.';
        job.updatedAt = stamp;
        job.completedAt = stamp;
        job.expiresAt = new Date(Date.now() + TERMINAL_RETENTION_MS).toISOString();
        await this.removeArtifact(job.id);
        await this.store.save(job);
      }
    }
    await this.cleanupExpired();
    this.cleanupTimer = setInterval(() => void this.cleanupExpired(), 15 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  async create(userId: string, workerId: string, includeRootfs = false): Promise<PublicExportJob> {
    await this.init();
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
    const stamp = now();
    const job: ExportJobRecord = {
      id: randomUUID(),
      userId,
      workerId,
      includeRootfs,
      status: 'queued',
      phase: 'queued',
      progress: 0,
      bytesProcessed: 0,
      createdAt: stamp,
      updatedAt: stamp,
      missingSecrets: (await useWorkerConfigStore().resolveValues(userId, workerId))
        .filter((entry) => entry.kind !== 'variable').map((entry) => entry.key),
    };
    try {
      await this.store.save(job);
    } catch (err) {
      this.store.discard(userId, job.id);
      throw err;
    }

    // Do not await materialisation: the create endpoint returns after the small
    // metadata write, while the expensive Docker archive work runs in-process.
    setImmediate(() => this.dispatch());
    return this.toPublic(job);
  }

  async get(id: string): Promise<ExportJobRecord | undefined> {
    await this.init();
    await this.cleanupExpired();
    return this.store.findById(id);
  }

  async cancel(job: ExportJobRecord): Promise<PublicExportJob> {
    await this.init();
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return this.toPublic(job);
    }
    const stamp = now();
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.updatedAt = stamp;
    job.completedAt = stamp;
    job.expiresAt = new Date(Date.now() + TERMINAL_RETENTION_MS).toISOString();
    this.controllers.get(job.id)?.abort(new Error('Export cancelled'));
    this.activeStreams.get(job.id)?.destroy(new Error('Export cancelled'));
    await this.removeArtifact(job.id);
    await this.store.save(job);
    this.dispatch();
    return this.toPublic(job);
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
    await this.init();
    const jobs = this.store.listForUser(userId);
    for (const job of jobs) {
      this.controllers.get(job.id)?.abort(new Error('Export owner removed'));
      this.activeStreams.get(job.id)?.destroy(new Error('Export owner removed'));
      await this.removeArtifact(job.id);
    }
    return this.store.removeForUser(userId);
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
      candidate.status === 'queued' && !runningWorkers.has(candidate.workerId));
    if (!next) return;
    this.runningJobs.add(next.id);
    void this.run(next.id).catch((err) => {
      this.logError(`[export-jobs] unexpected runner failure for job ${next.id}: ${err instanceof Error ? err.message : err}`);
    }).finally(() => {
      this.runningJobs.delete(next.id);
      this.controllers.delete(next.id);
      this.dispatch();
    });
    if (this.runningJobs.size < MAX_RUNNING_JOBS) this.dispatch();
  }

  private async run(id: string): Promise<void> {
    const job = this.store.findById(id);
    if (!job || job.status !== 'queued') return;
    // Register cancellation before the first await or published running state;
    // DELETE can now abort every preparation phase without a race window.
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const startedAt = now();
      job.status = 'running';
      job.phase = 'preparing';
      job.startedAt = startedAt;
      job.updatedAt = startedAt;
      job.progress = 1;
      await this.store.save(job);
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
          if (this.store.findById(id)?.status === 'cancelled') return;
          job.phase = update.phase as ExportJobRecord['phase'];
          job.progress = update.progress;
          job.bytesProcessed = update.bytesProcessed;
          job.updatedAt = now();
          await this.store.save(job);
        },
      });
      if (this.store.findById(id)?.status === 'cancelled') {
        result.stream.destroy();
        return;
      }

      job.phase = 'writing-artifact';
      job.progress = 90;
      job.filename = result.filename;
      job.updatedAt = now();
      await this.store.save(job);

      this.activeStreams.set(job.id, result.stream);
      let artifactBytes = 0;
      let bytesAtLastPersist = job.bytesProcessed;
      const counter = new Transform({
        transform: (chunk, _encoding, callback) => {
          const length = Buffer.byteLength(chunk);
          artifactBytes += length;
          job.bytesProcessed += length;
          if (artifactBytes > MAX_ARTIFACT_BYTES) {
            callback(new Error('Export artifact exceeds the size limit'));
            return;
          }
          if (job.bytesProcessed - bytesAtLastPersist >= 64 * 1024 * 1024) {
            bytesAtLastPersist = job.bytesProcessed;
            job.updatedAt = now();
            this.store.save(job).then(() => callback(null, chunk), callback);
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
      job.status = 'succeeded';
      job.phase = 'complete';
      job.progress = 100;
      job.updatedAt = completedAt;
      job.completedAt = completedAt;
      job.expiresAt = new Date(Date.now() + SUCCESS_RETENTION_MS).toISOString();
      await this.store.save(job);
    } catch (err) {
      this.activeStreams.delete(job.id);
      await this.removeArtifact(job.id);
      if (this.store.findById(id)?.status === 'cancelled') return;
      const completedAt = now();
      job.status = 'failed';
      job.phase = 'failed';
      job.progress = 0;
      job.error = safeFailure(err);
      job.updatedAt = completedAt;
      job.completedAt = completedAt;
      job.expiresAt = new Date(Date.now() + TERMINAL_RETENTION_MS).toISOString();
      await this.store.save(job);
      this.logError(`[export-jobs] job ${job.id} failed for worker ${job.workerId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private artifactPath(id: string): string {
    return join(this.artifactsDir, `${id}.tar`);
  }

  private async removeArtifact(id: string): Promise<void> {
    await rm(this.artifactPath(id), { force: true }).catch(() => {});
  }

  private async cleanupExpired(): Promise<void> {
    const cutoff = Date.now();
    for (const job of this.store.list()) {
      if (!job.expiresAt || Date.parse(job.expiresAt) > cutoff) continue;
      this.activeStreams.get(job.id)?.destroy();
      this.activeStreams.delete(job.id);
      await this.removeArtifact(job.id);
      await this.store.remove(job.userId, job.id);
    }
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
