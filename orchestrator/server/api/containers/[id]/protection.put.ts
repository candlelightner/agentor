defineRouteMeta({ openAPI: { tags:['Worker Protection'], summary:'Set or change worker protection password', operationId:'setWorkerProtection', responses:{200:{description:'Protection state'},400:{description:'Invalid password'},423:{description:'Current password required or incorrect'}} } });
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore } from '../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';
export default defineEventHandler(async event => { const id=getRouterParam(event,'id')!; const worker=useContainerManager().get(id) ?? useWorkerStore().findById(id); requireContainerAccess(event, worker); const body=await readBody<any>(event); return useWorkerProtectionLockStore().set(id, body?.password, body?.currentPassword); });
