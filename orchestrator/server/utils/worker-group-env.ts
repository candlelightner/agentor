import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import { useWorkerGroupEnvStore, useWorkerGroupStore } from "./services";

export async function resolveGroupEnv(userId: string, groupId: string) {
  const groups = useWorkerGroupStore();
  const chain = new WorkerGroupHierarchy(groups).ancestors(userId, groupId, true).reverse();
  const effective = new Map<string, string>();
  let inheritedEntries: Array<{key:string;value:string}> = [];
  const ownKeys = new Map<string, string[]>();
  for (const group of chain) {
    if (group.id === groupId) inheritedEntries = [...effective].map(([key,value])=>({key,value}));
    for (const key of group.excludedInheritedEnvVarKeys ?? []) effective.delete(key);
    const own = await useWorkerGroupEnvStore().resolve(userId, group.id);
    ownKeys.set(group.id, own.map(({ key }) => key));
    for (const entry of own) effective.set(entry.key, entry.value);
  }
  return { entries: [...effective].map(([key,value])=>({key,value})), inheritedEntries, chain, ownKeys };
}

export function mergeGroupEnvLevels(levels:Array<{entries:Array<{key:string;value:string}>;excludedInheritedKeys?:string[]}>,workerExcluded:Iterable<string>=[]){const effective=new Map<string,string>();for(const level of levels){for(const key of level.excludedInheritedKeys??[])effective.delete(key);for(const {key,value} of level.entries)effective.set(key,value);}for(const key of workerExcluded)effective.delete(key);return [...effective].map(([key,value])=>({key,value}));}

export async function publicGroupEnvKeys(userId:string,groupId:string) {
  const groups=useWorkerGroupStore(),chain=new WorkerGroupHierarchy(groups).ancestors(userId,groupId,true).reverse();
  const effective=new Set<string>();let inheritedKeys:string[]=[];let own:string[]=[];
  for(const group of chain){if(group.id===groupId)inheritedKeys=[...effective].sort();for(const key of group.excludedInheritedEnvVarKeys??[])effective.delete(key);const keys=(await useWorkerGroupEnvStore().publicList(userId,group.id)).map(({key})=>key);if(group.id===groupId)own=keys;for(const key of keys)effective.add(key);}
  return {
    ownKeys: own,
    inheritedKeys,
    excludedInheritedKeys: useWorkerGroupStore().get(userId,groupId)?.excludedInheritedEnvVarKeys ?? [],
    effectiveKeys: [...effective].sort(),
  };
}

export async function markGroupEnvPending(userId:string,groupId:string){
  const {useContainerManager,useWorkerStore}=await import("./services");
  const ids=new Set(new WorkerGroupHierarchy(useWorkerGroupStore()).subtreeWorkerIds(userId,groupId));
  for(const id of ids){const live=useContainerManager().get(id);if(live){live.pendingRebuild=true;live.updatedAt=new Date().toISOString();}const record=useWorkerStore().get(userId,id);if(record){record.pendingRebuild=true;record.updatedAt=new Date().toISOString();await useWorkerStore().upsert(record);}}
}
export async function markWorkersEnvPending(userId:string,ids:Iterable<string>){const {useContainerManager,useWorkerStore}=await import("./services");for(const id of ids){const live=useContainerManager().get(id);if(live){live.pendingRebuild=true;live.updatedAt=new Date().toISOString();}const record=useWorkerStore().get(userId,id);if(record){record.pendingRebuild=true;record.updatedAt=new Date().toISOString();await useWorkerStore().upsert(record);}}}
