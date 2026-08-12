defineRouteMeta({ openAPI: { tags:['Worker Protection'], summary:'Remove worker protection password', operationId:'removeWorkerProtection', responses:{200:{description:'Protection state'},423:{description:'Correct password required'}} } });
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore } from '../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';
export default defineEventHandler(async event => { const id=getRouterParam(event,'id')!; const worker=useContainerManager().get(id) ?? useWorkerStore().findById(id); requireContainerAccess(event, worker); const body=await readBody<any>(event); return useWorkerProtectionLockStore().remove(id, body?.password); });
