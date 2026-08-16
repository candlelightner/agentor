import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';
import { isSafeUserId } from './user-id';

const MANIFEST='backup-manifest.json';
const MAX_MANIFEST_BYTES=1024*1024;
interface Manifest{version:1;workspaces:Array<{id:string;file:string}>}

export async function packWorkspaceBackups(entries:Array<{id:string;path:string}>,output:string):Promise<void>{
  if(!entries.length)throw new Error('At least one workspace backup is required');
  if(new Set(entries.map(entry=>entry.id)).size!==entries.length||entries.some(entry=>!isSafeUserId(entry.id)))throw new Error('Invalid or duplicate backup workspace id');
  const sizes=new Map<string,number>();
  for(const entry of entries){const info=await lstat(entry.path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Workspace backup input must be a regular file');sizes.set(entry.path,info.size);}
  if(entries.length===1){await pipeline(createReadStream(entries[0]!.path),createWriteStream(output,{mode:0o600}));return;}
  const manifest:Manifest={version:1,workspaces:entries.map(e=>({id:e.id,file:`workspaces/${e.id}.tar`}))};
  const manifestPath=`${output}.manifest`;await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  const pack=tar.pack();const done=pipeline(pack,createWriteStream(output,{mode:0o600}));
  try{for(const entry of [{path:manifestPath,name:MANIFEST,size:Buffer.byteLength(JSON.stringify(manifest))},...entries.map(e=>({path:e.path,name:`workspaces/${e.id}.tar`,size:sizes.get(e.path)!}))])await pipeline(createReadStream(entry.path),pack.entry({name:entry.name,size:entry.size}));pack.finalize();await done;}catch(error){pack.destroy(error instanceof Error?error:undefined);await done.catch(()=>{});throw error;}
}

/**
 * Extract only an already-authorized subset. `artifactWorkspaceIds` describes
 * the outer artifact format; a one-workspace artifact is the legacy/raw worker
 * tar, while every multi-workspace artifact is a manifest-wrapped tar even
 * when only one member was selected for restore.
 */
export async function unpackWorkspaceBackups(input:string,artifactWorkspaceIds:string[],selectedWorkspaceIds:string[],dir:string):Promise<Array<{id:string;path:string}>>{
  if(!isExactWorkspaceSubset(artifactWorkspaceIds,selectedWorkspaceIds))throw new Error('Invalid backup workspace selection');
  await mkdir(dir,{recursive:true,mode:0o700});
  if(artifactWorkspaceIds.length===1)return[{id:selectedWorkspaceIds[0]!,path:input}];
  const extract=tar.extract();const found=new Map<string,string>();const seenEntries=new Set<string>();let manifest:Manifest|undefined;let manifestSeen=false;
  await new Promise<void>((resolve,reject)=>{let settled=false;const source=createReadStream(input);const outputs=new Set<WriteStream>();const stop=()=>{source.unpipe(extract);source.destroy();extract.destroy();for(const output of outputs)output.destroy();outputs.clear();};const fail=(error:unknown)=>{if(settled)return;settled=true;stop();reject(error);};const finish=()=>{if(settled)return;settled=true;resolve();};extract.on('entry',(header,stream,next)=>{const done=()=>{if(!settled)next();};if(header.name===MANIFEST){const size=header.size;if(manifestSeen||header.type!=='file'||typeof size!=='number'||!Number.isSafeInteger(size)||size<0||size>MAX_MANIFEST_BYTES){fail(new Error('Invalid multi-workspace backup manifest'));return;}manifestSeen=true;const chunks:Buffer[]=[];let bytes=0;stream.on('data',c=>{bytes+=c.length;if(bytes<=MAX_MANIFEST_BYTES)chunks.push(Buffer.from(c));else fail(new Error('Invalid multi-workspace backup manifest'));});stream.on('end',()=>{if(settled)return;try{manifest=JSON.parse(Buffer.concat(chunks).toString('utf8'));done();}catch{fail(new Error('Invalid multi-workspace backup manifest'));}});stream.on('error',fail);return;}const prefix='workspaces/',suffix='.tar';const id=header.name.startsWith(prefix)&&header.name.endsWith(suffix)?header.name.slice(prefix.length,-suffix.length):undefined;if(!id||!isSafeUserId(id)||!artifactWorkspaceIds.includes(id)||header.type!=='file'||seenEntries.has(id)){fail(new Error('Invalid multi-workspace backup bundle'));return;}seenEntries.add(id);if(!selectedWorkspaceIds.includes(id)){stream.resume();stream.on('end',done);stream.on('error',fail);return;}const path=join(dir,`${id}.tar`);const output=createWriteStream(path,{mode:0o600});outputs.add(output);pipeline(stream,output).then(()=>{outputs.delete(output);if(settled)return;found.set(id,path);done();},fail);});extract.on('finish',finish);extract.on('error',fail);source.on('error',fail);source.pipe(extract);});
  if(!validManifest(manifest,artifactWorkspaceIds)||artifactWorkspaceIds.some(id=>!seenEntries.has(id))||selectedWorkspaceIds.some(id=>!found.has(id)))throw new Error('Multi-workspace backup bundle is incomplete');return selectedWorkspaceIds.map(id=>({id,path:found.get(id)!}));
}

function isExactWorkspaceSubset(artifactWorkspaceIds:string[],selectedWorkspaceIds:string[]):boolean{return artifactWorkspaceIds.length>0&&new Set(artifactWorkspaceIds).size===artifactWorkspaceIds.length&&new Set(selectedWorkspaceIds).size===selectedWorkspaceIds.length&&selectedWorkspaceIds.length>0&&artifactWorkspaceIds.every(isSafeUserId)&&selectedWorkspaceIds.every(id=>artifactWorkspaceIds.includes(id));}
function validManifest(value:unknown,artifactWorkspaceIds:string[]):value is Manifest{if(!value||typeof value!=='object')return false;const manifest=value as Manifest;if(manifest.version!==1||!Array.isArray(manifest.workspaces)||manifest.workspaces.length!==artifactWorkspaceIds.length)return false;const ids=manifest.workspaces.map(entry=>entry?.id),files=manifest.workspaces.map(entry=>entry?.file);return new Set(ids).size===ids.length&&new Set(files).size===files.length&&artifactWorkspaceIds.every(id=>ids.includes(id))&&manifest.workspaces.every(entry=>isSafeUserId(entry?.id)&&entry.file===`workspaces/${entry.id}.tar`);}
