import { requireAdmin } from '../../utils/auth-helpers';
import { useContainerManager } from '../../utils/services';
import { rethrowAsHttpError } from '../../utils/http-errors';

defineRouteMeta({ openAPI: { tags: ['Workers'], summary: 'List retained runtime migration journals, including workers held out of live inventory', operationId: 'listWorkerRuntimeMigrations', responses: {
  200: { description: 'Read-only recovery inventory; entries are not executable live workers' },
  401: { description: 'Unauthorized' }, 403: { description: 'Platform administrator required' },
  503: { description: 'Worker or migration journal storage unavailable; inventory is not authoritative' },
} } });
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  try { return await useContainerManager().runtimeMigrationInventory(); }
  catch (error) { rethrowAsHttpError(error); }
});
