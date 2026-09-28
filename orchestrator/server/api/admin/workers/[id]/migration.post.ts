import { requireAdmin } from '../../../../utils/auth-helpers';
import { isPlatformAdminUser } from '../../../../utils/auth';
import { useContainerManager } from '../../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../../utils/worker-protection-lock';
import { authorizeRuntimeSelection } from '../../../../utils/worker-runtime-admin';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

defineRouteMeta({ openAPI: { tags: ['Workers'], summary: 'Explicitly migrate a worker runtime with snapshots and rollback', operationId: 'migrateWorkerRuntime' } });
export default defineEventHandler(async (event) => {
  const { user } = requireAdmin(event);
  const id = getRouterParam(event, 'id')!;
  const body = await readBody(event) ?? {};
  if (body.runtimeProfile !== 'kata-qemu' && body.runtimeProfile !== 'legacy-runc')
    throw createError({ statusCode: 400, statusMessage: 'Select a target runtime profile' });
  if (body.confirmDowntime !== true)
    throw createError({ statusCode: 400, statusMessage: 'Migration stops the worker and copies persistent data; confirm downtime explicitly' });
  const actor = { authorize: async () => {
    if (!isPlatformAdminUser(user.id)) throw createError({ statusCode: 403, statusMessage: 'Current platform administrator required' });
    await useWorkerProtectionLockStore().verify(id, body.lockPassword);
  } };
  try {
    await actor.authorize();
    await authorizeRuntimeSelection(actor, body.runtimeProfile, body.acknowledgeHostPrivilege);
    return await useContainerManager().migrateRuntime(id, body.runtimeProfile, actor.authorize);
  } catch (error) { rethrowAsHttpError(error); }
});
