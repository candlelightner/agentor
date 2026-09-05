import { expect, test } from "@playwright/test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateInstanceBackupOwnerArgument,
  validateManagementOwnerArguments,
} from "../../orchestrator/server/utils/management-owner";
import { UserEnvVarStore } from "../../orchestrator/server/utils/user-env-store";
import { UserScopedJsonStore } from "../../orchestrator/server/utils/user-scoped-store";
import { BackupStore } from "../../orchestrator/server/utils/backup-store";
import { WorkspaceTombstoneStore } from "../../orchestrator/server/utils/workspace-tombstones";
import { cleanManagementAuditDetails } from "../../orchestrator/server/utils/management-mcp-store";

test("management owner selectors allow real cross-user administration", async () => {
  const real = new Set(["admin-owner", "other_owner", "uuid-owner-2"]);
  const exists = (id: string) => real.has(id);

  await expect(
    validateManagementOwnerArguments({ ownerId: "other_owner" }, exists),
  ).resolves.toBeUndefined();
  await expect(
    validateManagementOwnerArguments({ userId: "uuid-owner-2" }, exists),
  ).resolves.toBeUndefined();
  await expect(validateManagementOwnerArguments({}, exists)).resolves.toBeUndefined();
  await expect(
    validateManagementOwnerArguments({ ownerId: "missing-owner" }, exists),
  ).rejects.toMatchObject({ statusCode: 404 });
});

test("whole-instance recovery namespaces require a platform-admin owner", async () => {
  const admins = new Set(["admin-owner"]);
  const isAdmin = (id: string) => admins.has(id);

  await expect(
    validateInstanceBackupOwnerArgument({ ownerId: "admin-owner" }, isAdmin),
  ).resolves.toBeUndefined();
  await expect(
    validateInstanceBackupOwnerArgument({ ownerId: "ordinary-owner" }, isAdmin),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    validateInstanceBackupOwnerArgument({}, isAdmin),
  ).resolves.toBeUndefined();
});

test("management audit redacts backup provider upload and cleanup handles", () => {
  expect(
    cleanManagementAuditDetails({
      providerUploadId: "session",
      pendingProviderUploadId: "pending-session",
      pendingProviderObjectId: "object",
      pendingProviderArtifactId: "artifact",
      jobId: "safe-job-id",
    }),
  ).toEqual({
    providerUploadId: "[REDACTED]",
    pendingProviderUploadId: "[REDACTED]",
    pendingProviderObjectId: "[REDACTED]",
    pendingProviderArtifactId: "[REDACTED]",
    jobId: "safe-job-id",
  });
});

test("management owner selectors reject traversal and encoded-ish separators", async () => {
  const invalid = [
    "../admin",
    "..",
    "/absolute",
    "owner/child",
    "owner\\child",
    "%2e%2e%2fadmin",
    "owner%2Fchild",
    "owner%5cchild",
    "owner..child",
    "",
  ];

  for (const ownerId of invalid) {
    await expect(
      validateManagementOwnerArguments({ ownerId }, () => true),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      validateManagementOwnerArguments({ userId: ownerId }, () => true),
    ).rejects.toMatchObject({ statusCode: 400 });
  }
});

test("user env persistence rejects an owner path before map or filesystem mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-owner-path-"));
  const dataDir = join(root, "data");
  const store = new UserEnvVarStore(dataDir);

  await expect(
    store.upsert("../escaped", { envVars: [{ key: "COLOR", value: "red" }] }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(store.list()).toEqual([]);
  await expect(access(join(root, "escaped", "env-vars.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await rm(root, { recursive: true, force: true });
});

test("user-scoped stores quarantine records whose embedded owner crosses partitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-owner-partition-"));
  const ownerId = "legacy_User-id";
  const ownerDir = join(root, "users", ownerId);
  await mkdir(ownerDir, { recursive: true });
  await writeFile(
    join(ownerDir, "records.json"),
    JSON.stringify([
      { id: "record-valid", userId: ownerId },
      { id: "record-1", userId: "owner-b" },
    ]),
  );

  class Store extends UserScopedJsonStore<string, { id: string; userId: string }> {
    constructor() {
      super(root, "records.json", (item) => item.id);
    }
    save(ownerId: string, item: { id: string; userId: string }) {
      return this.setItem(ownerId, item);
    }
  }

  const store = new Store();
  (globalThis as any).useLogger = () => ({ error() {}, warn() {}, info() {}, debug() {} });
  await store.init();
  expect(store.list()).toEqual([]);
  expect(() => store.listForUser(ownerId)).toThrow(/unavailable/);
  await expect(
    store.save(ownerId, { id: "record-2", userId: "owner-b" }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    store.save(ownerId, { id: "record-2", userId: ownerId }),
  ).rejects.toMatchObject({ statusCode: 503 });
  expect(JSON.parse(await readFile(join(ownerDir, "records.json"), "utf8"))).toEqual([
    { id: "record-valid", userId: ownerId },
    { id: "record-1", userId: "owner-b" },
  ]);
  await rm(root, { recursive: true, force: true });
});

test("a corrupt user-scoped file stays quarantined and cannot be overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-corrupt-owner-store-"));
  const ownerId = "owner-corrupt";
  const ownerDir = join(root, "users", ownerId);
  const path = join(ownerDir, "records.json");
  const corrupt = '[{"id":"partial"';
  await mkdir(ownerDir, { recursive: true });
  await writeFile(path, corrupt);

  class Store extends UserScopedJsonStore<string, { id: string; userId: string }> {
    constructor() {
      super(root, "records.json", (item) => item.id);
    }
    save(userId: string, item: { id: string; userId: string }) {
      return this.setItem(userId, item);
    }
  }

  const store = new Store();
  (globalThis as any).useLogger = () => ({ error() {}, warn() {}, info() {}, debug() {} });
  await store.init();
  expect(store.listUserIds()).toContain(ownerId);
  expect(() => store.get(ownerId, "partial")).toThrow(/unavailable/);
  await expect(store.save(ownerId, { id: "replacement", userId: ownerId }))
    .rejects.toMatchObject({ statusCode: 503 });
  expect(await readFile(path, "utf8")).toBe(corrupt);

  // Authoritative deleted-owner cleanup can still remove quarantined bytes.
  await expect(store.removeForUser(ownerId)).resolves.toBe(0);
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(store.listUserIds()).not.toContain(ownerId);
  await rm(root, { recursive: true, force: true });
});

test("user-scoped deletion restores its in-memory retry handle when persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-store-delete-"));
  class Store extends UserScopedJsonStore<string, { id: string; userId: string }> {
    failPersistence = false;
    constructor() {
      super(root, "records.json", (item) => item.id);
    }
    save(userId: string, item: { id: string; userId: string }) {
      return this.setItem(userId, item);
    }
    remove(userId: string, id: string) {
      return this.deleteItem(userId, id);
    }
    protected override persistUser(userId: string): Promise<void> {
      if (this.failPersistence) {
        return Promise.reject(new Error("injected persistence failure"));
      }
      return super.persistUser(userId);
    }
  }

  const store = new Store();
  await store.save("owner-1", { id: "record-1", userId: "owner-1" });
  store.failPersistence = true;
  await expect(store.remove("owner-1", "record-1")).rejects.toThrow(
    "injected persistence failure",
  );
  expect(store.get("owner-1", "record-1")).toEqual({
    id: "record-1",
    userId: "owner-1",
  });
  await rm(root, { recursive: true, force: true });
});

test("user-scoped bulk removal restores retry handles when persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-store-remove-where-"));
  class Store extends UserScopedJsonStore<string, { id: string; userId: string }> {
    failPersistence = false;
    constructor() {
      super(root, "records.json", (item) => item.id);
    }
    save(userId: string, item: { id: string; userId: string }) {
      return this.setItem(userId, item);
    }
    removeMatching(predicate: (item: { id: string; userId: string }) => boolean) {
      return this.removeWhere(predicate);
    }
    protected override persistUser(userId: string): Promise<void> {
      if (this.failPersistence) {
        return Promise.reject(new Error("injected persistence failure"));
      }
      return super.persistUser(userId);
    }
  }

  const store = new Store();
  await store.save("owner-1", { id: "record-1", userId: "owner-1" });
  await store.save("owner-1", { id: "record-2", userId: "owner-1" });
  store.failPersistence = true;
  await expect(store.removeMatching(() => true)).rejects.toThrow(
    "injected persistence failure",
  );
  expect(store.listForUser("owner-1").map((item) => item.id).sort()).toEqual([
    "record-1",
    "record-2",
  ]);
  await rm(root, { recursive: true, force: true });
});

test("a failed queued write cannot roll back a newer same-key update", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-store-serialized-mutation-"));
  let releaseFailure!: () => void;
  let failureStarted!: () => void;
  const failureGate = new Promise<void>((resolve) => (releaseFailure = resolve));
  const started = new Promise<void>((resolve) => (failureStarted = resolve));
  class Store extends UserScopedJsonStore<string, { id: string; userId: string; value: string }> {
    failNext = false;
    constructor() {
      super(root, "records.json", (item) => item.id);
    }
    save(item: { id: string; userId: string; value: string }) {
      return this.setItem(item.userId, item);
    }
    protected override async persistUser(userId: string): Promise<void> {
      if (this.failNext) {
        this.failNext = false;
        failureStarted();
        await failureGate;
        throw new Error("injected queued failure");
      }
      return super.persistUser(userId);
    }
  }

  const store = new Store();
  await store.save({ id: "record-1", userId: "owner-1", value: "v0" });
  store.failNext = true;
  const first = store.save({ id: "record-1", userId: "owner-1", value: "v1" });
  await started;
  const second = store.save({ id: "record-1", userId: "owner-1", value: "v2" });
  releaseFailure();
  await expect(first).rejects.toThrow("injected queued failure");
  await expect(second).resolves.toBeUndefined();
  expect(store.get("owner-1", "record-1")?.value).toBe("v2");
  expect(JSON.parse(await readFile(join(root, "users", "owner-1", "records.json"), "utf8")))
    .toEqual([{ id: "record-1", userId: "owner-1", value: "v2" }]);
  await rm(root, { recursive: true, force: true });
});

test("user-scoped owner removal retains its candidate when unlink fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-store-remove-owner-"));
  class Store extends UserScopedJsonStore<string, { id: string; userId: string }> {
    constructor() {
      super(root, "records.json", (item) => item.id);
    }
    save(userId: string, item: { id: string; userId: string }) {
      return this.setItem(userId, item);
    }
  }

  const store = new Store();
  await store.save("owner-1", { id: "record-1", userId: "owner-1" });
  const persistedPath = join(root, "users", "owner-1", "records.json");
  await rm(persistedPath, { force: true });
  await mkdir(join(persistedPath, "non-empty"), { recursive: true });
  await expect(store.removeForUser("owner-1")).rejects.toBeTruthy();
  expect(store.listUserIds()).toContain("owner-1");
  expect(store.get("owner-1", "record-1")).toBeTruthy();
  await rm(root, { recursive: true, force: true });
});

test("workspace tombstone persistence recovers after a rejected save", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-tombstone-queue-"));
  const dataDir = join(root, "data");
  await writeFile(dataDir, "blocks mkdir");
  const store = new WorkspaceTombstoneStore(dataDir);
  const first = {
    workerId: "worker-1",
    userId: "owner-1",
    displayName: "first",
    backend: "directory" as const,
  };
  await expect(store.record(first)).rejects.toBeTruthy();

  await rm(dataDir, { force: true });
  await mkdir(dataDir);
  await expect(store.record({ ...first, workerId: "worker-2", displayName: "second" }))
    .resolves.toBeUndefined();
  expect((await store.list()).map((entry) => entry.workerId)).toEqual(["worker-2"]);
  expect(JSON.parse(await readFile(join(dataDir, "workspace-tombstones.json"), "utf8")))
    .toMatchObject({ entries: [{ workerId: "worker-2" }] });
  await rm(root, { recursive: true, force: true });
});

test("historical URL-safe owner ids load while unsafe backup records are quarantined without rewrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-owner-legacy-"));
  const ownerId = "legacy_User-id";
  const ownerDir = join(root, "users", ownerId);
  const source = {
    schemaVersion: 1,
    config: { schemaVersion: 1, userId: ownerId, provider: "local", enabled: false, intervalMinutes: 60, retentionCount: 2, selectedWorkspaceIds: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    jobs: [
      { schemaVersion: 1, id: "job-valid_1", userId: ownerId, workspaceId: "workspace-1", provider: "local", status: "succeeded", phase: "complete", progress: 100, bytesProcessed: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", attempt: 1 },
      { schemaVersion: 1, id: "job-cross-owner", userId: "other-owner", workspaceId: "workspace-1", provider: "local", status: "failed", phase: "failed", progress: 0, bytesProcessed: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", attempt: 1 },
      { schemaVersion: 1, id: "job-mismatched-owner-id", userId: ownerId, ownerId: "other-owner", workspaceId: "workspace-1", provider: "local", status: "failed", phase: "failed", progress: 0, bytesProcessed: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", attempt: 1 },
    ],
    artifacts: [
      { schemaVersion: 1, id: "artifact-valid_1", userId: ownerId, workspaceId: "workspace-1", provider: "local", providerObjectId: "object-valid_1", createdAt: "2026-01-01T00:00:00.000Z", size: 1, sha256: "a".repeat(64), missingSecrets: [] },
      { schemaVersion: 1, id: "../artifact-escape", userId: ownerId, workspaceId: "workspace-1", provider: "local", providerObjectId: "../object-escape", createdAt: "2026-01-01T00:00:00.000Z", size: 1, sha256: "b".repeat(64), missingSecrets: [] },
    ],
  };
  await mkdir(ownerDir, { recursive: true });
  const path = join(ownerDir, "backups.json");
  const original = JSON.stringify(source);
  await writeFile(path, original);

  const store = new BackupStore(root);
  await store.init();
  expect(store.userIds()).toEqual([ownerId]);
  expect(store.get(ownerId).config?.userId).toBe(ownerId);
  expect(store.get(ownerId).jobs.map((job) => job.id)).toEqual(["job-valid_1"]);
  expect(store.get(ownerId).artifacts.map((artifact) => artifact.id)).toEqual(["artifact-valid_1"]);
  expect(await readFile(path, "utf8")).toBe(original);
  await rm(root, { recursive: true, force: true });
});

test("corrupt backup state is quarantined, preserved, and closed by owner cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-corrupt-backup-store-"));
  const ownerId = "owner-corrupt-backup";
  const ownerDir = join(root, "users", ownerId);
  const path = join(ownerDir, "backups.json");
  const corrupt = '{"schemaVersion":1,"jobs":[';
  await mkdir(ownerDir, { recursive: true });
  await writeFile(path, corrupt);
  (globalThis as any).useLogger = () => ({ error() {}, warn() {}, info() {}, debug() {} });

  const store = new BackupStore(root);
  await store.init();
  expect(store.userIds()).toContain(ownerId);
  expect(() => store.get(ownerId)).toThrow(/unavailable/);
  await expect(store.update(ownerId, () => undefined)).rejects.toMatchObject({ statusCode: 503 });
  expect(await readFile(path, "utf8")).toBe(corrupt);

  await store.forget(ownerId);
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(store.update(ownerId, () => undefined)).rejects.toMatchObject({ statusCode: 410 });
  await rm(root, { recursive: true, force: true });
});
