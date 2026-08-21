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
import {
  collectWorkerCleanupFailures,
  ContainerManager,
  importEnvironmentReferenced,
  importRollbackRetainsEnvironment,
  removeDockerContainerIdempotently,
  removeFailedImportedImage,
  removeImportEnvironmentIdempotently,
  rollbackCreatedImportEnvironment,
  rollbackFailedWorkerImport,
  stopWorkerContainerIdempotently,
} from "../../orchestrator/server/utils/container";
import { DockerService } from "../../orchestrator/server/utils/docker";
import { StorageManager } from "../../orchestrator/server/utils/storage";
import { WorkerConfigStore } from "../../orchestrator/server/utils/worker-config-store";
import { WorkerStore } from "../../orchestrator/server/utils/worker-store";
import type {
  BackupProvider,
  UploadResult,
} from "../../orchestrator/server/utils/backup-provider";
import {
  WorkerLifecycleCoordinator,
  withOwnerLifecycleMutation,
  withOwnerWorkerLifecycleMutation,
} from "../../orchestrator/server/utils/worker-lifecycle-coordinator";
import { withDeletedOwnerCleanupFence } from "../../orchestrator/server/utils/orphan-sweeper";

// These utilities are Nuxt server auto-imports in production. Focused direct
// module tests provide inert implementations for code paths that only detach
// log streaming or emit diagnostics.
(globalThis as any).useLogger ??= () => ({
  error() {},
  warn() {},
  info() {},
  debug() {},
});
(globalThis as any).useLogCollector ??= () => ({ detach() {} });

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
  expect(events).toEqual(["first-start", "unrelated", "first-end", "second"]);
});

test("a provisional import cannot be deleted before its lifecycle mutation settles", async () => {
  const coordinator = new WorkerLifecycleCoordinator();
  const events: string[] = [];
  let publish!: () => void;
  let finish!: () => void;
  const published = new Promise<void>((resolve) => (publish = resolve));
  const importCanFinish = new Promise<void>((resolve) => (finish = resolve));

  const importing = coordinator.withWorker("imported-worker", async () => {
    events.push("published");
    publish();
    await importCanFinish;
    events.push("import-complete");
  });
  await published;
  const deleting = coordinator.withWorker("imported-worker", async () => {
    events.push("deleted");
  });

  await Promise.resolve();
  expect(events).toEqual(["published"]);
  finish();
  await Promise.all([importing, deleting]);
  expect(events).toEqual(["published", "import-complete", "deleted"]);
});

test("owner cleanup serializes every owner-to-worker lifecycle mutation", async () => {
  const ownerId = `owner-fence-${Date.now()}-${Math.random()}`;
  const events: string[] = [];
  let releaseCleanup!: () => void;
  let cleanupStarted!: () => void;
  const cleanupGate = new Promise<void>(
    (resolve) => (releaseCleanup = resolve),
  );
  const started = new Promise<void>((resolve) => (cleanupStarted = resolve));

  const cleanup = withOwnerLifecycleMutation(ownerId, async () => {
    events.push("cleanup-start");
    cleanupStarted();
    await cleanupGate;
    events.push("cleanup-end");
  });
  await started;
  const queuedMutation = withOwnerWorkerLifecycleMutation(
    ownerId,
    "worker-1",
    async () => {
      events.push("worker-mutation");
    },
  );
  await Promise.resolve();
  expect(events).toEqual(["cleanup-start"]);
  releaseCleanup();
  await Promise.all([cleanup, queuedMutation]);
  expect(events).toEqual(["cleanup-start", "cleanup-end", "worker-mutation"]);
});

test("orphan cleanup revalidates the owner after waiting for its fence", async () => {
  const ownerId = `owner-revalidation-${Date.now()}-${Math.random()}`;
  let releaseMutation!: () => void;
  let mutationStarted!: () => void;
  let ownerExists = false;
  let cleanupCalls = 0;
  const gate = new Promise<void>((resolve) => (releaseMutation = resolve));
  const started = new Promise<void>((resolve) => (mutationStarted = resolve));

  const mutation = withOwnerLifecycleMutation(ownerId, async () => {
    mutationStarted();
    await gate;
  });
  await started;
  const cleanup = withDeletedOwnerCleanupFence(
    ownerId,
    () => ownerExists,
    async () => {
      cleanupCalls++;
    },
  );
  ownerExists = true;
  releaseMutation();

  await mutation;
  await expect(cleanup).resolves.toBe(false);
  expect(cleanupCalls).toBe(0);
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

test("post-persistence rollback retains both handles when record cleanup fails", async () => {
  const calls: string[] = [];
  const step =
    (name: string, fail = false) =>
    async () => {
      calls.push(name);
      if (fail) throw new Error(`${name} failed`);
    };

  let rollbackError: unknown;
  try {
    await rollbackFailedWorkerImport({
      removeFromMemory: () => calls.push("memory"),
      removeMappings: step("mappings"),
      // A persistence rollback can itself fail (for example, due to the same
      // full disk that caused upsert to reject). External resources are still
      // attempted, but the in-memory handle remains for an immediate retry.
      removeWorkerRecord: step("record", true),
      removeWorkerConfiguration: step("configuration"),
      removeContainer: step("container"),
      removeWorkspace: step("workspace"),
      removeAgents: step("agents"),
      removeDocker: step("docker"),
      removeImportedImage: step("image"),
    });
  } catch (error) {
    rollbackError = error;
  }

  expect(rollbackError).toMatchObject({
    code: "IMPORT_ROLLBACK_INCOMPLETE",
    failures: ["worker record"],
  });
  expect(importRollbackRetainsEnvironment(rollbackError)).toBe(true);

  expect(calls).toEqual([
    "container",
    "mappings",
    "configuration",
    "workspace",
    "agents",
    "docker",
    "image",
    "record",
  ]);
});

test("restore/start failure with failed removal retains the provisional import handle", async () => {
  const calls: string[] = [];
  const provisionalImports = new Map([
    ["worker-1", { status: "creating", containerId: "docker-1" }],
  ]);
  const step = (name: string) => async () => {
    calls.push(name);
  };

  await expect(
    rollbackFailedWorkerImport({
      removeFromMemory: () => {
        calls.push("memory");
        provisionalImports.delete("worker-1");
      },
      removeMappings: step("mappings"),
      removeWorkerRecord: step("record"),
      removeWorkerConfiguration: step("configuration"),
      removeContainer: async () => {
        calls.push("container");
        throw new Error("Docker daemon unavailable");
      },
      removeWorkspace: step("workspace"),
      removeAgents: step("agents"),
      removeDocker: step("docker"),
      removeImportedImage: step("image"),
    }),
  ).rejects.toThrow(/rollback could not remove the container/i);

  expect(calls).toEqual(["container"]);
  expect(provisionalImports.get("worker-1")).toEqual({
    status: "creating",
    containerId: "docker-1",
  });
});

test("container removal treats an already-absent Docker resource as success", async () => {
  await expect(
    removeDockerContainerIdempotently(async () => {
      throw Object.assign(new Error("No such container"), { statusCode: 404 });
    }),
  ).resolves.toBeUndefined();

  await expect(
    removeDockerContainerIdempotently(async () => {
      throw Object.assign(new Error("Docker unavailable"), { statusCode: 503 });
    }),
  ).rejects.toThrow("Docker unavailable");
});

test("worker stop is idempotent and updates lifecycle state before later steps", async () => {
  const info = {
    id: "worker-1",
    userId: "owner-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    containerId: "docker-1",
    containerName: "agentor-worker-worker-1",
    displayName: "Worker 1",
    imageName: "worker:latest",
    imageId: "image-1",
    status: "running",
  } as const;
  const mutable = { ...info } as any;

  await expect(
    stopWorkerContainerIdempotently(mutable, async () => {
      throw Object.assign(new Error("container already stopped"), {
        statusCode: 304,
      });
    }),
  ).resolves.toBeUndefined();
  expect(mutable.status).toBe("stopped");
  expect(mutable.updatedAt).not.toBe(info.updatedAt);

  mutable.status = "running";
  await expect(
    stopWorkerContainerIdempotently(mutable, async () => {
      throw Object.assign(new Error("Docker unavailable"), {
        statusCode: 503,
      });
    }),
  ).rejects.toThrow("Docker unavailable");
  expect(mutable.status).toBe("running");
});

test("archive retries after stop/remove and persistence failures without restopping", async () => {
  const now = "2026-01-01T00:00:00.000Z";
  const makeInfo = () => ({
    id: "worker-1",
    userId: "owner-1",
    createdAt: now,
    updatedAt: now,
    containerId: "docker-1",
    containerName: "agentor-worker-worker-1",
    displayName: "Worker 1",
    imageName: "worker:latest",
    imageId: "image-1",
    status: "running",
  });
  const archiveUnlocked = (ContainerManager.prototype as any).archiveUnlocked;

  for (const failure of ["remove", "persist"] as const) {
    const info = makeInfo();
    const containers = new Map([[info.id, info]]);
    let stopCalls = 0;
    let removeCalls = 0;
    let upsertCalls = 0;
    let archived = false;
    let recordExists = false;
    const fakeManager = {
      containers,
      assertOrdinaryMutation: () => {},
      dockerService: {
        stopContainer: async () => {
          stopCalls++;
        },
        removeContainer: async (target: string) => {
          removeCalls++;
          if (failure === "remove" && removeCalls === 1)
            throw Object.assign(new Error("transient remove failure"), {
              statusCode: 503,
            });
          if (failure === "persist" && removeCalls === 2)
            throw Object.assign(new Error("already absent"), {
              statusCode: 404,
            });
          expect(["docker-1", "agentor-worker-worker-1"]).toContain(target);
        },
      },
      containerInfoToWorkerRecord: (current: any) => ({
        id: current.id,
        userId: current.userId,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        displayName: current.displayName,
        status: "active",
      }),
      workerStore: {
        get: () => (recordExists ? { status: "active" } : undefined),
        upsert: async () => {
          upsertCalls++;
          if (failure === "persist" && upsertCalls === 1)
            throw new Error("injected archive persistence failure");
          recordExists = true;
        },
        archive: async () => {
          archived = true;
        },
      },
    };

    await expect(archiveUnlocked.call(fakeManager, info.id)).rejects.toThrow(
      failure === "remove"
        ? "transient remove failure"
        : "injected archive persistence failure",
    );
    expect(info.status).toBe(failure === "remove" ? "stopped" : "error");

    await expect(
      archiveUnlocked.call(fakeManager, info.id),
    ).resolves.toBeUndefined();
    expect(stopCalls).toBe(1);
    expect(archived).toBe(true);
    expect(containers.has(info.id)).toBe(false);
  }
});

test("rebuild retries Docker removal without stopping an already-stopped worker", async () => {
  const now = "2026-01-01T00:00:00.000Z";
  const info: any = {
    id: "worker-1",
    userId: "owner-1",
    createdAt: now,
    updatedAt: now,
    containerId: "docker-1",
    containerName: "agentor-worker-worker-1",
    displayName: "Worker 1",
    imageName: "worker:latest",
    imageId: "image-1",
    status: "running",
  };
  let stopCalls = 0;
  let removeCalls = 0;
  let archiveCalls = 0;
  const reachedRecreation = new Error("reached recreation");
  const fakeManager = {
    containers: new Map([[info.id, info]]),
    assertOrdinaryMutation: () => {},
    dockerService: {
      stopContainer: async () => {
        stopCalls++;
      },
      removeContainer: async () => {
        removeCalls++;
        if (removeCalls === 1)
          throw Object.assign(new Error("transient remove failure"), {
            statusCode: 503,
          });
      },
    },
    workerStore: {
      get: () => ({ status: "active" }),
      archive: async () => {
        archiveCalls++;
      },
    },
    resolveEnvironmentConfig: () => {
      throw reachedRecreation;
    },
  };
  const rebuildUnlocked = (ContainerManager.prototype as any).rebuildUnlocked;

  await expect(rebuildUnlocked.call(fakeManager, info.id)).rejects.toThrow(
    "transient remove failure",
  );
  expect(info.status).toBe("stopped");
  await expect(rebuildUnlocked.call(fakeManager, info.id)).rejects.toBe(
    reachedRecreation,
  );
  expect(stopCalls).toBe(1);
  expect(removeCalls).toBe(2);
  expect(archiveCalls).toBe(1);
});

test("Docker 404 still runs the complete import cleanup sequence", async () => {
  const calls: string[] = [];
  const step = (name: string) => async () => {
    calls.push(name);
  };

  await rollbackFailedWorkerImport({
    removeFromMemory: () => calls.push("memory"),
    removeMappings: step("mappings"),
    removeWorkerRecord: step("record"),
    removeWorkerConfiguration: step("configuration"),
    removeContainer: async () => {
      calls.push("container");
      await removeDockerContainerIdempotently(async () => {
        throw Object.assign(new Error("No such container"), {
          statusCode: 404,
        });
      });
    },
    removeWorkspace: step("workspace"),
    removeAgents: step("agents"),
    removeDocker: step("docker"),
    removeImportedImage: step("image"),
  });

  expect(calls).toEqual([
    "container",
    "mappings",
    "configuration",
    "workspace",
    "agents",
    "docker",
    "image",
    "record",
    "memory",
  ]);
});

test("failed import removes only its newly-created environment", async () => {
  const removed: string[] = [];
  const remove = async (id: string) => {
    removed.push(id);
  };

  await rollbackCreatedImportEnvironment("environment-1", false, remove);
  await rollbackCreatedImportEnvironment("environment-2", true, remove);
  await rollbackCreatedImportEnvironment(
    "environment-3",
    importRollbackRetainsEnvironment({
      code: "IMPORT_ROLLBACK_INCOMPLETE",
      failures: ["worker record"],
    }),
    remove,
  );
  await rollbackCreatedImportEnvironment(undefined, false, remove);

  expect(removed).toEqual(["environment-1"]);
});

test("retrying import-environment cleanup treats an already-absent environment as success", async () => {
  const removed: string[] = [];
  await removeImportEnvironmentIdempotently(
    "environment-1",
    () => false,
    async (id) => {
      removed.push(id);
    },
  );
  await removeImportEnvironmentIdempotently(
    "environment-2",
    () => true,
    async (id) => {
      removed.push(id);
    },
  );
  expect(removed).toEqual(["environment-2"]);
});

test("worker configuration deletion restores its retry handle on persistence failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-worker-config-delete-"));
  const store = new WorkerConfigStore({ dataDir: root } as never);
  await store.replace("owner-1", "worker-1", [
    { kind: "variable", key: "COLOR", value: "blue" },
  ]);
  (store as any).persist = async () => {
    throw new Error("injected worker config persistence failure");
  };

  await expect(store.remove("owner-1", "worker-1")).rejects.toThrow(
    "injected worker config persistence failure",
  );
  expect(await store.get("owner-1", "worker-1")).toBeTruthy();
  await rm(root, { recursive: true, force: true });
});

test("worker configuration serializes same-key mutation, persistence, and rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-worker-config-queue-"));
  const store = new WorkerConfigStore({ dataDir: root } as never);
  let releaseFirst!: () => void;
  let firstWriteStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  const started = new Promise<void>((resolve) => (firstWriteStarted = resolve));
  let writes = 0;
  (store as any).persist = async () => {
    writes++;
    if (writes === 1) {
      firstWriteStarted();
      await firstGate;
      throw new Error("injected first persistence failure");
    }
  };

  const first = store.replace("owner-1", "worker-1", [
    { kind: "variable", key: "COLOR", value: "blue" },
  ]);
  await started;
  const second = store.replace("owner-1", "worker-1", [
    { kind: "variable", key: "COLOR", value: "green" },
  ]);
  let readSettled = false;
  const concurrentRead = store
    .resolveValues("owner-1", "worker-1")
    .then((value) => {
      readSettled = true;
      return value;
    });
  await Promise.resolve();
  expect(writes).toBe(1);
  expect(readSettled).toBe(false);

  releaseFirst();
  await expect(first).rejects.toThrow("injected first persistence failure");
  await expect(second).resolves.toBeTruthy();
  expect(writes).toBe(2);
  expect((await concurrentRead)[0]).toMatchObject({
    key: "COLOR",
    value: "green",
  });
  await rm(root, { recursive: true, force: true });
});

test("worker deletion-pending state cannot be cleared by archive or unarchive", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-worker-store-state-"));
  const store = new WorkerStore(root);
  const createdAt = "2026-01-01T00:00:00.000Z";
  await store.upsert({
    id: "worker-1",
    userId: "owner-1",
    createdAt,
    updatedAt: createdAt,
    displayName: "Worker 1",
    status: "active",
  });
  await store.markDeletionPending("owner-1", "worker-1");
  const pending = store.get("owner-1", "worker-1")!;
  const archivedAt = pending.archivedAt;

  await store.archive("owner-1", "worker-1");
  expect(store.get("owner-1", "worker-1")).toMatchObject({
    status: "archived",
    deletionPending: true,
    archivedAt,
  });
  await expect(store.unarchive("owner-1", "worker-1")).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(store.get("owner-1", "worker-1")?.deletionPending).toBe(true);
  await rm(root, { recursive: true, force: true });
});

test("worker settings roll back in memory when durable persistence fails", async () => {
  const info: any = {
    id: "worker-1",
    userId: "owner-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    containerId: "docker-1",
    containerName: "agentor-worker-worker-1",
    displayName: "Before",
    imageName: "worker:latest",
    imageId: "image-1",
    status: "running",
    pendingRebuild: false,
  };
  const fakeManager = {
    containers: new Map([[info.id, info]]),
    assertOrdinaryMutation: () => {},
    userEnvStore: undefined,
    workerStore: {
      upsert: async () => {
        throw new Error("injected worker settings persistence failure");
      },
    },
    containerInfoToWorkerRecord: (value: unknown) => value,
  };

  await expect(
    (ContainerManager.prototype as any).updateSettingsForOwner.call(
      fakeManager,
      info.id,
      {
        displayName: "After",
        repos: [{ provider: "github", url: "example/repository" }],
      },
    ),
  ).rejects.toThrow("injected worker settings persistence failure");

  expect(info).toMatchObject({
    displayName: "Before",
    pendingRebuild: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(info).not.toHaveProperty("repos");
});

test("an import-created environment is retained once another worker references it", async () => {
  expect(
    importEnvironmentReferenced(
      "owner-1",
      "environment-1",
      [],
      [
        {
          userId: "owner-1",
          environmentId: "environment-1",
        },
      ],
    ),
  ).toBe(true);
  expect(
    importEnvironmentReferenced(
      "owner-1",
      "environment-1",
      [{ userId: "owner-2", environmentId: "environment-1" }],
      [],
    ),
  ).toBe(false);
});

test("production volume and image removers ignore only not-found errors", async () => {
  const dockerError = (statusCode: number, message: string) =>
    Object.assign(new Error(message), { statusCode });
  const storage = new StorageManager(
    {
      getVolume: () => ({
        remove: async () => {
          throw dockerError(503, "volume daemon unavailable");
        },
      }),
    } as never,
    { dataDir: "/data" } as never,
  );
  await expect(storage.removeWorkerDocker("worker-1")).rejects.toThrow(
    "volume daemon unavailable",
  );
  (storage as any).docker = {
    getVolume: () => ({
      remove: async () => {
        throw dockerError(404, "volume missing");
      },
    }),
  };
  await expect(storage.removeWorkerDocker("worker-1")).resolves.toBeUndefined();

  const images = new DockerService({} as never);
  (images as any).docker = {
    getImage: () => ({
      remove: async () => {
        throw dockerError(503, "image daemon unavailable");
      },
    }),
  };
  await expect(images.removeImage("image-1")).rejects.toThrow(
    "image daemon unavailable",
  );
  (images as any).docker = {
    getImage: () => ({
      remove: async () => {
        throw dockerError(404, "image missing");
      },
    }),
  };
  await expect(images.removeImage("image-1")).resolves.toBeUndefined();
});

test("permanent deletion runs every cleanup but retains a retryable failure list", async () => {
  const calls: string[] = [];
  const failures = await collectWorkerCleanupFailures([
    [
      "workspace",
      async () => {
        calls.push("workspace");
      },
    ],
    [
      "Docker data",
      async () => {
        calls.push("docker");
        throw new Error("daemon unavailable");
      },
    ],
    [
      "agent data",
      async () => {
        calls.push("agents");
      },
    ],
  ]);
  expect(calls).toEqual(["workspace", "docker", "agents"]);
  expect(failures).toEqual(["Docker data"]);
});

test("failed rootfs image cleanup preserves the deterministic recovery tag", async () => {
  await expect(
    removeFailedImportedImage("agentor-import-worker-1:latest", async () => {
      throw Object.assign(new Error("Docker unavailable"), {
        statusCode: 503,
      });
    }),
  ).rejects.toMatchObject({
    code: "ROOTFS_IMPORT_CLEANUP_FAILED",
    candidateImage: "agentor-import-worker-1:latest",
  });
});

test("deleted-owner cleanup removes live and archived workers under worker fences", async () => {
  const calls: string[] = [];
  const fakeManager = {
    list: () => [
      { id: "live-own", userId: "owner-1" },
      { id: "live-other", userId: "owner-2" },
      { id: "admin-own", userId: "owner-1", administrativeKind: "group" },
    ],
    workerStore: {
      listForUser: () => [
        { id: "live-own", userId: "owner-1", status: "active" },
        {
          id: "detached-own",
          userId: "owner-1",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          displayName: "Detached",
        },
        { id: "archived-own", userId: "owner-1", status: "archived" },
      ],
    },
    config: {
      containerPrefix: "agentor-worker-",
      workerImagePrefix: "",
      workerImage: "worker:latest",
    },
    containers: new Map(),
    buildContainerName: (id: string) => `agentor-worker-${id}`,
    removeUnlocked: async (id: string) => {
      calls.push(`live:${id}`);
    },
    deleteArchivedUnlocked: async (_userId: string, id: string) => {
      calls.push(`archived:${id}`);
    },
  };

  await ContainerManager.prototype.removeWorkersForDeletedOwner.call(
    fakeManager as never,
    "owner-1",
  );
  expect(calls).toEqual([
    "live:live-own",
    "live:detached-own",
    "archived:archived-own",
  ]);
  expect(fakeManager.containers.get("detached-own")).toMatchObject({
    containerId: "agentor-worker-detached-own",
    status: "error",
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
    // Successful owner cleanup durably cancels active work, drains it, deletes
    // provider state, and finally removes the owner's backup partition.
    expect(await fixture.manager.getJob(job.id)).toBeUndefined();
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
    // Owner cleanup deliberately aborts this promise before the assertion below
    // can await it. Observe the rejection immediately so strict unhandled-
    // rejection mode does not turn the expected AbortError into a test failure.
    void restore.catch(() => {});
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
