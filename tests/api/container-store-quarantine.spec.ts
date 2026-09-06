import { expect, test } from "@playwright/test";
import { ContainerManager } from "../../orchestrator/server/utils/container";
import { OperationDeadlineError } from "../../orchestrator/server/utils/operation-deadline";
import { withWorkerLifecycleMutation } from "../../orchestrator/server/utils/worker-lifecycle-coordinator";

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

test("managed runtimes without authoritative worker records stay quarantined", async () => {
  const errors: string[] = [];
  (globalThis as any).useLogger = () => ({
    error(message: string) { errors.push(message); },
    warn() {},
    info() {},
    debug() {},
  });
  const docker = {
    listContainers: async () => [{
      Id: "docker-container-id",
      Names: ["/agentor-worker-worker-missing"],
      Image: "agentor-worker:latest",
      ImageID: "sha256:image",
      State: "running",
      Labels: { "agentor.id": "worker-missing" },
    }],
  };
  const manager = new ContainerManager(
    docker as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [],
    findById: () => undefined,
  } as any);

  await manager.sync();

  expect(manager.list()).toEqual([]);
  expect(errors).toEqual([
    expect.stringContaining("authoritative worker record worker-missing is unavailable"),
  ]);
});

function workerRecord() {
  return {
    id: "worker-1",
    userId: "owner-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    displayName: "Worker 1",
    status: "active" as const,
  };
}

function dockerWorker() {
  return {
    Id: "docker-worker-1",
    Names: ["/agentor-worker-worker-1"],
    Image: "agentor-worker:latest",
    ImageID: "sha256:image",
    State: "running",
    Labels: { "agentor.id": "worker-1" },
  };
}

test("legacy workers persist desired running state after a verified task observation", async () => {
  const saved: string[] = [];
  const record = workerRecord();
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => ({
        status: "running",
        running: true,
        restartPolicy: "unless-stopped",
        secretHandshakeRequired: false,
      }),
      probeContainerTask: async () => undefined,
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
    setDesiredRuntimeStatus: async (_owner: string, _id: string, desired: string) => {
      saved.push(desired);
    },
  } as any);

  await manager.sync();

  expect(manager.get("worker-1")).toMatchObject({
    status: "running",
    desiredRuntimeStatus: "running",
  });
  expect(saved).toEqual(["running"]);
});

test("legacy crash-looping workers retain running intent for managed bootstrap recovery", async () => {
  const saved: string[] = [];
  const record = workerRecord();
  const restarting = { ...dockerWorker(), State: "restarting" };
  const manager = new ContainerManager(
    {
      listContainers: async () => [restarting],
      inspectContainerRuntime: async () => ({
        status: "restarting",
        running: false,
        restartPolicy: "unless-stopped",
        secretHandshakeRequired: true,
      }),
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
    setDesiredRuntimeStatus: async (_owner: string, _id: string, desired: string) => {
      saved.push(desired);
    },
  } as any);

  await manager.sync();

  expect(manager.get("worker-1")).toMatchObject({
    status: "starting",
    desiredRuntimeStatus: "running",
  });
  expect(saved).toEqual(["running"]);
});

test("a directly started secret worker is unknown until its bootstrap handshake exists", async () => {
  const record = {
    ...workerRecord(),
    desiredRuntimeStatus: "running" as const,
  };
  let secretAwareProbe = false;
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => ({
        status: "running",
        running: true,
        restartPolicy: "unless-stopped",
        secretHandshakeRequired: true,
      }),
      probeContainerTask: async (
        _containerId: string,
        secretHandshakeRequired: boolean,
      ) => {
        secretAwareProbe = secretHandshakeRequired;
        throw Object.assign(
          new Error("Worker secret bootstrap handshake is unavailable"),
          {
            code: "WORKER_SECRET_BOOTSTRAP_REQUIRED",
            data: { operation: "Docker worker task probe" },
          },
        );
      },
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
  } as any);

  await manager.sync();

  expect(secretAwareProbe).toBe(true);
  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown",
    desiredRuntimeStatus: "running",
    runtimeDiagnostic: {
      code: "WORKER_SECRET_BOOTSTRAP_REQUIRED",
      operation: "Docker worker task probe",
      retryable: true,
    },
  });
});

test("a failed live-task probe exposes unknown rather than stale running health", async () => {
  const record = workerRecord();
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => ({
        status: "running",
        running: true,
        restartPolicy: "unless-stopped",
        secretHandshakeRequired: false,
      }),
      probeContainerTask: async () => {
        throw new OperationDeadlineError(
          "DOCKER_OPERATION_TIMEOUT",
          "Docker worker task probe",
          10_000,
        );
      },
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
    setDesiredRuntimeStatus: async () => {
      throw new Error("unknown observations must not become desired state");
    },
  } as any);

  await manager.sync();

  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown",
    runtimeDiagnostic: {
      code: "DOCKER_OPERATION_TIMEOUT",
      operation: "Docker worker task probe",
      retryable: true,
    },
  });
});

test("sync cannot overwrite a lifecycle replacement with its older Docker snapshot", async () => {
  const record = workerRecord();
  let releaseInspection!: () => void;
  let inspecting = false;
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => {
        inspecting = true;
        await new Promise<void>((resolve) => { releaseInspection = resolve; });
        return {
          status: "running",
          running: true,
          restartPolicy: "unless-stopped",
          secretHandshakeRequired: false,
        };
      },
      probeContainerTask: async () => undefined,
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [record],
    findById: () => record,
    setDesiredRuntimeStatus: async () => undefined,
  } as any);
  (manager as any).containers.set("worker-1", {
    id: "worker-1",
    userId: "owner-1",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    containerId: "docker-worker-1",
    containerName: "agentor-worker-worker-1",
    displayName: "Worker 1",
    imageName: "agentor-worker:latest",
    imageId: "sha256:old",
    status: "running",
  });

  const syncing = manager.sync();
  for (let i = 0; !inspecting && i < 10; i++) await Promise.resolve();
  expect(inspecting).toBe(true);

  await withWorkerLifecycleMutation("worker-1", async () => {
    // This models a completed rebuild/recovery that replaced the disposable
    // Docker object while sync still owns the earlier list response.
    (manager as any).containers.set("worker-1", {
      ...(manager as any).containers.get("worker-1"),
      containerId: "docker-worker-replacement",
      imageId: "sha256:replacement",
      status: "starting",
    });
  });
  releaseInspection();
  await syncing;

  expect(manager.get("worker-1")).toMatchObject({
    containerId: "docker-worker-replacement",
    imageId: "sha256:replacement",
    status: "starting",
  });
});

test("sync never revives an archived worker from an older Docker list response", async () => {
  const record = workerRecord();
  let releaseInspection!: () => void;
  let inspecting = false;
  const manager = new ContainerManager(
    {
      listContainers: async () => [dockerWorker()],
      inspectContainerRuntime: async () => {
        inspecting = true;
        await new Promise<void>((resolve) => { releaseInspection = resolve; });
        return { status: "running", running: true, restartPolicy: "no", secretHandshakeRequired: false };
      },
      probeContainerTask: async () => undefined,
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({ list: () => [record], findById: () => record } as any);
  const syncing = manager.sync();
  for (let i = 0; !inspecting && i < 10; i++) await Promise.resolve();
  expect(inspecting).toBe(true);
  await withWorkerLifecycleMutation("worker-1", async () => {
    (record as any).status = "archived";
    (manager as any).containers.delete("worker-1");
  });
  releaseInspection();
  await syncing;
  expect(manager.get("worker-1")).toBeUndefined();
});

test("a failed secret bootstrap is recoverable by stop/start without rebuilding", async () => {
  const record = { ...workerRecord(), desiredRuntimeStatus: "running" as const };
  let bootstrapAttempts = 0;
  let bootstrapAvailable = false;
  let starts = 0;
  let stops = 0;
  let creates = 0;
  let pluginReconciles = 0;
  const docker = {
    updateContainerRestartPolicy: async () => undefined,
    inspectContainerRuntime: async () => ({
      status: "exited",
      running: false,
      restartPolicy: "no",
      secretHandshakeRequired: true,
    }),
    startContainer: async () => { starts++; },
    restartContainer: async () => { throw new Error("unexpected restart"); },
    materializeWorkerSecretFiles: async () => {
      bootstrapAttempts++;
      if (!bootstrapAvailable) throw new Error("injected transient provider outage");
    },
    stopContainer: async () => { stops++; },
    probeContainerTask: async () => undefined,
    createWorkerContainer: async () => { creates++; },
  };
  const manager = new ContainerManager(
    docker as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    get: () => record,
    setDesiredRuntimeStatus: async () => record,
  } as any);
  // Production lifecycle entry points revalidate the owner through auth. This
  // focused unit test deliberately supplies only Docker/store doubles, so keep
  // it independent of the native SQLite addon used by the auth module.
  (manager as any).assertOwnerExists = async () => undefined;
  (manager as any).containers.set("worker-1", {
    id: "worker-1",
    userId: "owner-1",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    containerId: "docker-worker-1",
    containerName: "agentor-worker-worker-1",
    displayName: "Worker 1",
    imageName: "agentor-worker:latest",
    imageId: "sha256:image",
    status: "stopped",
    desiredRuntimeStatus: "running",
  });
  (manager as any).resolveUserEnvAndBinds = async () => ({
    userEnv: { userId: "owner-1", envVars: [] },
    credentialBinds: [],
    groupSecrets: [{ kind: "secret", key: "GROUP_TOKEN", value: "runtime-only" }],
  });
  (manager as any).reconcileWorkerPlugins = async () => { pluginReconciles++; };

  await expect(manager.restart("worker-1")).rejects.toMatchObject({
    statusCode: 503,
    code: "WORKER_SECRET_BOOTSTRAP_FAILED",
    data: {
      phase: "secret-bootstrap",
      retryable: true,
      volumesPreserved: true,
    },
  });
  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown",
    desiredRuntimeStatus: "running",
  });
  expect(bootstrapAttempts).toBe(3);
  expect(stops).toBe(1);

  // The normal lifecycle path must recover the existing immutable container;
  // no rebuild or replacement is needed after the provider becomes available.
  await manager.stop("worker-1");
  expect(manager.get("worker-1")).toMatchObject({
    status: "stopped",
    desiredRuntimeStatus: "stopped",
  });
  bootstrapAvailable = true;
  await manager.restart("worker-1");
  expect(manager.get("worker-1")).toMatchObject({ status: "running" });
  expect(starts).toBe(2);
  expect(stops).toBe(2);
  expect(creates).toBe(0);
  expect(pluginReconciles).toBe(1);
});

test("one unresponsive runtime does not block reconciliation of another worker", async () => {
  const records = [
    { ...workerRecord(), id: "worker-1", desiredRuntimeStatus: "running" as const },
    { ...workerRecord(), id: "worker-2", desiredRuntimeStatus: "running" as const },
  ];
  const inspected: string[] = [];
  const manager = new ContainerManager(
    {
      inspectContainerRuntime: async (containerId: string) => {
        inspected.push(containerId);
        if (containerId === "docker-worker-1")
          throw new OperationDeadlineError(
            "DOCKER_OPERATION_TIMEOUT",
            "Docker worker inspection",
            8_000,
          );
        return {
          status: "running",
          running: true,
          restartPolicy: "unless-stopped",
          secretHandshakeRequired: false,
        };
      },
      updateContainerRestartPolicy: async () => undefined,
    } as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    get: (_owner: string, id: string) => records.find((item) => item.id === id),
    upsert: async () => undefined,
    listActive: () => records,
    listArchived: () => [],
  } as any);
  for (const [index, record] of records.entries())
    (manager as any).containers.set(record.id, {
      id: record.id,
      userId: record.userId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      containerId: `docker-worker-${index + 1}`,
      containerName: `agentor-worker-${record.id}`,
      displayName: record.displayName,
      imageName: "agentor-worker:latest",
      imageId: "sha256:image",
      status: "running",
      desiredRuntimeStatus: "running",
    });
  (manager as any).resolveUserEnvAndBinds = async () => ({
    userEnv: { userId: "owner-1", envVars: [] },
    credentialBinds: [],
    groupSecrets: [],
  });

  await manager.reconcileWorkers();

  expect(inspected).toEqual(["docker-worker-1", "docker-worker-2"]);
  expect(manager.get("worker-1")).toMatchObject({
    status: "unknown",
    runtimeDiagnostic: { code: "DOCKER_OPERATION_TIMEOUT" },
  });
  expect(manager.get("worker-2")).toMatchObject({ status: "running" });
});
