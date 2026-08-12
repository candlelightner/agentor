defineRouteMeta({ openAPI: { tags: ['Worker groups'], summary: 'Get worker group', operationId: 'getWorkerGroup' } });
import { requireAuth, requireResourceAccess } from '../../utils/auth-helpers'; import { useWorkerGroupStore } from '../../utils/services';
export default defineEventHandler((event) => { const id = getRouterParam(event, 'id')!; const group = useWorkerGroupStore().findById(id); requireAuth(event); requireResourceAccess(event, group, { allowGlobal: false }); return group; });
