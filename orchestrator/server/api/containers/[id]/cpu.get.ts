import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useContainerManager } from '../../../utils/services';

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!, manager = useContainerManager();
  const worker = manager.get(id);
  if (!worker) throw createError({ statusCode: 404, statusMessage: 'Worker not found' });
  requireContainerAccess(event, worker);
  return manager.getVcpuSettings(id);
});

defineRouteMeta({ openAPI: { tags: ['Containers'], summary: 'Read actual VM vCPU count and a pending CPU change without mutating the VM' } });
