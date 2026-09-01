import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { BackupStore } from "./backup-store";
import {
  LocalBackupProvider,
  FakeBackupProvider,
  GoogleDriveBackupProvider,
  MAX_BACKUP_PROVIDER_OBJECT_BYTES,
  exchangeGoogleAuthorizationCode,
  publicBackupFailure,
  type BackupProvider,
  type GoogleDriveToken,
} from "./backup-provider";
import {
  decryptBackup,
  decryptBackupV1WithMaterial,
  decryptBackupV2,
  encryptedBackupPayloadSha256,
  encryptBackupV2,
  inspectBackupV2,
} from "./backup-crypto";
import { BackupKeyring } from "./backup-keyring";
import type {
  BackupArtifact,
  BackupConfig,
  BackupDependency,
  BackupImageResolution,
  BackupJob,
  BackupProviderKind,
  BackupWorkspaceReconstructionSummary,
  RemoteBackupRecord,
} from "./backup-types";
import {
  useConfig,
  useContainerManager,
  useLogger,
  usePluginDefinitionStore,
  usePluginInstallationStore,
  useWorkerStore,
} from "./services";
import { useWorkerConfigStore } from "./worker-config-store";
import {
  decryptWorkerValue,
  encryptWorkerValue,
  type EncryptedWorkerValue,
} from "./worker-config-crypto";
import {
  inspectWorkspaceBackups,
  packWorkspaceBackups,
  unpackWorkspaceBackups,
} from "./backup-bundle";
import { extraBackupPaths, normalizeBackupPaths } from "./backup-paths";
import {
  extractBundle,
  readWorkerReconstruction,
} from "./worker-export";
import { replaceStoppedWorkspace } from "./backup-restore-helper";
import { useWorkerProtectionLockStore } from "./worker-protection-lock";
import { useGoogleBackupOAuthConfigStore } from "./google-backup-oauth-config";
import { useImageCatalogManager } from "./image-catalog";
import Docker from "dockerode";
import {
  useDockerService,
  useDomainMappingStore,
  useEnvironmentStore,
  usePortMappingStore,
  useStorageManager,
} from "./services";
import {
  BUNDLE_FILES,
  CREDENTIAL_EXCLUDE_SUFFIXES,
  EXPORT_AGENTS_PATH,
  EXPORT_WORKSPACE_PATH,
  SHARED_DATA_EXCLUDE_PREFIXES,
  WORKER_EXPORT_VERSION,
  packBundle,
  sanitizeBackupPathTarPayload,
  writeFilteredAgentsGz,
  writeGzipFile,
  writeManifest,
  writeWorkerReconstruction,
  type WorkerExportManifest,
} from "./worker-export";
import { assertSafeUserId } from "./user-id";
import {
  snapshotWorkerPlugins,
  writePortablePluginConfiguration,
} from "./plugin-portability";
import { snapshotWorkerReconstruction } from "./worker-reconstruction";
import { resolveWorkerReconstruction } from "./worker-reconstruction";
import { readPortablePluginConfiguration } from "./plugin-portability";
import { backupInstallationId } from "./backup-installation";
import { pluginDefinitionHash } from "./plugin-manifest";

interface RestoreExecution {
  controller: AbortController;
  completed: Promise<void>;
  finish: () => void;
  jobId?: string;
}

interface RestoreArtifactPin {
  artifact: BackupArtifact;
}

interface BackupQueueEntry {
  jobId: string;
  ownerId: string;
  task: () => Promise<void>;
  cancel?: (error: Error) => void;
}

export class BackupManager {
  private readonly dataDir: string;
  private store: BackupStore;
  private keyring: BackupKeyring;
  private initialized?: Promise<void>;
  private scheduleTimer?: NodeJS.Timeout;
  private active = 0;
  private pending: BackupQueueEntry[] = [];
  private readonly maxConcurrent = 2;
  private accepting = true;
  private controllers = new Map<string, AbortController>();
  private cancelledJobs = new Set<string>();
  private activeTasks = new Map<string, Set<Promise<void>>>();
  private restoreExecutions = new Map<string, Set<RestoreExecution>>();
  private restorePins = new Map<string, number>();
  private restoreJobPins = new Map<string, RestoreArtifactPin>();
  private retryClaims = new Set<string>();
  private artifactDeletions = new Set<string>();
  private forgottenUsers = new Set<string>();
  private readonly restoreCleanupTimeoutMs: number;
  private readonly providerCleanupTimeoutMs: number;
  private readonly prepareRestoreDirectory: (path: string) => Promise<void>;
  private tickInFlight?: Promise<void>;
  private fake: FakeBackupProvider;
  private fakeUsers = new Set<string>();
  private providers: Map<BackupProviderKind, BackupProvider>;
  private pathPersistence?: {
    reconcileSelections(
      userId: string,
      selected: Record<string, string[]> | undefined,
    ): Promise<void>;
  };
  /** Dependency injection keeps restart recovery testable against the same
   * persisted files and provider boundary used by the production manager. */
  constructor(
    options: {
      dataDir?: string;
      providers?: Partial<Record<BackupProviderKind, BackupProvider>>;
      restoreCleanupTimeoutMs?: number;
      providerCleanupTimeoutMs?: number;
      prepareRestoreDirectory?: (path: string) => Promise<void>;
    } = {},
  ) {
    this.dataDir = options.dataDir ?? useConfig().dataDir;
    this.restoreCleanupTimeoutMs = Math.max(
      1,
      options.restoreCleanupTimeoutMs ?? 30_000,
    );
    this.providerCleanupTimeoutMs = Math.max(
      1,
      options.providerCleanupTimeoutMs ?? 10_000,
    );
    this.prepareRestoreDirectory =
      options.prepareRestoreDirectory ??
      (async (path) => {
        await mkdir(path, { recursive: true, mode: 0o700 });
      });
    this.store = new BackupStore(this.dataDir);
    this.keyring = new BackupKeyring(
      { ...useConfig(), dataDir: this.dataDir },
      join(this.dataDir, "backup-keyring.json"),
    );
    this.fake = new FakeBackupProvider(join(this.dataDir, "backup-fake"));
    this.providers = new Map<BackupProviderKind, BackupProvider>([
      ["local", new LocalBackupProvider(join(this.dataDir, "backup-objects"))],
      ["fake", this.fake],
      [
        "google-drive",
        new GoogleDriveBackupProvider(
          (userId) => this.loadGoogleToken(userId),
          (userId, token) => this.saveGoogleToken(userId, token),
          async () => {
            const credentials =
              await useGoogleBackupOAuthConfigStore().credentials();
            return (
              credentials && {
                clientId: credentials.clientId,
                clientSecret: credentials.clientSecret,
              }
            );
          },
        ),
      ],
    ]);
    for (const [kind, provider] of Object.entries(options.providers ?? {}))
      if (provider) this.providers.set(kind as BackupProviderKind, provider);
  }

  setPathPersistenceAdapter(adapter: {
    reconcileSelections(
      userId: string,
      selected: Record<string, string[]> | undefined,
    ): Promise<void>;
  }) {
    this.pathPersistence = adapter;
  }
  init() {
    return (this.initialized ??= this.initialize());
  }
  private assertOwnerAvailable(userId: string): void {
    if (!this.forgottenUsers.has(userId)) return;
    throw Object.assign(new Error("Backup owner is no longer available"), {
      statusCode: 409,
      code: "BACKUP_OWNER_UNAVAILABLE",
    });
  }
  private async initialize() {
    await this.store.init();
    await mkdir(join(this.dataDir, "tmp"), { recursive: true });
    for (const user of this.store.all())
      for (const job of user.jobs)
        if (job.status === "queued" || job.status === "running") {
          // The process that owned an interrupted provider transfer is gone.
          // Remove deterministic per-job scratch before publishing failure so
          // a hard restart cannot strand large encrypted/decrypted archives.
          const operation =
            job.operation ?? (job.target ? "restore" : "backup");
          const resumable =
            operation === "backup"
              ? await readInterruptedBackupResume(this.dataDir, job.id)
              : undefined;
          if (resumable) {
            await rm(join(this.dataDir, "tmp", `restore-${job.id}`), {
              recursive: true,
              force: true,
            });
            // resume.json owns these identifiers until the retry starts. A
            // terminal cleanup sweep must not delete the resumable transfer.
            job.pendingProviderObjectId = undefined;
            job.pendingProviderArtifactId = undefined;
          } else {
            await cleanupInterruptedBackupStaging(this.dataDir, job.id);
          }
          job.status = "failed";
          job.phase = "failed";
          job.error =
            operation === "restore"
              ? "Restore interrupted by orchestrator restart"
              : operation === "discovery"
                ? "Provider discovery was interrupted by orchestrator restart. Retry is available."
                : operation === "adoption"
                  ? "Backup adoption was interrupted by orchestrator restart. The discovered record was retained and retry is available."
                  : resumable
                    ? "Backup interrupted by orchestrator restart. Retry is available."
                    : "Backup interrupted by orchestrator restart";
          job.retryable = operation !== "restore" || job.target !== "original";
          job.completedAt = job.updatedAt = new Date().toISOString();
          await this.store.update(job.userId, (data) => {
            const index = data.jobs.findIndex(
              (candidate) => candidate.id === job.id,
            );
            if (index >= 0) data.jobs[index] = structuredClone(job);
          });
        }
    await this.retryPendingProviderDeletes();
    this.scheduleTimer = setInterval(() => this.triggerScheduleTick(), 60_000);
    this.scheduleTimer.unref?.();
    setImmediate(() => this.triggerScheduleTick());
  }
  async getConfig(userId: string) {
    await this.init();
    return this.store.get(userId).config;
  }
  ownerIds() {
    return this.store.userIds();
  }
  async forgetUser(userId: string) {
    await this.init();
    this.forgottenUsers.add(userId);
    const activeJobIds = this.store
      .get(userId)
      .jobs.filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => job.id);
    for (const jobId of activeJobIds) this.cancelledJobs.add(jobId);
    let transitionError: unknown;
    try {
      await this.store.update(userId, (data) => {
        const now = new Date().toISOString();
        for (const job of data.jobs) {
          if (!activeJobIds.includes(job.id)) continue;
          job.status = "cancelled";
          job.phase = "cancelled";
          job.completedAt = job.updatedAt = now;
        }
      });
    } catch (error) {
      transitionError = error;
    }
    for (const jobId of activeJobIds) this.controllers.get(jobId)?.abort();
    this.cancelPending(
      (candidate) => candidate.ownerId === userId,
      Object.assign(new Error("Restore cancelled"), { name: "AbortError" }),
    );
    const executions = [...(this.restoreExecutions.get(userId) ?? [])];
    const activeTasks = [...(this.activeTasks.get(userId) ?? [])];
    for (const execution of executions) execution.controller.abort();
    // Account/orphan cleanup must not race an import or in-place commit. Every
    // built-in provider download observes the controller, and later restore
    // phases check it between each mutation before this barrier resolves.
    await this.drainRestoreExecutions(executions);
    await this.drainActiveBackupTasks(activeTasks);
    if (transitionError) throw transitionError;
    for (const [pinOwner, pin] of this.restoreJobPins)
      if (pin.artifact.userId === userId)
        this.releaseRestoreArtifactPin(pinOwner);
    const data = this.store.get(userId);
    const residualRestoreWorkers = [
      ...new Set(
        data.jobs
          .filter(
            (job) => job.target === "new" && job.phase === "rollback-failed",
          )
          .flatMap(
            (job) => job.workerIds ?? (job.workerId ? [job.workerId] : []),
          )
          .filter(
            (workerId) =>
              useContainerManager().get(workerId)?.userId === userId,
          ),
      ),
    ];
    const survivingRestoreWorkers = await rollbackRestoredWorkers(
      residualRestoreWorkers,
    );
    if (survivingRestoreWorkers.length)
      throw restoreRollbackFailure(survivingRestoreWorkers);
    const cleanupFailures: string[] = [];
    for (const job of data.jobs) {
      if (job.pendingProviderUploadId)
        await this.abortPendingProviderUpload(job).catch((error) => {
          cleanupFailures.push(
            `upload ${job.id}: ${error instanceof Error ? error.message : error}`,
          );
        });
      if (job.pendingProviderObjectId)
        await this.deletePendingProviderObject(
          job,
          job.pendingProviderObjectId,
        ).catch((error) => {
          cleanupFailures.push(
            `object ${job.id}: ${error instanceof Error ? error.message : error}`,
          );
        });
    }
    for (const artifact of data.artifacts)
      await this.runProviderCleanup("owner backup artifact deletion", (signal) =>
        this.providers
          .get(artifact.provider)!
          .delete(userId, artifact.providerObjectId, signal),
      ).catch((error) => {
        cleanupFailures.push(
          `artifact ${artifact.id}: ${error instanceof Error ? error.message : error}`,
        );
      });
    if (cleanupFailures.length)
      throw Object.assign(
        new Error(
          `Backup owner cleanup is incomplete: ${cleanupFailures.join("; ")}`,
        ),
        { code: "BACKUP_OWNER_CLEANUP_INCOMPLETE" },
      );
    await this.store.forget(userId);
  }
  async setConfig(
    userId: string,
    input: Partial<
      Pick<
        BackupConfig,
        | "provider"
        | "enabled"
        | "intervalMinutes"
        | "retentionCount"
        | "selectedWorkspaceIds"
        | "selectedPathsByWorkspace"
      >
    >,
  ) {
    await this.init();
    this.assertOwnerAvailable(userId);
    const normalizedPaths =
      input.selectedPathsByWorkspace === undefined
        ? undefined
        : normalizeSelectedPaths(input.selectedPathsByWorkspace);
    // Seed every newly selected directory before committing configuration.
    // A failed copy therefore leaves both the old container and the previous
    // backup settings authoritative, and no rebuild can attach an empty volume.
    if (input.selectedPathsByWorkspace !== undefined && this.pathPersistence)
      await this.pathPersistence.reconcileSelections(userId, normalizedPaths);
    const now = new Date().toISOString();
    const config = await this.store.update(userId, (data) => {
      const old = data.config;
      data.config = {
        schemaVersion: 1,
        userId,
        provider: input.provider ?? old?.provider ?? "local",
        enabled: input.enabled ?? old?.enabled ?? false,
        intervalMinutes: clamp(
          input.intervalMinutes ?? configIntervalMinutes(old),
          1,
          525_600,
        ),
        retentionCount: clamp(
          input.retentionCount ?? old?.retentionCount ?? 7,
          1,
          100,
        ),
        selectedWorkspaceIds:
          input.selectedWorkspaceIds === undefined
            ? (old?.selectedWorkspaceIds ?? null)
            : input.selectedWorkspaceIds,
        selectedPathsByWorkspace:
          input.selectedPathsByWorkspace === undefined
            ? old?.selectedPathsByWorkspace
            : normalizedPaths,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        nextRunAt:
          (input.enabled ?? old?.enabled ?? false)
            ? input.intervalMinutes !== undefined ||
              input.enabled === true ||
              !old?.nextRunAt
              ? new Date(
                  Date.now() +
                    clamp(
                      input.intervalMinutes ?? configIntervalMinutes(old),
                      1,
                      525_600,
                    ) *
                      60_000,
                ).toISOString()
              : old.nextRunAt
            : null,
        google: old?.google,
        lastAttemptAt: old?.lastAttemptAt,
        lastSuccessAt: old?.lastSuccessAt,
        lastError: old?.lastError,
        consecutiveFailures: old?.consecutiveFailures ?? 0,
      };
      return structuredClone(data.config);
    });
    return sanitizeConfig(config);
  }
  async create(userId: string, workspaceId: string) {
    return this.createMany(userId, [workspaceId]);
  }
  async createMany(
    userId: string,
    workspaceIds: string[],
    providerOverride?: BackupProviderKind,
    attempt = 1,
    resumed = 0,
    selectedPathsByWorkspace?: Record<string, string[]>,
    requestId?: string,
  ): Promise<BackupJob> {
    await this.init();
    this.assertOwnerAvailable(userId);
    const unique = [...new Set(workspaceIds)];
    if (!unique.length) throw new Error("At least one workspace is required");
    for (const id of unique) {
      const w = useContainerManager().get(id) ?? useWorkerStore().findById(id);
      if (!w || w.userId !== userId) throw new Error("Workspace not found");
    }
    const paths = normalizeSelectedPaths(selectedPathsByWorkspace);
    for (const id of Object.keys(paths ?? {}))
      if (!unique.includes(id))
        throw Object.assign(new Error("Backup paths reference an unselected workspace"), { statusCode: 400 });
    const provider =
      providerOverride ?? this.store.get(userId).config?.provider ?? "local";
    if (provider === "fake" && !this.fakeUsers.has(userId))
      throw new Error("Fake provider is not connected");
    const states = unique.map(
      (id) =>
        useContainerManager().get(id)?.status ??
        (useWorkerStore().findById(id)?.status === "archived"
          ? "archived"
          : "stopped"),
    );
    const state = states.includes("running")
      ? "running"
      : states.every((candidate) => candidate === "stopped")
        ? "stopped"
        : states.every((candidate) => candidate === "archived")
          ? "archived"
          : "mixed-offline";
    const consistency = {
      workerState: state,
      strategy: state === "running" ? "best-effort" : "offline-read-only",
      warning:
        state === "running"
          ? "Files may change while the running worker is backed up."
          : "Offline workspaces are read through a hardened read-only snapshot helper.",
    };
    const now = new Date().toISOString();
    const normalizedRequestId = normalizeBackupRequestId(requestId);
    const fingerprint = normalizedRequestId
      ? requestFingerprint({
          operation: "backup",
          provider,
          workspaceIds: [...unique].sort(),
          selectedPathsByWorkspace: paths
            ? Object.fromEntries(
                Object.entries(paths)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([workspaceId, selectedPaths]) => [
                    workspaceId,
                    [...selectedPaths].sort(),
                  ]),
              )
            : undefined,
        })
      : undefined;
    const job: BackupJob = {
      schemaVersion: 1,
      id: randomUUID(),
      userId,
      ownerId: userId,
      workspaceId: unique[0]!,
      workspaceIds: unique,
      provider,
      status: "queued",
      phase: "queued",
      progress: 0,
      bytesProcessed: 0,
      createdAt: now,
      updatedAt: now,
      attempt,
      resumedFromChunk: resumed,
      operation: "backup",
      ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
      ...(fingerprint ? { requestFingerprint: fingerprint } : {}),
      consistency,
      ...(paths ? { selectedPathsByWorkspace: paths } : {}),
    };
    if (normalizedRequestId) {
      const claimed = await this.claimStartJob(job);
      if (!claimed.created) return sanitizeJob(claimed.job);
    } else {
      await this.store.update(userId, (data) => {
        data.jobs.push(structuredClone(job));
      });
    }
    this.enqueue(job.id, job.userId, () => this.runV2(job));
    return sanitizeJob(job);
  }
  async getJob(id: string) {
    await this.init();
    const job = this.store.findJob(id);
    return job ? sanitizeJob(job) : undefined;
  }
  async getJobLogs(id: string, after = 0, limit = 100) {
    await this.init();
    const job = this.store.findJob(id);
    if (!job) return undefined;
    const start = Number.isSafeInteger(after) ? Math.max(0, after) : 0;
    const count = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(200, limit))
      : 100;
    const all = job.logs ?? [];
    const end = Math.min(all.length, start + count);
    return {
      jobId: job.id,
      after: start,
      next: end,
      hasMore: end < all.length,
      logs: all.slice(start, end),
    };
  }
  async getArtifact(id: string) {
    await this.init();
    return this.store.findArtifact(id);
  }
  connectFake(userId: string, chunkSize?: number, accountId?: string) {
    this.assertOwnerAvailable(userId);
    this.fakeUsers.add(userId);
    if (accountId) this.fake.bindAccount(userId, accountId);
    return this.fake.connect(userId, chunkSize);
  }
  setFakeFault(userId: string, chunk: number, count: number) {
    this.assertOwnerAvailable(userId);
    this.fake.setFault(userId, chunk, count);
  }
  fakeDiagnostic(userId: string, id: string) {
    // Public jobs intentionally omit opaque provider upload/cleanup handles.
    // Let the test-only diagnostic surface resolve the stable, owner-scoped job
    // id instead, while retaining direct upload-id lookup for older callers.
    const job = this.store.findJob(id);
    if (
      job?.userId === userId &&
      job.provider === "fake" &&
      job.providerUploadId
    )
      return this.fake.diagnostic(userId, job.providerUploadId);
    return this.fake.diagnostic(userId, id);
  }
  providersStatus(userId: string) {
    const providers = [
      {
        id: "fake",
        type: "fake",
        connected: this.fakeUsers.has(userId),
        testMode: true,
      },
      { id: "local", type: "local", connected: true },
      {
        id: "google",
        type: "google-drive",
        connected: !!this.store.get(userId).config?.google?.token,
        tokenEncrypted: !!this.store.get(userId).config?.google?.token,
      },
    ];
    return process.env.NODE_ENV === "production" &&
      process.env.ALLOW_FAKE_BACKUP_PROVIDER !== "true"
      ? providers.filter((provider) => provider.type !== "fake")
      : providers;
  }
  async disconnectGoogle(userId: string) {
    await this.init();
    this.assertOwnerAvailable(userId);
    await this.store.update(userId, (data) => {
      if (!data.config) return;
      data.config.google = undefined;
      if (data.config.provider === "google-drive")
        data.config.provider = "local";
      data.config.updatedAt = new Date().toISOString();
    });
  }
  async retry(job: BackupJob) {
    await this.init();
    this.assertOwnerAvailable(job.userId);
    const current = this.store.findJob(job.id);
    if (!current || current.userId !== job.userId)
      throw new Error("Backup job not found");
    job = current;
    if (job.status !== "failed")
      throw new Error("Only failed jobs can be retried");
    if (this.retryClaims.has(job.id))
      throw new Error("A retry is already being queued for this job");
    this.retryClaims.add(job.id);
    let restoreArtifact: BackupArtifact | undefined;
    let remoteBackup: RemoteBackupRecord | undefined;
    let restorePinOwner: string | undefined;
    try {
      const operation = job.operation ?? (job.target ? "restore" : "backup");
      if (operation === "restore") {
        if (job.target === "original")
          throw new Error(
            "Original-worker restores cannot be retried; submit a new restore with the worker lock password",
          );
        restoreArtifact = job.artifactId
          ? await this.getArtifact(job.artifactId)
          : undefined;
        if (!restoreArtifact || restoreArtifact.userId !== job.userId)
          throw new Error("The restore artifact is no longer available");
        const retryWorkspaceIds = this.selectRestoreWorkspaceIds(
          this.artifactWorkspaceIds(restoreArtifact),
          job.selectedWorkspaceIds ?? job.workspaceIds,
        );
        job.dependencies = await this.preflightRestoreDependencies(
          job.userId,
          restoreArtifact,
          retryWorkspaceIds,
          job.imageResolutions,
        );
        restorePinOwner = this.restorePinOwner(job.id, job.attempt + 1);
        this.pinRestoreArtifact(restorePinOwner, restoreArtifact);
      } else if (operation === "adoption") {
        remoteBackup = job.remoteBackupId
          ? this.findRemoteBackup(job.userId, job.remoteBackupId)
          : undefined;
        if (!remoteBackup)
          throw new Error("The discovered remote backup is no longer available");
      } else if (operation === "discovery") {
        if (!this.providers.get(job.provider)?.discover)
          throw new Error("This backup provider no longer supports discovery");
      } else if (operation === "dependency-resolution") {
        restoreArtifact = job.artifactId ? await this.getArtifact(job.artifactId) : undefined;
        if (!restoreArtifact || restoreArtifact.userId !== job.userId)
          throw new Error("The recovery artifact is no longer available");
        const workspaceId = job.selectedWorkspaceIds?.[0];
        if (!workspaceId || !this.artifactWorkspaceIds(restoreArtifact).includes(workspaceId))
          throw new Error("The selected recovery workspace is no longer available");
        restorePinOwner = this.restorePinOwner(job.id, job.attempt + 1);
        this.pinRestoreArtifact(restorePinOwner, restoreArtifact);
      }
      this.cancelledJobs.delete(job.id);
      job.attempt += 1;
      job.status = "queued";
      job.phase = "retrying";
      job.error = undefined;
      job.errorCode = undefined;
      job.providerStatus = undefined;
      job.retryable = undefined;
      job.workerId = undefined;
      job.workerIds = undefined;
      job.missingSecrets = undefined;
      job.integrityVerified = undefined;
      job.completedAt = undefined;
      job.updatedAt = new Date().toISOString();
      appendBackupJobLog(job, `Retry ${job.attempt} queued.`);
      await this.saveJob(job);
      if (operation === "restore") {
        this.enqueue(job.id, job.userId, () =>
          this.runRestoreV2(
            job,
            restoreArtifact!,
            job.displayName,
            restorePinOwner!,
          ),
        );
      } else if (operation === "discovery")
        this.enqueue(job.id, job.userId, () => this.runDiscovery(job));
      else if (operation === "adoption")
        this.enqueue(job.id, job.userId, () =>
          this.runAdoption(job, remoteBackup!),
        );
      else if (operation === "dependency-resolution")
        this.enqueue(job.id, job.userId, () =>
          this.runImageRecovery(job, restoreArtifact!, job.recoverImageStartBuild !== false, restorePinOwner!),
        );
      else this.enqueue(job.id, job.userId, () => this.runV2(job));
      return sanitizeJob(job);
    } catch (error) {
      if (restorePinOwner) this.releaseRestoreArtifactPin(restorePinOwner);
      throw error;
    } finally {
      this.retryClaims.delete(job.id);
    }
  }
  async cancel(job: BackupJob) {
    await this.init();
    this.assertOwnerAvailable(job.userId);
    const current = this.store.findJob(job.id);
    if (!current || current.userId !== job.userId)
      throw new Error("Backup job not found");
    job = current;
    if (job.status === "queued" || job.status === "running") {
      const queued = job.status === "queued";
      if (job.target === "original" && !queued)
        throw Object.assign(
          new Error("An in-place restore cannot be cancelled safely"),
          { statusCode: 409 },
        );
      job.status = "cancelled";
      this.cancelledJobs.add(job.id);
      job.phase = "cancelled";
      job.completedAt = job.updatedAt = new Date().toISOString();
      try {
        await this.saveJob(job);
      } finally {
        // Persistence failure must not leave a cancelled in-memory job with
        // executable queued work or a source-artifact pin. The API still
        // reports the write failure, while runtime cancellation completes and
        // restart recovery fails any stale queued/running durable record.
        if (queued)
          this.cancelPending(
            (candidate) => candidate.jobId === job.id,
            Object.assign(new Error("Backup job cancelled"), {
              name: "AbortError",
            }),
          );
        if (queued && (job.target || job.operation === "dependency-resolution"))
          this.releaseRestoreArtifactPin(
            this.restorePinOwner(job.id, job.attempt),
          );
        this.controllers.get(job.id)?.abort();
      }
    }
    return sanitizeJob(job);
  }
  stop() {
    this.accepting = false;
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = undefined;
    this.cancelPending(
      () => true,
      new Error("Backup manager is shutting down"),
    );
  }
  async list(userId: string) {
    await this.init();
    const d = this.store.get(userId);
    return {
      config: d.config ? sanitizeConfig(d.config) : undefined,
      jobs: d.jobs.map(sanitizeJob),
      artifacts: d.artifacts,
      remoteBackups: await Promise.all(
        d.remoteBackups.map((record) => this.publicRemoteBackup(record)),
      ),
    };
  }

  async recoveryKeyStatus(userId: string) {
    await this.init();
    this.assertOwnerAvailable(userId);
    const keys = await this.keyring.status(userId);
    const active = keys.find((key) => key.active);
    return {
      activeFingerprint: active?.fingerprint ?? (await this.keyring.active(userId)).fingerprint,
      keys: await this.keyring.status(userId),
    };
  }

  async importRecoveryKit(userId: string, material: unknown) {
    await this.init();
    this.assertOwnerAvailable(userId);
    const imported = await this.keyring.importKit(userId, material);
    return {
      imported: true,
      fingerprint: imported.fingerprint,
      active: imported.active,
      matchingRemoteBackupIds: this.store
        .get(userId)
        .remoteBackups.filter(
          (record) =>
            (record.keyFingerprint ?? record.remote.keyFingerprint) ===
            imported.fingerprint,
        )
        .map(({ id }) => id),
    };
  }

  async exportRecoveryKit(userId: string, fingerprint?: string) {
    await this.init();
    this.assertOwnerAvailable(userId);
    return this.keyring.exportKit(userId, fingerprint);
  }

  async listRemoteBackups(userId: string) {
    await this.init();
    this.assertOwnerAvailable(userId);
    return Promise.all(
      this.store
        .get(userId)
        .remoteBackups.map((record) => this.publicRemoteBackup(record)),
    );
  }

  async getRemoteBackup(id: string) {
    await this.init();
    for (const userId of this.store.userIds()) {
      const record = this.store
        .get(userId)
        .remoteBackups.find((candidate) => candidate.id === id);
      if (record) return this.publicRemoteBackup(record);
    }
  }

  async createDiscovery(
    userId: string,
    providerOverride?: BackupProviderKind,
    requestId?: string,
  ): Promise<BackupJob> {
    await this.init();
    this.assertOwnerAvailable(userId);
    const provider =
      providerOverride ?? this.store.get(userId).config?.provider ?? "local";
    const implementation = this.providers.get(provider);
    if (!implementation?.discover)
      throw Object.assign(
        new Error("This backup provider does not support remote discovery"),
        { statusCode: 501 },
      );
    if (provider === "fake" && !this.fakeUsers.has(userId))
      throw Object.assign(new Error("Fake provider is not connected"), {
        statusCode: 409,
      });
    const normalizedRequestId = normalizeBackupRequestId(requestId);
    const fingerprint = requestFingerprint({ operation: "discovery", provider });
    const now = new Date().toISOString();
    const candidate: BackupJob = {
      schemaVersion: 1,
      id: randomUUID(),
      userId,
      ownerId: userId,
      workspaceId: userId,
      provider,
      status: "queued",
      phase: "queued",
      progress: 0,
      bytesProcessed: 0,
      createdAt: now,
      updatedAt: now,
      attempt: 1,
      operation: "discovery",
      requestFingerprint: fingerprint,
      ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
      logs: ["Remote provider scan queued."],
    };
    const claimed = await this.claimStartJob(candidate);
    if (!claimed.created) return sanitizeJob(claimed.job);
    this.enqueue(candidate.id, userId, () => this.runDiscovery(candidate));
    return sanitizeJob(candidate);
  }

  async createAdoption(
    userId: string,
    remoteBackupId: string,
    requestId?: string,
  ): Promise<BackupJob> {
    await this.init();
    this.assertOwnerAvailable(userId);
    const remote = this.findRemoteBackup(userId, remoteBackupId);
    if (!remote)
      throw Object.assign(new Error("Remote backup not found"), {
        statusCode: 404,
      });
    if (remote.remote.incomplete || remote.state === "incomplete")
      throw Object.assign(
        new Error("The provider upload is incomplete and cannot be adopted"),
        { statusCode: 409, code: "BACKUP_UPLOAD_INCOMPLETE" },
      );
    if (
      remote.remote.size > MAX_BACKUP_PROVIDER_OBJECT_BYTES ||
      remote.state === "too-large"
    )
      throw Object.assign(
        new Error(
          "The provider backup object exceeds Agentor's staging size limit and cannot be adopted.",
        ),
        { statusCode: 409, code: "BACKUP_OBJECT_TOO_LARGE" },
      );
    if ((remote.formatVersion ?? remote.remote.formatVersion) &&
        ![1, 2].includes(remote.formatVersion ?? remote.remote.formatVersion!))
      throw Object.assign(
        new Error("The remote backup format is not supported by this Agentor version"),
        { statusCode: 409, code: "BACKUP_FORMAT_UNSUPPORTED" },
      );
    const existingArtifact = this.store
      .get(userId)
      .artifacts.find(
        (artifact) =>
          artifact.provider === remote.provider &&
          artifact.providerObjectId === remote.providerObjectId,
      );
    const normalizedRequestId = normalizeBackupRequestId(requestId);
    const fingerprint = requestFingerprint({
      operation: "adoption",
      provider: remote.provider,
      providerObjectId: remote.providerObjectId,
    });
    const now = new Date().toISOString();
    const candidate: BackupJob = {
      schemaVersion: 1,
      id: randomUUID(),
      userId,
      ownerId: userId,
      workspaceId: userId,
      provider: remote.provider,
      status: existingArtifact ? "succeeded" : "queued",
      phase: existingArtifact ? "complete" : "queued",
      progress: existingArtifact ? 100 : 0,
      bytesProcessed: 0,
      createdAt: now,
      updatedAt: now,
      ...(existingArtifact ? { completedAt: now } : {}),
      attempt: 1,
      operation: "adoption",
      remoteBackupId: remote.id,
      ...(existingArtifact
        ? {
            artifactId: existingArtifact.id,
            backupId: existingArtifact.id,
            integrityVerified: existingArtifact.integrityStatus === "verified",
          }
        : {}),
      requestFingerprint: fingerprint,
      ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
      logs: [
        existingArtifact
          ? "Remote backup was already adopted."
          : "Remote backup adoption queued.",
      ],
    };
    const claimed = await this.claimStartJob(candidate);
    if (!claimed.created) return sanitizeJob(claimed.job);
    if (!existingArtifact)
      this.enqueue(candidate.id, userId, () =>
        this.runAdoption(candidate, remote),
      );
    return sanitizeJob(candidate);
  }

  /** Recover exactly one captured custom-image recipe from an authorized,
   * already retained artifact.  Context bytes deliberately remain inside the
   * encrypted archive; the durable job records only catalog/build identities. */
  async createImageRecovery(
    userId: string,
    artifactId: string,
    workspaceId: string,
    requestId?: string,
    startBuild = true,
  ): Promise<BackupJob> {
    await this.init();
    this.assertOwnerAvailable(userId);
    const artifact = this.store.get(userId).artifacts.find((item) => item.id === artifactId);
    if (!artifact || artifact.deletionPending)
      throw Object.assign(new Error("Backup artifact not found"), { statusCode: 404 });
    if (!this.artifactWorkspaceIds(artifact).includes(workspaceId))
      throw Object.assign(new Error("Selected workspace is not contained in this backup artifact"), { statusCode: 400 });
    const summary = artifact.reconstruction?.find((item) => item.workspaceId === workspaceId);
    if (!summary || summary.image.kind !== "custom" || summary.image.recoveryAvailable !== true)
      throw Object.assign(
        new Error("This workspace has no portable custom-image recipe. Select a replacement image or explicitly restore workspace-only."),
        { statusCode: 409, code: "BACKUP_IMAGE_RECIPE_UNAVAILABLE" },
      );
    const normalizedRequestId = normalizeBackupRequestId(requestId);
    const fingerprint = requestFingerprint({
      operation: "dependency-resolution",
      artifactId,
      workspaceId,
      startBuild,
    });
    const now = new Date().toISOString();
    const candidate: BackupJob = {
      schemaVersion: 1, id: randomUUID(), userId, ownerId: userId,
      workspaceId, workspaceIds: [workspaceId], artifactWorkspaceIds: this.artifactWorkspaceIds(artifact),
      selectedWorkspaceIds: [workspaceId], artifactId, provider: artifact.provider,
      status: "queued", phase: "queued", progress: 0, bytesProcessed: 0,
      createdAt: now, updatedAt: now, attempt: 1,
      operation: "dependency-resolution", requestFingerprint: fingerprint,
      recoverImageStartBuild: startBuild,
      ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
      logs: ["Portable image recipe recovery queued."],
    };
    const pinOwner = this.restorePinOwner(candidate.id, candidate.attempt);
    this.pinRestoreArtifact(pinOwner, artifact);
    try {
      const claimed = await this.claimStartJob(candidate);
      if (!claimed.created) {
        this.releaseRestoreArtifactPin(pinOwner);
        return sanitizeJob(claimed.job);
      }
      this.enqueue(candidate.id, userId, () =>
        this.runImageRecovery(candidate, artifact, startBuild, pinOwner),
      );
    } catch (error) {
      this.releaseRestoreArtifactPin(pinOwner);
      throw error;
    }
    return sanitizeJob(candidate);
  }

  private async runImageRecovery(
    job: BackupJob,
    artifact: BackupArtifact,
    startBuild: boolean,
    pinOwner: string,
  ) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const dir = join(this.dataDir, "tmp", `dependency-resolution-${job.id}`);
    const assertActive = () => {
      if (controller.signal.aborted || this.cancelledJobs.has(job.id) || job.status === "cancelled")
        throw Object.assign(new Error("Image recovery cancelled"), { name: "AbortError" });
    };
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      job.status = "running";
      job.phase = "downloading";
      job.progress = 10;
      job.startedAt ||= new Date().toISOString();
      appendBackupJobLog(job, "Downloading the authenticated backup artifact to recover its image recipe.");
      await this.saveJob(job);
      const encrypted = join(dir, "archive.enc"), plain = join(dir, "bundle.tar");
      await this.providers.get(artifact.provider)!.download(
        job.userId, artifact.providerObjectId, encrypted, controller.signal,
        { expectedSize: artifact.size, maxBytes: MAX_BACKUP_PROVIDER_OBJECT_BYTES },
      );
      assertActive();
      if ((await stat(encrypted)).size !== artifact.size)
        throw Object.assign(new Error("The provider object changed after adoption. Scan and adopt it again before recovering the image recipe."), { code: "BACKUP_REMOTE_OBJECT_CHANGED", statusCode: 409 });
      job.phase = "verifying";
      job.progress = 40;
      appendBackupJobLog(job, "Authenticating and decrypting the retained backup before reading its image recipe.");
      await this.saveJob(job);
      await this.decryptArtifact(job.userId, artifact, encrypted, plain);
      assertActive();
      job.integrityVerified = true;
      const workspaceId = job.selectedWorkspaceIds?.[0];
      if (!workspaceId) throw new Error("Image recovery workspace selection is missing");
      const bundles = await unpackWorkspaceBackups(
        plain, this.artifactWorkspaceIds(artifact), [workspaceId], join(dir, "workspaces"),
      );
      const bundle = bundles[0];
      if (!bundle) throw Object.assign(new Error("Selected workspace is absent from the authenticated backup"), { code: "BACKUP_MANIFEST_MISMATCH" });
      const extracted = await extractBundle(bundle.path, join(dir, "workspace"));
      if (!extracted.reconstructionPath)
        throw Object.assign(new Error("This backup does not contain portable image reconstruction metadata. Select a replacement image or explicitly restore workspace-only."), { code: "BACKUP_IMAGE_RECIPE_UNAVAILABLE", statusCode: 409 });
      const reconstruction = await readWorkerReconstruction(extracted.reconstructionPath);
      if (reconstruction.image.kind !== "custom" || !reconstruction.image.definition)
        throw Object.assign(new Error("The selected workspace has no embedded custom-image recipe. Select a replacement image or explicitly restore workspace-only."), { code: "BACKUP_IMAGE_RECIPE_UNAVAILABLE", statusCode: 409 });
      assertActive();
      job.phase = "importing-definition";
      job.progress = 65;
      appendBackupJobLog(job, "Importing a validated owner-scoped recovery copy of the custom image definition.");
      await this.saveJob(job);
      const catalog = useImageCatalogManager();
      await catalog.init();
      let definitionId = job.recoveredImageDefinitionId;
      if (!definitionId) {
        const recipe = reconstruction.image.definition;
        const version = reconstruction.image.imageVersion;
        const selectedPlugins =
          version?.pluginComposition !== undefined
            ? version.pluginComposition
            : recipe.pluginComposition;
        const pluginComposition = selectedPlugins?.length
          ? await this.recoverImagePluginDefinitions(
              job.userId,
              extracted.pluginConfigurationPath,
              selectedPlugins,
            )
          : undefined;
        const definition = await catalog.create(job.userId, {
          ...recipe,
          name: `${recipe.name.slice(0, 84)} (recovered)`,
          baseImage: version?.baseImage ?? recipe.baseImage,
          contextFiles: version?.contextFiles ?? recipe.contextFiles,
          provisioning: version?.provisioning ?? recipe.provisioning,
          provisioningMode: version?.provisioningMode ?? recipe.provisioningMode,
          // An explicitly empty version composition overrides the definition
          // recipe. Set the field even though catalog validation later omits
          // empty arrays, otherwise `...recipe` would resurrect old entries.
          pluginComposition: pluginComposition ?? [],
        });
        definitionId = definition.id;
        job.recoveredImageDefinitionId = definitionId;
        await this.saveJob(job);
      }
      assertActive();
      if (startBuild && !job.recoveredImageBuildId) {
        job.phase = "starting-build";
        job.progress = 80;
        appendBackupJobLog(job, "Starting the ordinary asynchronous controlled image build.");
        await this.saveJob(job);
        const build = await catalog.startBuild(definitionId, job.userId, false, {
          requestId: `backup-recovery-${job.id}`,
        });
        job.recoveredImageBuildId = build.id;
      }
      job.status = "succeeded";
      job.phase = startBuild ? "build-started" : "definition-recovered";
      job.progress = 100;
      job.completedAt = job.updatedAt = new Date().toISOString();
      appendBackupJobLog(job, startBuild ? "Recovery definition imported and its asynchronous image build started." : "Recovery definition imported. Start an image build when ready.");
      await this.saveJob(job);
    } catch (error) {
      if (controller.signal.aborted || this.cancelledJobs.has(job.id) || job.status === "cancelled") {
        job.status = "cancelled"; job.phase = "cancelled";
        appendBackupJobLog(job, "Portable image recipe recovery cancelled.");
      } else {
        job.status = "failed"; job.phase = "failed";
        job.errorCode = safeBackupErrorCode(error, "BACKUP_IMAGE_RECOVERY_FAILED");
        job.error = safeImageRecoveryError(error);
        job.retryable = isRetryableImageRecoveryError(error);
        appendBackupJobLog(job, "Portable image recipe recovery failed. The adopted artifact and any imported recovery definition were retained for inspection or retry.");
      }
      job.completedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
    } finally {
      this.controllers.delete(job.id);
      this.releaseRestoreArtifactPin(pinOwner);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Portable plugin definitions are reusable metadata, not worker instances:
   * import only the definitions referenced by the image recipe and remap their
   * destination-local ids.  No installation, secret, port, display, or other
   * runtime allocation is recreated here. */
  private async recoverImagePluginDefinitions(
    userId: string,
    configurationPath: string | undefined,
    selections: Array<{ definitionId: string; validation: "required" | "optional" }>,
  ): Promise<Array<{ definitionId: string; validation: "required" | "optional" }>> {
    if (!configurationPath)
      throw Object.assign(new Error("The image recipe references plugins, but this backup has no portable plugin definitions. Recover the plugins first or edit the recovered image definition."), { code: "BACKUP_PLUGIN_DEFINITION_MISSING", statusCode: 409 });
    const configuration = await readPortablePluginConfiguration(configurationPath);
    const source = new Map(configuration.definitions.map((definition) => [definition.sourceId, definition]));
    const definitions = usePluginDefinitionStore();
    await definitions.init();
    const mappings = new Map<string, string>();
    for (const selection of selections) {
      if (mappings.has(selection.definitionId)) continue;
      const portable = source.get(selection.definitionId);
      if (!portable)
        throw Object.assign(new Error("The image recipe references a plugin definition that is absent from this backup. Recover or replace that plugin before building."), { code: "BACKUP_PLUGIN_DEFINITION_MISSING", statusCode: 409 });
      const existing = definitions.getById(selection.definitionId);
      if (
        existing &&
        (existing.scope === "platform" ||
          (existing.scope === "owner" && existing.userId === userId)) &&
        existing.definitionHash === pluginDefinitionHash(portable.manifest)
      ) {
        mappings.set(selection.definitionId, existing.id);
        continue;
      }
      // A retry may already have created a destination-local owner copy before
      // a later catalog step failed. Reuse the canonical manifest rather than
      // minting another definition for every retry.
      const reusable = definitions
        .listForOwner(userId)
        .find(
          (candidate) =>
            (candidate.scope === "platform" ||
              (candidate.scope === "owner" && candidate.userId === userId)) &&
            candidate.definitionHash ===
              pluginDefinitionHash(portable.manifest),
        );
      if (reusable) {
        mappings.set(selection.definitionId, reusable.id);
        continue;
      }
      const recovered = await definitions.create({
        scope: "owner", ownerId: userId, manifest: portable.manifest,
      });
      mappings.set(selection.definitionId, recovered.id);
    }
    return selections.map((selection) => ({
      definitionId: mappings.get(selection.definitionId)!, validation: selection.validation,
    }));
  }

  private async runDiscovery(job: BackupJob) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const provider = this.providers.get(job.provider)!;
    const dir = join(this.dataDir, "tmp", `discovery-${job.id}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      job.status = "running";
      job.phase = "scanning-provider";
      job.startedAt ||= new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      appendBackupJobLog(job, "Scanning the connected provider for Agentor backup objects.");
      await this.saveJob(job);
      let cursor: string | undefined;
      let pages = 0;
      let discovered = 0;
      do {
        controller.signal.throwIfAborted();
        if (++pages > 100)
          throw new Error("Provider discovery returned too many pages");
        const page = await provider.discover!(job.userId, cursor, controller.signal);
        for (const descriptor of page.records) {
          controller.signal.throwIfAborted();
          let formatVersion = descriptor.formatVersion;
          let keyFingerprint = descriptor.keyFingerprint;
          let sourceInstallationId: string | undefined;
          let headerWorkspaceIds: string[] | undefined;
          let headerCreatedAt: string | undefined;
          let headerBackupId: string | undefined;
          let headerInvalid = false;
          let headerAccessFailure: string | undefined;
          if (provider.readRange) {
            const path = join(dir, `${randomUUID()}.header`);
            try {
              await writeFile(
                path,
                await provider.readRange(
                  job.userId,
                  descriptor.objectId,
                  64 * 1024,
                  controller.signal,
                ),
                { mode: 0o600 },
              );
              try {
                const header = await inspectBackupV2(path);
                formatVersion = 2;
                keyFingerprint = header.keyFingerprint;
                sourceInstallationId = safeRemoteId(
                  header.metadata.sourceInstallationId,
                );
                headerWorkspaceIds = header.metadata.workspaceIds?.filter(
                  (id) => /^[A-Za-z0-9_-]{1,200}$/.test(id),
                );
                headerCreatedAt = safeRemoteTimestamp(header.metadata.createdAt);
                headerBackupId = safeRemoteId(header.metadata.backupId);
              } catch {
                if (descriptor.formatVersion === 2) headerInvalid = true;
              }
            } catch (error) {
              if (controller.signal.aborted) throw error;
              const failure = publicBackupFailure(error);
              headerAccessFailure =
                failure.code === "BACKUP_FAILED"
                  ? "The provider object could not be inspected."
                  : failure.message;
            } finally {
              await rm(path, { force: true }).catch(() => {});
            }
          }
          const existingArtifact = this.store
            .get(job.userId)
            .artifacts.find(
              (artifact) =>
                artifact.provider === job.provider &&
                artifact.providerObjectId === descriptor.objectId,
            );
          const existingRemote = this.store
            .get(job.userId)
            .remoteBackups.find(
              (candidate) =>
                candidate.provider === job.provider &&
                candidate.providerObjectId === descriptor.objectId,
            );
          const unchangedDamagedRecord = Boolean(
            existingRemote?.state === "damaged" &&
              existingRemote.remote.size === descriptor.size &&
              existingRemote.remote.integritySha256 ===
                descriptor.integritySha256,
          );
          const keyAvailable = keyFingerprint
            ? Boolean(await this.keyring.find(job.userId, keyFingerprint))
            : undefined;
          const now = new Date().toISOString();
          const unsupported =
            formatVersion !== undefined && ![1, 2].includes(formatVersion);
          const tooLarge =
            descriptor.size > MAX_BACKUP_PROVIDER_OBJECT_BYTES;
          const state: RemoteBackupRecord["state"] = existingArtifact
            ? "adopted"
            : descriptor.incomplete
              ? "incomplete"
              : headerAccessFailure
                ? "inaccessible"
              : headerInvalid
                ? "damaged"
                : unchangedDamagedRecord
                  ? "damaged"
                  : tooLarge
                    ? "too-large"
                    : unsupported
                      ? "unsupported-format"
                  : keyFingerprint && !keyAvailable
                    ? "missing-key"
                    : "ready-to-adopt";
          const blockedReason =
            state === "incomplete"
              ? "The provider object is marked as an incomplete upload."
              : state === "inaccessible"
                ? headerAccessFailure
              : state === "damaged"
                ? unchangedDamagedRecord
                  ? existingRemote?.blockedReason ??
                    "The provider object previously failed authenticated integrity or manifest validation."
                  : "The v2 discovery header is invalid or incomplete."
                : state === "unsupported-format"
                  ? `Backup format ${formatVersion} is not supported.`
                  : state === "too-large"
                    ? "The provider object exceeds Agentor's staging size limit."
                  : state === "missing-key"
                    ? `Recovery key ${keyFingerprint} is not available on this installation.`
                    : undefined;
          await this.store.upsertRemoteBackup(job.userId, {
            schemaVersion: 1,
            id: randomUUID(),
            userId: job.userId,
            provider: job.provider,
            providerObjectId: descriptor.objectId,
            discoveredAt: now,
            lastSeenAt: now,
            remote: {
              ...descriptor,
              ...(formatVersion ? { formatVersion } : {}),
              ...(keyFingerprint ? { keyFingerprint } : {}),
              ...(headerCreatedAt ? { createdAt: headerCreatedAt } : {}),
              ...(headerBackupId ? { artifactId: headerBackupId } : {}),
            },
            state,
            integrityStatus: existingArtifact ? "verified" : "unverified",
            ...(blockedReason ? { blockedReason } : {}),
            ...(sourceInstallationId ? { sourceInstallationId } : {}),
            ...(keyFingerprint ? { keyFingerprint } : {}),
            ...(formatVersion ? { formatVersion } : {}),
            ...(headerWorkspaceIds?.length
              ? { workspaceIds: headerWorkspaceIds }
              : {}),
            ...(existingArtifact
              ? { adoptedArtifactId: existingArtifact.id }
              : {}),
          });
          discovered++;
        }
        cursor = page.nextCursor;
        job.bytesProcessed = discovered;
        job.progress = Math.min(95, 10 + pages * 10);
        job.updatedAt = new Date().toISOString();
        await this.saveJob(job);
      } while (cursor);
      job.status = "succeeded";
      job.phase = "complete";
      job.progress = 100;
      job.completedAt = job.updatedAt = new Date().toISOString();
      appendBackupJobLog(
        job,
        discovered
          ? `Provider scan completed; ${discovered} backup object(s) were inspected.`
          : "Provider scan completed; no Agentor backups were found.",
      );
      await this.saveJob(job);
    } catch (error) {
      if (controller.signal.aborted || this.cancelledJobs.has(job.id)) {
        job.status = "cancelled";
        job.phase = "cancelled";
      } else {
        const failure = publicBackupFailure(error);
        job.status = "failed";
        job.phase = "failed";
        job.error = failure.message;
        job.errorCode = failure.code;
        job.providerStatus = failure.providerStatus;
        job.retryable = failure.retryable;
        appendBackupJobLog(job, "Provider discovery failed. Retry is available when the provider error is transient.");
      }
      job.completedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
    } finally {
      this.controllers.delete(job.id);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runAdoption(job: BackupJob, remote: RemoteBackupRecord) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const dir = join(this.dataDir, "tmp", `adoption-${job.id}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      job.status = "running";
      job.phase = "downloading";
      job.progress = 10;
      job.startedAt ||= new Date().toISOString();
      appendBackupJobLog(job, "Downloading the selected provider object.");
      await this.saveJob(job);
      const encrypted = join(dir, "archive.enc");
      const plain = join(dir, "bundle.tar");
      await this.providers
        .get(remote.provider)!
        .download(
          job.userId,
          remote.providerObjectId,
          encrypted,
          controller.signal,
          {
            expectedSize: remote.remote.size,
            maxBytes: MAX_BACKUP_PROVIDER_OBJECT_BYTES,
          },
        );
      controller.signal.throwIfAborted();
      const downloadedSize = (await stat(encrypted)).size;
      if (downloadedSize !== remote.remote.size)
        throw Object.assign(
          new Error(
            "The provider object changed after discovery. Scan the provider again before adopting it.",
          ),
          {
            code: "BACKUP_REMOTE_OBJECT_CHANGED",
            statusCode: 409,
            retryable: true,
          },
        );
      job.phase = "verifying";
      job.progress = 45;
      appendBackupJobLog(job, "Authenticating and decrypting the backup before adoption.");
      await this.saveJob(job);
      const sha256 = await encryptedBackupPayloadSha256(encrypted);
      let formatVersion = 1;
      let keyFingerprint: string | undefined;
      let sourceInstallationId: string | undefined;
      let authenticatedCreatedAt: string | undefined;
      let authenticatedArtifactId: string | undefined;
      let authenticatedWorkspaceIds: string[] | undefined;
      let v2Header: Awaited<ReturnType<typeof inspectBackupV2>> | undefined;
      try {
        v2Header = await inspectBackupV2(encrypted);
      } catch (error) {
        if (
          (remote.formatVersion ?? remote.remote.formatVersion) === 2 ||
          !(
            error instanceof Error &&
            error.message === "Unsupported backup format"
          )
        )
          throw error;
      }
      if (v2Header) {
        const header = v2Header;
        formatVersion = 2;
        keyFingerprint = header.keyFingerprint;
        await decryptBackupV2(
          { ...useConfig(), dataDir: this.dataDir },
          job.userId,
          encrypted,
          plain,
          sha256,
          this.keyring,
        );
        sourceInstallationId = safeRemoteId(
          header.metadata.sourceInstallationId,
        );
        authenticatedCreatedAt = safeRemoteTimestamp(header.metadata.createdAt);
        authenticatedArtifactId = safeRemoteId(header.metadata.backupId);
        authenticatedWorkspaceIds = header.metadata.workspaceIds;
      } else {
        const candidates = await this.keyring.candidates(job.userId);
        let matched: { fingerprint: string } | undefined;
        for (const candidate of candidates) {
          const attempt = join(dir, `v1-${randomUUID()}.tar`);
          try {
            await decryptBackupV1WithMaterial(
              encrypted,
              attempt,
              sha256,
              candidate.material,
            );
            await rename(attempt, plain);
            matched = { fingerprint: candidate.fingerprint };
            break;
          } catch {
            await rm(attempt, { force: true }).catch(() => {});
          }
        }
        if (!matched)
          throw Object.assign(
            new Error("No available recovery key could authenticate this legacy backup."),
            { code: "BACKUP_RECOVERY_KEY_MISSING", statusCode: 409 },
          );
        keyFingerprint = matched.fingerprint;
      }
      controller.signal.throwIfAborted();
      const inspected = await inspectWorkspaceBackups(
        plain,
        join(dir, "inspection"),
      );
      const actualWorkspaceIds = inspected.workspaces.map(({ id }) => id);
      if (
        authenticatedWorkspaceIds &&
        (authenticatedWorkspaceIds.length !== actualWorkspaceIds.length ||
          authenticatedWorkspaceIds.some((id) => !actualWorkspaceIds.includes(id)))
      )
        throw Object.assign(
          new Error("The authenticated backup summary does not match the contained workspaces."),
          { code: "BACKUP_MANIFEST_MISMATCH" },
        );
      const {
        summaries,
        dependencies,
        missingSecrets,
        selectedPathsByWorkspace,
      } = await this.summarizeArtifactInspection(job.userId, inspected);
      job.phase = "adopting";
      job.progress = 85;
      job.dependencies = dependencies;
      await this.saveJob(job);
      const data = this.store.get(job.userId);
      const already = data.artifacts.find(
        (artifact) =>
          artifact.provider === remote.provider &&
          artifact.providerObjectId === remote.providerObjectId,
      );
      let artifact = already;
      if (!artifact) {
        // A provider backup identity belongs to its source installation. A
        // destination-local artifact always gets a fresh identity so a scan
        // from another account/installation cannot collide with an existing
        // local artifact and make owner-scoped lookup resolve the wrong row.
        // The authenticated source identity remains on the remote discovery
        // record for inspection and deduplication uses provider object id.
        const id = randomUUID();
        artifact = {
          schemaVersion: 1,
          id,
          userId: job.userId,
          workspaceId: actualWorkspaceIds[0]!,
          workspaceIds: actualWorkspaceIds,
          provider: remote.provider,
          providerObjectId: remote.providerObjectId,
          createdAt:
            authenticatedCreatedAt ??
            remote.remote.createdAt ??
            new Date().toISOString(),
          size: downloadedSize,
          sha256,
          sourceWorkerId: actualWorkspaceIds[0],
          missingSecrets,
          ...(Object.keys(selectedPathsByWorkspace).length
            ? { selectedPathsByWorkspace }
            : {}),
          formatVersion,
          ...(keyFingerprint ? { keyFingerprint } : {}),
          ...(sourceInstallationId ? { sourceInstallationId } : {}),
          integrityStatus: "verified",
          provenance: "remote-adopted",
          workspaceMembers: summaries.map(({ workspaceId: id, displayName }) =>
            displayName ? { id, displayName } : { id },
          ),
          reconstruction: summaries,
          dependencies,
        };
        await this.store.update(job.userId, (draft) => {
          const duplicate = draft.artifacts.find(
            (candidate) =>
              candidate.provider === remote.provider &&
              candidate.providerObjectId === remote.providerObjectId,
          );
          if (!duplicate) draft.artifacts.push(structuredClone(artifact!));
          else artifact = duplicate;
          const discovered = draft.remoteBackups.find(
            (candidate) => candidate.id === remote.id,
          );
          if (discovered) {
            discovered.adoptedArtifactId = artifact!.id;
            discovered.state = "adopted";
            discovered.integrityStatus = "verified";
            discovered.workspaceIds = actualWorkspaceIds;
            discovered.workspaceMembers = artifact!.workspaceMembers;
            discovered.keyFingerprint = keyFingerprint;
            discovered.formatVersion = formatVersion;
            if (sourceInstallationId)
              discovered.sourceInstallationId = sourceInstallationId;
            if (authenticatedCreatedAt)
              discovered.remote.createdAt = authenticatedCreatedAt;
            if (authenticatedArtifactId)
              discovered.remote.artifactId = authenticatedArtifactId;
            discovered.blockedReason = undefined;
          }
        });
      }
      job.status = "succeeded";
      job.phase = "complete";
      job.progress = 100;
      job.artifactId = job.backupId = artifact.id;
      job.integrityVerified = true;
      job.size = job.sizeBytes = artifact.size;
      job.sha256 = artifact.sha256;
      job.workspaceIds = actualWorkspaceIds;
      job.missingSecrets = artifact.missingSecrets.map((name) => ({
        name,
        type: "secret",
      }));
      job.completedAt = job.updatedAt = new Date().toISOString();
      appendBackupJobLog(job, "Backup adopted after successful authentication, integrity, and manifest validation.");
      await this.saveJob(job);
    } catch (error: any) {
      if (controller.signal.aborted || this.cancelledJobs.has(job.id)) {
        job.status = "cancelled";
        job.phase = "cancelled";
      } else {
        job.status = "failed";
        job.phase = "failed";
        job.errorCode = safeBackupErrorCode(error, "BACKUP_ADOPTION_FAILED");
        job.error = safeAdoptionError(error);
        job.retryable = isRetryableAdoptionError(error);
        appendBackupJobLog(job, "Backup adoption stopped without deleting the discovered record.");
        await this.store.update(job.userId, (draft) => {
          const discovered = draft.remoteBackups.find(
            (candidate) => candidate.id === remote.id,
          );
          if (!discovered) return;
          discovered.lastErrorAt = new Date().toISOString();
          if (job.errorCode === "BACKUP_RECOVERY_KEY_MISSING") {
            discovered.state = "missing-key";
            discovered.blockedReason = job.error;
          } else if (/INTEGRITY|AUTHENTICATION|MANIFEST|INVALID/i.test(job.errorCode || "")) {
            discovered.state = "damaged";
            discovered.integrityStatus = "failed";
            discovered.blockedReason = job.error;
          } else {
            discovered.state = "inaccessible";
            discovered.blockedReason = job.error;
          }
        });
      }
      job.completedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
    } finally {
      this.controllers.delete(job.id);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async summarizeWorkspaceReconstruction(
    userId: string,
    workspace: Awaited<ReturnType<typeof inspectWorkspaceBackups>>["workspaces"][number],
    dependencies: BackupDependency[],
  ): Promise<BackupWorkspaceReconstructionSummary> {
    const requiredSecrets = new Set<string>([
      ...(workspace.manifest.missingSecrets ?? []),
      ...(workspace.reconstruction?.requiredSecretNames ?? []),
      ...(workspace.plugins?.installations.flatMap(({ secretKeys }) => secretKeys) ?? []),
    ]);
    const resolution = await resolveWorkerReconstruction(
      userId,
      workspace.reconstruction,
    );
    let image: BackupWorkspaceReconstructionSummary["image"];
    if (!workspace.reconstruction) image = { kind: "legacy" };
    else if (workspace.reconstruction.image.kind === "platform-default")
      image = { kind: "platform-default" };
    else if (workspace.reconstruction.image.kind === "unmanaged") {
      const required = workspace.reconstruction.image;
      image = {
        kind: "unmanaged",
        ...(required.digest ? { digest: required.digest } : {}),
        runtimeImageAvailable: false,
      };
      dependencies.push({
        kind: "image",
        id: `unmanaged:${workspace.id}${required.digest ? `@${required.digest}` : ""}`,
        workspaceId: workspace.id,
        status: "replacement-required",
        required: true,
        reason:
          "The source worker used a per-worker or otherwise unmanaged image without a portable catalog definition. Select a replacement image or explicitly restore workspace-only.",
      });
    } else {
      const required = workspace.reconstruction.image;
      image = {
        kind: "custom",
        definitionId: required.definitionId,
        version: required.version,
        digest: required.digest,
        runtimeImageAvailable: Boolean(required.runtimeImage),
        recoveryAvailable: Boolean(required.definition),
        ...(required.catalogSource
          ? { catalogSource: structuredClone(required.catalogSource) }
          : {}),
      };
      dependencies.push({
        kind: "image",
        id: `${required.definitionId}:${required.version}@${required.digest}`,
        workspaceId: workspace.id,
        status:
          resolution.state === "resolved"
            ? "resolved"
            : "replacement-required",
        required: true,
        ...(resolution.state === "unresolved"
          ? {
              reason:
                "Recover or sync the image definition, rebuild it, pull the immutable digest, select a replacement, or explicitly choose workspace-only restore.",
            }
          : {}),
      });
    }
    const pluginDefinitions =
      workspace.plugins?.definitions.map(({ sourceId, manifest }) => ({
        sourceId,
        name: manifest.name,
        version: manifest.version,
      })) ?? [];
    for (const plugin of pluginDefinitions)
      dependencies.push({
        kind: "plugin",
        id: `${plugin.name}@${plugin.version}`,
        workspaceId: workspace.id,
        status: "resolved",
        required: workspace.plugins?.installations.some(
          ({ definitionSourceId }) => definitionSourceId === plugin.sourceId,
        ),
        reason:
          "The reusable plugin definition is embedded; runtime ports, displays, sessions, and process state will be allocated again.",
      });
    for (const name of requiredSecrets)
      dependencies.push({
        kind: "secret",
        id: name,
        workspaceId: workspace.id,
        status: "missing",
        required: true,
        reason:
          "Only the secret name is portable. Configure its value on the restored worker.",
      });
    return {
      workspaceId: workspace.id,
      displayName: workspace.manifest.source.displayName,
      image,
      pluginDefinitions,
      desiredPluginCount: workspace.plugins?.installations.length ?? 0,
      requiredSecretNames: [...requiredSecrets].sort(),
    };
  }

  private async summarizeArtifactInspection(
    userId: string,
    inspected: Awaited<ReturnType<typeof inspectWorkspaceBackups>>,
  ): Promise<{
    summaries: BackupWorkspaceReconstructionSummary[];
    dependencies: BackupDependency[];
    missingSecrets: string[];
    selectedPathsByWorkspace: Record<string, string[]>;
  }> {
    const summaries: BackupWorkspaceReconstructionSummary[] = [];
    const dependencies: BackupDependency[] = [];
    const missingSecrets = new Set<string>();
    const selectedPathsByWorkspace: Record<string, string[]> = {};
    for (const workspace of inspected.workspaces) {
      const summary = await this.summarizeWorkspaceReconstruction(
        userId,
        workspace,
        dependencies,
      );
      summaries.push(summary);
      for (const name of summary.requiredSecretNames) missingSecrets.add(name);
      if (workspace.manifest.backupPaths?.length)
        selectedPathsByWorkspace[workspace.id] = [
          ...new Set(workspace.manifest.backupPaths.map(({ path }) => path)),
        ];
    }
    return {
      summaries,
      dependencies,
      missingSecrets: [...missingSecrets].sort(),
      selectedPathsByWorkspace,
    };
  }

  private async preflightRestoreDependencies(
    userId: string,
    artifact: BackupArtifact,
    selectedWorkspaceIds: string[],
    imageResolutions?: Record<string, BackupImageResolution>,
  ): Promise<BackupDependency[]> {
    const selected = new Set(selectedWorkspaceIds);
    const dependencies = structuredClone(
      (artifact.dependencies ?? []).filter(
        (dependency) =>
          !dependency.workspaceId || selected.has(dependency.workspaceId),
      ),
    );
    const summaries = (artifact.reconstruction ?? []).filter((summary) =>
      selected.has(summary.workspaceId),
    );
    const catalog = useImageCatalogManager();
    await catalog.init();
    const blockers: BackupDependency[] = [];
    for (const summary of summaries) {
      if (summary.image.kind !== "custom" && summary.image.kind !== "unmanaged")
        continue;
      const resolution = imageResolutions?.[summary.workspaceId] ?? {
        mode: "exact" as const,
      };
      const dependencyId =
        summary.image.kind === "custom"
          ? `${summary.image.definitionId}:${summary.image.version}@${summary.image.digest}`
          : `unmanaged:${summary.workspaceId}${summary.image.digest ? `@${summary.image.digest}` : ""}`;
      const prior = dependencies.find(
        (dependency) =>
          dependency.kind === "image" &&
          dependency.workspaceId === summary.workspaceId,
      );
      if (resolution.mode === "workspace-only") {
        const replacement: BackupDependency = {
          kind: "image",
          id: dependencyId,
          workspaceId: summary.workspaceId,
          status: "warning",
          required: false,
          reason:
            "Workspace-only restore was explicitly acknowledged; the new worker will use the platform image and is not a faithful image reconstruction.",
        };
        if (prior) Object.assign(prior, replacement);
        else dependencies.push(replacement);
        continue;
      }
      if (resolution.mode === "replacement") {
        try {
          const selectedImage = catalog.resolveSelection(
            userId,
            resolution.imageDefinitionId,
            resolution.imageVersion,
          );
          if (!selectedImage) throw new Error("replacement unavailable");
          const replacement: BackupDependency = {
            kind: "image",
            id: `${selectedImage.definitionId}:${selectedImage.version}@${selectedImage.digest}`,
            workspaceId: summary.workspaceId,
            status: "resolved",
            required: true,
            reason: `Explicit replacement for ${dependencyId}.`,
          };
          if (prior) Object.assign(prior, replacement);
          else dependencies.push(replacement);
          continue;
        } catch {
          blockers.push({
            kind: "image",
            id: `${resolution.imageDefinitionId}:${resolution.imageVersion}`,
            workspaceId: summary.workspaceId,
            status: "replacement-required",
            required: true,
            reason:
              "The selected replacement image is unavailable or not ready.",
          });
          continue;
        }
      }
      let exactAvailable = false;
      if (summary.image.kind === "unmanaged") {
        blockers.push({
          kind: "image",
          id: dependencyId,
          workspaceId: summary.workspaceId,
          status: "replacement-required",
          required: true,
          reason:
            "The source used an unmanaged per-worker image. Select a replacement or explicitly acknowledge workspace-only restore.",
        });
        continue;
      }
      const definitionIds = new Set([summary.image.definitionId!]);
      if (summary.image.catalogSource)
        for (const definition of catalog.list(userId, false))
          if (
            definition.gitRecovery?.remoteId ===
              summary.image.catalogSource.remoteId &&
            definition.gitRecovery.hash === summary.image.catalogSource.hash
          )
            definitionIds.add(definition.id);
      for (const definitionId of definitionIds) {
        try {
          const exact = catalog.resolveSelection(
            userId,
            definitionId,
            summary.image.version!,
          );
          if (exact && exact.digest === summary.image.digest) {
            exactAvailable = true;
            break;
          }
        } catch {
          // Keep searching provenance-equivalent local definitions.
        }
      }
      if (exactAvailable) {
        if (prior) prior.status = "resolved";
        else
          dependencies.push({
            kind: "image",
            id: dependencyId,
            workspaceId: summary.workspaceId,
            status: "resolved",
            required: true,
          });
      } else {
        blockers.push({
          kind: "image",
          id: dependencyId,
          workspaceId: summary.workspaceId,
          status: "replacement-required",
          required: true,
          reason:
            "Recover or sync the exact image definition, rebuild it, pull its immutable digest, select a replacement, or explicitly acknowledge workspace-only restore.",
        });
      }
    }
    if (blockers.length)
      throw Object.assign(
        new Error(
          "Restore dependencies are unresolved. No download or worker creation was started.",
        ),
        {
          statusCode: 409,
          code: "BACKUP_DEPENDENCIES_UNRESOLVED",
          data: { dependencies: blockers },
        },
      );
    return dependencies;
  }

  private async decryptArtifact(
    userId: string,
    artifact: BackupArtifact,
    encrypted: string,
    plain: string,
  ): Promise<void> {
    const config = { ...useConfig(), dataDir: this.dataDir };
    if (artifact.formatVersion === 2) {
      await decryptBackupV2(
        config,
        userId,
        encrypted,
        plain,
        artifact.sha256,
        this.keyring,
      );
      return;
    }
    // Local v1 artifacts retain their installation-key path. Adopted legacy
    // artifacts may instead depend on any explicitly imported historical key.
    if (artifact.provenance !== "remote-adopted") {
      try {
        await decryptBackup(config, encrypted, plain, artifact.sha256);
        return;
      } catch {
        await rm(plain, { force: true }).catch(() => {});
      }
    }
    const candidates = await this.keyring.candidates(userId);
    const preferred = artifact.keyFingerprint
      ? candidates.sort((left, right) =>
          left.fingerprint === artifact.keyFingerprint
            ? -1
            : right.fingerprint === artifact.keyFingerprint
              ? 1
              : 0,
        )
      : candidates;
    for (const candidate of preferred) {
      try {
        await decryptBackupV1WithMaterial(
          encrypted,
          plain,
          artifact.sha256,
          candidate.material,
        );
        return;
      } catch {
        await rm(plain, { force: true }).catch(() => {});
      }
    }
    throw Object.assign(
      new Error(
        "No available recovery key could authenticate this legacy backup.",
      ),
      {
        statusCode: 409,
        code: "BACKUP_RECOVERY_KEY_MISSING",
      },
    );
  }

  private async claimStartJob(
    candidate: BackupJob,
  ): Promise<{ job: BackupJob; created: boolean }> {
    return this.store.update(candidate.userId, (data) => {
      if (candidate.requestId) {
        const existing = data.jobs.find(
          (job) =>
            job.operation === candidate.operation &&
            job.requestId === candidate.requestId,
        );
        if (existing) {
          if (existing.requestFingerprint !== candidate.requestFingerprint)
            throw Object.assign(
              new Error(
                "The request identity is already associated with different backup arguments",
              ),
              { statusCode: 409, code: "BACKUP_REQUEST_ID_CONFLICT" },
            );
          return { job: structuredClone(existing), created: false };
        }
      } else if (candidate.requestFingerprint) {
        // Older REST clients may omit requestId. Coalesce an identical active
        // operation atomically so two near-simultaneous transport retries do
        // not duplicate provider scans/downloads. Durable retry after an
        // uncertain completed response still requires the documented ID.
        const active = data.jobs.find(
          (job) =>
            job.operation === candidate.operation &&
            job.requestFingerprint === candidate.requestFingerprint &&
            (job.status === "queued" || job.status === "running"),
        );
        if (active)
          return { job: structuredClone(active), created: false };
      }
      data.jobs.push(structuredClone(candidate));
      return { job: structuredClone(candidate), created: true };
    });
  }

  private findRemoteBackup(userId: string, id: string) {
    return this.store
      .get(userId)
      .remoteBackups.find((candidate) => candidate.id === id);
  }

  private async publicRemoteBackup(record: RemoteBackupRecord) {
    const fingerprint = record.keyFingerprint ?? record.remote.keyFingerprint;
    const keyAvailable = fingerprint
      ? Boolean(await this.keyring.find(record.userId, fingerprint))
      : null;
    const artifact = record.adoptedArtifactId
      ? this.store.findArtifact(record.adoptedArtifactId)
      : undefined;
    const persistedState = record.state;
    const state = artifact
      ? "adopted"
      : record.remote.incomplete
        ? "incomplete"
        : persistedState === "missing-key" && keyAvailable
          ? "ready-to-adopt"
          : persistedState === "ready-to-adopt" && fingerprint && !keyAvailable
            ? "missing-key"
            : persistedState ??
              (fingerprint && !keyAvailable
                ? "missing-key"
                : "discovered");
    return {
      ...record,
      createdAt: record.remote.createdAt ?? record.discoveredAt,
      size: record.remote.size,
      backupIdentity: record.remote.artifactId,
      state,
      formatVersion: record.formatVersion ?? record.remote.formatVersion,
      keyFingerprint: fingerprint,
      keyAvailable,
      knownLocally: Boolean(artifact),
      restorable: Boolean(artifact && artifact.integrityStatus === "verified"),
      ...(artifact
        ? {
            adoptedArtifact: {
              id: artifact.id,
              workspaceIds: this.artifactWorkspaceIds(artifact),
              workspaceMembers: artifact.workspaceMembers,
              reconstruction: artifact.reconstruction,
              dependencies: artifact.dependencies,
              requiredSecretNames: artifact.missingSecrets,
              integrityStatus: artifact.integrityStatus,
            },
          }
        : {}),
      blockedReason:
        (persistedState === state ? record.blockedReason : undefined) ??
        (state === "missing-key"
          ? `Recovery key ${fingerprint} is not available on this installation.`
          : state === "incomplete"
            ? "The provider upload is incomplete."
            : state === "discovered"
              ? "Adopt and verify this provider object before restoring it."
              : state === "ready-to-adopt"
                ? "Adopt and verify this provider object before restoring it."
              : undefined),
    };
  }
  async restore(
    userId: string,
    artifact: BackupArtifact,
    mode: "new" | "original",
    displayName?: string,
    selectedWorkspaceIds?: string[],
  ) {
    await this.init();
    this.assertOwnerAvailable(userId);
    const currentArtifact = this.store.findArtifact(artifact.id);
    if (
      !currentArtifact ||
      currentArtifact.userId !== userId ||
      currentArtifact.providerObjectId !== artifact.providerObjectId
    )
      throw new Error("Backup artifact not found");
    artifact = currentArtifact;
    if (mode === "original")
      throw new Error(
        "In-place restore is not safe while identity-preserving volume replacement is unavailable; restore into a new worker",
      );
    const restoreTaskId = `legacy-restore:${randomUUID()}`;
    this.pinRestoreArtifact(restoreTaskId, artifact);
    try {
      return await this.enqueueAndWait(restoreTaskId, userId, () =>
        this.runLegacyRestore(
          userId,
          artifact,
          displayName,
          selectedWorkspaceIds,
        ),
      );
    } finally {
      this.releaseRestoreArtifactPin(restoreTaskId);
    }
  }
  private async runLegacyRestore(
    userId: string,
    artifact: BackupArtifact,
    displayName?: string,
    selectedWorkspaceIds?: string[],
  ) {
    const dir = join(this.dataDir, "tmp", `restore-${randomUUID()}`);
    const encrypted = join(dir, "archive.enc");
    const plain = join(dir, "worker.tar");
    const createdWorkers: string[] = [];
    const execution = this.beginRestoreExecution(userId);
    const assertActive = () =>
      this.assertRestoreActive(userId, execution.controller.signal);
    try {
      assertActive();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      assertActive();
      await this.providers
        .get(artifact.provider)!
        .download(
          userId,
          artifact.providerObjectId,
          encrypted,
          execution.controller.signal,
          {
            expectedSize: artifact.size,
            maxBytes: MAX_BACKUP_PROVIDER_OBJECT_BYTES,
          },
        );
      assertActive();
      await this.decryptArtifact(userId, artifact, encrypted, plain);
      assertActive();
      const artifactWorkspaceIds = this.artifactWorkspaceIds(artifact);
      const selected = this.selectRestoreWorkspaceIds(
        artifactWorkspaceIds,
        selectedWorkspaceIds,
      );
      const bundles = await unpackWorkspaceBackups(
        plain,
        artifactWorkspaceIds,
        selected,
        join(dir, "workspaces"),
      );
      assertActive();
      const workers = [];
      for (const [index, bundle] of bundles.entries()) {
        assertActive();
        const worker = await useContainerManager().importWorker(
          userId,
          bundle.path,
          { displayName: index === 0 ? displayName : undefined },
        );
        workers.push(worker);
        createdWorkers.push(worker.id);
        assertActive();
      }
      return workers.length === 1 ? workers[0] : workers;
    } catch (error) {
      const survivingWorkers = await rollbackRestoredWorkers(createdWorkers);
      if (survivingWorkers.length)
        throw restoreRollbackFailure(survivingWorkers);
      throw error;
    } finally {
      try {
        await rm(dir, { recursive: true, force: true });
      } finally {
        execution.finish();
      }
    }
  }
  async createRestore(
    userId: string,
    artifact: BackupArtifact,
    target: "new" | "original",
    displayName?: string,
    lockPassword?: unknown,
    selectedWorkspaceIds?: string[],
    requestId?: string,
    imageResolutions?: Record<string, BackupImageResolution>,
  ): Promise<BackupJob> {
    await this.init();
    this.assertOwnerAvailable(userId);
    const currentArtifact = this.store.findArtifact(artifact.id);
    if (
      !currentArtifact ||
      currentArtifact.userId !== userId ||
      currentArtifact.providerObjectId !== artifact.providerObjectId
    )
      throw new Error("Backup artifact not found");
    artifact = currentArtifact;
    const artifactWorkspaceIds = this.artifactWorkspaceIds(artifact);
    const selected = this.selectRestoreWorkspaceIds(
      artifactWorkspaceIds,
      selectedWorkspaceIds,
    );
    const source = selected[0]!;
    if (target === "original" && selected.length !== 1)
      throw new Error(
        "Original restore requires selecting exactly one backup workspace",
      );
    if (target === "original" && extraBackupPaths(artifact.selectedPathsByWorkspace?.[source]).length)
      throw Object.assign(new Error("Original restore is unavailable for backups containing explicit absolute paths; restore into a new worker"), { statusCode: 409 });
    const normalizedResolutions = normalizeImageResolutions(
      selected,
      imageResolutions,
    );
    const dependencies =
      target === "new"
        ? await this.preflightRestoreDependencies(
            userId,
            artifact,
            selected,
            normalizedResolutions,
          )
        : structuredClone(
            (artifact.dependencies ?? []).filter(
              (dependency) =>
                !dependency.workspaceId ||
                selected.includes(dependency.workspaceId),
            ),
          );
    const normalizedRequestId = normalizeBackupRequestId(requestId);
    const fingerprint = requestFingerprint({
      operation: "restore",
      artifactId: artifact.id,
      target,
      displayName: displayName?.trim() || undefined,
      selectedWorkspaceIds: [...selected].sort(),
      imageResolutions: Object.fromEntries(
        Object.entries(normalizedResolutions ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    });
    const jobId = randomUUID();
    const restorePinOwner = this.restorePinOwner(jobId, 1);
    this.pinRestoreArtifact(restorePinOwner, artifact);
    const admission = this.beginRestoreExecution(userId);
    try {
      this.assertRestoreActive(userId, admission.controller.signal);
      if (target === "original") {
        const worker = useContainerManager().get(source);
        if (!worker || worker.userId !== userId || worker.status !== "stopped")
          throw new Error(
            "Selected original worker must be stopped for safe restore",
          );
        await useWorkerProtectionLockStore().verify(source, lockPassword);
        this.assertRestoreActive(userId, admission.controller.signal);
      }
      const now = new Date().toISOString();
      const job: BackupJob = {
        schemaVersion: 1,
        id: jobId,
        userId,
        ownerId: userId,
        workspaceId: artifact.workspaceId,
        workspaceIds: selected,
        artifactWorkspaceIds,
        selectedWorkspaceIds: selected,
        artifactId: artifact.id,
        provider: artifact.provider,
        status: "queued",
        phase: "queued",
        progress: 0,
        bytesProcessed: 0,
        createdAt: now,
        updatedAt: now,
        attempt: 1,
        operation: "restore",
        target,
        displayName,
        dependencies,
        ...(normalizedResolutions
          ? { imageResolutions: normalizedResolutions }
          : {}),
        requestFingerprint: fingerprint,
        ...(normalizedRequestId ? { requestId: normalizedRequestId } : {}),
        logs: ["Restore queued."],
      };
      const claimed = await this.claimStartJob(job);
      if (!claimed.created) {
        this.releaseRestoreArtifactPin(restorePinOwner);
        return sanitizeJob(claimed.job);
      }
      this.assertRestoreActive(userId, admission.controller.signal, job);
      this.enqueue(job.id, job.userId, () =>
        this.runRestoreV2(job, artifact, displayName, restorePinOwner),
      );
      return sanitizeJob(job);
    } catch (error) {
      this.releaseRestoreArtifactPin(restorePinOwner);
      throw error;
    } finally {
      admission.finish();
    }
  }
  private async runRestore(
    job: BackupJob,
    artifact: BackupArtifact,
    displayName?: string,
  ) {
    const dir = join(this.dataDir, "tmp", `restore-${job.id}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      job.status = "running";
      await this.recordAttempt(job.userId);
      job.phase = "downloading";
      job.progress = 20;
      await this.saveJob(job);
      const enc = join(dir, "archive.enc"),
        plain = join(dir, "worker.tar");
      await this.providers
        .get(artifact.provider)!
        .download(job.userId, artifact.providerObjectId, enc, undefined, {
          expectedSize: artifact.size,
          maxBytes: MAX_BACKUP_PROVIDER_OBJECT_BYTES,
        });
      job.phase = "verifying";
      job.progress = 60;
      await this.saveJob(job);
      await this.decryptArtifact(job.userId, artifact, enc, plain);
      job.integrityVerified = true;
      if (job.target === "new") {
        const worker = await useContainerManager().importWorker(
          job.userId,
          plain,
          { displayName },
        );
        job.workerId = worker.id;
      } else {
        job.workerId = artifact.sourceWorkerId;
      }
      job.missingSecrets = artifact.missingSecrets.map((name) => ({
        name,
        type: "secret",
      }));
      job.status = "succeeded";
      job.phase = "complete";
      job.progress = 100;
      job.completedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
    } catch {
      job.status = "failed";
      job.phase = "failed";
      job.error = "Restore failed. Check server logs for details.";
      job.completedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
      useLogger().error(`[backup] restore job ${job.id} failed`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  private async exportWorkspaceBundle(
    userId: string,
    id: string,
    destination: string,
    signal: AbortSignal,
    selectedPaths?: string[],
  ) {
    assertSafeUserId(userId);
    const live = useContainerManager().get(id);
    // Archived records remain visible through ContainerManager, but they no
    // longer have a Docker container. Only take the native export path when
    // sync discovered an actual container; archived storage is handled by
    // the hardened read-only helper below.
    const explicitPaths = extraBackupPaths(selectedPaths);
    // Omitted selection is the legacy complete portable backup. Once the
    // operator supplies a selection, exact default roots become ordinary,
    // deselectable paths while descendants remain explicit archives.
    const includeWorkspace =
      selectedPaths === undefined || selectedPaths.includes("/workspace");
    const includeAgents =
      selectedPaths === undefined ||
      selectedPaths.includes("/home/agent/.agent-data");
    if (live?.containerId) {
      if (explicitPaths.length)
        await useContainerManager().assertBackupPathsReadable(id, explicitPaths);
      const result = await useContainerManager().exportWorker(id, {
        includeRootfs: false,
        includeWorkspace,
        includeAgents,
        signal,
      });
      await pipeline(
        result.stream,
        createWriteStream(destination, { mode: 0o600 }),
        { signal },
      );
      if (explicitPaths.length)
        await this.appendExplicitBackupPaths(destination, live.containerId, explicitPaths, signal);
      return;
    }
    if (explicitPaths.length)
      throw Object.assign(new Error("Explicit backup paths require a running worker"), { statusCode: 409 });
    const worker = useWorkerStore().findById(id);
    if (!worker || worker.userId !== userId || worker.status !== "archived")
      throw new Error("Workspace is unavailable for offline backup");
    const storage = useStorageManager();
    const containerName = useContainerManager().buildContainerName(id);
    const workspaceSource =
      storage.mode === "directory"
        ? join(storage.dataRef, "users", userId, "workspaces", id)
        : `${containerName}-workspace`;
    const agentsSource =
      storage.mode === "directory"
        ? join(storage.dataRef, "users", userId, "agents", id)
        : `${containerName}-agents`;
    const image = `${useConfig().workerImagePrefix}${useConfig().workerImage}`;
    await useDockerService().ensureImage(image);
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    if (storage.mode === "directory") {
      for (const source of [workspaceSource, agentsSource]) {
        const info = await lstat(source);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error(
            "Archived workspace storage is unsafe or unavailable",
          );
      }
    } else {
      await Promise.all([
        docker.getVolume(workspaceSource).inspect(),
        docker.getVolume(agentsSource).inspect(),
      ]);
    }
    const helperOptions: Docker.ContainerCreateOptions = {
      Image: image,
      Entrypoint: ["tail"],
      Cmd: ["-f", "/dev/null"],
      User: "1000:1000",
      Labels: {
        "agentor.storage-helper": "backup",
        "agentor.workspace-id": id,
      },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Mounts: [
          {
            Type: storage.mode === "volume" ? "volume" : "bind",
            Source: workspaceSource,
            Target: "/workspace",
            ReadOnly: true,
            ...(storage.mode === "volume"
              ? { VolumeOptions: { NoCopy: true } }
              : {}),
          },
          {
            Type: storage.mode === "volume" ? "volume" : "bind",
            Source: agentsSource,
            Target: "/home/agent/.agent-data",
            ReadOnly: true,
            ...(storage.mode === "volume"
              ? { VolumeOptions: { NoCopy: true } }
              : {}),
          },
        ] as any,
        PidsLimit: 32,
        Memory: 256 * 1024 * 1024,
        NanoCpus: 500_000_000,
        Init: true,
        LogConfig: { Type: "none", Config: {} },
        Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16777216" },
      },
    };
    let helper = await docker.createContainer(helperOptions);
    const temp = join(this.dataDir, "tmp", `offline-backup-${randomUUID()}`);
    try {
      await mkdir(temp, { recursive: true, mode: 0o700 });
      try {
        await helper.start();
      } catch (error) {
        await helper.remove({ force: true }).catch(() => {});
        // See workspace-access.ts: retain the security boundary but tolerate
        // DinD's threaded-cgroup limitation for optional resource ceilings.
        if (!isThreadedCgroupLimitError(error)) throw error;
        const { PidsLimit, Memory, NanoCpus, ...fallbackHostConfig } =
          helperOptions.HostConfig!;
        helper = await docker.createContainer({
          ...helperOptions,
          HostConfig: fallbackHostConfig,
        });
        await helper.start();
      }
      signal.throwIfAborted();
      const environment =
        useEnvironmentStore().getById(worker.environmentId || "default") ??
        useEnvironmentStore().list()[0];
      if (!environment) throw new Error("Workspace environment is unavailable");
      const pluginConfiguration = snapshotWorkerPlugins(
        userId,
        id,
        usePluginDefinitionStore(),
        usePluginInstallationStore(),
      );
      const hasPlugins =
        pluginConfiguration.definitions.length > 0 ||
        pluginConfiguration.installations.length > 0;
      const catalog = useImageCatalogManager();
      await catalog.init();
      const imageDefinition = worker.imageDefinitionId
        ? catalog
            .list(userId, false)
            .find((item) => item.id === worker.imageDefinitionId)
        : undefined;
      const manifest: WorkerExportManifest = {
        version: WORKER_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        source: {
          id,
          displayName: worker.displayName,
          containerName,
          imageName: worker.imageRuntimeReference || image,
        },
        worker: {
          displayName: worker.displayName,
          repos: worker.repos ?? [],
          mounts: worker.mounts ?? [],
          initScript: worker.initScript ?? "",
        },
        environment: { ...environment, envVars: "" },
        portMappings: usePortMappingStore()
          .list()
          .filter((entry) => entry.containerName === containerName)
          .map(({ externalPort, type, internalPort, appType, instanceId }) => ({
            externalPort,
            type,
            internalPort,
            appType,
            instanceId,
          })),
        domainMappings: useDomainMappingStore()
          .list()
          .filter((entry) => entry.containerName === containerName)
          .map(
            ({
              subdomain,
              baseDomain,
              path,
              protocol,
              wildcard,
              internalPort,
            }) => ({
              subdomain,
              baseDomain,
              path,
              protocol,
              wildcard,
              internalPort,
            }),
          ),
        contents: {
          rootfs: false,
          workspace: includeWorkspace,
          agents: includeAgents,
          ...(hasPlugins ? { plugins: true } : {}),
          reconstruction: true,
        },
        missingSecrets: (await useWorkerConfigStore().resolveValues(userId, id))
          .filter((entry) => entry.kind !== "variable")
          .map((entry) => entry.key),
      };
      const manifestPath = join(temp, BUNDLE_FILES.manifest),
        workspacePath = join(temp, BUNDLE_FILES.workspace),
        agentsPath = join(temp, BUNDLE_FILES.agents),
        pluginsPath = join(temp, BUNDLE_FILES.plugins),
        reconstructionPath = join(temp, BUNDLE_FILES.reconstruction);
      await writeManifest(manifest, manifestPath);
      const reconstruction = snapshotWorkerReconstruction(
        worker,
        imageDefinition,
      );
      reconstruction.requiredSecretNames = manifest.missingSecrets ?? [];
      await writeWorkerReconstruction(reconstructionPath, reconstruction);
      if (hasPlugins)
        await writePortablePluginConfiguration(
          pluginsPath,
          pluginConfiguration,
        );
      if (includeWorkspace)
        await writeGzipFile(
          await useDockerService().getArchive(helper.id, EXPORT_WORKSPACE_PATH),
          workspacePath,
          signal,
        );
      if (includeAgents)
        await writeFilteredAgentsGz(
          await useDockerService().getArchive(helper.id, EXPORT_AGENTS_PATH),
          agentsPath,
          CREDENTIAL_EXCLUDE_SUFFIXES,
          SHARED_DATA_EXCLUDE_PREFIXES,
          signal,
        );
      await pipeline(
        packBundle([
          { name: BUNDLE_FILES.manifest, path: manifestPath },
          ...(includeWorkspace
            ? [{ name: BUNDLE_FILES.workspace, path: workspacePath }]
            : []),
          ...(includeAgents
            ? [{ name: BUNDLE_FILES.agents, path: agentsPath }]
            : []),
          ...(hasPlugins
            ? [{ name: BUNDLE_FILES.plugins, path: pluginsPath }]
            : []),
          {
            name: BUNDLE_FILES.reconstruction,
            path: reconstructionPath,
          },
        ]),
        createWriteStream(destination, { mode: 0o600 }),
        { signal },
      );
    } finally {
      await helper.remove({ force: true }).catch(() => {});
      await rm(temp, { recursive: true, force: true });
    }
  }
  /** Repackage an ordinary portable worker bundle with separately archived
   * explicit absolute paths. The ordinary workspace/agent payload is kept
   * byte-for-byte and old bundles continue to omit this optional member. */
  private async appendExplicitBackupPaths(destination: string, containerId: string, paths: string[], signal: AbortSignal) {
    const dir = `${destination}.paths-${randomUUID()}`;
    const unpacked = join(dir, "bundle");
    const replacement = `${destination}.new-${randomUUID()}`;
    try {
      await mkdir(unpacked, { recursive: true, mode: 0o700 });
      const extracted = await extractBundle(destination, unpacked);
      const manifest = extracted.manifest;
      const archives: Array<{ path: string; archive: string; file: string }> = [];
      for (const [index, selected] of paths.entries()) {
        signal.throwIfAborted();
        const file = join(dir, `${index}.tar`);
        await pipeline(await useDockerService().getArchive(containerId, selected), createWriteStream(file, { mode: 0o600 }), { signal });
        const sanitized = join(dir, `${index}.sanitized.tar`);
        await sanitizeBackupPathTarPayload(file, sanitized, selected, signal);
        await rm(file, { force: true });
        archives.push({ path: selected, archive: `paths/${index}.tar`, file: sanitized });
      }
      const payload = join(dir, BUNDLE_FILES.backupPaths);
      const pack = tar.pack();
      const writing = pipeline(pack, createGzip(), createWriteStream(payload, { mode: 0o600 }), { signal });
      for (const archive of archives) {
        const size = (await stat(archive.file)).size;
        await new Promise<void>((resolve, reject) => {
          const entry = pack.entry({ name: archive.archive, size, mode: 0o600 }, (error) => error ? reject(error) : resolve());
          createReadStream(archive.file).pipe(entry);
        });
      }
      pack.finalize(); await writing;
      manifest.version = WORKER_EXPORT_VERSION;
      manifest.contents.backupPaths = true;
      manifest.backupPaths = archives.map(({ path, archive }) => ({ path, archive }));
      const manifestPath = join(dir, BUNDLE_FILES.manifest);
      await writeManifest(manifest, manifestPath);
      const files = [
        { name: BUNDLE_FILES.manifest, path: manifestPath },
        ...(extracted.rootfsPath ? [{ name: BUNDLE_FILES.rootfs, path: extracted.rootfsPath }] : []),
        ...(extracted.workspacePath ? [{ name: BUNDLE_FILES.workspace, path: extracted.workspacePath }] : []),
        ...(extracted.agentsPath ? [{ name: BUNDLE_FILES.agents, path: extracted.agentsPath }] : []),
        ...(extracted.pluginConfigurationPath
          ? [
              {
                name: BUNDLE_FILES.plugins,
                path: extracted.pluginConfigurationPath,
              },
            ]
          : []),
        ...(extracted.reconstructionPath
          ? [
              {
                name: BUNDLE_FILES.reconstruction,
                path: extracted.reconstructionPath,
              },
            ]
          : []),
        { name: BUNDLE_FILES.backupPaths, path: payload },
      ];
      await pipeline(packBundle(files), createWriteStream(replacement, { mode: 0o600 }), { signal });
      await rename(replacement, destination);
    } finally {
      // `rename` removes this pathname on success. On failure/abort, remove
      // the partial sibling as well as the private staging directory so a
      // repeated backup cannot strand a large, misleading `.new` artifact.
      await rm(replacement, { force: true }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async runV2(job: BackupJob) {
    const started = Date.now(),
      dir = join(this.dataDir, "tmp", `backup-${job.id}`);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const cancelled = () =>
      job.status === "cancelled" ||
      this.cancelledJobs.has(job.id) ||
      controller.signal.aborted;
    let pendingArtifactId: string | undefined;
    let interruptedUploadId: string | undefined;
    let keepForResume = false;
    let resumableState:
      { artifactId: string; sha256: string; size: number } | undefined;
    try {
      if (cancelled()) return;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (cancelled()) return;
      const encrypted = join(dir, "archive.enc");
      const resumePath = join(dir, "resume.json");
      const resume = await readInterruptedBackupResume(this.dataDir, job.id);
      let crypt: { sha256: string; size: number };
      let artifactId: string;
      let resumeUploadId: string | undefined;
      let encryptionMetadata: {
        createdAt: string;
        sourceInstallationId: string;
        workspaceIds: string[];
        keyFingerprint?: string;
        formatVersion: 1 | 2;
      };
      job.status = "running";
      job.operation ||= "backup";
      job.startedAt ||= new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      await this.recordAttempt(job.userId);
      if (cancelled()) return;
      if (resume) {
        crypt = { sha256: resume.sha256, size: resume.size };
        artifactId = resume.artifactId;
        resumeUploadId = resume.uploadId;
        try {
          const resumedHeader = await inspectBackupV2(encrypted);
          encryptionMetadata = {
            createdAt:
              safeRemoteTimestamp(resumedHeader.metadata.createdAt) ??
              new Date().toISOString(),
            sourceInstallationId:
              resumedHeader.metadata.sourceInstallationId ??
              (await backupInstallationId(this.dataDir)),
            workspaceIds:
              resumedHeader.metadata.workspaceIds ??
              job.workspaceIds ??
              [job.workspaceId],
            keyFingerprint: resumedHeader.keyFingerprint,
            formatVersion: 2,
          };
        } catch {
          // Interrupted uploads from pre-v2 Agentor installations retain the
          // exact v1 ciphertext required by provider resumable sessions. Keep
          // those jobs retryable instead of replacing their upload bytes.
          if ((await encryptedBackupPayloadSha256(encrypted)) !== resume.sha256)
            throw new Error("Interrupted backup ciphertext is invalid");
          const legacy = (await this.keyring.status(job.userId)).find(
            ({ source }) => source === "legacy",
          );
          encryptionMetadata = {
            createdAt: new Date().toISOString(),
            sourceInstallationId: await backupInstallationId(this.dataDir),
            workspaceIds: job.workspaceIds ?? [job.workspaceId],
            ...(legacy ? { keyFingerprint: legacy.fingerprint } : {}),
            formatVersion: 1,
          };
        }
        job.phase = "uploading";
        job.progress = 60;
        await this.saveJob(job);
      } else {
        job.phase = "exporting";
        await this.saveJob(job);
        const exports: Array<{ id: string; path: string }> = [];
        for (const id of job.workspaceIds ?? [job.workspaceId]) {
          if (cancelled()) return;
          const path = join(dir, `${id}.worker.tar`);
          await this.exportWorkspaceBundle(
            job.userId,
            id,
            path,
            controller.signal,
            job.selectedPathsByWorkspace?.[id],
          );
          exports.push({ id, path });
        }
        const plain = join(dir, "bundle.tar");
        await packWorkspaceBackups(exports, plain);
        if (cancelled()) return;
        job.phase = "encrypting";
        job.progress = 35;
        await this.saveJob(job);
        artifactId = randomUUID();
        const createdAt = new Date().toISOString();
        const sourceInstallationId = await backupInstallationId(this.dataDir);
        const encryptedV2 = await encryptBackupV2(
          { ...useConfig(), dataDir: this.dataDir },
          job.userId,
          plain,
          encrypted,
          {
            backupId: artifactId,
            sourceInstallationId,
            createdAt,
            workspaceIds: job.workspaceIds ?? [job.workspaceId],
            formatVersion: 2,
          },
          this.keyring,
          (bytes: number) => {
            job.bytesProcessed = bytes;
          },
        );
        crypt = encryptedV2;
        encryptionMetadata = {
          createdAt,
          sourceInstallationId,
          workspaceIds: job.workspaceIds ?? [job.workspaceId],
          keyFingerprint: encryptedV2.header.keyFingerprint,
          formatVersion: 2,
        };
      }
      if (cancelled()) return;
      job.phase = "uploading";
      job.progress = 60;
      await this.saveJob(job);
      // The stable Agentor artifact id is persisted before upload. Providers
      // with opaque object ids can reconcile it through object metadata if the
      // process dies after remote commit but before the actual id is saved.
      pendingArtifactId = artifactId;
      job.pendingProviderObjectId = artifactId;
      job.pendingProviderArtifactId = artifactId;
      await this.saveJob(job);
      resumableState = { artifactId, sha256: crypt.sha256, size: crypt.size };
      const uploaded = await this.providers.get(job.provider)!.upload(
        job.userId,
        artifactId,
        encrypted,
        (bytes) => {
          job.bytesProcessed = bytes;
        },
        controller.signal,
        resumeUploadId,
        {
          artifactId,
          formatVersion: encryptionMetadata.formatVersion,
          ...(encryptionMetadata.keyFingerprint
            ? { keyFingerprint: encryptionMetadata.keyFingerprint }
            : {}),
          integritySha256: crypt.sha256,
          createdAt: encryptionMetadata.createdAt,
          incomplete: false,
        },
      );
      // Persist the provider's authoritative object id before verification so
      // cancellation or verification failure never deletes an Agentor UUID in
      // place of an opaque provider object.
      pendingArtifactId = recordUploadedProviderObject(job, uploaded.objectId);
      await this.saveJob(job);
      if (cancelled()) {
        await this.deletePendingProviderObject(job, uploaded.objectId).catch(
          () => {},
        );
        return;
      }
      job.providerUploadId = uploaded.uploadId;
      job.resumedFromChunk = Math.max(
        job.resumedFromChunk ?? 0,
        uploaded.resumedFromChunk,
      );
      job.phase = "verifying";
      job.progress = 90;
      await this.saveJob(job);
      const verifyEnc = join(dir, "verify.enc"),
        verifyPlain = join(dir, "verify.tar");
      await this.providers
        .get(job.provider)!
        .download(job.userId, uploaded.objectId, verifyEnc, controller.signal, {
          expectedSize: uploaded.size,
          maxBytes: MAX_BACKUP_PROVIDER_OBJECT_BYTES,
        });
      if (encryptionMetadata.formatVersion === 2)
        await decryptBackupV2(
          { ...useConfig(), dataDir: this.dataDir },
          job.userId,
          verifyEnc,
          verifyPlain,
          crypt.sha256,
          this.keyring,
        );
      else
        await decryptBackup(
          { ...useConfig(), dataDir: this.dataDir },
          verifyEnc,
          verifyPlain,
          crypt.sha256,
        );
      if (cancelled()) {
        await this.deletePendingProviderObject(job, uploaded.objectId).catch(
          () => {},
        );
        return;
      }
      const inspected = await inspectWorkspaceBackups(
        verifyPlain,
        join(dir, "inspection"),
      );
      const actualWorkspaceIds = inspected.workspaces.map(({ id }) => id);
      if (
        encryptionMetadata.workspaceIds.length !== actualWorkspaceIds.length ||
        encryptionMetadata.workspaceIds.some(
          (id) => !actualWorkspaceIds.includes(id),
        )
      )
        throw Object.assign(
          new Error(
            "The authenticated backup summary does not match the contained workspaces.",
          ),
          { code: "BACKUP_MANIFEST_MISMATCH" },
        );
      const inspection = await this.summarizeArtifactInspection(
        job.userId,
        inspected,
      );
      const missing = new Set<string>(inspection.missingSecrets);
      for (const id of job.workspaceIds ?? [job.workspaceId])
        for (const entry of (await useWorkerConfigStore().get(job.userId, id))
          ?.entries ?? [])
          if (entry.kind !== "variable") missing.add(entry.key);
      const artifact: BackupArtifact = {
        schemaVersion: 1,
        id: artifactId,
        userId: job.userId,
        workspaceId: job.workspaceId,
        workspaceIds: job.workspaceIds,
        provider: job.provider,
        providerObjectId: uploaded.objectId,
        createdAt: encryptionMetadata.createdAt,
        size: uploaded.size,
        sha256: crypt.sha256,
        sourceWorkerId: job.workspaceId,
        missingSecrets: [...missing],
        selectedPathsByWorkspace:
          Object.keys(inspection.selectedPathsByWorkspace).length > 0
            ? inspection.selectedPathsByWorkspace
            : job.selectedPathsByWorkspace,
        formatVersion: encryptionMetadata.formatVersion,
        ...(encryptionMetadata.keyFingerprint
          ? { keyFingerprint: encryptionMetadata.keyFingerprint }
          : {}),
        sourceInstallationId: encryptionMetadata.sourceInstallationId,
        integrityStatus: "verified",
        provenance: "local",
        workspaceMembers: inspection.summaries.map(
          ({ workspaceId: id, displayName }) =>
            displayName ? { id, displayName } : { id },
        ),
        reconstruction: inspection.summaries,
        dependencies: inspection.dependencies,
      };
      job.dependencies = inspection.dependencies;
      job.status = "succeeded";
      job.phase = "complete";
      job.progress = 100;
      job.artifactId = job.backupId = artifact.id;
      job.size = job.sizeBytes = artifact.size;
      job.sha256 = artifact.sha256;
      job.encrypted = true;
      job.integrityVerified = true;
      job.completedAt = job.updatedAt = new Date().toISOString();
      job.durationMs = Date.now() - started;
      if (!(await this.commitCompletedBackup(job, artifact))) return;
      pendingArtifactId = undefined;
      await this.applyRetention(job.userId);
    } catch (error: any) {
      if (typeof error?.uploadId === "string")
        interruptedUploadId = error.uploadId;
      if (!cancelled()) {
        if (resumableState && typeof error?.uploadId === "string") {
          await writeFile(
            join(dir, "resume.json"),
            JSON.stringify({ ...resumableState, uploadId: error.uploadId }),
            { mode: 0o600 },
          );
          keepForResume = true;
          pendingArtifactId = undefined;
          // This transfer is intentionally retained for same-ciphertext
          // resume, not pending deletion. The resume file now owns the remote
          // artifact/upload identifiers until retry or stale-staging cleanup.
          job.pendingProviderObjectId = undefined;
          job.pendingProviderArtifactId = undefined;
        }
        job.status = "failed";
        job.phase = "failed";
        const failure = publicBackupFailure(error);
        job.error = failure.message;
        job.errorCode = failure.code;
        job.providerStatus = failure.providerStatus;
        job.retryable = failure.retryable;
        job.completedAt = job.updatedAt = new Date().toISOString();
        job.durationMs = Date.now() - started;
        await this.commitFailedJob(job);
        useLogger().error(
          `[backup] job ${job.id} failed (${failure.code}${failure.providerStatus ? `, HTTP ${failure.providerStatus}` : ""})`,
        );
      }
    } finally {
      const cleanupFailures: string[] = [];
      const attemptCleanup = async (
        label: string,
        operation: () => Promise<void>,
      ) => {
        try {
          await operation();
        } catch (error) {
          cleanupFailures.push(
            `${label}: ${error instanceof Error ? error.message : error}`,
          );
        }
      };
      if (
        cancelled() &&
        interruptedUploadId
      ) {
        job.pendingProviderUploadId = interruptedUploadId;
        await attemptCleanup("persist upload-abort marker", () =>
          this.saveJob(job),
        );
        await attemptCleanup("abort provider upload", () =>
          this.abortPendingProviderUpload(job),
        );
      }
      if (pendingArtifactId)
        await attemptCleanup("delete pending provider object", () =>
          this.deletePendingProviderObject(job, pendingArtifactId!),
        );
      this.controllers.delete(job.id);
      if (!keepForResume)
        await attemptCleanup("remove backup staging", () =>
          rm(dir, { recursive: true, force: true }),
        );
      if (cleanupFailures.length)
        useLogger().warn(
          `[backup] job ${job.id} cleanup incomplete: ${cleanupFailures.join("; ")}`,
        );
    }
  }
  private async runRestoreV2(
    job: BackupJob,
    artifact: BackupArtifact,
    displayName?: string,
    restorePinOwner = this.restorePinOwner(job.id, job.attempt),
  ) {
    const dir = join(this.dataDir, "tmp", `restore-${job.id}`);
    const createdWorkers: string[] = [];
    const execution = this.beginRestoreExecution(job.userId, job.id);
    const assertActive = () => {
      this.assertRestoreActive(job.userId, execution.controller.signal, job);
    };
    try {
      assertActive();
      await this.prepareRestoreDirectory(dir);
      assertActive();
      job.status = "running";
      job.operation ||= "restore";
      job.phase = "downloading";
      job.progress = 20;
      job.startedAt ||= new Date().toISOString();
      appendBackupJobLog(job, "Downloading the adopted backup artifact.");
      await this.saveJob(job);
      const enc = join(dir, "archive.enc"),
        plain = join(dir, "bundle.tar");
      await this.providers
        .get(artifact.provider)!
        .download(
          job.userId,
          artifact.providerObjectId,
          enc,
          execution.controller.signal,
          {
            expectedSize: artifact.size,
            maxBytes: MAX_BACKUP_PROVIDER_OBJECT_BYTES,
          },
        );
      assertActive();
      job.phase = "verifying";
      job.progress = 55;
      appendBackupJobLog(
        job,
        "Authenticating the encrypted archive and validating the selected workspace bundles.",
      );
      await this.saveJob(job);
      await this.decryptArtifact(job.userId, artifact, enc, plain);
      assertActive();
      job.integrityVerified = true;
      const artifactWorkspaceIds =
        job.artifactWorkspaceIds ?? this.artifactWorkspaceIds(artifact);
      const selectedWorkspaceIds =
        job.selectedWorkspaceIds ?? job.workspaceIds ?? artifactWorkspaceIds;
      const bundles = await unpackWorkspaceBackups(
        plain,
        artifactWorkspaceIds,
        selectedWorkspaceIds,
        join(dir, "workspaces"),
      );
      assertActive();
      if (job.target === "new") {
        job.phase = "restoring-workers";
        job.progress = 70;
        job.restoreMappings = [];
        await this.saveJob(job);
        for (const [index, bundle] of bundles.entries()) {
          assertActive();
          const resolution = job.imageResolutions?.[bundle.id];
          const imageResolution =
            resolution?.mode === "replacement"
              ? {
                  mode: "replacement" as const,
                  imageDefinitionId: resolution.imageDefinitionId,
                  imageVersion: resolution.imageVersion,
                }
              : resolution?.mode === "workspace-only"
                ? { mode: "workspace-only" as const }
                : undefined;
          const worker = await useContainerManager().importWorker(
            job.userId,
            bundle.path,
            {
              displayName: index === 0 ? displayName : undefined,
              ...(imageResolution ? { imageResolution } : {}),
            },
          );
          createdWorkers.push(worker.id);
          job.restoreMappings.push({
            sourceWorkspaceId: bundle.id,
            workerId: worker.id,
          });
          job.progress = Math.min(
            95,
            70 + Math.round((createdWorkers.length / bundles.length) * 25),
          );
          appendBackupJobLog(
            job,
            `Restored source workspace ${bundle.id} as worker ${worker.id}.`,
          );
          await this.saveJob(job);
          assertActive();
        }
        job.workerId = createdWorkers[0];
        (job as BackupJob & { workerIds?: string[] }).workerIds =
          createdWorkers;
      } else {
        const source = selectedWorkspaceIds[0]!;
        const selected = bundles.find((b) => b.id === source);
        if (!selected)
          throw new Error("Original workspace is absent from backup");
        const extracted = await extractBundle(
          selected.path,
          join(dir, "original"),
        );
        if (!extracted.workspacePath)
          throw new Error("Backup workspace payload is missing");
        assertActive();
        await replaceStoppedWorkspace(
          job.userId,
          source,
          extracted.workspacePath,
        );
        job.workerId = source;
        job.restoreMappings = [
          { sourceWorkspaceId: source, workerId: source },
        ];
      }
      job.missingSecrets = artifact.missingSecrets.map((name) => ({
        name,
        type: "secret",
      }));
      job.status = "succeeded";
      job.phase = "complete";
      job.progress = 100;
      job.completedAt = job.updatedAt = new Date().toISOString();
      appendBackupJobLog(
        job,
        `Restore completed for ${job.restoreMappings?.length ?? 0} workspace(s).`,
      );
      await this.saveJob(job);
    } catch (error) {
      const survivingWorkers = await rollbackRestoredWorkers(createdWorkers);
      if (survivingWorkers.length) {
        job.status = "failed";
        job.phase = "rollback-failed";
        job.workerId = survivingWorkers[0];
        job.workerIds = survivingWorkers;
        job.error =
          "Restore failed and some newly created workers require manual cleanup.";
        job.errorCode = "RESTORE_ROLLBACK_FAILED";
      } else if (
        job.status !== "cancelled" &&
        !this.cancelledJobs.has(job.id)
      ) {
        job.status = "failed";
        job.phase = "failed";
        job.workerId = undefined;
        job.workerIds = undefined;
        job.error = "Restore failed. No secret values were restored.";
        job.errorCode = safeBackupErrorCode(error, "BACKUP_RESTORE_FAILED");
      } else {
        job.status = "cancelled";
        job.phase = "cancelled";
      }
      job.completedAt = job.updatedAt = new Date().toISOString();
      appendBackupJobLog(
        job,
        job.status === "cancelled"
          ? "Restore cancelled."
          : "Restore failed; the adopted backup record remains available for retry.",
      );
      await this.saveJob(job);
      if (job.status === "failed")
        useLogger().error(`[backup] restore job ${job.id} failed`);
    } finally {
      try {
        await rm(dir, { recursive: true, force: true });
      } finally {
        this.releaseRestoreArtifactPin(restorePinOwner);
        execution.finish();
      }
    }
  }
  async deleteArtifact(artifact: BackupArtifact) {
    await this.init();
    this.assertOwnerAvailable(artifact.userId);
    const currentArtifact = this.store.findArtifact(artifact.id);
    if (
      !currentArtifact ||
      currentArtifact.userId !== artifact.userId ||
      currentArtifact.providerObjectId !== artifact.providerObjectId
    )
      throw Object.assign(new Error("Backup artifact not found"), {
        statusCode: 404,
      });
    artifact = currentArtifact;
    if (!this.beginArtifactDeletion(artifact))
      throw Object.assign(
        new Error("Backup artifact is in use by a restore job"),
        { statusCode: 409 },
      );
    try {
      await this.store.update(artifact.userId, (data) => {
        const current = data.artifacts.find(
          (candidate) => candidate.id === artifact.id,
        );
        if (!current) throw new Error("Backup artifact not found");
        current.deletionPending = true;
        current.deletionErrorAt = undefined;
      });
      await this.runProviderCleanup("backup artifact deletion", (signal) =>
        this.providers
          .get(artifact.provider)!
          .delete(artifact.userId, artifact.providerObjectId, signal),
      );
      await this.store.update(artifact.userId, (data) => {
        data.artifacts = data.artifacts.filter((x) => x.id !== artifact.id);
      });
    } catch (error) {
      await this.store
        .update(artifact.userId, (data) => {
          const current = data.artifacts.find((x) => x.id === artifact.id);
          if (!current) return;
          current.deletionPending = true;
          current.deletionErrorAt = new Date().toISOString();
        })
        .catch(() => {});
      throw error;
    } finally {
      this.endArtifactDeletion(artifact);
    }
  }
  async beginGoogleOAuth(
    userId: string,
    clientId: string,
    redirectUri: string,
  ) {
    await this.init();
    this.assertOwnerAvailable(userId);
    const state = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    await this.store.update(userId, (data) => {
      data.config ??= {
        schemaVersion: 1,
        userId,
        provider: "google-drive",
        enabled: false,
        intervalMinutes: 1440,
        retentionCount: 7,
        selectedWorkspaceIds: null,
        createdAt: now,
        updatedAt: now,
      };
      data.config.google = {
        ...data.config.google,
        clientId,
        redirectUri,
        oauthPending: {
          stateHash: createHash("sha256").update(state).digest("hex"),
          expiresAt: Date.now() + 10 * 60_000,
        },
      };
    });
    return { state };
  }
  async completeGoogleOAuth(userId: string, state: string, code: string) {
    await this.init();
    this.assertOwnerAvailable(userId);
    const data = this.store.get(userId);
    const pending = data.config?.google?.oauthPending;
    const actual = Buffer.from(
      createHash("sha256").update(state).digest("hex"),
    );
    const expected = Buffer.from(String(pending?.stateHash || ""));
    if (
      !pending ||
      pending.expiresAt < Date.now() ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new Error("Invalid or expired OAuth state");
    const google = data.config!.google!;
    let token: GoogleDriveToken;
    const fakeAllowed =
      this.fakeUsers.has(userId) &&
      (process.env.NODE_ENV !== "production" ||
        process.env.ALLOW_FAKE_BACKUP_PROVIDER === "true");
    if (fakeAllowed && code === "fake-test-code") {
      token = {
        access_token: "test-only",
        refresh_token: "test-only",
        expires_at: Date.now() + 3600_000,
      };
    } else {
      const credentials = await useGoogleBackupOAuthConfigStore().credentials();
      if (!google.clientId || !credentials?.clientSecret || !google.redirectUri)
        throw new Error("Google Drive backup OAuth is not configured");
      let previousToken: GoogleDriveToken | undefined;
      if (google.token) {
        previousToken = JSON.parse(
          await decryptWorkerValue(
            useConfig(),
            google.token as EncryptedWorkerValue,
            `backup-google\0${userId}`,
          ),
        ) as GoogleDriveToken;
      }
      token = await exchangeGoogleAuthorizationCode({
        code,
        clientId: google.clientId,
        clientSecret: credentials.clientSecret,
        redirectUri: google.redirectUri,
        previousToken,
      });
    }
    const encryptedToken = await encryptWorkerValue(
      useConfig(),
      JSON.stringify(token),
      `backup-google\0${userId}`,
    );
    this.assertOwnerAvailable(userId);
    const config = await this.store.update(userId, (currentData) => {
      const currentPending = currentData.config?.google?.oauthPending;
      if (!currentPending || currentPending.stateHash !== pending.stateHash)
        throw new Error("OAuth state was replaced before completion");
      currentData.config!.google!.token = encryptedToken;
      currentData.config!.provider = "google-drive";
      currentData.config!.google!.oauthPending = undefined;
      currentData.config!.updatedAt = new Date().toISOString();
      return structuredClone(currentData.config!);
    });
    return sanitizeConfig(config);
  }
  private async loadGoogleToken(userId: string): Promise<GoogleDriveToken> {
    const encrypted = this.store.get(userId).config?.google?.token as
      EncryptedWorkerValue | undefined;
    if (!encrypted)
      throw new Error("Google Drive backup account is not linked");
    return JSON.parse(
      await decryptWorkerValue(
        useConfig(),
        encrypted,
        `backup-google\0${userId}`,
      ),
    ) as GoogleDriveToken;
  }
  private async saveGoogleToken(userId: string, token: GoogleDriveToken) {
    this.assertOwnerAvailable(userId);
    const encryptedToken = await encryptWorkerValue(
      useConfig(),
      JSON.stringify(token),
      `backup-google\0${userId}`,
    );
    this.assertOwnerAvailable(userId);
    await this.store.update(userId, (data) => {
      if (!data.config?.google)
        throw new Error("Google Drive backup account is not linked");
      data.config.google.token = encryptedToken;
      data.config.updatedAt = new Date().toISOString();
    });
  }
  private async run(job: BackupJob) {
    const started = Date.now();
    const dir = join(this.dataDir, "tmp", `backup-${job.id}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      job.status = "running";
      job.phase = "exporting";
      job.startedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
      const worker = useContainerManager().get(job.workspaceId);
      if (
        !worker ||
        worker.userId !== job.userId ||
        !["running", "stopped"].includes(worker.status)
      )
        throw new Error("Workspace worker must be running or stopped");
      const bundle = await useContainerManager().exportWorker(job.workspaceId, {
        includeRootfs: false,
      });
      const plain = join(dir, "worker.tar");
      await pipeline(bundle.stream, createWriteStream(plain, { mode: 0o600 }));
      job.phase = "encrypting";
      job.progress = 35;
      await this.saveJob(job);
      const encrypted = join(dir, "archive.enc");
      const crypt = await encryptBackup(
        useConfig(),
        plain,
        encrypted,
        (bytes) => {
          job.bytesProcessed = bytes;
        },
      );
      job.phase = "uploading";
      job.progress = 60;
      await this.saveJob(job);
      const artifactId = randomUUID();
      const uploaded = await this.providers
        .get(job.provider)!
        .upload(job.userId, artifactId, encrypted, (bytes) => {
          job.bytesProcessed = bytes;
        });
      job.providerUploadId = uploaded.uploadId;
      job.resumedFromChunk = Math.max(
        job.resumedFromChunk ?? 0,
        uploaded.resumedFromChunk,
      );
      job.phase = "verifying";
      job.progress = 90;
      await this.saveJob(job);
      const verifyEnc = join(dir, "verify.enc"),
        verifyPlain = join(dir, "verify.tar");
      await this.providers
        .get(job.provider)!
        .download(job.userId, uploaded.objectId, verifyEnc, undefined, {
          expectedSize: uploaded.size,
          maxBytes: MAX_BACKUP_PROVIDER_OBJECT_BYTES,
        });
      await decryptBackup(useConfig(), verifyEnc, verifyPlain, crypt.sha256);
      const missing =
        (await useWorkerConfigStore().get(job.userId, job.workspaceId))?.entries
          .filter((x) => x.kind !== "variable")
          .map((x) => x.key) ?? [];
      const artifact: BackupArtifact = {
        schemaVersion: 1,
        id: artifactId,
        userId: job.userId,
        workspaceId: job.workspaceId,
        workspaceIds: job.workspaceIds,
        provider: job.provider,
        providerObjectId: uploaded.objectId,
        createdAt: new Date().toISOString(),
        size: uploaded.size,
        sha256: crypt.sha256,
        sourceWorkerId: job.workspaceId,
        missingSecrets: missing,
        selectedPathsByWorkspace: job.selectedPathsByWorkspace,
      };
      job.status = "succeeded";
      job.phase = "complete";
      job.progress = 100;
      job.artifactId = artifact.id;
      job.backupId = artifact.id;
      job.size = artifact.size;
      job.sizeBytes = artifact.size;
      job.sha256 = artifact.sha256;
      job.encrypted = true;
      job.integrityVerified = true;
      job.completedAt = job.updatedAt = new Date().toISOString();
      job.durationMs = Date.now() - started;
      await this.store.update(job.userId, (data) => {
        if (!data.artifacts.some((candidate) => candidate.id === artifact.id))
          data.artifacts.push(structuredClone(artifact));
        const index = data.jobs.findIndex(
          (candidate) => candidate.id === job.id,
        );
        if (index >= 0) data.jobs[index] = structuredClone(job);
      });
      await this.applyRetention(job.userId);
    } catch (err) {
      job.error = safeError(err);
      job.durationMs = Date.now() - started;
      job.status = "failed";
      job.phase = "failed";
      job.completedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
      useLogger().error(`[backup] job ${job.id} failed`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  private async saveJob(job: BackupJob) {
    if (this.forgottenUsers.has(job.userId)) return;
    await this.store.update(job.userId, (data) => {
      const i = data.jobs.findIndex((x) => x.id === job.id);
      if (i < 0) return;
      const current = data.jobs[i]!;
      // Cancellation is an absorbing durable state. An admitted execution may
      // still hold a stale queued/running snapshot when cancellation wins the
      // store race; never let that snapshot resurrect the job. Updating the
      // live object also makes the caller stop at its next cancellation check.
      if (current.status === "cancelled" && job.status !== "cancelled") {
        Object.assign(job, structuredClone(current));
        return;
      }
      data.jobs[i] = structuredClone(job);
    });
  }

  /** Persist terminal failure and its scheduler diagnostics together so a
   * caller cannot observe a failed job before the matching failure state. */
  private async commitFailedJob(job: BackupJob): Promise<void> {
    if (this.forgottenUsers.has(job.userId)) return;
    await this.store.update(job.userId, (data) => {
      const index = data.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index < 0) return;
      const current = data.jobs[index]!;
      if (current.status === "cancelled") {
        Object.assign(job, structuredClone(current));
        return;
      }
      data.jobs[index] = structuredClone(job);
      if (!data.config) return;
      data.config.lastError = job.error;
      data.config.consecutiveFailures =
        (data.config.consecutiveFailures ?? 0) + 1;
      data.config.updatedAt = job.updatedAt;
    });
  }
  private beginRestoreExecution(
    userId: string,
    jobId?: string,
  ): RestoreExecution {
    const controller = new AbortController();
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    let finished = false;
    const execution: RestoreExecution = {
      controller,
      completed,
      jobId,
      finish: () => {
        if (finished) return;
        finished = true;
        if (jobId && this.controllers.get(jobId) === controller)
          this.controllers.delete(jobId);
        const active = this.restoreExecutions.get(userId);
        active?.delete(execution);
        if (active?.size === 0) this.restoreExecutions.delete(userId);
        resolveCompleted();
      },
    };
    const active = this.restoreExecutions.get(userId) ?? new Set();
    active.add(execution);
    this.restoreExecutions.set(userId, active);
    if (jobId) this.controllers.set(jobId, controller);
    if (this.forgottenUsers.has(userId)) controller.abort();
    return execution;
  }
  private async drainRestoreExecutions(
    executions: readonly RestoreExecution[],
  ): Promise<void> {
    if (!executions.length) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(
          executions.map((execution) => execution.completed),
        ).then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error(
                    "Active restores did not stop before the cleanup deadline",
                  ),
                  { code: "RESTORE_CLEANUP_TIMEOUT" },
                ),
              ),
            this.restoreCleanupTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async drainActiveBackupTasks(
    tasks: readonly Promise<void>[],
  ): Promise<void> {
    if (!tasks.length) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(tasks).then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error(
                    "Active backup jobs did not stop before the cleanup deadline",
                  ),
                  { code: "BACKUP_CLEANUP_TIMEOUT" },
                ),
              ),
            this.restoreCleanupTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private assertRestoreActive(
    userId: string,
    signal: AbortSignal,
    job?: BackupJob,
  ): void {
    if (
      signal.aborted ||
      this.forgottenUsers.has(userId) ||
      (job ? this.cancelledJobs.has(job.id) : false) ||
      job?.status === "cancelled"
    )
      throw Object.assign(new Error("Restore cancelled"), {
        name: "AbortError",
      });
  }
  private artifactWorkspaceIds(artifact: BackupArtifact): string[] {
    const ids = artifact.workspaceIds ?? [artifact.workspaceId];
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new Error("Backup artifact has invalid workspace membership");
    return ids;
  }
  private artifactPinKey(artifact: BackupArtifact): string {
    return `${artifact.userId}:${artifact.id}`;
  }
  private pinArtifact(artifact: BackupArtifact): void {
    // A durable deletion tombstone is authoritative across restarts even when
    // the in-memory deletion lock no longer exists. Treat it exactly like a
    // missing artifact so neither legacy restore, durable restore, nor retry
    // can race or resurrect provider data pending deletion.
    if (artifact.deletionPending)
      throw Object.assign(new Error("Backup artifact not found"), {
        statusCode: 404,
      });
    const key = this.artifactPinKey(artifact);
    if (this.artifactDeletions.has(key))
      throw Object.assign(new Error("Backup artifact is being deleted"), {
        statusCode: 409,
      });
    this.restorePins.set(key, (this.restorePins.get(key) ?? 0) + 1);
  }
  private unpinArtifact(artifact: BackupArtifact): void {
    const key = this.artifactPinKey(artifact);
    const remaining = (this.restorePins.get(key) ?? 1) - 1;
    if (remaining > 0) this.restorePins.set(key, remaining);
    else this.restorePins.delete(key);
  }
  private restorePinOwner(jobId: string, attempt: number): string {
    return `${jobId}:${attempt}`;
  }
  private pinRestoreArtifact(pinOwner: string, artifact: BackupArtifact): void {
    const existing = this.restoreJobPins.get(pinOwner);
    if (existing) {
      if (
        this.artifactPinKey(existing.artifact) !== this.artifactPinKey(artifact)
      )
        throw new Error("Restore job pin ownership conflict");
      return;
    }
    this.pinArtifact(artifact);
    this.restoreJobPins.set(pinOwner, { artifact });
  }
  private releaseRestoreArtifactPin(pinOwner: string): void {
    const pin = this.restoreJobPins.get(pinOwner);
    if (!pin) return;
    this.restoreJobPins.delete(pinOwner);
    this.unpinArtifact(pin.artifact);
  }
  private beginArtifactDeletion(artifact: BackupArtifact): boolean {
    const key = this.artifactPinKey(artifact);
    if (this.restorePins.has(key) || this.artifactDeletions.has(key))
      return false;
    this.artifactDeletions.add(key);
    return true;
  }
  private endArtifactDeletion(artifact: BackupArtifact): void {
    this.artifactDeletions.delete(this.artifactPinKey(artifact));
  }
  private selectRestoreWorkspaceIds(
    artifactWorkspaceIds: string[],
    selectedWorkspaceIds?: string[],
  ): string[] {
    if (selectedWorkspaceIds === undefined) return [...artifactWorkspaceIds];
    if (
      !Array.isArray(selectedWorkspaceIds) ||
      !selectedWorkspaceIds.length ||
      new Set(selectedWorkspaceIds).size !== selectedWorkspaceIds.length ||
      selectedWorkspaceIds.some(
        (id) => typeof id !== "string" || !artifactWorkspaceIds.includes(id),
      )
    )
      throw new Error("Select a non-empty subset of backup workspaces");
    return [...selectedWorkspaceIds];
  }
  private async applyRetention(userId: string) {
    const data = this.store.get(userId);
    const keep = data.config?.retentionCount ?? 7;
    const sorted = [...data.artifacts].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    for (const old of sorted.slice(keep)) {
      if (!this.beginArtifactDeletion(old)) continue;
      try {
        await this.store.update(userId, (currentData) => {
          const current = currentData.artifacts.find(
            (candidate) => candidate.id === old.id,
          );
          if (!current) return;
          current.deletionPending = true;
          current.deletionErrorAt = undefined;
        });
        await this.runProviderCleanup("backup retention deletion", (signal) =>
          this.providers
            .get(old.provider)!
            .delete(userId, old.providerObjectId, signal),
        );
        await this.store.update(userId, (currentData) => {
          currentData.artifacts = currentData.artifacts.filter(
            (candidate) => candidate.id !== old.id,
          );
        });
      } catch {
        await this.store
          .update(userId, (currentData) => {
            const current = currentData.artifacts.find(
              (candidate) => candidate.id === old.id,
            );
            if (!current) return;
            current.deletionPending = true;
            current.deletionErrorAt = new Date().toISOString();
          })
          .catch(() => {});
      } finally {
        this.endArtifactDeletion(old);
      }
    }
  }
  private async tickSchedules() {
    await this.retryPendingProviderDeletes();
    const now = Date.now();
    for (const data of this.store.all()) {
      const c = data.config;
      if (!c?.enabled || (c.nextRunAt && Date.parse(c.nextRunAt) > now))
        continue;
      const selected =
        c.selectedWorkspaceIds ??
        useWorkerStore()
          .list()
          .filter((worker) => worker.userId === c.userId)
          .map((worker) => worker.id);
      let scheduleError: string | undefined;
      try {
        await this.createMany(c.userId, selected, undefined, 1, 0, pickSelectedPaths(c.selectedPathsByWorkspace, selected));
      } catch (error) {
        scheduleError = safeError(error);
        useLogger().error(
          `[backup] scheduled backup could not be queued for user ${c.userId}`,
        );
      } finally {
        await this.store.update(c.userId, (currentData) => {
          const current = currentData.config;
          if (!current) return;
          if (scheduleError) {
            current.lastAttemptAt = new Date().toISOString();
            current.lastError = scheduleError;
            current.consecutiveFailures =
              (current.consecutiveFailures ?? 0) + 1;
          }
          current.nextRunAt = new Date(
            now + configIntervalMinutes(current) * 60_000,
          ).toISOString();
          current.updatedAt = new Date().toISOString();
        });
      }
    }
  }

  private triggerScheduleTick(): void {
    if (this.tickInFlight) return;
    this.tickInFlight = this.tickSchedules()
      .catch((error) => {
        useLogger().error(
          `[backup] schedule tick failed: ${error instanceof Error ? error.message : error}`,
        );
      })
      .finally(() => {
        this.tickInFlight = undefined;
      });
  }

  private async commitCompletedBackup(
    job: BackupJob,
    artifact: BackupArtifact,
  ): Promise<boolean> {
    let committed = false;
    await this.store.update(job.userId, (data) => {
      const index = data.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index < 0) return;
      const current = data.jobs[index]!;
      if (current.status === "cancelled") {
        Object.assign(job, structuredClone(current));
        return;
      }
      if (!data.artifacts.some((candidate) => candidate.id === artifact.id))
        data.artifacts.push(structuredClone(artifact));
      const completedJob = structuredClone(job);
      delete completedJob.pendingProviderObjectId;
      delete completedJob.pendingProviderArtifactId;
      data.jobs[index] = completedJob;
      if (data.config) {
        data.config.lastSuccessAt = job.completedAt;
        data.config.lastError = undefined;
        data.config.consecutiveFailures = 0;
      }
      committed = true;
    });
    if (!committed) return false;
    // Retain cleanup handles on the live attempt until the artifact and
    // completed job commit atomically. A rejected commit then still leaves
    // catch/finally able to delete the already-uploaded provider object.
    job.pendingProviderObjectId = undefined;
    job.pendingProviderArtifactId = undefined;
    return true;
  }

  /** Retry every durable provider-object cleanup marker, including failed and
   * cancelled jobs. Clear a marker only after both provider deletion and the
   * updated job record are committed. */
  private async retryPendingProviderDeletes() {
    for (const data of this.store.all()) {
      for (const job of data.jobs) {
        if (job.pendingProviderUploadId) {
          await this.abortPendingProviderUpload(job).catch((error) => {
            useLogger().warn(
              `[backup] deferred provider upload abort for job ${job.id}: ${error instanceof Error ? error.message : error}`,
            );
          });
        }
        if (
          !job.pendingProviderObjectId ||
          (job.status !== "failed" && job.status !== "cancelled")
        )
          continue;
        await this.deletePendingProviderObject(
          job,
          job.pendingProviderObjectId,
        ).catch((error) => {
          useLogger().warn(
            `[backup] deferred provider cleanup for job ${job.id}: ${error instanceof Error ? error.message : error}`,
          );
        });
      }
      for (const artifact of [...data.artifacts]) {
        if (!artifact.deletionPending) continue;
        if (!this.beginArtifactDeletion(artifact)) continue;
        try {
          await this.runProviderCleanup("deferred artifact deletion", (signal) =>
            this.providers
              .get(artifact.provider)!
              .delete(artifact.userId, artifact.providerObjectId, signal),
          );
          await this.store.update(artifact.userId, (currentData) => {
            currentData.artifacts = currentData.artifacts.filter(
              (candidate) => candidate.id !== artifact.id,
            );
          });
        } catch (error) {
          await this.store
            .update(artifact.userId, (currentData) => {
              const current = currentData.artifacts.find(
                (candidate) => candidate.id === artifact.id,
              );
              if (!current) return;
              current.deletionPending = true;
              current.deletionErrorAt = new Date().toISOString();
            })
            .catch(() => {});
          useLogger().warn(
            `[backup] deferred artifact cleanup for ${artifact.id}: ${error instanceof Error ? error.message : error}`,
          );
        } finally {
          this.endArtifactDeletion(artifact);
        }
      }
    }
  }

  private async deletePendingProviderObject(
    job: BackupJob,
    objectId: string,
  ): Promise<void> {
    const provider = this.providers.get(job.provider)!;
    const artifactId = job.pendingProviderArtifactId ?? objectId;
    await this.runProviderCleanup(
      "pending provider object deletion",
      async (signal) => {
        if (!provider.deleteByArtifactId || objectId !== artifactId)
          await provider.delete(job.userId, objectId, signal);
        await provider.deleteByArtifactId?.(job.userId, artifactId, signal);
      },
    );
    if (job.pendingProviderObjectId !== objectId) return;
    job.pendingProviderObjectId = undefined;
    job.pendingProviderArtifactId = undefined;
    job.updatedAt = new Date().toISOString();
    try {
      await this.saveJob(job);
    } catch (error) {
      job.pendingProviderObjectId = objectId;
      job.pendingProviderArtifactId = artifactId;
      throw error;
    }
  }

  private async abortPendingProviderUpload(job: BackupJob): Promise<void> {
    const uploadId = job.pendingProviderUploadId;
    if (!uploadId) return;
    const provider = this.providers.get(job.provider)!;
    if (!provider.abortUpload)
      throw new Error("Backup provider cannot confirm upload cancellation");
    await this.runProviderCleanup("pending provider upload cancellation", (signal) =>
      provider.abortUpload!(
        job.userId,
        uploadId,
        job.pendingProviderObjectId || "",
        signal,
      ),
    );
    job.pendingProviderUploadId = undefined;
    job.updatedAt = new Date().toISOString();
    try {
      await this.saveJob(job);
    } catch (error) {
      job.pendingProviderUploadId = uploadId;
      throw error;
    }
  }
  private async runProviderCleanup(
    label: string,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    let deadlineExceeded = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const running = operation(controller.signal).catch((error) => {
        // Once the deadline owns the public result, keep the provider
        // rejection observed without allowing it to replace the structured
        // timeout or become an unhandled rejection.
        if (deadlineExceeded) return new Promise<void>(() => {});
        throw error;
      });
      await Promise.race([
        running,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              deadlineExceeded = true;
              const error = Object.assign(
                new Error(`${label} exceeded the cleanup deadline`),
                { code: "BACKUP_PROVIDER_CLEANUP_TIMEOUT" },
              );
              reject(error);
              controller.abort(error);
            },
            this.providerCleanupTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async recordAttempt(userId: string) {
    await this.store.update(userId, (data) => {
      if (!data.config) return;
      data.config.lastAttemptAt = new Date().toISOString();
      data.config.updatedAt = data.config.lastAttemptAt;
    });
  }
  private enqueue(jobId: string, ownerId: string, task: () => Promise<void>) {
    if (!this.accepting) throw new Error("Backup manager is shutting down");
    this.pending.push({ jobId, ownerId, task });
    this.pump();
  }
  private enqueueAndWait<T>(
    jobId: string,
    ownerId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new Error("Backup manager is shutting down"));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        jobId,
        ownerId,
        cancel: reject,
        task: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.pump();
    });
  }
  private cancelPending(
    shouldCancel: (candidate: BackupQueueEntry) => boolean,
    error: Error,
  ): void {
    const retained: BackupQueueEntry[] = [];
    for (const candidate of this.pending) {
      if (shouldCancel(candidate)) candidate.cancel?.(error);
      else retained.push(candidate);
    }
    this.pending = retained;
  }
  private pump() {
    while (this.active < this.maxConcurrent && this.pending.length) {
      const entry = this.pending.shift()!;
      this.active++;
      const task = Promise.resolve().then(entry.task);
      const ownerTasks = this.activeTasks.get(entry.ownerId) ?? new Set();
      ownerTasks.add(task);
      this.activeTasks.set(entry.ownerId, ownerTasks);
      void task
        .catch((error) => {
          useLogger().error(
            `[backup] queued task ${entry.jobId} failed: ${error instanceof Error ? error.message : error}`,
          );
        })
        .finally(() => {
          ownerTasks.delete(task);
          if (!ownerTasks.size) this.activeTasks.delete(entry.ownerId);
          this.active--;
          this.pump();
        });
    }
  }
}

export async function cleanupInterruptedBackupStaging(
  dataDir: string,
  jobId: string,
) {
  assertSafeUserId(jobId, "jobId");
  await Promise.all([
    rm(join(dataDir, "tmp", `backup-${jobId}`), {
      recursive: true,
      force: true,
    }),
    rm(join(dataDir, "tmp", `restore-${jobId}`), {
      recursive: true,
      force: true,
    }),
    rm(join(dataDir, "tmp", `discovery-${jobId}`), {
      recursive: true,
      force: true,
    }),
    rm(join(dataDir, "tmp", `adoption-${jobId}`), {
      recursive: true,
      force: true,
    }),
  ]);
}
export async function readInterruptedBackupResume(
  dataDir: string,
  jobId: string,
): Promise<
  | { artifactId: string; uploadId: string; sha256: string; size: number }
  | undefined
> {
  assertSafeUserId(jobId, "jobId");
  try {
    const value = JSON.parse(
      await readFile(
        join(dataDir, "tmp", `backup-${jobId}`, "resume.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    if (
      typeof value.artifactId !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(value.artifactId) ||
      typeof value.uploadId !== "string" ||
      !value.uploadId ||
      value.uploadId.length > 4096 ||
      /[\0\r\n]/.test(value.uploadId) ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(value.sha256) ||
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0
    )
      return undefined;
    return {
      artifactId: value.artifactId,
      uploadId: value.uploadId,
      sha256: value.sha256,
      size: value.size,
    };
  } catch {
    return undefined;
  }
}
export function recordUploadedProviderObject(
  job: BackupJob,
  providerObjectId: string,
): string {
  job.pendingProviderArtifactId ??= job.pendingProviderObjectId;
  job.pendingProviderObjectId = providerObjectId;
  return providerObjectId;
}
export async function rollbackRestoredWorkers(
  workerIds: readonly string[],
  removeWorker: (workerId: string) => Promise<void> = (workerId) =>
    useContainerManager().remove(workerId),
): Promise<string[]> {
  const survivingWorkers: string[] = [];
  for (const workerId of [...workerIds].reverse()) {
    try {
      await removeWorker(workerId);
    } catch {
      survivingWorkers.push(workerId);
    }
  }
  return survivingWorkers;
}
export function restoreRollbackFailure(workerIds: readonly string[]) {
  return Object.assign(
    new Error(
      "Restore failed and some newly created workers require manual cleanup.",
    ),
    {
      statusCode: 500,
      data: {
        code: "RESTORE_ROLLBACK_FAILED",
        workerIds: [...workerIds],
      },
    },
  );
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function configIntervalMinutes(c?: Partial<BackupConfig>) {
  return (
    c?.intervalMinutes ?? Math.max(1, Math.round((c?.intervalHours ?? 24) * 60))
  );
}
function normalizeSelectedPaths(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("selectedPathsByWorkspace must be an object"), { statusCode: 400 });
  const output: Record<string, string[]> = {};
  for (const [workerId, paths] of Object.entries(value as Record<string, unknown>)) {
    assertSafeUserId(workerId);
    output[workerId] = normalizeBackupPaths(paths);
  }
  return output;
}
function pickSelectedPaths(value: Record<string, string[]> | undefined, workerIds: string[]): Record<string, string[]> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([id]) => workerIds.includes(id)));
}
function normalizeImageResolutions(
  selectedWorkspaceIds: string[],
  value: Record<string, BackupImageResolution> | undefined,
): Record<string, BackupImageResolution> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("imageResolutions must be an object"), {
      statusCode: 400,
    });
  const selected = new Set(selectedWorkspaceIds);
  const output: Record<string, BackupImageResolution> = {};
  for (const [workspaceId, resolution] of Object.entries(value)) {
    assertSafeUserId(workspaceId, "workspaceId");
    if (!selected.has(workspaceId))
      throw Object.assign(
        new Error("Image resolution references an unselected workspace"),
        { statusCode: 400 },
      );
    if (!resolution || typeof resolution !== "object")
      throw Object.assign(new Error("Invalid image resolution"), {
        statusCode: 400,
      });
    if (resolution.mode === "exact") {
      output[workspaceId] = { mode: "exact" };
      continue;
    }
    if (resolution.mode === "workspace-only") {
      if (resolution.acknowledged !== true)
        throw Object.assign(
          new Error("Workspace-only restore must be explicitly acknowledged"),
          { statusCode: 400 },
        );
      output[workspaceId] = {
        mode: "workspace-only",
        acknowledged: true,
      };
      continue;
    }
    if (resolution.mode === "replacement") {
      assertSafeUserId(resolution.imageDefinitionId, "imageDefinitionId");
      if (
        typeof resolution.imageVersion !== "string" ||
        !resolution.imageVersion.trim() ||
        resolution.imageVersion.length > 100 ||
        /[\0\r\n]/.test(resolution.imageVersion)
      )
        throw Object.assign(new Error("Invalid replacement image version"), {
          statusCode: 400,
        });
      output[workspaceId] = {
        mode: "replacement",
        imageDefinitionId: resolution.imageDefinitionId,
        imageVersion: resolution.imageVersion,
      };
      continue;
    }
    throw Object.assign(new Error("Invalid image resolution mode"), {
      statusCode: 400,
    });
  }
  return Object.keys(output).length ? output : undefined;
}
function normalizeBackupRequestId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    /[\0\r\n]/.test(normalized)
  )
    throw Object.assign(new Error("Invalid backup request identity"), {
      statusCode: 400,
      code: "BACKUP_REQUEST_ID_INVALID",
    });
  return normalized;
}
function requestFingerprint(value: Record<string, unknown>): string {
  const canonical = Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
function appendBackupJobLog(job: BackupJob, message: string): void {
  // Job logs are intentionally concise operational events, never exception
  // bodies or provider responses. Keep their durable/MCP representation
  // bounded so repeated polling stays inexpensive.
  const safe = message.replace(/[\0\r\n]+/g, " ").slice(0, 2048);
  job.logs = [...(job.logs ?? []), safe].slice(-1000);
}
function safeRemoteTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 100) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const year = new Date(milliseconds).getUTCFullYear();
  return year >= 2000 && year <= 9999
    ? new Date(milliseconds).toISOString()
    : undefined;
}
function safeRemoteId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    assertSafeUserId(value, "backupId");
    return value;
  } catch {
    return undefined;
  }
}
function safeBackupErrorCode(error: unknown, fallback: string): string {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (
    typeof candidate === "string" &&
    /^[A-Z][A-Z0-9_]{2,100}$/.test(candidate)
  )
    return candidate;
  const message = error instanceof Error ? error.message : "";
  if (/recovery key|required key.*unavailable/i.test(message))
    return "BACKUP_RECOVERY_KEY_MISSING";
  if (/integrity verification failed/i.test(message))
    return "BACKUP_INTEGRITY_FAILED";
  if (/authentication failed/i.test(message))
    return "BACKUP_AUTHENTICATION_FAILED";
  if (/unsupported backup format|format is not supported/i.test(message))
    return "BACKUP_FORMAT_UNSUPPORTED";
  if (/manifest|workspace identity|backup bundle|reconstruction metadata/i.test(message))
    return "BACKUP_MANIFEST_INVALID";
  const publicFailure = publicBackupFailure(error);
  return publicFailure.code === "BACKUP_FAILED"
    ? fallback
    : publicFailure.code;
}
function safeAdoptionError(error: unknown): string {
  const code = safeBackupErrorCode(error, "BACKUP_ADOPTION_FAILED");
  if (code === "BACKUP_RECOVERY_KEY_MISSING")
    return "The recovery key required by this backup is not available or did not authenticate it.";
  if (code === "BACKUP_FORMAT_UNSUPPORTED")
    return "This backup format is not supported by this Agentor version.";
  if (/INTEGRITY|AUTHENTICATION|MANIFEST|INVALID|DAMAGED/.test(code))
    return "The downloaded backup could not be authenticated or its manifest is invalid.";
  const providerFailure = publicBackupFailure(error);
  if (providerFailure.code !== "BACKUP_FAILED") return providerFailure.message;
  return "Backup adoption failed. The discovered record was retained so the operation can be retried.";
}
function isRetryableAdoptionError(error: unknown): boolean {
  const code = safeBackupErrorCode(error, "BACKUP_ADOPTION_FAILED");
  if (/RECOVERY_KEY|FORMAT_UNSUPPORTED|INTEGRITY|AUTHENTICATION|MANIFEST|INVALID|DAMAGED/.test(code))
    return false;
  return publicBackupFailure(error).retryable;
}
function safeImageRecoveryError(error: unknown): string {
  const code = safeBackupErrorCode(error, "BACKUP_IMAGE_RECOVERY_FAILED");
  if (code === "BACKUP_RECOVERY_KEY_MISSING")
    return "The recovery key required by this backup is not available or did not authenticate it.";
  if (code === "BACKUP_IMAGE_RECIPE_UNAVAILABLE")
    return "This workspace has no portable custom-image recipe. Select a replacement image or explicitly restore workspace-only.";
  if (/INTEGRITY|AUTHENTICATION|MANIFEST|FORMAT/.test(code))
    return "The backup could not be authenticated or its reconstruction metadata is invalid.";
  if (code === "BACKUP_REMOTE_OBJECT_CHANGED")
    return "The provider object changed after adoption. Scan and adopt it again before recovering its image definition.";
  const providerFailure = publicBackupFailure(error);
  return providerFailure.code !== "BACKUP_FAILED"
    ? providerFailure.message
    : "Image recipe recovery failed. The adopted backup and any imported recovery definition were retained.";
}
function isRetryableImageRecoveryError(error: unknown): boolean {
  const code = safeBackupErrorCode(error, "BACKUP_IMAGE_RECOVERY_FAILED");
  if (/RECOVERY_KEY|RECIPE_UNAVAILABLE|INTEGRITY|AUTHENTICATION|MANIFEST|FORMAT/.test(code))
    return false;
  return publicBackupFailure(error).retryable;
}
function safeError(err: unknown) {
  const m = err instanceof Error ? err.message : "";
  return /running or stopped|not linked/.test(m)
    ? m
    : "Backup failed. Check server logs for details.";
}
/** Nested/rootless Docker may expose a threaded cgroup subtree where runc
 * rejects controller-backed resource limits. This exact error is the only
 * case where the offline helper retries without optional cgroup ceilings. */
function isThreadedCgroupLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cgroup(?:v2)?[^\n]*threaded mode|cannot enter cgroupv2[^\n]*threaded/i.test(
    message,
  );
}
function sanitizeConfig(c: BackupConfig) {
  return {
    ...c,
    google: c.google
      ? { clientId: c.google.clientId, linked: !!c.google.token }
      : undefined,
  };
}
function sanitizeJob(job: BackupJob): BackupJob {
  const publicJob = structuredClone(job);
  delete publicJob.pendingProviderObjectId;
  delete publicJob.pendingProviderArtifactId;
  delete publicJob.pendingProviderUploadId;
  delete publicJob.providerUploadId;
  return publicJob;
}
let singleton: BackupManager | undefined;
export function useBackupManager() {
  return (singleton ??= new BackupManager());
}
