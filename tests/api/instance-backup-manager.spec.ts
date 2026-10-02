import { expect, test } from "@playwright/test";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { backupKeyFingerprint } from "../../orchestrator/server/utils/backup-keyring";
import {
  FakeBackupProvider,
  type BackupProvider,
} from "../../orchestrator/server/utils/backup-provider";
import type { BackupManager } from "../../orchestrator/server/utils/backup-manager";
import { InstanceBackupManager } from "../../orchestrator/server/utils/instance-backup-manager";
import { InstanceBackupStore } from "../../orchestrator/server/utils/instance-backup-store";
import { encryptInstanceBackup } from "../../orchestrator/server/utils/instance-backup-crypto";
import {
  beginInstanceRestore,
  instanceControlPlaneBarrierKind,
  beginInstanceSnapshot,
  instanceSnapshotActive,
  instanceSnapshotJobId,
  instanceControlPlaneCoordinator,
} from "../../orchestrator/server/utils/instance-snapshot-gate";

const orchestratorRequire = createRequire(
  new URL("../../orchestrator/package.json", import.meta.url),
);
const tar = orchestratorRequire("tar-stream") as { pack(): any };

function heldOperation() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function drainManagerFixture(timeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-instance-drain-'));
  const provider = new FakeBackupProvider(join(root, 'provider'));
  const calls: string[] = [];
  const manager = new InstanceBackupManager({
    dataDir: root, controlPlaneDrainTimeoutMs: timeoutMs,
    backupManager: { instanceBackupProvider: () => provider } as unknown as BackupManager,
    preflightCreate: async () => { calls.push('preflight'); },
    authSnapshot: async () => { calls.push('snapshot'); throw new Error('Intentional snapshot boundary stop'); },
  });
  await manager.init();
  return { manager, root, calls, close: async () => {
    manager.stop();
    await Promise.allSettled([...(manager as any).tasks.values()] as Promise<void>[]);
    await rm(root, { recursive: true, force: true });
  } };
}

test('snapshot waits for both logical writes and accepting request final audit before authoritative preflight', async () => {
  const f = await drainManagerFixture(), held = heldOperation(), accepted = heldOperation();
  let id!: string;
  const request = instanceControlPlaneCoordinator.run(async () => {
    f.calls.push('first-write');
    id = (await f.manager.create('owner', 'fake')).id;
    accepted.resolve(); await held.promise;
    await instanceControlPlaneCoordinator.run(() => { f.calls.push('second-write'); });
    f.calls.push('final-audit');
  });
  try {
    await accepted.promise;
    await expect.poll(instanceSnapshotActive).toBe(true);
    expect(f.calls).toEqual(['first-write']);
    held.resolve(); await request; await settled(f.manager, id);
    expect(f.calls).toEqual(['first-write', 'second-write', 'final-audit', 'preflight', 'snapshot']);
  } finally { held.resolve(); await request; await f.close(); }
});

test('snapshot drain timeout never reaches preflight or snapshots and keeps the writer accounted', async () => {
  const f = await drainManagerFixture(10), held = heldOperation();
  const writer = instanceControlPlaneCoordinator.run(() => held.promise);
  try {
    const job = await f.manager.create('owner', 'fake');
    expect((await settled(f.manager, job.id)).status).toBe('failed');
    expect(f.calls).toEqual([]); expect(instanceControlPlaneCoordinator.activeOperations).toBe(1);
    expect(instanceSnapshotActive()).toBe(false);
    held.resolve(); await writer; expect(instanceControlPlaneCoordinator.activeOperations).toBe(0);
  } finally { held.resolve(); await writer; await f.close(); }
});

test('cancelled drain never reaches a snapshot and does not cancel another admitted writer', async () => {
  const f = await drainManagerFixture(), held = heldOperation();
  const writer = instanceControlPlaneCoordinator.run(() => held.promise);
  try {
    const job = await f.manager.create('owner', 'fake');
    await expect.poll(instanceSnapshotActive).toBe(true);
    await f.manager.cancel(job.id);
    await expect.poll(instanceSnapshotActive).toBe(false);
    expect((await settled(f.manager, job.id)).status).toBe('cancelled');
    expect(f.calls).toEqual([]); expect(instanceControlPlaneCoordinator.activeOperations).toBe(1);
  } finally { held.resolve(); await writer; await f.close(); }
});

test('barrier-only control reads without initialization and aborts only the exact running owner job', async () => {
  const f = await drainManagerFixture(), held = heldOperation();
  const writer = instanceControlPlaneCoordinator.run(() => held.promise);
  try {
    const job = await f.manager.create('owner', 'fake');
    await expect.poll(instanceSnapshotActive).toBe(true);
    const originalInit = f.manager.init;
    f.manager.init = () => { throw new Error('Barrier path must never initialize'); };
    try {
      expect(f.manager.barrierControlJob(job.id, 'other', true)).toBeUndefined();
      expect(f.manager.barrierControlJob('other', 'owner', true)).toBeUndefined();
      expect(f.manager.barrierControlJob(job.id, 'owner')?.id).toBe(job.id);
      expect((f.manager as any).controllers.get(job.id).signal.aborted).toBe(false);
      expect(f.manager.barrierControlJob(job.id, 'owner', true)?.id).toBe(job.id);
      expect((f.manager as any).controllers.get(job.id).signal.aborted).toBe(true);
      expect(instanceSnapshotActive()).toBe(true);
    } finally { f.manager.init = originalInit; }
    await expect.poll(instanceSnapshotActive).toBe(false);
    expect((await settled(f.manager, job.id)).status).toBe('cancelled');
    expect(f.calls).toEqual([]); expect(instanceControlPlaneCoordinator.activeOperations).toBe(1);
  } finally { held.resolve(); await writer; await f.close(); }
});

test('barrier control refuses uninitialized, undispatched and already-applying restore cancellation', () => {
  const job = { id: 'barrier-job', userId: 'owner', operation: 'restore', status: 'queued', phase: 'queued' };
  let reads = 0;
  const manager = new InstanceBackupManager({ dataDir: '/unused-barrier-control', docker: {} as any,
    backupManager: {} as any, store: { getJob: () => { reads++; return { ...job }; } } as any });
  const release = beginInstanceRestore(job.id);
  try {
    expect(manager.barrierControlJob(job.id, 'owner', true)).toBeUndefined(); expect(reads).toBe(0);
    (manager as any).initializationComplete = true;
    expect(() => manager.barrierControlJob(job.id, 'owner', true)).toThrow('cannot currently be cancelled');
    const controller = new AbortController(); (manager as any).controllers.set(job.id, controller);
    job.status = 'running'; job.phase = 'applying';
    expect(() => manager.barrierControlJob(job.id, 'owner', true)).toThrow('cannot currently be cancelled');
    expect(controller.signal.aborted).toBe(false);
  } finally { release(); }
});

test('post-drain workload preflight can veto snapshots after an admitted writer changes state', async () => {
  const f = await drainManagerFixture(), held = heldOperation(); let workload = false;
  (f.manager as any).preflightCreate = async () => {
    f.calls.push('preflight'); if (workload) throw new Error('New workload requires quiescence');
  };
  const writer = instanceControlPlaneCoordinator.run(async () => { await held.promise; workload = true; });
  try {
    const job = await f.manager.create('owner', 'fake'); await expect.poll(instanceSnapshotActive).toBe(true);
    held.resolve(); await writer;
    expect((await settled(f.manager, job.id)).status).toBe('failed');
    expect(f.calls).toEqual(['preflight']);
  } finally { held.resolve(); await writer; await f.close(); }
});

test('snapshot drain dispatches an admitted ordinary instance job queued behind itself without self-deadlock', async () => {
  const f = await drainManagerFixture(), continueRequest = heldOperation(), accepted = heldOperation();
  let snapshotId!: string, childId!: string;
  const request = instanceControlPlaneCoordinator.run(async () => {
    snapshotId = (await f.manager.create('owner', 'fake')).id;
    accepted.resolve(); await continueRequest.promise;
    childId = (await f.manager.discover('owner', 'fake')).id;
    f.calls.push('accepting-request-finished');
  });
  try {
    await accepted.promise; await expect.poll(instanceSnapshotActive).toBe(true);
    continueRequest.resolve(); await request;
    expect((await settled(f.manager, childId)).status).toBe('succeeded');
    await settled(f.manager, snapshotId);
    expect(f.calls).toEqual(['accepting-request-finished', 'preflight', 'snapshot']);
  } finally { continueRequest.resolve(); await request; await f.close(); }
});

/** Execute the real module and constructor-selected default preflight in an
 * isolated CommonJS transform. Every service import is a safe mock; no Nitro
 * globals, Docker clients, singleton initialization or filesystem stores run.
 * In particular, do not install a global useManagedVolumeManager: that would
 * conceal the missing lexical binding this regression is intended to catch.
 */
async function defaultPreflightFixture(active = "") {
  let workerUnavailable = active === 'worker-store';
  const calls: string[] = [];
  const operation = (name: string) => ({
    hasActiveOperationsForInstanceSnapshot: () => { calls.push(name); return active === name; },
  });
  const backup = operation("backup");
  const modules: Record<string, unknown> = {
    "node:path": { join },
    "./services": {
      useWorkerStore: () => ({ hasUnavailableOwners: () => workerUnavailable,
        list: () => { calls.push('unsafe-worker-list'); return []; },
        listUserIds: () => { calls.push('strict-worker-list'); return []; } }),
      useStorageManager: () => ({ assertInitializedForInstanceSnapshot() {}, mode: 'volume' }),
      useContainerManager: () => ({
        list: () => active === "worker" ? [{ status: "running" }] : [],
        hasPendingRuntimeMigrations: async () => { calls.push("migration"); return active === "migration"; },
      }),
      useWorkerGroupStore: () => ({ list: () => [] }),
      useExportJobManager: () => operation("export"),
      useUsageChecker: () => operation("usage"),
      useOrphanSweeper: () => operation("orphan"),
      useUpdateChecker: () => operation("update"),
    },
    "./admin-workspace-store": { useAdminWorkspaceStore: () => ({ getRecord: () => undefined }) },
    "./backup-manager": { useBackupManager: () => backup },
    "./managed-volume-manager": { useManagedVolumeManager: () => operation("managed-volume") },
    "./managed-volume-sizing": { useManagedVolumeSizingManager: () => operation("sizing") },
    "./portable-managed-volume-runtime": { usePortableManagedVolumeRuntime: () => operation("portable") },
    "./image-catalog": { useImageCatalogManager: () => operation("image") },
  };
  const source = await readFile(new URL("../../orchestrator/server/utils/instance-backup-manager.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(compiled, {
    exports,
    // Unused imports receive empty modules, never access real services.
    require: (id: string) => modules[id] ?? Object.freeze({}),
  }, { timeout: 1_000 });
  const manager = new exports.InstanceBackupManager({
    dataDir: "/unused-synthetic-preflight", docker: {}, store: { getArtifact: () => ({ userId: 'owner', manifest: {} }) }, backupManager: backup,
    authSnapshot: async () => { throw new Error("Snapshot must not run in preflight fixture"); },
  });
  return { calls, run: () => manager.preflightCreate(), inventory: () => manager.inventory('owner'),
    quarantine: () => { workerUnavailable = true; }, restore: () => {
    manager.init = async () => {};
    return manager.restorePreflight('owner', 'artifact');
  } };
}

for (const operation of ['run', 'restore'] as const) test(`instance ${operation === 'run' ? 'backup' : 'restore'} preflight rejects unavailable worker owners before inventory`, async () => {
  const fixture = await defaultPreflightFixture('worker-store');
  await expect(fixture[operation]()).rejects.toMatchObject({ statusCode: 503, code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  expect(fixture.calls).toEqual([]);
});

test('production backup inventory rejects a worker owner becoming unavailable after successful preflight', async () => {
  const fixture = await defaultPreflightFixture();
  await fixture.run(); fixture.calls.length = 0;
  fixture.quarantine();
  await expect(fixture.inventory()).rejects.toMatchObject({ statusCode: 503, code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  expect(fixture.calls).toEqual([]);
});

test("default instance preflight resolves managed-volume binding and visits every quiescence guard", async () => {
  const fixture = await defaultPreflightFixture();
  await expect(fixture.run()).resolves.toBeUndefined();
  expect(fixture.calls).toEqual(["migration", "backup", "managed-volume", "sizing", "portable", "export", "image", "usage", "orphan", "update"]);
});

for (const active of ["managed-volume", "orphan", "update"]) {
  test(`default instance preflight rejects active ${active} operations`, async () => {
    const fixture = await defaultPreflightFixture(active);
    await expect(fixture.run()).rejects.toMatchObject({ code: "INSTANCE_BACKUP_JOBS_ACTIVE", statusCode: 409 });
    expect(fixture.calls.at(-1)).toBe(active);
  });
}

test("default instance preflight rejects running workers before querying operation guards", async () => {
  const fixture = await defaultPreflightFixture("worker");
  await expect(fixture.run()).rejects.toMatchObject({ code: "INSTANCE_BACKUP_WORKSPACES_ACTIVE", statusCode: 409 });
  expect(fixture.calls).toEqual([]);
});

async function settled(manager: InstanceBackupManager, id: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const job = await manager.getJob(id);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status))
      return job;
    if (Date.now() > deadline)
      throw new Error(`Instance backup job ${id} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function inventory() {
  return {
    volumes: [],
    plugins: {
      platformDefinitionCount: 4,
      ownerDefinitionCount: 3,
      installationCount: 2,
    },
    hostMounts: {
      configuredPaths: ["/srv/source-host-data"],
      contentsIncluded: false as const,
    },
    images: {
      definitions: 5,
      immutableDigests: [`sha256:${"e".repeat(64)}`],
      layersIncluded: false as const,
    },
    storage: { mode: "volume" as const, containerPrefix: "agentor-worker" },
  };
}

async function writeVolumeArchive(path: string) {
  const pack = tar.pack();
  const writing = pipeline(pack, createGzip(), createWriteStream(path));
  await new Promise<void>((resolve, reject) => {
    pack
      .entry(
        { name: "source/", type: "directory", size: 0 },
        (error?: Error | null) => (error ? reject(error) : resolve()),
      )
      .end();
  });
  await new Promise<void>((resolve, reject) => {
    pack.entry(
      { name: "source/state.txt", type: "file", size: 5 },
      "state",
      (error?: Error | null) => (error ? reject(error) : resolve()),
    );
  });
  pack.finalize();
  await writing;
}

test("two independent managers create, remotely discover, and adopt one encrypted instance artifact idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-instance-cross-installation-"));
  const provider = new FakeBackupProvider(join(root, "shared-provider"));
  const sourceOwner = "source-admin";
  const destinationOwner = "destination-admin";
  const recoveryMaterial = Buffer.alloc(32, 91).toString("base64");
  const recoveryFingerprint = backupKeyFingerprint(recoveryMaterial);
  let destinationHasKey = false;
  provider.bindAccount(sourceOwner, "shared-google-account");
  provider.bindAccount(destinationOwner, "shared-google-account");

  const sourceBackupManager = {
    instanceBackupProvider: () => provider,
    resolveInstanceRecoveryMaterial: async () => ({
      fingerprint: recoveryFingerprint,
      material: recoveryMaterial,
    }),
  } as unknown as BackupManager;
  const destinationBackupManager = {
    instanceBackupProvider: () => provider,
    resolveInstanceRecoveryMaterial: async (
      _userId: string,
      fingerprint?: string,
    ) =>
      destinationHasKey && (!fingerprint || fingerprint === recoveryFingerprint)
        ? { fingerprint: recoveryFingerprint, material: recoveryMaterial }
        : undefined,
  } as unknown as BackupManager;
  const source = new InstanceBackupManager({
    dataDir: join(root, "instance-a"),
    backupManager: sourceBackupManager,
    preflightCreate: async () => {},
    authSnapshot: async (destination) => {
      await writeFile(destination, "consistent sqlite snapshot");
    },
    inventory: async () => inventory(),
  });
  const destination = new InstanceBackupManager({
    dataDir: join(root, "instance-b"),
    backupManager: destinationBackupManager,
  });
  try {
    await mkdir(join(root, "instance-a"), { recursive: true });
    await writeFile(
      join(root, "instance-a", "plugin-definitions.platform.json"),
      "[]",
    );

    const startedAt = Date.now();
    const created = await source.create(
      sourceOwner,
      "fake",
      { includeDockerVolumes: false },
      "create-source-instance",
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(created).toMatchObject({
      operation: "create",
      status: expect.stringMatching(/queued|running/),
      requestId: "create-source-instance",
    });
    const duplicateCreate = await source.create(
      sourceOwner,
      "fake",
      { includeDockerVolumes: false },
      "create-source-instance",
    );
    expect(duplicateCreate.id).toBe(created.id);
    await expect(
      source.create(
        sourceOwner,
        "fake",
        { includeDockerVolumes: false, includeLogs: true },
        "create-source-instance",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const completed = await settled(source, created.id);
    expect(completed).toMatchObject({ status: "succeeded", phase: "complete" });
    const sourceArtifacts = (await source.list(sourceOwner)).artifacts;
    expect(sourceArtifacts).toHaveLength(1);
    expect(sourceArtifacts[0]).toMatchObject({
      id: created.id,
      integrityStatus: "verified",
      keyFingerprint: recoveryFingerprint,
      manifest: {
        plugins: inventory().plugins,
        hostMounts: inventory().hostMounts,
        images: inventory().images,
      },
    });

    const discovery = await destination.discover(
      destinationOwner,
      "fake",
      "discover-shared-provider",
    );
    const duplicateDiscovery = await destination.discover(
      destinationOwner,
      "fake",
      "discover-shared-provider",
    );
    expect(duplicateDiscovery.id).toBe(discovery.id);
    await expect(settled(destination, discovery.id)).resolves.toMatchObject({
      status: "succeeded",
      operation: "discovery",
    });
    const missingKey = (await destination.list(destinationOwner)).remoteBackups;
    expect(missingKey).toHaveLength(1);
    expect(missingKey[0]).toMatchObject({
      state: "missing-key",
      keyFingerprint: recoveryFingerprint,
      keyAvailable: false,
      restorable: false,
    });

    destinationHasKey = true;
    const rescan = await destination.discover(
      destinationOwner,
      "fake",
      "discover-after-key-import",
    );
    await expect(settled(destination, rescan.id)).resolves.toMatchObject({
      status: "succeeded",
    });
    const ready = (await destination.list(destinationOwner)).remoteBackups;
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      id: missingKey[0]!.id,
      state: "ready-to-adopt",
      keyAvailable: true,
    });

    const adoption = await destination.adopt(
      destinationOwner,
      ready[0]!.id,
      "adopt-shared-instance",
    );
    const duplicateAdoption = await destination.adopt(
      destinationOwner,
      ready[0]!.id,
      "adopt-shared-instance",
    );
    expect(duplicateAdoption.id).toBe(adoption.id);
    await expect(settled(destination, adoption.id)).resolves.toMatchObject({
      status: "succeeded",
      operation: "adoption",
      artifactId: created.id,
    });
    const adopted = await destination.list(destinationOwner);
    expect(adopted.artifacts).toEqual([
      expect.objectContaining({
        id: created.id,
        provenance: "remote-adopted",
        integrityStatus: "verified",
        keyFingerprint: recoveryFingerprint,
      }),
    ]);
    expect(adopted.remoteBackups).toEqual([
      expect.objectContaining({
        id: ready[0]!.id,
        state: "adopted",
        adoptedArtifactId: created.id,
        restorable: true,
      }),
    ]);
    await expect(
      destination.adopt("unrelated-admin", ready[0]!.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      destination.adopt(destinationOwner, ready[0]!.id, "adopt-again"),
    ).resolves.toMatchObject({
      accepted: false,
      alreadyAdopted: true,
      artifactId: created.id,
    });
  } finally {
    source.stop();
    destination.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery cancellation is prompt and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-instance-cancel-"));
  const slowProvider: BackupProvider = {
    kind: "fake",
    upload: async () => ({ objectId: "unused", size: 0, uploadId: "unused", resumedFromChunk: 0 }),
    download: async () => {},
    delete: async () => {},
    discoverInstances: async (_userId, _cursor, signal) =>
      new Promise((resolve, reject) => {
        const aborted = () =>
          reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
        // Deliberately no resolution: cancellation owns completion.
        void resolve;
      }),
  };
  const manager = new InstanceBackupManager({
    dataDir: root,
    backupManager: {
      instanceBackupProvider: () => slowProvider,
    } as unknown as BackupManager,
  });
  try {
    const job = await manager.discover("platform-admin", "fake", "cancel-me");
    const deadline = Date.now() + 5_000;
    while ((await manager.getJob(job.id))?.status === "queued") {
      if (Date.now() > deadline) throw new Error("Discovery did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const first = await manager.cancel(job.id);
    const second = await manager.cancel(job.id);
    expect(first).toMatchObject({ status: "cancelled", phase: "cancelled" });
    expect(second).toMatchObject({ status: "cancelled", id: job.id });
    await expect(settled(manager, job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
  } finally {
    manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker and agent-data options filter Docker volumes while the write barrier remains active", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-instance-volume-options-"));
  const provider = new FakeBackupProvider(join(root, "provider"));
  const owner = "platform-admin";
  const recoveryMaterial = Buffer.alloc(32, 73).toString("base64");
  const candidates = [
    { name: "worker-workspace", kind: "worker-workspace" as const, workerId: "worker-1" },
    { name: "worker-agents", kind: "worker-agent-data" as const, workerId: "worker-1" },
    { name: "worker-dind", kind: "worker-dind" as const, workerId: "worker-1" },
    { name: "persisted-path", kind: "persistent-path" as const, workerId: "worker-1" },
    { name: "admin-workspace", kind: "admin-workspace" as const },
    { name: "admin-agents", kind: "admin-agent-data" as const },
    { name: "agentor-traefik-certs", kind: "traefik-certificates" as const },
  ];
  const manager = new InstanceBackupManager({
    dataDir: join(root, "data"),
    backupManager: {
      instanceBackupProvider: () => provider,
      resolveInstanceRecoveryMaterial: async () => ({
        fingerprint: backupKeyFingerprint(recoveryMaterial),
        material: recoveryMaterial,
      }),
    } as unknown as BackupManager,
    preflightCreate: async () => {},
    authSnapshot: async (destination) => writeFile(destination, "sqlite snapshot"),
    inventory: async () => ({
      ...inventory(),
      volumes: candidates,
    }),
  });
  const attempted: string[] = [];
  (manager as any).snapshotVolume = async (name: string, output: string) => {
    expect(instanceSnapshotActive()).toBe(true);
    attempted.push(name);
    await writeVolumeArchive(output);
    return true;
  };
  try {
    const job = await manager.create(
      owner,
      "fake",
      {
        includeWorkers: false,
        // normalizeOptions must also force this false when worker data is off.
        includeAgentData: true,
        includeDockerVolumes: true,
      },
      "volume-filter",
    );
    await expect(settled(manager, job.id)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(instanceSnapshotActive()).toBe(false);
    expect(attempted).toEqual(["admin-workspace", "agentor-traefik-certs"]);
    const artifact = (await manager.list(owner)).artifacts[0]!;
    expect(artifact.manifest?.options).toMatchObject({
      includeWorkers: false,
      includeAgentData: false,
      includeDockerVolumes: true,
    });
    expect(artifact.manifest?.volumes.map((volume) => volume.kind)).toEqual([
      "admin-workspace",
      "traefik-certificates",
    ]);
  } finally {
    manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("create validates nested archives before publishing an instance artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-instance-create-validation-"));
  const provider = new FakeBackupProvider(join(root, "provider"));
  const owner = "platform-admin";
  const recoveryMaterial = Buffer.alloc(32, 57).toString("base64");
  const manager = new InstanceBackupManager({
    dataDir: join(root, "data"),
    backupManager: {
      instanceBackupProvider: () => provider,
      resolveInstanceRecoveryMaterial: async () => ({
        fingerprint: backupKeyFingerprint(recoveryMaterial),
        material: recoveryMaterial,
      }),
    } as unknown as BackupManager,
    preflightCreate: async () => {},
    authSnapshot: async (destination) => writeFile(destination, "sqlite snapshot"),
    inventory: async () => ({
      ...inventory(),
      volumes: [
        {
          name: "worker-workspace",
          kind: "worker-workspace" as const,
          workerId: "worker-1",
        },
      ],
    }),
  });
  (manager as any).snapshotVolume = async (_name: string, output: string) => {
    await writeFile(output, "not a gzip archive");
    return true;
  };
  try {
    const job = await manager.create(
      owner,
      "fake",
      { includeDockerVolumes: true },
      "create-validation",
    );
    await expect(settled(manager, job.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "INSTANCE_BACKUP_INVALID",
    });
    expect((await manager.list(owner)).artifacts).toHaveLength(0);
  } finally {
    manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("the control-plane snapshot write barrier is exclusive and releases idempotently", () => {
  const release = beginInstanceSnapshot("snapshot-job-1");
  expect(instanceSnapshotActive()).toBe(true);
  expect(instanceSnapshotJobId()).toBe("snapshot-job-1");
  expect(() => beginInstanceSnapshot("snapshot-job-2")).toThrow(
    /another instance control-plane recovery operation is already active/i,
  );

  // A durable job ID is not ownership of another live acquisition.
  expect(() => beginInstanceSnapshot("snapshot-job-1")).toThrow();
  release();
  expect(instanceSnapshotActive()).toBe(false);
  release();
  expect(instanceSnapshotActive()).toBe(false);

  const releaseNext = beginInstanceSnapshot("snapshot-job-2");
  expect(instanceSnapshotJobId()).toBe("snapshot-job-2");
  release();
  expect(instanceSnapshotJobId()).toBe("snapshot-job-2");
  releaseNext();
  expect(instanceSnapshotActive()).toBe(false);

  const releaseRestore = beginInstanceRestore("restore-job-1");
  expect(instanceSnapshotActive()).toBe(true);
  expect(instanceSnapshotJobId()).toBe("restore-job-1");
  expect(instanceControlPlaneBarrierKind()).toBe("restore");
  expect(() => beginInstanceSnapshot("snapshot-job-3")).toThrow(
    /another instance control-plane recovery operation is already active/i,
  );
  releaseRestore();
  expect(instanceSnapshotActive()).toBe(false);
});

test('cancelling image inventory releases the instance snapshot barrier before publishing an artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-instance-inventory-cancel-'));
  const provider = new FakeBackupProvider(join(root, 'provider'));
  let entered!: () => void;
  const inventoryStarted = new Promise<void>((resolve) => { entered = resolve; });
  const manager = new InstanceBackupManager({
    dataDir: join(root, 'data'),
    backupManager: { instanceBackupProvider: () => provider } as unknown as BackupManager,
    preflightCreate: async () => {},
    authSnapshot: async (destination) => writeFile(destination, 'sqlite snapshot'),
    inventory: async (_userId, signal) => {
      expect(instanceSnapshotActive()).toBe(true);
      entered();
      await new Promise<void>((_resolve, reject) => {
        if (!signal) { reject(new Error('Inventory did not receive cancellation')); return; }
        if (signal.aborted) { reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); return; }
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
      });
      return inventory();
    },
  });
  try {
    const job = await manager.create('platform-admin', 'fake', { includeDockerVolumes: false }, 'cancel-inventory');
    await inventoryStarted;
    expect(instanceSnapshotActive()).toBe(true);
    await manager.cancel(job.id);
    await expect(settled(manager, job.id)).resolves.toMatchObject({ status: 'cancelled' });
    expect(instanceSnapshotActive()).toBe(false);
    expect((await manager.list('platform-admin')).artifacts).toHaveLength(0);
  } finally {
    manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("restore acceptance holds the mutation barrier until cancellation has unwound", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-instance-restore-barrier-"));
  const store = new InstanceBackupStore(root);
  await store.init();
  const stamp = new Date().toISOString();
  await store.saveArtifact({
    schemaVersion: 1,
    id: "restore-artifact",
    userId: "platform-admin",
    provider: "local",
    providerObjectId: "restore-artifact",
    createdAt: stamp,
    size: 1,
    sha256: "a".repeat(64),
    keyFingerprint: `sha256:${"b".repeat(64)}`,
    sourceInstallationId: "source-installation",
    formatVersion: 1,
    integrityStatus: "verified",
    provenance: "local",
    manifest: {
      kind: "agentor-instance-backup",
      formatVersion: 1,
      backupId: "restore-artifact",
      sourceInstallationId: "source-installation",
      createdByUserId: "source-admin",
      createdAt: stamp,
      volumes: [],
    } as any,
  });
  const manager = new InstanceBackupManager({
    dataDir: root,
    store,
    backupManager: {
      instanceBackupProvider: () => undefined,
      prepareInstanceRecoveryMaterial: async () => {},
    } as unknown as BackupManager,
  });
  (manager as any).runRestore = async (
    _job: unknown,
    _artifact: unknown,
    _options: unknown,
    signal: AbortSignal,
  ) =>
    new Promise<void>((_resolve, reject) => {
      const cancelled = () =>
        reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      if (signal.aborted) cancelled();
      else signal.addEventListener("abort", cancelled, { once: true });
    });
  try {
    const job = await manager.restore(
      "platform-admin",
      "restore-artifact",
      {
        confirmReplaceControlPlane: true,
        confirmExternalDependencies: true,
      },
      "restore-with-barrier",
    );
    expect(instanceSnapshotActive()).toBe(true);
    expect(instanceSnapshotJobId()).toBe(job.id);
    expect(instanceControlPlaneBarrierKind()).toBe("restore");
    await expect
      .poll(() => (manager as any).controllers.has(job.id), { timeout: 5_000 })
      .toBe(true);
    await manager.cancel(job.id);
    await expect(settled(manager, job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect
      .poll(() => instanceSnapshotActive(), { timeout: 5_000 })
      .toBe(false);
  } finally {
    manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('real restore drain waits for its accepting request and nested final audit before staging and authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-instance-restore-drain-'));
  const store = new InstanceBackupStore(root), held = heldOperation(), accepted = heldOperation();
  const events: string[] = [], artifactId = 'restore-drain-artifact';
  const stamp = new Date().toISOString(), input = join(root, 'fixture-input');
  const artifactPath = join(root, 'instance-backup-artifacts', `${artifactId}.backup`);
  await store.init(); await mkdir(join(root, 'instance-backup-artifacts'), { recursive: true });
  await writeFile(input, 'offline fixture, deliberately never decrypted');
  const encrypted = await encryptInstanceBackup(input, artifactPath, Buffer.alloc(32, 43).toString('base64'), {
    backupId: artifactId, sourceInstallationId: 'source-installation', createdAt: stamp, formatVersion: 1,
  });
  await store.saveArtifact({
    schemaVersion: 1, id: artifactId, userId: 'owner', provider: 'local', providerObjectId: artifactId,
    createdAt: stamp, size: encrypted.size, sha256: encrypted.sha256, keyFingerprint: encrypted.header.keyFingerprint,
    sourceInstallationId: 'source-installation', formatVersion: 1, integrityStatus: 'verified', provenance: 'local',
    // Acceptance requires a retained manifest, but the deliberate missing-key
    // boundary stops this real execution before decrypt/preflight/helper work.
    manifest: { kind: 'agentor-instance-backup', formatVersion: 1, backupId: artifactId,
      sourceInstallationId: 'source-installation', createdByUserId: 'source-owner', createdAt: stamp, volumes: [] } as any,
  });
  const manager = new InstanceBackupManager({ dataDir: root, store, controlPlaneDrainTimeoutMs: 2000,
    backupManager: { prepareInstanceRecoveryMaterial: async () => {
      expect(instanceSnapshotActive()).toBe(false);
    }, resolveInstanceRecoveryMaterialForRestore: async () => {
      events.push('post-drain-authentication');
      expect(instanceControlPlaneCoordinator.activeOperations).toBe(0);
      return undefined;
    } } as unknown as BackupManager,
  });
  await manager.init();
  let id!: string;
  const request = instanceControlPlaneCoordinator.run(async () => {
    id = (await manager.restore('owner', artifactId, {
      confirmReplaceControlPlane: true, confirmExternalDependencies: true,
    }, 'restore-drain-request')).id;
    events.push('accepted'); accepted.resolve(); await held.promise;
    await instanceControlPlaneCoordinator.run(async () => {
      await writeFile(join(root, 'final-audit-marker'), 'complete');
      events.push('final-audit');
    });
  });
  try {
    await accepted.promise;
    await expect.poll(() => (manager as any).controllers.has(id)).toBe(true);
    expect(instanceSnapshotActive()).toBe(true);
    expect(events).toEqual(['accepted']);
    await expect(stat(join(root, 'instance-restore-staging', `restore-${id}`))).rejects.toMatchObject({ code: 'ENOENT' });
    held.resolve(); await request;
    const result = await settled(manager, id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'INSTANCE_BACKUP_KEY_MISSING' });
    expect(events).toEqual(['accepted', 'final-audit', 'post-drain-authentication']);
    expect(await readFile(join(root, 'final-audit-marker'), 'utf8')).toBe('complete');
    await expect.poll(instanceSnapshotActive).toBe(false);
    await expect(stat(join(root, 'instance-restore-staging', `restore-${id}`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(artifactPath)).size).toBe(encrypted.size);
  } finally {
    held.resolve(); await request; manager.stop();
    await Promise.allSettled([...(manager as any).tasks.values()] as Promise<void>[]);
    await rm(root, { recursive: true, force: true });
  }
});

test("restore failures and cancellation remove plaintext staging but retain the encrypted artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-instance-restore-cleanup-"));
  const store = new InstanceBackupStore(root);
  const owner = "platform-admin";
  const artifactId = "restore-cleanup-artifact";
  const recoveryMaterial = Buffer.alloc(32, 29).toString("base64");
  const stamp = new Date().toISOString();
  const artifactPath = join(root, "instance-backup-artifacts", `${artifactId}.backup`);
  const input = join(root, "plaintext-bundle.tar");
  await store.init();
  await mkdir(join(root, "instance-backup-artifacts"), { recursive: true });
  await writeFile(input, "plaintext control-plane content");
  const encrypted = await encryptInstanceBackup(
    input,
    artifactPath,
    recoveryMaterial,
    {
      backupId: artifactId,
      sourceInstallationId: "source-installation",
      createdAt: stamp,
      formatVersion: 1,
    },
  );
  const artifact = {
    schemaVersion: 1 as const,
    id: artifactId,
    userId: owner,
    provider: "local" as const,
    providerObjectId: artifactId,
    createdAt: stamp,
    size: encrypted.size,
    sha256: encrypted.sha256,
    keyFingerprint: encrypted.header.keyFingerprint,
    sourceInstallationId: "source-installation",
    formatVersion: 1 as const,
    integrityStatus: "verified" as const,
    provenance: "local" as const,
  };
  const job = (id: string) => ({
    schemaVersion: 1 as const,
    id,
    userId: owner,
    operation: "restore" as const,
    provider: "local" as const,
    status: "queued" as const,
    phase: "queued",
    progress: 0,
    bytesProcessed: 0,
    createdAt: stamp,
    updatedAt: stamp,
    logs: [],
  });
  const options = {
    restoreDockerVolumes: true,
    restoreHostMountPolicies: false,
    confirmReplaceControlPlane: true,
    confirmExternalDependencies: true,
  };
  try {
    const missingKeyManager = new InstanceBackupManager({
      dataDir: root,
      store,
      backupManager: {
        resolveInstanceRecoveryMaterialForRestore: async () => undefined,
      } as unknown as BackupManager,
    });
    const missingKeyJob = job("restore-cleanup-missing-key");
    await store.saveJob(missingKeyJob);
    const missingKeyBarrier = beginInstanceRestore(missingKeyJob.id);
    (missingKeyManager as any).restoreBarriers.set(missingKeyJob.id, missingKeyBarrier);
    try {
    await expect(
      (missingKeyManager as any).runRestore(
        missingKeyJob,
        artifact,
        options,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/recovery key is unavailable/i);
    } finally { missingKeyBarrier(); }
    await expect(
      stat(join(root, "instance-restore-staging", `restore-${missingKeyJob.id}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const cancelledManager = new InstanceBackupManager({
      dataDir: root,
      store,
      backupManager: {
        resolveInstanceRecoveryMaterialForRestore: async () => ({
          fingerprint: encrypted.header.keyFingerprint,
          material: recoveryMaterial,
        }),
      } as unknown as BackupManager,
    });
    const cancelledJob = job("restore-cleanup-cancelled");
    await store.saveJob(cancelledJob);
    const abort = new AbortController();
    abort.abort();
    const cancelledBarrier = beginInstanceRestore(cancelledJob.id);
    (cancelledManager as any).restoreBarriers.set(cancelledJob.id, cancelledBarrier);
    try {
    await expect(
      (cancelledManager as any).runRestore(
        cancelledJob,
        artifact,
        options,
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    } finally { cancelledBarrier(); }
    await expect(
      stat(join(root, "instance-restore-staging", `restore-${cancelledJob.id}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(artifactPath)).isFile()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
