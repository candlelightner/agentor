import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { pipeline } from "node:stream/promises";
import { BackupStore } from "./backup-store";
import {
  LocalBackupProvider,
  FakeBackupProvider,
  GoogleDriveBackupProvider,
  exchangeGoogleAuthorizationCode,
  type BackupProvider,
  type GoogleDriveToken,
} from "./backup-provider";
import { encryptBackup, decryptBackup } from "./backup-crypto";
import type {
  BackupArtifact,
  BackupConfig,
  BackupJob,
  BackupProviderKind,
} from "./backup-types";
import {
  useConfig,
  useContainerManager,
  useLogger,
  useWorkerStore,
} from "./services";
import { useWorkerConfigStore } from "./worker-config-store";
import {
  decryptWorkerValue,
  encryptWorkerValue,
  type EncryptedWorkerValue,
} from "./worker-config-crypto";
import { packWorkspaceBackups, unpackWorkspaceBackups } from "./backup-bundle";
import { extractBundle } from "./worker-export";
import { replaceStoppedWorkspace } from "./backup-restore-helper";
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
  writeFilteredAgentsGz,
  writeGzipFile,
  writeManifest,
  type WorkerExportManifest,
} from "./worker-export";

export class BackupManager {
  private store = new BackupStore(useConfig().dataDir);
  private initialized?: Promise<void>;
  private scheduleTimer?: NodeJS.Timeout;
  private active = 0;
  private pending: Array<() => Promise<void>> = [];
  private readonly maxConcurrent = 2;
  private accepting = true;
  private controllers = new Map<string, AbortController>();
  private forgottenUsers = new Set<string>();
  private fake = new FakeBackupProvider(
    join(useConfig().dataDir, "backup-fake"),
  );
  private fakeUsers = new Set<string>();
  private providers = new Map<BackupProviderKind, BackupProvider>([
    [
      "local",
      new LocalBackupProvider(join(useConfig().dataDir, "backup-objects")),
    ],
    ["fake", this.fake],
    [
      "google-drive",
      new GoogleDriveBackupProvider(
        (userId) => this.loadGoogleToken(userId),
        (userId, token) => this.saveGoogleToken(userId, token),
      ),
    ],
  ]);
  init() {
    return (this.initialized ??= this.initialize());
  }
  private async initialize() {
    await this.store.init();
    await mkdir(join(useConfig().dataDir, "tmp"), { recursive: true });
    for (const user of this.store.all())
      for (const job of user.jobs)
        if (job.status === "queued" || job.status === "running") {
          job.status = "failed";
          job.phase = "failed";
          job.error = "Backup interrupted by orchestrator restart";
          job.completedAt = job.updatedAt = new Date().toISOString();
          await this.store.save(job.userId, user);
        }
    this.scheduleTimer = setInterval(() => void this.tickSchedules(), 60_000);
    this.scheduleTimer.unref?.();
    setImmediate(() => void this.tickSchedules());
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
    const data = this.store.get(userId);
    for (const job of data.jobs) this.controllers.get(job.id)?.abort();
    await Promise.allSettled(
      data.artifacts.map((artifact) =>
        this.providers
          .get(artifact.provider)!
          .delete(userId, artifact.providerObjectId),
      ),
    );
    this.store.forget(userId);
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
      >
    >,
  ) {
    await this.init();
    const data = this.store.get(userId);
    const now = new Date().toISOString();
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
    await this.store.save(userId, data);
    return sanitizeConfig(data.config);
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
  ): Promise<BackupJob> {
    await this.init();
    const unique = [...new Set(workspaceIds)];
    if (!unique.length) throw new Error("At least one workspace is required");
    for (const id of unique) {
      const w = useContainerManager().get(id) ?? useWorkerStore().findById(id);
      if (!w || w.userId !== userId) throw new Error("Workspace not found");
    }
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
      consistency,
    };
    const data = this.store.get(userId);
    data.jobs.push(job);
    await this.store.save(userId, data);
    this.enqueue(() => this.runV2(job));
    return job;
  }
  async getJob(id: string) {
    await this.init();
    return this.store.findJob(id);
  }
  async getArtifact(id: string) {
    await this.init();
    return this.store.findArtifact(id);
  }
  connectFake(userId: string, chunkSize?: number) {
    this.fakeUsers.add(userId);
    return this.fake.connect(userId, chunkSize);
  }
  setFakeFault(userId: string, chunk: number, count: number) {
    this.fake.setFault(userId, chunk, count);
  }
  fakeDiagnostic(userId: string, id: string) {
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
    const data = this.store.get(userId);
    if (data.config) {
      data.config.google = undefined;
      if (data.config.provider === "google-drive")
        data.config.provider = "local";
      data.config.updatedAt = new Date().toISOString();
      await this.store.save(userId, data);
    }
  }
  async retry(job: BackupJob) {
    if (job.status !== "failed")
      throw new Error("Only failed jobs can be retried");
    job.attempt += 1;
    job.status = "queued";
    job.phase = "retrying";
    job.error = undefined;
    job.completedAt = undefined;
    job.updatedAt = new Date().toISOString();
    await this.saveJob(job);
    this.enqueue(() => this.runV2(job));
    return job;
  }
  async cancel(job: BackupJob) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "cancelled";
      job.phase = "cancelled";
      job.completedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
      this.controllers.get(job.id)?.abort();
    }
    return job;
  }
  stop() {
    this.accepting = false;
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = undefined;
    this.pending = [];
  }
  async list(userId: string) {
    await this.init();
    const d = this.store.get(userId);
    return {
      config: d.config ? sanitizeConfig(d.config) : undefined,
      jobs: d.jobs,
      artifacts: d.artifacts,
    };
  }
  async restore(
    userId: string,
    artifact: BackupArtifact,
    mode: "new" | "original",
    displayName?: string,
  ) {
    await this.init();
    if (mode === "original")
      throw new Error(
        "In-place restore is not safe while identity-preserving volume replacement is unavailable; restore into a new worker",
      );
    const dir = join(useConfig().dataDir, "tmp", `restore-${randomUUID()}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const encrypted = join(dir, "archive.enc");
    const plain = join(dir, "worker.tar");
    try {
      await this.providers
        .get(artifact.provider)!
        .download(userId, artifact.providerObjectId, encrypted);
      await decryptBackup(useConfig(), encrypted, plain, artifact.sha256);
      return await useContainerManager().importWorker(userId, plain, {
        displayName,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async createRestore(
    userId: string,
    artifact: BackupArtifact,
    target: "new" | "original",
    displayName?: string,
  ): Promise<BackupJob> {
    const now = new Date().toISOString();
    const job: BackupJob = {
      schemaVersion: 1,
      id: randomUUID(),
      userId,
      ownerId: userId,
      workspaceId: artifact.workspaceId,
      workspaceIds: artifact.workspaceIds ?? [artifact.workspaceId],
      provider: artifact.provider,
      status: "queued",
      phase: "queued",
      progress: 0,
      bytesProcessed: 0,
      createdAt: now,
      updatedAt: now,
      attempt: 1,
      target,
    };
    const data = this.store.get(userId);
    data.jobs.push(job);
    await this.store.save(userId, data);
    this.enqueue(() => this.runRestoreV2(job, artifact, displayName));
    return job;
  }
  private async runRestore(
    job: BackupJob,
    artifact: BackupArtifact,
    displayName?: string,
  ) {
    const dir = join(useConfig().dataDir, "tmp", `restore-${job.id}`);
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
        .download(job.userId, artifact.providerObjectId, enc);
      job.phase = "verifying";
      job.progress = 60;
      await this.saveJob(job);
      await decryptBackup(useConfig(), enc, plain, artifact.sha256);
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
  ) {
    const live = useContainerManager().get(id);
    // Archived records remain visible through ContainerManager, but they no
    // longer have a Docker container. Only take the native export path when
    // sync discovered an actual container; archived storage is handled by
    // the hardened read-only helper below.
    if (live?.containerId) {
      const result = await useContainerManager().exportWorker(id, {
        includeRootfs: false,
        signal,
      });
      await pipeline(
        result.stream,
        createWriteStream(destination, { mode: 0o600 }),
        { signal },
      );
      return;
    }
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
    const temp = join(
      useConfig().dataDir,
      "tmp",
      `offline-backup-${randomUUID()}`,
    );
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
        contents: { rootfs: false, workspace: true, agents: true },
        missingSecrets: (await useWorkerConfigStore().resolveValues(userId, id))
          .filter((entry) => entry.kind !== "variable")
          .map((entry) => entry.key),
      };
      const manifestPath = join(temp, BUNDLE_FILES.manifest),
        workspacePath = join(temp, BUNDLE_FILES.workspace),
        agentsPath = join(temp, BUNDLE_FILES.agents);
      await writeManifest(manifest, manifestPath);
      await writeGzipFile(
        await useDockerService().getArchive(helper.id, EXPORT_WORKSPACE_PATH),
        workspacePath,
        signal,
      );
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
          { name: BUNDLE_FILES.workspace, path: workspacePath },
          { name: BUNDLE_FILES.agents, path: agentsPath },
        ]),
        createWriteStream(destination, { mode: 0o600 }),
        { signal },
      );
    } finally {
      await helper.remove({ force: true }).catch(() => {});
      await rm(temp, { recursive: true, force: true });
    }
  }
  private async runV2(job: BackupJob) {
    if (job.status === "cancelled") return;
    const started = Date.now(),
      dir = join(useConfig().dataDir, "tmp", `backup-${job.id}`);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    let pendingArtifactId: string | undefined;
    let interruptedUploadId: string | undefined;
    let keepForResume = false;
    let resumableState:
      { artifactId: string; sha256: string; size: number } | undefined;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const encrypted = join(dir, "archive.enc");
      const resumePath = join(dir, "resume.json");
      const resume = await readFile(resumePath, "utf8")
        .then(
          (text) =>
            JSON.parse(text) as {
              artifactId: string;
              uploadId: string;
              sha256: string;
              size: number;
            },
        )
        .catch(() => undefined);
      let crypt: { sha256: string; size: number };
      let artifactId: string;
      let resumeUploadId: string | undefined;
      job.status = "running";
      job.startedAt ||= new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      await this.recordAttempt(job.userId);
      if (resume) {
        crypt = { sha256: resume.sha256, size: resume.size };
        artifactId = resume.artifactId;
        resumeUploadId = resume.uploadId;
        job.phase = "uploading";
        job.progress = 60;
        await this.saveJob(job);
      } else {
        job.phase = "exporting";
        await this.saveJob(job);
        const exports: Array<{ id: string; path: string }> = [];
        for (const id of job.workspaceIds ?? [job.workspaceId]) {
          if ((job.status as BackupJob["status"]) === "cancelled") return;
          const path = join(dir, `${id}.worker.tar`);
          await this.exportWorkspaceBundle(
            job.userId,
            id,
            path,
            controller.signal,
          );
          exports.push({ id, path });
        }
        const plain = join(dir, "bundle.tar");
        await packWorkspaceBackups(exports, plain);
        if ((job.status as BackupJob["status"]) === "cancelled") return;
        job.phase = "encrypting";
        job.progress = 35;
        await this.saveJob(job);
        crypt = await encryptBackup(
          useConfig(),
          plain,
          encrypted,
          (bytes: number) => {
            job.bytesProcessed = bytes;
          },
        );
        artifactId = randomUUID();
      }
      if ((job.status as BackupJob["status"]) === "cancelled") return;
      job.phase = "uploading";
      job.progress = 60;
      await this.saveJob(job);
      pendingArtifactId = artifactId;
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
      );
      if ((job.status as BackupJob["status"]) === "cancelled") {
        await this.providers
          .get(job.provider)!
          .delete(job.userId, uploaded.objectId)
          .catch(() => {});
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
        .download(job.userId, uploaded.objectId, verifyEnc);
      await decryptBackup(useConfig(), verifyEnc, verifyPlain, crypt.sha256);
      if ((job.status as BackupJob["status"]) === "cancelled") {
        await this.providers
          .get(job.provider)!
          .delete(job.userId, uploaded.objectId)
          .catch(() => {});
        return;
      }
      const missing = new Set<string>();
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
        createdAt: new Date().toISOString(),
        size: uploaded.size,
        sha256: crypt.sha256,
        sourceWorkerId: job.workspaceId,
        missingSecrets: [...missing],
      };
      const data = this.store.get(job.userId);
      data.artifacts.push(artifact);
      pendingArtifactId = undefined;
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
      await this.applyRetention(data, job.userId);
      if (data.config) {
        data.config.lastSuccessAt = job.completedAt;
        data.config.lastError = undefined;
        data.config.consecutiveFailures = 0;
      }
      await this.store.save(job.userId, data);
    } catch (error: any) {
      if (typeof error?.uploadId === "string")
        interruptedUploadId = error.uploadId;
      if ((job.status as BackupJob["status"]) !== "cancelled") {
        if (resumableState && typeof error?.uploadId === "string") {
          await writeFile(
            join(dir, "resume.json"),
            JSON.stringify({ ...resumableState, uploadId: error.uploadId }),
            { mode: 0o600 },
          );
          keepForResume = true;
          pendingArtifactId = undefined;
        }
        job.status = "failed";
        job.phase = "failed";
        job.error = "Backup failed. Retry is available.";
        job.completedAt = job.updatedAt = new Date().toISOString();
        job.durationMs = Date.now() - started;
        await this.saveJob(job);
        await this.recordFailure(job.userId, job.error);
        useLogger().error(`[backup] job ${job.id} failed`);
      }
    } finally {
      if (
        (job.status as BackupJob["status"]) === "cancelled" &&
        interruptedUploadId
      )
        await this.providers
          .get(job.provider)!
          .abortUpload?.(
            job.userId,
            interruptedUploadId,
            pendingArtifactId || "",
          )
          .catch(() => {});
      if (pendingArtifactId)
        await this.providers
          .get(job.provider)!
          .delete(job.userId, pendingArtifactId)
          .catch(() => {});
      this.controllers.delete(job.id);
      if (!keepForResume) await rm(dir, { recursive: true, force: true });
    }
  }
  private async runRestoreV2(
    job: BackupJob,
    artifact: BackupArtifact,
    displayName?: string,
  ) {
    const dir = join(useConfig().dataDir, "tmp", `restore-${job.id}`);
    const createdWorkers: string[] = [];
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      job.status = "running";
      job.phase = "downloading";
      job.progress = 20;
      await this.saveJob(job);
      const enc = join(dir, "archive.enc"),
        plain = join(dir, "bundle.tar");
      await this.providers
        .get(artifact.provider)!
        .download(job.userId, artifact.providerObjectId, enc);
      job.phase = "verifying";
      job.progress = 55;
      await this.saveJob(job);
      await decryptBackup(useConfig(), enc, plain, artifact.sha256);
      job.integrityVerified = true;
      const bundles = await unpackWorkspaceBackups(
        plain,
        artifact.workspaceIds ?? [artifact.workspaceId],
        join(dir, "workspaces"),
      );
      if (job.target === "new") {
        for (const [index, bundle] of bundles.entries()) {
          const worker = await useContainerManager().importWorker(
            job.userId,
            bundle.path,
            { displayName: index === 0 ? displayName : undefined },
          );
          createdWorkers.push(worker.id);
        }
        job.workerId = createdWorkers[0];
        (job as BackupJob & { workerIds?: string[] }).workerIds =
          createdWorkers;
      } else {
        const source = artifact.sourceWorkerId ?? artifact.workspaceId;
        const selected = bundles.find((b) => b.id === source);
        if (!selected)
          throw new Error("Original workspace is absent from backup");
        const extracted = await extractBundle(
          selected.path,
          join(dir, "original"),
        );
        if (!extracted.workspacePath)
          throw new Error("Backup workspace payload is missing");
        await replaceStoppedWorkspace(
          job.userId,
          source,
          extracted.workspacePath,
        );
        job.workerId = source;
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
      for (const workerId of createdWorkers.reverse())
        await useContainerManager()
          .remove(workerId)
          .catch(() => {});
      job.status = "failed";
      job.phase = "failed";
      job.error = "Restore failed. No secret values were restored.";
      job.completedAt = job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
      useLogger().error(`[backup] restore job ${job.id} failed`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async deleteArtifact(artifact: BackupArtifact) {
    await this.providers
      .get(artifact.provider)!
      .delete(artifact.userId, artifact.providerObjectId);
    const data = this.store.get(artifact.userId);
    data.artifacts = data.artifacts.filter((x) => x.id !== artifact.id);
    await this.store.save(artifact.userId, data);
  }
  async beginGoogleOAuth(
    userId: string,
    clientId: string,
    redirectUri: string,
  ) {
    const state = randomBytes(32).toString("base64url");
    const data = this.store.get(userId);
    const now = new Date().toISOString();
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
    await this.store.save(userId, data);
    return { state };
  }
  async completeGoogleOAuth(userId: string, state: string, code: string) {
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
      const clientSecret = process.env.GOOGLE_BACKUP_CLIENT_SECRET || "";
      if (!google.clientId || !clientSecret || !google.redirectUri)
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
        clientSecret,
        redirectUri: google.redirectUri,
        previousToken,
      });
    }
    data.config!.google!.token = await encryptWorkerValue(
      useConfig(),
      JSON.stringify(token),
      `backup-google\0${userId}`,
    );
    data.config!.provider = "google-drive";
    data.config!.google!.oauthPending = undefined;
    data.config!.updatedAt = new Date().toISOString();
    await this.store.save(userId, data);
    return sanitizeConfig(data.config!);
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
    const data = this.store.get(userId);
    if (!data.config?.google)
      throw new Error("Google Drive backup account is not linked");
    data.config.google.token = await encryptWorkerValue(
      useConfig(),
      JSON.stringify(token),
      `backup-google\0${userId}`,
    );
    data.config.updatedAt = new Date().toISOString();
    await this.store.save(userId, data);
  }
  private async run(job: BackupJob) {
    const started = Date.now();
    const dir = join(useConfig().dataDir, "tmp", `backup-${job.id}`);
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
        .download(job.userId, uploaded.objectId, verifyEnc);
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
      };
      const data = this.store.get(job.userId);
      data.artifacts.push(artifact);
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
      await this.applyRetention(data, job.userId);
      await this.store.save(job.userId, data);
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
    const data = this.store.get(job.userId);
    const i = data.jobs.findIndex((x) => x.id === job.id);
    if (i >= 0) data.jobs[i] = job;
    await this.store.save(job.userId, data);
  }
  private async applyRetention(
    data: ReturnType<BackupStore["get"]>,
    userId: string,
  ) {
    const keep = data.config?.retentionCount ?? 7;
    const sorted = [...data.artifacts].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    for (const old of sorted.slice(keep)) {
      try {
        await this.providers
          .get(old.provider)!
          .delete(userId, old.providerObjectId);
        data.artifacts = data.artifacts.filter((x) => x.id !== old.id);
      } catch {
        old.deletionPending = true;
        old.deletionErrorAt = new Date().toISOString();
      }
    }
  }
  private async tickSchedules() {
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
      try {
        await this.createMany(c.userId, selected);
      } catch (error) {
        c.lastAttemptAt = new Date().toISOString();
        c.lastError = safeError(error);
        c.consecutiveFailures = (c.consecutiveFailures ?? 0) + 1;
        useLogger().error(
          `[backup] scheduled backup could not be queued for user ${c.userId}`,
        );
      } finally {
        c.nextRunAt = new Date(
          now + configIntervalMinutes(c) * 60_000,
        ).toISOString();
        c.updatedAt = new Date().toISOString();
        await this.store.save(c.userId, data);
      }
    }
  }
  private async recordAttempt(userId: string) {
    const data = this.store.get(userId);
    if (!data.config) return;
    data.config.lastAttemptAt = new Date().toISOString();
    data.config.updatedAt = data.config.lastAttemptAt;
    await this.store.save(userId, data);
  }
  private async recordFailure(userId: string, error: string) {
    const data = this.store.get(userId);
    if (!data.config) return;
    data.config.lastError = error;
    data.config.consecutiveFailures =
      (data.config.consecutiveFailures ?? 0) + 1;
    data.config.updatedAt = new Date().toISOString();
    await this.store.save(userId, data);
  }
  private enqueue(task: () => Promise<void>) {
    if (!this.accepting) throw new Error("Backup manager is shutting down");
    this.pending.push(task);
    this.pump();
  }
  private pump() {
    while (this.active < this.maxConcurrent && this.pending.length) {
      const task = this.pending.shift()!;
      this.active++;
      void task().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function configIntervalMinutes(c?: Partial<BackupConfig>) {
  return (
    c?.intervalMinutes ?? Math.max(1, Math.round((c?.intervalHours ?? 24) * 60))
  );
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
let singleton: BackupManager | undefined;
export function useBackupManager() {
  return (singleton ??= new BackupManager());
}
