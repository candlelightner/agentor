import { mkdir, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type {
  InstanceBackupArtifact,
  InstanceBackupJob,
  InstanceBackupState,
  RemoteInstanceBackupRecord,
} from "./instance-backup-types";

const MAX_STORE_BYTES = 32 * 1024 * 1024;

export class InstanceBackupStore {
  private readonly path: string;
  private state: InstanceBackupState = emptyState();
  private initialized?: Promise<void>;
  private writes = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "admin", "instance-backups.v1.json");
  }

  init() {
    return (this.initialized ??= this.load());
  }

  /** Reload terminal state written by the out-of-process restore helper when
   * it fails before stopping this orchestrator. No manager write is active
   * while the restore task is waiting for that helper. */
  async reload(): Promise<void> {
    await this.writes;
    await this.load();
  }

  listJobs(): InstanceBackupJob[] {
    return structuredClone(this.state.jobs);
  }

  getJob(id: string): InstanceBackupJob | undefined {
    const value = this.state.jobs.find((job) => job.id === id);
    return value ? structuredClone(value) : undefined;
  }

  listArtifacts(): InstanceBackupArtifact[] {
    return structuredClone(this.state.artifacts);
  }

  getArtifact(id: string): InstanceBackupArtifact | undefined {
    const value = this.state.artifacts.find((artifact) => artifact.id === id);
    return value ? structuredClone(value) : undefined;
  }

  listRemote(): RemoteInstanceBackupRecord[] {
    return structuredClone(this.state.remoteBackups);
  }

  getRemote(id: string): RemoteInstanceBackupRecord | undefined {
    const value = this.state.remoteBackups.find((record) => record.id === id);
    return value ? structuredClone(value) : undefined;
  }

  async saveJob(job: InstanceBackupJob): Promise<void> {
    if (!validJob(job)) throw new Error("Invalid instance backup job state");
    await this.commit((state) => {
      const index = state.jobs.findIndex((item) => item.id === job.id);
      if (index >= 0) state.jobs[index] = structuredClone(job);
      else state.jobs.push(structuredClone(job));
      state.jobs = state.jobs.slice(-500);
    });
  }

  async saveArtifact(artifact: InstanceBackupArtifact): Promise<void> {
    if (!validArtifact(artifact))
      throw new Error("Invalid instance backup artifact state");
    await this.commit((state) => {
      const index = state.artifacts.findIndex((item) => item.id === artifact.id);
      if (index >= 0) state.artifacts[index] = structuredClone(artifact);
      else state.artifacts.push(structuredClone(artifact));
    });
  }

  async removeArtifact(id: string): Promise<void> {
    await this.commit((state) => {
      state.artifacts = state.artifacts.filter((item) => item.id !== id);
      for (const remote of state.remoteBackups)
        if (remote.adoptedArtifactId === id) {
          delete remote.adoptedArtifactId;
          remote.state = "ready-to-adopt";
        }
    });
  }

  async upsertRemote(
    record: RemoteInstanceBackupRecord,
  ): Promise<RemoteInstanceBackupRecord> {
    if (!validRemote(record))
      throw new Error("Invalid remote instance backup state");
    let result = structuredClone(record);
    await this.commit((state) => {
      const index = state.remoteBackups.findIndex(
        (item) =>
          item.userId === record.userId &&
          item.provider === record.provider &&
          item.providerObjectId === record.providerObjectId,
      );
      if (index >= 0) {
        const existing = state.remoteBackups[index]!;
        result = {
          ...structuredClone(record),
          id: existing.id,
          discoveredAt: existing.discoveredAt,
          ...(existing.adoptedArtifactId
            ? {
                adoptedArtifactId: existing.adoptedArtifactId,
                state: "adopted" as const,
              }
            : {}),
        };
        state.remoteBackups[index] = result;
      } else state.remoteBackups.push(result);
    });
    return structuredClone(result);
  }

  private async load(): Promise<void> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_STORE_BYTES)
        throw new Error("Invalid instance backup store");
      const parsed = JSON.parse(await file.readFile("utf8"));
      if (!validState(parsed)) throw new Error("Invalid instance backup store");
      this.state = parsed;
    } catch (error: any) {
      if (error?.code !== "ENOENT")
        throw new Error("Instance backup state is unavailable");
    } finally {
      await file?.close().catch(() => {});
    }
  }

  private async commit(change: (state: InstanceBackupState) => void) {
    const write = async () => {
      const next = structuredClone(this.state);
      change(next);
      if (!validState(next)) throw new Error("Invalid instance backup state");
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        await file.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, this.path);
        this.state = next;
      } finally {
        await file?.close().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
      }
    };
    const pending = this.writes.then(write, write);
    this.writes = pending.catch(() => {});
    await pending;
  }
}

function emptyState(): InstanceBackupState {
  return { schemaVersion: 1, jobs: [], artifacts: [], remoteBackups: [] };
}

function validState(value: any): value is InstanceBackupState {
  return (
    value?.schemaVersion === 1 &&
    Array.isArray(value.jobs) &&
    value.jobs.length <= 500 &&
    value.jobs.every(validJob) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.length <= 10_000 &&
    value.artifacts.every(validArtifact) &&
    Array.isArray(value.remoteBackups) &&
    value.remoteBackups.length <= 10_000 &&
    value.remoteBackups.every(validRemote) &&
    unique(value.jobs.map((item: any) => item.id)) &&
    unique(value.artifacts.map((item: any) => item.id)) &&
    unique(
      value.remoteBackups.map(
        (item: any) => `${item.userId}\0${item.provider}\0${item.providerObjectId}`,
      ),
    )
  );
}

function validJob(value: any): value is InstanceBackupJob {
  return (
    value?.schemaVersion === 1 &&
    id(value.id) &&
    id(value.userId) &&
    ["create", "discovery", "adoption", "verify", "restore"].includes(
      value.operation,
    ) &&
    provider(value.provider) &&
    ["queued", "running", "succeeded", "failed", "cancelled"].includes(
      value.status,
    ) &&
    text(value.phase, 100) &&
    number(value.progress, 0, 100) &&
    Number.isSafeInteger(value.bytesProcessed) &&
    value.bytesProcessed >= 0 &&
    iso(value.createdAt) &&
    iso(value.updatedAt) &&
    optionalIso(value.startedAt) &&
    optionalIso(value.completedAt) &&
    optionalText(value.requestId, 200) &&
    optionalText(value.requestFingerprint, 128) &&
    optionalText(value.artifactId, 200) &&
    optionalText(value.remoteBackupId, 200) &&
    optionalText(value.error, 2048) &&
    optionalText(value.errorCode, 100) &&
    (value.retryable === undefined || typeof value.retryable === "boolean") &&
    Array.isArray(value.logs) &&
    value.logs.length <= 1000 &&
    value.logs.every((item: unknown) => text(item, 2048)) &&
    optionalText(value.pendingProviderObjectId, 4096) &&
    optionalText(value.pendingProviderUploadId, 8192)
  );
}

function validArtifact(value: any): value is InstanceBackupArtifact {
  return (
    value?.schemaVersion === 1 &&
    id(value.id) &&
    id(value.userId) &&
    provider(value.provider) &&
    text(value.providerObjectId, 4096) &&
    iso(value.createdAt) &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    /^sha256:[a-f0-9]{64}$/.test(value.keyFingerprint) &&
    text(value.sourceInstallationId, 200) &&
    value.formatVersion === 1 &&
    ["verified", "failed", "unavailable"].includes(value.integrityStatus) &&
    ["local", "remote-adopted"].includes(value.provenance) &&
    (value.manifest === undefined || validManifestShape(value.manifest))
  );
}

function validRemote(value: any): value is RemoteInstanceBackupRecord {
  return (
    value?.schemaVersion === 1 &&
    id(value.id) &&
    id(value.userId) &&
    provider(value.provider) &&
    text(value.providerObjectId, 4096) &&
    iso(value.discoveredAt) &&
    iso(value.lastSeenAt) &&
    value.remote?.artifactKind === "instance" &&
    value.remote.objectId === value.providerObjectId &&
    Number.isSafeInteger(value.remote.size) &&
    value.remote.size >= 0 &&
    [
      "discovered",
      "missing-key",
      "unsupported-format",
      "too-large",
      "incomplete",
      "inaccessible",
      "damaged",
      "ready-to-adopt",
      "adopted",
    ].includes(value.state) &&
    optionalText(value.keyFingerprint, 80) &&
    optionalText(value.sourceInstallationId, 200) &&
    (value.formatVersion === undefined ||
      (Number.isInteger(value.formatVersion) && value.formatVersion >= 1)) &&
    optionalText(value.blockedReason, 2048) &&
    optionalText(value.adoptedArtifactId, 200)
  );
}

function validManifestShape(value: any) {
  return (
    value?.kind === "agentor-instance-backup" &&
    value.formatVersion === 1 &&
    id(value.backupId) &&
    text(value.sourceInstallationId, 200) &&
    id(value.createdByUserId) &&
    iso(value.createdAt) &&
    Array.isArray(value.volumes) &&
    value.volumes.length <= 100_000
  );
}

function provider(value: unknown) {
  return ["local", "fake", "google-drive"].includes(String(value));
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= max;
}
function optionalText(value: unknown, max: number) {
  return value === undefined || text(value, max);
}
function iso(value: unknown): value is string {
  return text(value, 64) && Number.isFinite(Date.parse(value));
}
function optionalIso(value: unknown) {
  return value === undefined || iso(value);
}
function number(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function unique(values: string[]) {
  return new Set(values).size === values.length;
}
