defineRouteMeta({ openAPI: { tags: ['Containers'], summary: 'Uninstall worker plugin', description: 'Stops, cleans up, releases allocations, and removes an installation from a running worker.', operationId: 'uninstallWorkerPlugin', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'installationId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Installation removed' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Worker or installation not found' }, 409: { description: 'Worker is not running or pinned definition unavailable' }, 502: { description: 'Plugin runner failed' }, 504: { description: 'Plugin lifecycle timed out' } } } });

import {
  requirePluginWorker,
  requireWorkerInstallation,
} from "../../../../utils/plugin-api";
import {
  useContainerManager,
  usePluginRuntimeManager,
} from "../../../../utils/services";

export default defineEventHandler(async (event) => {
  const worker = requirePluginWorker(event, getRouterParam(event, "id")!);
  const installation = requireWorkerInstallation(
    worker.userId,
    worker.id,
    getRouterParam(event, "installationId")!,
  );
  const runtime = useContainerManager().get(worker.id);
  if (!runtime || runtime.status !== "running")
    throw createError({
      statusCode: 409,
      statusMessage: "Worker is not running",
    });
  await usePluginRuntimeManager().uninstall(
    worker.userId,
    installation.id,
    runtime.containerId,
  );
  setResponseStatus(event, 204);
});
