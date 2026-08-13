/** Isolated MCP domain adapter for storage/export operations.  The transport
 * registers these definitions; this module never authorizes a caller or emits
 * a browser URL, so it is safe to reuse from the administrative identity path. */
import { listWorkspaceInventory, publicWorkspaceInventoryItem } from './workspace-inventory';
import { OfflineWorkspaceAccess } from './workspace-access';
import { useContainerManager, useExportJobManager, useWorkerStore } from './services';
import { ManagementWorkerDomain } from './management-worker-domain';

const workspaceToolEntries: Array<[string, string]> = [
  ['workspaces.list','List offline workspaces'],['workspaces.files','List files in a workspace'],['workspaces.preview','Preview safe text/image metadata'],['workspaces.download','Prepare a private one-use streaming download'],['workspaces.clone','Clone a workspace into a new worker'],['exports.create','Create durable worker export'],['exports.status','Read export job status'],['exports.cancel','Cancel export job'],['exports.download','Prepare a private one-use export artifact download']
];
export const workspaceMcpTools = workspaceToolEntries.map(([name,description])=>({name,group:(name.startsWith('exports.')?'exports':'storage') as 'exports'|'storage',description,inputSchema:{type:'object',properties:{workspaceId:{type:'string'},workerId:{type:'string'},displayName:{type:'string'},lockPassword:{type:'string',writeOnly:true,description:'Required when cloning a protected source worker'},path:{type:'string'},paths:{type:'array',items:{type:'string'}},jobId:{type:'string'},includeRootfs:{type:'boolean'}}},annotations:{readOnlyHint:/\.(list|files|preview|download|status)$/.test(name),destructiveHint:name==='exports.cancel',idempotentHint:/\.(list|files|preview|download|status)$/.test(name),openWorldHint:false}}));

function workspace(id:unknown){ return listWorkspaceInventory(true).then(all=>{const item=all.find(x=>x.id===id);if(!item||item.state==='orphaned'||item.state==='deleted')throw Object.assign(new Error('Workspace unavailable'),{statusCode:404});return item}) }
export async function executeWorkspaceMcpTool(name:string,args:Record<string,any>) : Promise<any> {
  if(name==='workspaces.list') return {workspaces:(await listWorkspaceInventory(true)).map(publicWorkspaceInventoryItem)};
  if(name==='workspaces.files'){const item=await workspace(args.workspaceId);return new OfflineWorkspaceAccess(item).list(args.path||'')}
  if(name==='workspaces.preview'){const item=await workspace(args.workspaceId);const result=await new OfflineWorkspaceAccess(item).preview(args.path);return result.kind==='text'?{kind:'text',contentType:result.contentType,size:result.size,text:result.text}:{kind:'image',contentType:result.contentType,size:result.size,downloadOnly:true}}
  if(name==='workspaces.download'||name==='exports.download')throw Object.assign(new Error('Private management download handoff is unavailable'),{statusCode:503});
  if(name==='workspaces.clone'){
    const item=await workspace(args.workspaceId);
    const worker=item.workerId ? useWorkerStore().findById(item.workerId) : undefined;
    if(!worker)throw Object.assign(new Error('Clone requires an existing worker record'),{statusCode:409});
    const executed=await new ManagementWorkerDomain().execute('workers.clone',{workerId:worker.id,displayName:args.displayName,lockPassword:args.lockPassword});
    if(!executed.handled)throw Object.assign(new Error('Workspace clone unavailable'),{statusCode:501});
    return executed.result;
  }
  const jobs=useExportJobManager(); if(name==='exports.create'){const worker=useContainerManager().get(args.workerId);if(!worker)throw Object.assign(new Error('Worker not found'),{statusCode:404});return jobs.create(worker.userId,worker.id,args.includeRootfs===true)} const job=await jobs.get(String(args.jobId||''));if(!job)throw Object.assign(new Error('Export job not found'),{statusCode:404});if(name==='exports.status')return jobs.toPublic(job);if(name==='exports.cancel')return jobs.cancel(job);throw Object.assign(new Error('Unknown workspace MCP tool'),{statusCode:404});
}
