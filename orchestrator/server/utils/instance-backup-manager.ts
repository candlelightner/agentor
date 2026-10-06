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
import { isDeepStrictEqual } from 'node:util';
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
import { withOperationDeadline } from "./operation-deadline";
import { withOwnerWorkerLifecycleMutation } from './worker-lifecycle-coordinator';
import { managedVolumeRuntimeKind, assertIncusLiveResolved } from './managed-volume-store';
import { IncusError } from './incus-client';
import { incusWorkerVolumeName } from './incus-worker-storage';

const MAX_CONCURRENT_JOBS = 1;
const MAX_LOG_LINES = 1000;
const REMOTE_HEADER_BYTES = 16 * 1024;
const INSTANCE_DOCKER_READ_TIMEOUT_MS = 8_000;
const INSTANCE_DOCKER_MUTATION_TIMEOUT_MS = 30_000;
const INSTANCE_RESTORE_HELPER_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function assertSupportedInstanceRestore(manifest: InstanceBackupManifest, options: InstanceRestoreOptions) {
  if (manifest.formatVersion === 2 && !options.restoreDockerVolumes)
    throw Object.assign(new Error('Native instance restore requires canonical persistent filesystem data. Enable persistent volume restoration; disposable VM roots cannot substitute for it.'),
      { statusCode: 409, code: 'INSTANCE_RESTORE_NATIVE_DATA_REQUIRED' });
  if (![1, 2].includes(manifest.formatVersion) || manifest.formatVersion === 1 && manifest.volumes.some(volume => volume.runtime))
    throw new Error('Unsupported instance restore format');
}

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
  runtime?: InstanceBackupVolumeManifest['runtime'];
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
    /** Gate native control-plane records even if filesystem bytes are omitted. */
    nativeRuntime?: boolean;
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
  private startupChecked?: Promise<void>;
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
    const held = this.store.listJobs().filter(restoreMayOwnStage);
    for (const job of held) this.restoreBarriers.set(job.id, beginInstanceRestore(job.id));
    const retained = new Set(held.map(job => `restore-${job.id}`));
    for (const name of await readdir(this.stagingDir).catch(() => []))
      if (!retained.has(name)) await rm(join(this.stagingDir, name), { recursive: true, force: true });
    for (const job of this.store.listJobs()) {
      if (restoreMayOwnStage(job)) continue; // Never replay or overwrite a helper-owned ledger.
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
    // Settle acknowledged completed handoffs before the mutation barrier can
    // block sign-in. Reuse exact terminal observation, never waive auth writes.
    await this.refreshRestoreHolds();
  }

  async list(userId: string) {
    await this.init();
    await this.refreshRestoreHolds();
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
    await this.refreshRestoreHolds();
    const job = this.store.getJob(id);
    return job ? publicJob(job) : undefined;
  }

  async logs(id: string, after = 0, limit = 100) {
    await this.init();
    await this.refreshRestoreHolds();
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
    assertSupportedInstanceRestore(artifact.manifest, restoreOptions);
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
    if (manifest.formatVersion === 2) {
      const config = useConfig(), client = services.useIncusClient();
      try {
        if (!config.incusEnabled || !config.incusEndpoint.startsWith('https://') ||
            !config.incusClientCertPath || !config.incusClientKeyPath || !config.incusServerCertPath ||
            !config.incusProject || config.incusProject === 'default' || !config.incusStoragePool || !config.incusNetwork)
          throw new Error('Native restore requires enabled restricted HTTPS/mTLS Incus configuration');
        const readiness = await client.getReadiness();
        if (!readiness.ready || readiness.auth !== 'trusted' || readiness.project !== config.incusProject)
          throw new Error('Native restore destination is not ready in the configured Incus project');
        const project = await client.request<{ name: string; config: Record<string, string> }>('GET',
          '/1.0/projects/' + encodeURIComponent(config.incusProject));
        if (project.name !== config.incusProject || project.config.restricted !== 'true' ||
            project.config['features.storage.volumes'] !== 'true' || project.config['restricted.devices.nic'] !== 'managed' ||
            !(project.config['restricted.networks.access'] ?? '').split(',').map(value => value.trim()).includes(config.incusNetwork))
          throw new Error('Native restore requires the configured restricted project, managed NICs, worker network and private storage');
        await client.request('GET', '/1.0/storage-pools/' + encodeURIComponent(config.incusStoragePool));
        const network = await client.getNetwork(config.incusNetwork);
        if (!network.managed || network.type !== 'bridge' || network.name !== config.incusNetwork)
          throw new Error('The configured native worker network is unavailable');

        // Descriptive bundle IDs determine names, never project/pool/device
        // authority. Probe hidden core roles too: omitted agent/Docker data
        // must not overwrite destination state created outside this manifest.
        const native = manifest.volumes.filter(volume => volume.runtime);
        const workers = new Map<string, string>(), names = new Set(native.map(volume => volume.name));
        for (const volume of native) {
          if (!volume.workerId || !volume.ownerId) throw new Error('Native restore storage identity is incomplete');
          const owner = workers.get(volume.workerId);
          if (owner && owner !== volume.ownerId) throw new Error('Native restore worker ownership is ambiguous');
          workers.set(volume.workerId, volume.ownerId);
        }
        const absent = async (load: () => Promise<unknown>, name: string, volume: boolean) => {
          try {
            await load();
            if (volume) volumeConflicts.push(name);
            else blockers.push(`Destination Incus instance ${name} already exists; safe restore will not replace it.`);
          } catch (error) {
            if (!(error instanceof IncusError) || error.statusCode !== 404) throw error;
          }
        };
        for (const [id, userId] of workers) {
          const containerName = config.containerPrefix + '-' + id;
          for (const role of ['workspace', 'agents', 'docker'] as const)
            names.add(incusWorkerVolumeName({ id, userId, containerName }, config.containerPrefix, role));
          await absent(() => client.getInstance(containerName), containerName, false);
        }
        for (const name of names) await absent(() => client.getCustomVolume(config.incusStoragePool, name), name, true);
      } catch {
        // Never reinterpret inaccessible native resources as absent or fall
        // through to Docker. Staged helper freshness remains definitive.
        blockers.push('Incus restore readiness or destination absence could not be verified. Check the configured restricted project, mTLS credentials, network and storage pool before retrying.');
      }
    }
    const legacyVolumes = manifest.volumes.filter(volume => !volume.runtime);
    if (restoreOptions.restoreDockerVolumes) {
      const existingVolumes = legacyVolumes.length ? new Set(
        ((
          await withOperationDeadline(
            (operationSignal) => this.docker.listVolumes({
              abortSignal: operationSignal,
            }),
            INSTANCE_DOCKER_READ_TIMEOUT_MS,
            "Docker instance-restore volume inventory",
          )
        ).Volumes ?? [])
          .map((volume) => volume.Name)
          .filter((name): name is string => Boolean(name)),
      ) : new Set<string>();
      for (const volume of legacyVolumes)
        if (existingVolumes.has(volume.name)) volumeConflicts.push(volume.name);
    }
    if (volumeConflicts.length)
      blockers.push(
        "One or more destination persistent volumes already exist. Agentor will not overwrite them during a safe instance restore.",
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
    if (restoreMayOwnStage(current))
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
    for (const jobId of [...this.restoreBarriers.keys()]) {
      const job = this.store.getJob(jobId);
      if (job && !restoreMayOwnStage(job)) this.releaseRestoreBarrier(jobId);
    }
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
        const captured = new Set<string>();
        for (const candidate of selectedVolumes) {
          signal.throwIfAborted();
          if (captured.has(candidate.name)) continue;
          const group = candidate.runtime && candidate.runtime.role !== 'docker' && candidate.runtime.role !== 'managed'
            ? selectedVolumes.filter(other => other.workerId === candidate.workerId && other.ownerId === candidate.ownerId &&
              other.runtime && (other.runtime.role === 'workspace' || other.runtime.role === 'agents')) : [candidate];
          const outputs = group.map((volume, offset) => ({ volume, path: join(stage, `volume-${index + offset}.tar.gz`) }));
          if (candidate.runtime) await this.snapshotNativeVolumes(outputs, signal);
          else if (!await this.snapshotVolume(candidate.name, outputs[0]!.path, signal)) continue;
          for (const { volume, path: output } of outputs) {
            const info = await stat(output);
            volumes.push({
              manifest: {
                ...volume,
                archive: instanceVolumeArchiveName(volume.name),
                sha256: await sha256File(output),
                size: info.size,
              },
              path: output,
            });
            captured.add(volume.name);
            index += 1;
          }
          await this.phase(
            job,
            "volume-snapshot",
            25 + Math.floor((index / Math.max(1, selectedVolumes.length)) * 35),
            `Snapshotted persistent volume ${index} of ${selectedVolumes.length}.`,
          );
        }
      }
      releaseSnapshot();
      releaseSnapshot = undefined;
      const createdAt = new Date().toISOString();
      const sourceInstallationId = await backupInstallationId(this.dataDir);
      const formatVersion = inventory.nativeRuntime || inventory.volumes.some(volume => volume.runtime) ? 2 : 1;
      const manifest: InstanceBackupManifest = {
        kind: "agentor-instance-backup",
        formatVersion,
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
      await this.phase(job, "verifying", 70, "Validating the manifest and every nested archive before encryption.");
      await inspectInstanceBundle(bundle, join(stage, "verification"), signal);
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
          formatVersion,
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
            formatVersion,
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
        formatVersion,
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
          header.metadata.sourceInstallationId || inspected.manifest.formatVersion !== header.metadata.formatVersion ||
        inspected.manifest.createdAt !== header.metadata.createdAt
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
        formatVersion: inspected.manifest.formatVersion,
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
        inspected.manifest.sourceInstallationId !== header.metadata.sourceInstallationId ||
        inspected.manifest.formatVersion !== header.metadata.formatVersion || inspected.manifest.createdAt !== header.metadata.createdAt
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
        formatVersion: inspected.manifest.formatVersion,
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
        inspected.manifest.sourceInstallationId !== artifact.sourceInstallationId ||
        inspected.manifest.formatVersion !== artifact.formatVersion || inspected.manifest.createdAt !== artifact.createdAt ||
        inspected.manifest.backupId !== header.metadata.backupId ||
        inspected.manifest.sourceInstallationId !== header.metadata.sourceInstallationId ||
        inspected.manifest.formatVersion !== header.metadata.formatVersion || inspected.manifest.createdAt !== header.metadata.createdAt
      )
        throw new Error("Retained instance artifact identity does not match its manifest");
      assertSupportedInstanceRestore(inspected.manifest, options);
      const preflight = await this.restorePreflight(job.userId, artifact.id, options);
      if (!preflight.ready)
        throw Object.assign(new Error(preflight.blockers.join(" ")), {
          code: "INSTANCE_RESTORE_PREFLIGHT_FAILED",
          statusCode: 409,
        });
      const plan = {
        version: 1,
        formatVersion: inspected.manifest.formatVersion,
        jobId: job.id,
        dataArchive: inspected.dataArchivePath,
        volumes: options.restoreDockerVolumes
          ? inspected.manifest.volumes.map((volume) => ({
              name: volume.name,
              archive: inspected.volumeArchives.get(volume.name),
              kind: volume.kind,
              ...(volume.workerId ? { workerId: volume.workerId } : {}),
              ...(volume.runtime ? { runtime: volume.runtime, ownerId: volume.ownerId } : {}),
            }))
          : [],
        restoreHostMountPolicies: options.restoreHostMountPolicies,
        sourceInstallationId: inspected.manifest.sourceInstallationId,
        restoredOwnerId: inspected.manifest.createdByUserId,
        stagingOwnerId: job.userId,
        ...(inspected.manifest.formatVersion === 2 ? { manifest: inspected.manifest } : {}),
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
      await this.launchRestoreHelper(job, stage, signal, async () => {
        helperOwnsStage = true;
        await this.phase(
          job,
          "applying",
          70,
          "Controlled helper started and owns the staged restore.",
        );
      }, inspected.manifest.formatVersion === 2);
      // The helper owns the terminal status because this process is about to be
      // stopped. It updates the persisted job before restarting the orchestrator.
    } catch (error) {
      if ((error as { code?: string })?.code === 'INSTANCE_RESTORE_HELPER_NOT_STARTED') helperOwnsStage = false;
      throw error;
    } finally {
      // Ownership transfers BEFORE a start request can execute remotely.
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
    signal: AbortSignal,
    onHandoff: () => Promise<void>,
    native = false,
  ) {
    const hostname = process.env.HOSTNAME;
    if (!hostname) throw new Error("Orchestrator container identity is unavailable");
    const current = await withOperationDeadline(
      (operationSignal) => this.docker.getContainer(hostname).inspect({
        abortSignal: operationSignal,
      }),
      INSTANCE_DOCKER_READ_TIMEOUT_MS,
      "Docker instance-restore orchestrator inspection",
      signal,
    );
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
    const environment = [
      `AGENTOR_INSTANCE_RESTORE_JOB=${job.id}`,
      `AGENTOR_INSTANCE_RESTORE_STAGE=${stage}`,
      `AGENTOR_INSTANCE_RESTORE_DATA_DIR=${this.dataDir}`,
      `AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR=${current.Id}`,
    ];
    let network = 'none';
    let extraHosts: string[] | undefined;
    if (native) {
      const config = useConfig();
      if (!config.incusEnabled || !config.incusEndpoint.startsWith('https://') ||
          !config.dockerNetwork || !current.NetworkSettings?.Networks?.[config.dockerNetwork])
        throw new Error('Native restore requires current restricted Incus configuration and the verified control-plane network');
      network = config.dockerNetwork;
      const hosts = new Set([config.incusEndpoint, ...(config.incusNetworkHostEndpoint ? [config.incusNetworkHostEndpoint] : [])]
        .map(endpoint => new URL(endpoint).hostname));
      // Preserve only operator-defined resolution for the two fixed endpoints,
      // not arbitrary bindings from restored data or the full environment.
      extraHosts = current.HostConfig?.ExtraHosts?.filter((entry: string) =>
        [...hosts].some(host => entry.startsWith(host + ':')));
      environment.push('AGENTOR_INSTANCE_RESTORE_NATIVE=true');
      const fields = {
        CONTAINER_PREFIX: config.containerPrefix, INCUS_ENDPOINT: config.incusEndpoint, INCUS_PROJECT: config.incusProject,
        INCUS_CLIENT_CERT_PATH: config.incusClientCertPath, INCUS_CLIENT_KEY_PATH: config.incusClientKeyPath,
        INCUS_SERVER_CERT_PATH: config.incusServerCertPath, INCUS_NETWORK: config.incusNetwork,
        INCUS_STORAGE_POOL: config.incusStoragePool, INCUS_WORKER_IMAGE: config.incusWorkerImage,
        INCUS_DOCKER_VOLUME_SIZE: config.incusDockerVolumeSize, INCUS_INTERNAL_GATEWAY_URL: config.incusInternalGatewayUrl,
        INCUS_NETWORK_HOST_ENDPOINT: config.incusNetworkHostEndpoint || '',
        INCUS_NETWORK_HOST_SERVER_CERT_PATH: config.incusNetworkHostServerCertPath || '',
      };
      environment.push(...Object.entries(fields).map(([key, value]) => `${key}=${value}`));
      if (process.env.WORKER_CONFIG_ENCRYPTION_KEY)
        environment.push(`WORKER_CONFIG_ENCRYPTION_KEY=${process.env.WORKER_CONFIG_ENCRYPTION_KEY}`);
      const credentials = new Set([config.incusClientCertPath, config.incusClientKeyPath, config.incusServerCertPath,
        ...(config.incusNetworkHostServerCertPath ? [config.incusNetworkHostServerCertPath] : [])]);
      for (const path of credentials) {
        if (!path.startsWith('/') || path === '/' || path.includes('\0'))
          throw new Error('Native restore requires explicit credential file mounts');
        const source = current.Mounts?.filter(mount => mount.Type === 'bind' && mount.Destination &&
          (path === mount.Destination || path.startsWith(mount.Destination.replace(/\/$/, '') + '/')))
          .sort((a, b) => b.Destination.length - a.Destination.length)[0];
        if (!source?.Source || !source.Source.startsWith('/'))
          throw new Error('Native restore credentials must use operator-controlled bind mounts');
        mounts.push({ Type: 'bind', Source: join(source.Source, path.slice(source.Destination.length)),
          Target: path, ReadOnly: true } as Docker.MountSettings);
      }
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(current.Image))
      throw new Error('Restore requires the inspected immutable orchestrator image');
    const helper = await withOperationDeadline((operationSignal) => this.docker.createContainer({
      Image: current.Image,
      name: `agentor-instance-restore-${job.id}`,
      User: "0:0",
      Cmd: ["node", ".output/server/instance-restore-helper.mjs"],
      WorkingDir: "/app",
      Env: environment,
      NetworkDisabled: !native,
      Labels: {
        "agentor.instance-restore-helper": "true",
        "agentor.instance-restore-job": job.id,
      },
      HostConfig: {
        NetworkMode: network,
        ...(extraHosts?.length ? { ExtraHosts: extraHosts } : {}),
        Binds: binds,
        Mounts: mounts.length ? mounts : undefined,
        AutoRemove: false, // Exact terminal evidence survives a parent restart/lost start acknowledgement.
        Init: true,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216" },
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
        PidsLimit: 64,
        Memory: 256 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "json-file", Config: { "max-size": "1m" } },
      },
      abortSignal: operationSignal,
    }), INSTANCE_DOCKER_MUTATION_TIMEOUT_MS, "Docker instance-restore helper creation", signal);
    if (!/^[a-f0-9]{64}$/.test(helper.id)) throw new Error('Restore helper creation lacks an exact identity');
    job.restoreHelper = { containerId: helper.id, imageId: current.Image };
    try {
      await onHandoff();
      signal.throwIfAborted();
      await withOperationDeadline(
        (operationSignal) => helper.start({ abortSignal: operationSignal }),
        INSTANCE_DOCKER_MUTATION_TIMEOUT_MS,
        "Docker instance-restore helper start",
        signal,
      );
    } catch (error) {
      const observed = await this.inspectRestoreHelper(job).catch(() => undefined);
      if (observed && restoreHelperNeverStarted(observed)) {
        await withOperationDeadline((operationSignal) => helper.remove({ force: false, abortSignal: operationSignal } as
          Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }), INSTANCE_DOCKER_MUTATION_TIMEOUT_MS,
          'Docker exact never-started restore helper cleanup');
        delete job.restoreHelper;
        throw Object.assign(new Error('The restore helper never started; the original control plane was not replaced'),
          { code: 'INSTANCE_RESTORE_HELPER_NOT_STARTED' });
      }
      throw Object.assign(new Error('Restore helper start acknowledgement is unsettled; retain exact helper and staging, do not retry'),
        { code: 'INSTANCE_RESTORE_HELPER_UNCERTAIN' });
    }
    // If validation fails before the helper stops this container, remain
    // alive long enough to ingest the terminal ledger entry it wrote. On a
    // successful apply Docker stops this process, so this wait never turns a
    // management request into a long-running call—the request already
    // returned when the durable restore job was queued.
    const result = await withOperationDeadline(
      (operationSignal) => helper.wait({ abortSignal: operationSignal }),
      INSTANCE_RESTORE_HELPER_TIMEOUT_MS,
      "Docker instance-restore helper completion",
      signal,
    );
    await this.store.reload();
    const persisted = this.store.getJob(job.id);
    const completed = await this.inspectRestoreHelper(job);
    if (persisted && restoreHelperSettled(persisted, completed) && result.StatusCode === completed.State.ExitCode) {
      await helper.remove({ force: false });
      delete persisted.restoreHelper;
      await this.store.saveJob(persisted);
    } else throw Object.assign(new Error('Restore helper exit and completion ledger disagree; retain helper, stage and fences'),
      { code: 'INSTANCE_RESTORE_HELPER_UNCERTAIN' });
    if (result.StatusCode !== 0 && persisted?.status !== "failed")
      throw Object.assign(new Error("The controlled instance restore helper failed"), {
        code: "INSTANCE_RESTORE_HELPER_FAILED",
      });
  }

  /** Exact acknowledged identity only; a name or a404 never proves settlement. */
  private async inspectRestoreHelper(job: InstanceBackupJob): Promise<Docker.ContainerInspectInfo> {
    const identity = job.restoreHelper;
    if (!identity) throw new Error('Restore helper acknowledgement is unavailable');
    const info = await withOperationDeadline(signal => this.docker.getContainer(identity.containerId).inspect({ abortSignal: signal }),
      INSTANCE_DOCKER_READ_TIMEOUT_MS, 'Docker exact restore helper inspection');
    const env = info.Config?.Env ?? [];
    if (info.Id !== identity.containerId || info.Image !== identity.imageId ||
        info.Config?.Labels?.['agentor.instance-restore-helper'] !== 'true' ||
        info.Config?.Labels?.['agentor.instance-restore-job'] !== job.id ||
        !env.includes(`AGENTOR_INSTANCE_RESTORE_JOB=${job.id}`) ||
        !env.includes(`AGENTOR_INSTANCE_RESTORE_DATA_DIR=${this.dataDir}`) ||
        !env.includes(`AGENTOR_INSTANCE_RESTORE_STAGE=${join(this.stagingDir, `restore-${job.id}`)}`))
      throw new Error('Exact restore helper authority differs from its acknowledgement');
    return info;
  }

  /** Run before any startup writes/migrations: an unexpected parent restart
   * must not open auth.db while a helper is swapping the same DATA mount. */
  assertStartupSafe(): Promise<void> {
    return (this.startupChecked ??= this.checkStartupSafe());
  }

  private async checkStartupSafe(): Promise<void> {
    const hostname = process.env.HOSTNAME;
    if (!hostname) throw new Error('Startup container identity is unavailable');
    const current = await withOperationDeadline(signal => this.docker.getContainer(hostname).inspect({ abortSignal: signal }),
      INSTANCE_DOCKER_READ_TIMEOUT_MS, 'Docker startup DATA mount inspection');
    const data = current.Mounts?.find(mount => mount.Destination === this.dataDir);
    if (!data) throw new Error('Startup DATA mount authority is unavailable');
    const helpers = await withOperationDeadline(signal => this.docker.listContainers({ all: false,
      filters: { label: ['agentor.instance-restore-helper=true'] }, abortSignal: signal }),
      INSTANCE_DOCKER_READ_TIMEOUT_MS, 'Docker running restore helpers');
    if (helpers.some(helper => helper.Id !== current.Id && helper.Mounts?.some(mount =>
      mount.Destination === this.dataDir && mount.Type === data.Type && mount.Source === data.Source &&
      (data.Type !== 'volume' || mount.Name === data.Name))))
      throw Object.assign(new Error('A restore helper is still executing against this DATA mount; wait for it to exit before restarting Agentor'),
        { code: 'INSTANCE_RESTORE_HELPER_ACTIVE', statusCode: 503 });
  }

  /** Status reads observe orphaned handoffs using existing job state, not a
   * new watcher or replay mechanism. Success alone is not terminal proof while
   * the helper may still be clearing fences/restarting its exact parent. */
  private async refreshRestoreHolds(): Promise<void> {
    if (!this.restoreBarriers.size) return;
    const orphaned = [...this.restoreBarriers.keys()].filter(id => !this.tasks.has(id));
    if (!orphaned.length) return;
    await this.store.reload();
    for (const id of orphaned) {
      const job = this.store.getJob(id);
      if (!job || restoreQuarantined(job) || !job.restoreHelper ||
          !['succeeded', 'failed', 'cancelled'].includes(job.status)) continue;
      const info = await this.inspectRestoreHelper(job).catch(() => undefined);
      if (!info || !restoreHelperSettled(job, info)) continue;
      await withOperationDeadline(signal => this.docker.getContainer(job.restoreHelper!.containerId)
        .remove({ force: false, abortSignal: signal } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
        INSTANCE_DOCKER_MUTATION_TIMEOUT_MS, 'Docker settled restore helper cleanup');
      delete job.restoreHelper;
      await this.store.saveJob(job);
      await rm(join(this.stagingDir, `restore-${id}`), { recursive: true, force: true });
      this.releaseRestoreBarrier(id);
    }
  }

  private async inventory(userId: string) {
    const [services, adminStoreModule, imageModule] = await Promise.all([
      import("./services"),
      import("./admin-workspace-store"),
      import("./image-catalog"),
    ]);
    const storage = services.useStorageManager();
    await storage.init();
    const { useManagedVolumeManager } = await import('./managed-volume-manager');
    const managedVolumes = useManagedVolumeManager(); await managedVolumes.init();
    const workers = services.useWorkerStore().list();
    const managedRecords = managedVolumes.store.list();
    const nativeWorkers = new Set(workers.filter(worker => worker.runtimeKind === 'incus-vm').map(worker => worker.id));
    const managedNames = new Set(managedRecords.map(volume => volume.dockerName));
    const nativeNames = new Set([...nativeWorkers].flatMap(id =>
      ['workspace', 'agents', 'docker'].map(role => `${useConfig().containerPrefix}-${id}-${role}`)));
    const candidates = new Map<string, VolumeCandidate>();
    const add = (candidate: VolumeCandidate) => {
      if (candidates.has(candidate.name)) throw new Error('Instance backup has conflicting logical volume authority');
      candidates.set(candidate.name, candidate);
    };
    for (const worker of workers) {
      const containerName = `${useConfig().containerPrefix}-${worker.id}`;
      if (worker.runtimeKind === 'incus-vm') {
        const state = await withOwnerWorkerLifecycleMutation(worker.userId, worker.id, () =>
          services.useContainerManager().inspectInstanceBackupStorageWithLifecycleFenceHeld(worker.id));
        if (state.runtime.kind !== 'incus-vm') throw new Error('Native instance inventory returned another runtime');
        for (const role of ['workspace', 'agents', ...(state.docker ? ['docker' as const] : [])] as const)
          add({ name: `${containerName}-${role}`, ownerId: worker.userId, workerId: worker.id,
            kind: role === 'workspace' ? 'worker-workspace' : role === 'agents' ? 'worker-agent-data' : 'worker-dind',
            runtime: role === 'workspace'
              ? { kind: 'incus-vm', role, source: state.runtime.source, dockerData: state.docker }
              : { kind: 'incus-vm', role, source: state.runtime.source } });
        continue;
      }
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
    const persistent = await withOperationDeadline(
      (operationSignal) => this.docker.listVolumes({
        filters: { label: ["agentor.persistent-backup-path=true"] },
        abortSignal: operationSignal,
      }),
      INSTANCE_DOCKER_READ_TIMEOUT_MS,
      "Docker persistent backup-volume inventory",
    );
    for (const volume of persistent.Volumes ?? [])
      if (volume.Name && !nativeNames.has(volume.Name) && !managedNames.has(volume.Name) &&
          !nativeWorkers.has(volume.Labels?.['agentor.worker-id'] ?? ''))
        add({
          name: volume.Name,
          kind: "persistent-path",
          workerId: volume.Labels?.["agentor.worker-id"],
        });
    const volumes: VolumeCandidate[] = [];
    for (const volume of managedRecords) {
      if (managedVolumeRuntimeKind(volume) === 'incus-vm') {
        assertIncusLiveResolved(volume);
        const found = await managedVolumes.incusRuntime.inspectVolume(volume);
        if (!found && !volume.seeded && ['pending', 'detached'].includes(volume.state) && !volume.operation) continue;
        if (!volume.seeded || volume.state !== (volume.attached ? 'ready' : 'detached') ||
            volume.operation && volume.operation.stage !== 'complete')
          throw new Error('Complete pending native managed storage before creating an instance backup');
        if (!found)
          throw new Error('Canonical native managed storage is missing; restore it before creating an instance backup');
        add({ name: volume.dockerName, kind: 'persistent-path', ownerId: volume.userId, workerId: volume.workerId,
          runtime: { kind: 'incus-vm', role: 'managed', managedVolumeId: volume.id, target: volume.target } });
        continue;
      }
      if (nativeWorkers.has(volume.workerId)) throw new Error('Worker and managed storage runtime authority disagree');
      if (!await managedVolumes.runtime.inspectVolume(volume)) continue;
      add({ name: volume.dockerName, kind: "persistent-path", ownerId: volume.userId, workerId: volume.workerId });
    }
    for (const candidate of candidates.values())
      if (candidate.runtime || await this.volumeExists(candidate.name)) volumes.push(candidate);
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
      nativeRuntime: nativeWorkers.size > 0 || managedRecords.some(volume => managedVolumeRuntimeKind(volume) === 'incus-vm'),
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
    await (await import('./incus-offline-archive-helper')).assertOfflineArchiveHelpersSettled(this.dataDir);
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
      useManagedVolumeManager().hasActiveOperationsForInstanceSnapshot() ||
      (await import("./managed-volume-sizing")).useManagedVolumeSizingManager().hasActiveOperationsForInstanceSnapshot() ||
      (await import("./portable-managed-volume-runtime")).usePortableManagedVolumeRuntime().hasActiveOperationsForInstanceSnapshot() ||
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

  private async snapshotNativeVolumes(outputs: Array<{ volume: VolumeCandidate; path: string }>, signal: AbortSignal) {
    const first = outputs[0]?.volume;
    if (!first?.runtime || !first.ownerId || !first.workerId) throw new Error('Native instance capture identity is missing');
    const descriptor = first.runtime, ownerId = first.ownerId, workerId = first.workerId;
    const services = await import('./services');
    await withOwnerWorkerLifecycleMutation(ownerId, workerId, async () => {
      signal.throwIfAborted();
      const containers = services.useContainerManager();
      if (descriptor.role === 'workspace' || descriptor.role === 'agents') {
        const paths: { workspace?: string; agents?: string } = {};
        for (const { volume, path } of outputs) {
          if (!volume.runtime || volume.ownerId !== first.ownerId || volume.workerId !== first.workerId ||
              volume.runtime.role !== 'workspace' && volume.runtime.role !== 'agents' ||
              !isDeepStrictEqual(volume.runtime.source, descriptor.source) || paths[volume.runtime.role])
            throw new Error('Native canonical instance capture roles disagree');
          paths[volume.runtime.role] = path;
        }
        const workspace = outputs.find(({ volume }) => volume.runtime?.role === 'workspace')?.volume.runtime;
        const proveDockerData = async () => {
          if (workspace?.role !== 'workspace') return;
          const state = await containers.inspectInstanceBackupStorageWithLifecycleFenceHeld(workerId);
          if (typeof workspace.dockerData !== 'boolean' || state.docker !== workspace.dockerData ||
              state.runtime.kind !== 'incus-vm' || !isDeepStrictEqual(state.runtime.source, workspace.source))
            throw new Error('Native canonical Docker data presence changed after instance inventory');
        };
        await proveDockerData();
        const result = await containers.captureInstanceCanonicalWithLifecycleFenceHeld(workerId, paths, signal);
        if (result.runtime.kind !== 'incus-vm' || !isDeepStrictEqual(result.runtime.source, descriptor.source))
          throw new Error('Native immutable source changed after instance inventory');
        await proveDockerData();
        return;
      }
      if (outputs.length !== 1) throw new Error('Native instance raw capture must select exactly one role');
      const output = outputs[0]!.path, raw = output + '.raw';
      try {
        if (descriptor.role === 'docker') {
          const state = await containers.inspectInstanceBackupStorageWithLifecycleFenceHeld(workerId);
          if (!state.docker || state.runtime.kind !== 'incus-vm' ||
              !isDeepStrictEqual(state.runtime.source, descriptor.source))
            throw new Error('Native Docker instance inventory changed');
          await containers.captureInstanceDockerWithLifecycleFenceHeld(workerId, raw, signal);
        } else {
          const { useManagedVolumeManager } = await import('./managed-volume-manager');
          const managed = useManagedVolumeManager(); await managed.init();
          if (descriptor.role !== 'managed') throw new Error('Unknown native instance archive role');
          const record = managed.store.get(ownerId, descriptor.managedVolumeId);
          if (!record || record.dockerName !== first.name || record.workerId !== first.workerId || record.target !== descriptor.target)
            throw new Error('Native managed instance inventory changed');
          await managed.captureInstanceArchiveWithLifecycleFenceHeld(record, raw, signal);
        }
        // Preserve every raw/PAX byte and its metadata. The authenticated role
        // codec validates this stream during bundle inspection; never repack.
        await pipeline(createReadStream(raw), createGzip(), createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal });
      } finally { await rm(raw, { force: true }); }
    });
  }

  private async snapshotVolume(
    volumeName: string,
    output: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!(await this.volumeExists(volumeName))) return false;
    const hostname = process.env.HOSTNAME;
    if (!hostname) throw new Error("Orchestrator container identity is unavailable");
    const source = await withOperationDeadline(
      (operationSignal) => this.docker.getContainer(hostname).inspect({
        abortSignal: operationSignal,
      }),
      INSTANCE_DOCKER_READ_TIMEOUT_MS,
      "Docker instance-snapshot orchestrator inspection",
      signal,
    );
    const helper = await withOperationDeadline((operationSignal) => this.docker.createContainer({
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
      abortSignal: operationSignal,
    }), INSTANCE_DOCKER_MUTATION_TIMEOUT_MS, "Docker instance-snapshot helper creation", signal);
    const raw = `${output}.raw`;
    const sanitized = `${output}.tar`;
    try {
      await withOperationDeadline(
        (operationSignal) => helper.start({ abortSignal: operationSignal }),
        INSTANCE_DOCKER_MUTATION_TIMEOUT_MS,
        "Docker instance-snapshot helper start",
        signal,
      );
      await pipeline(
        (await withOperationDeadline(
          (operationSignal) => helper.getArchive({
            path: "/source",
            abortSignal: operationSignal,
          }),
          INSTANCE_DOCKER_READ_TIMEOUT_MS,
          "Docker instance-snapshot archive setup",
          signal,
        )) as NodeJS.ReadableStream,
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
      await withOperationDeadline(
        (operationSignal) => helper.remove({ force: true, abortSignal: operationSignal } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
        INSTANCE_DOCKER_MUTATION_TIMEOUT_MS,
        "Docker instance-snapshot helper cleanup",
      ).catch(() => {});
      await rm(raw, { force: true }).catch(() => {});
      await rm(sanitized, { force: true }).catch(() => {});
    }
  }

  private async volumeExists(name: string) {
    try {
      await withOperationDeadline(
        (operationSignal) => this.docker.getVolume(name).inspect({
          abortSignal: operationSignal,
        }),
        INSTANCE_DOCKER_READ_TIMEOUT_MS,
        "Docker instance-snapshot volume inspection",
      );
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
          if (!restoreMayOwnStage(this.store.getJob(job.id) ?? job)) this.releaseRestoreBarrier(job.id);
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
    if (job.restoreHelper && (error as { code?: string })?.code !== 'INSTANCE_RESTORE_HELPER_NOT_STARTED') {
      await this.store.reload();
      const helperLedger = this.store.getJob(job.id);
      if (helperLedger && ['succeeded', 'failed', 'cancelled'].includes(helperLedger.status)) return;
      // A possibly active helper owns this ledger. Do not abort its native
      // mutation by replacing it from a stale parent cache on transport loss.
      return;
    }
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

function restoreQuarantined(job: InstanceBackupJob): boolean {
  return job.operation === 'restore' && ['INSTANCE_RESTORE_ROLLBACK_INCOMPLETE', 'INSTANCE_RESTORE_HELPER_UNCERTAIN']
    .includes(job.errorCode ?? '');
}

function restoreMayOwnStage(job: InstanceBackupJob): boolean {
  return job.operation === 'restore' && (restoreQuarantined(job) || !!job.restoreHelper ||
    ['queued', 'running'].includes(job.status) && ['helper-starting', 'applying'].includes(job.phase));
}

function restoreHelperNeverStarted(info: Docker.ContainerInspectInfo): boolean {
  return info.State.Status === 'created' && !info.State.Running && !info.State.Restarting && !info.State.Dead &&
    /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(info.State.StartedAt);
}

function restoreHelperSettled(job: InstanceBackupJob, info: Docker.ContainerInspectInfo): boolean {
  return !restoreQuarantined(job) && ['succeeded', 'failed', 'cancelled'].includes(job.status) &&
    !info.State.Running && !info.State.Restarting && info.State.Status === 'exited' &&
    Number.isFinite(Date.parse(info.State.FinishedAt)) && !info.State.FinishedAt.startsWith('0001-') &&
    (job.status === 'failed' ? info.State.ExitCode !== 0 : info.State.ExitCode === 0);
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
    restoreHelper: _restoreHelper,
    ...result
  } = structuredClone(job);
  return { ...result, logLineCount: logs.length };
}

function publicInstanceFailure(error: unknown) {
  const restoreCode = (error as { code?: string })?.code;
  if (restoreCode === 'INSTANCE_RESTORE_HELPER_NOT_STARTED')
    return { code: restoreCode, message: 'The restore helper never started; original data remains untouched.', retryable: true };
  if (restoreCode === 'INSTANCE_RESTORE_HELPER_UNCERTAIN')
    return { code: restoreCode, message: 'Restore execution is unsettled. Retain the exact helper, staging and data; do not retry automatically.', retryable: false };
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
