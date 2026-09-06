import Docker from 'dockerode';
import { withWorkerLifecycleMutation } from './worker-lifecycle-coordinator';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { useConfig, useContainerManager, useDockerService, useStorageManager } from './services';
import { assertSafeUserId } from './user-id';
import {
  operationSettlement,
  type OperationFailureWithSettlement,
  withOperationDeadline,
} from './operation-deadline';
import { registerOperationHelper } from './operation-helper-registry';

const RESTORE_HELPER_DOCKER_TIMEOUT_MS = 30_000;

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
export async function replaceStoppedWorkspace(userId:string,workerId:string,workspaceArchive:string,signal?:AbortSignal):Promise<void>{
 return withWorkerLifecycleMutation(workerId,async()=>{
 signal?.throwIfAborted();
 assertSafeUserId(userId);
 const cm=useContainerManager(),worker=cm.get(workerId);if(!worker||worker.userId!==userId||worker.status!=='stopped')throw new Error('Original worker must be stopped for safe restore');
 const storage=useStorageManager(),config=useConfig(),source=storage.mode==='directory'?join(storage.dataRef,'users',userId,'workspaces',workerId):`${cm.buildContainerName(workerId)}-workspace`;
 const docker=new Docker({socketPath:'/var/run/docker.sock'});
 if(storage.mode==='volume')await withOperationDeadline(docker.getVolume(source).inspect(),RESTORE_HELPER_DOCKER_TIMEOUT_MS,'Docker restore-workspace volume inspection',signal);else{const st=await lstat(source);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Workspace storage is not a safe directory');}
 const image=config.workerImagePrefix+config.workerImage;await useDockerService().ensureImage(image,signal);
 const operationId=randomUUID(),helperName=`agentor-backup-restore-${operationId}`,releaseOperation=registerOperationHelper(operationId);
 const options: Docker.ContainerCreateOptions={Image:image,name:helperName,Entrypoint:['sleep'],Cmd:['120'],User:'1000:1000',Labels:{'agentor.backup-restore-helper':'true','agentor.worker-id':workerId,'agentor.helper.operation-id':operationId,'agentor.helper.owner-id':userId,'agentor.helper.created-at':new Date().toISOString()},HostConfig:{Mounts:[{Type:storage.mode==='volume'?'volume':'bind',Source:source,Target:'/target',ReadOnly:false,...(storage.mode==='volume'?{VolumeOptions:{NoCopy:true}}:{})}] as any,NetworkMode:'none',ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:32,Memory:128*1024*1024,NanoCpus:500_000_000,Init:true,Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=16777216'},LogConfig:{Type:'none',Config:{}}}};
 const cleanupNamedHelper=(name:string)=>withOperationDeadline((operationSignal)=>docker.getContainer(name).remove({force:true,abortSignal:operationSignal} as Docker.ContainerRemoveOptions&{abortSignal:AbortSignal}),RESTORE_HELPER_DOCKER_TIMEOUT_MS,'Docker restore helper cleanup').catch(()=>{});
 let helper:Docker.Container;
 try{helper=await withOperationDeadline((operationSignal)=>docker.createContainer({...options,abortSignal:operationSignal}),RESTORE_HELPER_DOCKER_TIMEOUT_MS,'Docker restore helper creation',signal);}catch(error){await cleanupNamedHelper(helperName);const settlement=(error as OperationFailureWithSettlement)?.[operationSettlement];if(settlement)void settlement.then(()=>cleanupNamedHelper(helperName));releaseOperation();throw error;}
 try{
  try { await withOperationDeadline((operationSignal)=>helper.start({abortSignal:operationSignal}),RESTORE_HELPER_DOCKER_TIMEOUT_MS,'Docker restore helper start',signal); } catch (error) {
   await withOperationDeadline((operationSignal)=>helper.remove({force:true,abortSignal:operationSignal} as Docker.ContainerRemoveOptions&{abortSignal:AbortSignal}),RESTORE_HELPER_DOCKER_TIMEOUT_MS,'Docker restore helper failed-start cleanup').catch(()=>{});
   if (!isThreadedCgroupLimitError(error)) throw error;
   const { PidsLimit, Memory, NanoCpus, ...hostConfig } = options.HostConfig!;
   const fallbackName=`${helperName}-fallback`;
   try{helper=await withOperationDeadline((operationSignal)=>docker.createContainer({...options,name:fallbackName,HostConfig:hostConfig,abortSignal:operationSignal}),RESTORE_HELPER_DOCKER_TIMEOUT_MS,'Docker restore fallback helper creation',signal);await withOperationDeadline((operationSignal)=>helper.start({abortSignal:operationSignal}),RESTORE_HELPER_DOCKER_TIMEOUT_MS,'Docker restore fallback helper start',signal);}catch(fallbackError){await cleanupNamedHelper(fallbackName);const settlement=(fallbackError as OperationFailureWithSettlement)?.[operationSettlement];if(settlement)void settlement.then(()=>cleanupNamedHelper(fallbackName));throw fallbackError;}
  }
  let result=await useDockerService().execCapture(helper.id,['python3','-c',PREPARE],{user:'agent',signal});if(result.exitCode!==0)throw new Error('Restore staging area could not be prepared');await useDockerService().putArchive(helper.id,createReadStream(workspaceArchive),`/target/${STAGE}`,signal);result=await useDockerService().execCapture(helper.id,['python3','-c',COMMIT],{user:'agent',signal});if(result.exitCode!==0)throw new Error('Workspace replacement failed and was rolled back');
 }finally{await withOperationDeadline((operationSignal)=>helper.remove({force:true,abortSignal:operationSignal} as Docker.ContainerRemoveOptions&{abortSignal:AbortSignal}),RESTORE_HELPER_DOCKER_TIMEOUT_MS,'Docker restore helper cleanup').catch(()=>{});releaseOperation();}
 });
}

function isThreadedCgroupLimitError(error: unknown): boolean {
 const message=error instanceof Error?error.message:String(error);
 return /cgroup(?:v2)?[^\n]*threaded mode|cannot enter cgroupv2[^\n]*threaded/i.test(message);
}
