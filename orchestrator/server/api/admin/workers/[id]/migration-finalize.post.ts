import { requireAdmin } from '../../../../utils/auth-helpers';
import { isPlatformAdminUser } from '../../../../utils/auth';
import { useContainerManager } from '../../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../../utils/worker-protection-lock';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

defineRouteMeta({ openAPI: { tags: ['Workers'], summary: 'Delete retained runtime rollback container and volume copies after validation', operationId: 'finalizeWorkerRuntimeMigration' } });
export default defineEventHandler(async (event) => {
  const { user } = requireAdmin(event);
  const id = getRouterParam(event, 'id')!;
  const body = await readBody(event) ?? {};
  if (body.confirmDeleteRollback !== true)
    throw createError({ statusCode: 400, statusMessage: 'Explicitly confirm deletion of retained rollback evidence' });
  try {
    return await useContainerManager().finalizeRuntimeMigration(id, async () => {
      if (!isPlatformAdminUser(user.id)) throw createError({ statusCode: 403, statusMessage: 'Current platform administrator required' });
      await useWorkerProtectionLockStore().verify(id, body.lockPassword);
    });
  } catch (error) { rethrowAsHttpError(error); }
});
