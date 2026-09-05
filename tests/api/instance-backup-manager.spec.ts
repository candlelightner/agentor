import { expect, test } from "@playwright/test";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
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
} from "../../orchestrator/server/utils/instance-snapshot-gate";

const orchestratorRequire = createRequire(
  new URL("../../orchestrator/package.json", import.meta.url),
);
const tar = orchestratorRequire("tar-stream") as { pack(): any };

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

test("the control-plane snapshot write barrier is exclusive and releases idempotently", () => {
  const release = beginInstanceSnapshot("snapshot-job-1");
  expect(instanceSnapshotActive()).toBe(true);
  expect(instanceSnapshotJobId()).toBe("snapshot-job-1");
  expect(() => beginInstanceSnapshot("snapshot-job-2")).toThrow(
    /another instance control-plane recovery operation is already active/i,
  );

  // Reentry by the same durable operation is safe and neither release callback
  // can clear a future operation after its ownership changed.
  const releaseSame = beginInstanceSnapshot("snapshot-job-1");
  release();
  expect(instanceSnapshotActive()).toBe(false);
  releaseSame();
  releaseSame();
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
        resolveInstanceRecoveryMaterial: async () => undefined,
      } as unknown as BackupManager,
    });
    const missingKeyJob = job("restore-cleanup-missing-key");
    await store.saveJob(missingKeyJob);
    await expect(
      (missingKeyManager as any).runRestore(
        missingKeyJob,
        artifact,
        options,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/recovery key is unavailable/i);
    await expect(
      stat(join(root, "instance-restore-staging", `restore-${missingKeyJob.id}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const cancelledManager = new InstanceBackupManager({
      dataDir: root,
      store,
      backupManager: {
        resolveInstanceRecoveryMaterial: async () => ({
          fingerprint: encrypted.header.keyFingerprint,
          material: recoveryMaterial,
        }),
      } as unknown as BackupManager,
    });
    const cancelledJob = job("restore-cleanup-cancelled");
    await store.saveJob(cancelledJob);
    const abort = new AbortController();
    abort.abort();
    await expect(
      (cancelledManager as any).runRestore(
        cancelledJob,
        artifact,
        options,
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      stat(join(root, "instance-restore-staging", `restore-${cancelledJob.id}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(artifactPath)).isFile()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
