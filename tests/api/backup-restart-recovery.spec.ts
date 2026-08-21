import { expect, test } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackupManager,
  cleanupInterruptedBackupStaging,
  recordUploadedProviderObject,
} from "../../orchestrator/server/utils/backup-manager";
import { BackupStore } from "../../orchestrator/server/utils/backup-store";

test("restart recovery removes interrupted backup and restore staging", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agentor-backup-restart-"));
  const jobId = "interrupted-job";
  await mkdir(join(dataDir, "tmp", `backup-${jobId}`), { recursive: true });
  await mkdir(join(dataDir, "tmp", `restore-${jobId}`), { recursive: true });
  try {
    await cleanupInterruptedBackupStaging(dataDir, jobId);
    await expect(
      stat(join(dataDir, "tmp", `backup-${jobId}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(dataDir, "tmp", `restore-${jobId}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an uploaded opaque provider object replaces the Agentor artifact marker", () => {
  const now = new Date().toISOString();
  const job = {
    schemaVersion: 1 as const,
    id: "google-job",
    userId: "google-owner",
    workspaceId: "worker-one",
    provider: "google-drive" as const,
    status: "running" as const,
    phase: "uploading",
    progress: 60,
    bytesProcessed: 1,
    createdAt: now,
    updatedAt: now,
    attempt: 1,
    pendingProviderObjectId: "agentor-artifact-id",
  };
  expect(recordUploadedProviderObject(job, "opaque-drive-object-id")).toBe(
    "opaque-drive-object-id",
  );
  expect(job.pendingProviderObjectId).toBe("opaque-drive-object-id");
});

test("completed backup keeps cleanup handles until its atomic commit succeeds", async () => {
  const now = new Date().toISOString();
  const makeJob = () => ({
    schemaVersion: 1 as const,
    id: "commit-job",
    userId: "commit-owner",
    workspaceId: "worker-one",
    provider: "google-drive" as const,
    status: "succeeded" as const,
    phase: "complete",
    progress: 100,
    bytesProcessed: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    attempt: 1,
    pendingProviderObjectId: "opaque-drive-object",
    pendingProviderArtifactId: "stable-artifact-id",
  });
  const artifact = {
    schemaVersion: 1 as const,
    id: "stable-artifact-id",
    userId: "commit-owner",
    workspaceId: "worker-one",
    provider: "google-drive" as const,
    providerObjectId: "opaque-drive-object",
    createdAt: now,
    size: 1,
    sha256: "0".repeat(64),
    missingSecrets: [],
  };
  const commit = (BackupManager.prototype as any).commitCompletedBackup;

  const rejectedJob = makeJob();
  let rejectedDraft: any;
  const rejectingManager = {
    store: {
      update: async (_owner: string, mutation: (draft: any) => void) => {
        rejectedDraft = { jobs: [structuredClone(rejectedJob)], artifacts: [] };
        mutation(rejectedDraft);
        throw new Error("injected final commit failure");
      },
    },
  };
  await expect(
    commit.call(rejectingManager, rejectedJob, artifact),
  ).rejects.toThrow("injected final commit failure");
  expect(rejectedDraft.jobs[0]).not.toHaveProperty("pendingProviderObjectId");
  expect(rejectedDraft.jobs[0]).not.toHaveProperty("pendingProviderArtifactId");
  expect(rejectedJob).toMatchObject({
    pendingProviderObjectId: "opaque-drive-object",
    pendingProviderArtifactId: "stable-artifact-id",
  });

  const committedJob = makeJob();
  let committedDraft: any;
  const succeedingManager = {
    store: {
      update: async (_owner: string, mutation: (draft: any) => void) => {
        committedDraft = {
          jobs: [structuredClone(committedJob)],
          artifacts: [],
        };
        mutation(committedDraft);
      },
    },
  };
  expect(await commit.call(succeedingManager, committedJob, artifact)).toBe(
    true,
  );
  expect(committedDraft.artifacts).toEqual([artifact]);
  expect(committedDraft.jobs[0]).not.toHaveProperty("pendingProviderObjectId");
  expect(committedDraft.jobs[0]).not.toHaveProperty(
    "pendingProviderArtifactId",
  );
  expect(committedJob.pendingProviderObjectId).toBeUndefined();
  expect(committedJob.pendingProviderArtifactId).toBeUndefined();

  const cancelledJob = makeJob();
  let cancelledDraft: any;
  const cancelledManager = {
    store: {
      update: async (_owner: string, mutation: (draft: any) => void) => {
        cancelledDraft = {
          jobs: [
            {
              ...structuredClone(cancelledJob),
              status: "cancelled",
              phase: "cancelled",
            },
          ],
          artifacts: [],
        };
        mutation(cancelledDraft);
      },
    },
  };
  expect(await commit.call(cancelledManager, cancelledJob, artifact)).toBe(
    false,
  );
  expect(cancelledDraft.artifacts).toEqual([]);
  expect(cancelledDraft.jobs[0]).toMatchObject({
    status: "cancelled",
    phase: "cancelled",
  });
  expect(cancelledJob).toMatchObject({
    status: "cancelled",
    phase: "cancelled",
    pendingProviderObjectId: "opaque-drive-object",
  });
});

test("cancelled backup state absorbs a stale running execution save", async () => {
  const now = new Date().toISOString();
  const cancelled = {
    schemaVersion: 1 as const,
    id: "cancel-race-job",
    userId: "cancel-race-owner",
    workspaceId: "worker-one",
    provider: "local" as const,
    status: "cancelled" as const,
    phase: "cancelled",
    progress: 0,
    bytesProcessed: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    attempt: 1,
  };
  const staleExecution = {
    ...structuredClone(cancelled),
    status: "running",
    phase: "exporting",
    completedAt: undefined,
  };
  const persisted = { jobs: [structuredClone(cancelled)] };
  const manager = {
    forgottenUsers: new Set<string>(),
    store: {
      update: async (_owner: string, mutation: (draft: any) => void) =>
        mutation(persisted),
    },
  };

  await (BackupManager.prototype as any).saveJob.call(
    manager,
    staleExecution,
  );

  expect(persisted.jobs[0]).toEqual(cancelled);
  expect(staleExecution).toMatchObject({
    status: "cancelled",
    phase: "cancelled",
    completedAt: now,
  });
});

test("manager reconstruction fails interrupted jobs and deletes a pending local object", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "agentor-backup-manager-restart-"),
  );
  const userId = "restart-owner";
  const backupJobId = "interrupted-backup";
  const restoreJobId = "interrupted-restore";
  const pendingObjectId = "pending-local-object";
  const now = new Date().toISOString();
  const job = (id: string, target?: "new") => ({
    schemaVersion: 1 as const,
    id,
    userId,
    workspaceId: "workspace-id",
    provider: "local" as const,
    status: "running" as const,
    phase: "uploading",
    progress: 55,
    bytesProcessed: 123,
    createdAt: now,
    updatedAt: now,
    attempt: 1,
    ...(target ? { target } : {}),
    ...(id === backupJobId ? { pendingProviderObjectId: pendingObjectId } : {}),
  });
  await mkdir(join(dataDir, "users", userId), { recursive: true });
  await writeFile(
    join(dataDir, "users", userId, "backups.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [job(backupJobId), job(restoreJobId, "new")],
      artifacts: [],
    }),
  );
  await mkdir(join(dataDir, "backup-objects", userId), { recursive: true });
  await writeFile(
    join(dataDir, "backup-objects", userId, `${pendingObjectId}.backup`),
    "partial encrypted archive",
  );
  for (const id of [backupJobId, restoreJobId]) {
    await mkdir(join(dataDir, "tmp", `backup-${id}`), { recursive: true });
    await mkdir(join(dataDir, "tmp", `restore-${id}`), { recursive: true });
  }
  const manager = new BackupManager({ dataDir });
  try {
    await manager.init();
    const backup = await manager.getJob(backupJobId);
    const restore = await manager.getJob(restoreJobId);
    expect(backup).toMatchObject({
      status: "failed",
      phase: "failed",
      error: "Backup interrupted by orchestrator restart",
    });
    expect(backup?.pendingProviderObjectId).toBeUndefined();
    expect(restore).toMatchObject({
      status: "failed",
      phase: "failed",
      error: "Restore interrupted by orchestrator restart",
    });
    await expect(
      stat(
        join(dataDir, "backup-objects", userId, `${pendingObjectId}.backup`),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const id of [backupJobId, restoreJobId]) {
      await expect(
        stat(join(dataDir, "tmp", `backup-${id}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(join(dataDir, "tmp", `restore-${id}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    const persisted = JSON.parse(
      await readFile(join(dataDir, "users", userId, "backups.json"), "utf8"),
    );
    const persistedBackup = persisted.jobs.find(
      (entry: { id: string }) => entry.id === backupJobId,
    );
    expect(persistedBackup).toMatchObject({
      id: backupJobId,
      status: "failed",
    });
    expect(persistedBackup).not.toHaveProperty("pendingProviderObjectId");
    expect(persisted.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: restoreJobId, status: "failed" }),
      ]),
    );
  } finally {
    manager.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery preserves a valid resumable upload instead of sweeping it", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "agentor-backup-resume-restart-"),
  );
  const userId = "resume-owner";
  const jobId = "resume-job";
  const artifactId = "resume-artifact";
  const now = new Date().toISOString();
  await mkdir(join(dataDir, "users", userId), { recursive: true });
  await writeFile(
    join(dataDir, "users", userId, "backups.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [
        {
          schemaVersion: 1,
          id: jobId,
          userId,
          workspaceId: "workspace-id",
          provider: "fake",
          status: "running",
          phase: "uploading",
          progress: 60,
          bytesProcessed: 1,
          createdAt: now,
          updatedAt: now,
          attempt: 1,
          pendingProviderObjectId: artifactId,
          pendingProviderArtifactId: artifactId,
        },
      ],
      artifacts: [],
    }),
  );
  const staging = join(dataDir, "tmp", `backup-${jobId}`);
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "archive.enc"), "same encrypted payload");
  await writeFile(
    join(staging, "resume.json"),
    JSON.stringify({
      artifactId,
      uploadId: "resume-upload-session",
      sha256: "a".repeat(64),
      size: 22,
    }),
  );
  let deletes = 0;
  const provider = {
    kind: "fake",
    upload: async () => {
      throw new Error("unused");
    },
    download: async () => {
      throw new Error("unused");
    },
    delete: async () => {
      deletes++;
    },
  };
  const manager = new BackupManager({
    dataDir,
    providers: { fake: provider as never },
  });
  try {
    await manager.init();
    expect(await readFile(join(staging, "resume.json"), "utf8")).toContain(
      "resume-upload-session",
    );
    expect(deletes).toBe(0);
    expect(await manager.getJob(jobId)).toMatchObject({
      status: "failed",
      phase: "failed",
      error: "Backup interrupted by orchestrator restart. Retry is available.",
    });
    const persisted = JSON.parse(
      await readFile(join(dataDir, "users", userId, "backups.json"), "utf8"),
    );
    expect(persisted.jobs[0]).not.toHaveProperty("pendingProviderObjectId");
    expect(persisted.jobs[0]).not.toHaveProperty("pendingProviderArtifactId");
  } finally {
    manager.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("failed provider cleanup keeps a durable marker that a later manager retries", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "agentor-backup-cleanup-retry-"),
  );
  const userId = "cleanup-owner";
  const jobId = "cancelled-backup";
  const objectId = "pending-object";
  const now = new Date().toISOString();
  await mkdir(join(dataDir, "users", userId), { recursive: true });
  await writeFile(
    join(dataDir, "users", userId, "backups.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [
        {
          schemaVersion: 1,
          id: jobId,
          userId,
          workspaceId: "workspace-id",
          provider: "fake",
          status: "cancelled",
          phase: "cancelled",
          progress: 60,
          bytesProcessed: 1,
          createdAt: now,
          updatedAt: now,
          attempt: 1,
          providerUploadId: "provider-session",
          pendingProviderObjectId: objectId,
          pendingProviderArtifactId: objectId,
        },
      ],
      artifacts: [],
    }),
  );
  (globalThis as any).useLogger = () => ({
    error() {},
    warn() {},
    info() {},
    debug() {},
  });
  const provider = (remove: () => Promise<void>) => ({
    kind: "fake",
    upload: async () => {
      throw new Error("unused");
    },
    download: async () => {
      throw new Error("unused");
    },
    delete: async () => remove(),
  });

  const failing = new BackupManager({
    dataDir,
    providers: {
      fake: provider(async () => {
        throw new Error("transient delete failure");
      }) as never,
    },
  });
  try {
    await failing.init();
    for (const publicJob of [
      await failing.getJob(jobId),
      (await failing.list(userId)).jobs[0],
    ]) {
      expect(publicJob).not.toHaveProperty("providerUploadId");
      expect(publicJob).not.toHaveProperty("pendingProviderObjectId");
      expect(publicJob).not.toHaveProperty("pendingProviderArtifactId");
      expect(publicJob).not.toHaveProperty("pendingProviderUploadId");
    }
    const persisted = JSON.parse(
      await readFile(join(dataDir, "users", userId, "backups.json"), "utf8"),
    );
    expect(persisted.jobs[0].pendingProviderObjectId).toBe(objectId);
  } finally {
    failing.stop();
  }

  let deleted = 0;
  const succeeding = new BackupManager({
    dataDir,
    providers: {
      fake: provider(async () => {
        deleted++;
      }) as never,
    },
  });
  try {
    await succeeding.init();
    expect(deleted).toBeGreaterThan(0);
    expect(
      (await succeeding.getJob(jobId))?.pendingProviderObjectId,
    ).toBeUndefined();
    const persisted = JSON.parse(
      await readFile(join(dataDir, "users", userId, "backups.json"), "utf8"),
    );
    expect(persisted.jobs[0]).not.toHaveProperty("pendingProviderObjectId");
  } finally {
    succeeding.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart cleanup reconciles an opaque provider upload by stable artifact id", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "agentor-backup-opaque-reconcile-"),
  );
  const userId = "opaque-owner";
  const jobId = "opaque-job";
  const artifactId = "stable-artifact-id";
  const now = new Date().toISOString();
  await mkdir(join(dataDir, "users", userId), { recursive: true });
  await writeFile(
    join(dataDir, "users", userId, "backups.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [
        {
          schemaVersion: 1,
          id: jobId,
          userId,
          workspaceId: "workspace-id",
          provider: "google-drive",
          status: "failed",
          phase: "failed",
          progress: 60,
          bytesProcessed: 1,
          createdAt: now,
          updatedAt: now,
          attempt: 1,
          pendingProviderObjectId: artifactId,
          pendingProviderArtifactId: artifactId,
        },
      ],
      artifacts: [],
    }),
  );
  const exact: string[] = [];
  const reconciled: string[] = [];
  const provider = {
    kind: "google-drive",
    upload: async () => {
      throw new Error("unused");
    },
    download: async () => {
      throw new Error("unused");
    },
    delete: async (_owner: string, objectId: string) => {
      exact.push(objectId);
    },
    deleteByArtifactId: async (_owner: string, stableId: string) => {
      reconciled.push(stableId);
    },
  };
  const manager = new BackupManager({
    dataDir,
    providers: { "google-drive": provider as never },
  });
  try {
    await manager.init();
    // The pre-commit marker is an Agentor artifact id, not necessarily a
    // provider object id. Reconcile by metadata without issuing an unsafe
    // exact delete against an opaque provider namespace.
    expect(exact).toEqual([]);
    expect(reconciled).toEqual([artifactId]);
    const persisted = JSON.parse(
      await readFile(join(dataDir, "users", userId, "backups.json"), "utf8"),
    );
    expect(persisted.jobs[0]).not.toHaveProperty("pendingProviderObjectId");
    expect(persisted.jobs[0]).not.toHaveProperty("pendingProviderArtifactId");
  } finally {
    manager.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("BackupStore rolls memory back after a failed write and its save queue recovers", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "agentor-backup-store-transaction-"),
  );
  const userId = "transaction-owner";
  const store = new BackupStore(dataDir);
  const now = new Date().toISOString();
  try {
    await store.init();
    const initial = store.get(userId);
    initial.jobs.push({
      schemaVersion: 1,
      id: "first-job",
      userId,
      workspaceId: "worker-one",
      provider: "local",
      status: "failed",
      phase: "failed",
      progress: 0,
      bytesProcessed: 0,
      createdAt: now,
      updatedAt: now,
      attempt: 1,
    });
    await store.save(userId, initial);

    const target = join(dataDir, "users", userId, "backups.json");
    const persisted = await readFile(target);
    await rm(target);
    await mkdir(target);
    const failed = store.get(userId);
    failed.jobs.push({ ...failed.jobs[0]!, id: "uncommitted-job" });
    await expect(store.save(userId, failed)).rejects.toThrow();
    expect(store.get(userId).jobs.map((job) => job.id)).toEqual(["first-job"]);

    await rm(target, { recursive: true, force: true });
    await writeFile(target, persisted);
    const recovered = store.get(userId);
    recovered.jobs.push({ ...recovered.jobs[0]!, id: "recovered-job" });
    await store.save(userId, recovered);
    expect(
      JSON.parse(await readFile(target, "utf8")).jobs.map(
        (job: { id: string }) => job.id,
      ),
    ).toEqual(["first-job", "recovered-job"]);

    await Promise.all([
      store.update(userId, (draft) => {
        draft.jobs.push({ ...draft.jobs[0]!, id: "concurrent-a" });
      }),
      store.update(userId, (draft) => {
        draft.jobs.push({ ...draft.jobs[0]!, id: "concurrent-b" });
      }),
    ]);
    expect(store.get(userId).jobs.map((job) => job.id)).toEqual([
      "first-job",
      "recovered-job",
      "concurrent-a",
      "concurrent-b",
    ]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("artifact deletion persists a retry marker before bounded provider cleanup", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "agentor-backup-delete-timeout-"),
  );
  const userId = "delete-timeout-owner";
  const now = new Date().toISOString();
  const artifact = {
    schemaVersion: 1 as const,
    id: "artifact-one",
    userId,
    workspaceId: "worker-one",
    provider: "local" as const,
    providerObjectId: "provider-object",
    createdAt: now,
    size: 1,
    sha256: "0".repeat(64),
    missingSecrets: [],
  };
  await mkdir(join(dataDir, "users", userId), { recursive: true });
  await writeFile(
    join(dataDir, "users", userId, "backups.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [],
      artifacts: [artifact],
    }),
  );
  let cleanupSignal: AbortSignal | undefined;
  const provider = {
    kind: "local",
    upload: async () => {
      throw new Error("unused");
    },
    download: async () => {
      throw new Error("unused");
    },
    delete: async (_owner: string, _objectId: string, signal?: AbortSignal) => {
      cleanupSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const manager = new BackupManager({
    dataDir,
    providers: { local: provider as never },
    providerCleanupTimeoutMs: 25,
  });
  try {
    await manager.init();
    const started = Date.now();
    await expect(manager.deleteArtifact(artifact)).rejects.toMatchObject({
      code: "BACKUP_PROVIDER_CLEANUP_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cleanupSignal?.aborted).toBe(true);
    const persisted = JSON.parse(
      await readFile(join(dataDir, "users", userId, "backups.json"), "utf8"),
    );
    expect(persisted.artifacts[0]).toMatchObject({
      id: artifact.id,
      deletionPending: true,
    });
  } finally {
    manager.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pending upload cleanup invokes the provider with its class receiver and a signal", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agentor-backup-abort-receiver-"));
  let provider!: BackupProvider & { called: boolean };
  provider = {
    kind: "local",
    called: false,
    upload: async () => { throw new Error("unused"); },
    download: async () => { throw new Error("unused"); },
    delete: async () => {},
    async abortUpload(_owner, _uploadId, _artifactId, signal) {
      expect(this).toBe(provider);
      expect(signal).toBeInstanceOf(AbortSignal);
      this.called = true;
    },
  };
  const manager = new BackupManager({
    dataDir,
    providers: { local: provider },
  });
  const stamp = new Date().toISOString();
  const job = {
    schemaVersion: 1 as const,
    id: "abort-receiver-job",
    userId: "abort-receiver-owner",
    workspaceId: "worker-one",
    provider: "local" as const,
    status: "failed" as const,
    phase: "failed",
    progress: 0,
    bytesProcessed: 0,
    createdAt: stamp,
    updatedAt: stamp,
    attempt: 1,
    pendingProviderUploadId: "upload-one",
  };
  try {
    await (manager as any).abortPendingProviderUpload(job);
    expect(provider.called).toBe(true);
    expect(job.pendingProviderUploadId).toBeUndefined();
  } finally {
    manager.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("durable artifact deletion tombstones reject restore pins after restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agentor-backup-delete-pin-"));
  const manager = new BackupManager({ dataDir });
  const stamp = new Date().toISOString();
  const artifact = {
    schemaVersion: 1 as const,
    id: "pending-delete-artifact",
    userId: "pending-delete-owner",
    workspaceId: "worker-one",
    provider: "local" as const,
    providerObjectId: "provider-object",
    createdAt: stamp,
    size: 1,
    sha256: "0".repeat(64),
    missingSecrets: [],
    deletionPending: true,
  };
  try {
    expect(() =>
      (manager as any).pinRestoreArtifact("restore-attempt", artifact),
    ).toThrow("Backup artifact not found");
    try {
      (manager as any).pinRestoreArtifact("restore-attempt", artifact);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 404 });
    }
    expect((manager as any).restoreJobPins.size).toBe(0);
  } finally {
    manager.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("owner cleanup drains active backup tasks and fails closed on provider deletion", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "agentor-backup-owner-cleanup-"),
  );
  const userId = "owner-cleanup";
  const now = new Date().toISOString();
  const artifact = {
    schemaVersion: 1 as const,
    id: "owner-artifact",
    userId,
    workspaceId: "worker-one",
    provider: "local" as const,
    providerObjectId: "owner-object",
    createdAt: now,
    size: 1,
    sha256: "0".repeat(64),
    missingSecrets: [],
  };
  await mkdir(join(dataDir, "users", userId), { recursive: true });
  await writeFile(
    join(dataDir, "users", userId, "backups.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [
        {
          schemaVersion: 1,
          id: "queued-owner-job",
          userId,
          workspaceId: "worker-one",
          provider: "local",
          status: "queued",
          phase: "queued",
          progress: 0,
          bytesProcessed: 0,
          createdAt: now,
          updatedAt: now,
          attempt: 1,
        },
      ],
      artifacts: [artifact],
    }),
  );
  let release!: () => void;
  const active = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deletionFails = true;
  const provider = {
    kind: "local",
    upload: async () => {
      throw new Error("unused");
    },
    download: async () => {
      throw new Error("unused");
    },
    delete: async () => {
      if (deletionFails) throw new Error("provider unavailable");
    },
  };
  const manager = new BackupManager({
    dataDir,
    providers: { local: provider as never },
    restoreCleanupTimeoutMs: 1_000,
  });
  try {
    await manager.init();
    await (manager as any).store.update(
      userId,
      (data: {
        jobs: Array<{ id: string; status: string; phase: string }>;
      }) => {
        const job = data.jobs.find(
          (candidate) => candidate.id === "queued-owner-job",
        );
        if (job) {
          job.status = "queued";
          job.phase = "queued";
        }
      },
    );
    (manager as any).activeTasks.set(userId, new Set([active]));
    const forgetting = manager.forgetUser(userId);
    let settled = false;
    void forgetting
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await expect(forgetting).rejects.toMatchObject({
      code: "BACKUP_OWNER_CLEANUP_INCOMPLETE",
    });
    expect(manager.ownerIds()).toContain(userId);
    const retained = JSON.parse(
      await readFile(join(dataDir, "users", userId, "backups.json"), "utf8"),
    );
    expect(retained.jobs[0]).toMatchObject({
      id: "queued-owner-job",
      status: "cancelled",
      phase: "cancelled",
    });

    deletionFails = false;
    await manager.forgetUser(userId);
    expect(manager.ownerIds()).not.toContain(userId);
  } finally {
    release();
    manager.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
