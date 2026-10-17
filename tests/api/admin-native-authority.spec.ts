import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdminWorkspaceStore, type AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { GroupAdminWorkspaceStore } from '../../orchestrator/server/utils/group-admin-workspace-store';
import { validateAdminNativeState, administrativeRuntimeOwner, applyAdminNativePatch, adminNativeInstanceName } from '../../orchestrator/server/utils/admin-native-authority';
const stamp = new Date(0).toISOString();
const record = (): AdministrativeWorkspaceRecord => ({schemaVersion:1,id:randomUUID(),kind:'administrative',trusted:true,status:'stopped',createdAt:stamp,updatedAt:stamp});
const identity = (r: AdministrativeWorkspaceRecord) => ({version:1 as const,name:`agentor-admin-${r.id}`,installationId:randomUUID(),nonce:randomUUID(),overlayVersion:'6' as const,overlaySha256:'f'.repeat(64),image:{version:1 as const,sourceImageId:'sha256:'+'1'.repeat(64),recipeId:'2'.repeat(64),architecture:'amd64' as const,converterVersion:'v0.4.0',bootstrapGeneration:'3' as const,fingerprint:'3'.repeat(64)}});
test('new global administrative identity is durably native before provisioning', async () => {
 const directory=await mkdtemp(join(tmpdir(),'admin-native-'));
 try {
  const store=new AdminWorkspaceStore(directory); let calls=0;
  store.setRuntimeAdapter({ensure:async(r,ack)=>{calls++; expect(r.runtimeKind).toBe('incus-vm');
   expect(JSON.parse(await readFile(join(directory,'admin/workspace.v1.json'),'utf8')).runtimeKind).toBe('incus-vm');
   const native=identity(r); await ack!({runtimeKind:'incus-vm',nativeRuntime:native});
   expect(JSON.parse(await readFile(join(directory,'admin/workspace.v1.json'),'utf8')).nativeRuntime).toEqual(native);
  },start:async()=>{},stop:async()=>{},rebuild:async()=>{}});
  const result=await store.ensure(); expect(calls).toBe(1); expect(result.runtimeKind).toBe('incus-vm'); expect(result.nativeRuntime).toBeUndefined(); expect(store.getRecord()?.nativeRuntime).toBeTruthy();
 } finally {await rm(directory,{recursive:true,force:true});}
});
test('new group administrative identity is native before runtime admission', async () => {
 const group:any={id:randomUUID(),userId:'owner',name:'group',workerIds:[],createdAt:stamp,updatedAt:stamp};
 const store=new GroupAdminWorkspaceStore({findById:()=>structuredClone(group),list:()=>[structuredClone(group)],update:async(_owner:string,_id:string,patch:any)=>Object.assign(group,structuredClone(patch))} as any,async(_o,operation)=>operation());
 store.setRuntimeAdapter({ensure:async(r,ack)=>{expect(group.adminWorkspace.runtimeKind).toBe('incus-vm');const native=identity(r);await ack!({runtimeKind:'incus-vm',nativeRuntime:native});expect(group.adminWorkspace.nativeRuntime).toEqual(native);},start:async()=>{},stop:async()=>{},rebuild:async()=>{}});
 await store.ensure(group.id); expect(group.adminWorkspace.kind).toBe('group-administrative'); expect(group.adminWorkspace.runtimeKind).toBe('incus-vm');
});
test('legacy record remains legacy until a dedicated serialized transaction commits cutover', async()=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-native-'));const original=record();
 try {await mkdir(join(directory,'admin'));await writeFile(join(directory,'admin/workspace.v1.json'),JSON.stringify(original));
 const store=new AdminWorkspaceStore(directory);await store.init();expect(store.getRecord()?.runtimeKind).toBeUndefined();
 await store.withNativeRuntimeTransaction(async(r,ack)=>{expect(r.id).toBe(original.id);await ack({runtimeKind:'incus-vm',nativeRuntime:identity(r)});});
 expect(store.getRecord()?.id).toBe(original.id);expect(store.getRecord()?.runtimeKind).toBe('incus-vm');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('failed native acknowledgement never permits external mutation or loses exact pending commit',async()=>{
 let writes=0,mutations=0;const store=new AdminWorkspaceStore('/unused',async()=>{if(++writes===2)throw Error('disk');});
 store.setRuntimeAdapter({ensure:async(r,ack)=>{await ack!({runtimeKind:'incus-vm',nativeRuntime:identity(r)});mutations++;},start:async()=>{},stop:async()=>{},rebuild:async()=>{}});
 await expect(store.ensure()).rejects.toThrow('disk');expect(mutations).toBe(0);expect(store.getRecord()?.nativeRuntime).toBeTruthy();
});
test('native identity validation rejects forged or malformed runtime state',()=>{
 const r=record();const native=identity(r);
 for(const bad of [{...native,nonce:'bad'},{...native,image:{...native.image,sourceImageId:'tag'}},{...native,overlayVersion:'unknown'},{...native,pending:{kind:'create',operation:'/arbitrary'}}])
  expect(()=>validateAdminNativeState({...r,runtimeKind:'incus-vm',nativeRuntime:bad as any})).toThrow();
 expect(()=>validateAdminNativeState({...r,nativeRuntime:native})).toThrow();
 expect(administrativeRuntimeOwner(r).userId).toBe('__agentor_admin__');
 expect(()=>administrativeRuntimeOwner({...r,kind:'group-administrative'})).toThrow();
});
test('malformed persisted native metadata quarantines the global identity and preserves bytes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-native-'));const r=record();const bytes=JSON.stringify({...r,runtimeKind:'incus-vm',nativeRuntime:{bad:true}});
 try {await mkdir(join(directory,'admin'));const path=join(directory,'admin/workspace.v1.json');await writeFile(path,bytes);const store=new AdminWorkspaceStore(directory);await expect(store.init()).rejects.toMatchObject({statusCode:503});expect(()=>store.getRecord()).toThrow();expect(await readFile(path,'utf8')).toBe(bytes);}finally{await rm(directory,{recursive:true,force:true});}
});
test('runtime patch cannot change administrative identity, status or startup script',()=>{
 const r=record();r.startupScript='echo unchanged';const before=structuredClone(r);applyAdminNativePatch(r,{runtimeKind:'incus-vm',nativeRuntime:identity(r),id:randomUUID(),status:'running',startupScript:'bad'} as any);
 expect(r.id).toBe(before.id);expect(r.status).toBe(before.status);expect(r.startupScript).toBe(before.startupScript);
});

test('bounded legacy administrative and group IDs retain authority and deterministic bounded native names',()=>{
 for(const id of ['legacy-admin','A'.repeat(128)]){const r={...record(),id};expect(administrativeRuntimeOwner(r).id).toBe(id);expect(adminNativeInstanceName(r).length).toBeLessThanOrEqual(63);expect(adminNativeInstanceName(r)).toBe(adminNativeInstanceName(r));
 const native={...identity(r),name:adminNativeInstanceName(r)};expect(()=>validateAdminNativeState({...r,runtimeKind:'incus-vm',nativeRuntime:native})).not.toThrow();
 expect(administrativeRuntimeOwner({...r,kind:'group-administrative',ownerId:'owner',groupId:'legacy-group'} as any).groupId).toBe('legacy-group');}
 for(const id of ['../unsafe','','x'.repeat(129)])expect(()=>administrativeRuntimeOwner({...record(),id})).toThrow();
});

test('concurrent group bootstrap is singleflight and later native reads preserve in-flight record representation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-group-init-')),owner='owner',id='legacy-group';
 try{await mkdir(join(directory,'users',owner),{recursive:true});const path=join(directory,'users',owner,'worker-groups.json');const group={id,userId:owner,name:'persisted',workerIds:[],createdAt:stamp,updatedAt:stamp};await writeFile(path,JSON.stringify([group]));
 const store=new WorkerGroupStore(directory);let loads=0;const load=store.loadUser.bind(store);store.loadUser=async user=>{loads++;return load(user);};await Promise.all(Array.from({length:20},()=>store.init()));expect(loads).toBe(1);
 const workspace={...record(),id:'legacy-admin',kind:'group-administrative',ownerId:owner,groupId:id,startupScript:undefined};await store.update(owner,id,{adminWorkspace:workspace});await store.init();expect(loads).toBe(1);expect(Object.hasOwn(store.findById(id)!.adminWorkspace!,'startupScript')).toBe(true);
 const privateReader=new WorkerGroupStore(directory);await privateReader.init();expect(Object.hasOwn(privateReader.findById(id)!.adminWorkspace!,'startupScript')).toBe(false);expect(Object.hasOwn(store.findById(id)!.adminWorkspace!,'startupScript')).toBe(true);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('explicit group reload refreshes and quarantines/recoveries remain explicit after once initialization',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-group-reload-')),owner='owner',id='legacy-group';
 try{await mkdir(join(directory,'users',owner),{recursive:true});const path=join(directory,'users',owner,'worker-groups.json');const group={id,userId:owner,name:'first',workerIds:[],createdAt:stamp,updatedAt:stamp};await writeFile(path,JSON.stringify([group]));const store=new WorkerGroupStore(directory);await store.init();
 await writeFile(path,JSON.stringify([{...group,name:'changed'}]));await store.init();expect(store.findById(id)!.name).toBe('first');await store.loadUser(owner);expect(store.findById(id)!.name).toBe('changed');await writeFile(path,'{broken');await expect(store.loadUser(owner)).rejects.toBeTruthy();await store.init();expect(()=>store.listForUser(owner)).toThrow('unavailable');await writeFile(path,JSON.stringify([group]));expect(()=>store.listForUser(owner)).toThrow('unavailable');await store.loadUser(owner);expect(store.findById(id)!.name).toBe('first');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('overall group bootstrap scan failure is retryable without manufacturing healthy authority',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-group-retry-'));try{const users=join(directory,'users');await writeFile(users,'not a directory');const store=new WorkerGroupStore(directory);await expect(store.init()).rejects.toBeTruthy();await rm(users);await mkdir(users);await expect(store.init()).resolves.toBeUndefined();expect(store.list()).toEqual([]);}finally{await rm(directory,{recursive:true,force:true});}
});
