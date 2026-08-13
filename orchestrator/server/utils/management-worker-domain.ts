import type { CreateContainerRequest, UpdateContainerSettingsRequest } from "../../shared/types";
import {
  useContainerManager,
  useWorkerGroupStore,
  useWorkerStore,
} from "./services";
import { useImageCatalogManager } from "./image-catalog";
import { useWorkerConfigStore } from "./worker-config-store";
import { workerConfigurationResponse } from "./worker-config-response";
import { useWorkerProtectionLockStore } from "./worker-protection-lock";
import { findWorkspaceInventory } from "./workspace-inventory";
import { OfflineWorkspaceAccess } from "./workspace-access";
import { deleteWorkerGroup, updateWorkerGroupWithNetworks, withWorkerNetworkMutation } from "./worker-group-manager";

export interface ManagementDomainTool {
  name: string;
  group: "worker-lifecycle" | "configuration" | "groups" | "locks";
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | string>;
}

const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** MCP domain adapter for ordinary worker administration. It is deliberately
 * transport-free: ManagementMcpStore can register these definitions/dispatch
 * results without duplicating HTTP routes or granting host execution. */
export class ManagementWorkerDomain {
  tools(): ManagementDomainTool[] {
    const names: Array<[string, ManagementDomainTool["group"], string, Record<string, unknown>, Record<string, boolean | string>]> = [
      ["workers.create", "worker-lifecycle", "Create a worker for an explicit owner from the approved base or a built catalog version.", { type:"object", required:["userId"], properties:{ userId:{type:"string"}, displayName:{type:"string"}, environmentId:{type:"string"}, imageDefinitionId:{type:"string"}, imageVersion:{type:"string"} } }, mutation],
      ["workers.update", "worker-lifecycle", "Update material worker settings; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.restart", "worker-lifecycle", "Restart a worker; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.rebuild", "worker-lifecycle", "Rebuild a worker; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.archive", "worker-lifecycle", "Archive a worker; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.unarchive", "worker-lifecycle", "Unarchive a worker; protected workers require lockPassword.", objectWithWorker(), mutation],
      ["workers.delete", "worker-lifecycle", "Permanently delete a worker; protected workers require lockPassword.", objectWithWorker(), { ...mutation, destructiveHint:true }],
      ["workers.clone", "worker-lifecycle", "Clone workspace into a new worker; secret names are reported, never values.", objectWithWorker(), mutation],
      ["configuration.get", "configuration", "Read sanitized worker configuration.", objectWithWorker(), read],
      ["configuration.set", "configuration", "Replace worker-local variables/secrets/files; secrets are write-only.", objectWithWorker(), mutation],
      ["groups.list", "groups", "List groups for an owner or all groups.", { type:"object", properties:{userId:{type:"string"}} }, read],
      ["groups.create", "groups", "Create a worker group for an explicit owner.", { type:"object", required:["userId","name"], properties:{userId:{type:"string"},name:{type:"string"}} }, mutation],
      ["groups.update", "groups", "Rename a group or replace same-owner membership, reconciling every dependent managed network. Protected workers in the previous or requested membership require lockPasswords.", { type:"object", required:["groupId"], properties:{groupId:{type:"string"},name:{type:"string"},workerIds:{type:"array",items:{type:"string"}},lockPasswords:{type:"object",additionalProperties:{type:"string",writeOnly:true}}} }, mutation],
      ["groups.delete", "groups", "Delete a group without deleting workers. Groups referenced by managed networks must be reconfigured first.", { type:"object", required:["groupId"], properties:{groupId:{type:"string"}} }, { ...mutation, destructiveHint:true }],
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
      const selection=catalog.resolveSelection(userId,optionalString(args.imageDefinitionId),optionalString(args.imageVersion));
      const request: CreateContainerRequest = { userId, displayName: optionalString(args.displayName), environmentId: optionalString(args.environmentId), initScript: optionalString(args.initScript), repos: array(args.repos), mounts: array(args.mounts), workerConfiguration: configInput(args.configuration), imageDefinitionId:selection?.definitionId, imageVersion:selection?.version, imageDigest:selection?.digest, imageRuntimeReference:selection?.runtimeImage } as CreateContainerRequest;
      return { handled:true, result: await cm.create(request) };
    }
    if (name.startsWith("groups.")) return { handled:true, result: await this.groups(name,args) };
    const workerId = required(args.workerId, "workerId");
    const worker = cm.get(workerId) ?? useWorkerStore().findById(workerId);
    if (!worker) throw status(404,"Worker not found");
    if (name === "configuration.get") return { handled:true, result: await workerConfigurationResponse(worker) };
    if (name === "locks.get") return { handled:true, result: await locks.public(workerId) };
    if (name === "locks.set") return { handled:true, result: await locks.set(workerId,args.password,args.currentPassword) };
    if (name === "locks.remove") return { handled:true, result: await locks.remove(workerId,args.password) };
    if (name === "configuration.set") {
      await locks.verify(workerId,args.lockPassword);
      const input = configInput(args); await useWorkerConfigStore().patch(worker.userId,workerId,input);
      worker.pendingRebuild=true; const stored=useWorkerStore().findById(workerId); if(stored){stored.pendingRebuild=true;stored.updatedAt=new Date().toISOString();await useWorkerStore().upsert(stored);}
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
    if(name==="groups.create") { const userId=required(args.userId,"userId"), label=required(args.name,"name").trim(); if(!label||label.length>100) throw status(400,"Invalid group name"); return withWorkerNetworkMutation(userId,()=>store.create(userId,label)); }
    const group=store.findById(required(args.groupId,"groupId")); if(!group) throw status(404,"Worker group not found");
    if(name==="groups.delete") { await deleteWorkerGroup(group.userId,group.id); return {id:group.id,deleted:true}; }
    const patch:{name?:string;workerIds?:string[]}={}; if(args.name!==undefined){const label=required(args.name,"name").trim();if(!label||label.length>100)throw status(400,"Invalid group name");patch.name=label;}
    if(args.workerIds!==undefined){const ids=strings(args.workerIds,"workerIds");for(const id of ids){const worker=useWorkerStore().findById(id);if(!worker||worker.userId!==group.userId)throw status(400,"All workers must belong to group owner");}patch.workerIds=ids;}
    return updateWorkerGroupWithNetworks(group.userId,group.id,patch,args.lockPasswords);
  }
}
function objectWithWorker(){return {type:"object",required:["workerId"],properties:{workerId:{type:"string"},lockPassword:{type:"string",writeOnly:true}}};}
function lockSetInput(){return {type:"object",required:["workerId","password"],properties:{workerId:{type:"string"},password:{type:"string",writeOnly:true},currentPassword:{type:"string",writeOnly:true}}};}
function lockRemoveInput(){return {type:"object",required:["workerId","password"],properties:{workerId:{type:"string"},password:{type:"string",writeOnly:true}}};}
function required(v:unknown,n:string){if(typeof v!=="string"||!v.trim())throw status(400,`${n} is required`);return v;}
function optionalString(v:unknown){return typeof v==="string"?v:undefined;}
function array(v:unknown){return Array.isArray(v)?v:undefined;}
function strings(v:unknown,n:string){if(!Array.isArray(v)||v.some(x=>typeof x!=="string"))throw status(400,`${n} must be strings`);return [...new Set(v as string[])];}
function settings(a:Record<string,unknown>):UpdateContainerSettingsRequest { const result:any={}; for(const k of ["displayName","environmentId","initScript","repos","mounts"]){if(a[k]!==undefined)result[k]=a[k];} return result; }
function configInput(value:unknown){const a=value && typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};const result:any={};for(const k of ["variables","secrets","secretFiles","envFile","deleteSecrets","deleteSecretFiles"]){if(a[k]!==undefined)result[k]=a[k];}return result;}
function status(statusCode:number,message:string){return Object.assign(new Error(message),{statusCode});}
