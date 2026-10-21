import { requireAdmin } from '../../utils/auth-helpers';
import { getAuthDb } from '../../utils/auth';
import { setPhysicalGpuAssignment } from '../../utils/physical-gpu-management';

defineRouteMeta({ openAPI: { tags: ['Hardware devices'], summary: 'Assign or release an NVIDIA GPU on a stopped VM', operationId: 'setPhysicalGpuAssignment' } });
export default defineEventHandler(async event => {
  requireAdmin(event);
  const body = await readBody(event);
  return setPhysicalGpuAssignment(body?.deviceId, body?.workerId,
    async () => {
      const { user } = requireAdmin(event);
      const current = getAuthDb().prepare('SELECT role FROM user WHERE id = ?').get(user.id) as { role?: string } | undefined;
      if (current?.role !== 'admin') throw createError({ statusCode: 403, statusMessage: 'Platform administrator authority is no longer valid' });
    }, body?.lockPassword);
});
