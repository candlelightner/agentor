defineRouteMeta({
  openAPI: {
    tags: ["Account"],
    summary: "List account environment variable names without values",
    description: "Returns predefined and configured custom names available for per-worker inheritance controls. No values are returned.",
    operationId: "getAccountEnvVarKeys",
    responses: { 200: { description: "Names-only environment variable inventory" }, 401: { description: "Unauthorized" } },
  },
});
import { PREDEFINED_ENV_VAR_KEYS } from "../../../shared/types";
import { requireAuth, requireResourceAccess } from "../../utils/auth-helpers";
import { useUserEnvStore } from "../../utils/services";
import { useWorkerGroupStore, useWorkerStore } from "../../utils/services";
import { publicGroupEnvKeys } from "../../utils/worker-group-env";
export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const query=getQuery(event);let ownerId=user.id;let groupId=typeof query.groupId==="string"?query.groupId:undefined;
  if(typeof query.workerId==="string"){const worker=useWorkerStore().findById(query.workerId);if(!worker)throw createError({statusCode:404,statusMessage:"Worker not found"});requireResourceAccess(event,worker,{allowGlobal:false});ownerId=worker.userId;const memberships=useWorkerGroupStore().listForUser(ownerId).filter(group=>group.workerIds.includes(worker.id));if(memberships.length>1)throw createError({statusCode:409,statusMessage:"Worker has conflicting group memberships"});groupId=memberships[0]?.id;}
  else if(groupId){const group=useWorkerGroupStore().findById(groupId);if(!group)throw createError({statusCode:404,statusMessage:"Worker group not found"});requireResourceAccess(event,group,{allowGlobal:false});ownerId=group.userId;}
  const configured = useUserEnvStore().getOrDefault(ownerId).envVars.map(({ key }) => key);
  const predefinedKeys = [...PREDEFINED_ENV_VAR_KEYS];
  const predefined = new Set<string>(predefinedKeys);
  const customKeys = [...new Set(configured.filter((key) => !predefined.has(key)))].sort();
  let groupKeys:string[]=[];if(groupId)groupKeys=(await publicGroupEnvKeys(ownerId,groupId)).effectiveKeys;
  return { predefinedKeys, customKeys, keys: [...new Set([...predefinedKeys, ...customKeys])], groupKeys };
});
