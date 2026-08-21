import type { H3Event } from "h3";
import { requireResourceAccess } from "./auth-helpers";
import { assertDefinitionVisibleToWorker } from "./plugin-scope";
import {
  useContainerManager,
  usePluginDefinitionStore,
  usePluginInstallationStore,
  usePluginRuntimeManager,
  useWorkerGroupStore,
  useWorkerStore,
} from "./services";

export function requirePluginWorker(event: H3Event, workerId: string) {
  const worker = useWorkerStore().findById(workerId);
  requireResourceAccess(event, worker, { allowGlobal: true });
  return worker!;
}

export function requireWorkerDefinition(
  worker: { id: string; userId: string },
  id: string,
) {
  const definition = usePluginDefinitionStore().getById(id);
  assertDefinitionVisibleToWorker(definition, worker, useWorkerGroupStore());
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
