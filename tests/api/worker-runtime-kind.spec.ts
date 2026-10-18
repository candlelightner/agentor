import { expect, test } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeWorkerRuntimeKind } from "../../orchestrator/shared/types";
import { WorkerStore } from "../../orchestrator/server/utils/worker-store";
import { ContainerManager } from "../../orchestrator/server/utils/container";

(globalThis as any).useLogCollector ??= () => ({
  detach() {},
  attach: async () => undefined,
});
(globalThis as any).useLogger ??= () => ({
  error() {},
  warn() {},
  info() {},
  debug() {},
});

test.describe("Worker runtime kind", () => {
  test("normalizeWorkerRuntimeKind resolves legacy-docker for undefined, null, unknown, and legacy values", () => {
    expect(normalizeWorkerRuntimeKind(undefined)).toBe("legacy-docker");
    expect(normalizeWorkerRuntimeKind(null)).toBe("legacy-docker");
    expect(normalizeWorkerRuntimeKind("")).toBe("legacy-docker");
    expect(normalizeWorkerRuntimeKind("unknown-runtime")).toBe("legacy-docker");
    expect(normalizeWorkerRuntimeKind("docker")).toBe("legacy-docker");
    expect(normalizeWorkerRuntimeKind("legacy-docker")).toBe("legacy-docker");
  });

  test("normalizeWorkerRuntimeKind resolves incus-vm only for explicit incus-vm", () => {
    expect(normalizeWorkerRuntimeKind("incus-vm")).toBe("incus-vm");
  });

  test("WorkerStore loads legacy records without runtimeKind as legacy-docker", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "agentor-test-worker-store-"));
    try {
      const userDir = join(testDir, "users", "user-1");
      await mkdir(userDir, { recursive: true });

      // Write a legacy workers.json containing a record without runtimeKind
      const legacyWorker = {
        id: "worker-legacy-1",
        userId: "user-1",
        displayName: "Legacy Worker 1",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      await writeFile(
        join(userDir, "workers.json"),
        JSON.stringify([legacyWorker], null, 2),
      );

      const store = new WorkerStore(testDir);
      await store.init();

      // get()
      const fetched = store.get("user-1", "worker-legacy-1");
      expect(fetched).toBeDefined();
      expect(fetched?.runtimeKind).toBe("legacy-docker");

      // findById()
      const found = store.findById("worker-legacy-1");
      expect(found).toBeDefined();
      expect(found?.runtimeKind).toBe("legacy-docker");

      // list()
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.runtimeKind).toBe("legacy-docker");

      // listForUser()
      const userList = store.listForUser("user-1");
      expect(userList).toHaveLength(1);
      expect(userList[0]?.runtimeKind).toBe("legacy-docker");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("WorkerStore preserves explicit incus-vm across upsert and reload", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "agentor-test-worker-store-"));
    try {
      const store = new WorkerStore(testDir);
      await store.init();

      await store.upsert({
        id: "worker-incus-1",
        userId: "user-1",
        displayName: "Incus Worker 1",
        status: "active",
        runtimeKind: "incus-vm",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const fetched = store.get("user-1", "worker-incus-1");
      expect(fetched?.runtimeKind).toBe("incus-vm");

      // Reload store from disk
      const store2 = new WorkerStore(testDir);
      await store2.init();
      const reloaded = store2.get("user-1", "worker-incus-1");
      expect(reloaded?.runtimeKind).toBe("incus-vm");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("ContainerManager sync resolves legacy worker without runtimeKind to legacy-docker", async () => {
    const docker = {
      listContainers: async () => [
        {
          Id: "docker-cid-1",
          Names: ["/agentor-worker-legacy-1"],
          Image: "agentor-worker:latest",
          ImageID: "sha256:img1",
          State: "running",
          Labels: { "agentor.id": "legacy-1" },
        },
      ],
    };
    const manager = new ContainerManager(
      docker as any,
      { containerPrefix: "agentor-worker", incusEnabled: false } as any,
    );
    manager.setWorkerStore({
      list: () => [
        {
          id: "legacy-1",
          userId: "user-1",
          displayName: "Legacy 1",
          status: "active",
        },
      ],
      get: () => ({ id: 'legacy-1', userId: 'user-1', displayName: 'Legacy 1', status: 'active' }),
      findById: () => ({
        id: "legacy-1",
        userId: "user-1",
        displayName: "Legacy 1",
        status: "active",
      }),
      listActive: () => [
        {
          id: "legacy-1",
          userId: "user-1",
          displayName: "Legacy 1",
          status: "active",
        },
      ],
      listArchived: () => [],
    } as any);

    await manager.sync();

    const info = manager.get("legacy-1");
    expect(info).toBeDefined();
    expect(info?.runtimeKind).toBe("legacy-docker");
  });

  test("ContainerManager sync quarantines Docker containers claiming an Incus worker identity", async () => {
    const docker = {
      listContainers: async () => [
        {
          Id: "docker-cid-2",
          Names: ["/agentor-worker-incus-1"],
          Image: "agentor-worker:latest",
          ImageID: "sha256:img2",
          State: "running",
          Labels: { "agentor.id": "incus-1" },
        },
      ],
    };
    const manager = new ContainerManager(
      docker as any,
      { containerPrefix: "agentor-worker", incusEnabled: true } as any,
    );
    manager.setWorkerStore({
      list: () => [
        {
          id: "incus-1",
          userId: "user-1",
          displayName: "Incus 1",
          status: "active",
          runtimeKind: "incus-vm",
        },
      ],
      get: () => ({ id: 'incus-1', userId: 'user-1', displayName: 'Incus 1', status: 'active', runtimeKind: 'incus-vm' }),
      findById: () => ({
        id: "incus-1",
        userId: "user-1",
        displayName: "Incus 1",
        status: "active",
        runtimeKind: "incus-vm",
      }),
      listActive: () => [
        {
          id: "incus-1",
          userId: "user-1",
          displayName: "Incus 1",
          status: "active",
          runtimeKind: "incus-vm",
        },
      ],
      listArchived: () => [],
    } as any);

    await manager.sync();

    const info = manager.get("incus-1");
    expect(info).toMatchObject({ runtimeKind: 'incus-vm', containerId: 'agentor-worker-incus-1', status: 'unknown',
      runtimeDiagnostic: { code: 'INCUS_COMPUTE_UNVERIFIED' } });
    expect(info?.containerId).not.toBe('docker-cid-2');
  });
});
