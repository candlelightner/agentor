defineRouteMeta({ openAPI: { tags: ['Worker groups'], summary: 'List worker groups with direct active and archived member counts', operationId: 'listWorkerGroups', responses: { 200: { description: 'Groups visible to the caller, including additive direct memberCounts' } } } });
import { requireAuth } from '../../utils/auth-helpers'; import { useWorkerGroupStore, useWorkerStore } from '../../utils/services';
import { workerGroupsWithMemberCounts } from '../../utils/worker-group-response';
export default defineEventHandler((event) => {
  const { user } = requireAuth(event);
  const groups = user.role === 'admin' ? useWorkerGroupStore().list() : useWorkerGroupStore().listForUser(user.id);
  const workers = user.role === 'admin' ? useWorkerStore().list() : useWorkerStore().listForUser(user.id);
  return workerGroupsWithMemberCounts(groups, workers);
});
