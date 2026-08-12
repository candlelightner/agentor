defineRouteMeta({ openAPI: { tags:['Worker Protection'], summary:'Get worker protection state', operationId:'getWorkerProtection', responses:{200:{description:'Protection state; no password or verifier is returned'}} } });
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore } from '../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';
export default defineEventHandler(async event => { const id=getRouterParam(event,'id')!; const worker=useContainerManager().get(id) ?? useWorkerStore().findById(id); requireContainerAccess(event, worker); return useWorkerProtectionLockStore().public(id); });
