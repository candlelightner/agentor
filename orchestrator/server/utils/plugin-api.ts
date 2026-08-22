import type { H3Event } from "h3";
import { requireResourceAccess } from "./auth-helpers";
import { assertDefinitionVisibleToWorker, definitionVisibleToPluginSelf, resourceNotFound } from "./plugin-scope";
import { useGroupAdminWorkspaceStore } from "./group-admin-workspace-store";
import type { PluginDefinitionRecord } from "./plugin-definition-store";
import type { WorkerSelfAuthority } from "./worker-auth";
import {
  useContainerManager,
  usePluginDefinitionStore,
  usePluginInstallationStore,
  usePluginRuntimeManager,
  useWorkerGroupStore,
  useWorkerStore,
} from "./services";

export function requirePluginWorker(event: H3Event, workerId: string) {
  const worker = useContainerManager().get(workerId) ?? useWorkerStore().findById(workerId);
  requireResourceAccess(event, worker, { allowGlobal: true });
  return worker!;
}

export function resolvePluginTarget(workerId: string) {
  return useContainerManager().get(workerId) ?? useWorkerStore().findById(workerId);
}

export function pluginAuthorityForTarget(worker: { id: string; userId: string; administrativeKind?: "platform" | "group" }): WorkerSelfAuthority | undefined {
  if (worker.administrativeKind === "platform") return { kind: "platform-admin", workspaceId: worker.id };
  if (worker.administrativeKind === "group") {
    const record = useGroupAdminWorkspaceStore().findByWorkspaceId(worker.id);
    return record ? { kind: "group-admin", workspaceId: worker.id, groupId: record.groupId, ownerId: record.ownerId } : undefined;
  }
  return { kind: "ordinary", userId: worker.userId, workerId: worker.id };
}

export function requireWorkerDefinition(
  worker: { id: string; userId: string; administrativeKind?: "platform" | "group" },
  id: string,
): PluginDefinitionRecord {
  const definition = usePluginDefinitionStore().getById(id);
  if (!definition) throw resourceNotFound();
  if (worker.administrativeKind) {
    const authority = pluginAuthorityForTarget(worker);
    if (!authority || !definitionVisibleToPluginSelf(definition, authority, useWorkerGroupStore())) throw resourceNotFound();
  } else assertDefinitionVisibleToWorker(definition, worker, useWorkerGroupStore());
  return definition;
}

export function requireWorkerInstallation(
  userId: string,
  workerId: string,
  id: string,
) {
  const installation = usePluginInstallationStore().getById(id);
  if (
    !installation ||
    installation.userId !== userId ||
    installation.workerId !== workerId
  )
    throw createError({
      statusCode: 404,
      statusMessage: "Plugin installation not found",
    });
  return installation;
}

export async function reconcilePluginInstallation(
  userId: string,
  workerId: string,
  id: string,
) {
  const runtime = useContainerManager().get(workerId);
  if (!runtime || runtime.status !== "running")
    return usePluginInstallationStore().getById(id);
  return usePluginRuntimeManager().reconcileInstallation(
    userId,
    id,
    runtime.containerId,
  );
}
