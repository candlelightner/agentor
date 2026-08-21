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

  await expect(store.rebuild(groupId, ownerId)).resolves.toMatchObject({
    image: { digest: `sha256:${"a".repeat(64)}` },
  });
  expect(rebuildCalls).toBe(1);
  expect(fake.findById(groupId)?.adminWorkspace).toMatchObject({
    imageDigest: `sha256:${"a".repeat(64)}`,
  });
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
  const attempted = store.getStartupScript(groupId, () => {
    if (!authorized)
      throw Object.assign(new Error("Resource not found"), { statusCode: 404 });
  });
  authorized = false;
  release();
  await preceding;
  await expect(attempted).rejects.toMatchObject({ statusCode: 404 });
});
