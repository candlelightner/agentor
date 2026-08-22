defineRouteMeta({ openAPI: { tags: ['Worker Self'], summary: 'List installed plugins for calling worker', description: 'Source-IP-authenticated worker-self view of installed plugins. Returns lifecycle state, allocations, actions, documentation, and environment/secret key names only; secret values are never returned.', operationId: 'workerSelfListPlugins', responses: { 200: { description: 'Installed plugin summaries' }, 401: { description: 'Caller is not a recognized worker' }, 404: { description: 'Worker is unavailable' } } } });

import { requirePluginSelf } from "../../utils/worker-auth";
import { WorkerSelfPluginDomain } from "../../utils/worker-self-plugin-domain";

const domain = new WorkerSelfPluginDomain();
export default defineEventHandler(async (event) =>
  domain.invoke(await requirePluginSelf(event), "plugins.list", {}),
);
