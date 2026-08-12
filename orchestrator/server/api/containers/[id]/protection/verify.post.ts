defineRouteMeta({ openAPI: { tags:['Worker Protection'], summary:'Verify a worker protection password', operationId:'verifyWorkerProtection', responses:{200:{description:'Verification result'},423:{description:'Incorrect password'}} } });
import { requireContainerAccess } from '../../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore } from '../../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../../utils/worker-protection-lock';
export default defineEventHandler(async event => { const id=getRouterParam(event,'id')!; const worker=useContainerManager().get(id) ?? useWorkerStore().findById(id); requireContainerAccess(event, worker); const body=await readBody<any>(event); await useWorkerProtectionLockStore().verify(id, body?.password); return { workerId:id, verified:true }; });
