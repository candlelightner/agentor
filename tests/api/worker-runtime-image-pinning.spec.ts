import { expect, test } from "@playwright/test";
import { ContainerManager } from "../../orchestrator/server/utils/container";
import { DockerService } from "../../orchestrator/server/utils/docker";
import { useManagedVolumeManager } from "../../orchestrator/server/utils/managed-volume-manager";
import { validRuntimeSnapshotIdentity } from "../../orchestrator/server/utils/worker-store";

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

const reference = "agentor-import-worker-1:runtime-operation-1";
const imageId = `sha256:${"a".repeat(64)}`;
const identity = { reference, imageId, portableIdentity: {
  version: 1 as const, configDigest: `sha256:${"b".repeat(64)}`,
  platform: { os: "linux", architecture: "amd64" },
} };

test("durable snapshot identity is strictly shaped and bound to worker and reference", () => {
  expect(validRuntimeSnapshotIdentity(identity, reference, "worker-1")).toBe(true);
  for (const value of [
    { ...identity, reference: "agentor-import-worker-2:runtime-operation-1" },
    { ...identity, imageId: "latest" },
    { ...identity, portableIdentity: null },
    { ...identity, portableIdentity: { ...identity.portableIdentity, configDigest: [identity.portableIdentity.configDigest] } },
    { ...identity, portableIdentity: { ...identity.portableIdentity, platform: { os: "linux", architecture: "amd64", extra: "ignored" } } },
    { ...identity, unexpectedAuthority: true },
  ]) expect(validRuntimeSnapshotIdentity(value, reference, "worker-1")).toBe(false);
});

test("record projection retains a trusted pin but never carries it onto another image", () => {
  const manager = new ContainerManager({} as any, { containerPrefix: "agentor-worker" } as any);
  (manager as any).workerStore = { get: () => ({ importedImage: reference, runtimeSnapshotIdentity: identity }) };
  const base = { id: "worker-1", userId: "owner-1", createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", displayName: "Worker", containerId: "container-id",
    containerName: "agentor-worker-worker-1", imageName: reference, imageId,
    status: "running" as const, importedImage: reference };
  expect((manager as any).containerInfoToWorkerRecord(base).runtimeSnapshotIdentity).toEqual(identity);
  expect((manager as any).containerInfoToWorkerRecord({ ...base, importedImage: "plain-import" }).runtimeSnapshotIdentity).toBeUndefined();
  expect(() => (manager as any).containerInfoToWorkerRecord({
    ...base, runtimeSnapshotIdentity: { ...identity, imageId: `sha256:${"c".repeat(64)}` },
  })).toThrow(/disagrees with its durable record/);
});

test("storage recreation journals the exact replacement before inspecting its snapshot image", async () => {
  const events: string[] = [];
  const sourceId = "source-container";
  const replacementId = "replacement-container";
  const wrongImage = `sha256:${"c".repeat(64)}`;
  const source = {
    Id: sourceId, Name: "/agentor-worker-worker-1", Image: imageId,
    Config: { Image: reference, Labels: { "agentor.id": "worker-1" }, Hostname: sourceId.slice(0, 12) },
    HostConfig: { Runtime: "runc", Privileged: false, Mounts: [], Binds: [] },
    NetworkSettings: { Networks: {} }, Mounts: [], State: { Running: false, Paused: false },
  };
  const replacement = {
    id: replacementId,
    inspect: async () => { events.push("inspect-replacement"); return {
      ...source, Id: replacementId, Image: wrongImage,
    }; },
    stop: async () => { events.push("stop-replacement"); },
  };
  const old = {
    inspect: async () => source,
    update: async () => { events.push("update-source"); },
    rename: async () => { events.push("rename-source"); },
    remove: async () => { events.push("remove-source"); },
  };
  const docker = {
    getContainer: (id: string) => id === sourceId ? old : id === replacementId ? replacement : undefined,
    createContainer: async (options: { Image: string }) => {
      events.push(`create:${options.Image}`);
      return replacement;
    },
  };
  const volumes = useManagedVolumeManager() as any;
  const previous = {
    init: volumes.init, isRecoveryBlocked: volumes.isRecoveryBlocked,
    prepare: volumes.prepare, markDeclared: volumes.markDeclared,
    runtime: volumes.runtime, recreations: volumes.recreations,
    store: volumes.store,
  };
  let journal: any;
  volumes.init = async () => {};
  volumes.isRecoveryBlocked = () => false;
  volumes.prepare = async () => [];
  volumes.markDeclared = async () => { events.push("mark-declared"); };
  volumes.runtime = { docker };
  volumes.store = { forWorker: () => [] };
  volumes.recreations = {
    get: () => journal,
    save: async (next: any) => { journal = structuredClone(next); events.push(`save:${next.replacementId ?? "source"}`); },
    clear: async () => { journal = undefined; events.push("clear"); },
  };
  const manager = new ContainerManager({} as any, { containerPrefix: "agentor-worker" } as any);
  const info = { id: "worker-1", userId: "owner-1", containerId: sourceId,
    containerName: "agentor-worker-worker-1", importedImage: reference,
    runtimeSnapshotIdentity: identity, runtimeProfile: "legacy-runc", status: "stopped" };
  (manager as any).containers.set(info.id, info);
  (manager as any).resolveImageOpts = async () => ({ image: imageId, expectedImageId: imageId });
  (manager as any).assertOrdinaryMutation = () => {};
  (manager as any).assertRuntimeRestoreApproved = () => {};
  (manager as any).assertRuntimeRollbackFinalized = () => {};
  (manager as any).assertRecreationRuntime = async () => {};
  (manager as any).persistDesiredRuntimeStatus = async () => {};
  (globalThis as any).useLogCollector ??= () => ({ detach() {} });
  try {
    await expect((manager as any).applyManagedStorageUnlocked(info.id))
      .rejects.toThrow(/different runtime snapshot image/);
    expect(events.indexOf(`save:${replacementId}`)).toBeLessThan(events.indexOf("inspect-replacement"));
    expect(journal?.replacementId).toBe(replacementId);
    expect(info.containerId).toBe(sourceId);
    expect(events).not.toContain("remove-source");
    await expect((manager as any).applyManagedStorageUnlocked(info.id))
      .rejects.toThrow(/different runtime snapshot image/);
    expect(events.filter((event) => event.startsWith("create:"))).toEqual([`create:${imageId}`]);
    expect(journal?.replacementId).toBe(replacementId);
  } finally {
    Object.assign(volumes, previous);
  }
});

test("an archived runtime snapshot without a stored identity cannot adopt a mutable tag", async () => {
  const manager = new ContainerManager({} as any, { containerPrefix: "agentor-worker" } as any);
  await expect((manager as any).resolveImageOpts(reference)).rejects.toMatchObject({
    code: "RUNTIME_SNAPSHOT_IDENTITY_MISSING",
  });
});

test("snapshot cleanup retains its image when worker inventory is incomplete or another owner depends on it", async () => {
  const manager = new ContainerManager({} as any, { containerPrefix: "agentor-worker" } as any);
  const dockerAccess: string[] = [];
  (manager as any).runtimeSnapshotDocker = () => { dockerAccess.push("docker"); return {}; };
  await (manager as any).removeOwnedRuntimeSnapshotImage("owner-1", "worker-1", identity);
  (manager as any).workerStore = {
    listUserIds: () => ["owner-1", "unavailable-owner"],
    listForUser: (owner: string) => {
      if (owner === "unavailable-owner") throw new Error("owner partition quarantined");
      return [];
    },
  };
  await (manager as any).removeOwnedRuntimeSnapshotImage("owner-1", "worker-1", identity);
  (manager as any).workerStore = {
    listUserIds: () => ["owner-1", "owner-2"],
    listForUser: (owner: string) => owner === "owner-2"
      ? [{ id: "worker-1", userId: owner, importedImage: reference, runtimeSnapshotIdentity: identity }]
      : [],
  };
  await (manager as any).removeOwnedRuntimeSnapshotImage("owner-1", "worker-1", identity);
  expect(dockerAccess).toEqual([]);
});

function legacySnapshotFixture() {
  const events: string[] = [];
  const containerId = "d".repeat(64);
  const info = { id: "worker-1", userId: "owner-1", containerId,
    containerName: "agentor-worker-worker-1", importedImage: reference,
    runtimeProfile: "legacy-runc", status: "running" };
  let record: any = { id: info.id, userId: info.userId, importedImage: reference, status: "active" };
  const store = {
    get: () => record,
    upsert: async (next: any) => { events.push("save-pin"); record = structuredClone(next); },
  };
  const manager = new ContainerManager({
    stopContainer: async () => { events.push("stop-source"); },
    removeContainer: async () => { events.push("remove-source"); },
  } as any, { containerPrefix: "agentor-worker" } as any);
  (manager as any).workerStore = store;
  (manager as any).containers.set(info.id, info);
  (manager as any).assertOrdinaryMutation = () => {};
  (manager as any).assertRuntimeRollbackFinalized = () => {};
  (manager as any).assertRuntimeRestoreApproved = () => {};
  (manager as any).persistentBackupPathMounts = async () => { events.push("prepare-storage"); throw new Error("stop after pin"); };
  (manager as any).persistDesiredRuntimeStatus = async () => { events.push("persist-stop"); };
  (manager as any).inspectRuntimeSnapshotSource = async () => {
    events.push("inspect-source");
    return { Id: containerId, Name: `/${info.containerName}`, Image: imageId,
      Config: { Image: reference, Labels: { "agentor.managed": "true", "agentor.id": info.id } },
      HostConfig: { Runtime: "runc", Privileged: false } };
  };
  (manager as any).runtimeSnapshotDocker = () => ({ getImage: (name: string) => ({
    modem: { dial: (_options: unknown, cb: (error: Error | null, image?: unknown) => void) => {
      events.push(`inspect-image:${name}`); cb(null, { Id: imageId });
    } },
  }) });
  return { manager, info, store, events, getRecord: () => record };
}

test("legacy backfill rejects conflicting optional owner provenance before archive mutation", async () => {
  const f = legacySnapshotFixture();
  (f.manager as any).inspectRuntimeSnapshotSource = async () => {
    f.events.push("inspect-source");
    return { Id: f.info.containerId, Name: `/${f.info.containerName}`, Image: imageId,
      Config: { Image: reference, Labels: { "agentor.managed": "true", "agentor.id": f.info.id,
        "agentor.owner-id": "another-owner" } },
      HostConfig: { Runtime: "runc", Privileged: false } };
  };
  await expect((f.manager as any).archiveUnlocked(f.info.id)).rejects.toMatchObject({
    code: "RUNTIME_SNAPSHOT_IDENTITY_MISSING",
  });
  expect(f.events).toEqual(["inspect-source"]);
});

test("active legacy snapshot backfill persists source image identity before archive storage and Docker changes", async () => {
  const f = legacySnapshotFixture();
  await expect((f.manager as any).archiveUnlocked(f.info.id)).rejects.toThrow("stop after pin");
  expect(f.getRecord().runtimeSnapshotIdentity).toEqual({ reference, imageId });
  expect(f.info).toMatchObject({ runtimeSnapshotIdentity: { reference, imageId } });
  expect(f.events).toEqual(["inspect-source", `inspect-image:${reference}`, "save-pin", "prepare-storage"]);
});

test("failed legacy pin persistence prevents archive from stopping or removing the source", async () => {
  const f = legacySnapshotFixture();
  f.store.upsert = async () => { f.events.push("save-pin"); throw new Error("persistence unavailable"); };
  await expect((f.manager as any).archiveUnlocked(f.info.id)).rejects.toThrow("persistence unavailable");
  expect(f.getRecord().runtimeSnapshotIdentity).toBeUndefined();
  expect(f.info.runtimeSnapshotIdentity).toBeUndefined();
  expect(f.events).toEqual(["inspect-source", `inspect-image:${reference}`, "save-pin"]);
});

test("a durable legacy pin cannot be reseeded from a different live source when its tag changes", async () => {
  const f = legacySnapshotFixture();
  const durable = { reference, imageId };
  (f.manager as any).workerStore = { get: () => ({ ...f.getRecord(), runtimeSnapshotIdentity: durable }),
    upsert: async () => { f.events.push("save-pin"); } };
  (f.manager as any).inspectRuntimeSnapshotSource = async () => { f.events.push("inspect-source"); throw new Error("must not inspect"); };
  (f.manager as any).runtimeSnapshotDocker = () => ({ getImage: () => ({ modem: { dial: (_options: unknown,
    cb: (error: Error | null, image?: unknown) => void) => {
      f.events.push("inspect-image"); cb(null, { Id: `sha256:${"c".repeat(64)}` });
    } } }) });
  await expect((f.manager as any).archiveUnlocked(f.info.id)).rejects.toThrow(/platform is unavailable/);
  expect(f.events).toEqual(["inspect-image"]);
});

function dockerFixture(observedImage = imageId) {
  const events: string[] = [];
  const service = new DockerService({ workerImagePrefix: "", workerImage: "worker:latest",
    dockerNetwork: "agentor-net" } as any);
  (service as any).docker = {
    getImage: (name: string) => ({ modem: { dial: (_options: unknown, cb: (error: Error | null, image?: unknown) => void) => {
      events.push(`inspect-image:${name}`); cb(null, { Id: imageId });
    } } }),
    createContainer: async (options: any) => {
      events.push(`create:${options.Image}`);
      return {
        id: "container-id",
        modem: { dial: (_options: unknown, cb: (error: Error | null, container?: unknown) => void) => {
          events.push("inspect-created"); cb(null, { Image: observedImage });
        } },
        start: async () => { events.push("start"); },
        remove: async () => { events.push("remove"); },
      };
    },
  };
  (service as any).materializeWorkerSecretFiles = async () => { events.push("bootstrap"); };
  const opts = { userId: "owner-1", id: "worker-1", containerName: "agentor-worker-worker-1",
    runtimeProfile: "legacy-runc" as const, dockerEnabled: false,
    environmentJson: { networkMode: "full", allowedDomains: [], dockerEnabled: false,
      setupScript: "", envVars: "", exposeApis: {} },
    capabilitiesJson: [], instructionsJson: [],
    workerJson: { id: "worker-1", displayName: "Worker", repos: [], initScript: "", gitName: "", gitEmail: "" },
    userEnv: { userId: "owner-1", envVars: [] }, image: imageId, expectedImageId: imageId,
  };
  return { service, events, opts };
}

test("snapshot create consumes the immutable ID and verifies Docker's resolved image before start", async () => {
  const f = dockerFixture();
  await f.service.createWorkerContainer(f.opts as any);
  expect(f.events).toEqual([`inspect-image:${imageId}`, `create:${imageId}`, "inspect-created", "start", "bootstrap"]);
});

test("mismatched Docker image is removed before the worker can start", async () => {
  const f = dockerFixture(`sha256:${"c".repeat(64)}`);
  await expect(f.service.createWorkerContainer(f.opts as any)).rejects.toThrow(/different runtime snapshot image/);
  expect(f.events).toEqual([`inspect-image:${imageId}`, `create:${imageId}`, "inspect-created", "remove"]);
});
