import { PREDEFINED_ENV_VAR_KEYS, type CreateContainerRequest, type UpdateContainerSettingsRequest } from "../../shared/types";
import {
  useContainerManager,
  useWorkerGroupStore,
  useWorkerStore,
  useUserEnvStore,
} from "./services";
import { useImageCatalogManager } from "./image-catalog";
import { useWorkerConfigStore } from "./worker-config-store";
import { workerConfigurationResponse } from "./worker-config-response";
import { useWorkerProtectionLockStore } from "./worker-protection-lock";
import { findWorkspaceInventory } from "./workspace-inventory";
import { OfflineWorkspaceAccess } from "./workspace-access";
import { assignWorkerToGroupWithNetworks, deleteWorkerGroup, updateWorkerGroupWithNetworks, withWorkerNetworkMutation } from "./worker-group-manager";
import { useGroupAdminWorkspaceStore } from "./group-admin-workspace-store";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import { markGroupEnvPending, publicGroupEnvKeys } from "./worker-group-env";
import { useWorkerGroupEnvStore } from "./services";

export interface ManagementDomainTool {
  name: string;
  group: "worker-lifecycle" | "configuration" | "groups" | "locks";
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | string>;
}

const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const GROUP_ADMIN_LIFECYCLE_TIMEOUT_DEFAULT_SECONDS = 120;
const GROUP_ADMIN_LIFECYCLE_TIMEOUT_MAX_SECONDS = 300;
const MANAGEMENT_FAIL_FAST_TIMEOUT_DEFAULT_SECONDS = 30;
const MANAGEMENT_FAIL_FAST_TIMEOUT_MAX_SECONDS = 120;
const MANAGEMENT_FAIL_FAST_TOOLS = new Set([
  "workers.env-keys",
  "groups.list", "groups.create", "groups.update", "groups.delete",
  "groups.assign-worker", "groups.env.list", "groups.env.update",
  "groups.admin-workspace.startup-script.get",
  "groups.admin-workspace.startup-script.set",
]);
const failFastTimeoutSchema = {
  type: "integer",
  minimum: 1,
  maximum: MANAGEMENT_FAIL_FAST_TIMEOUT_MAX_SECONDS,
  description: `Server-side fail-fast deadline in seconds (default ${MANAGEMENT_FAIL_FAST_TIMEOUT_DEFAULT_SECONDS}; 1-${MANAGEMENT_FAIL_FAST_TIMEOUT_MAX_SECONDS}). The MCP request returns a structured 504 error when exceeded.`,
};
const groupAdminLifecycleInput = {
  type: "object",
  additionalProperties: false,
  required: ["groupId"],
  properties: {
    groupId: { type: "string" },
    timeoutSeconds: {
      type: "integer",
      minimum: 1,
      maximum: GROUP_ADMIN_LIFECYCLE_TIMEOUT_MAX_SECONDS,
      description: `Server-side operation deadline in seconds (default ${GROUP_ADMIN_LIFECYCLE_TIMEOUT_DEFAULT_SECONDS}; 1-${GROUP_ADMIN_LIFECYCLE_TIMEOUT_MAX_SECONDS}).`,
    },
  },
};
const groupAdminStartupScriptInput = (write: boolean) => ({
  type: "object",
  additionalProperties: false,
  required: write ? ["groupId", "startupScript"] : ["groupId"],
  properties: {
    groupId: {
      type: "string",
      description: "Target worker group. Group-admin callers are restricted to their bound group and descendants.",
    },
    ...(write
      ? {
          startupScript: {
            type: "string",
            minLength: 0,
            maxLength: 65_536,
            description:
              "Non-secret shell script launched after each administrative workspace start. Empty disables it; changes apply on the next explicit start or rebuild.",
          },
        }
      : {}),
    timeoutSeconds: failFastTimeoutSchema,
  },
});

/** MCP domain adapter for ordinary worker administration. It is deliberately
 * transport-free: ManagementMcpStore can register these definitions/dispatch
 * results without duplicating HTTP routes or granting host execution. */
export class ManagementWorkerDomain {
  tools(): ManagementDomainTool[] {
    const names: Array<[string, ManagementDomainTool["group"], string, Record<string, unknown>, Record<string, boolean | string>]> = [
      ["workers.create", "worker-lifecycle", "Create a worker for an explicit owner. excludedGlobalEnvVarKeys is a names-only list of account variables the worker must not inherit; unknown names fail validation and values are never returned.", { type:"object", required:["userId"], properties:{ userId:{type:"string"}, displayName:{type:"string"}, environmentId:{type:"string"}, imageDefinitionId:{type:"string"}, imageVersion:{type:"string"}, excludedGlobalEnvVarKeys:excludedEnvKeysSchema() } }, mutation],
      ["workers.update", "worker-lifecycle", "Update worker settings. excludedGlobalEnvVarKeys completely replaces the names-only exclusion list and takes effect after rebuild; protected workers require lockPassword.", workerUpdateInput(), mutation],
      ["workers.restart", "worker-lifecycle", "Restart a worker; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.rebuild", "worker-lifecycle", "Rebuild a worker; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.archive", "worker-lifecycle", "Archive a worker; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.unarchive", "worker-lifecycle", "Unarchive a worker; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.delete", "worker-lifecycle", "Permanently delete a worker; protected workers require lockPassword.", objectWithWorker(), { ...mutation, destructiveHint:true }],
      ["workers.clone", "worker-lifecycle", "Clone workspace into a new worker; secret names are reported, never values.", objectWithWorker(), mutation],
      ["workers.env-keys", "configuration", "List predefined, configured custom account, and effective worker-group environment variable names available to this worker. Values are never returned. timeoutSeconds bounds the server-side request.", {type:"object",required:["workerId"],additionalProperties:false,properties:{workerId:{type:"string"},timeoutSeconds:failFastTimeoutSchema}}, read],
      ["configuration.get", "configuration", "Read sanitized worker configuration.", objectWithWorker(), read],
      ["configuration.set", "configuration", "Replace worker-local variables/secrets/files; secrets are write-only.", objectWithWorker(), mutation],
      ["groups.list", "groups", "List groups for an owner or all groups. timeoutSeconds bounds the server-side request.", failFastInput({userId:{type:"string"}}), read],
      ["groups.create", "groups", "Create a root or child worker group for an explicit owner. timeoutSeconds bounds hierarchy validation, persistence, and network reconciliation.", failFastInput({userId:{type:"string"},name:{type:"string"},parentId:{type:["string","null"]}}, ["userId","name"]), mutation],
      ["groups.update", "groups", "Rename, reparent, or replace same-owner direct membership, reconciling dependent managed networks. Protected workers require lockPasswords; timeoutSeconds bounds the operation.", failFastInput({groupId:{type:"string"},name:{type:"string"},parentId:{type:["string","null"]},workerIds:{type:"array",items:{type:"string"}},lockPasswords:{type:"object",additionalProperties:{type:"string",writeOnly:true}}}, ["groupId"]), mutation],
      ["groups.delete", "groups", "Delete an empty group without deleting workers. Groups referenced by managed networks must be reconfigured first; timeoutSeconds bounds the operation.", failFastInput({groupId:{type:"string"}}, ["groupId"]), { ...mutation, destructiveHint:true }],
      ["groups.assign-worker", "groups", "Atomically move one worker to a group, or set targetGroupId to null to leave it ungrouped. timeoutSeconds bounds lock checks and network reconciliation.", failFastInput({workerId:{type:"string"},targetGroupId:{type:["string","null"]},lockPasswords:{type:"object",additionalProperties:{type:"string",writeOnly:true}}}, ["workerId","targetGroupId"]), mutation],
      ["groups.env.list", "groups", "List own, inherited, excluded, and effective group environment variable names. Values are never returned; timeoutSeconds bounds the server-side request.", failFastInput({groupId:{type:"string"}}, ["groupId"]), read],
      ["groups.env.update", "groups", "Set write-only variables owned by a group, delete own keys, or replace inherited-key exclusions. Returns names only; values never appear in results or audit output. timeoutSeconds bounds authorization, persistence, and rebuild marking.", failFastInput({groupId:{type:"string"},entries:{type:"array",items:{type:"object",required:["key","value"],additionalProperties:false,properties:{key:{type:"string"},value:{type:"string",writeOnly:true}}}},deleteKeys:{type:"array",items:{type:"string"}},excludedInheritedKeys:{type:"array",items:{type:"string"}}}, ["groupId"]), mutation],
      ["groups.admin-workspace.get", "groups", "Get and reconcile the persistent administrative workspace for a worker group; returns 404 if none was provisioned. The server operation deadline defaults to 120 seconds.", groupAdminLifecycleInput, read],
      ["groups.admin-workspace.provision", "groups", "Provision or return the one persistent trusted administrative workspace for a worker group. The server operation deadline defaults to 120 seconds.", groupAdminLifecycleInput, mutation],
      ["groups.admin-workspace.start", "groups", "Provision if needed, then start a worker-group administrative workspace. The server operation deadline defaults to 120 seconds.", groupAdminLifecycleInput, mutation],
      ["groups.admin-workspace.stop", "groups", "Provision if needed, then stop a worker-group administrative workspace without deleting its workspace data. The server operation deadline defaults to 120 seconds.", groupAdminLifecycleInput, mutation],
      ["groups.admin-workspace.rebuild", "groups", "Provision if needed, then rebuild and start a worker-group administrative workspace while retaining its group binding and data. The server operation deadline defaults to 120 seconds.", groupAdminLifecycleInput, mutation],
      ["groups.admin-workspace.startup-script.get", "groups", "Read the non-secret startup script and bounded runtime status for an existing group-administrative workspace. The target must be an authorized group; timeoutSeconds bounds the request.", groupAdminStartupScriptInput(false), read],
      ["groups.admin-workspace.startup-script.set", "groups", "Set or clear the non-secret startup script for an existing group-administrative workspace. The target must be an authorized group. A running workspace is not interrupted; the next explicit start or rebuild applies the revision. timeoutSeconds bounds the request.", groupAdminStartupScriptInput(true), mutation],
      ["locks.get", "locks", "Get worker protection state without password/verifier.", objectWithWorker(), read],
      ["locks.set", "locks", "Set/change a worker protection password; values are write-only.", lockSetInput(), mutation],
      ["locks.remove", "locks", "Remove protection with its current password.", lockRemoveInput(), { ...mutation, destructiveHint:true }],
    ];
    return names.map(([name, group, description, inputSchema, annotations]) => ({ name, group, description, inputSchema, annotations }));
  }

  async execute(name: string, args: Record<string, unknown>): Promise<{ handled: boolean; result?: unknown }> {
    if (!this.tools().some(tool => tool.name === name)) return { handled:false };
    const cm = useContainerManager(); const locks = useWorkerProtectionLockStore();
    if (name === "workers.create") {
      const userId = required(args.userId, "userId");
      const catalog=useImageCatalogManager(); await catalog.init();
      const imageCatalogGroupId=optionalString(args.imageCatalogGroupId);
      const imageCatalogGroupIds=Array.isArray(args.imageCatalogGroupIds) ? strings(args.imageCatalogGroupIds,"imageCatalogGroupIds") : undefined;
      const selection=imageCatalogGroupIds
        ? catalog.resolveSelectionForGroupHierarchy(userId,imageCatalogGroupIds,optionalString(args.imageDefinitionId),optionalString(args.imageVersion))
        : imageCatalogGroupId
        ? catalog.resolveSelectionForGroup(userId,imageCatalogGroupId,optionalString(args.imageDefinitionId),optionalString(args.imageVersion))
        : catalog.resolveSelection(userId,optionalString(args.imageDefinitionId),optionalString(args.imageVersion));
      const request: CreateContainerRequest = { userId, displayName: optionalString(args.displayName), environmentId: optionalString(args.environmentId), excludedGlobalEnvVarKeys: args.excludedGlobalEnvVarKeys===undefined?undefined:strings(args.excludedGlobalEnvVarKeys,"excludedGlobalEnvVarKeys"), excludedGroupEnvVarKeys:args.excludedGroupEnvVarKeys===undefined?undefined:strings(args.excludedGroupEnvVarKeys,"excludedGroupEnvVarKeys"),targetWorkerGroupId:optionalString(args.__targetWorkerGroupId), initScript: optionalString(args.initScript), repos: array(args.repos), mounts: array(args.mounts), workerConfiguration: configInput(args.configuration), imageDefinitionId:selection?.definitionId, imageVersion:selection?.version, imageDigest:selection?.digest, imageRuntimeReference:selection?.runtimeImage } as CreateContainerRequest;
      return { handled:true, result: await cm.create(request) };
    }
    if (name.startsWith("groups.")) {
      const operation = () => this.groups(name,args);
      const result = MANAGEMENT_FAIL_FAST_TOOLS.has(name)
        ? await withinManagementFailFastDeadline(operation, managementFailFastTimeoutSeconds(args.timeoutSeconds), name)
        : await operation();
      return { handled:true, result };
    }
    const workerId = required(args.workerId, "workerId");
    const worker = cm.get(workerId) ?? useWorkerStore().findById(workerId);
    if (!worker) throw status(404,"Worker not found");
    if (name === "workers.env-keys") {
      return {handled:true,result:await withinManagementFailFastDeadline(async()=>{
        const configured=useUserEnvStore().getOrDefault(worker.userId).envVars.map(({key})=>key);
        const predefinedKeys=[...PREDEFINED_ENV_VAR_KEYS],predefined=new Set<string>(predefinedKeys);
        const customKeys=[...new Set(configured.filter(key=>!predefined.has(key)))].sort();
        const memberships=useWorkerGroupStore().listForUser(worker.userId).filter(group=>group.workerIds.includes(worker.id));
        if(memberships.length>1)throw status(409,"Worker has conflicting group memberships");
        const groupKeys=memberships[0]?(await publicGroupEnvKeys(worker.userId,memberships[0].id)).effectiveKeys:[];
        return {predefinedKeys,customKeys,keys:[...new Set([...predefinedKeys,...customKeys])],groupKeys};
      },managementFailFastTimeoutSeconds(args.timeoutSeconds),name)};
    }
    if (name === "configuration.get") return { handled:true, result: await workerConfigurationResponse(worker) };
    if (name === "locks.get") return { handled:true, result: await locks.public(workerId) };
    if (name === "locks.set") return { handled:true, result: await locks.set(workerId,args.password,args.currentPassword) };
    if (name === "locks.remove") return { handled:true, result: await locks.remove(workerId,args.password) };
    if (name === "configuration.set") {
      await locks.verify(workerId,args.lockPassword);
      const input = configInput(args); await useWorkerConfigStore().patch(worker.userId,workerId,input);
      const stored=await useWorkerStore().markPendingRebuild(worker.userId,workerId);
      if(stored){worker.pendingRebuild=true;worker.updatedAt=stored.updatedAt;}
      return { handled:true,result: await workerConfigurationResponse(worker) };
    }
    if (name === "workers.restart") { await locks.verify(workerId,args.lockPassword); await cm.restart(workerId); return {handled:true,result:{workerId,status:"running"}}; }
    await locks.verify(workerId,args.lockPassword);
    if (name === "workers.update") return {handled:true,result:await cm.updateSettings(workerId, settings(args))};
    if (name === "workers.rebuild") return {handled:true,result:await cm.rebuild(workerId)};
    if (name === "workers.archive") { await cm.archive(workerId); return {handled:true,result:{workerId,status:"archived"}}; }
    if (name === "workers.unarchive") return {handled:true,result:await cm.unarchive(worker.userId,workerId)};
    if (name === "workers.delete") { if(cm.get(workerId)) await cm.remove(workerId); else await cm.deleteArchived(worker.userId,workerId); await locks.removeForDeletedWorker(workerId); return {handled:true,result:{workerId,deleted:true}}; }
    if (name === "workers.clone") {
      const resolved = await useWorkerConfigStore().resolveValues(worker.userId, workerId);
      const variables = resolved.filter(entry => entry.kind === "variable").map(({key,value}) => ({key,value}));
      const clone = await cm.create({ userId: worker.userId, displayName: optionalString(args.displayName) || `${worker.displayName || "worker"} copy`, repos: worker.repos, mounts: worker.mounts, environmentId: worker.environmentId, initScript: worker.initScript, workerConfiguration:{variables} });
      try {
        const workspace = await findWorkspaceInventory(workerId, true);
        if (!workspace || workspace.state === "orphaned") throw status(404,"Source workspace not found");
        await new OfflineWorkspaceAccess(workspace).cloneInto(clone.containerId);
      } catch(error) { await cm.remove(clone.id).catch(() => {}); throw error; }
      return {handled:true,result:{...clone,missingSecrets:resolved.filter(entry=>entry.kind!=="variable").map(entry=>entry.key)}};
    }
    return {handled:false};
  }
  private async groups(name:string,args:Record<string,unknown>) {
    const store=useWorkerGroupStore();
    if(name==="groups.list") return args.userId ? store.listForUser(required(args.userId,"userId")) : store.list();
    if(name==="groups.create") { const userId=required(args.userId,"userId"), label=required(args.name,"name").trim(); if(!label||label.length>100) throw status(400,"Invalid group name"); const parent=args.parentId===null?null:optionalString(args.parentId); return withWorkerNetworkMutation(userId,()=>{if(typeof args.__scopeAuthorize==="function")(args.__scopeAuthorize as ()=>void)();new WorkerGroupHierarchy(store).validateParent(userId,undefined,parent);return store.create(userId,label,parent||undefined);}); }
    if(name==="groups.assign-worker") {
      const workerId=required(args.workerId,"workerId");
      const worker=useContainerManager().get(workerId)??useWorkerStore().findById(workerId);
      if(!worker)throw status(404,"Worker not found");
      const target=args.targetGroupId===null?null:required(args.targetGroupId,"targetGroupId");
      return assignWorkerToGroupWithNetworks(worker.userId,workerId,target,args.lockPasswords);
    }
    const group=store.findById(required(args.groupId,"groupId")); if(!group) throw status(404,"Worker group not found");
    if(name==="groups.env.list")return withWorkerNetworkMutation(group.userId,async()=>{if(typeof args.__scopeAuthorize==="function")(args.__scopeAuthorize as ()=>void)();return publicGroupEnvKeys(group.userId,group.id);});
    if(name==="groups.env.update")return withWorkerNetworkMutation(group.userId,async()=>{
      if(typeof args.__scopeAuthorize==="function")(args.__scopeAuthorize as ()=>void)();
      let excluded:string[]|undefined;if(args.excludedInheritedKeys!==undefined){excluded=strings(args.excludedInheritedKeys,"excludedInheritedKeys");const visible=await publicGroupEnvKeys(group.userId,group.id),inherited=new Set(visible.inheritedKeys);if(excluded.some(key=>!inherited.has(key)))throw status(400,"Unknown inherited group environment variable key");}
      const env=useWorkerGroupEnvStore();let changed=false;if(args.entries!==undefined){await env.set(group.userId,group.id,args.entries);changed=true;}if(args.deleteKeys!==undefined){await env.delete(group.userId,group.id,args.deleteKeys);changed=true;}if(excluded){await store.update(group.userId,group.id,{excludedInheritedEnvVarKeys:excluded});changed=true;}if(changed)await markGroupEnvPending(group.userId,group.id);
      return publicGroupEnvKeys(group.userId,group.id);
    });
    if(name.startsWith("groups.admin-workspace.")) {
      const workspaces=useGroupAdminWorkspaceStore();
      const authorize=typeof args.__scopeAuthorize==="function"?args.__scopeAuthorize as ()=>void:undefined;
      if(name==="groups.admin-workspace.startup-script.get") return workspaces.getStartupScript(group.id,authorize);
      if(name==="groups.admin-workspace.startup-script.set") return workspaces.setStartupScript(group.id,args.startupScript,authorize);
      const deadline=groupAdminLifecycleTimeoutSeconds(args.timeoutSeconds);
      if(name==="groups.admin-workspace.get") {
        if(!group.adminWorkspace) throw status(404,"Group administrative workspace not provisioned");
        return withinGroupAdminLifecycleDeadline(() => workspaces.ensure(group.id,group.userId,authorize), deadline);
      }
      if(name==="groups.admin-workspace.provision") return withinGroupAdminLifecycleDeadline(() => workspaces.ensure(group.id,group.userId,authorize), deadline);
      if(name==="groups.admin-workspace.start") return withinGroupAdminLifecycleDeadline(() => workspaces.setStatus(group.id,"running",authorize), deadline);
      if(name==="groups.admin-workspace.stop") return withinGroupAdminLifecycleDeadline(() => workspaces.setStatus(group.id,"stopped",authorize), deadline);
      if(name==="groups.admin-workspace.rebuild") return withinGroupAdminLifecycleDeadline(() => workspaces.rebuild(group.id,group.userId,authorize), deadline);
    }
    if(name==="groups.delete") { const workspaceStatus=group.adminWorkspace?.status;await deleteWorkerGroup(group.userId,group.id,async()=>{const workspaces=useGroupAdminWorkspaceStore();try{await workspaces.remove(group.id,true);}catch(error){await workspaces.restoreAfterFailedGroupDelete(group.id,workspaceStatus,true).catch(()=>undefined);throw error;}return async()=>workspaces.restoreAfterFailedGroupDelete(group.id,workspaceStatus,true);},typeof args.__scopeAuthorize==="function"?args.__scopeAuthorize as ()=>void:undefined); return {id:group.id,deleted:true}; }
    const patch:{name?:string;workerIds?:string[];parentId?:string|null}={}; if(args.name!==undefined){const label=required(args.name,"name").trim();if(!label||label.length>100)throw status(400,"Invalid group name");patch.name=label;}
    if(args.parentId!==undefined)patch.parentId=args.parentId===null?null:required(args.parentId,"parentId");
    if(args.workerIds!==undefined){const ids=strings(args.workerIds,"workerIds");for(const id of ids){const worker=useWorkerStore().findById(id);if(!worker||worker.userId!==group.userId)throw status(400,"All workers must belong to group owner");}patch.workerIds=ids;}
    return updateWorkerGroupWithNetworks(group.userId,group.id,patch,args.lockPasswords,typeof args.__scopeAuthorize==="function"?args.__scopeAuthorize as ()=>void:undefined);
  }
}
function objectWithWorker(){return {type:"object",required:["workerId"],properties:{workerId:{type:"string"},lockPassword:{type:"string",writeOnly:true}}};}
function failFastInput(properties:Record<string,unknown>,requiredFields?:string[]){return {type:"object",...(requiredFields?{required:requiredFields}:{}),additionalProperties:false,properties:{...properties,timeoutSeconds:failFastTimeoutSchema}};}
function excludedEnvKeysSchema(){return {type:"array",items:{type:"string"},uniqueItems:true,description:"Names of predefined or configured custom account environment variables to omit. Never accepts values."};}
function workerUpdateInput(){return {type:"object",required:["workerId"],properties:{workerId:{type:"string"},displayName:{type:"string"},environmentId:{type:"string"},initScript:{type:"string"},repos:{type:"array",items:{type:"object"}},mounts:{type:"array",items:{type:"object"}},excludedGlobalEnvVarKeys:excludedEnvKeysSchema(),excludedGroupEnvVarKeys:{...excludedEnvKeysSchema(),description:"Names of effective inherited worker-group variables to omit after rebuild. Values are never accepted."},lockPassword:{type:"string",writeOnly:true}}};}
function lockSetInput(){return {type:"object",required:["workerId","password"],properties:{workerId:{type:"string"},password:{type:"string",writeOnly:true},currentPassword:{type:"string",writeOnly:true}}};}
function lockRemoveInput(){return {type:"object",required:["workerId","password"],properties:{workerId:{type:"string"},password:{type:"string",writeOnly:true}}};}
function required(v:unknown,n:string){if(typeof v!=="string"||!v.trim())throw status(400,`${n} is required`);return v;}
function optionalString(v:unknown){return typeof v==="string"?v:undefined;}
function array(v:unknown){return Array.isArray(v)?v:undefined;}
function strings(v:unknown,n:string){if(!Array.isArray(v)||v.some(x=>typeof x!=="string"))throw status(400,`${n} must be strings`);return [...new Set(v as string[])];}
function settings(a:Record<string,unknown>):UpdateContainerSettingsRequest { const result:any={}; for(const k of ["displayName","environmentId","initScript","repos","mounts"]){if(a[k]!==undefined)result[k]=a[k];} if(a.excludedGlobalEnvVarKeys!==undefined)result.excludedGlobalEnvVarKeys=strings(a.excludedGlobalEnvVarKeys,"excludedGlobalEnvVarKeys"); if(a.excludedGroupEnvVarKeys!==undefined)result.excludedGroupEnvVarKeys=strings(a.excludedGroupEnvVarKeys,"excludedGroupEnvVarKeys"); return result; }
function configInput(value:unknown){const a=value && typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};const result:any={};for(const k of ["variables","secrets","secretFiles","envFile","deleteSecrets","deleteSecretFiles"]){if(a[k]!==undefined)result[k]=a[k];}return result;}
function status(statusCode:number,message:string){return Object.assign(new Error(message),{statusCode});}
export function managementFailFastTimeoutSeconds(value:unknown){if(value===undefined)return MANAGEMENT_FAIL_FAST_TIMEOUT_DEFAULT_SECONDS;if(!Number.isInteger(value)||(value as number)<1||(value as number)>MANAGEMENT_FAIL_FAST_TIMEOUT_MAX_SECONDS)throw status(400,`timeoutSeconds must be an integer between 1 and ${MANAGEMENT_FAIL_FAST_TIMEOUT_MAX_SECONDS}`);return value as number;}
export function withinManagementFailFastDeadline<T>(operation:()=>Promise<T>,timeoutSeconds:number,toolName:string):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;return new Promise<T>((resolve,reject)=>{timer=setTimeout(()=>reject(status(504,`${toolName} exceeded its ${timeoutSeconds} second server-side deadline`)),timeoutSeconds*1000);timer.unref?.();void operation().then(resolve,reject);}).finally(()=>{if(timer)clearTimeout(timer);});}
function groupAdminLifecycleTimeoutSeconds(value: unknown) {
  if (value === undefined) return GROUP_ADMIN_LIFECYCLE_TIMEOUT_DEFAULT_SECONDS;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > GROUP_ADMIN_LIFECYCLE_TIMEOUT_MAX_SECONDS)
    throw status(400, `timeoutSeconds must be an integer between 1 and ${GROUP_ADMIN_LIFECYCLE_TIMEOUT_MAX_SECONDS}`);
  return value as number;
}
/** Bounds only the MCP caller's wait. Dockerode does not expose cancellable
 * lifecycle operations, so a timed-out operation remains serialized by the
 * workspace store and may still finish; no later request can bypass it. */
export function withinGroupAdminLifecycleDeadline<T>(operation: () => Promise<T>, timeoutSeconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(status(504, `Group administrative workspace operation exceeded ${timeoutSeconds} seconds`)), timeoutSeconds * 1000);
    timer.unref?.();
    void operation().then(resolve, reject);
  }).finally(() => { if (timer) clearTimeout(timer); });
}
