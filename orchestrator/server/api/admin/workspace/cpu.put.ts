import { requireAdmin } from '../../../utils/auth-helpers';
import { useAdminWorkspaceStore } from '../../../utils/admin-workspace-store';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';

export default defineEventHandler(async event => {
  requireAdmin(event);
  const store = useAdminWorkspaceStore();
  await store.init();
  const record = store.getRecord();
  if (!record) throw createError({ statusCode: 404, statusMessage: 'Administrative workspace not provisioned' });
  const body = await readBody(event);
  await useWorkerProtectionLockStore().verify(record.id, body?.lockPassword);
  return store.setCpuCount(body?.vcpuCount, record.id);
});

defineRouteMeta({ openAPI: { tags: ['Admin workspace'], summary: 'Update a stopped administrative VM vCPU count, or reconcile its pending CPU change' } });
