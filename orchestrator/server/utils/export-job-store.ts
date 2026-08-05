import { UserScopedJsonStore } from './user-scoped-store';

export type ExportJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ExportJobPhase = 'queued' | 'preparing' | 'manifest' | 'workspace' | 'agent-data' | 'root-filesystem' | 'writing-artifact' | 'complete' | 'failed' | 'cancelled';

export interface ExportJobRecord {
  id: string;
  userId: string;
  workerId: string;
  includeRootfs: boolean;
  status: ExportJobStatus;
  phase: ExportJobPhase;
  progress: number;
  bytesProcessed: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  filename?: string;
  error?: string;
  /** Names only of worker-local secrets intentionally omitted from export. */
  missingSecrets?: string[];
}

/** Durable, owner-partitioned metadata for worker export jobs. Artifacts are
 * deliberately stored separately and their server paths never enter records or
 * API responses. */
export class ExportJobStore extends UserScopedJsonStore<string, ExportJobRecord> {
  constructor(dataDir: string) {
    super(dataDir, 'export-jobs.json', (job) => job.id);
  }

  async save(job: ExportJobRecord): Promise<void> {
    await this.setItem(job.userId, job);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    return this.deleteItem(userId, id);
  }

  /** Roll back an item whose initial persistence failed. No second disk write
   * is attempted because that is the failure being recovered from. */
  discard(userId: string, id: string): void {
    const map = this.items.get(userId);
    map?.delete(id);
    if (map?.size === 0) this.items.delete(userId);
  }

  findById(id: string): ExportJobRecord | undefined {
    return this.findWithOwner((job) => job.id === id)?.item;
  }
}
