defineRouteMeta({ openAPI: { tags: ['Containers'], summary: 'List worker plugin installations', description: 'Lists installations for one worker, including desired state, observed lifecycle state, and resource allocations. Only environment/secret key names are stored; no secret values are returned.', operationId: 'listWorkerPlugins', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID.' }], responses: { 200: { description: 'Plugin installations' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Worker not found' } } } });

import { requirePluginWorker } from "../../../../utils/plugin-api";
import { usePluginInstallationStore } from "../../../../utils/services";

export default defineEventHandler((event) => {
  const worker = requirePluginWorker(event, getRouterParam(event, "id")!);
  return usePluginInstallationStore().listForWorker(worker.userId, worker.id);
});
