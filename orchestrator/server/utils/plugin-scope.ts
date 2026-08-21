import type { PluginDefinitionRecord } from "./plugin-definition-store";
import type { ContainerInfo } from "../../shared/types";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import type { WorkerGroupStore } from "./worker-group-store";

export function workerDirectGroupId(
  groups: WorkerGroupStore,
  ownerId: string,
  workerId: string,
): string | undefined {
  const matches = groups
    .listForUser(ownerId)
    .filter((group) => group.workerIds.includes(workerId));
  if (matches.length > 1)
    throw Object.assign(new Error("Worker group membership is inconsistent"), {
      statusCode: 409,
    });
  return matches[0]?.id;
}

/** A definition can be installed only when its declared scope contains the
 * worker. Group definitions flow down the hierarchy; sibling and descendant
 * definitions never flow upward. */
export function definitionVisibleToWorker(
  definition: PluginDefinitionRecord,
  worker: Pick<ContainerInfo, "id" | "userId">,
  groups: WorkerGroupStore,
): boolean {
  if (definition.scope === "platform") return true;
  if (definition.userId !== worker.userId) return false;
  if (definition.scope === "owner") return true;
  if (definition.scope === "worker") return definition.workerId === worker.id;
  const direct = workerDirectGroupId(groups, worker.userId, worker.id);
  if (!direct || !definition.groupId) return false;
  return new WorkerGroupHierarchy(groups)
    .ancestors(worker.userId, direct, true)
    .some((group) => group.id === definition.groupId);
}

export function assertDefinitionVisibleToWorker(
  definition: PluginDefinitionRecord | undefined,
  worker: Pick<ContainerInfo, "id" | "userId">,
  groups: WorkerGroupStore,
): asserts definition is PluginDefinitionRecord {
  if (!definition || !definitionVisibleToWorker(definition, worker, groups))
    throw resourceNotFound();
}

export function definitionVisibleToGroupAdmin(
  definition: PluginDefinitionRecord,
  ownerId: string,
  authorityGroupId: string,
  groups: WorkerGroupStore,
): boolean {
  if (definition.scope === "platform") return true;
  if (definition.userId !== ownerId) return false;
  if (definition.scope === "owner") return true;
  const hierarchy = new WorkerGroupHierarchy(groups);
  if (definition.scope === "group") {
    if (!definition.groupId) return false;
    // Ancestor definitions are read/install-only; subtree definitions are
    // manageable. Both are visible in discovery.
    return (
      hierarchy
        .ancestors(ownerId, authorityGroupId, true)
        .some((group) => group.id === definition.groupId) ||
      hierarchy.canAdminister(ownerId, authorityGroupId, definition.groupId)
    );
  }
  const targetGroup = definition.workerId
    ? workerDirectGroupId(groups, ownerId, definition.workerId)
    : undefined;
  return Boolean(
    targetGroup &&
    hierarchy.canAdminister(ownerId, authorityGroupId, targetGroup),
  );
}

export function groupAdminCanMutateDefinition(
  definition: PluginDefinitionRecord,
  ownerId: string,
  authorityGroupId: string,
  groups: WorkerGroupStore,
): boolean {
  if (
    definition.builtIn ||
    definition.scope === "platform" ||
    definition.scope === "owner" ||
    definition.userId !== ownerId
  )
    return false;
  const hierarchy = new WorkerGroupHierarchy(groups);
  if (definition.scope === "group")
    return Boolean(
      definition.groupId &&
      hierarchy.canAdminister(ownerId, authorityGroupId, definition.groupId),
    );
  const targetGroup = definition.workerId
    ? workerDirectGroupId(groups, ownerId, definition.workerId)
    : undefined;
  return Boolean(
    targetGroup &&
    hierarchy.canAdminister(ownerId, authorityGroupId, targetGroup),
  );
}

export function resourceNotFound(): Error & { statusCode: number } {
  return Object.assign(new Error("Resource not found"), { statusCode: 404 });
}
