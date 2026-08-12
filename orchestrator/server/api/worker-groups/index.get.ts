defineRouteMeta({ openAPI: { tags: ['Worker groups'], summary: 'List worker groups', operationId: 'listWorkerGroups', responses: { 200: { description: 'Groups owned by the caller' } } } });
import { requireAuth } from '../../utils/auth-helpers'; import { useWorkerGroupStore } from '../../utils/services';
export default defineEventHandler((event) => { const { user } = requireAuth(event); return user.role === 'admin' ? useWorkerGroupStore().list() : useWorkerGroupStore().listForUser(user.id); });
