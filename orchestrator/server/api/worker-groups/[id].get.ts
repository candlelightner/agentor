defineRouteMeta({ openAPI: { tags: ['Worker groups'], summary: 'Get worker group with direct active and archived member counts', operationId: 'getWorkerGroup' } });
import { requireAuth, requireResourceAccess } from '../../utils/auth-helpers'; import { useWorkerGroupStore, useWorkerStore } from '../../utils/services';
import { workerGroupWithMemberCounts } from '../../utils/worker-group-response';
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!;
  const group = useWorkerGroupStore().findById(id);
  requireAuth(event);
  requireResourceAccess(event, group, { allowGlobal: false });
  return workerGroupWithMemberCounts(group!, useWorkerStore().listForUser(group!.userId));
});
