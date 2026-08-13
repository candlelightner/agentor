import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupArtifact, BackupConfig, BackupJob } from './backup-types';
import { assertSafeUserId, isSafeUserId } from './user-id';

interface UserBackupData { schemaVersion: 1; config?: BackupConfig; jobs: BackupJob[]; artifacts: BackupArtifact[] }
export class BackupStore {
  private data = new Map<string, UserBackupData>(); private queues = new Map<string, Promise<void>>(); private initialized?: Promise<void>;
  constructor(private dataDir: string) {}
  init() { return this.initialized ??= this.load(); }
  get(userId: string) { return this.data.get(userId) ?? { schemaVersion: 1 as const, jobs: [], artifacts: [] }; }
  all() { return [...this.data.values()]; }
  userIds() { return [...this.data.keys()]; }
  forget(userId: string) { this.data.delete(userId); }
  findJob(id: string) { for (const value of this.data.values()) { const job = value.jobs.find((x) => x.id === id); if (job) return job; } }
  findArtifact(id: string) { for (const value of this.data.values()) { const artifact = value.artifacts.find((x) => x.id === id); if (artifact) return artifact; } }
  async save(userId: string, value: UserBackupData) { assertSafeUserId(userId); this.data.set(userId, value); await this.persist(userId); }
  private async load() { let users: string[] = []; try { users = await readdir(join(this.dataDir, 'users')); } catch { return; }
    for (const userId of users.filter(isSafeUserId)) try { const value = normalizeStoredUserBackupData(userId, JSON.parse(await readFile(join(this.dataDir, 'users', userId, 'backups.json'), 'utf8'))); if (value) this.data.set(userId, value); } catch {} }
  private persist(userId: string) { assertSafeUserId(userId); const previous = this.queues.get(userId) ?? Promise.resolve(); const next = previous.then(async () => { const dir = join(this.dataDir, 'users', userId); await mkdir(dir, { recursive: true, mode: 0o700 }); const target = join(dir, 'backups.json'); const tmp = `${target}.tmp.${process.pid}`; await writeFile(tmp, JSON.stringify(this.get(userId), null, 2), { mode: 0o600 }); await rename(tmp, target); }); this.queues.set(userId, next.catch(() => {})); return next; }
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
        validOptionalPathIdArray(job.workspaceIds))
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
