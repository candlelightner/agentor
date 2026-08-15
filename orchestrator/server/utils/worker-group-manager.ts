import { createError } from "h3";
import { useManagedNetworkManager } from "./managed-network-manager";
import type { ManagedNetwork } from "./managed-network-store";
import {
  useManagedNetworkStore,
  useWorkerGroupStore,
} from "./services";
import { useImageCatalogManager } from "./image-catalog";
import type { WorkerGroup } from "./worker-group-store";
import { verifyWorkerMutationUnlocks } from "./worker-protection-lock";

type WorkerGroupPatch = Pick<Partial<WorkerGroup>, "name" | "workerIds">;
type Reconciliation = { workerIds: string[]; partialFailures: string[] };

interface GroupStoreLike {
  get(userId: string, groupId: string): WorkerGroup | undefined;
  update(userId: string, groupId: string, patch: WorkerGroupPatch): Promise<WorkerGroup>;
  remove(userId: string, groupId: string): Promise<void>;
}
interface NetworkStoreLike {
  listForUser(userId: string): ManagedNetwork[];
  get(userId: string, networkId: string): ManagedNetwork | undefined;
}
interface NetworkManagerLike {
  reconcile(network: ManagedNetwork, workerIds?: Iterable<string>): Promise<Reconciliation>;
}
export interface WorkerGroupNetworkDependencies {
  groups: GroupStoreLike;
  networks: NetworkStoreLike;
  manager: NetworkManagerLike;
  verify(workerIds: Iterable<string>, passwords: unknown): Promise<void>;
}

/** One owner-scoped queue spans group mutations and managed-network reference
 * mutations. This closes check/create and check/delete races without globally
 * serializing unrelated users. */
export class WorkerGroupNetworkCoordinator {
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: WorkerGroupNetworkDependencies = productionDependencies()) {}

  withOwner<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
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
  ) {
    return this.withOwner(userId, () =>
      this.updateLocked(userId, groupId, () => patch, lockPasswords),
    );
  }

  /** Add one worker using the membership snapshot read inside the owner queue. */
  addWorker(
    userId: string,
    groupId: string,
    workerId: string,
    lockPasswords?: unknown,
  ) {
    return this.withOwner(userId, () =>
      this.updateLocked(
        userId,
        groupId,
        (current) => ({
          workerIds: [...new Set([...current.workerIds, workerId])],
        }),
        lockPasswords,
      ),
    );
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
        throw createError({ statusCode: 404, statusMessage: "Worker group not found" });
      const patch = resolvePatch(existing);
      const previous = { name: existing.name, workerIds: [...existing.workerIds] };
      const networks = patch.workerIds === undefined
        ? []
        : this.managedNetworksForGroup(userId, groupId);

      if (patch.workerIds !== undefined && networks.length)
        await this.dependencies.verify(
          [...new Set([...previous.workerIds, ...patch.workerIds])],
          lockPasswords,
        );

      const updated = await groups.update(userId, groupId, patch);
      if (!networks.length) return updated;

      const networkIds = networks.map((network) => network.id);
      const failures = await this.reconcileAll(userId, networkIds);
      if (!failures.length) return updated;

      let storageRollbackFailure = "";
      try {
        await groups.update(userId, groupId, previous);
      } catch (error) {
        storageRollbackFailure = safeMessage(error);
      }
      // Always restore actual topology, even when persisting the previous group
      // definition fails. The explicit member override avoids consulting the
      // possibly-unrestored group record.
      const topologyRollbackFailures = await this.reconcileAll(
        userId,
        networkIds,
        previous.workerIds,
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

  delete(userId: string, groupId: string) {
    return this.withOwner(userId, async () => {
      this.assertCanDelete(userId, groupId);
      await this.dependencies.groups.remove(userId, groupId);
    });
  }

  managedNetworksForGroup(userId: string, groupId: string) {
    return this.dependencies.networks
      .listForUser(userId)
      .filter((network) => network.scope === "group" && network.groupId === groupId);
  }

  assertCanDelete(userId: string, groupId: string) {
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
        failures.push(`${networkId}: managed network disappeared during reconciliation`);
        continue;
      }
      try {
        const result = await this.dependencies.manager.reconcile(network, workerIds);
        failures.push(...result.partialFailures.map((failure) => `${network.name}: ${failure}`));
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
  };
}

let singleton: WorkerGroupNetworkCoordinator | undefined;
export function useWorkerGroupNetworkCoordinator() {
  return (singleton ??= new WorkerGroupNetworkCoordinator());
}

export function withWorkerNetworkMutation<T>(userId: string, operation: () => Promise<T>) {
  return useWorkerGroupNetworkCoordinator().withOwner(userId, operation);
}

export function updateWorkerGroupWithNetworks(
  userId: string,
  groupId: string,
  patch: WorkerGroupPatch,
  lockPasswords?: unknown,
) {
  return useWorkerGroupNetworkCoordinator().update(userId, groupId, patch, lockPasswords);
}

export function addWorkerToGroupWithNetworks(
  userId: string,
  groupId: string,
  workerId: string,
  lockPasswords?: unknown,
) {
  return useWorkerGroupNetworkCoordinator().addWorker(
    userId,
    groupId,
    workerId,
    lockPasswords,
  );
}

export async function deleteWorkerGroup(userId: string, groupId: string) {
  const catalog = useImageCatalogManager();
  await catalog.init();
  if (catalog.listForGroup(userId, groupId).length)
    throw createError({
      statusCode: 409,
      statusMessage:
        "Worker group has private image definitions. Delete them before deleting the group.",
    });
  return useWorkerGroupNetworkCoordinator().delete(userId, groupId);
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : "Docker reconciliation failed";
}
