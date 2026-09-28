import { requireAdmin } from '../../../../utils/auth-helpers';
import { useContainerManager } from '../../../../utils/services';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

defineRouteMeta({ openAPI: { tags: ['Workers'], summary: 'Read runtime migration preflight', operationId: 'preflightWorkerRuntimeMigration' } });
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const profile = getQuery(event).runtimeProfile ?? 'kata-qemu';
  if (profile !== 'kata-qemu' && profile !== 'legacy-runc') throw createError({ statusCode: 400, statusMessage: 'Invalid runtime profile' });
  try { return await useContainerManager().preflightRuntimeMigration(getRouterParam(event, 'id')!, profile); }
  catch (error) { rethrowAsHttpError(error); }
});
