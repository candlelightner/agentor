import { requireAdmin } from '../../utils/auth-helpers';
import { listPhysicalGpuAssignments } from '../../utils/physical-gpu-management';

defineRouteMeta({ openAPI: { tags: ['Hardware devices'], summary: 'List GPU profiles, capacities and assignments', operationId: 'listPhysicalGpuAssignments' } });
export default defineEventHandler(async event => {
  requireAdmin(event);
  return listPhysicalGpuAssignments();
});
