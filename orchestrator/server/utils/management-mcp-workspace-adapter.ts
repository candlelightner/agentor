/** Isolated MCP domain adapter for storage/export operations.  The transport
 * registers these definitions; this module never authorizes a caller or emits
 * a browser URL, so it is safe to reuse from the administrative identity path. */
import { listWorkspaceInventory, publicWorkspaceInventoryItem } from './workspace-inventory';
import { OfflineWorkspaceAccess } from './workspace-access';
import { useContainerManager, useExportJobManager, useWorkerStore } from './services';

const MAX_INLINE = 256 * 1024;
export const workspaceMcpTools = [
  ['workspaces.list','List offline workspaces'],['workspaces.files','List files in a workspace'],['workspaces.preview','Preview safe text/image metadata'],['workspaces.download','Prepare a download; only small regular files are returned inline'],['workspaces.clone','Clone a workspace into a new worker'],['exports.create','Create durable worker export'],['exports.status','Read export job status'],['exports.cancel','Cancel export job'],['exports.download','Describe the authenticated streaming download']
].map(([name,description])=>({name,description,inputSchema:{type:'object',properties:{workspaceId:{type:'string'},workerId:{type:'string'},path:{type:'string'},paths:{type:'array',items:{type:'string'}},jobId:{type:'string'},includeRootfs:{type:'boolean'}}}}));

function workspace(id:unknown){ return listWorkspaceInventory(true).then(all=>{const item=all.find(x=>x.id===id);if(!item||item.state==='orphaned'||item.state==='deleted')throw Object.assign(new Error('Workspace unavailable'),{statusCode:404});return item}) }
export async function executeWorkspaceMcpTool(name:string,args:Record<string,any>) : Promise<any> {
  if(name==='workspaces.list') return {workspaces:(await listWorkspaceInventory(true)).map(publicWorkspaceInventoryItem)};
  if(name==='workspaces.files'){const item=await workspace(args.workspaceId);return new OfflineWorkspaceAccess(item).list(args.path||'')}
  if(name==='workspaces.preview'){const item=await workspace(args.workspaceId);const result=await new OfflineWorkspaceAccess(item).preview(args.path);return result.kind==='text'?{kind:'text',contentType:result.contentType,size:result.size,text:result.text}:{kind:'image',contentType:result.contentType,size:result.size,downloadOnly:true}}
  if(name==='workspaces.download'){const item=await workspace(args.workspaceId), result=await new OfflineWorkspaceAccess(item).download(args.paths||[args.path]);if(result.kind!=='file'||result.entry!.size>MAX_INLINE){result.stream.destroy();return {streamingRequired:true,reason:'MCP responses never buffer directory archives or files above 256 KiB',authenticatedDownload:`/api/workspaces/${item.id}/download`}}const chunks:Buffer[]=[];for await(const chunk of result.stream)chunks.push(Buffer.from(chunk));return {name:result.entry!.name,size:result.entry!.size,base64:Buffer.concat(chunks).toString('base64')};}
  if(name==='workspaces.clone'){const item=await workspace(args.workspaceId);const worker=useWorkerStore().findById(item.workerId);if(!worker)throw Object.assign(new Error('Clone requires an existing worker record'),{statusCode:409});return {unsupported:true,reason:'Workspace clone is available through the authenticated HTTP API but is not yet safely wired to an MCP streaming/clone operation'};}
  const jobs=useExportJobManager(); if(name==='exports.create'){const worker=useContainerManager().get(args.workerId);if(!worker)throw Object.assign(new Error('Worker not found'),{statusCode:404});return jobs.create(worker.userId,worker.id,args.includeRootfs===true)} const job=await jobs.get(String(args.jobId||''));if(!job)throw Object.assign(new Error('Export job not found'),{statusCode:404});if(name==='exports.status')return jobs.toPublic(job);if(name==='exports.cancel')return jobs.cancel(job);if(name==='exports.download')return {ready:job.status==='succeeded',streamingRequired:true,authenticatedDownload:`/api/export-jobs/${job.id}/download`,filename:job.filename};throw Object.assign(new Error('Unknown workspace MCP tool'),{statusCode:404});
}
