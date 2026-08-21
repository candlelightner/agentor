import { expect, test } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupManager } from "../../orchestrator/server/utils/backup-manager";
import type {
  BackupProvider,
  UploadResult,
} from "../../orchestrator/server/utils/backup-provider";
import type {
  BackupArtifact,
  BackupJob,
} from "../../orchestrator/server/utils/backup-types";

test("cancellation during restore setup stays cancelled after the directory is prepared", async () => {
  const setupEntered = deferred<void>();
  const releaseSetup = deferred<void>();
  const setupCompleted = deferred<void>();
  const fixture = await restoreFixture("restore-setup-cancel", {
    prepareRestoreDirectory: async (path) => {
      setupEntered.resolve();
      await releaseSetup.promise;
      await mkdir(path, { recursive: true, mode: 0o700 });
      setupCompleted.resolve();
    },
  });

  try {
    const job = await fixture.manager.createRestore(
      fixture.userId,
      fixture.artifact,
      "new",
    );
    await setupEntered.promise;
    expect(job.status).toBe("queued");

    await fixture.manager.cancel(job);
    releaseSetup.resolve();
    await setupCompleted.promise;
    await waitForMissing(
      join(fixture.dataDir, "tmp", `restore-${job.id}`),
    );

    expect(await fixture.manager.getJob(job.id)).toMatchObject({
      status: "cancelled",
      phase: "cancelled",
    });
    expect(fixture.provider.downloadCalls).toBe(0);
    await fixture.manager.deleteArtifact(fixture.artifact);
    expect(fixture.provider.deleted).toEqual([fixture.objectId]);
  } finally {
    releaseSetup.resolve();
    await disposeFixture(fixture);
  }
});

test("queued restore cancellation releases admission and its pin when persistence fails", async () => {
  const setupEntered = deferred<void>();
  const releaseSetup = deferred<void>();
  const fixture = await restoreFixture("restore-cancel-save-failure", {
    prepareRestoreDirectory: async (path) => {
      setupEntered.resolve();
      await releaseSetup.promise;
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
  });

  try {
    const job = await fixture.manager.createRestore(
      fixture.userId,
      fixture.artifact,
      "new",
    );
    await setupEntered.promise;
    const backupsPath = join(
      fixture.dataDir,
      "users",
      fixture.userId,
      "backups.json",
    );
    const persisted = await readFile(backupsPath);
    await rm(backupsPath);
    await mkdir(backupsPath);

    await expect(fixture.manager.cancel(job)).rejects.toThrow();
    expect(job).toMatchObject({ status: "queued", phase: "queued" });

    await rm(backupsPath, { recursive: true, force: true });
    await writeFile(backupsPath, persisted);
    releaseSetup.resolve();
    await waitForMissing(
      join(fixture.dataDir, "tmp", `restore-${job.id}`),
    );
    expect(fixture.provider.downloadCalls).toBe(0);
    await fixture.manager.deleteArtifact(fixture.artifact);
    expect(fixture.provider.deleted).toEqual([fixture.objectId]);
  } finally {
    releaseSetup.resolve();
    await disposeFixture(fixture);
  }
});

test("queued in-place cancellation releases only that restore job's artifact pin", async () => {
  const fixture = await restoreFixture("queued-original-restore-cancel");

  try {
    const first = await fixture.manager.createRestore(
      fixture.userId,
      fixture.artifact,
      "new",
    );
    const second = await fixture.manager.createRestore(
      fixture.userId,
      fixture.artifact,
      "new",
    );
    await expect.poll(() => fixture.provider.downloadCalls).toBe(2);

    const queued = await fixture.manager.createRestore(
      fixture.userId,
      fixture.artifact,
      "new",
    );
    // The queue/cancel behavior is independent of admission checks. Recast
    // this already-admitted fixture job to exercise the in-place branch
    // without requiring a real stopped, protection-locked Docker worker.
    await (fixture.manager as any).store.update(
      fixture.userId,
      (data: { jobs: BackupJob[] }) => {
        const current = data.jobs.find((candidate) => candidate.id === queued.id);
        if (current) current.target = "original";
      },
    );
    queued.target = "original";
    expect(queued.status).toBe("queued");
    await expect(fixture.manager.cancel(queued)).resolves.toMatchObject({
      status: "cancelled",
      phase: "cancelled",
    });

    await expect(
      fixture.manager.deleteArtifact(fixture.artifact),
    ).rejects.toMatchObject({ statusCode: 409 });

    await fixture.manager.cancel(first);
    await waitForMissing(
      join(fixture.dataDir, "tmp", `restore-${first.id}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fixture.provider.downloadCalls).toBe(2);
    await expect(
      fixture.manager.deleteArtifact(fixture.artifact),
    ).rejects.toMatchObject({ statusCode: 409 });

    await fixture.manager.cancel(second);
    await waitForMissing(
      join(fixture.dataDir, "tmp", `restore-${second.id}`),
    );
    await fixture.manager.deleteArtifact(fixture.artifact);
    expect(fixture.provider.deleted).toEqual([fixture.objectId]);
  } finally {
    await disposeFixture(fixture);
  }
});

test("concurrent retry callers admit one restore execution and one artifact pin", async () => {
  const userId = "concurrent-restore-retry";
  const artifact = restoreArtifact(userId);
  const failed = failedRestoreJob(userId, artifact);
  const fixture = await restoreFixture(userId, { jobs: [failed] });

  try {
    const stored = await fixture.manager.getJob(failed.id);
    expect(stored).toBeTruthy();
    const accepted = fixture.manager.retry(stored!);
    const duplicate = fixture.manager.retry(stored!);

    await expect(duplicate).rejects.toThrow(/already being queued/i);
    const retry = await accepted;
    expect(retry.attempt).toBe(2);
    await expect.poll(() => fixture.provider.downloadCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fixture.provider.downloadCalls).toBe(1);
    await expect(
      fixture.manager.deleteArtifact(fixture.artifact),
    ).rejects.toMatchObject({ statusCode: 409 });

    await fixture.manager.cancel(retry);
    await waitForMissing(
      join(fixture.dataDir, "tmp", `restore-${retry.id}`),
    );
    await fixture.manager.deleteArtifact(fixture.artifact);
    expect(fixture.provider.deleted).toEqual([fixture.objectId]);
  } finally {
    await disposeFixture(fixture);
  }
});

test("legacy synchronous restore waits for the shared concurrency limiter", async () => {
  const fixture = await restoreFixture("legacy-restore-queue-limit");

  try {
    const first = await fixture.manager.createRestore(
      fixture.userId,
      fixture.artifact,
      "new",
    );
    const second = await fixture.manager.createRestore(
      fixture.userId,
      fixture.artifact,
      "new",
    );
    await expect.poll(() => fixture.provider.downloadCalls).toBe(2);

    const legacy = fixture.manager.restore(
      fixture.userId,
      fixture.artifact,
      "new",
    );
    void legacy.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fixture.provider.downloadCalls).toBe(2);
    await expect(
      fixture.manager.deleteArtifact(fixture.artifact),
    ).rejects.toMatchObject({ statusCode: 409 });

    await fixture.manager.cancel(first);
    await waitForMissing(
      join(fixture.dataDir, "tmp", `restore-${first.id}`),
    );
    await expect.poll(() => fixture.provider.downloadCalls).toBe(3);
    await fixture.manager.cancel(second);
    await waitForMissing(
      join(fixture.dataDir, "tmp", `restore-${second.id}`),
    );

    await fixture.manager.forgetUser(fixture.userId);
    await expect(legacy).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.provider.deleted).toEqual([fixture.objectId]);
  } finally {
    await disposeFixture(fixture);
  }
});

test("a forgotten backup owner is fail-closed across every mutating entry point", async () => {
  const fixture = await restoreFixture("forgotten-owner-admission");
  const staleJob = failedRestoreJob(fixture.userId, fixture.artifact);
  const unavailable = {
    statusCode: 409,
    code: "BACKUP_OWNER_UNAVAILABLE",
  };
  try {
    await fixture.manager.forgetUser(fixture.userId);

    await expect(fixture.manager.setConfig(fixture.userId, { enabled: true }))
      .rejects.toMatchObject(unavailable);
    await expect(fixture.manager.createMany(fixture.userId, ["worker-1"]))
      .rejects.toMatchObject(unavailable);
    await expect(fixture.manager.disconnectGoogle(fixture.userId))
      .rejects.toMatchObject(unavailable);
    await expect(fixture.manager.retry(staleJob))
      .rejects.toMatchObject(unavailable);
    await expect(fixture.manager.cancel(staleJob))
      .rejects.toMatchObject(unavailable);
    await expect(fixture.manager.restore(fixture.userId, fixture.artifact, "new"))
      .rejects.toMatchObject(unavailable);
    await expect(fixture.manager.createRestore(fixture.userId, fixture.artifact, "new"))
      .rejects.toMatchObject(unavailable);
    await expect(fixture.manager.deleteArtifact(fixture.artifact))
      .rejects.toMatchObject(unavailable);
    await expect(fixture.manager.beginGoogleOAuth(
      fixture.userId,
      "client-id",
      "https://agentor.test/oauth/callback",
    )).rejects.toMatchObject(unavailable);
    await expect(fixture.manager.completeGoogleOAuth(fixture.userId, "state", "code"))
      .rejects.toMatchObject(unavailable);
    for (const mutation of [
      () => fixture.manager.connectFake(fixture.userId),
      () => fixture.manager.setFakeFault(fixture.userId, 1, 1),
    ]) {
      let thrown: unknown;
      try { mutation(); } catch (error) { thrown = error; }
      expect(thrown).toMatchObject(unavailable);
    }
  } finally {
    fixture.manager.stop();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

class BlockingDownloadProvider implements BackupProvider {
  kind = "local";
  downloadCalls = 0;
  deleted: string[] = [];

  async upload(): Promise<UploadResult> {
    throw new Error("unused");
  }

  async download(
    _userId: string,
    _objectId: string,
    _destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.downloadCalls += 1;
    if (!signal) throw new Error("restore download signal is required");
    await new Promise<void>((_resolve, reject) => {
      const aborted = () =>
        reject(
          Object.assign(new Error("download aborted"), { name: "AbortError" }),
        );
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    });
  }

  async delete(_userId: string, objectId: string): Promise<void> {
    this.deleted.push(objectId);
  }
}

async function restoreFixture(
  userId: string,
  options: {
    prepareRestoreDirectory?: (path: string) => Promise<void>;
    jobs?: BackupJob[];
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "agentor-restore-cancel-"));
  const artifact = restoreArtifact(userId);
  const objectId = artifact.providerObjectId;
  await mkdir(join(dataDir, "users", userId), { recursive: true });
  await writeFile(
    join(dataDir, "users", userId, "backups.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: options.jobs ?? [],
      artifacts: [artifact],
    }),
  );
  const provider = new BlockingDownloadProvider();
  const manager = new BackupManager({
    dataDir,
    providers: { local: provider },
    prepareRestoreDirectory: options.prepareRestoreDirectory,
  });
  await manager.init();
  return { dataDir, userId, objectId, artifact, provider, manager };
}

function restoreArtifact(userId: string): BackupArtifact {
  return {
    schemaVersion: 1,
    id: "restore-artifact",
    userId,
    workspaceId: "source-worker",
    workspaceIds: ["source-worker"],
    provider: "local",
    providerObjectId: "provider-object",
    createdAt: new Date().toISOString(),
    size: 1,
    sha256: "0".repeat(64),
    sourceWorkerId: "source-worker",
    missingSecrets: [],
  };
}

function failedRestoreJob(
  userId: string,
  artifact: BackupArtifact,
): BackupJob {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: "failed-restore-job",
    userId,
    ownerId: userId,
    workspaceId: artifact.workspaceId,
    workspaceIds: artifact.workspaceIds,
    artifactWorkspaceIds: artifact.workspaceIds,
    selectedWorkspaceIds: artifact.workspaceIds,
    artifactId: artifact.id,
    provider: artifact.provider,
    status: "failed",
    phase: "failed",
    progress: 0,
    bytesProcessed: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    attempt: 1,
    target: "new",
  };
}

async function disposeFixture(
  fixture: Awaited<ReturnType<typeof restoreFixture>>,
) {
  await fixture.manager.forgetUser(fixture.userId).catch(() => {});
  fixture.manager.stop();
  await rm(fixture.dataDir, { recursive: true, force: true });
}

async function waitForMissing(path: string) {
  await expect
    .poll(async () => {
      try {
        await stat(path);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    })
    .toBe(true);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
