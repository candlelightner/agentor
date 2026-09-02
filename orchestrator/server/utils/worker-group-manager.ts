import { AsyncLocalStorage } from "node:async_hooks";
import { createError } from "h3";
import { useManagedNetworkManager } from "./managed-network-manager";
import type { ManagedNetwork } from "./managed-network-store";
import {
  useManagedNetworkStore,
  useWorkerGroupStore,
  useWorkerGroupEnvStore,
  useWorkerStore,
} from "./services";
import { useImageCatalogManager } from "./image-catalog";
import type { WorkerGroup } from "./worker-group-store";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import { verifyWorkerMutationUnlocks } from "./worker-protection-lock";

type WorkerGroupPatch = Pick<Partial<WorkerGroup>, "name" | "workerIds"> & {
  parentId?: string | null;
};
type Reconciliation = { workerIds: string[]; partialFailures: string[] };

interface GroupStoreLike {
  listForUser(userId: string): WorkerGroup[];
  get(userId: string, groupId: string): WorkerGroup | undefined;
  update(
    userId: string,
    groupId: string,
    patch: WorkerGroupPatch,
  ): Promise<WorkerGroup>;
  assignWorker(
    userId: string,
    workerId: string,
    expectedSourceId: string | undefined,
    targetGroupId: string | null,
  ): Promise<WorkerGroup | null>;
  setWorkerReferences(
    userId: string,
    workerId: string,
    groupIds: Iterable<string>,
  ): Promise<string[]>;
  removeWorkerReferences(userId: string, workerId: string): Promise<string[]>;
  remove(userId: string, groupId: string): Promise<void>;
}
interface NetworkStoreLike {
  listForUser(userId: string): ManagedNetwork[];
  get(userId: string, networkId: string): ManagedNetwork | undefined;
}
interface NetworkManagerLike {
  reconcile(
    network: ManagedNetwork,
    workerIds?: Iterable<string>,
  ): Promise<Reconciliation>;
}
export interface WorkerGroupNetworkDependencies {
  groups: GroupStoreLike;
  networks: NetworkStoreLike;
  manager: NetworkManagerLike;
  verify(workerIds: Iterable<string>, passwords: unknown): Promise<void>;
  workerExists(userId: string, workerId: string): boolean;
}

/** One owner-scoped queue spans group mutations and managed-network reference
 * mutations. This closes check/create and check/delete races without globally
 * serializing unrelated users. */
export class WorkerGroupNetworkCoordinator {
  private queues = new Map<string, Promise<void>>();
  private activeOwners = new AsyncLocalStorage<
    ReadonlyMap<string, { active: boolean }>
  >();

  constructor(
    private readonly dependencies: WorkerGroupNetworkDependencies = productionDependencies(),
  ) {}

  withOwner<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const active = this.activeOwners.getStore();
    // Group-scoped management calls intentionally hold this queue across the
    // authorized operation. Cleanup performed by that operation may need to
    // update the same owner's memberships; waiting on our own queue tail would
    // deadlock the request. The async-local marker permits only an operation
    // already executing inside this coordinator's same-owner boundary to run
    // inline. Independent requests remain serialized normally.
    if (active?.get(userId)?.active) return operation();
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => {
      // Async-local state is inherited by detached tasks. Invalidate this
      // marker when the queued operation settles so a late continuation can
      // never use an expired execution context to bypass serialization.
      const marker = { active: true };
      const context = new Map(active ?? []);
      context.set(userId, marker);
      return this.activeOwners.run(context, async () => {
        try {
          return await operation();
        } finally {
          marker.active = false;
        }
      });
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(userId, tail);
    void tail.finally(() => {
      if (this.queues.get(userId) === tail) this.queues.delete(userId);
    });
    return result;
  }

  /** Update a group and apply its membership to every dependent network. */
  update(
    userId: string,
    groupId: string,
    patch: WorkerGroupPatch,
    lockPasswords?: unknown,
    authorize?: () => void,
  ) {
    return this.withOwner(userId, () => {
      authorize?.();
      return this.updateLocked(userId, groupId, () => patch, lockPasswords);
    });
  }

  /** Add one worker using the membership snapshot read inside the owner queue. */
  addWorker(
    userId: string,
    groupId: string,
    workerId: string,
    lockPasswords?: unknown,
    authorize?: () => void,
  ) {
    return this.withOwner(userId, () => {
      authorize?.();
      return this.updateLocked(
        userId,
        groupId,
        (current) => ({
          workerIds: [...new Set([...current.workerIds, workerId])],
        }),
        lockPasswords,
      );
    });
  }

  assignWorker(
    userId: string,
    workerId: string,
    targetGroupId: string | null,
    lockPasswords?: unknown,
    authorize?: (sourceGroupId?: string, targetGroupId?: string) => void,
  ) {
    return this.withOwner(userId, async () => {
      const { groups } = this.dependencies;
      const containing = this.dependencies.groups
        .listForUser(userId)
        .filter((group) => group.workerIds.includes(workerId));
      if (containing.length > 1)
        throw createError({
          statusCode: 409,
          statusMessage: "Worker has conflicting direct group memberships",
        });
      const source = containing[0];
      const target = targetGroupId
        ? this.dependencies.groups.get(userId, targetGroupId)
        : undefined;
      if (targetGroupId && !target)
        throw createError({
          statusCode: 404,
          statusMessage: "Worker group not found",
        });
      authorize?.(source?.id, target?.id);
      if (source?.id === targetGroupId) return source;
      await this.dependencies.verify([workerId], lockPasswords);

      const hierarchy = new WorkerGroupHierarchy(groups);
      const affectedGroups = new Set<string>();
      for (const group of [source, target]) {
        if (!group) continue;
        for (const item of hierarchy.ancestors(userId, group.id, true))
          affectedGroups.add(item.id);
      }
      const networkIds = this.networkIdsForGroups(userId, affectedGroups);
      const previousTopology = this.networkMembershipSnapshot(
        userId,
        networkIds,
      );
      await groups.assignWorker(userId, workerId, source?.id, targetGroupId);

      const failures = await this.reconcileAll(userId, networkIds);
      if (!failures.length) return target ?? null;
      const rollbackFailures: string[] = [];
      await groups
        .assignWorker(userId, workerId, target?.id, source?.id ?? null)
        .catch((error) =>
          rollbackFailures.push(`membership: ${safeMessage(error)}`),
        );
      rollbackFailures.push(
        ...(await this.reconcileSnapshot(userId, previousTopology)),
      );
      throw createError({
        statusCode: 409,
        statusMessage: `Worker group network reconciliation failed: ${failures.join("; ")}. ${rollbackFailures.length ? `Rollback failed: ${rollbackFailures.join("; ")}` : "Previous memberships and topology restored."}`,
      });
    });
  }

  private async updateLocked(
    userId: string,
    groupId: string,
    resolvePatch: (current: WorkerGroup) => WorkerGroupPatch,
    lockPasswords?: unknown,
  ) {
    const { groups } = this.dependencies;
    const existing = groups.get(userId, groupId);
    if (!existing)
      throw createError({
        statusCode: 404,
        statusMessage: "Worker group not found",
      });
    const patch = resolvePatch(existing);
    const hierarchy = new WorkerGroupHierarchy(groups);
    if (patch.parentId !== undefined)
      hierarchy.validateParent(userId, groupId, patch.parentId);
    if (patch.workerIds !== undefined)
      hierarchy.assertMembershipAvailable(userId, groupId, patch.workerIds);
    const previous = {
      name: existing.name,
      workerIds: [...existing.workerIds],
      parentId: existing.parentId ?? null,
    };
    const affectedGroups = new Set<string>();
    if (patch.workerIds !== undefined || patch.parentId !== undefined)
      for (const item of hierarchy.ancestors(userId, groupId, true))
        affectedGroups.add(item.id);
    if (patch.parentId !== undefined && patch.parentId)
      for (const item of hierarchy.ancestors(userId, patch.parentId, true))
        affectedGroups.add(item.id);
    const networkIds = this.networkIdsForGroups(userId, affectedGroups);
    const previousTopology = this.networkMembershipSnapshot(userId, networkIds);

    if (networkIds.length)
      await this.dependencies.verify(
        patch.parentId !== undefined
          ? hierarchy.subtreeWorkerIds(userId, groupId)
          : [...new Set([...previous.workerIds, ...(patch.workerIds ?? [])])],
        lockPasswords,
      );

    const updated = await groups.update(userId, groupId, patch);
    if (!networkIds.length) return updated;

    const failures = await this.reconcileAll(userId, networkIds);
    if (!failures.length) return updated;

    let storageRollbackFailure = "";
    try {
      await groups.update(userId, groupId, previous);
    } catch (error) {
      storageRollbackFailure = safeMessage(error);
    }
    // Restore the exact pre-mutation topology even if persisting the group
    // rollback itself failed. Each ancestor network has its own snapshot.
    const topologyRollbackFailures = await this.reconcileSnapshot(
      userId,
      previousTopology,
    );
    const details = [
      storageRollbackFailure
        ? `group storage rollback failed: ${storageRollbackFailure}`
        : "previous group membership restored",
      topologyRollbackFailures.length
        ? `topology rollback failed: ${topologyRollbackFailures.join("; ")}`
        : "previous topology restored",
    ].join("; ");
    throw createError({
      statusCode: 409,
      statusMessage: `Worker group network reconciliation failed: ${failures.join("; ")}. ${details}`,
    });
  }

  delete(
    userId: string,
    groupId: string,
    beforeRemove?: () => Promise<void | (() => Promise<void>)>,
    authorize?: () => void,
  ) {
    return this.withOwner(userId, async () => {
      authorize?.();
      // Older worker deletion paths could leave ids behind after the durable
      // worker record was already gone. Repair only this already-authorized
      // target group before evaluating the normal non-empty guard. Never
      // discard a reference to a live or archived worker.
      const current = this.dependencies.groups.get(userId, groupId);
      if (current) {
        const retained = current.workerIds.filter((workerId) =>
          this.dependencies.workerExists(userId, workerId),
        );
        if (retained.length !== current.workerIds.length)
          await this.dependencies.groups.update(userId, groupId, {
            workerIds: retained,
          });
      }
      this.assertCanDelete(userId, groupId);
      const rollback = await beforeRemove?.();
      try {
        await this.dependencies.groups.remove(userId, groupId);
      } catch (error) {
        await rollback?.().catch(() => undefined);
        throw error;
      }
    });
  }

  /** Remove a permanently deleted worker from every direct membership and
   * reconcile networks derived from those groups and their ancestors. The
   * membership snapshot is restored on reconciliation failure so deletion
   * remains safely retryable instead of committing a half-updated topology. */
  removeDeletedWorker(userId: string, workerId: string) {
    return this.withOwner(userId, async () => {
      const containing = this.dependencies.groups
        .listForUser(userId)
        .filter((group) => group.workerIds.includes(workerId));
      if (!containing.length) return [];
      const hierarchy = new WorkerGroupHierarchy(this.dependencies.groups);
      const affectedGroups = new Set<string>();
      for (const group of containing)
        for (const item of hierarchy.ancestors(userId, group.id, true))
          affectedGroups.add(item.id);
      const networkIds = this.networkIdsForGroups(userId, affectedGroups);
      const previousTopology = this.networkMembershipSnapshot(
        userId,
        networkIds,
      );
      const previousGroupIds = containing.map((group) => group.id);
      await this.dependencies.groups.removeWorkerReferences(userId, workerId);
      const failures = await this.reconcileAll(userId, networkIds);
      if (!failures.length) return previousGroupIds;

      const rollbackFailures: string[] = [];
      await this.dependencies.groups
        .setWorkerReferences(userId, workerId, previousGroupIds)
        .catch((error) =>
          rollbackFailures.push(`membership: ${safeMessage(error)}`),
        );
      rollbackFailures.push(
        ...(await this.reconcileSnapshot(userId, previousTopology)),
      );
      throw createError({
        statusCode: 409,
        statusMessage: `Worker group network reconciliation failed during worker deletion: ${failures.join("; ")}. ${rollbackFailures.length ? `Rollback failed: ${rollbackFailures.join("; ")}` : "Previous memberships and topology restored."}`,
      });
    });
  }

  managedNetworksForGroup(userId: string, groupId: string) {
    return this.dependencies.networks
      .listForUser(userId)
      .filter(
        (network) => network.scope === "group" && network.groupId === groupId,
      );
  }

  private networkIdsForGroups(userId: string, groupIds: Iterable<string>) {
    const ids = new Set(groupIds);
    return this.dependencies.networks
      .listForUser(userId)
      .filter(
        (network) =>
          network.scope === "group" &&
          !!network.groupId &&
          ids.has(network.groupId),
      )
      .map((network) => network.id);
  }

  private networkMembershipSnapshot(
    userId: string,
    networkIds: Iterable<string>,
  ) {
    const hierarchy = new WorkerGroupHierarchy(this.dependencies.groups);
    const snapshot = new Map<string, string[]>();
    for (const networkId of networkIds) {
      const network = this.dependencies.networks.get(userId, networkId);
      if (!network?.groupId) continue;
      snapshot.set(
        networkId,
        hierarchy.subtreeWorkerIds(userId, network.groupId),
      );
    }
    return snapshot;
  }

  private async reconcileSnapshot(
    userId: string,
    snapshot: Map<string, string[]>,
  ) {
    const failures: string[] = [];
    for (const [networkId, workerIds] of snapshot) {
      const network = this.dependencies.networks.get(userId, networkId);
      if (!network) {
        failures.push(
          `${networkId}: managed network disappeared during rollback`,
        );
        continue;
      }
      try {
        const result = await this.dependencies.manager.reconcile(
          network,
          workerIds,
        );
        failures.push(
          ...result.partialFailures.map(
            (failure) => `${network.name}: ${failure}`,
          ),
        );
      } catch (error) {
        failures.push(`${network.name}: ${safeMessage(error)}`);
      }
    }
    return failures;
  }

  assertCanDelete(userId: string, groupId: string) {
    const hierarchy = new WorkerGroupHierarchy(this.dependencies.groups);
    const group = this.dependencies.groups.get(userId, groupId);
    if (!group)
      throw createError({
        statusCode: 404,
        statusMessage: "Worker group not found",
      });
    if (hierarchy.descendants(userId, groupId).length)
      throw createError({
        statusCode: 409,
        statusMessage:
          "Worker group has child groups. Move or delete them first.",
      });
    if (group.workerIds.length)
      throw createError({
        statusCode: 409,
        statusMessage:
          "Worker group has direct workers. Move or unassign them first.",
      });
    const references = this.managedNetworksForGroup(userId, groupId);
    if (!references.length) return;
    const labels = references.map((network) => network.name).join(", ");
    throw createError({
      statusCode: 409,
      statusMessage: `Worker group is used by managed network${references.length === 1 ? "" : "s"}: ${labels}. Delete or reconfigure the network first.`,
    });
  }

  private async reconcileAll(
    userId: string,
    networkIds: string[],
    workerIds?: Iterable<string>,
  ) {
    const failures: string[] = [];
    for (const networkId of networkIds) {
      const network = this.dependencies.networks.get(userId, networkId);
      if (!network) {
        failures.push(
          `${networkId}: managed network disappeared during reconciliation`,
        );
        continue;
      }
      try {
        const result = await this.dependencies.manager.reconcile(
          network,
          workerIds,
        );
        failures.push(
          ...result.partialFailures.map(
            (failure) => `${network.name}: ${failure}`,
          ),
        );
      } catch (error) {
        failures.push(`${network.name}: ${safeMessage(error)}`);
      }
    }
    return failures;
  }
}

function productionDependencies(): WorkerGroupNetworkDependencies {
  return {
    groups: useWorkerGroupStore(),
    networks: useManagedNetworkStore(),
    manager: useManagedNetworkManager(),
    verify: verifyWorkerMutationUnlocks,
    workerExists: (userId, workerId) =>
      Boolean(useWorkerStore().get(userId, workerId)),
  };
}

let singleton: WorkerGroupNetworkCoordinator | undefined;
export function useWorkerGroupNetworkCoordinator() {
  return (singleton ??= new WorkerGroupNetworkCoordinator());
}

export function withWorkerNetworkMutation<T>(
  userId: string,
  operation: () => Promise<T>,
) {
  return useWorkerGroupNetworkCoordinator().withOwner(userId, operation);
}

export function updateWorkerGroupWithNetworks(
  userId: string,
  groupId: string,
  patch: WorkerGroupPatch,
  lockPasswords?: unknown,
  authorize?: () => void,
) {
  return useWorkerGroupNetworkCoordinator()
    .update(userId, groupId, patch, lockPasswords, authorize)
    .then(async (result) => {
      if (patch.parentId !== undefined) {
        const { markGroupEnvPending } = await import("./worker-group-env");
        await markGroupEnvPending(userId, groupId);
      }
      if (patch.parentId !== undefined || patch.workerIds !== undefined)
        await reconcileHostMountsAfterGroupChange(userId);
      return result;
    });
}

export function addWorkerToGroupWithNetworks(
  userId: string,
  groupId: string,
  workerId: string,
  lockPasswords?: unknown,
  authorize?: () => void,
) {
  return useWorkerGroupNetworkCoordinator().addWorker(
    userId,
    groupId,
    workerId,
    lockPasswords,
    authorize,
  );
}

/** Atomically changes a worker's direct group under the owner queue. Rollback
 * restores persisted memberships when the destination update fails. */
export function assignWorkerToGroupWithNetworks(
  userId: string,
  workerId: string,
  targetGroupId: string | null,
  lockPasswords?: unknown,
  authorize?: (sourceGroupId?: string, targetGroupId?: string) => void,
) {
  return useWorkerGroupNetworkCoordinator()
    .assignWorker(userId, workerId, targetGroupId, lockPasswords, authorize)
    .then(async (result) => {
      const { markWorkersEnvPending } = await import("./worker-group-env");
      await markWorkersEnvPending(userId, [workerId]);
      await reconcileHostMountsAfterGroupChange(userId);
      return result;
    });
}

export function removeDeletedWorkerFromGroups(
  userId: string,
  workerId: string,
) {
  return useWorkerGroupNetworkCoordinator().removeDeletedWorker(
    userId,
    workerId,
  );
}

export async function deleteWorkerGroup(
  userId: string,
  groupId: string,
  beforeRemove?: () => Promise<void | (() => Promise<void>)>,
  authorize?: () => void,
) {
  const catalog = useImageCatalogManager();
  await catalog.init();
  const envStore = useWorkerGroupEnvStore();
  let removedEnv: Awaited<ReturnType<typeof envStore.take>> = undefined;
  try {
    await useWorkerGroupNetworkCoordinator().delete(
      userId,
      groupId,
      async () => {
        // Evaluate all deletion guards immediately before removal. Cleanup runs
        // while the group still exists because the administrative workspace store
        // resolves its record through the group.
        if (catalog.listForGroup(userId, groupId).length)
          throw createError({
            statusCode: 409,
            statusMessage:
              "Worker group has private image definitions. Delete them before deleting the group.",
          });
        removedEnv = await envStore.take(userId, groupId);
        try {
          const rollbackExternal = await beforeRemove?.();
          return async () => {
            await envStore.restore(userId, removedEnv);
            removedEnv = undefined;
            await rollbackExternal?.();
          };
        } catch (error) {
          await envStore.restore(userId, removedEnv);
          removedEnv = undefined;
          throw error;
        }
      },
      authorize,
    );
  } catch (error) {
    await envStore.restore(userId, removedEnv).catch(() => undefined);
    throw error;
  }
}

function safeMessage(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 300)
    : "Docker reconciliation failed";
}

async function reconcileHostMountsAfterGroupChange(userId: string) {
  const { useContainerManager } = await import("./services");
  const result = await useContainerManager().reconcileHostMountAccess(userId);
  if (result.failures.length)
    throw createError({
      statusCode: 409,
      statusMessage:
        "Worker group changed, but one or more workers with revoked host mounts could not be stopped. Rebuild or stop the affected workers immediately.",
      data: result,
    });
}
