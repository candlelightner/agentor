import { expect, test } from "@playwright/test";
import {
  AdminWorkspaceStore,
  type AdministrativeWorkspaceRecord,
  type AdminWorkspaceRuntimeAdapter,
} from "../../orchestrator/server/utils/admin-workspace-store";
import {
  GroupAdminWorkspaceStore,
  type GroupAdministrativeWorkspaceRecord,
} from "../../orchestrator/server/utils/group-admin-workspace-store";
import {
  withWorkerNetworkMutation,
} from "../../orchestrator/server/utils/worker-group-manager";
import type { WorkerGroup } from "../../orchestrator/server/utils/worker-group-store";
import {
  OperationDeadlineError,
  operationSettlement,
} from "../../orchestrator/server/utils/operation-deadline";
import {
  administrativeOwnerEnvironment,
  DockerAdminWorkspaceRuntime,
} from "../../orchestrator/server/utils/admin-workspace-runtime";

function runtime(overrides: Partial<AdminWorkspaceRuntimeAdapter> = {}) {
  return {
    ensure: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    rebuild: async () => undefined,
    ...overrides,
  } satisfies AdminWorkspaceRuntimeAdapter;
}

function groupRecord(ownerId: string, groupId: string) {
  const stamp = new Date().toISOString();
  const workspace: GroupAdministrativeWorkspaceRecord = {
    schemaVersion: 1,
    id: `workspace-${groupId}`,
    kind: "group-administrative",
    trusted: true,
    groupId,
    ownerId,
    services: ["terminal", "editor", "desktop"],
    status: "running",
    createdAt: stamp,
    updatedAt: stamp,
  };
  const group: WorkerGroup = {
    id: groupId,
    userId: ownerId,
    name: "transaction test",
    workerIds: [],
    adminWorkspace: structuredClone(workspace),
    createdAt: stamp,
    updatedAt: stamp,
  };
  return { group, workspace };
}

test("administrative owner environment cannot override credential-routing control-plane keys", () => {
  const environment = administrativeOwnerEnvironment({
    userId: "owner-a",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    envVars: [
      { key: "AGENTOR_MANAGEMENT_MCP_URL", value: "https://invalid.example/mcp" },
      { key: "AGENTOR_MANAGEMENT_MCP_CREDENTIAL", value: "/workspace/not-a-credential" },
      { key: "AGENTOR_MANAGEMENT_MCP_TIMEOUT_MS", value: "120000" },
      { key: "ORCHESTRATOR_URL", value: "https://invalid.example" },
      { key: "AGENTOR_RUNTIME_ROLE", value: "platform-admin" },
      { key: "SAFE_OWNER_SETTING", value: "retained" },
    ],
  });
  expect(environment).toEqual(["SAFE_OWNER_SETTING=retained"]);
});

test("unconsumed administrative bootstrap credentials expire and are cleared in-process", () => {
  const runtime = new DockerAdminWorkspaceRuntime({} as any) as any;
  runtime.rememberPendingCredential("admin-test", "test-credential");
  expect(runtime.takePendingCredential("admin-test")).toBe("test-credential");

  runtime.pendingCredentials.get("admin-test").expiresAt = 0;
  expect(runtime.takePendingCredential("admin-test")).toBeUndefined();
  expect(runtime.pendingCredentials.has("admin-test")).toBe(false);
});

test("start-boundary credentials survive an old-runtime refresh until the replacement consumes them", async () => {
  const runtime = new DockerAdminWorkspaceRuntime({} as any) as any;
  runtime.docker = {
    getContainer: () => ({
      inspect: async () => ({ State: { Running: true } }),
    }),
  };
  runtime.writeCredential = async () => undefined;

  await runtime.materializeCredential(
    "replacement-credential",
    undefined,
    "prepare-start",
  );
  expect(runtime.takePendingCredential("agentor-admin-workspace")).toBe(
    "replacement-credential",
  );

  await runtime.materializeCredential(
    "refreshed-credential",
    undefined,
    "refresh-running",
  );
  expect(
    runtime.takePendingCredential("agentor-admin-workspace"),
  ).toBeUndefined();
});

test("slow administrative preparation mints the short-lived identity only at the actual start boundary", async () => {
  const sequence: string[] = [];
  const container = {
    inspect: async () => ({ State: { Running: false } }),
    start: async () => { sequence.push("start"); },
    stop: async () => undefined,
  };
  const runtime = new DockerAdminWorkspaceRuntime({} as any) as any;
  runtime.docker = { getContainer: () => container };
  runtime.writeCredential = async (_container: unknown, credential: string) => {
    expect(credential).toBe("just-in-time-credential");
    sequence.push("write");
  };
  const stamp = new Date().toISOString();
  const record: AdministrativeWorkspaceRecord = {
    schemaVersion: 1,
    id: "admin-jit-test",
    kind: "administrative",
    trusted: true,
    status: "running",
    createdAt: stamp,
    updatedAt: stamp,
  };

  await runtime.prepareCredential(record, async () => {
    sequence.push("issue");
    return "just-in-time-credential";
  });
  expect(sequence).toEqual([]);
  expect(runtime.pendingCredentials.size).toBe(0);
  expect(runtime.pendingCredentialIssuers.size).toBe(1);

  // Represents an arbitrarily slow image/overlay preparation phase. No raw
  // identity exists until startWithPreparedCredential reaches the gate.
  sequence.push("preflight-complete");
  await runtime.startWithPreparedCredential(container, record);

  expect(sequence).toEqual([
    "preflight-complete",
    "issue",
    "start",
    "write",
  ]);
  expect(runtime.pendingCredentialIssuers.size).toBe(0);
  expect(runtime.pendingCredentials.size).toBe(0);
});

class FakeGroups {
  records = new Map<string, WorkerGroup>();
  failNextUpdate = false;

  findById(id: string) {
    return this.records.get(id);
  }

  list() {
    return [...this.records.values()];
  }

  async update(ownerId: string, id: string, patch: { adminWorkspace?: Record<string, any> }) {
    const current = this.records.get(id);
    if (!current || current.userId !== ownerId)
      throw Object.assign(new Error("Worker group not found"), { statusCode: 404 });
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("injected group persistence failure");
    }
    const next = {
      ...current,
      adminWorkspace: structuredClone(patch.adminWorkspace),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, next);
    return next;
  }
}

test("global admin runtime success is durably retried without repeating the side effect", async () => {
  let persisted: AdministrativeWorkspaceRecord | undefined;
  let failNextWrite = false;
  let stopCalls = 0;
  const store = new AdminWorkspaceStore("/unused", async (record) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("injected workspace persistence failure");
    }
    persisted = structuredClone(record);
  });
  store.setRuntimeAdapter(runtime({
    stop: async (record) => {
      stopCalls++;
      // Runtime adapters receive a detached snapshot, not the store record.
      (record as AdministrativeWorkspaceRecord).marker = "adapter-mutation";
    },
  }));

  await store.ensure();
  failNextWrite = true;
  await expect(store.setStatus("stopped")).rejects.toThrow(
    "injected workspace persistence failure",
  );
  expect(stopCalls).toBe(1);
  expect(persisted?.status).toBe("running");
  await expect(store.getStatus()).rejects.toMatchObject({ statusCode: 503 });
  await expect(store.getStartupScript()).rejects.toMatchObject({ statusCode: 503 });
  expect(persisted?.status).toBe("running");

  await expect(store.setStatus("stopped")).resolves.toMatchObject({
    status: "stopped",
  });
  expect(stopCalls).toBe(1);
  expect(persisted).toMatchObject({ status: "stopped" });
  expect(persisted).not.toHaveProperty("marker");
});

test("global admin persistence rejection does not publish an uncommitted script", async () => {
  let failNextWrite = false;
  const store = new AdminWorkspaceStore("/unused", async () => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("injected workspace persistence failure");
    }
  });
  store.setRuntimeAdapter({ ensure: async () => {}, start: async () => {}, stop: async () => {}, rebuild: async () => {} });
  await store.ensure();
  failNextWrite = true;
  await expect(store.setStartupScript("echo unsafe")).rejects.toThrow(
    "injected workspace persistence failure",
  );
  await expect(store.getStartupScript()).resolves.toMatchObject({
    script: "",
    revision: 0,
  });
});

test("global admin materializes its identity with start and refresh intents", async () => {
  const events: string[] = [];
  const store = new AdminWorkspaceStore("/unused", async () => {});
  store.setRuntimeAdapter(runtime({
    ensure: async () => { events.push("ensure"); },
    start: async () => { events.push("start"); },
    rebuild: async () => { events.push("rebuild"); },
  }));
  store.setIdentityMaterializer(async (_record, intent) => {
    events.push(`identity:${intent}`);
  });

  await store.ensure();
  expect(events).toEqual([
    "identity:prepare-start",
    "ensure",
    "identity:refresh-running",
  ]);
  events.length = 0;
  await store.setStatus("stopped");
  await store.setStatus("running");
  expect(events).toEqual([
    "identity:prepare-start",
    "start",
    "identity:refresh-running",
  ]);
  events.length = 0;
  await store.rebuild();
  expect(events).toEqual([
    "identity:prepare-start",
    "rebuild",
    "identity:refresh-running",
  ]);
});

test("global admin retries stay fenced until an aborted Docker mutation settles", async () => {
  const store = new AdminWorkspaceStore("/unused", async () => {});
  let startCalls = 0;
  let releaseDocker!: () => void;
  const dockerSettlement = new Promise<void>((resolve) => {
    releaseDocker = resolve;
  });
  const timeout = new OperationDeadlineError(
    "DOCKER_OPERATION_TIMEOUT",
    "admin workspace start",
    30_000,
  );
  Object.defineProperty(timeout, operationSettlement, {
    value: dockerSettlement,
    enumerable: false,
  });
  store.setRuntimeAdapter(runtime({
    start: async () => {
      startCalls++;
      if (startCalls === 1) throw timeout;
    },
  }));

  await store.ensure();
  await store.setStatus("stopped");
  await expect(store.setStatus("running")).rejects.toMatchObject({
    code: "DOCKER_OPERATION_TIMEOUT",
  });
  await expect(store.setStatus("running")).rejects.toMatchObject({ statusCode: 409 });
  await expect(store.getStatus()).rejects.toMatchObject({ statusCode: 503 });
  expect(startCalls).toBe(1);

  releaseDocker();
  await expect.poll(async () => (await store.getStatus().catch(() => null))?.status).toBe('stopped');
  await expect(store.setStatus("running")).resolves.toMatchObject({ status: "running" });
  expect(startCalls).toBe(2);
});

test("group admin runtime success is persisted on retry without a second stop", async () => {
  const ownerId = `group-admin-transaction-${Date.now()}`;
  const groupId = `${ownerId}-group`;
  const fake = new FakeGroups();
  fake.records.set(groupId, groupRecord(ownerId, groupId).group);
  let stopCalls = 0;
  const store = new GroupAdminWorkspaceStore(fake as any);
  store.setRuntimeAdapter(runtime({
    stop: async (record) => {
      stopCalls++;
      (record as GroupAdministrativeWorkspaceRecord).startupScript =
        "adapter mutation";
    },
  }));

  fake.failNextUpdate = true;
  await expect(store.setStatus(groupId, "stopped")).rejects.toThrow(
    "injected group persistence failure",
  );
  expect(stopCalls).toBe(1);
  expect(fake.findById(groupId)?.adminWorkspace).toMatchObject({
    status: "running",
  });

  await expect(store.setStatus(groupId, "stopped")).resolves.toMatchObject({
    status: "stopped",
  });
  expect(stopCalls).toBe(1);
  expect(fake.findById(groupId)?.adminWorkspace).toMatchObject({
    status: "stopped",
  });
  expect(fake.findById(groupId)?.adminWorkspace).not.toHaveProperty(
    "startupScript",
  );
});

test("group admin rebuild acknowledgement retry does not rebuild twice", async () => {
  const ownerId = `group-admin-rebuild-retry-${Date.now()}`;
  const groupId = `${ownerId}-group`;
  const fake = new FakeGroups();
  fake.records.set(groupId, groupRecord(ownerId, groupId).group);
  let rebuildCalls = 0;
  const store = new GroupAdminWorkspaceStore(fake as any);
  store.setRuntimeAdapter(runtime({
    rebuild: async () => {
      rebuildCalls++;
      return {
        name: "agentor-admin-worker:test",
        digest: `sha256:${"a".repeat(64)}`,
      };
    },
  }));

  fake.failNextUpdate = true;
  await expect(store.rebuild(groupId, ownerId)).rejects.toThrow(
    "injected group persistence failure",
  );
  expect(rebuildCalls).toBe(1);
  expect(fake.findById(groupId)?.adminWorkspace).not.toHaveProperty(
    "imageDigest",
  );
  await expect(store.getStatus(groupId)).rejects.toMatchObject({ statusCode: 503 });
  expect(fake.findById(groupId)?.adminWorkspace).not.toHaveProperty("imageDigest");

  await expect(store.rebuild(groupId, ownerId)).resolves.toMatchObject({
    image: { digest: `sha256:${"a".repeat(64)}` },
  });
  expect(rebuildCalls).toBe(1);
  expect(fake.findById(groupId)?.adminWorkspace).toMatchObject({
    imageDigest: `sha256:${"a".repeat(64)}`,
  });
});

test("group admin materializes its identity with start and refresh intents", async () => {
  const ownerId = `group-admin-identity-${Date.now()}`;
  const groupId = `${ownerId}-group`;
  const fake = new FakeGroups();
  fake.records.set(groupId, groupRecord(ownerId, groupId).group);
  const events: string[] = [];
  const store = new GroupAdminWorkspaceStore(fake as any);
  store.setRuntimeAdapter(runtime({
    ensure: async () => { events.push("ensure"); },
    start: async () => { events.push("start"); },
    rebuild: async () => { events.push("rebuild"); },
  }));
  store.setIdentityMaterializer(async (_record, intent) => {
    events.push(`identity:${intent}`);
  });

  await store.ensure(groupId);
  expect(events).toEqual([
    "identity:prepare-start",
    "ensure",
    "identity:refresh-running",
  ]);
  events.length = 0;
  await store.setStatus(groupId, "stopped");
  await store.setStatus(groupId, "running");
  expect(events).toEqual([
    "identity:prepare-start",
    "start",
    "identity:refresh-running",
  ]);
  events.length = 0;
  await store.rebuild(groupId, ownerId);
  expect(events).toEqual([
    "identity:prepare-start",
    "rebuild",
    "identity:refresh-running",
  ]);
});

test("group admin state mutations are cloned and wait behind live group deletion", async () => {
  const ownerId = `group-admin-delete-race-${Date.now()}`;
  const groupId = `${ownerId}-group`;
  const fake = new FakeGroups();
  fake.records.set(groupId, groupRecord(ownerId, groupId).group);
  const store = new GroupAdminWorkspaceStore(fake as any);

  fake.failNextUpdate = true;
  await expect(store.setStartupScript(groupId, "echo uncommitted")).rejects.toThrow(
    "injected group persistence failure",
  );
  expect(fake.findById(groupId)?.adminWorkspace).not.toHaveProperty(
    "startupScript",
  );

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deletion = withWorkerNetworkMutation(ownerId, async () => {
    await gate;
    fake.records.delete(groupId);
  });
  const staleUpdate = store.setStartupScript(groupId, "echo after delete");
  release();
  await deletion;
  await expect(staleUpdate).rejects.toMatchObject({ statusCode: 404 });
});

test("group admin authorization is evaluated inside the owner hierarchy queue", async () => {
  const ownerId = `group-admin-auth-race-${Date.now()}`;
  const groupId = `${ownerId}-group`;
  const fake = new FakeGroups();
  fake.records.set(groupId, groupRecord(ownerId, groupId).group);
  const store = new GroupAdminWorkspaceStore(fake as any);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preceding = withWorkerNetworkMutation(ownerId, () => gate);
  let authorized = true;
  const authorize = () => {
    if (!authorized)
      throw Object.assign(new Error("Resource not found"), { statusCode: 404 });
  };
  const attempted = store.getStartupScript(groupId, authorize);
  const status = store.getStatus(groupId, authorize);
  authorized = false;
  release();
  await preceding;
  await expect(attempted).rejects.toMatchObject({ statusCode: 404 });
  await expect(status).rejects.toMatchObject({ statusCode: 404 });
});

test("read-only admin status distinguishes absence without provisioning", async () => {
  const global = new AdminWorkspaceStore("/unused", async () => { throw Error("Read must not persist"); });
  await expect(global.getStatus()).resolves.toBeNull();
  await expect(global.getStartupScript()).rejects.toMatchObject({ statusCode: 404 });
  const fake = new FakeGroups(), { group } = groupRecord("read-owner", "read-group");
  delete group.adminWorkspace;
  fake.records.set(group.id, group);
  const scoped = new GroupAdminWorkspaceStore(fake as any);
  await expect(scoped.getStatus(group.id)).rejects.toMatchObject({ statusCode: 404 });
});


test("global admin status and duplicate actions return promptly while a lifecycle action is delayed", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = new AdminWorkspaceStore("/unused", async () => {});
  store.setRuntimeAdapter(runtime({ stop: () => gate }));
  await store.ensure();
  const stopping = store.setStatus("stopped");
  try {
    await expect(store.getStatus()).rejects.toMatchObject({ statusCode: 503 });
    await expect(store.setStatus("running")).rejects.toMatchObject({ statusCode: 409 });
  } finally { release(); await stopping; }
  await expect(store.getStatus()).resolves.toMatchObject({ status: "stopped" });
});

for (const scoped of [false, true]) test(`${scoped ? 'group' : 'platform'} admin memory settings reject unbounded values, persist desired limits and do not mutate runtime`, async () => {
  const global = new AdminWorkspaceStore('/unused', async () => {});
  global.setRuntimeAdapter(runtime());
  await global.ensure();
  const fake = new FakeGroups(), { group } = groupRecord('memory-owner', 'memory-group');
  group.adminWorkspace!.runtimeKind = 'incus-vm';
  fake.records.set(group.id, group);
  const groups = new GroupAdminWorkspaceStore(fake as any);
  const get = () => scoped ? groups.getResources(group.id) : global.getResources();
  const set = (value: unknown) => scoped ? groups.setResources(group.id, value) : global.setResources(value);
  expect(await get()).toEqual({ memoryLimit: '4GiB', appliedMemoryLimit: '4GiB', pendingRebuild: false });
  for (const invalid of ['', '0', '0GiB', '-1GiB', '50%', 'unlimited', 'InfinityGiB', '9007199254740992GiB', 8, null])
    await expect(set(invalid)).rejects.toMatchObject({ statusCode: 400 });
  expect(await set('8GiB')).toEqual({ memoryLimit: '8GiB', appliedMemoryLimit: '4GiB', pendingRebuild: true });
  expect(await get()).toEqual({ memoryLimit: '8GiB', appliedMemoryLimit: '4GiB', pendingRebuild: true });
  expect(scoped ? fake.findById(group.id)?.adminWorkspace?.memoryLimit : global.getRecord()?.memoryLimit).toBe('8GiB');
});

for (const scoped of [false, true]) test(`${scoped ? 'group' : 'platform'} admin status observes stopped compute without changing desired state and rejects a concurrent lifecycle`, async () => {
  const global = new AdminWorkspaceStore('/unused', async () => {});
  const fake = new FakeGroups(), { group } = groupRecord('status-owner', 'status-group');
  fake.records.set(group.id, group);
  const groups = new GroupAdminWorkspaceStore(fake as any);
  let observe: () => Promise<'running' | 'stopped'> = async () => 'stopped';
  const adapter = runtime({ observeStatus: () => observe() });
  global.setRuntimeAdapter(adapter); groups.setRuntimeAdapter(adapter);
  await global.ensure();
  const get = () => scoped ? groups.getStatus(group.id) : global.getStatus();
  const desired = () => scoped ? fake.findById(group.id)?.adminWorkspace?.status : global.getRecord()?.status;
  await expect(get()).resolves.toMatchObject({ status: 'stopped' });
  expect(desired()).toBe('running');
  observe = async () => { throw Object.assign(new Error('Host policy rejected inspection'), { statusCode: 409 }); };
  await expect(get()).rejects.toThrow('Host policy rejected');
  let release!: (value: 'running') => void;
  observe = () => new Promise(resolve => { release = resolve; });
  const stale = get();
  await expect.poll(() => Boolean(release)).toBe(true);
  if (scoped) fake.records.get(group.id)!.adminWorkspace!.status = 'stopped';
  else await global.setStatus('stopped');
  release('running');
  await expect(stale).rejects.toMatchObject({ statusCode: 503 });
});
