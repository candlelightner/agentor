import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';

const MANIFEST='backup-manifest.json';
interface Manifest{version:1;workspaces:Array<{id:string;file:string}>}

export async function packWorkspaceBackups(entries:Array<{id:string;path:string}>,output:string):Promise<void>{
  if(entries.length===1){await pipeline(createReadStream(entries[0]!.path),createWriteStream(output,{mode:0o600}));return;}
  const manifest:Manifest={version:1,workspaces:entries.map(e=>({id:e.id,file:`workspaces/${e.id}.tar`}))};
  const manifestPath=`${output}.manifest`;await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  const pack=tar.pack();const done=pipeline(pack,createWriteStream(output,{mode:0o600}));
  for(const entry of [{path:manifestPath,name:MANIFEST},...entries.map(e=>({path:e.path,name:`workspaces/${e.id}.tar`}))]){const size=(await stat(entry.path)).size;await new Promise<void>((resolve,reject)=>{const target=pack.entry({name:entry.name,size},err=>err?reject(err):resolve());createReadStream(entry.path).on('error',reject).pipe(target);});}
  pack.finalize();await done;
}

export async function unpackWorkspaceBackups(input:string,workspaceIds:string[],dir:string):Promise<Array<{id:string;path:string}>>{
  await mkdir(dir,{recursive:true,mode:0o700});if(workspaceIds.length===1)return[{id:workspaceIds[0]!,path:input}];
  const extract=tar.extract();const found=new Map<string,string>();let manifest:Manifest|undefined;
  await new Promise<void>((resolve,reject)=>{extract.on('entry',(header,stream,next)=>{if(header.name===MANIFEST){const chunks:Buffer[]=[];stream.on('data',c=>chunks.push(Buffer.from(c)));stream.on('end',()=>{try{manifest=JSON.parse(Buffer.concat(chunks).toString('utf8'));next();}catch(e){reject(e);}});return;}const match=/^workspaces\/([0-9a-f-]{36})\.tar$/i.exec(header.name);if(!match||!workspaceIds.includes(match[1]!)){stream.resume();stream.on('end',next);return;}const path=join(dir,`${match[1]}.tar`);pipeline(stream,createWriteStream(path,{mode:0o600})).then(()=>{found.set(match[1]!,path);next();},reject);});extract.on('finish',resolve);extract.on('error',reject);createReadStream(input).on('error',reject).pipe(extract);});
  if(!manifest||manifest.version!==1||workspaceIds.some(id=>!found.has(id)))throw new Error('Multi-workspace backup bundle is incomplete');return workspaceIds.map(id=>({id,path:found.get(id)!}));
}
