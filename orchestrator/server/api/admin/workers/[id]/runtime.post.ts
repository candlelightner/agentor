import { requireAdmin } from '../../../../utils/auth-helpers';
import { isPlatformAdminUser } from '../../../../utils/auth';
import { grantLegacyWorkerRuntime, approveRestoredKataRuntime, runtimeGrantDependencies } from '../../../../utils/worker-runtime-admin';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

defineRouteMeta({ openAPI: { tags: ['Workers'], summary: 'Explicitly authorize an existing legacy worker runtime', operationId: 'authorizeLegacyWorkerRuntime' } });

export default defineEventHandler(async (event) => {
  const { user } = requireAdmin(event);
  try {
    const actor = { authorize: async () => {
      if (!isPlatformAdminUser(user.id)) throw createError({ statusCode: 403, statusMessage: 'Current platform administrator required' });
    } };
    const body = await readBody(event) ?? {};
    const id = getRouterParam(event, 'id')!;
    const deps = await runtimeGrantDependencies();
    if (body.runtimeProfile === 'kata-qemu') return await approveRestoredKataRuntime(actor, id, body.lockPassword, deps);
    if (body.runtimeProfile !== undefined && body.runtimeProfile !== 'legacy-runc')
      throw createError({ statusCode: 400, statusMessage: 'Invalid runtime profile' });
    return await grantLegacyWorkerRuntime(actor, id, body, deps);
  } catch (error) { rethrowAsHttpError(error); }
});
