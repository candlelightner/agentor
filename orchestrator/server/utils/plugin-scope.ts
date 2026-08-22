import type { PluginDefinitionRecord } from "./plugin-definition-store";
import type { ContainerInfo } from "../../shared/types";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import type { WorkerGroupStore } from "./worker-group-store";
import type { WorkerSelfAuthority } from "./worker-auth";

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

/** Visibility for the plugin self-MCP. Workspace-scoped definitions are the
 * only mutable definitions an admin runtime may create or change. */
export function definitionVisibleToPluginSelf(
  definition: PluginDefinitionRecord,
  authority: WorkerSelfAuthority,
  groups: WorkerGroupStore,
): boolean {
  if (authority.kind === "ordinary") return definitionVisibleToWorker(definition, { id: authority.workerId, userId: authority.userId }, groups);
  if (definition.scope === "platform") return true;
  if (definition.scope === "owner") return false;
  if (definition.scope === "worker") return definition.workerId === authority.workspaceId && definition.userId === (authority.kind === "group-admin" ? authority.ownerId : "__agentor_admin__");
  if (authority.kind !== "group-admin" || definition.userId !== authority.ownerId || !definition.groupId) return false;
  const hierarchy = new WorkerGroupHierarchy(groups);
  return hierarchy.ancestors(authority.ownerId, authority.groupId, true).some((g) => g.id === definition.groupId)
    || hierarchy.canAdminister(authority.ownerId, authority.groupId, definition.groupId);
}

export function pluginSelfCanMutateDefinition(definition: PluginDefinitionRecord, authority: WorkerSelfAuthority): boolean {
  return !definition.builtIn && definition.scope === "worker" && definition.userId === (authority.kind === "ordinary" ? authority.userId : authority.kind === "group-admin" ? authority.ownerId : "__agentor_admin__") && definition.workerId === (authority.kind === "ordinary" ? authority.workerId : authority.workspaceId);
}

export function resourceNotFound(): Error & { statusCode: number } {
  return Object.assign(new Error("Resource not found"), { statusCode: 404 });
}
