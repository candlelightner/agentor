import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupArtifact, BackupConfig, BackupJob, RemoteBackupRecord } from './backup-types';
import { assertSafeUserId, isSafeUserId } from './user-id';

interface UserBackupData { schemaVersion: 1; config?: BackupConfig; jobs: BackupJob[]; artifacts: BackupArtifact[]; remoteBackups: RemoteBackupRecord[] }
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
  /** Atomic owner-scoped discovery upsert. The provider object id, not remote
   * labels or claimed source ownership, is the deduplication authority. */
  async upsertRemoteBackup(userId: string, record: RemoteBackupRecord): Promise<RemoteBackupRecord> {
    assertSafeUserId(userId);
    if (!validRemoteRecord(userId, record)) throw Object.assign(new Error('Invalid remote backup record'), { statusCode: 400 });
    return this.update(userId, (draft) => {
      const index = draft.remoteBackups.findIndex((item) => item.provider === record.provider && item.providerObjectId === record.providerObjectId);
      if (index >= 0) {
        const existing = draft.remoteBackups[index]!;
        // Adoption is local state and must never be cleared by another scan.
        const next: RemoteBackupRecord = { ...structuredClone(record), id: existing.id, discoveredAt: existing.discoveredAt, ...(existing.adoptedArtifactId ? { adoptedArtifactId: existing.adoptedArtifactId } : {}) };
        draft.remoteBackups[index] = next;
        return structuredClone(next);
      }
      draft.remoteBackups.push(structuredClone(record));
      return structuredClone(record);
    });
  }
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
  return { schemaVersion: 1, jobs: [], artifacts: [], remoteBackups: [] };
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
        validOptionalPathIdArray(job.selectedWorkspaceIds) && validJobAdditions(job))
    : [];
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.filter((artifact: any): artifact is BackupArtifact =>
        validOwnedRecord(userId, artifact) &&
        validProvider(artifact.provider) && validPathId(artifact.workspaceId) &&
        validOptionalPathIds(artifact, ['sourceWorkerId']) && validOptionalPathIdArray(artifact.workspaceIds) &&
        validPathId(artifact.id) &&
        validProviderObjectId(artifact.provider, artifact.providerObjectId) &&
        validArtifactAdditions(artifact))
    : [];
  const remoteBackups = Array.isArray(value.remoteBackups)
    ? value.remoteBackups.filter((record: any): record is RemoteBackupRecord => validRemoteRecord(userId, record))
    : [];
  // A malformed duplicate must not make the account undiscoverable. Retain the
  // first durable record; future scans atomically refresh it.
  const seenRemote = new Set<string>();
  return { schemaVersion: 1, ...(config ? { config } : {}), jobs, artifacts,
    remoteBackups: remoteBackups.filter((record: RemoteBackupRecord) => {
      const key = `${record.provider}\0${record.providerObjectId}`;
      if (seenRemote.has(key)) return false; seenRemote.add(key); return true;
    }) };
}

function validOwnedRecord(userId: string, value: any): boolean {
  return value && value.schemaVersion === 1 && value.userId === userId &&
    (value.ownerId === undefined || value.ownerId === userId) && validPathId(value.id);
}

function validRemoteRecord(userId: string, value: any): value is RemoteBackupRecord {
  if (!validOwnedRecord(userId, value) || !validProvider(value.provider) || !validProviderObjectId(value.provider, value.providerObjectId)) return false;
  if (!validIso(value.discoveredAt) || !validIso(value.lastSeenAt) || !validRemoteDescriptor(value.remote) || value.remote.objectId !== value.providerObjectId) return false;
  if (value.adoptedArtifactId !== undefined && !validPathId(value.adoptedArtifactId)) return false;
  if (value.state !== undefined && !['discovered','missing-key','unsupported-format','too-large','incomplete','inaccessible','damaged','ready-to-adopt','adopted'].includes(value.state)) return false;
  if (value.integrityStatus !== undefined && !['unverified','verified','failed'].includes(value.integrityStatus)) return false;
  if (value.blockedReason !== undefined && !validBoundedText(value.blockedReason, 1024)) return false;
  if (value.sourceInstallationId !== undefined && !validBoundedText(value.sourceInstallationId, 200)) return false;
  if (value.keyFingerprint !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.keyFingerprint)) return false;
  if (value.formatVersion !== undefined && (!Number.isInteger(value.formatVersion) || value.formatVersion < 1 || value.formatVersion > 100)) return false;
  if (!validOptionalPathIdArray(value.workspaceIds) || !validWorkspaceMembers(value.workspaceMembers)) return false;
  return value.lastErrorAt === undefined || validIso(value.lastErrorAt);
}
function validIso(value: unknown): value is string { return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)); }
function validRemoteDescriptor(value: any): boolean {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    validOpaqueProviderId(value.objectId) && Number.isSafeInteger(value.size) && value.size >= 0 &&
    (value.createdAt === undefined || validIso(value.createdAt)) &&
    (value.artifactId === undefined || validPathId(value.artifactId)) &&
    (value.formatVersion === undefined || (Number.isInteger(value.formatVersion) && value.formatVersion >= 1 && value.formatVersion <= 100)) &&
    (value.keyFingerprint === undefined || (typeof value.keyFingerprint === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.keyFingerprint))) &&
    (value.integritySha256 === undefined || (typeof value.integritySha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.integritySha256))) &&
    (value.incomplete === undefined || typeof value.incomplete === 'boolean');
}
function validJobAdditions(value: any): boolean {
  if (value.operation !== undefined && !['backup', 'restore', 'discovery', 'adoption', 'dependency-resolution'].includes(value.operation)) return false;
  if (value.requestId !== undefined && !validOpaqueProviderId(value.requestId)) return false;
  if (value.requestFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(value.requestFingerprint)) return false;
  if (value.remoteBackupId !== undefined && !validPathId(value.remoteBackupId)) return false;
  if (value.recoveredImageDefinitionId !== undefined && !validPathId(value.recoveredImageDefinitionId)) return false;
  if (value.recoveredImageBuildId !== undefined && !validPathId(value.recoveredImageBuildId)) return false;
  if (value.recoverImageStartBuild !== undefined && typeof value.recoverImageStartBuild !== 'boolean') return false;
  if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.length > 1024 || value.dependencies.some((item: any) => !item || typeof item !== 'object' || !['image','plugin','secret','template'].includes(item.kind) || !validBoundedText(item.id, 4096) || !['resolved', 'missing', 'replacement-required', 'warning'].includes(item.status) || (item.workspaceId !== undefined && !validPathId(item.workspaceId)) || (item.required !== undefined && typeof item.required !== 'boolean') || (item.reason !== undefined && !validBoundedText(item.reason, 1024))))) return false;
  if (!validImageResolutions(value.imageResolutions)) return false;
  if (value.logs !== undefined && (!Array.isArray(value.logs) || value.logs.length > 1000 || value.logs.some((line: unknown) => typeof line !== 'string' || line.length > 2048 || /[\0\r]/.test(line)))) return false;
  return value.restoreMappings === undefined || (Array.isArray(value.restoreMappings) && value.restoreMappings.length <= 256 && value.restoreMappings.every((item: any) => item && typeof item === 'object' && validPathId(item.sourceWorkspaceId) && validPathId(item.workerId)));
}
function validBoundedText(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\0\r\n]/.test(value); }

function validWorkspaceMembers(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 256 && value.every((item: any) => item && typeof item === 'object' && validPathId(item.id) && (item.displayName === undefined || validBoundedText(item.displayName, 100))));
}
function validImageResolutions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, any>);
  if (entries.length > 256) return false;
  return entries.every(([workspaceId, resolution]) => {
    if (!validPathId(workspaceId) || !resolution || typeof resolution !== 'object' || Array.isArray(resolution)) return false;
    if (resolution.mode === 'exact') return true;
    if (resolution.mode === 'workspace-only') return resolution.acknowledged === true;
    return resolution.mode === 'replacement' && validPathId(resolution.imageDefinitionId) && validBoundedText(resolution.imageVersion, 100);
  });
}
function validArtifactAdditions(value: any): boolean {
  if (value.formatVersion !== undefined && (!Number.isInteger(value.formatVersion) || value.formatVersion < 1 || value.formatVersion > 100)) return false;
  if (value.keyFingerprint !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.keyFingerprint)) return false;
  if (value.sourceInstallationId !== undefined && !validBoundedText(value.sourceInstallationId, 200)) return false;
  if (value.integrityStatus !== undefined && !['verified','failed','unavailable'].includes(value.integrityStatus)) return false;
  if (value.provenance !== undefined && !['local','remote-adopted'].includes(value.provenance)) return false;
  if (!validWorkspaceMembers(value.workspaceMembers)) return false;
  if (value.dependencies !== undefined && !validJobAdditions({ dependencies: value.dependencies })) return false;
  if (value.reconstruction === undefined) return true;
  return Array.isArray(value.reconstruction) && value.reconstruction.length <= 256 && value.reconstruction.every((item: any) =>
    item && typeof item === 'object' && validPathId(item.workspaceId) && (item.displayName === undefined || validBoundedText(item.displayName, 100)) &&
    item.image && typeof item.image === 'object' && ['legacy','platform-default','unmanaged','custom'].includes(item.image.kind) &&
    (item.image.definitionId === undefined || validPathId(item.image.definitionId)) && (item.image.version === undefined || validBoundedText(item.image.version, 100)) &&
    (item.image.digest === undefined || /^sha256:[a-f0-9]{64}$/.test(item.image.digest)) &&
    (item.image.runtimeImageAvailable === undefined || typeof item.image.runtimeImageAvailable === 'boolean') &&
    (item.image.recoveryAvailable === undefined || typeof item.image.recoveryAvailable === 'boolean') &&
    (item.image.catalogSource === undefined || (item.image.catalogSource && item.image.catalogSource.kind === 'git' && /^[0-9a-f-]{36}$/i.test(item.image.catalogSource.connectionId) && validBoundedText(item.image.catalogSource.remoteId, 100) && /^[0-9a-f]{64}$/.test(item.image.catalogSource.hash))) &&
    Array.isArray(item.pluginDefinitions) && item.pluginDefinitions.length <= 256 && item.pluginDefinitions.every((plugin: any) => plugin && validBoundedText(plugin.sourceId, 200) && validBoundedText(plugin.name, 200) && validBoundedText(plugin.version, 100)) &&
    Number.isInteger(item.desiredPluginCount) && item.desiredPluginCount >= 0 && item.desiredPluginCount <= 1024 &&
    Array.isArray(item.requiredSecretNames) && item.requiredSecretNames.length <= 1024 && item.requiredSecretNames.every((name: unknown) => validBoundedText(name, 255)));
}

function validOptionalPathIds(value: any, fields: string[]): boolean {
  return fields.every((field) => value[field] === undefined || validPathId(value[field]));
}

function validOptionalPathIdArray(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.every(validPathId));
}

function validStoredConfig(userId: string, value: any): boolean {
  return value && value.schemaVersion === 1 && value.userId === userId &&
    validProvider(value.provider) && validOptionalPathIdArray(value.selectedWorkspaceIds) && validPathSelections(value.selectedPathsByWorkspace);
}

function validPathSelections(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([id, paths]) =>
    validPathId(id) && Array.isArray(paths) && paths.length <= 32 && paths.every((path) =>
      typeof path === 'string' && path.length > 0 && path.length <= 4096 && path.startsWith('/') && !path.includes('\0') && !path.includes('\\'),
    ),
  );
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
