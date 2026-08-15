defineRouteMeta({ openAPI: { tags:["Worker groups"], summary:"List inherited group environment variable names", description:"Names and configured state only; secret values are never returned.", operationId:"getWorkerGroupEnvVarKeys" } });
import { requireResourceAccess } from "../../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../../utils/services";
import { publicGroupEnvKeys } from "../../../utils/worker-group-env";
export default defineEventHandler(async(event)=>{const id=getRouterParam(event,"id")!;const group=useWorkerGroupStore().findById(id);requireResourceAccess(event,group,{allowGlobal:false});return publicGroupEnvKeys(group!.userId,id);});
