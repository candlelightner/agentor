import { expect, test } from "@playwright/test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManagementOwnerArguments } from "../../orchestrator/server/utils/management-owner";
import { UserEnvVarStore } from "../../orchestrator/server/utils/user-env-store";
import { UserScopedJsonStore } from "../../orchestrator/server/utils/user-scoped-store";
import { BackupStore } from "../../orchestrator/server/utils/backup-store";

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
  expect(store.list()).toEqual([{ id: "record-valid", userId: ownerId }]);
  await expect(
    store.save(ownerId, { id: "record-2", userId: "owner-b" }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(JSON.parse(await readFile(join(ownerDir, "records.json"), "utf8"))).toEqual([
    { id: "record-valid", userId: ownerId },
    { id: "record-1", userId: "owner-b" },
  ]);
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
