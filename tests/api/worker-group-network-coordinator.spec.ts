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
  const held = new Promise<void>((resolve) => { release = resolve; });
  const service = new WorkerGroupNetworkCoordinator(dependencies({
    group: () => current,
    networks: () => networks,
    remove: async () => { current = undefined as unknown as WorkerGroup; },
  }));

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

test("queued group worker enrollment derives membership inside the owner lock", async () => {
  let current = group();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const service = new WorkerGroupNetworkCoordinator(dependencies({
    group: () => current,
    update: async (_userId, _groupId, patch) => {
      current = { ...current, ...patch, workerIds: patch.workerIds ?? current.workerIds };
      return current;
    },
  }));

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

test("reconciliation failure restores topology even when group storage rollback fails", async () => {
  let current = group();
  let updates = 0;
  const reconciliations: Array<string[] | undefined> = [];
  const service = new WorkerGroupNetworkCoordinator(dependencies({
    group: () => current,
    networks: () => [network],
    update: async (_userId, _groupId, patch) => {
      updates++;
      if (updates === 2) throw new Error("injected persistence failure");
      current = { ...current, ...patch, workerIds: patch.workerIds ?? current.workerIds };
      return current;
    },
    reconcile: async (_network, workerIds) => {
      reconciliations.push(workerIds === undefined ? undefined : [...workerIds]);
      return reconciliations.length === 1
        ? { workerIds: ["new-worker"], partialFailures: ["injected attach failure"] }
        : { workerIds: [...(workerIds ?? [])], partialFailures: [] };
    },
  }));

  await expect(service.update(ownerId, groupId, { workerIds: ["new-worker"] }))
    .rejects.toMatchObject({ statusCode: 409 });
  expect(reconciliations).toEqual([undefined, ["old-worker"]]);
});

test("worker group persistence failure leaves the in-memory record unchanged", async () => {
  class FailingStore extends WorkerGroupStore {
    fail = false;
    protected override persistUser(): Promise<void> {
      return this.fail ? Promise.reject(new Error("injected write failure")) : Promise.resolve();
    }
  }
  const store = new FailingStore("/unused");
  const created = await store.create(ownerId, "before");
  store.fail = true;
  await expect(store.update(ownerId, created.id, { name: "after" })).rejects.toThrow("injected write failure");
  expect(store.get(ownerId, created.id)?.name).toBe("before");
  await expect(store.remove(ownerId, created.id)).rejects.toThrow("injected write failure");
  expect(store.get(ownerId, created.id)?.name).toBe("before");
});

function dependencies(overrides: {
  group?: () => WorkerGroup | undefined;
  networks?: () => ManagedNetwork[];
  update?: WorkerGroupNetworkDependencies["groups"]["update"];
  remove?: WorkerGroupNetworkDependencies["groups"]["remove"];
  reconcile?: WorkerGroupNetworkDependencies["manager"]["reconcile"];
} = {}): WorkerGroupNetworkDependencies {
  return {
    groups: {
      get: () => overrides.group?.() ?? group(),
      update: overrides.update ?? (async (_userId, _groupId, patch) => ({ ...group(), ...patch })),
      remove: overrides.remove ?? (async () => undefined),
    },
    networks: {
      listForUser: () => overrides.networks?.() ?? [],
      get: (_userId, id) => (overrides.networks?.() ?? []).find((candidate) => candidate.id === id),
    },
    manager: {
      reconcile: overrides.reconcile ?? (async (_network, workerIds) => ({ workerIds: [...(workerIds ?? [])], partialFailures: [] })),
    },
    verify: async () => undefined,
  };
}
