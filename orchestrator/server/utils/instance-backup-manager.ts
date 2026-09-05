import Docker from "dockerode";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BackupProvider } from "./backup-provider";
import { MAX_BACKUP_PROVIDER_OBJECT_BYTES, publicBackupFailure } from "./backup-provider";
import type { BackupProviderKind } from "./backup-types";
import { backupInstallationId } from "./backup-installation";
import { useBackupManager, type BackupManager } from "./backup-manager";
import {
  createInstanceDataArchive,
  inspectInstanceBundle,
  instanceVolumeArchiveName,
  packInstanceBundle,
  sha256File,
} from "./instance-backup-bundle";
import {
  decryptInstanceBackup,
  encryptedInstancePayloadSha256,
  encryptInstanceBackup,
  inspectInstanceBackup,
  inspectInstanceBackupPrefix,
} from "./instance-backup-crypto";
import { InstanceBackupStore } from "./instance-backup-store";
import {
  DEFAULT_INSTANCE_BACKUP_OPTIONS,
  type InstanceBackupArtifact,
  type InstanceBackupJob,
  type InstanceBackupManifest,
  type InstanceBackupOptions,
  type PublicInstanceBackupJob,
  type InstanceRestoreOptions,
  type InstanceRestorePreflight,
  type InstanceBackupVolumeManifest,
  type RemoteInstanceBackupRecord,
} from "./instance-backup-types";
import { getAuthDb } from "./auth";
import { administrativeWorkspaceResourceNames } from "./admin-workspace-runtime";
import { sanitizeBackupPathTarPayload } from "./worker-export";
import { useConfig } from "./services";
import {
  beginInstanceRestore,
  beginInstanceSnapshot,
} from "./instance-snapshot-gate";

const MAX_CONCURRENT_JOBS = 1;
const MAX_LOG_LINES = 1000;
const REMOTE_HEADER_BYTES = 16 * 1024;

interface QueuedOperation {
  jobId: string;
  run: (job: InstanceBackupJob, signal: AbortSignal) => Promise<void>;
}

interface VolumeCandidate {
  name: string;
  kind: InstanceBackupVolumeManifest["kind"];
  ownerId?: string;
  workerId?: string;
  groupId?: string;
}

export interface InstanceBackupManagerOptions {
  dataDir?: string;
  docker?: Docker;
  store?: InstanceBackupStore;
  backupManager?: BackupManager;
  authSnapshot?: (destination: string) => Promise<void>;
  preflightCreate?: () => Promise<void>;
  inventory?: (userId: string) => Promise<{
    volumes: VolumeCandidate[];
    plugins: InstanceBackupManifest["plugins"];
    hostMounts: InstanceBackupManifest["hostMounts"];
    images: InstanceBackupManifest["images"];
    storage: InstanceBackupManifest["storage"];
  }>;
}

export class InstanceBackupManager {
  private readonly dataDir: string;
  private readonly artifactsDir: string;
  private readonly stagingDir: string;
  private readonly docker: Docker;
  private readonly store: InstanceBackupStore;
  private readonly backupManager: BackupManager;
  private readonly authSnapshot: (destination: string) => Promise<void>;
  private readonly preflightCreate: () => Promise<void>;
  private readonly inventoryOverride?: InstanceBackupManagerOptions["inventory"];
  private initialized?: Promise<void>;
  private accepting = true;
  private active = 0;
  private queue: QueuedOperation[] = [];
  private controllers = new Map<string, AbortController>();
  private tasks = new Map<string, Promise<void>>();
  private restoreBarriers = new Map<string, () => void>();

  constructor(options: InstanceBackupManagerOptions = {}) {
    this.dataDir = options.dataDir ?? useConfig().dataDir;
    this.artifactsDir = join(this.dataDir, "instance-backup-artifacts");
    this.stagingDir = join(this.dataDir, "instance-restore-staging");
    this.docker =
      options.docker ?? new Docker({ socketPath: "/var/run/docker.sock" });
    this.store = options.store ?? new InstanceBackupStore(this.dataDir);
    this.backupManager = options.backupManager ?? useBackupManager();
    this.authSnapshot =
      options.authSnapshot ??
      (async (destination) => {
        await getAuthDb().backup(destination);
      });
    this.preflightCreate = options.preflightCreate ?? (() => this.defaultPreflight());
    this.inventoryOverride = options.inventory;
  }

  init() {
    return (this.initialized ??= this.initialize());
  }

  private async initialize() {
    await Promise.all([
      mkdir(this.artifactsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.stagingDir, { recursive: true, mode: 0o700 }),
      this.store.init(),
    ]);
    for (const name of await readdir(this.stagingDir).catch(() => []))
      await rm(join(this.stagingDir, name), { recursive: true, force: true });
    for (const job of this.store.listJobs()) {
      if (job.status !== "queued" && job.status !== "running") continue;
      const stamp = new Date().toISOString();
      await this.store.saveJob({
        ...job,
        status: "failed",
        phase: "interrupted",
        progress: 100,
        retryable: true,
        errorCode: "INSTANCE_BACKUP_INTERRUPTED",
        error:
          "Instance backup operation was interrupted by an orchestrator restart. Retry it with the same request identity.",
        updatedAt: stamp,
        completedAt: stamp,
        logs: appendLog(job.logs, "Operation interrupted by orchestrator restart."),
      });
    }
  }

  async list(userId: string) {
    await this.init();
    return {
      jobs: this.store.listJobs().filter((job) => job.userId === userId).map(publicJob),
      artifacts: this.store
        .listArtifacts()
        .filter((artifact) => artifact.userId === userId),
      remoteBackups: await Promise.all(
        this.store
          .listRemote()
          .filter((record) => record.userId === userId)
          .map((record) => this.publicRemote(record)),
      ),
      options: DEFAULT_INSTANCE_BACKUP_OPTIONS,
    };
  }

  async getJob(id: string) {
    await this.init();
    const job = this.store.getJob(id);
    return job ? publicJob(job) : undefined;
  }

  async logs(id: string, after = 0, limit = 100) {
    await this.init();
    const job = this.store.getJob(id);
    if (!job) return undefined;
    const start = Number.isSafeInteger(after) ? Math.max(0, after) : 0;
    const count = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(200, limit))
      : 100;
    const end = Math.min(job.logs.length, start + count);
    return {
      jobId: job.id,
      after: start,
      next: end,
      hasMore: end < job.logs.length,
      logs: job.logs.slice(start, end),
    };
  }

  async getArtifact(id: string) {
    await this.init();
    return this.store.getArtifact(id);
  }

  async getRemote(id: string) {
    await this.init();
    const remote = this.store.getRemote(id);
    return remote ? this.publicRemote(remote) : undefined;
  }

  async create(
    userId: string,
    provider: BackupProviderKind = "local",
    options?: Partial<InstanceBackupOptions>,
    requestId?: string,
  ) {
    await this.init();
    this.assertAccepting();
    const normalizedOptions = normalizeOptions(options);
    this.provider(provider);
    const identity = normalizeRequestId(requestId);
    const fingerprint = requestFingerprint({
      operation: "create",
      provider,
      options: normalizedOptions,
    });
    const existing = this.findRequest(userId, "create", identity, fingerprint);
    if (existing) return publicJob(existing);
    if (
      this.store
        .listJobs()
        .some(
          (job) =>
            job.userId === userId &&
            job.operation === "create" &&
            (job.status === "queued" || job.status === "running"),
        )
    )
      throw Object.assign(new Error("An instance backup is already active"), {
        statusCode: 409,
      });
    const job = newJob(userId, "create", provider, identity, fingerprint);
    await this.store.saveJob(job);
    this.enqueue(job.id, (record, signal) =>
      this.runCreate(record, normalizedOptions, signal),
    );
    return publicJob(job);
  }

  async discover(
    userId: string,
    provider: BackupProviderKind = "google-drive",
    requestId?: string,
  ) {
    await this.init();
    this.assertAccepting();
    const implementation = this.provider(provider);
    if (!implementation.discoverInstances)
      throw Object.assign(
        new Error("This provider does not support instance backup discovery"),
        { statusCode: 501 },
      );
    const identity = normalizeRequestId(requestId);
    const fingerprint = requestFingerprint({ operation: "discovery", provider });
    const existing = this.findRequest(
      userId,
      "discovery",
      identity,
      fingerprint,
    );
    if (existing) return publicJob(existing);
    const job = newJob(userId, "discovery", provider, identity, fingerprint);
    await this.store.saveJob(job);
    this.enqueue(job.id, (record, signal) => this.runDiscovery(record, signal));
    return publicJob(job);
  }

  async adopt(userId: string, remoteId: string, requestId?: string) {
    await this.init();
    this.assertAccepting();
    const remote = this.store.getRemote(remoteId);
    if (!remote || remote.userId !== userId)
      throw Object.assign(new Error("Remote instance backup not found"), {
        statusCode: 404,
      });
    if (remote.state === "incomplete" || remote.remote.incomplete)
      throw Object.assign(new Error("The remote upload is incomplete"), {
        statusCode: 409,
      });
    if (remote.adoptedArtifactId) {
      const artifact = this.store.getArtifact(remote.adoptedArtifactId);
      if (artifact)
        return {
          accepted: false,
          alreadyAdopted: true,
          artifactId: artifact.id,
          message: "Remote instance backup was already adopted.",
        };
    }
    const identity = normalizeRequestId(requestId);
    const fingerprint = requestFingerprint({
      operation: "adoption",
      remoteId,
      providerObjectId: remote.providerObjectId,
    });
    const existing = this.findRequest(
      userId,
      "adoption",
      identity,
      fingerprint,
    );
    if (existing) return publicJob(existing);
    const job = {
      ...newJob(userId, "adoption", remote.provider, identity, fingerprint),
      remoteBackupId: remote.id,
    };
    await this.store.saveJob(job);
    this.enqueue(job.id, (record, signal) => this.runAdoption(record, signal));
    return publicJob(job);
  }

  /** Admit an already streamed local upload into the same authenticated,
   * asynchronous verification path used for provider adoption. */
  async importUpload(userId: string, uploadPath: string, requestId?: string) {
    await this.init();
    this.assertAccepting();
    const info = await lstat(uploadPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 1 ||
      info.size > MAX_BACKUP_PROVIDER_OBJECT_BYTES
    )
      throw Object.assign(new Error("Invalid instance backup upload"), {
        statusCode: 400,
      });
    const header = await inspectInstanceBackup(uploadPath);
    const identity = normalizeRequestId(requestId);
    const fingerprint = requestFingerprint({
      operation: "verify",
      backupId: header.metadata.backupId,
      sourceInstallationId: header.metadata.sourceInstallationId,
      keyFingerprint: header.keyFingerprint,
      size: info.size,
    });
    const existing = this.findRequest(
      userId,
      "verify",
      identity,
      fingerprint,
    );
    if (existing) {
      await rm(uploadPath, { force: true }).catch(() => {});
      return publicJob(existing);
    }
    const job = {
      ...newJob(userId, "verify", "local", identity, fingerprint),
      artifactId: header.metadata.backupId,
    };
    const stableUpload = join(this.stagingDir, `upload-${job.id}.backup`);
    await rename(uploadPath, stableUpload);
    try {
      await this.store.saveJob(job);
    } catch (error) {
      await rm(stableUpload, { force: true }).catch(() => {});
      throw error;
    }
    this.enqueue(job.id, (record, signal) =>
      this.runUploadedAdoption(record, stableUpload, signal),
    );
    return publicJob(job);
  }

  async restorePreflight(
    userId: string,
    artifactId: string,
    options?: Partial<InstanceRestoreOptions>,
  ): Promise<InstanceRestorePreflight> {
    await this.init();
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact || artifact.userId !== userId || !artifact.manifest)
      throw Object.assign(new Error("Verified instance backup artifact not found"), {
        statusCode: 404,
      });
    const restoreOptions = normalizeRestoreOptions(options, false);
    const services = await import("./services");
    const adminStore = await import("./admin-workspace-store");
    const storage = services.useStorageManager();
    await storage.init();
    const manifest = artifact.manifest;
    const blockers: string[] = [];
    const warnings: string[] = [];
    const runtimeWorkers = services
      .useContainerManager()
      .list()
      .filter((worker) => worker.status === "running" || worker.status === "creating");
    const persistedWorkers = services.useWorkerStore().list();
    const admin = adminStore.useAdminWorkspaceStore().getRecord();
    const groupAdmins = services
      .useWorkerGroupStore()
      .list()
      .filter((group) => Boolean(group.adminWorkspace));
    if (process.env.AGENTOR_INSTANCE_RECOVERY_MODE !== "true")
      blockers.push(
        "Start the empty destination with AGENTOR_INSTANCE_RECOVERY_MODE=true before applying a whole-instance restore. This prevents bootstrap workspaces and recovered workers from starting during replacement.",
      );
    if (runtimeWorkers.length)
      blockers.push("Stop every running worker before applying an instance restore.");
    if (persistedWorkers.length || admin || groupAdmins.length)
      blockers.push(
        "The destination installation already contains workers or administrative workspaces. Whole-instance restore is limited to an empty recovery installation.",
      );
    if (manifest.storage.mode !== storage.mode)
      blockers.push(
        `Storage mode differs: the backup uses ${manifest.storage.mode}, while this installation uses ${storage.mode}. Configure the destination with the same /data mount mode before restore.`,
      );
    if (manifest.storage.containerPrefix !== useConfig().containerPrefix)
      blockers.push(
        `Worker container prefix differs: expected ${manifest.storage.containerPrefix}. Preserve CONTAINER_PREFIX before restore so named volumes remain addressable.`,
      );
    const volumeConflicts: string[] = [];
    if (restoreOptions.restoreDockerVolumes) {
      const existingVolumes = new Set(
        ((await this.docker.listVolumes()).Volumes ?? [])
          .map((volume) => volume.Name)
          .filter((name): name is string => Boolean(name)),
      );
      for (const volume of manifest.volumes)
        if (existingVolumes.has(volume.name)) volumeConflicts.push(volume.name);
    }
    if (volumeConflicts.length)
      blockers.push(
        "One or more destination Docker volumes already exist. Agentor will not overwrite them during a safe instance restore.",
      );
    if (!restoreOptions.restoreHostMountPolicies && manifest.hostMounts.configuredPaths.length)
      warnings.push(
        "Host-mount allowlists and grants will be omitted. Recreate them deliberately after copying the external host data.",
      );
    if (!restoreOptions.restoreDockerVolumes && manifest.volumes.length)
      warnings.push(
        "Persistent Docker volumes will not be restored; affected workers and administrative workspaces will be incomplete.",
      );
    if (manifest.images.immutableDigests.length)
      warnings.push(
        "Docker image layers are not embedded. Pull immutable registry digests or rebuild custom images after restore.",
      );
    warnings.push(
      "External .env values, GitHub App PEM files, DNS credentials, registry credentials, and host-mounted file contents are not embedded and must be supplied separately.",
    );
    return {
      ready: blockers.length === 0,
      blockers,
      warnings,
      sourceInstallationId: manifest.sourceInstallationId,
      sourceStorageMode: manifest.storage.mode,
      destinationStorageMode: storage.mode,
      sourceContainerPrefix: manifest.storage.containerPrefix,
      destinationContainerPrefix: useConfig().containerPrefix,
      volumeConflicts,
      hostMountPaths: [...manifest.hostMounts.configuredPaths],
      imageDigestsNotEmbedded: [...manifest.images.immutableDigests],
    };
  }

  async restore(
    userId: string,
    artifactId: string,
    options: Partial<InstanceRestoreOptions>,
    requestId?: string,
  ) {
    await this.init();
    this.assertAccepting();
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact || artifact.userId !== userId || !artifact.manifest)
      throw Object.assign(new Error("Verified instance backup artifact not found"), {
        statusCode: 404,
      });
    const restoreOptions = normalizeRestoreOptions(options, true);
    const identity = normalizeRequestId(requestId);
    const fingerprint = requestFingerprint({
      operation: "restore",
      artifactId,
      options: restoreOptions,
    });
    const existing = this.findRequest(
      userId,
      "restore",
      identity,
      fingerprint,
    );
    if (existing) return publicJob(existing);
    if (
      this.store.listJobs().some(
        (job) =>
          job.operation === "restore" &&
          (job.status === "queued" || job.status === "running"),
      )
    )
      throw Object.assign(new Error("An instance restore is already active"), {
        statusCode: 409,
      });
    const job = {
      ...newJob(userId, "restore", artifact.provider, identity, fingerprint),
      artifactId,
    };
    // Acquire before persisting the accepted response. No dashboard/API/MCP
    // mutation can make the recovery installation non-empty in the small gap
    // before the queued restore reaches its authoritative preflight.
    const releaseBarrier = beginInstanceRestore(job.id);
    this.restoreBarriers.set(job.id, releaseBarrier);
    try {
      await this.store.saveJob(job);
      this.enqueue(job.id, (record, signal) =>
        this.runRestore(record, artifact, restoreOptions, signal),
      );
    } catch (error) {
      this.releaseRestoreBarrier(job.id);
      throw error;
    }
    return publicJob(job);
  }

  async cancel(id: string) {
    await this.init();
    const current = this.store.getJob(id);
    if (!current) throw Object.assign(new Error("Instance backup job not found"), { statusCode: 404 });
    if (["succeeded", "failed", "cancelled"].includes(current.status))
      return publicJob(current);
    if (current.operation === "restore" && current.phase === "applying")
      throw Object.assign(
        new Error(
          "Instance restore can no longer be cancelled after control has been handed to the restart helper.",
        ),
        { statusCode: 409, code: "INSTANCE_RESTORE_ALREADY_APPLYING" },
      );
    const stamp = new Date().toISOString();
    const cancelled: InstanceBackupJob = {
      ...current,
      status: "cancelled",
      phase: "cancelled",
      progress: 100,
      updatedAt: stamp,
      completedAt: stamp,
      logs: appendLog(current.logs, "Cancellation requested."),
    };
    await this.store.saveJob(cancelled);
    this.controllers.get(id)?.abort(Object.assign(new Error("Instance backup cancelled"), { name: "AbortError" }));
    // A queued restore has no task-finally hook. An active one retains the
    // barrier until its aborted task has actually unwound.
    if (current.operation === "restore" && !this.controllers.has(id))
      this.releaseRestoreBarrier(id);
    const provider = this.backupManager.instanceBackupProvider(current.provider);
    if (current.pendingProviderUploadId && provider?.abortUpload)
      void provider
        .abortUpload(
          current.userId,
          current.pendingProviderUploadId,
          current.artifactId ?? current.id,
        )
        .catch(() => {});
    return publicJob(cancelled);
  }

  async openArtifact(
    userId: string,
    artifactId: string,
  ): Promise<{ stream: Readable; size: number; filename: string }> {
    await this.init();
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact || artifact.userId !== userId)
      throw Object.assign(new Error("Instance backup artifact not found"), {
        statusCode: 404,
      });
    const path = this.artifactPath(artifact.id);
    const info = await stat(path);
    return {
      stream: createReadStream(path),
      size: info.size,
      filename: `agentor-instance-${artifact.createdAt.slice(0, 10)}-${artifact.id}.backup`,
    };
  }

  stop() {
    this.accepting = false;
    for (const controller of this.controllers.values())
      controller.abort(Object.assign(new Error("Orchestrator is stopping"), { name: "AbortError" }));
    for (const jobId of [...this.restoreBarriers.keys()])
      this.releaseRestoreBarrier(jobId);
  }

  private async runCreate(
    job: InstanceBackupJob,
    options: InstanceBackupOptions,
    signal: AbortSignal,
  ) {
    const stage = join(this.stagingDir, job.id);
    const authSnapshot = join(stage, "auth.db");
    const dataArchive = join(stage, "data.tar.gz");
    const bundle = join(stage, "instance.tar");
    const encrypted = this.artifactPath(job.id);
    let provider: BackupProvider | undefined;
    let releaseSnapshot: (() => void) | undefined;
    let inventory: Awaited<ReturnType<NonNullable<InstanceBackupManagerOptions["inventory"]>>>;
    let data: Awaited<ReturnType<typeof createInstanceDataArchive>>;
    try {
      await this.running(job, "preflight", "Checking whether the installation is quiescent enough to snapshot.");
      releaseSnapshot = beginInstanceSnapshot(job.id);
      await this.preflightCreate();
      signal.throwIfAborted();
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await this.phase(job, "database-snapshot", 10, "Pausing control-plane mutations and creating a consistent SQLite online-backup snapshot.");
      await this.authSnapshot(authSnapshot);
      signal.throwIfAborted();
      inventory = this.inventoryOverride
        ? await this.inventoryOverride(job.userId)
        : await this.inventory(job.userId);
      await this.phase(job, "data-snapshot", 20, "Archiving the versioned control-plane stores under the snapshot write barrier.");
      data = await createInstanceDataArchive({
        dataDir: this.dataDir,
        authSnapshotPath: authSnapshot,
        output: dataArchive,
        options,
        signal,
        onBytes: (bytes) => {
          job.bytesProcessed = bytes;
        },
      });
      const volumes: Array<{
        manifest: InstanceBackupVolumeManifest;
        path: string;
      }> = [];
      if (options.includeDockerVolumes) {
        const selectedVolumes = inventory.volumes.filter((candidate) =>
          includeVolumeCandidate(candidate, options),
        );
        let index = 0;
        for (const candidate of selectedVolumes) {
          signal.throwIfAborted();
          const output = join(stage, `volume-${index}.tar.gz`);
          const snapshotted = await this.snapshotVolume(candidate.name, output, signal);
          if (!snapshotted) continue;
          const info = await stat(output);
          volumes.push({
            manifest: {
              ...candidate,
              archive: instanceVolumeArchiveName(candidate.name),
              sha256: await sha256File(output),
              size: info.size,
            },
            path: output,
          });
          index += 1;
          await this.phase(
            job,
            "volume-snapshot",
            25 + Math.floor((index / Math.max(1, selectedVolumes.length)) * 35),
            `Snapshotted persistent Docker volume ${index} of ${selectedVolumes.length}.`,
          );
        }
      }
      releaseSnapshot();
      releaseSnapshot = undefined;
      const createdAt = new Date().toISOString();
      const sourceInstallationId = await backupInstallationId(this.dataDir);
      const manifest: InstanceBackupManifest = {
        kind: "agentor-instance-backup",
        formatVersion: 1,
        backupId: job.id,
        sourceInstallationId,
        createdByUserId: job.userId,
        createdAt,
        agentorVersion: process.env.npm_package_version || "2.0.0",
        storage: inventory.storage,
        options,
        dataArchive: {
          archive: "data.tar.gz",
          sha256: data.sha256,
          size: data.size,
        },
        volumes: volumes.map(({ manifest }) => manifest),
        plugins: inventory.plugins,
        hostMounts: inventory.hostMounts,
        images: inventory.images,
        excludedDataPaths: data.excludedDataPaths,
      };
      await this.phase(job, "packing", 65, "Packing the authenticated instance recovery bundle.");
      await packInstanceBundle(manifest, dataArchive, volumes, bundle, signal);
      const recovery = await this.backupManager.resolveInstanceRecoveryMaterial(job.userId);
      if (!recovery) throw new Error("Backup recovery key is unavailable");
      await this.phase(job, "encrypting", 75, "Encrypting the instance bundle before provider access.");
      const encryptedResult = await encryptInstanceBackup(
        bundle,
        encrypted,
        recovery.material,
        {
          backupId: job.id,
          sourceInstallationId,
          createdAt,
          formatVersion: 1,
        },
        (bytes) => {
          job.bytesProcessed = bytes;
        },
        signal,
      );
      signal.throwIfAborted();
      provider = this.provider(job.provider);
      await this.phase(job, "uploading", 85, "Uploading the encrypted instance artifact to the selected provider.");
      job.artifactId = job.id;
      // Persist a stable reconciliation identity before crossing the provider
      // boundary. If the transport commits and then disconnects, cleanup can
      // find the provider object without knowing its opaque id.
      job.pendingProviderObjectId = job.id;
      await this.store.saveJob(job);
      let uploaded: Awaited<ReturnType<BackupProvider["upload"]>>;
      try {
        uploaded = await provider.upload(
          job.userId,
          job.id,
          encrypted,
          (bytes) => {
            job.bytesProcessed = bytes;
          },
          signal,
          undefined,
          {
            artifactKind: "instance",
            artifactId: job.id,
            formatVersion: 1,
            keyFingerprint: recovery.fingerprint,
            integritySha256: encryptedResult.sha256,
            createdAt,
            incomplete: false,
          },
        );
      } catch (error: any) {
        if (typeof error?.uploadId === "string") {
          job.pendingProviderUploadId = error.uploadId;
          await this.store.saveJob(job).catch(() => {});
        }
        throw error;
      }
      job.pendingProviderObjectId = uploaded.objectId;
      await this.store.saveJob(job);
      const artifact: InstanceBackupArtifact = {
        schemaVersion: 1,
        id: job.id,
        userId: job.userId,
        provider: job.provider,
        providerObjectId: uploaded.objectId,
        createdAt,
        size: encryptedResult.size,
        sha256: encryptedResult.sha256,
        keyFingerprint: recovery.fingerprint,
        sourceInstallationId,
        formatVersion: 1,
        integrityStatus: "verified",
        provenance: "local",
        manifest,
      };
      await this.store.saveArtifact(artifact);
      delete job.pendingProviderObjectId;
      await this.succeeded(job, "complete", "Instance disaster-recovery backup is encrypted, verified, and available.");
    } finally {
      releaseSnapshot?.();
      if (job.status !== "succeeded" && provider) {
        if (job.pendingProviderUploadId && provider.abortUpload)
          await provider
            .abortUpload(job.userId, job.pendingProviderUploadId, job.id)
            .catch(() => {});
        if (provider.deleteByArtifactId)
          await provider
            .deleteByArtifactId(job.userId, job.id, undefined, "instance")
            .catch(() => {});
        else if (
          job.pendingProviderObjectId &&
          job.pendingProviderObjectId !== job.id
        )
          await provider
            .delete(job.userId, job.pendingProviderObjectId)
            .catch(() => {});
        await this.store.removeArtifact(job.id).catch(() => {});
      }
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      if (job.status !== "succeeded")
        await rm(encrypted, { force: true }).catch(() => {});
    }
  }

  private async runDiscovery(job: InstanceBackupJob, signal: AbortSignal) {
    await this.running(job, "scanning", "Scanning the provider for instance disaster-recovery artifacts.");
    const provider = this.provider(job.provider);
    if (!provider.discoverInstances)
      throw new Error("This provider does not support instance backup discovery");
    let cursor: string | undefined;
    let inspected = 0;
    do {
      const page = await provider.discoverInstances(job.userId, cursor, signal);
      for (const descriptor of page.records) {
        signal.throwIfAborted();
        if (descriptor.artifactKind !== "instance") continue;
        const timestamp = new Date().toISOString();
        let state: RemoteInstanceBackupRecord["state"] = "discovered";
        let blockedReason: string | undefined;
        let keyFingerprint = descriptor.keyFingerprint;
        let sourceInstallationId: string | undefined;
        let formatVersion = descriptor.formatVersion;
        if (descriptor.incomplete) {
          state = "incomplete";
          blockedReason = "The provider upload is incomplete.";
        } else if (descriptor.size > MAX_BACKUP_PROVIDER_OBJECT_BYTES) {
          state = "too-large";
          blockedReason = "The provider object exceeds Agentor's staging size limit.";
        } else if (!provider.readRange) {
          state = "inaccessible";
          blockedReason = "This provider cannot inspect instance backup headers.";
        } else {
          try {
            const header = inspectInstanceBackupPrefix(
              await provider.readRange(
                job.userId,
                descriptor.objectId,
                REMOTE_HEADER_BYTES,
                signal,
              ),
            );
            keyFingerprint = header.keyFingerprint;
            sourceInstallationId = header.metadata.sourceInstallationId;
            formatVersion = header.metadata.formatVersion;
            const recovery = await this.backupManager.resolveInstanceRecoveryMaterial(
              job.userId,
              keyFingerprint,
            );
            if (recovery) state = "ready-to-adopt";
            else {
              state = "missing-key";
              blockedReason = `Recovery key ${keyFingerprint} is not available on this installation.`;
            }
          } catch (error) {
            state = /unsupported/i.test(error instanceof Error ? error.message : "")
              ? "unsupported-format"
              : "damaged";
            blockedReason =
              state === "unsupported-format"
                ? "The remote object is not a supported Agentor instance backup."
                : "The remote instance backup header is damaged or invalid.";
          }
        }
        await this.store.upsertRemote({
          schemaVersion: 1,
          id: randomUUID(),
          userId: job.userId,
          provider: job.provider,
          providerObjectId: descriptor.objectId,
          discoveredAt: timestamp,
          lastSeenAt: timestamp,
          remote: descriptor,
          state,
          ...(keyFingerprint ? { keyFingerprint } : {}),
          ...(sourceInstallationId ? { sourceInstallationId } : {}),
          ...(formatVersion ? { formatVersion } : {}),
          ...(blockedReason ? { blockedReason } : {}),
        });
        inspected += 1;
        job.progress = Math.min(95, 10 + inspected);
        job.bytesProcessed = inspected;
      }
      cursor = page.nextCursor;
    } while (cursor);
    await this.succeeded(
      job,
      "complete",
      inspected
        ? `Provider scan inspected ${inspected} instance backup object(s).`
        : "Provider scan completed; no instance backups were found.",
    );
  }

  private async runAdoption(job: InstanceBackupJob, signal: AbortSignal) {
    const remote = job.remoteBackupId
      ? this.store.getRemote(job.remoteBackupId)
      : undefined;
    if (!remote || remote.userId !== job.userId)
      throw new Error("Remote instance backup is no longer available");
    const stage = join(this.stagingDir, job.id);
    const encrypted = join(stage, "remote.backup");
    const bundle = join(stage, "bundle.tar");
    const unpacked = join(stage, "unpacked");
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await this.running(job, "downloading", "Downloading the remote instance backup into bounded staging.");
      const provider = this.provider(remote.provider);
      await provider.download(
        job.userId,
        remote.providerObjectId,
        encrypted,
        signal,
        {
          expectedSize: remote.remote.size,
          maxBytes: MAX_BACKUP_PROVIDER_OBJECT_BYTES,
        },
      );
      const header = await inspectInstanceBackup(encrypted);
      const recovery = await this.backupManager.resolveInstanceRecoveryMaterial(
        job.userId,
        header.keyFingerprint,
      );
      if (!recovery) throw Object.assign(new Error("Required recovery key is unavailable"), { code: "INSTANCE_BACKUP_KEY_MISSING" });
      await this.phase(job, "authenticating", 45, "Authenticating and decrypting the complete remote object.");
      const expectedSha = remote.remote.integritySha256;
      await decryptInstanceBackup(
        encrypted,
        bundle,
        recovery.material,
        expectedSha,
        signal,
      );
      await this.phase(job, "verifying", 65, "Validating the instance manifest and every nested archive.");
      const inspected = await inspectInstanceBundle(bundle, unpacked, signal);
      if (
        inspected.manifest.backupId !== header.metadata.backupId ||
        inspected.manifest.sourceInstallationId !==
          header.metadata.sourceInstallationId
      )
        throw new Error("Instance backup header does not match its authenticated manifest");
      const localPath = this.artifactPath(inspected.manifest.backupId);
      const digest = await encryptedInstancePayloadSha256(encrypted, signal);
      const existing = this.store.getArtifact(inspected.manifest.backupId);
      if (
        existing &&
        (existing.userId !== job.userId || existing.sha256 !== digest)
      )
        throw Object.assign(
          new Error("A different local instance backup already uses this identity"),
          { code: "INSTANCE_BACKUP_ID_CONFLICT", statusCode: 409 },
        );
      let copied = false;
      if (!existing) {
        try {
          await copyFile(encrypted, localPath, fsConstants.COPYFILE_EXCL);
          copied = true;
        } catch (error: any) {
          if (error?.code === "EEXIST")
            throw Object.assign(
              new Error("A local instance backup file already uses this identity"),
              { code: "INSTANCE_BACKUP_ID_CONFLICT", statusCode: 409 },
            );
          throw error;
        }
      }
      const artifact: InstanceBackupArtifact = existing ?? {
        schemaVersion: 1,
        id: inspected.manifest.backupId,
        userId: job.userId,
        provider: remote.provider,
        providerObjectId: remote.providerObjectId,
        createdAt: inspected.manifest.createdAt,
        size: (await stat(localPath)).size,
        sha256: digest,
        keyFingerprint: header.keyFingerprint,
        sourceInstallationId: inspected.manifest.sourceInstallationId,
        formatVersion: 1,
        integrityStatus: "verified",
        provenance: "remote-adopted",
        manifest: inspected.manifest,
      };
      if (!existing)
        try {
          await this.store.saveArtifact(artifact);
        } catch (error) {
          if (copied) await rm(localPath, { force: true }).catch(() => {});
          throw error;
        }
      await this.store.upsertRemote({
        ...remote,
        state: "adopted",
        adoptedArtifactId: artifact.id,
        blockedReason: undefined,
        lastSeenAt: new Date().toISOString(),
      });
      job.artifactId = artifact.id;
      await this.succeeded(job, "complete", "Remote instance backup was authenticated, verified, and adopted locally.");
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runUploadedAdoption(
    job: InstanceBackupJob,
    encrypted: string,
    signal: AbortSignal,
  ) {
    const stage = join(this.stagingDir, job.id);
    const bundle = join(stage, "bundle.tar");
    const unpacked = join(stage, "unpacked");
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await this.running(job, "authenticating", "Authenticating the uploaded instance backup.");
      const header = await inspectInstanceBackup(encrypted);
      const recovery = await this.backupManager.resolveInstanceRecoveryMaterial(
        job.userId,
        header.keyFingerprint,
      );
      if (!recovery)
        throw Object.assign(new Error("Required recovery key is unavailable"), {
          code: "INSTANCE_BACKUP_KEY_MISSING",
        });
      await decryptInstanceBackup(
        encrypted,
        bundle,
        recovery.material,
        undefined,
        signal,
      );
      await this.phase(job, "verifying", 60, "Validating the instance manifest and every nested archive.");
      const inspected = await inspectInstanceBundle(bundle, unpacked, signal);
      if (
        inspected.manifest.backupId !== header.metadata.backupId ||
        inspected.manifest.sourceInstallationId !== header.metadata.sourceInstallationId
      )
        throw new Error("Instance backup header does not match its authenticated manifest");
      const digest = await encryptedInstancePayloadSha256(encrypted, signal);
      const existing = this.store.getArtifact(inspected.manifest.backupId);
      if (
        existing &&
        (existing.userId !== job.userId || existing.sha256 !== digest)
      )
        throw Object.assign(
          new Error("A different local instance backup already uses this identity"),
          { code: "INSTANCE_BACKUP_ID_CONFLICT", statusCode: 409 },
        );
      const localPath = this.artifactPath(inspected.manifest.backupId);
      let copied = false;
      if (!existing)
        try {
          await copyFile(encrypted, localPath, fsConstants.COPYFILE_EXCL);
          copied = true;
        } catch (error: any) {
          if (error?.code === "EEXIST")
            throw Object.assign(
              new Error("A local instance backup file already uses this identity"),
              { code: "INSTANCE_BACKUP_ID_CONFLICT", statusCode: 409 },
            );
          throw error;
        }
      const artifact: InstanceBackupArtifact = existing ?? {
        schemaVersion: 1,
        id: inspected.manifest.backupId,
        userId: job.userId,
        provider: "local",
        providerObjectId: `import:${inspected.manifest.backupId}`,
        createdAt: inspected.manifest.createdAt,
        size: (await stat(encrypted)).size,
        sha256: digest,
        keyFingerprint: header.keyFingerprint,
        sourceInstallationId: inspected.manifest.sourceInstallationId,
        formatVersion: 1,
        integrityStatus: "verified",
        provenance: "remote-adopted",
        manifest: inspected.manifest,
      };
      if (!existing)
        try {
          await this.store.saveArtifact(artifact);
        } catch (error) {
          if (copied) await rm(localPath, { force: true }).catch(() => {});
          throw error;
        }
      job.artifactId = artifact.id;
      await this.succeeded(job, "complete", "Uploaded instance backup was authenticated, verified, and adopted locally.");
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      await rm(encrypted, { force: true }).catch(() => {});
    }
  }

  private async runRestore(
    job: InstanceBackupJob,
    artifact: InstanceBackupArtifact,
    options: InstanceRestoreOptions,
    signal: AbortSignal,
  ) {
    const stage = join(this.stagingDir, `restore-${job.id}`);
    const bundle = join(stage, "bundle.tar");
    const unpacked = join(stage, "unpacked");
    let helperOwnsStage = false;
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await this.running(job, "authenticating", "Re-authenticating the retained instance backup before restore.");
      const encrypted = this.artifactPath(artifact.id);
      const header = await inspectInstanceBackup(encrypted);
      const recovery = await this.backupManager.resolveInstanceRecoveryMaterial(
        artifact.userId,
        header.keyFingerprint,
      );
      if (!recovery)
        throw Object.assign(new Error("Required recovery key is unavailable"), {
          code: "INSTANCE_BACKUP_KEY_MISSING",
        });
      await decryptInstanceBackup(
        encrypted,
        bundle,
        recovery.material,
        artifact.sha256,
        signal,
      );
      signal.throwIfAborted();
      await this.phase(job, "verifying", 35, "Validating the manifest and all nested archives before any destructive action.");
      const inspected = await inspectInstanceBundle(bundle, unpacked, signal);
      if (
        inspected.manifest.backupId !== artifact.id ||
        inspected.manifest.sourceInstallationId !== artifact.sourceInstallationId
      )
        throw new Error("Retained instance artifact identity does not match its manifest");
      const preflight = await this.restorePreflight(job.userId, artifact.id, options);
      if (!preflight.ready)
        throw Object.assign(new Error(preflight.blockers.join(" ")), {
          code: "INSTANCE_RESTORE_PREFLIGHT_FAILED",
          statusCode: 409,
        });
      const plan = {
        version: 1,
        jobId: job.id,
        dataArchive: inspected.dataArchivePath,
        volumes: options.restoreDockerVolumes
          ? inspected.manifest.volumes.map((volume) => ({
              name: volume.name,
              archive: inspected.volumeArchives.get(volume.name),
              kind: volume.kind,
              ...(volume.workerId ? { workerId: volume.workerId } : {}),
            }))
          : [],
        restoreHostMountPolicies: options.restoreHostMountPolicies,
        sourceInstallationId: inspected.manifest.sourceInstallationId,
        restoredOwnerId: inspected.manifest.createdByUserId,
        stagingOwnerId: job.userId,
      };
      if (plan.volumes.some((volume) => !volume.archive))
        throw new Error("Instance restore staging is missing a declared volume archive");
      const planPath = join(stage, "restore-plan.json");
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
        mode: 0o600,
      });
      await this.phase(
        job,
        "helper-starting",
        70,
        "Validated restore staged. Starting the controlled helper that will stop the orchestrator, apply the snapshot, and restart it.",
      );
      await this.launchRestoreHelper(job, stage, async () => {
        helperOwnsStage = true;
        await this.phase(
          job,
          "applying",
          70,
          "Controlled helper started and owns the staged restore.",
        );
      });
      // The helper owns the terminal status because this process is about to be
      // stopped. It updates the persisted job before restarting the orchestrator.
    } finally {
      // Before a successful helper start this process owns all decrypted data.
      // Never retain a plaintext auth.db/control-plane bundle after a failed
      // preflight, cancellation, or helper-launch failure. Once the helper has
      // started it alone owns the stage and may still need it after this
      // process has been stopped.
      if (!helperOwnsStage)
        await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async launchRestoreHelper(
    job: InstanceBackupJob,
    stage: string,
    onHandoff: () => Promise<void>,
  ) {
    const hostname = process.env.HOSTNAME;
    if (!hostname) throw new Error("Orchestrator container identity is unavailable");
    const current = await this.docker.getContainer(hostname).inspect();
    const dataMount = current.Mounts?.find(
      (mount) => mount.Destination === this.dataDir,
    );
    if (!dataMount)
      throw new Error("The orchestrator data mount could not be identified");
    const binds = ["/var/run/docker.sock:/var/run/docker.sock"];
    const mounts: Docker.MountSettings[] = [];
    if (dataMount.Type === "bind")
      binds.push(`${dataMount.Source}:${this.dataDir}`);
    else if (dataMount.Type === "volume" && dataMount.Name)
      mounts.push({
        Type: "volume",
        Source: dataMount.Name,
        Target: this.dataDir,
      } as Docker.MountSettings);
    else throw new Error("Unsupported orchestrator data mount type");
    const helper = await this.docker.createContainer({
      Image: current.Config.Image,
      name: `agentor-instance-restore-${job.id}`,
      User: "0:0",
      Cmd: ["node", ".output/server/instance-restore-helper.mjs"],
      WorkingDir: "/app",
      Env: [
        `AGENTOR_INSTANCE_RESTORE_JOB=${job.id}`,
        `AGENTOR_INSTANCE_RESTORE_STAGE=${stage}`,
        `AGENTOR_INSTANCE_RESTORE_DATA_DIR=${this.dataDir}`,
        `AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR=${current.Id}`,
      ],
      NetworkDisabled: true,
      Labels: {
        "agentor.instance-restore-helper": "true",
        "agentor.instance-restore-job": job.id,
      },
      HostConfig: {
        NetworkMode: "none",
        Binds: binds,
        Mounts: mounts.length ? mounts : undefined,
        AutoRemove: true,
        Init: true,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216" },
        PidsLimit: 64,
        Memory: 256 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "json-file", Config: { "max-size": "1m" } },
      },
    });
    await helper.start();
    await onHandoff();
    // If validation fails before the helper stops this container, remain
    // alive long enough to ingest the terminal ledger entry it wrote. On a
    // successful apply Docker stops this process, so this wait never turns a
    // management request into a long-running call—the request already
    // returned when the durable restore job was queued.
    const result = await helper.wait();
    await this.store.reload();
    const persisted = this.store.getJob(job.id);
    if (result.StatusCode !== 0 && persisted?.status !== "failed")
      throw Object.assign(new Error("The controlled instance restore helper failed"), {
        code: "INSTANCE_RESTORE_HELPER_FAILED",
      });
  }

  private async inventory(userId: string) {
    const [services, adminStoreModule, imageModule] = await Promise.all([
      import("./services"),
      import("./admin-workspace-store"),
      import("./image-catalog"),
    ]);
    const storage = services.useStorageManager();
    await storage.init();
    const candidates = new Map<string, VolumeCandidate>();
    const add = (candidate: VolumeCandidate) => candidates.set(candidate.name, candidate);
    for (const worker of services.useWorkerStore().list()) {
      const containerName = `${useConfig().containerPrefix}-${worker.id}`;
      if (storage.mode === "volume") {
        add({ name: `${containerName}-workspace`, kind: "worker-workspace", ownerId: worker.userId, workerId: worker.id });
        add({ name: `${containerName}-agents`, kind: "worker-agent-data", ownerId: worker.userId, workerId: worker.id });
      }
      add({ name: `${containerName}-docker`, kind: "worker-dind", ownerId: worker.userId, workerId: worker.id });
    }
    const admin = adminStoreModule.useAdminWorkspaceStore().getRecord();
    if (admin) {
      const names = administrativeWorkspaceResourceNames(admin);
      add({ name: names.workspaceVolume, kind: "admin-workspace" });
      add({ name: names.agentsVolume, kind: "admin-agent-data" });
    }
    for (const group of services.useWorkerGroupStore().list()) {
      const record = group.adminWorkspace as any;
      if (!record) continue;
      const names = administrativeWorkspaceResourceNames(record);
      add({ name: names.workspaceVolume, kind: "admin-workspace", ownerId: group.userId, groupId: group.id });
      add({ name: names.agentsVolume, kind: "admin-agent-data", ownerId: group.userId, groupId: group.id });
    }
    if (storage.mode === "volume")
      add({ name: "agentor-traefik-certs", kind: "traefik-certificates" });
    const persistent = await this.docker.listVolumes({
      filters: { label: ["agentor.persistent-backup-path=true"] },
    });
    for (const volume of persistent.Volumes ?? [])
      if (volume.Name)
        add({
          name: volume.Name,
          kind: "persistent-path",
          workerId: volume.Labels?.["agentor.worker-id"],
        });
    const volumes: VolumeCandidate[] = [];
    for (const candidate of candidates.values())
      if (await this.volumeExists(candidate.name)) volumes.push(candidate);
    const definitions = services.usePluginDefinitionStore().list();
    const installations = services.usePluginInstallationStore().list();
    const catalog = imageModule.useImageCatalogManager();
    await catalog.init();
    const images = catalog.list(userId, true);
    const immutableDigests = [
      ...new Set(
        images.flatMap((definition) =>
          definition.versions
            .map((version) => version.digest)
            .filter((digest) => /^sha256:[a-f0-9]{64}$/.test(digest)),
        ),
      ),
    ];
    return {
      volumes,
      plugins: {
        platformDefinitionCount: definitions.filter((item) => item.userId === null).length,
        ownerDefinitionCount: definitions.filter((item) => item.userId !== null).length,
        installationCount: installations.length,
      },
      hostMounts: {
        configuredPaths: services.useHostMountStore().listCatalog().map((item) => item.sourcePath),
        contentsIncluded: false as const,
      },
      images: {
        definitions: images.length,
        immutableDigests,
        layersIncluded: false as const,
      },
      storage: {
        mode: storage.mode,
        containerPrefix: useConfig().containerPrefix,
      },
    };
  }

  private async defaultPreflight() {
    const [services, adminStoreModule, imageModule] = await Promise.all([
      import("./services"),
      import("./admin-workspace-store"),
      import("./image-catalog"),
    ]);
    const activeWorkers = services
      .useContainerManager()
      .list()
      .filter((worker) => worker.status === "running" || worker.status === "creating");
    const admin = adminStoreModule.useAdminWorkspaceStore().getRecord();
    const activeGroupAdmins = services
      .useWorkerGroupStore()
      .list()
      .filter((group) => {
        const status = (group.adminWorkspace as any)?.status;
        return Boolean(status) && status !== "stopped";
      });
    if (activeWorkers.length || admin?.status === "running" || activeGroupAdmins.length)
      throw Object.assign(
        new Error(
          "Stop all ordinary, platform-admin, and group-admin workspaces before creating a full instance backup.",
        ),
        {
          statusCode: 409,
          code: "INSTANCE_BACKUP_WORKSPACES_ACTIVE",
        },
      );
    if (
      (await useBackupManager().hasActiveOperationsForInstanceSnapshot()) ||
      services.useExportJobManager().hasActiveOperationsForInstanceSnapshot() ||
      imageModule.useImageCatalogManager().hasActiveOperationsForInstanceSnapshot() ||
      services.useUsageChecker().hasActiveOperationsForInstanceSnapshot() ||
      services.useOrphanSweeper().hasActiveOperationsForInstanceSnapshot()
    )
      throw Object.assign(
        new Error(
          "Wait for portable backup, export, image build, validation, usage refresh, orphan cleanup, and restore jobs to finish before creating a full instance snapshot.",
        ),
        {
          statusCode: 409,
          code: "INSTANCE_BACKUP_JOBS_ACTIVE",
        },
      );
  }

  private async snapshotVolume(
    volumeName: string,
    output: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!(await this.volumeExists(volumeName))) return false;
    const hostname = process.env.HOSTNAME;
    if (!hostname) throw new Error("Orchestrator container identity is unavailable");
    const source = await this.docker.getContainer(hostname).inspect();
    const helper = await this.docker.createContainer({
      Image: source.Config.Image,
      name: `agentor-instance-snapshot-${randomUUID()}`,
      Entrypoint: ["sleep"],
      Cmd: ["300"],
      NetworkDisabled: true,
      Labels: { "agentor.instance-backup-helper": "true" },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Mounts: [
          {
            Type: "volume",
            Source: volumeName,
            Target: "/source",
            ReadOnly: true,
          },
        ],
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216" },
        PidsLimit: 32,
        Memory: 128 * 1024 * 1024,
        NanoCpus: 500_000_000,
        LogConfig: { Type: "none", Config: {} },
      },
    });
    const raw = `${output}.raw`;
    const sanitized = `${output}.tar`;
    try {
      await helper.start();
      await pipeline(
        (await helper.getArchive({ path: "/source" })) as NodeJS.ReadableStream,
        createWriteStream(raw, { mode: 0o600 }),
        { signal },
      );
      await sanitizeBackupPathTarPayload(raw, sanitized, "/", signal);
      await pipeline(
        createReadStream(sanitized),
        createGzip({ level: 6 }),
        createWriteStream(output, { mode: 0o600 }),
        { signal },
      );
      return true;
    } finally {
      await helper.remove({ force: true }).catch(() => {});
      await rm(raw, { force: true }).catch(() => {});
      await rm(sanitized, { force: true }).catch(() => {});
    }
  }

  private async volumeExists(name: string) {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (error: any) {
      if (error?.statusCode === 404) return false;
      throw error;
    }
  }

  private provider(kind: BackupProviderKind): BackupProvider {
    const provider = this.backupManager.instanceBackupProvider(kind);
    if (!provider)
      throw Object.assign(new Error("Unknown instance backup provider"), {
        statusCode: 400,
      });
    return provider;
  }

  private findRequest(
    userId: string,
    operation: InstanceBackupJob["operation"],
    requestId: string | undefined,
    fingerprint: string,
  ) {
    if (!requestId) return undefined;
    const existing = this.store
      .listJobs()
      .find(
        (job) =>
          job.userId === userId &&
          job.operation === operation &&
          job.requestId === requestId,
      );
    if (!existing) return undefined;
    if (existing.requestFingerprint !== fingerprint)
      throw Object.assign(
        new Error(
          "The request identity is already associated with different instance backup arguments",
        ),
        { statusCode: 409 },
      );
    return existing;
  }

  private enqueue(
    jobId: string,
    run: QueuedOperation["run"],
  ) {
    this.queue.push({ jobId, run });
    setImmediate(() => this.dispatch());
  }

  private dispatch() {
    while (this.accepting && this.active < MAX_CONCURRENT_JOBS && this.queue.length) {
      const operation = this.queue.shift()!;
      const job = this.store.getJob(operation.jobId);
      if (!job || job.status !== "queued") continue;
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      this.active += 1;
      const task = operation
        .run(job, controller.signal)
        .catch((error) => this.fail(job, error))
        .finally(() => {
          this.releaseRestoreBarrier(job.id);
          this.controllers.delete(job.id);
          this.tasks.delete(job.id);
          this.active -= 1;
          this.dispatch();
        });
      this.tasks.set(job.id, task);
    }
  }

  private async running(job: InstanceBackupJob, phase: string, message: string) {
    const stamp = new Date().toISOString();
    job.status = "running";
    job.phase = phase;
    job.startedAt ??= stamp;
    job.updatedAt = stamp;
    job.logs = appendLog(job.logs, message);
    await this.store.saveJob(job);
  }

  private async phase(
    job: InstanceBackupJob,
    phase: string,
    progress: number,
    message: string,
  ) {
    job.phase = phase;
    job.progress = Math.max(job.progress, Math.min(99, progress));
    job.updatedAt = new Date().toISOString();
    job.logs = appendLog(job.logs, message);
    await this.store.saveJob(job);
  }

  private async succeeded(job: InstanceBackupJob, phase: string, message: string) {
    const stamp = new Date().toISOString();
    job.status = "succeeded";
    job.phase = phase;
    job.progress = 100;
    job.updatedAt = stamp;
    job.completedAt = stamp;
    job.durationMs = job.startedAt
      ? Math.max(0, Date.parse(stamp) - Date.parse(job.startedAt))
      : 0;
    job.logs = appendLog(job.logs, message);
    await this.store.saveJob(job);
  }

  private async fail(job: InstanceBackupJob, error: unknown) {
    const persisted = this.store.getJob(job.id);
    if (persisted?.status === "cancelled") return;
    const cancelled =
      error instanceof Error &&
      (error.name === "AbortError" || /cancelled/i.test(error.message));
    const publicFailure = publicInstanceFailure(error);
    const stamp = new Date().toISOString();
    job.status = cancelled ? "cancelled" : "failed";
    job.phase = cancelled ? "cancelled" : "failed";
    job.progress = 100;
    job.error = cancelled ? undefined : publicFailure.message;
    job.errorCode = cancelled ? undefined : publicFailure.code;
    job.retryable = cancelled ? undefined : publicFailure.retryable;
    job.updatedAt = stamp;
    job.completedAt = stamp;
    job.logs = appendLog(
      job.logs,
      cancelled ? "Operation cancelled." : publicFailure.message,
    );
    delete job.pendingProviderObjectId;
    delete job.pendingProviderUploadId;
    await this.store.saveJob(job);
  }

  private async publicRemote(record: RemoteInstanceBackupRecord) {
    const keyAvailable = record.keyFingerprint
      ? Boolean(
          await this.backupManager.resolveInstanceRecoveryMaterial(
            record.userId,
            record.keyFingerprint,
          ),
        )
      : false;
    return {
      ...record,
      keyAvailable,
      restorable: record.state === "adopted" && Boolean(record.adoptedArtifactId),
    };
  }

  private artifactPath(id: string) {
    if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(id))
      throw new Error("Invalid instance backup artifact id");
    return join(this.artifactsDir, `${id}.backup`);
  }

  private assertAccepting() {
    if (!this.accepting)
      throw Object.assign(new Error("Instance backup manager is stopping"), {
        statusCode: 503,
      });
  }

  private releaseRestoreBarrier(jobId: string) {
    const release = this.restoreBarriers.get(jobId);
    if (!release) return;
    this.restoreBarriers.delete(jobId);
    release();
  }
}

function newJob(
  userId: string,
  operation: InstanceBackupJob["operation"],
  provider: BackupProviderKind,
  requestId: string | undefined,
  fingerprint: string,
): InstanceBackupJob {
  const stamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    userId,
    operation,
    provider,
    status: "queued",
    phase: "queued",
    progress: 0,
    bytesProcessed: 0,
    createdAt: stamp,
    updatedAt: stamp,
    ...(requestId ? { requestId } : {}),
    requestFingerprint: fingerprint,
    logs: [`${operation} queued.`],
  };
}

function normalizeOptions(
  value?: Partial<InstanceBackupOptions>,
): InstanceBackupOptions {
  const input = value ?? {};
  for (const [key, candidate] of Object.entries(input))
    if (
      !Object.prototype.hasOwnProperty.call(DEFAULT_INSTANCE_BACKUP_OPTIONS, key) ||
      typeof candidate !== "boolean"
    )
      throw Object.assign(new Error("Invalid instance backup option"), {
        statusCode: 400,
      });
  const result = { ...DEFAULT_INSTANCE_BACKUP_OPTIONS, ...input };
  if (!result.includeWorkers && result.includeAgentData)
    result.includeAgentData = false;
  return result;
}

function includeVolumeCandidate(
  candidate: VolumeCandidate,
  options: InstanceBackupOptions,
) {
  if (
    !options.includeAgentData &&
    (candidate.kind === "worker-agent-data" ||
      candidate.kind === "admin-agent-data")
  )
    return false;
  if (
    !options.includeWorkers &&
    (candidate.kind === "worker-workspace" ||
      candidate.kind === "worker-agent-data" ||
      candidate.kind === "worker-dind" ||
      candidate.kind === "persistent-path")
  )
    return false;
  return true;
}

function normalizeRestoreOptions(
  value: Partial<InstanceRestoreOptions> | undefined,
  requireConfirmation: boolean,
): InstanceRestoreOptions {
  const input = value ?? {};
  const allowed = new Set([
    "restoreDockerVolumes",
    "restoreHostMountPolicies",
    "confirmReplaceControlPlane",
    "confirmExternalDependencies",
  ]);
  for (const [key, candidate] of Object.entries(input))
    if (!allowed.has(key) || typeof candidate !== "boolean")
      throw Object.assign(new Error("Invalid instance restore option"), {
        statusCode: 400,
      });
  const normalized: InstanceRestoreOptions = {
    restoreDockerVolumes: input.restoreDockerVolumes ?? true,
    restoreHostMountPolicies: input.restoreHostMountPolicies ?? false,
    confirmReplaceControlPlane: input.confirmReplaceControlPlane ?? false,
    confirmExternalDependencies: input.confirmExternalDependencies ?? false,
  };
  if (
    requireConfirmation &&
    (!normalized.confirmReplaceControlPlane ||
      !normalized.confirmExternalDependencies)
  )
    throw Object.assign(
      new Error(
        "Instance restore requires explicit confirmation that the control-plane data will be replaced and that external dependencies have been prepared.",
      ),
      { statusCode: 400, code: "INSTANCE_RESTORE_CONFIRMATION_REQUIRED" },
    );
  return normalized;
}

function normalizeRequestId(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[a-zA-Z0-9._:-]+$/.test(value)
  )
    throw Object.assign(new Error("Invalid requestId"), { statusCode: 400 });
  return value;
}

function requestFingerprint(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function appendLog(logs: string[], message: string) {
  const safe = safeMessage(message);
  return [...logs, safe].slice(-MAX_LOG_LINES);
}

function safeMessage(value: string) {
  return value
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 2048);
}

function publicJob(job: InstanceBackupJob): PublicInstanceBackupJob {
  const {
    logs,
    pendingProviderObjectId: _pendingProviderObjectId,
    pendingProviderUploadId: _pendingProviderUploadId,
    ...result
  } = structuredClone(job);
  return { ...result, logLineCount: logs.length };
}

function publicInstanceFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const code = (error as any)?.code;
  if (
    code === "INSTANCE_BACKUP_WORKSPACES_ACTIVE" ||
    code === "INSTANCE_BACKUP_JOBS_ACTIVE" ||
    code === "INSTANCE_RESTORE_PREFLIGHT_FAILED" ||
    code === "INSTANCE_RESTORE_HELPER_FAILED"
  )
    return { code, message: safeMessage(message), retryable: true };
  if (code === "INSTANCE_BACKUP_ID_CONFLICT")
    return { code, message: safeMessage(message), retryable: false };
  if (code === "INSTANCE_BACKUP_KEY_MISSING" || /recovery key/i.test(message))
    return {
      code: "INSTANCE_BACKUP_KEY_MISSING",
      message: "The recovery key required by this instance backup is unavailable.",
      retryable: true,
    };
  if (/integrity|authentication|manifest|archive|header/i.test(message))
    return {
      code: "INSTANCE_BACKUP_INVALID",
      message: "The instance backup failed authentication or structural validation.",
      retryable: false,
    };
  const provider = publicBackupFailure(error);
  if (provider.code !== "BACKUP_FAILED") return provider;
  return {
    code: "INSTANCE_BACKUP_FAILED",
    message: "Instance backup operation failed. Inspect the bounded job logs and server logs.",
    retryable: true,
  };
}

let singleton: InstanceBackupManager | undefined;
export function useInstanceBackupManager() {
  return (singleton ??= new InstanceBackupManager());
}
