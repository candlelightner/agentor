import { requireAdmin } from '../../../../utils/auth-helpers';
import { isPlatformAdminUser } from '../../../../utils/auth';
import { useContainerManager } from '../../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../../utils/worker-protection-lock';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

defineRouteMeta({ openAPI: { tags: ['Workers'], summary: 'Retry rollback of one interrupted runtime migration', operationId: 'recoverWorkerRuntimeMigration' } });
export default defineEventHandler(async (event) => {
  const { user } = requireAdmin(event);
  const id = getRouterParam(event, 'id')!;
  const body = await readBody(event) ?? {};
  try {
    return await useContainerManager().recoverRuntimeMigration(id, async () => {
      if (!isPlatformAdminUser(user.id)) throw createError({ statusCode: 403, statusMessage: 'Current platform administrator required' });
      await useWorkerProtectionLockStore().verify(id, body.lockPassword);
    }, body.acknowledgeDaemonOperationsSettled === true);
  } catch (error) { rethrowAsHttpError(error); }
});
