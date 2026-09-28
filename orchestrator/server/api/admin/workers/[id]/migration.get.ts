import { requireAdmin } from '../../../../utils/auth-helpers';
import { useContainerManager } from '../../../../utils/services';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

defineRouteMeta({ openAPI: { tags: ['Workers'], summary: 'Read durable runtime migration status', operationId: 'getWorkerRuntimeMigration' } });
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  try { return await useContainerManager().runtimeMigrationStatus(getRouterParam(event, 'id')!); }
  catch (error) { rethrowAsHttpError(error); }
});
