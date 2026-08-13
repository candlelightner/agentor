import Docker from 'dockerode';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { useConfig, useContainerManager, useDockerService, useStorageManager } from './services';
import { assertSafeUserId } from './user-id';

const STAGE='.agentor-restore-stage';const ROLLBACK='.agentor-restore-rollback';
const PREPARE=`import os,sys
r='/target'
for n in ('${STAGE}','${ROLLBACK}'):
 p=os.path.join(r,n)
 if os.path.lexists(p): raise SystemExit(2)
os.mkdir(os.path.join(r,'${STAGE}'),0o700)
`;
const COMMIT=`import os,sys,shutil
r='/target';s=os.path.join(r,'${STAGE}','workspace');b=os.path.join(r,'${ROLLBACK}')
if not os.path.isdir(s) or os.path.islink(s): raise SystemExit(3)
os.mkdir(b,0o700);moved=[];promoted=[]
try:
 for n in os.listdir(r):
  if n in ('${STAGE}','${ROLLBACK}'): continue
  os.rename(os.path.join(r,n),os.path.join(b,n));moved.append(n)
 for n in os.listdir(s):
  os.rename(os.path.join(s,n),os.path.join(r,n));promoted.append(n)
 shutil.rmtree(os.path.join(r,'${STAGE}'))
 shutil.rmtree(b)
except BaseException:
 for n in promoted:
  p=os.path.join(r,n)
  if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p,ignore_errors=True)
  else:
   try: os.unlink(p)
   except OSError: pass
 for n in moved:
  p=os.path.join(b,n)
  if os.path.lexists(p): os.rename(p,os.path.join(r,n))
 shutil.rmtree(os.path.join(r,'${STAGE}'),ignore_errors=True);shutil.rmtree(b,ignore_errors=True)
 raise
`;

/** Same-filesystem staged replacement for a stopped worker workspace. */
export async function replaceStoppedWorkspace(userId:string,workerId:string,workspaceArchive:string):Promise<void>{
 assertSafeUserId(userId);
 const cm=useContainerManager(),worker=cm.get(workerId);if(!worker||worker.userId!==userId||worker.status!=='stopped')throw new Error('Original worker must be stopped for safe restore');
 const storage=useStorageManager(),config=useConfig(),source=storage.mode==='directory'?join(storage.dataRef,'users',userId,'workspaces',workerId):`${cm.buildContainerName(workerId)}-workspace`;
 const docker=new Docker({socketPath:'/var/run/docker.sock'});
 if(storage.mode==='volume')await docker.getVolume(source).inspect();else{const st=await lstat(source);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Workspace storage is not a safe directory');}
 const image=config.workerImagePrefix+config.workerImage;await useDockerService().ensureImage(image);
 const options: Docker.ContainerCreateOptions={Image:image,name:`agentor-backup-restore-${randomUUID()}`,Entrypoint:['sleep'],Cmd:['120'],User:'1000:1000',Labels:{'agentor.backup-restore-helper':'true','agentor.worker-id':workerId},HostConfig:{Mounts:[{Type:storage.mode==='volume'?'volume':'bind',Source:source,Target:'/target',ReadOnly:false,...(storage.mode==='volume'?{VolumeOptions:{NoCopy:true}}:{})}] as any,NetworkMode:'none',ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:32,Memory:128*1024*1024,NanoCpus:500_000_000,Init:true,Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=16777216'},LogConfig:{Type:'none',Config:{}}}};
 let helper=await docker.createContainer(options);
 try{
  try { await helper.start(); } catch (error) {
   await helper.remove({force:true}).catch(()=>{});
   if (!isThreadedCgroupLimitError(error)) throw error;
   const { PidsLimit, Memory, NanoCpus, ...hostConfig } = options.HostConfig!;
   helper=await docker.createContainer({...options,name:`agentor-backup-restore-${randomUUID()}`,HostConfig:hostConfig});
   await helper.start();
  }
  let result=await useDockerService().execCapture(helper.id,['python3','-c',PREPARE],{user:'agent'});if(result.exitCode!==0)throw new Error('Restore staging area could not be prepared');await useDockerService().putArchive(helper.id,createReadStream(workspaceArchive),`/target/${STAGE}`);result=await useDockerService().execCapture(helper.id,['python3','-c',COMMIT],{user:'agent'});if(result.exitCode!==0)throw new Error('Workspace replacement failed and was rolled back');
 }finally{await helper.remove({force:true}).catch(()=>{});}
}

function isThreadedCgroupLimitError(error: unknown): boolean {
 const message=error instanceof Error?error.message:String(error);
 return /cgroup(?:v2)?[^\n]*threaded mode|cannot enter cgroupv2[^\n]*threaded/i.test(message);
}
