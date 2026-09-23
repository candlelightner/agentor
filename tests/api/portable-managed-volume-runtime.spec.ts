import { test as base, expect } from "@playwright/test";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig } from "../../orchestrator/server/utils/config";
import { DockerService } from "../../orchestrator/server/utils/docker";
import { beginInstanceSnapshot } from "../../orchestrator/server/utils/instance-snapshot-gate";
import {
  writePortableManagedVolumePayload,
} from "../../orchestrator/server/utils/portable-managed-volume-archive";
import {
  createPortableManagedVolumeImportJournal,
  transitionPortableManagedVolumeJournalPhase,
  transitionPortableManagedVolumeWorker,
  type PortableManagedVolumeImportJournal,
} from "../../orchestrator/server/utils/portable-managed-volume-journal";
import {
  PortableManagedVolumeRuntime,
  PORTABLE_VOLUME_HELPER_LABEL,
} from "../../orchestrator/server/utils/portable-managed-volume-runtime";
import {
  BUNDLE_FILES,
  MAX_BUNDLE_ENTRY_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
  WORKER_EXPORT_VERSION,
  extractBundle,
  packBundle,
  validateBundleOutputLayout,
  type WorkerExportManifest,
} from "../../orchestrator/server/utils/worker-export";

const USER_ID = "owner-a";
const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

function portableHelperLabels(helperOperationId: string) {
  return {
    [PORTABLE_VOLUME_HELPER_LABEL]: "true",
    "agentor.helper.operation-id": helperOperationId,
    "agentor.helper.owner-id": USER_ID,
    "agentor.helper.worker-id": WORKER_ID,
    "agentor.helper.volume-id": "44444444-4444-4444-8444-444444444444",
    "agentor.portable-operation-id": OPERATION_ID,
    "agentor.helper.created-at": "2026-09-23T00:00:00.000Z",
  };
}

const test = base.extend<{ autoImports: void }>({
  autoImports: [async ({}, use) => {
    const previous = (globalThis as any).useLogger;
    (globalThis as any).useLogger = () => ({
      debug() {}, info() {}, warn() {}, error() {},
    });
    try {
      await use();
    } finally {
      if (previous === undefined) delete (globalThis as any).useLogger;
      else (globalThis as any).useLogger = previous;
    }
  }, { auto: true }],
});

function createdWorkerJournal(): PortableManagedVolumeImportJournal {
  let journal = createPortableManagedVolumeImportJournal({
    operationId: OPERATION_ID,
    userId: USER_ID,
    workerId: WORKER_ID,
    resources: [],
  });
  journal = transitionPortableManagedVolumeJournalPhase(journal, "provisioning");
  journal = transitionPortableManagedVolumeJournalPhase(journal, "worker-pending");
  journal = transitionPortableManagedVolumeWorker(journal, "create-pending");
  journal = transitionPortableManagedVolumeWorker(journal, "created");
  return transitionPortableManagedVolumeJournalPhase(journal, "worker-created");
}

function pendingWorkerIntentJournal(): PortableManagedVolumeImportJournal {
  let journal = createPortableManagedVolumeImportJournal({
    operationId: OPERATION_ID,
    userId: USER_ID,
    workerId: WORKER_ID,
    resources: [],
  });
  journal = transitionPortableManagedVolumeJournalPhase(journal, "provisioning");
  return transitionPortableManagedVolumeJournalPhase(journal, "worker-pending");
}

async function seedJournal(
  runtime: PortableManagedVolumeRuntime,
  journal: PortableManagedVolumeImportJournal,
) {
  // The durable store is intentionally private API; seeding its real on-disk
  // representation here exercises restart parsing and recovery rather than a
  // test-only in-memory shortcut.
  await (runtime as any).journals.save(journal);
}

async function writeInnerVolumeTar(path: string) {
  const chunks: Buffer[] = [];
  for (const entry of [
    { name: "volume/", type: "5", mode: 0o755, body: Buffer.alloc(0) },
    { name: "volume/value.txt", type: "0", mode: 0o640, body: Buffer.from("value\n") },
  ]) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write(`${entry.mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${entry.body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = entry.type.charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(
      header,
      entry.body,
      Buffer.alloc((512 - (entry.body.length % 512)) % 512),
    );
  }
  await writeFile(path, Buffer.concat([...chunks, Buffer.alloc(1024)]), { mode: 0o600 });
}

test("startup recovery removes only exactly labelled portable helpers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-helper-recovery-"));
  let removed = false;
  const helperName = `agentor-portable-volume-capture-${OPERATION_ID}`;
  try {
    const docker = {
      listContainers: async () => [{
        Id: "helper-id",
        Names: [`/${helperName}`],
        Labels: portableHelperLabels(OPERATION_ID),
      }],
      getContainer: () => ({
        inspect: async () => ({
          Id: "helper-id",
          Name: `/${helperName}`,
          Config: { Labels: portableHelperLabels(OPERATION_ID) },
        }),
        remove: async () => { removed = true; },
      }),
    };
    const runtime = new PortableManagedVolumeRuntime(dir, docker as any);
    (runtime as any).initialization = Promise.resolve();
    await runtime.recoverStartup();
    expect(removed).toBe(true);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed portable helper identity becomes snapshot-blocking cleanup debt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-helper-debt-"));
  let removals = 0;
  try {
    const runtime = new PortableManagedVolumeRuntime(dir, {
      listContainers: async () => [{
        Id: "unknown-helper",
        Names: ["/agentor-portable-volume-restore-unknown"],
        Labels: { [PORTABLE_VOLUME_HELPER_LABEL]: "true" },
      }],
      getContainer: () => ({ remove: async () => { removals += 1; } }),
    } as any);
    (runtime as any).initialization = Promise.resolve();
    await runtime.recoverStartup();
    expect(removals).toBe(0);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart recovery refuses a provisional worker whose journal labels mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-worker-mismatch-"));
  let callbackCalls = 0;
  try {
    const runtime = new PortableManagedVolumeRuntime(dir, {
      listContainers: async () => [],
      getContainer: () => ({ inspect: async () => ({
        Config: { Labels: {
          "agentor.id": WORKER_ID,
          "agentor.owner-id": USER_ID,
          "agentor.worker-id": WORKER_ID,
          "agentor.portable-import-id": "33333333-3333-4333-8333-333333333333",
        } },
      }) }),
    } as any);
    (runtime as any).initialization = Promise.resolve();
    await seedJournal(runtime, createdWorkerJournal());
    await runtime.recoverStartup(async () => { callbackCalls += 1; });
    expect(callbackCalls).toBe(0);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart recovery deletes a matching provisional worker before forgetting intent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-worker-recovery-"));
  let exists = true;
  try {
    const runtime = new PortableManagedVolumeRuntime(dir, {
      listContainers: async () => [],
      getContainer: () => ({ inspect: async () => {
        if (!exists) throw Object.assign(new Error("not found"), { statusCode: 404 });
        return { Config: { Labels: {
          "agentor.id": WORKER_ID,
          "agentor.owner-id": USER_ID,
          "agentor.worker-id": WORKER_ID,
          "agentor.portable-import-id": OPERATION_ID,
        } } };
      } }),
    } as any);
    (runtime as any).initialization = Promise.resolve();
    await seedJournal(runtime, createdWorkerJournal());
    await runtime.recoverStartup(async () => { exists = false; });
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(false);
    expect((runtime as any).journals.list()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart recovery removes a durable provisional worker record even while journal worker state is intent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-worker-intent-recovery-"));
  let callbackCalls = 0;
  try {
    const runtime = new PortableManagedVolumeRuntime(dir, {
      listContainers: async () => [],
      getContainer: () => ({
        inspect: async () => { throw Object.assign(new Error("not found"), { statusCode: 404 }); },
      }),
    } as any);
    (runtime as any).initialization = Promise.resolve();
    await seedJournal(runtime, pendingWorkerIntentJournal());
    await runtime.recoverStartup(async () => { callbackCalls += 1; });
    expect(callbackCalls).toBe(1);
    expect((runtime as any).journals.list()).toEqual([]);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed provisional intent cleanup retains restart evidence and snapshot debt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-worker-intent-debt-"));
  try {
    const runtime = new PortableManagedVolumeRuntime(dir, {
      listContainers: async () => [],
      getContainer: () => ({
        inspect: async () => { throw Object.assign(new Error("not found"), { statusCode: 404 }); },
      }),
    } as any);
    (runtime as any).initialization = Promise.resolve();
    await seedJournal(runtime, pendingWorkerIntentJournal());
    await runtime.recoverStartup(async () => { throw new Error("durable worker cleanup failed"); });
    expect((runtime as any).journals.list()).toHaveLength(1);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable capture admission closes while an instance snapshot is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-snapshot-"));
  const release = beginInstanceSnapshot("portable-runtime-test");
  try {
    const runtime = new PortableManagedVolumeRuntime(dir, {} as any);
    await expect(runtime.captureWithLifecycleFenceHeld({
      userId: USER_ID,
      workerId: WORKER_ID,
      state: "archived",
      outputPath: join(dir, "payload.tar.gz"),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE",
    });
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("import admission registers before initialization and eligible-empty v6 stays active through commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-import-admission-"));
  const payload = join(dir, "managed-volumes.tar.gz");
  let releaseInit!: () => void;
  const initialization = new Promise<void>((resolve) => { releaseInit = resolve; });
  try {
    await writePortableManagedVolumePayload([], payload);
    const runtime = new PortableManagedVolumeRuntime(dir, {} as any);
    (runtime as any).initialization = initialization;
    const preparing = runtime.prepareImportWithLifecycleFenceHeld({
      userId: USER_ID,
      workerId: WORKER_ID,
      entries: [],
      payloadPath: payload,
      stagingDir: join(dir, "staging"),
      conflicts: {
        protectedPaths: [], workspacePaths: [], agentDataPaths: [],
        dockerDataPaths: [], hostGrantPaths: [], destinationMountPaths: [],
        selectedBackupPaths: [],
      },
      image: "sha256:unused-for-empty-import",
    });
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    releaseInit();
    const transaction = await preparing;
    expect(transaction.mounts).toEqual([]);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    await transaction.commit();
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally {
    releaseInit?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("preexisting destination volume collision is refused without create or delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-volume-collision-"));
  const inner = join(dir, "inner.tar");
  const payload = join(dir, "managed-volumes.tar.gz");
  let helperOptions: any;
  let volumeCreates = 0;
  let volumeDeletes = 0;
  let probeStarts = 0;
  try {
    await writeInnerVolumeTar(inner);
    const entry = { target: "/srv/state", name: "state", archive: "volumes/0.tar" };
    await writePortableManagedVolumePayload([{ entry, archivePath: inner }], payload);
    const runtime = new PortableManagedVolumeRuntime(dir, {
      createContainer: async (options: any) => {
        helperOptions = options;
        return {
          id: "probe-helper",
          start: async () => { probeStarts += 1; },
          infoArchive: async () => { throw Object.assign(new Error("missing"), { statusCode: 404 }); },
        };
      },
      getContainer: (id: string) => id === "probe-helper" ? {
        inspect: async () => ({ Id: id, Name: `/${helperOptions.name}`, Config: { Labels: helperOptions.Labels } }),
        remove: async () => {},
      } : {
        inspect: async () => { throw Object.assign(new Error("not found"), { statusCode: 404 }); },
      },
      getVolume: (name: string) => ({
        inspect: async () => ({ Name: name, Driver: "local", Labels: { "foreign.owner": "true" }, Options: {} }),
        remove: async () => { volumeDeletes += 1; },
      }),
      createVolume: async () => { volumeCreates += 1; },
    } as any);
    (runtime as any).initialization = Promise.resolve();
    await expect(runtime.prepareImportWithLifecycleFenceHeld({
      userId: USER_ID,
      workerId: WORKER_ID,
      entries: [entry],
      payloadPath: payload,
      stagingDir: join(dir, "staging"),
      conflicts: {
        protectedPaths: [], workspacePaths: [], agentDataPaths: [],
        dockerDataPaths: [], hostGrantPaths: [], destinationMountPaths: [],
        selectedBackupPaths: [],
      },
      image: "sha256:destination",
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(probeStarts).toBe(0);
    expect(volumeCreates).toBe(0);
    expect(volumeDeletes).toBe(0);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(false);
    expect((runtime as any).journals.list()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("destination probe creates a configless image with an inert command and never starts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-configless-probe-"));
  let helperOptions: any;
  let starts = 0;
  let removals = 0;
  const inspectedPaths: string[] = [];
  const directoryStat = Buffer.from(JSON.stringify({ mode: 0x800001ed, linkTarget: "" }))
    .toString("base64");
  try {
    const helper = {
      id: "probe-helper",
      start: async () => { starts += 1; },
      infoArchive: async ({ path }: { path: string }) => {
        inspectedPaths.push(path);
        if (path === "/home" || path === "/home/agent") return {
          headers: { "x-docker-container-path-stat": directoryStat },
          resume() {},
        };
        throw Object.assign(new Error("missing"), { statusCode: 404 });
      },
    };
    const runtime = new PortableManagedVolumeRuntime(dir, {
      createContainer: async (options: any) => {
        helperOptions = options;
        if (!options.Entrypoint?.length && !options.Cmd?.length)
          throw Object.assign(new Error("no command specified"), { statusCode: 400 });
        return helper;
      },
      getContainer: () => ({
        inspect: async () => ({
          Id: helper.id,
          Name: `/${helperOptions.name}`,
          Config: { Labels: helperOptions.Labels },
        }),
        remove: async () => { removals += 1; },
      }),
    } as any);
    await (runtime as any).validateImageTargetsWithProbe(
      { image: "sha256:configless", userId: USER_ID, workerId: WORKER_ID },
      OPERATION_ID,
      [{ target: "/home/agent/portable-probe" }],
    );
    expect(helperOptions).toMatchObject({
      Image: "sha256:configless",
      Entrypoint: ["/bin/true"],
      Cmd: [],
      Env: [],
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 8,
        Memory: 64 * 1024 * 1024,
        NanoCpus: 250_000_000,
      },
    });
    expect(helperOptions.HostConfig).not.toHaveProperty("Mounts");
    expect(starts).toBe(0);
    expect(inspectedPaths).toEqual(["/home", "/home/agent", "/home/agent/portable-probe"]);
    expect(removals).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const stage of ["start", "getArchive"] as const) {
  test(`capture waits for a cancelled helper ${stage} call to settle before cleanup`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `agentor-portable-${stage}-settlement-`));
    const controller = new AbortController();
    let releaseLate!: () => void;
    let entered!: () => void;
    let removals = 0;
    let createOptions: any;
    const enteredStage = new Promise<void>((resolve) => { entered = resolve; });
    const late = new Promise<Readable | void>((resolve) => {
      releaseLate = () => resolve(
        stage === "getArchive" ? Readable.from([Buffer.alloc(1024)]) : undefined,
      );
    });
    try {
      const helper = {
        id: "capture-helper",
        start: async () => {
          if (stage === "start") { entered(); await late; }
        },
        getArchive: async () => {
          if (stage === "getArchive") { entered(); return await late as Readable; }
          return Readable.from([Buffer.alloc(1024)]);
        },
      };
      const runtime = new PortableManagedVolumeRuntime(dir, {
        createContainer: async (options: any) => { createOptions = options; return helper; },
        getContainer: () => ({
          inspect: async () => ({ Id: helper.id, Name: `/${createOptions.name}`, Config: { Labels: createOptions.Labels } }),
          remove: async () => { removals += 1; },
        }),
      } as any, { trustedImage: async () => "sha256:trusted" });
      const operation = (runtime as any).captureOneVolume({
        operationId: OPERATION_ID,
        index: 0,
        dockerName: "source-volume",
        archivePath: join(dir, "capture.tar"),
        maxBytes: 4096,
        signal: controller.signal,
        userId: USER_ID,
        workerId: WORKER_ID,
        volumeId: "44444444-4444-4444-8444-444444444444",
      });
      await enteredStage;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(removals).toBe(0);
      releaseLate();
      await expect(operation).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
      expect(removals).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("restore waits for cancelled putArchive settlement before helper cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-put-settlement-"));
  const controller = new AbortController();
  let releaseLate!: () => void;
  let entered!: () => void;
  let removals = 0;
  let createOptions: any;
  const enteredStage = new Promise<void>((resolve) => { entered = resolve; });
  const late = new Promise<void>((resolve) => { releaseLate = resolve; });
  const archive = join(dir, "volume.tar");
  try {
    await writeFile(archive, Buffer.alloc(1024));
    const helper = {
      id: "restore-helper",
      start: async () => {},
      putArchive: async () => { entered(); await late; },
    };
    const runtime = new PortableManagedVolumeRuntime(dir, {
      createContainer: async (options: any) => { createOptions = options; return helper; },
      getContainer: () => ({
        inspect: async () => ({ Id: helper.id, Name: `/${createOptions.name}`, Config: { Labels: createOptions.Labels } }),
        remove: async () => { removals += 1; },
      }),
    } as any, { trustedImage: async () => "sha256:trusted" });
    const operation = (runtime as any).restoreOneVolume(
      OPERATION_ID,
      {
        id: "55555555-5555-4555-8555-555555555555",
        dockerName: "destination-volume",
        target: "/srv/state",
        name: "state",
        archive: "volumes/0.tar",
        labels: {
          "agentor.volume-id": "55555555-5555-4555-8555-555555555555",
          "agentor.owner-id": USER_ID,
          "agentor.worker-id": WORKER_ID,
          "agentor.portable-import-id": OPERATION_ID,
        },
      },
      archive,
      controller.signal,
    );
    await enteredStage;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removals).toBe(0);
    releaseLate();
    await expect(operation).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(removals).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore permits Docker to extract the validated volume-rooted tar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-put-rootfs-"));
  const archive = join(dir, "volume.tar");
  let createOptions: any;
  let restored = false;
  let putPath = "";
  let removals = 0;
  try {
    await writeInnerVolumeTar(archive);
    const helper = {
      id: "restore-helper",
      start: async () => {},
      putArchive: async (_input: unknown, options: { path: string }) => {
        putPath = options.path;
        // Moby validates the destination itself before tar members. Extracting
        // on the read-only rootfs returns HTTP 400 even when every member is
        // safely rooted under a nested writable volume mount.
        const writableDestination = createOptions.HostConfig.Mounts.some(
          (mount: any) => mount.Target === options.path && mount.ReadOnly !== true,
        );
        if (createOptions.HostConfig.ReadonlyRootfs && !writableDestination)
          throw Object.assign(new Error("container rootfs is marked read-only"), { statusCode: 400 });
        restored = true;
      },
    };
    const runtime = new PortableManagedVolumeRuntime(dir, {
      createContainer: async (options: any) => { createOptions = options; return helper; },
      getContainer: () => ({
        inspect: async () => ({ Id: helper.id, Name: `/${createOptions.name}`, Config: { Labels: createOptions.Labels } }),
        remove: async () => { removals += 1; },
      }),
    } as any, { trustedImage: async () => "sha256:trusted" });
    await (runtime as any).restoreOneVolume(
      OPERATION_ID,
      {
        id: "55555555-5555-4555-8555-555555555555",
        dockerName: "destination-volume",
        target: "/srv/state",
        name: "state",
        archive: "volumes/0.tar",
        labels: {
          "agentor.volume-id": "55555555-5555-4555-8555-555555555555",
          "agentor.owner-id": USER_ID,
          "agentor.worker-id": WORKER_ID,
          "agentor.portable-import-id": OPERATION_ID,
        },
      },
      archive,
    );
    expect(createOptions.HostConfig).toMatchObject({
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Mounts: [
        { Type: "tmpfs", Source: "", Target: "/restore", TmpfsOptions: { SizeBytes: 1024 * 1024, Mode: 0o700 } },
        { Type: "volume", Source: "destination-volume", Target: "/restore/volume" },
      ],
    });
    expect(putPath).toBe("/restore");
    expect(restored).toBe(true);
    expect(removals).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture enforces the aggregate staging bound while streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-capture-bound-"));
  let removals = 0;
  let createOptions: any;
  try {
    const helper = {
      id: "bounded-capture-helper",
      start: async () => {},
      getArchive: async () => Readable.from([Buffer.alloc(1025)]),
    };
    const runtime = new PortableManagedVolumeRuntime(dir, {
      createContainer: async (options: any) => { createOptions = options; return helper; },
      getContainer: () => ({
        inspect: async () => ({ Id: helper.id, Name: `/${createOptions.name}`, Config: { Labels: createOptions.Labels } }),
        remove: async () => { removals += 1; },
      }),
    } as any, { trustedImage: async () => "sha256:trusted" });
    await expect((runtime as any).captureOneVolume({
      operationId: OPERATION_ID,
      index: 0,
      dockerName: "source-volume",
      archivePath: join(dir, "bounded.tar"),
      maxBytes: 1024,
      userId: USER_ID,
      workerId: WORKER_ID,
      volumeId: "66666666-6666-4666-8666-666666666666",
    })).rejects.toThrow("staging size limit");
    expect(removals).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("foreign helper name collision is never removed and remains snapshot cleanup debt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-helper-collision-"));
  let removals = 0;
  let generatedName = "";
  const foreignOperationId = "55555555-5555-4555-8555-555555555555";
  const foreignLabels = portableHelperLabels(foreignOperationId);
  try {
    const runtime = new PortableManagedVolumeRuntime(dir, {
      listContainers: async () => [{
        Id: "foreign-container",
        Names: [`/${generatedName}`],
        Labels: foreignLabels,
      }],
      createContainer: async (options: any) => {
        generatedName = options.name;
        throw Object.assign(new Error("container name already exists"), { statusCode: 409 });
      },
      getContainer: () => ({
        inspect: async () => ({
          Id: "foreign-container",
          Name: generatedName,
          Config: { Labels: foreignLabels },
        }),
        remove: async () => { removals += 1; },
      }),
    } as any, { trustedImage: async () => "sha256:trusted" });
    await expect((runtime as any).captureOneVolume({
      operationId: OPERATION_ID,
      index: 0,
      dockerName: "source-volume",
      archivePath: join(dir, "collision.tar"),
      maxBytes: 1024,
      userId: USER_ID,
      workerId: WORKER_ID,
      volumeId: "77777777-7777-4777-8777-777777777777",
    })).rejects.toThrow("unexpected identity");
    expect(generatedName).toMatch(/^agentor-portable-volume-capture-/);
    expect(removals).toBe(0);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    (runtime as any).initialization = Promise.resolve();
    await runtime.recoverStartup();
    expect(removals).toBe(0);
    expect(runtime.hasActiveOperationsForInstanceSnapshot()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function workerCreateInput() {
  return {
    userId: USER_ID,
    id: WORKER_ID,
    containerName: `agentor-worker-${WORKER_ID}`,
    environmentJson: {
      networkMode: "full",
      allowedDomains: [],
      dockerEnabled: false,
      setupScript: "",
      envVars: "",
      exposeApis: {
        portMappings: false,
        domainMappings: false,
        usage: false,
      },
    },
    capabilitiesJson: [],
    instructionsJson: [],
    workerJson: {
      id: WORKER_ID,
      displayName: "test",
      repos: [],
      initScript: "",
      gitName: "Test",
      gitEmail: "test@example.invalid",
    },
    userEnv: { envVars: [] },
    start: false,
  } as any;
}

test("Docker worker creation adds portable recovery labels only for journaled imports", async () => {
  const service = new DockerService(loadConfig());
  const creations: any[] = [];
  (service as any).ensureImage = async () => {};
  (service as any).docker = {
    createContainer: async (options: any) => {
      creations.push(options);
      return { id: `container-${creations.length}` };
    },
  };
  await service.createWorkerContainer(workerCreateInput());
  await service.createWorkerContainer({
    ...workerCreateInput(),
    portableImportIdentity: {
      ownerId: USER_ID,
      workerId: WORKER_ID,
      operationId: OPERATION_ID,
    },
  });
  expect(creations[0].Labels).toEqual({
    "agentor.managed": "true",
    "agentor.id": WORKER_ID,
  });
  expect(creations[1].Labels).toMatchObject({
    "agentor.managed": "true",
    "agentor.id": WORKER_ID,
    "agentor.owner-id": USER_ID,
    "agentor.worker-id": WORKER_ID,
    "agentor.portable-import-id": OPERATION_ID,
  });
  await expect(service.createWorkerContainer({
    ...workerCreateInput(),
    portableImportIdentity: {
      ownerId: "other-owner",
      workerId: WORKER_ID,
      operationId: OPERATION_ID,
    },
  })).rejects.toThrow("does not match");
  expect(creations).toHaveLength(2);
});

test("legacy v5 extract-repack-extract never gains managed-volume fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-portable-v5-repack-"));
  try {
    const manifest: WorkerExportManifest = {
      version: WORKER_EXPORT_VERSION,
      exportedAt: "2026-09-22T00:00:00.000Z",
      source: {
        id: WORKER_ID,
        displayName: "source",
        containerName: `agentor-worker-${WORKER_ID}`,
        imageName: "agentor-worker:latest",
      },
      worker: { displayName: "source", repos: [], mounts: [], initScript: "" },
      environment: { id: "default", name: "Default" },
      portMappings: [],
      domainMappings: [],
      contents: { rootfs: false, workspace: false, agents: false },
      localPersistence: [{ path: "/srv/state", included: false }],
    };
    const manifestPath = join(dir, "manifest.json");
    const first = join(dir, "first.tar");
    const second = join(dir, "second.tar");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await pipeline(
      packBundle([{ name: BUNDLE_FILES.manifest, path: manifestPath }]),
      createWriteStream(first, { mode: 0o600 }),
    );
    const extracted = await extractBundle(first, join(dir, "first"));
    await pipeline(
      packBundle([{ name: BUNDLE_FILES.manifest, path: join(dir, "first", BUNDLE_FILES.manifest) }]),
      createWriteStream(second, { mode: 0o600 }),
    );
    const repacked = await extractBundle(second, join(dir, "second"));
    expect(extracted.manifest.version).toBe(WORKER_EXPORT_VERSION);
    expect(repacked.manifest.version).toBe(WORKER_EXPORT_VERSION);
    expect(Object.hasOwn(repacked.manifest.contents, "managedVolumes")).toBe(false);
    expect(Object.hasOwn(repacked.manifest, "managedVolumes")).toBe(false);
    expect(repacked.managedVolumesPath).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated bundle preflight cannot publish an unimportable managed payload", () => {
  expect(() => validateBundleOutputLayout([
    { name: BUNDLE_FILES.managedVolumes, size: MAX_BUNDLE_ENTRY_BYTES - 1024 },
    { name: BUNDLE_FILES.workspace, size: MAX_BUNDLE_ENTRY_BYTES - 1024 },
  ])).not.toThrow();
  expect(() => validateBundleOutputLayout([
    { name: BUNDLE_FILES.managedVolumes, size: MAX_BUNDLE_ENTRY_BYTES + 1 },
  ])).toThrow("importable size limit");
  expect(() => validateBundleOutputLayout([
    { name: BUNDLE_FILES.managedVolumes, size: MAX_BUNDLE_ENTRY_BYTES },
    { name: BUNDLE_FILES.workspace, size: MAX_BUNDLE_ENTRY_BYTES },
  ])).toThrow("importable size limit");
  expect(() => validateBundleOutputLayout([
    { name: BUNDLE_FILES.managedVolumes, size: MAX_BUNDLE_ENTRY_BYTES - 1024 },
    { name: BUNDLE_FILES.workspace, size: MAX_BUNDLE_TOTAL_BYTES - MAX_BUNDLE_ENTRY_BYTES + 1024 },
  ])).toThrow("importable size limit");
});
