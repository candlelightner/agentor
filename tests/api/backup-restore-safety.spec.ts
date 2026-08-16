import { expect, test } from "@playwright/test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  BackupManager,
  restoreRollbackFailure,
  rollbackRestoredWorkers,
} from "../../orchestrator/server/utils/backup-manager";
import type {
  BackupProvider,
  UploadResult,
} from "../../orchestrator/server/utils/backup-provider";
import { WorkerLifecycleCoordinator } from "../../orchestrator/server/utils/worker-lifecycle-coordinator";

test("worker lifecycle mutations serialize per worker and recover after rejection", async () => {
  const coordinator = new WorkerLifecycleCoordinator();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = coordinator.withWorker("worker-a", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
    throw new Error("expected failure");
  });
  const second = coordinator.withWorker("worker-a", async () => {
    events.push("second");
  });
  const unrelated = coordinator.withWorker("worker-b", async () => {
    events.push("unrelated");
  });

  await unrelated;
  expect(events).toEqual(["first-start", "unrelated"]);
  releaseFirst();
  await expect(first).rejects.toThrow("expected failure");
  await second;
  expect(events).toEqual([
    "first-start",
    "unrelated",
    "first-end",
    "second",
  ]);
});

test("restore rollback reports every worker that still needs manual cleanup", async () => {
  const removals: string[] = [];
  const survivors = await rollbackRestoredWorkers(
    ["worker-1", "worker-2", "worker-3"],
    async (workerId) => {
      removals.push(workerId);
      if (workerId !== "worker-2") return;
      throw new Error("remove failed");
    },
  );
  expect(removals).toEqual(["worker-3", "worker-2", "worker-1"]);
  expect(survivors).toEqual(["worker-2"]);
  expect(restoreRollbackFailure(survivors)).toMatchObject({
    statusCode: 500,
    message:
      "Restore failed and some newly created workers require manual cleanup.",
    data: {
      code: "RESTORE_ROLLBACK_FAILED",
      workerIds: ["worker-2"],
    },
  });
});

test("forgetting an owner aborts and drains an active selective restore", async () => {
  const fixture = await restoreFixture("queued-restore-owner");
  try {
    const artifact = await fixture.manager.getArtifact(fixture.artifactId);
    expect(artifact).toBeTruthy();
    const job = await fixture.manager.createRestore(
      fixture.userId,
      artifact!,
      "new",
    );
    const signal = await fixture.provider.downloadStarted;

    await fixture.manager.forgetUser(fixture.userId);

    expect(signal.aborted).toBe(true);
    expect(job).toMatchObject({ status: "cancelled", phase: "cancelled" });
    expect(fixture.provider.deleted).toEqual([fixture.objectId]);
    await expect(
      stat(join(fixture.dataDir, "tmp", `restore-${job.id}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    fixture.manager.stop();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("forgetting an owner aborts and drains a synchronous legacy restore", async () => {
  const fixture = await restoreFixture("legacy-restore-owner");
  try {
    const artifact = await fixture.manager.getArtifact(fixture.artifactId);
    expect(artifact).toBeTruthy();
    const restore = fixture.manager.restore(fixture.userId, artifact!, "new");
    const signal = await fixture.provider.downloadStarted;

    await fixture.manager.forgetUser(fixture.userId);

    expect(signal.aborted).toBe(true);
    await expect(restore).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.provider.deleted).toEqual([fixture.objectId]);
  } finally {
    fixture.manager.stop();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("owner cleanup fails closed by a bounded deadline when a restore cannot drain", async () => {
  const fixture = await restoreFixture("stalled-restore-owner", {
    cooperativeDownload: false,
    cleanupTimeoutMs: 25,
  });
  try {
    const artifact = await fixture.manager.getArtifact(fixture.artifactId);
    expect(artifact).toBeTruthy();
    const restore = fixture.manager.restore(fixture.userId, artifact!, "new");
    void restore.catch(() => {});
    const signal = await fixture.provider.downloadStarted;
    const started = Date.now();

    await expect(fixture.manager.forgetUser(fixture.userId)).rejects.toThrow(
      /cleanup deadline/i,
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signal.aborted).toBe(true);
    expect(fixture.provider.deleted).toEqual([]);
    expect(await fixture.manager.getArtifact(fixture.artifactId)).toBeTruthy();
    fixture.provider.releaseDownload();
    await expect(restore).rejects.toMatchObject({ name: "AbortError" });
    await fixture.manager.forgetUser(fixture.userId);
    expect(fixture.provider.deleted).toEqual([fixture.objectId]);
  } finally {
    fixture.manager.stop();
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

class BlockingDownloadProvider implements BackupProvider {
  kind = "local";
  deleted: string[] = [];
  private resolveDownloadStarted!: (signal: AbortSignal) => void;
  private releaseBlockedDownload?: () => void;
  readonly downloadStarted = new Promise<AbortSignal>((resolve) => {
    this.resolveDownloadStarted = resolve;
  });

  constructor(private readonly cooperative = true) {}

  releaseDownload() {
    this.releaseBlockedDownload?.();
  }

  async upload(): Promise<UploadResult> {
    throw new Error("unused");
  }

  async download(
    _userId: string,
    _objectId: string,
    _destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!signal) throw new Error("restore download signal is required");
    this.resolveDownloadStarted(signal);
    if (!this.cooperative) {
      await new Promise<void>((resolve) => {
        this.releaseBlockedDownload = resolve;
      });
      return;
    }
    await new Promise<void>((_resolve, reject) => {
      const aborted = () =>
        reject(Object.assign(new Error("download aborted"), { name: "AbortError" }));
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
  options: { cooperativeDownload?: boolean; cleanupTimeoutMs?: number } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "agentor-restore-safety-"));
  const artifactId = "restore-artifact";
  const objectId = "provider-object";
  const now = new Date().toISOString();
  await mkdir(join(dataDir, "users", userId), { recursive: true });
  await writeFile(
    join(dataDir, "users", userId, "backups.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [],
      artifacts: [
        {
          schemaVersion: 1,
          id: artifactId,
          userId,
          workspaceId: "source-worker",
          workspaceIds: ["source-worker"],
          provider: "local",
          providerObjectId: objectId,
          createdAt: now,
          size: 1,
          sha256: "0".repeat(64),
          sourceWorkerId: "source-worker",
          missingSecrets: [],
        },
      ],
    }),
  );
  const provider = new BlockingDownloadProvider(
    options.cooperativeDownload ?? true,
  );
  const manager = new BackupManager({
    dataDir,
    providers: { local: provider },
    restoreCleanupTimeoutMs: options.cleanupTimeoutMs,
  });
  await manager.init();
  return { dataDir, userId, artifactId, objectId, provider, manager };
}
