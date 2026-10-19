import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useContainerManager } from '../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';
import { isWorkerLifecycleMutationPending } from '../../../utils/worker-lifecycle-coordinator';
import { validateVcpuCount } from '../../../../shared/vcpu-count';

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!, manager = useContainerManager();
  const worker = manager.get(id);
  if (!worker) throw createError({ statusCode: 404, statusMessage: 'Worker not found' });
  requireContainerAccess(event, worker);
  if (isWorkerLifecycleMutationPending(id)) throw createError({ statusCode: 409, statusMessage: 'Worker operation is in progress; refresh before retrying.' });
  const body = await readBody(event);
  await useWorkerProtectionLockStore().verify(id, body?.lockPassword);
  return manager.setVcpuCount(id, validateVcpuCount(body?.vcpuCount));
});

defineRouteMeta({ openAPI: { tags: ['Containers'], summary: 'Change a stopped VM guest vCPU count or reconcile its recorded CPU operation' } });
