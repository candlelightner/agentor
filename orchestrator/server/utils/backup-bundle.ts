import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';
import { isSafeUserId } from './user-id';
import { extractBundle, readWorkerReconstruction, type WorkerExportManifest } from './worker-export';
import {
  MAX_BUNDLE_ENTRY_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
  MAX_INNER_ARCHIVE_BYTES,
} from './worker-export';
import { readPortablePluginConfiguration, type PortablePluginConfiguration } from './plugin-portability';
import type { WorkerReconstruction } from './worker-reconstruction';

const MANIFEST='backup-manifest.json';
const MAX_MANIFEST_BYTES=1024*1024;
const MAX_MULTI_WORKSPACE_COUNT = 10_000;
const MAX_MULTI_WORKSPACE_PAYLOAD_BYTES = MAX_INNER_ARCHIVE_BYTES;
const MAX_MULTI_WORKSPACE_CONTAINER_BYTES =
  MAX_MULTI_WORKSPACE_PAYLOAD_BYTES + 64 * 1024 * 1024;
interface Manifest{version:1;workspaces:Array<{id:string;file:string}>}

export interface InspectedWorkspaceBackup {
  id: string;
  path: string;
  manifest: WorkerExportManifest;
  reconstruction?: WorkerReconstruction;
  plugins?: PortablePluginConfiguration;
}

export async function packWorkspaceBackups(entries:Array<{id:string;path:string}>,output:string):Promise<void>{
  if(!entries.length)throw new Error('At least one workspace backup is required');
  if(entries.length>MAX_MULTI_WORKSPACE_COUNT)throw new Error('Too many workspaces in one backup');
  if(new Set(entries.map(entry=>entry.id)).size!==entries.length||entries.some(entry=>!isSafeUserId(entry.id)))throw new Error('Invalid or duplicate backup workspace id');
  const sizes=new Map<string,number>();
  let totalBytes=0;
  for(const entry of entries){const info=await lstat(entry.path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Workspace backup input must be a regular file');if(info.size>MAX_BUNDLE_TOTAL_BYTES||totalBytes+info.size>MAX_MULTI_WORKSPACE_PAYLOAD_BYTES)throw new Error('Multi-workspace backup exceeds the size limit');totalBytes+=info.size;sizes.set(entry.path,info.size);}
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
  if(artifactWorkspaceIds.length>MAX_MULTI_WORKSPACE_COUNT)throw new Error('Multi-workspace backup contains too many workspaces');
  const inputInfo=await lstat(input);if(!inputInfo.isFile()||inputInfo.isSymbolicLink()||inputInfo.size>MAX_MULTI_WORKSPACE_CONTAINER_BYTES)throw new Error('Multi-workspace backup exceeds the size limit');
  await mkdir(dir,{recursive:true,mode:0o700});
  if(artifactWorkspaceIds.length===1)return[{id:selectedWorkspaceIds[0]!,path:input}];
  const extract=tar.extract();const found=new Map<string,string>();const seenEntries=new Set<string>();let manifest:Manifest|undefined;let manifestSeen=false;let entryCount=0,totalBytes=0;
  await new Promise<void>((resolve,reject)=>{let settled=false;const source=createReadStream(input);const outputs=new Set<WriteStream>();const stop=()=>{source.unpipe(extract);source.destroy();extract.destroy();for(const output of outputs)output.destroy();outputs.clear();};const fail=(error:unknown)=>{if(settled)return;settled=true;stop();reject(error);};const finish=()=>{if(settled)return;settled=true;resolve();};extract.on('entry',(header,stream,next)=>{const done=()=>{if(!settled)next();};const size=header.size;if(++entryCount>artifactWorkspaceIds.length+1||header.type!=='file'||typeof size!=='number'||!Number.isSafeInteger(size)||size<0){fail(new Error('Invalid multi-workspace backup bundle'));return;}if(header.name===MANIFEST){if(manifestSeen||size>MAX_MANIFEST_BYTES||totalBytes+size>MAX_MULTI_WORKSPACE_PAYLOAD_BYTES){fail(new Error('Invalid multi-workspace backup manifest'));return;}totalBytes+=size;manifestSeen=true;const chunks:Buffer[]=[];let bytes=0;stream.on('data',c=>{bytes+=c.length;if(bytes<=MAX_MANIFEST_BYTES)chunks.push(Buffer.from(c));else fail(new Error('Invalid multi-workspace backup manifest'));});stream.on('end',()=>{if(settled)return;try{manifest=JSON.parse(Buffer.concat(chunks).toString('utf8'));done();}catch{fail(new Error('Invalid multi-workspace backup manifest'));}});stream.on('error',fail);return;}const prefix='workspaces/',suffix='.tar';const id=header.name.startsWith(prefix)&&header.name.endsWith(suffix)?header.name.slice(prefix.length,-suffix.length):undefined;if(!id||!isSafeUserId(id)||!artifactWorkspaceIds.includes(id)||seenEntries.has(id)||size>MAX_BUNDLE_TOTAL_BYTES||totalBytes+size>MAX_MULTI_WORKSPACE_PAYLOAD_BYTES){fail(new Error('Invalid multi-workspace backup bundle'));return;}totalBytes+=size;seenEntries.add(id);if(!selectedWorkspaceIds.includes(id)){stream.resume();stream.on('end',done);stream.on('error',fail);return;}const path=join(dir,`${id}.tar`);const output=createWriteStream(path,{mode:0o600});outputs.add(output);pipeline(stream,output).then(()=>{outputs.delete(output);if(settled)return;found.set(id,path);done();},fail);});extract.on('finish',finish);extract.on('error',fail);source.on('error',fail);source.pipe(extract);});
  if(!validManifest(manifest,artifactWorkspaceIds)||artifactWorkspaceIds.some(id=>!seenEntries.has(id))||selectedWorkspaceIds.some(id=>!found.has(id)))throw new Error('Multi-workspace backup bundle is incomplete');return selectedWorkspaceIds.map(id=>({id,path:found.get(id)!}));
}

/** Inspect a decrypted provider artifact without trusting its provider name,
 * metadata, or a locally remembered workspace list.  Multi-worker wrappers
 * are validated against their own bounded manifest, then every nested worker
 * bundle goes through the ordinary hardened worker-export parser.  A raw
 * single-worker bundle follows the same parser directly. */
export async function inspectWorkspaceBackups(
  input: string,
  dir: string,
): Promise<{ multi: boolean; workspaces: InspectedWorkspaceBackup[] }> {
  const multiManifest = await readMultiManifest(input);
  if (!multiManifest) {
    const extracted = await extractBundle(input, join(dir, 'single'));
    const id = extracted.manifest.source?.id;
    if (!isSafeUserId(id)) throw new Error('Invalid backup workspace identity');
    return {
      multi: false,
      workspaces: [{
        id,
        path: input,
        manifest: extracted.manifest,
        ...(extracted.reconstructionPath
          ? { reconstruction: await readWorkerReconstruction(extracted.reconstructionPath) }
          : {}),
        ...(extracted.pluginConfigurationPath
          ? { plugins: await readPortablePluginConfiguration(extracted.pluginConfigurationPath) }
          : {}),
      }],
    };
  }
  const ids = multiManifest.workspaces.map(({ id }) => id);
  const bundles = await unpackWorkspaceBackups(input, ids, ids, join(dir, 'members'));
  const workspaces: InspectedWorkspaceBackup[] = [];
  for (const bundle of bundles) {
    const extracted = await extractBundle(bundle.path, join(dir, `inspect-${bundle.id}`));
    if (extracted.manifest.source?.id !== bundle.id)
      throw new Error('Backup workspace identity does not match its bundle path');
    workspaces.push({
      id: bundle.id,
      path: bundle.path,
      manifest: extracted.manifest,
      ...(extracted.reconstructionPath
        ? { reconstruction: await readWorkerReconstruction(extracted.reconstructionPath) }
        : {}),
      ...(extracted.pluginConfigurationPath
        ? { plugins: await readPortablePluginConfiguration(extracted.pluginConfigurationPath) }
        : {}),
    });
  }
  return { multi: true, workspaces };
}

async function readMultiManifest(input: string): Promise<Manifest | undefined> {
  const info = await lstat(input);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_MULTI_WORKSPACE_CONTAINER_BYTES
  )
    throw new Error('Backup bundle exceeds the size limit');
  const extract = tar.extract();
  let parsed: unknown;
  let manifestSeen = false;
  let sawWorkspaceMember = false;
  let sawNonMultiMember = false;
  let entryCount = 0;
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const source = createReadStream(input);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      source.destroy();
      extract.destroy();
      reject(error);
    };
    extract.on('entry', (header, stream, next) => {
      const size = header.size;
      if (
        ++entryCount > MAX_MULTI_WORKSPACE_COUNT + 1 ||
        header.type !== 'file' ||
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        totalBytes + size > MAX_MULTI_WORKSPACE_PAYLOAD_BYTES
      ) {
        fail(new Error('Invalid backup bundle size or entry count'));
        return;
      }
      totalBytes += size;
      if (header.name.startsWith('workspaces/')) {
        sawWorkspaceMember = true;
        if (size > MAX_BUNDLE_TOTAL_BYTES) {
          fail(new Error('Multi-workspace member exceeds the size limit'));
          return;
        }
      } else if (header.name !== MANIFEST) {
        sawNonMultiMember = true;
        if (size > MAX_BUNDLE_ENTRY_BYTES) {
          fail(new Error('Backup bundle entry exceeds the size limit'));
          return;
        }
      }
      if (header.name !== MANIFEST) {
        stream.on('error', fail);
        stream.on('end', next);
        stream.resume();
        return;
      }
      if (
        manifestSeen ||
        header.type !== 'file' ||
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_MANIFEST_BYTES
      ) {
        fail(new Error('Invalid multi-workspace backup manifest'));
        return;
      }
      manifestSeen = true;
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_MANIFEST_BYTES) {
          fail(new Error('Invalid multi-workspace backup manifest'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          next();
        } catch {
          fail(new Error('Invalid multi-workspace backup manifest'));
        }
      });
    });
    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    extract.on('error', fail);
    source.on('error', fail);
    source.pipe(extract);
  });
  if (!manifestSeen) {
    if (sawWorkspaceMember)
      throw new Error('Multi-workspace backup manifest is missing');
    return undefined;
  }
  if (sawNonMultiMember)
    throw new Error('Invalid multi-workspace backup bundle');
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Invalid multi-workspace backup manifest');
  const candidate = parsed as Manifest;
  const ids = Array.isArray(candidate.workspaces)
    ? candidate.workspaces.map((entry) => entry?.id)
    : [];
  if (
    candidate.version !== 1 ||
    ids.length < 2 ||
    ids.some((id) => !isSafeUserId(id)) ||
    new Set(ids).size !== ids.length ||
    !validManifest(candidate, ids as string[])
  )
    throw new Error('Invalid multi-workspace backup manifest');
  return candidate;
}

function isExactWorkspaceSubset(artifactWorkspaceIds:string[],selectedWorkspaceIds:string[]):boolean{return artifactWorkspaceIds.length>0&&new Set(artifactWorkspaceIds).size===artifactWorkspaceIds.length&&new Set(selectedWorkspaceIds).size===selectedWorkspaceIds.length&&selectedWorkspaceIds.length>0&&artifactWorkspaceIds.every(isSafeUserId)&&selectedWorkspaceIds.every(id=>artifactWorkspaceIds.includes(id));}
function validManifest(value:unknown,artifactWorkspaceIds:string[]):value is Manifest{if(!value||typeof value!=='object')return false;const manifest=value as Manifest;if(manifest.version!==1||!Array.isArray(manifest.workspaces)||manifest.workspaces.length!==artifactWorkspaceIds.length)return false;const ids=manifest.workspaces.map(entry=>entry?.id),files=manifest.workspaces.map(entry=>entry?.file);return new Set(ids).size===ids.length&&new Set(files).size===files.length&&artifactWorkspaceIds.every(id=>ids.includes(id))&&manifest.workspaces.every(entry=>isSafeUserId(entry?.id)&&entry.file===`workspaces/${entry.id}.tar`);}
