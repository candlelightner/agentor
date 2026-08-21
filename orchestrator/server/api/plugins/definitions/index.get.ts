defineRouteMeta({ openAPI: { tags: ['Plugins'], summary: 'List plugin definitions', description: 'Lists definitions visible to the signed-in user, or only definitions installable on `workerId`. Manifests contain named environment/secret references only; no secret values are returned.', operationId: 'listPluginDefinitions', parameters: [{ name: 'workerId', in: 'query', schema: { type: 'string' }, description: 'Optional worker UUID used to apply scope visibility.' }], responses: { 200: { description: 'Plugin definitions and manifests' }, 401: { description: 'Unauthorized' }, 404: { description: 'Worker not found' } } } });

import { requireAuth } from "../../../utils/auth-helpers";
import { definitionVisibleToWorker } from "../../../utils/plugin-scope";
import {
  usePluginDefinitionStore,
  useWorkerGroupStore,
  useWorkerStore,
} from "../../../utils/services";

export default defineEventHandler((event) => {
  const { user } = requireAuth(event);
  const workerId = getQuery(event).workerId;
  if (typeof workerId === "string") {
    const worker = useWorkerStore().findById(workerId);
    if (!worker || (user.role !== "admin" && worker.userId !== user.id))
      throw createError({ statusCode: 404, statusMessage: "Worker not found" });
    return usePluginDefinitionStore()
      .listForOwner(worker.userId)
      .filter((item) =>
        definitionVisibleToWorker(item, worker, useWorkerGroupStore()),
      );
  }
  return user.role === "admin"
    ? usePluginDefinitionStore().list()
    : usePluginDefinitionStore().listForOwner(user.id);
});
