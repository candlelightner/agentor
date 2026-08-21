import { expect, test } from "@playwright/test";
import {
  WorkerGroupNetworkCoordinator,
  type WorkerGroupNetworkDependencies,
} from "../../orchestrator/server/utils/worker-group-manager";
import { WorkerGroupStore } from "../../orchestrator/server/utils/worker-group-store";
import type { WorkerGroup } from "../../orchestrator/server/utils/worker-group-store";
import type { ManagedNetwork } from "../../orchestrator/server/utils/managed-network-store";

const ownerId = "owner-a";
const groupId = "group-a";
const network = {
  id: "network-a",
  userId: ownerId,
  name: "group network",
  dockerName: "agentor-managed-network-a",
  scope: "group",
  groupId,
  workerIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies ManagedNetwork;

function group(workerIds = ["old-worker"]): WorkerGroup {
  return {
    id: groupId,
    userId: ownerId,
    name: "group",
    workerIds,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("owner queue closes network-reference create versus group-delete races", async () => {
  let current = group();
  const networks: ManagedNetwork[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      group: () => current,
      networks: () => networks,
      remove: async () => {
        current = undefined as unknown as WorkerGroup;
      },
    }),
  );

  const createReference = service.withOwner(ownerId, async () => {
    await held;
    networks.push(network);
  });
  const deletion = service.delete(ownerId, groupId);
  release();
  await createReference;
  await expect(deletion).rejects.toMatchObject({ statusCode: 409 });
  expect(current.id).toBe(groupId);
  expect(networks).toEqual([network]);
});

test("failed group persistence invokes dependent-state deletion compensation", async () => {
  let restored = false;
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      group: () => group([]),
      remove: async () => {
        throw new Error("injected group persistence failure");
      },
    }),
  );
  await expect(
    service.delete(ownerId, groupId, async () => async () => {
      restored = true;
    }),
  ).rejects.toThrow("injected group persistence failure");
  expect(restored).toBe(true);
});

test("queued group worker enrollment derives membership inside the owner lock", async () => {
  let current = group();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      group: () => current,
      update: async (_userId, _groupId, patch) => {
        current = {
          ...current,
          ...patch,
          workerIds: patch.workerIds ?? current.workerIds,
        };
        return current;
      },
    }),
  );

  const concurrentMembershipChange = service.withOwner(ownerId, async () => {
    await held;
    current = { ...current, workerIds: ["concurrent-worker"] };
  });
  const enrollment = service.addWorker(ownerId, groupId, "new-worker");
  release();
  await concurrentMembershipChange;
  await enrollment;
  expect(current.workerIds).toEqual(["concurrent-worker", "new-worker"]);
});

test("scope authorization is rechecked inside the owner mutation queue", async () => {
  let current = group();
  let updates = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      group: () => current,
      update: async (_userId, _groupId, patch) => {
        updates++;
        current = {
          ...current,
          ...patch,
          workerIds: patch.workerIds ?? current.workerIds,
        };
        return current;
      },
    }),
  );

  const precedingMutation = service.withOwner(ownerId, async () => held);
  const scopedUpdate = service.update(
    ownerId,
    groupId,
    { name: "must-not-apply" },
    undefined,
    () => {
      throw Object.assign(new Error("Resource not found"), { statusCode: 404 });
    },
  );
  release();
  await precedingMutation;
  await expect(scopedUpdate).rejects.toMatchObject({ statusCode: 404 });
  expect(updates).toBe(0);
  expect(current.name).toBe("group");
});

test("queued group deletion rechecks live scope immediately before removal", async () => {
  let current = group([]);
  let removals = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      group: () => current,
      remove: async () => {
        removals++;
        current = undefined as unknown as WorkerGroup;
      },
    }),
  );
  const preceding = service.withOwner(ownerId, () => held);
  let authorized = true;
  const deletion = service.delete(ownerId, groupId, async () => {
    if (!authorized)
      throw Object.assign(new Error("Resource not found"), { statusCode: 404 });
  });

  authorized = false;
  release();
  await preceding;
  await expect(deletion).rejects.toMatchObject({ statusCode: 404 });
  expect(removals).toBe(0);
  expect(current.id).toBe(groupId);
});

test("group deletion rejects direct workers and child groups", async () => {
  const direct = new WorkerGroupNetworkCoordinator(dependencies());
  expect(() => direct.assertCanDelete(ownerId, groupId)).toThrow(
    /direct workers/,
  );
  const root = group([]);
  const child = { ...group([]), id: "child", parentId: groupId };
  const nested = new WorkerGroupNetworkCoordinator(
    dependencies({ groups: () => [root, child] }),
  );
  expect(() => nested.assertCanDelete(ownerId, groupId)).toThrow(
    /child groups/,
  );
});

test("reconciliation failure restores topology even when group storage rollback fails", async () => {
  let current = group();
  let updates = 0;
  const reconciliations: Array<string[] | undefined> = [];
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      group: () => current,
      networks: () => [network],
      update: async (_userId, _groupId, patch) => {
        updates++;
        if (updates === 2) throw new Error("injected persistence failure");
        current = {
          ...current,
          ...patch,
          workerIds: patch.workerIds ?? current.workerIds,
        };
        return current;
      },
      reconcile: async (_network, workerIds) => {
        reconciliations.push(
          workerIds === undefined ? undefined : [...workerIds],
        );
        return reconciliations.length === 1
          ? {
              workerIds: ["new-worker"],
              partialFailures: ["injected attach failure"],
            }
          : { workerIds: [...(workerIds ?? [])], partialFailures: [] };
      },
    }),
  );

  await expect(
    service.update(ownerId, groupId, { workerIds: ["new-worker"] }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(reconciliations).toEqual([undefined, ["old-worker"]]);
});

test("direct membership changes reconcile the group and every ancestor network", async () => {
  let groups = [
    { ...group([]), id: "root" },
    { ...group(["old-worker"]), id: "child", parentId: "root" },
  ];
  const networks = [
    { ...network, id: "root-network", groupId: "root" },
    { ...network, id: "child-network", groupId: "child" },
  ];
  const reconciled: string[] = [];
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      groups: () => groups,
      networks: () => networks,
      update: async (_userId, id, patch) => {
        const current = groups.find((candidate) => candidate.id === id)!;
        const updated = { ...current, ...patch } as WorkerGroup;
        groups = groups.map((candidate) =>
          candidate.id === id ? updated : candidate,
        );
        return updated;
      },
      reconcile: async (candidate) => {
        reconciled.push(candidate.id);
        return { workerIds: [], partialFailures: [] };
      },
    }),
  );

  await service.update(ownerId, "child", { workerIds: ["new-worker"] });
  expect(new Set(reconciled)).toEqual(
    new Set(["root-network", "child-network"]),
  );
});

test("reparenting reconciles both old and new ancestor networks", async () => {
  let groups = [
    { ...group([]), id: "old-root" },
    { ...group([]), id: "new-root" },
    { ...group(["moved-worker"]), id: "child", parentId: "old-root" },
  ];
  const networks = [
    { ...network, id: "old-network", groupId: "old-root" },
    { ...network, id: "new-network", groupId: "new-root" },
  ];
  const reconciled: string[] = [];
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      groups: () => groups,
      networks: () => networks,
      update: async (_userId, id, patch) => {
        const current = groups.find((candidate) => candidate.id === id)!;
        const updated = { ...current, ...patch } as WorkerGroup;
        groups = groups.map((candidate) =>
          candidate.id === id ? updated : candidate,
        );
        return updated;
      },
      reconcile: async (candidate) => {
        reconciled.push(candidate.id);
        return { workerIds: [], partialFailures: [] };
      },
    }),
  );

  await service.update(ownerId, "child", { parentId: "new-root" });
  expect(new Set(reconciled)).toEqual(new Set(["old-network", "new-network"]));
});

test("worker group persistence failure leaves the in-memory record unchanged", async () => {
  class FailingStore extends WorkerGroupStore {
    fail = false;
    protected override persistUser(): Promise<void> {
      return this.fail
        ? Promise.reject(new Error("injected write failure"))
        : Promise.resolve();
    }
  }
  const store = new FailingStore("/unused");
  const created = await store.create(ownerId, "before");
  store.fail = true;
  await expect(
    store.update(ownerId, created.id, { name: "after" }),
  ).rejects.toThrow("injected write failure");
  expect(store.get(ownerId, created.id)?.name).toBe("before");
  await expect(store.remove(ownerId, created.id)).rejects.toThrow(
    "injected write failure",
  );
  expect(store.get(ownerId, created.id)?.name).toBe("before");

  store.fail = false;
  const target = await store.create(ownerId, "target");
  await store.update(ownerId, created.id, { workerIds: ["worker-a"] });
  store.fail = true;
  await expect(
    store.assignWorker(ownerId, "worker-a", created.id, target.id),
  ).rejects.toThrow("injected write failure");
  expect(store.get(ownerId, created.id)?.workerIds).toEqual(["worker-a"]);
  expect(store.get(ownerId, target.id)?.workerIds).toEqual([]);
});

test("assignment reconciliation rollback restores both memberships atomically", async () => {
  let groups = [
    { ...group(["worker-a"]), id: "source" },
    { ...group([]), id: "target" },
  ];
  const assignments: Array<[string | undefined, string | null]> = [];
  let reconciliations = 0;
  const service = new WorkerGroupNetworkCoordinator(
    dependencies({
      groups: () => groups,
      networks: () => [
        { ...network, id: "source-network", groupId: "source" },
        { ...network, id: "target-network", groupId: "target" },
      ],
      assignWorker: async (_userId, workerId, sourceId, targetId) => {
        assignments.push([sourceId, targetId]);
        groups = groups.map((candidate) => ({
          ...candidate,
          workerIds:
            candidate.id === sourceId
              ? candidate.workerIds.filter((id) => id !== workerId)
              : candidate.id === targetId
                ? [...new Set([...candidate.workerIds, workerId])]
                : candidate.workerIds,
        }));
        return targetId
          ? groups.find((candidate) => candidate.id === targetId)!
          : null;
      },
      reconcile: async () => ({
        workerIds: [],
        partialFailures:
          reconciliations++ === 0 ? ["injected attach failure"] : [],
      }),
    }),
  );

  await expect(
    service.assignWorker(ownerId, "worker-a", "target"),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(assignments).toEqual([
    ["source", "target"],
    ["target", "source"],
  ]);
  expect(
    groups.find((candidate) => candidate.id === "source")?.workerIds,
  ).toEqual(["worker-a"]);
  expect(
    groups.find((candidate) => candidate.id === "target")?.workerIds,
  ).toEqual([]);
});

test("concurrent worker group patches preserve unrelated committed fields", async () => {
  class PausingStore extends WorkerGroupStore {
    writes = 0;
    entered!: () => void;
    release!: () => void;
    readonly writeEntered = new Promise<void>((resolve) => {
      this.entered = resolve;
    });
    readonly writeRelease = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    protected override async persistUser(): Promise<void> {
      // create() is write one; pause the first update so the second is queued.
      if (++this.writes === 2) {
        this.entered();
        await this.writeRelease;
      }
    }
  }
  const store = new PausingStore("/unused");
  const created = await store.create(ownerId, "before");
  const rename = store.update(ownerId, created.id, { name: "after" });
  await store.writeEntered;
  const assign = store.update(ownerId, created.id, { workerIds: ["worker-b"] });
  store.release();
  await Promise.all([rename, assign]);
  expect(store.get(ownerId, created.id)).toMatchObject({
    name: "after",
    workerIds: ["worker-b"],
  });
});

function dependencies(
  overrides: {
    group?: () => WorkerGroup | undefined;
    groups?: () => WorkerGroup[];
    networks?: () => ManagedNetwork[];
    update?: WorkerGroupNetworkDependencies["groups"]["update"];
    assignWorker?: WorkerGroupNetworkDependencies["groups"]["assignWorker"];
    remove?: WorkerGroupNetworkDependencies["groups"]["remove"];
    reconcile?: WorkerGroupNetworkDependencies["manager"]["reconcile"];
  } = {},
): WorkerGroupNetworkDependencies {
  return {
    groups: {
      listForUser: () =>
        overrides.groups?.() ??
        (() => {
          const candidate = overrides.group?.() ?? group();
          return candidate ? [candidate] : [];
        })(),
      get: (_userId, id) => {
        if (overrides.groups)
          return overrides.groups().find((candidate) => candidate.id === id);
        const candidate = overrides.group?.() ?? group();
        return candidate?.id === id ? candidate : undefined;
      },
      update:
        overrides.update ??
        (async (_userId, _groupId, patch) => ({ ...group(), ...patch })),
      assignWorker:
        overrides.assignWorker ??
        (async (_userId, _workerId, _sourceId, targetId) =>
          targetId ? group() : null),
      remove: overrides.remove ?? (async () => undefined),
    },
    networks: {
      listForUser: () => overrides.networks?.() ?? [],
      get: (_userId, id) =>
        (overrides.networks?.() ?? []).find((candidate) => candidate.id === id),
    },
    manager: {
      reconcile:
        overrides.reconcile ??
        (async (_network, workerIds) => ({
          workerIds: [...(workerIds ?? [])],
          partialFailures: [],
        })),
    },
    verify: async () => undefined,
  };
}
