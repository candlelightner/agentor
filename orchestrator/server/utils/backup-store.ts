import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupArtifact, BackupConfig, BackupJob } from './backup-types';
import { assertSafeUserId, isSafeUserId } from './user-id';

interface UserBackupData { schemaVersion: 1; config?: BackupConfig; jobs: BackupJob[]; artifacts: BackupArtifact[] }
export class BackupStore {
  private data = new Map<string, UserBackupData>();
  private queues = new Map<string, Promise<void>>();
  private revisions = new Map<string, number>();
  private unavailableUsers = new Set<string>();
  private closedUsers = new Set<string>();
  private initialized?: Promise<void>;
  constructor(private dataDir: string) {}
  init() { return this.initialized ??= this.load(); }
  get(userId: string) { this.assertAvailable(userId); return structuredClone(this.data.get(userId) ?? emptyUserBackupData()); }
  all() { return [...this.data.values()].map((value) => structuredClone(value)); }
  userIds() { return [...new Set([...this.data.keys(), ...this.unavailableUsers])]; }
  async forget(userId: string) {
    assertSafeUserId(userId);
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await rm(join(this.dataDir, 'users', userId, 'backups.json'), { force: true });
      this.data.delete(userId);
      this.unavailableUsers.delete(userId);
      this.closedUsers.add(userId);
      this.revisions.delete(userId);
    });
    this.queues.set(userId, next.then(() => undefined, () => undefined));
    await next;
  }
  findJob(id: string) { for (const value of this.data.values()) { const job = value.jobs.find((x) => x.id === id); if (job) return structuredClone(job); } }
  findArtifact(id: string) { for (const value of this.data.values()) { const artifact = value.artifacts.find((x) => x.id === id); if (artifact) return structuredClone(artifact); } }
  async save(userId: string, value: UserBackupData) {
    assertSafeUserId(userId);
    const snapshot = structuredClone(value);
    await this.enqueue(userId, async (revision) => {
      await this.persistSnapshot(userId, revision, snapshot);
      this.data.set(userId, structuredClone(snapshot));
    });
  }
  async update<T>(
    userId: string,
    mutate: (draft: UserBackupData) => T,
  ): Promise<T> {
    assertSafeUserId(userId);
    return this.enqueue(userId, async (revision) => {
      const draft = structuredClone(this.data.get(userId) ?? emptyUserBackupData());
      const result = mutate(draft);
      await this.persistSnapshot(userId, revision, draft);
      this.data.set(userId, draft);
      return result;
    });
  }
  private async load() {
    let users: string[] = [];
    try {
      users = await readdir(join(this.dataDir, 'users'));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const userId of users.filter(isSafeUserId)) {
      const path = join(this.dataDir, 'users', userId, 'backups.json');
      try {
        const value = normalizeStoredUserBackupData(userId, JSON.parse(await readFile(path, 'utf8')));
        if (!value) throw new Error('Unsupported or invalid backup store state');
        this.data.set(userId, value);
        this.unavailableUsers.delete(userId);
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue;
        this.unavailableUsers.add(userId);
        useLogger().error(`[backup-store] quarantined unreadable ${path}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  private enqueue<T>(userId: string, operation: (revision: number) => Promise<T>): Promise<T> {
    const revision = (this.revisions.get(userId) ?? 0) + 1;
    this.revisions.set(userId, revision);
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => {
      this.assertAvailable(userId);
      if (this.closedUsers.has(userId))
        throw Object.assign(new Error('Backup owner state is closed'), { statusCode: 410 });
      return operation(revision);
    });
    this.queues.set(userId, next.then(() => undefined, () => undefined));
    return next;
  }
  private async persistSnapshot(userId: string, revision: number, snapshot: UserBackupData) { assertSafeUserId(userId); const dir = join(this.dataDir, 'users', userId); await mkdir(dir, { recursive: true, mode: 0o700 }); const target = join(dir, 'backups.json'); const tmp = `${target}.tmp.${process.pid}.${revision}`; await writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); await rename(tmp, target); }
  private assertAvailable(userId: string) {
    if (!this.unavailableUsers.has(userId)) return;
    throw Object.assign(new Error('Stored backup data is unavailable for this owner'), { statusCode: 503 });
  }
}

function emptyUserBackupData(): UserBackupData {
  return { schemaVersion: 1, jobs: [], artifacts: [] };
}

/** Read old v1 files without rewriting them, but never trust an embedded owner
 * or a path-relevant local/fake identifier that disagrees with its directory
 * partition. Individual bad records are quarantined so one corrupt job cannot
 * hide otherwise recoverable configuration and artifacts. */
function normalizeStoredUserBackupData(userId: string, value: any): UserBackupData | undefined {
  if (!value || value.schemaVersion !== 1) return;
  const config = validStoredConfig(userId, value.config) ? value.config as BackupConfig : undefined;
  const jobs = Array.isArray(value.jobs)
    ? value.jobs.filter((job: any): job is BackupJob =>
        validOwnedRecord(userId, job) && validProvider(job.provider) &&
        validPathId(job.workspaceId) && validOptionalPathIds(job, ['artifactId', 'backupId', 'workerId']) &&
        (job.pendingProviderObjectId === undefined || validProviderObjectId(job.provider, job.pendingProviderObjectId)) &&
        (job.pendingProviderArtifactId === undefined || validPathId(job.pendingProviderArtifactId)) &&
        (job.pendingProviderUploadId === undefined || validOpaqueProviderId(job.pendingProviderUploadId)) &&
        validOptionalPathIdArray(job.workspaceIds) && validOptionalPathIdArray(job.artifactWorkspaceIds) &&
        validOptionalPathIdArray(job.selectedWorkspaceIds))
    : [];
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.filter((artifact: any): artifact is BackupArtifact =>
        validOwnedRecord(userId, artifact) &&
        validProvider(artifact.provider) && validPathId(artifact.workspaceId) &&
        validOptionalPathIds(artifact, ['sourceWorkerId']) && validOptionalPathIdArray(artifact.workspaceIds) &&
        validPathId(artifact.id) &&
        validProviderObjectId(artifact.provider, artifact.providerObjectId))
    : [];
  return { schemaVersion: 1, ...(config ? { config } : {}), jobs, artifacts };
}

function validOwnedRecord(userId: string, value: any): boolean {
  return value && value.schemaVersion === 1 && value.userId === userId &&
    (value.ownerId === undefined || value.ownerId === userId) && validPathId(value.id);
}

function validOptionalPathIds(value: any, fields: string[]): boolean {
  return fields.every((field) => value[field] === undefined || validPathId(value[field]));
}

function validOptionalPathIdArray(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.every(validPathId));
}

function validStoredConfig(userId: string, value: any): boolean {
  return value && value.schemaVersion === 1 && value.userId === userId &&
    validProvider(value.provider) && validOptionalPathIdArray(value.selectedWorkspaceIds);
}

function validProvider(value: unknown): value is BackupArtifact['provider'] {
  return value === 'local' || value === 'fake' || value === 'google-drive';
}

function validPathId(value: unknown): value is string {
  return isSafeUserId(value);
}

function validProviderObjectId(provider: unknown, value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) return false;
  // Local and deterministic fake providers interpolate this value into a
  // filename. Google Drive ids are opaque and are URL-encoded before use.
  return provider === 'google-drive' || validPathId(value);
}

function validOpaqueProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);
}
