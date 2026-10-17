import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceBackupManager } from "../../orchestrator/server/utils/instance-backup-manager";
import { useBackupManager } from "../../orchestrator/server/utils/backup-manager";
import { useManagedVolumeManager } from "../../orchestrator/server/utils/managed-volume-manager";
import { useManagedVolumeSizingManager } from "../../orchestrator/server/utils/managed-volume-sizing";
import { usePortableManagedVolumeRuntime } from "../../orchestrator/server/utils/portable-managed-volume-runtime";
import { useAdminWorkspaceStore } from "../../orchestrator/server/utils/admin-workspace-store";
import { useImageCatalogManager } from "../../orchestrator/server/utils/image-catalog";
import * as services from "../../orchestrator/server/utils/services";
import { backupKeyFingerprint } from "../../orchestrator/server/utils/backup-keyring";
import { FakeBackupProvider } from "../../orchestrator/server/utils/backup-provider";
import { instanceSnapshotActive } from "../../orchestrator/server/utils/instance-snapshot-gate";

let root: string;
let active: string;
let workers: Array<{ status: string }>;
let admin: { status: string } | undefined;
let groups: Array<{ adminWorkspace: { status: string } }>;
let calls: string[];
let diagnostics: string[];
let undo: Array<() => void>;
const guards = ["backup", "managed", "sizing", "portable", "export", "image", "usage", "orphan"];

function replace(target: any, key: string, value: any) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  undo.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete target[key];
  });
}

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentor-instance-preflight-"));
  active = "";
  workers = [{ status: "stopped" }, { status: "archived" }];
  admin = { status: "stopped" };
  groups = [{ adminWorkspace: { status: "stopped" } }];
  calls = [];
  diagnostics = [];
  undo = [];
  replace(services.useContainerManager(), "list", () => workers);
  replace(useAdminWorkspaceStore(), "getRecord", () => admin);
  replace(services.useWorkerGroupStore(), "list", () => groups);
  const managers = [
    useBackupManager(), useManagedVolumeManager(), useManagedVolumeSizingManager(),
    usePortableManagedVolumeRuntime(), services.useExportJobManager(),
    useImageCatalogManager(), services.useUsageChecker(), services.useOrphanSweeper(),
  ];
  managers.forEach((manager, index) => replace(manager, "hasActiveOperationsForInstanceSnapshot", () => {
    const guard = guards[index]!;
    calls.push(guard);
    return active === guard;
  }));
});

test.afterEach(async () => {
  undo.reverse().forEach((restore) => restore());
  await rm(root, { recursive: true, force: true });
});

function manager(overrides: ConstructorParameters<typeof InstanceBackupManager>[0] = {}) {
  const provider = new FakeBackupProvider(join(root, "provider"));
  provider.bindAccount("admin", "test-account");
  const material = Buffer.alloc(32, 47).toString("base64");
  return new InstanceBackupManager({
    dataDir: root,
    backupManager: {
      instanceBackupProvider: () => provider,
      resolveInstanceRecoveryMaterial: async () => ({
        material, fingerprint: backupKeyFingerprint(material),
      }),
    } as any,
    authSnapshot: async (path) => { await writeFile(path, "test database"); },
    inventory: async () => ({
      volumes: [],
      plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
      hostMounts: { configuredPaths: [], contentsIncluded: false },
      images: { definitions: 0, immutableDigests: [], layersIncluded: false },
      storage: { mode: "volume", containerPrefix: "agentor-worker" },
    }),
    logError: (message) => { diagnostics.push(message); },
    ...overrides,
    // Deliberately do not override preflightCreate: exercise the real method.
  });
}

async function create(instance: InstanceBackupManager) {
  const queued = await instance.create("admin", "fake", { includeDockerVolumes: false });
  await expect.poll(async () => (await instance.getJob(queued.id))?.status)
    .toMatch(/succeeded|failed|cancelled/);
  expect(instanceSnapshotActive()).toBe(false);
  return (await instance.getJob(queued.id))!;
}

test("real default preflight creates an artifact with stopped workspaces and every manager idle", async () => {
  const instance = manager();
  const job = await create(instance);
  expect(job).toMatchObject({ status: "succeeded", phase: "complete" });
  expect(calls).toEqual(guards);
  expect(await instance.getArtifact(job.artifactId!)).toMatchObject({ integrityStatus: "verified" });
  expect(diagnostics).toEqual([]);
});

for (const status of ["running", "creating"]) {
  test(`real default preflight blocks an ordinary workspace that is ${status}`, async () => {
    workers.push({ status });
    expect(await create(manager())).toMatchObject({ status: "failed", errorCode: "INSTANCE_BACKUP_WORKSPACES_ACTIVE" });
    expect(calls).toEqual([]);
  });
}

test("real default preflight blocks a running platform-admin workspace", async () => {
  admin = { status: "running" };
  expect(await create(manager())).toMatchObject({ status: "failed", errorCode: "INSTANCE_BACKUP_WORKSPACES_ACTIVE" });
  expect(calls).toEqual([]);
});

for (const status of ["running", "creating"]) {
  test(`real default preflight blocks a group-admin workspace that is ${status}`, async () => {
    groups.push({ adminWorkspace: { status } });
    expect(await create(manager())).toMatchObject({ status: "failed", errorCode: "INSTANCE_BACKUP_WORKSPACES_ACTIVE" });
    expect(calls).toEqual([]);
  });
}

for (const guard of guards) {
  test(`real default preflight blocks active ${guard} operations`, async () => {
    active = guard;
    expect(await create(manager())).toMatchObject({ status: "failed", errorCode: "INSTANCE_BACKUP_JOBS_ACTIVE" });
    expect(calls).toEqual(guards.slice(0, guards.indexOf(guard) + 1));
  });
}

test("unexpected failures log the job and original phase with safe exception locations", async () => {
  const managed = useManagedVolumeManager();
  replace(managed, "hasActiveOperationsForInstanceSnapshot", () => {
    throw new ReferenceError("useManagedVolumeManager is not defined");
  });
  const instance = manager();
  const job = await create(instance);
  expect(job).toMatchObject({ status: "failed", errorCode: "INSTANCE_BACKUP_FAILED" });
  expect(diagnostics).toHaveLength(1);
  expect(JSON.parse(diagnostics[0]!.replace("[instance-backup] ", ""))).toMatchObject({
    jobId: job.id, operation: "create", phase: "preflight", type: "ReferenceError",
    reference: "useManagedVolumeManager is not defined",
    locations: expect.arrayContaining([expect.stringMatching(/^instance-backup-manager\.ts:\d+:\d+$/)]),
  });
  expect(JSON.stringify(await instance.logs(job.id))).not.toContain("ReferenceError");
});

test("diagnostics omit arbitrary error messages, causes, properties, and stack headers", async () => {
  const secret = "short-secret";
  const material = Buffer.alloc(32, 47).toString("base64");
  const error = Object.assign(new TypeError(`Authorization: Bearer ${secret}; key=${material}`), {
    cause: new Error(secret), response: { token: secret }, code: secret,
  });
  const job = await create(manager({ authSnapshot: async () => { throw error; } }));
  expect(job).toMatchObject({ status: "failed", errorCode: "INSTANCE_BACKUP_FAILED" });
  const output = JSON.stringify({ diagnostics, job });
  expect(output).not.toContain(secret);
  expect(output).not.toContain(material);
  expect(diagnostics[0]).toContain('"phase":"database-snapshot"');
  expect(diagnostics[0]).toContain('"type":"TypeError"');
});

test("a failed diagnostic logger cannot prevent persistence of the failed job", async () => {
  const original = console.error;
  const fallback: string[] = [];
  console.error = (message) => { fallback.push(message); };
  try {
    const job = await create(manager({
      authSnapshot: async () => { throw new Error("private provider response"); },
      logError: () => { throw new Error("logging unavailable"); },
    }));
    expect(job.status).toBe("failed");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toContain(job.id);
    expect(fallback[0]).not.toContain("private provider response");
  } finally {
    console.error = original;
  }
});
