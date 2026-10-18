import { expect, test } from '@playwright/test';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ADMIN_DR_FLAG, requireAdminDrFixture, adminDrConfig, assertAdminDrPackage, AdminDrHttp, adminDrDigest,
  type AdminDrFixture, type AdminDrSide, ADMIN_DR_SAMPLE_SCRIPT, adminDrSampleContent, parseAdminDrJson } from '../helpers/private-admin-native-dr-fixture';
import { readPrivateNativeDrFile } from '../helpers/private-native-dr-fixture';
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
import type { StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';

const pause = () => new Promise(resolve => setTimeout(resolve, 2000));
const options = { includeWorkers:true,includeAgentData:true,includeDockerVolumes:true,includeLogs:false,includeLocalBackups:false };

interface State { records:AdministrativeWorkspaceRecord[]; managed:StoredManagedVolume[]; shadow:string }
interface Evidence { version:1; artifactId:string; artifactSha256:string; artifactBytes:number; helperSha256:string;
  state:State; samples:Record<string,unknown>; manifest:any }

async function state(f:AdminDrFixture,side:AdminDrSide):Promise<State> {
  const { readInstanceAdministrativeRecords } = await import('../../orchestrator/server/utils/instance-restore-administrative');
  const { ManagedVolumeStore } = await import('../../orchestrator/server/utils/managed-volume-store');
  const config=adminDrConfig(f,side), records=await readInstanceAdministrativeRecords(config.dataDir);
  expect(records.map(r=>r.id).sort()).toEqual([f.receipt.globalId,f.receipt.groupAdminId].sort());
  for(const r of records) {
    expect(r.trusted).toBe(true);expect(r.runtimeKind).toBe('incus-vm');
    if(r.kind==='group-administrative')expect(r.ownerId).toBe(f.receipt.source.ownerId);
    else expect([undefined,f.receipt.source.ownerId]).toContain(r.ownerId);
    expect(r.kind).toBe(r.id===f.receipt.globalId?'administrative':'group-administrative');
    expect('groupId' in r ? r.groupId : undefined).toBe(r.id===f.receipt.globalId?undefined:f.receipt.groupId);
    expect(r.nativeRuntime?.storageInitialized).toBe(true); expect(r.nativeRuntime?.storageReady).toBe(true);
    expect(r.nativeRuntime?.pending).toBeUndefined();expect(r.nativeRuntime?.selectedOperation).toBeUndefined();expect(r.nativeRuntime?.deleting).toBeUndefined();
  }
  const store=new ManagedVolumeStore(config.dataDir);await store.init();
  await store.loadUser(f.receipt.source.ownerId);await store.loadUser('__agentor_admin__');
  const managed=store.list();expect(managed).toHaveLength(4);
  for(const r of records) {
    const rows=managed.filter(v=>v.workerId===r.id);
    expect(rows.map(v=>[v.attached,v.target]).sort()).toEqual([[false,'/srv/native-dr-detached'],[true,'/srv/native-dr-attached']].sort());
    for(const v of rows) {
      expect(v.userId).toBe(r.kind==='administrative'?'__agentor_admin__':f.receipt.source.ownerId);
      expect(v.storageRuntimeKind).toBe('incus-vm');expect(v.purpose).toBe('persistent-path');expect(v.seeded).toBe(true);
      expect(v.state).toBe(v.attached?'ready':'detached');expect(v.dockerName).toBe('agentor-persist-'+v.id);
      expect(v.incusLive).toBeUndefined();expect(v.liveContainerId).toBeUndefined();
    }
    expect(r.nativeRuntime!.selectedVolumeIds).toEqual(rows.filter(v=>v.attached).map(v=>v.id));
  }
  const shadow=await readPrivateNativeDrFile(join(config.dataDir,'users',f.receipt.source.ownerId,'workers.json'),1024*1024);
  const rows=parseAdminDrJson(shadow);expect(Array.isArray(rows)).toBe(true);
  expect(rows.map((r:any)=>[r.id,r.status]).sort()).toEqual([[f.receipt.globalId,'archived'],[f.receipt.groupAdminId,'archived']].sort());
  return {records:records.sort((a,b)=>a.id.localeCompare(b.id)),managed:managed.sort((a,b)=>a.id.localeCompare(b.id)),shadow};
}
async function native(f:AdminDrFixture,side:AdminDrSide) {
  const { IncusClient }=await import('../../orchestrator/server/utils/incus-client');
  const config=adminDrConfig(f,side),client=IncusClient.fromConfig(config),ready=await client.getReadiness();
  expect(ready).toMatchObject({ready:true,auth:'trusted',project:config.incusProject});
  const project=await client.request<any>('GET','/1.0/projects/'+config.incusProject);
  expect(project.config).toMatchObject({restricted:'true','features.storage.volumes':'true','features.networks':'false'});
  expect((await client.getImageAlias(config.incusWorkerImage)).target).toBe(f.receipt.nativeFingerprint);
  return {config,client};
}
async function samples(f:AdminDrFixture,side:AdminDrSide,current:State):Promise<Record<string,unknown>> {
  const {config,client}=await native(f,side);
  const {IncusOfflineArchiveHelper}=await import('../../orchestrator/server/utils/incus-offline-archive-helper');
  const {administrativeArchiveHelperOwner}=await import('../../orchestrator/server/utils/incus-admin-backup');
  const {administrativeRuntimeOwner}=await import('../../orchestrator/server/utils/admin-native-identity');
  const {IncusAdminWorkspaceStorage}=await import('../../orchestrator/server/utils/incus-admin-workspace-storage');
  const {ManagedVolumeStore}=await import('../../orchestrator/server/utils/managed-volume-store');
  const output:Record<string,unknown>={};
  for(const r of current.records) {
    expect(r.status).toBe('stopped');const n=r.nativeRuntime!,owner=administrativeRuntimeOwner(r);
    const storage=new IncusAdminWorkspaceStorage(config,client,async()=>{const s=new ManagedVolumeStore(config.dataDir);await s.init();return s;});
    const roots=[{role:'workspace',name:n.name+'-workspace',metadata:storage.metadata(r,n,'workspace')},
      {role:'agents',name:n.name+'-agents',metadata:storage.metadata(r,n,'agents')}];
    const selected=current.managed.filter(v=>v.workerId===r.id);
    for(const item of [...roots,...selected.map(v=>({role:v.attached?'attached':'detached',name:v.dockerName,
      metadata:{'user.agentor.installation':n.installationId,'user.agentor.owner':owner.userId,'user.agentor.id':r.id,
        'user.agentor.volume-id':v.id,'user.agentor.target':v.target}}))]) {
      const baseline=await client.getCustomVolume(config.incusStoragePool,item.name);
      expect(baseline).toMatchObject({name:item.name,type:'custom',content_type:'filesystem',project:config.incusProject,config:item.metadata});
      const expected=n.incarnation && item.role!=='detached' ? ['/1.0/instances/'+n.name+'?project='+config.incusProject] : [];
      expect(baseline.used_by).toEqual(expected);
      const proof=async(helper?:string)=>{
        expect(await state(f,side)).toEqual(current);
        const volume=await client.getCustomVolume(config.incusStoragePool,item.name);
        expect({...volume,used_by:undefined}).toEqual({...baseline,used_by:undefined});
        expect([...volume.used_by].sort()).toEqual([...expected,...(helper?['/1.0/instances/'+helper+'?project='+config.incusProject]:[])].sort());
      };
      const core=item.role==='workspace'||item.role==='agents';
      // The established helper mounts both canonical roots; prove both below.
      const other=core?await client.getCustomVolume(config.incusStoragePool,n.name+(item.role==='workspace'?'-agents':'-workspace')):undefined;
      if(other)expect(other).toMatchObject({name:n.name+(item.role==='workspace'?'-agents':'-workspace'),type:'custom',content_type:'filesystem',project:config.incusProject,
        config:storage.metadata(r,n,item.role==='workspace'?'agents':'workspace'),used_by:expected});
      const validate=async(helper?:string)=>{
        await proof(helper);
        if(other){const value=await client.getCustomVolume(config.incusStoragePool,other.name);
          expect({...value,used_by:undefined}).toEqual({...other,used_by:undefined});
          expect([...value.used_by].sort()).toEqual([...other.used_by,...(helper?['/1.0/instances/'+helper+'?project='+config.incusProject]:[])].sort());}
      };
      await new IncusOfflineArchiveHelper(config,client,n.installationId).withGuest(administrativeArchiveHelperOwner(r),
        core?{workspace:n.name+'-workspace',agents:n.name+'-agents'}:{managed:item.name},validate,undefined,async(name,assertHelper)=>{
          await assertHelper();await validate(name);
          const path=item.role==='workspace'?'/workspace':item.role==='agents'?'/home/agent/.agent-data':'/volume';
          const result=await client.exec(name,['timeout','30','python3','-c',ADMIN_DR_SAMPLE_SCRIPT,path],{command:[],user:0,group:0});
          expect(result.returnCode).toBe(0);expect(Buffer.byteLength(result.stdout)).toBeLessThan(8192);
          const value=JSON.parse(result.stdout);expect(value.sha256).toBe(adminDrDigest(adminDrSampleContent(r.id,item.role)));expect(value.xattr).toBe('00ff800a3d00');expect(value.symlink).toBe('data.bin');
          expect(value.file).toMatchObject({uid:12345,gid:23456,mode:0o640,mtimeNs:'1234567890000000000'});
          expect(value.root).toMatchObject({uid:12343,gid:23454,mode:0o751,mtimeNs:'1234567891000000000'});
          output[r.id+':'+item.role]=value;await assertHelper();await validate(name);
        });
      await validate();
    }
  }
  expect(Object.keys(output)).toHaveLength(8);return output;
}
async function waitJob(http:AdminDrHttp,id:string):Promise<any> {
  expect(id).toMatch(/^[a-f0-9-]{36}$/);const until=Date.now()+45*60_000;
  while(Date.now()<until){const job=await http.json('/api/admin/instance-backups/jobs/'+id);
    if(job.status==='succeeded')return job;
    if(['failed','cancelled'].includes(job.status))throw new Error('Administrative DR job '+job.status+' ('+(job.errorCode??'no code')+')');
    await pause();}
  throw new Error('Administrative DR job did not settle');
}
async function readArtifact(path:string):Promise<Buffer> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const info=await file.stat();if(!info.isFile()||info.uid!==0||(info.mode&0o077)||info.size<1||info.size>512*1024*1024)throw Error('Invalid private encrypted artifact');return await file.readFile();}
  finally{await file.close();}
}
async function evidence(f:AdminDrFixture):Promise<Evidence> {
  const v=parseAdminDrJson(await readPrivateNativeDrFile(join(f.vm.root,'admin-dr-source.json'),2*1024*1024)) as Evidence;
  expect(v.version).toBe(1);expect(v.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(v.state.records.map(r=>r.id).sort()).toEqual([f.receipt.globalId,f.receipt.groupAdminId].sort());
  const bytes=await readArtifact(join(f.vm.root,'admin-instance.backup'));
  expect(bytes.length).toBe(v.artifactBytes);expect(adminDrDigest(bytes)).toBe(v.artifactSha256);
  return v;
}
async function capture(f:AdminDrFixture) {
  const packaged=await assertAdminDrPackage(f,'source',false),http=new AdminDrHttp('source');await http.login(f.receipt.source);
  const before=await state(f,'source');for(const r of before.records){expect(r.nativeRuntime!.incarnation).toMatch(/^[a-f0-9-]{36}$/);expect(r.nativeRuntime!.image.fingerprint).toBe(f.receipt.nativeFingerprint);}
  const {client}=await native(f,'source'),compute=await client.listInstances();
  expect(compute.map(v=>v.name).sort()).toEqual(before.records.map(r=>r.nativeRuntime!.name).sort());
  for(const r of before.records){const vm=compute.find(v=>v.name===r.nativeRuntime!.name)!;expect(vm.status).toBe('Stopped');expect(vm.config['volatile.uuid']).toBe(r.nativeRuntime!.incarnation);}
  const expected=await samples(f,'source',before);
  const accepted=await http.json('/api/admin/instance-backups','POST',{provider:'local',options});
  const job=await waitJob(http,accepted.jobId);
  const artifact=await http.json('/api/admin/instance-backups/artifacts/'+(job.artifactId??job.id));
  expect(artifact.formatVersion).toBe(2);expect(artifact.manifest.volumes).toHaveLength(8);
  expect(artifact.manifest.volumes.every((v:any)=>v.runtime?.administrative&&['workspace','agents','managed'].includes(v.runtime.role))).toBe(true);
  const bytes=await http.request('/api/admin/instance-backups/artifacts/'+artifact.id+'/download');
  const {inspectInstanceBackup}=await import('../../orchestrator/server/utils/instance-backup-crypto');
  await writeFile(join(f.vm.root,'admin-instance.backup'),bytes,{flag:'wx',mode:0o600});
  const header=await inspectInstanceBackup(join(f.vm.root,'admin-instance.backup'));
  const kit=await http.json('/api/backups/recovery-key/export','POST',{password:f.receipt.source.password});
  expect(header.keyFingerprint).toBe(kit.fingerprint);
  await writeFile(join(f.vm.root,'admin-dr-recovery-kit.json'),JSON.stringify(kit),{flag:'wx',mode:0o600});
  const result:Evidence={version:1,artifactId:artifact.id,artifactSha256:adminDrDigest(bytes),artifactBytes:bytes.length,
    helperSha256:packaged.helperSha256,state:before,samples:expected,manifest:artifact.manifest};
  expect(await state(f,'source')).toEqual(before);expect(await client.listInstances()).toEqual(compute);
  await writeFile(join(f.vm.root,'admin-dr-source.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
}
async function restore(f:AdminDrFixture) {
  await assertAdminDrPackage(f,'recovery',true);const expected=await evidence(f),http=new AdminDrHttp('recovery');
  const {client,config}=await native(f,'recovery');expect(await client.listInstances()).toEqual([]);expect(await client.listCustomVolumes(config.incusStoragePool)).toEqual([]);
  await http.login(f.receipt.recovery);
  const kit=parseAdminDrJson(await readPrivateNativeDrFile(join(f.vm.root,'admin-dr-recovery-kit.json'),16384));
  await http.json('/api/backups/recovery-key/import','POST',{kit});
  const bytes=await readArtifact(join(f.vm.root,'admin-instance.backup'));
  const imported=parseAdminDrJson((await http.request('/api/admin/instance-backups/import','POST',undefined,bytes)).toString());
  const verified=await waitJob(http,imported.jobId),artifactId=verified.artifactId;
  expect(artifactId).toMatch(/^[a-f0-9-]{36}$/);
  const artifact=await http.json('/api/admin/instance-backups/artifacts/'+artifactId);expect(artifact.manifest).toEqual(expected.manifest);
  const preflight=await http.json('/api/admin/instance-backups/artifacts/'+artifactId+'/preflight?restoreDockerVolumes=true');
  expect(preflight.ready).toBe(true);expect(preflight.blockers).toEqual([]);
  const accepted=await http.json('/api/admin/instance-backups/artifacts/'+artifactId+'/restore','POST',{options:{restoreDockerVolumes:true,restoreHostMountPolicies:false,confirmReplaceControlPlane:true,confirmExternalDependencies:true}});
  const until=Date.now()+45*60_000;let settled=false;
  while(Date.now()<until){
    // The helper replaces authentication and stops the server; read only its durable private job ledger during handoff.
    try{const ledger=parseAdminDrJson(await readPrivateNativeDrFile(join(config.dataDir,'admin','instance-backups.v1.json'),32*1024*1024));
      const job=ledger.jobs?.find((v:any)=>v.id===accepted.jobId);
      if(job?.status==='succeeded'){expect(job.userId).toBe(f.receipt.source.ownerId);settled=true;break;}
      if(job&&['failed','cancelled'].includes(job.status))throw Error('Administrative restore terminal failure '+(job.errorCode??''));
    }catch(error:any){if(error.code!=='ENOENT')throw error;}await pause();}
  expect(settled).toBe(true);
  // Terminal job is committed before per-admin fences clear; observe their exact completion separately.
  await expect.poll(async()=>{try{return (await state(f,'recovery')).records.every(r=>!r.nativeRuntime?.pending);}catch{return false;}},{timeout:60_000}).toBe(true);
  const after=await state(f,'recovery');expect(after.shadow).toBe(expected.state.shadow);
  for(const r of after.records){const old=expected.state.records.find(v=>v.id===r.id)!;
    expect(r.status).toBe('stopped');expect(r.nativeRuntime!.incarnation).toBeUndefined();expect(r.nativeRuntime!.nonce).not.toBe(old.nativeRuntime!.nonce);
    expect(r.nativeRuntime!.installationId).toBe(old.nativeRuntime!.installationId);
    expect(r.nativeRuntime!.image.fingerprint).toBe(f.receipt.nativeFingerprint);}
  for(const v of after.managed)expect(expected.state.managed.some(old=>old.id===v.id)).toBe(false);
  expect(await client.listInstances()).toEqual([]);expect(await samples(f,'recovery',after)).toEqual(expected.samples);
  expect(await client.listInstances()).toEqual([]);
  await writeFile(join(f.vm.root,'admin-dr-restored.json'),JSON.stringify({version:1,nonce:f.vm.nonce,artifactSha256:expected.artifactSha256,state:after}),{flag:'wx',mode:0o600});
}
async function lifecycle(f:AdminDrFixture) {
  const expected=await evidence(f),restored=parseAdminDrJson(await readPrivateNativeDrFile(join(f.vm.root,'admin-dr-restored.json'),2*1024*1024));
  expect(restored.nonce).toBe(f.vm.nonce);expect(restored.artifactSha256).toBe(expected.artifactSha256);
  await assertAdminDrPackage(f,'recovery',false);
  const http=new AdminDrHttp('recovery');await http.login(f.receipt.source);
  const {config,client}=await native(f,'recovery');
  const {IncusAdminNetworkBoundary}=await import('../../orchestrator/server/utils/incus-admin-network');
  const network=new IncusAdminNetworkBoundary({...config,incusNetworkHostEndpoint:'https://127.0.0.1:18445',incusNetworkHostServerCertPath:config.incusServerCertPath});
  const networks=new Set<string>();
  for(const original of restored.state.records as AdministrativeWorkspaceRecord[]){
    const route=original.kind==='administrative'?'/api/admin/workspace':'/api/worker-groups/'+f.receipt.groupId+'/admin-workspace';
    const identities:string[]=[];const credentials:string[]=[];
    for(const action of ['start','stop','start','rebuild'] as const){
      await http.json(route+'/'+action,'POST',{});
      if(action==='stop')continue;
      const current=(await state(f,'recovery')).records.find(r=>r.id===original.id)!;expect(current.status).toBe('running');
      expect(current.nativeRuntime!.nonce).toBe(original.nativeRuntime!.nonce);
      const vm=await client.getInstance(current.nativeRuntime!.name);expect(vm.status).toBe('Running');expect(vm.profiles).toEqual([]);
      const uuid=vm.config['volatile.uuid'];expect(uuid).toBe(current.nativeRuntime!.incarnation);
      expect(uuid).not.toBe(expected.state.records.find(r=>r.id===current.id)!.nativeRuntime!.incarnation);identities.push(uuid!);
      const boundary=await network.boundary(current,'inspect');expect(boundary.network).not.toBe(config.incusNetwork);
      expect(vm.devices.eth0).toEqual(network.device(boundary));expect(Object.values(vm.devices).filter(v=>v.type==='nic')).toHaveLength(1);networks.add(boundary.network);
      const result=await client.exec(vm.name,['timeout','30','python3','-c',"import hashlib,os; p='/run/agentor-management/credential'; s=os.lstat(p); assert s.st_uid==1000 and s.st_mode & 0o777==0o600; print(hashlib.sha256(open(p,'rb').read(128)).hexdigest())"],{command:[],user:0,group:0});
      expect(result.returnCode).toBe(0);expect(result.stdout.trim()).toMatch(/^[a-f0-9]{64}$/);credentials.push(result.stdout.trim());
      const detached=(await state(f,'recovery')).managed.find(v=>v.workerId===current.id&&!v.attached)!;
      expect(Object.values(vm.devices).some(v=>v.source===detached.dockerName)).toBe(false);
    }
    expect(identities[0]).toBe(identities[1]);expect(identities[2]).not.toBe(identities[1]);expect(new Set(credentials).size).toBe(3);
    await http.json(route+'/stop','POST',{});
  }
  expect(networks.size).toBe(2);
  const current=await state(f,'recovery');expect(current.shadow).toBe(expected.state.shadow);
  expect(await samples(f,'recovery',current)).toEqual(expected.samples);
  await writeFile(join(f.vm.root,'admin-dr-lifecycle.json'),JSON.stringify({version:1,nonce:f.vm.nonce,artifactSha256:expected.artifactSha256,verified:true}),{flag:'wx',mode:0o600});
}

test('real encrypted administrative disaster recovery in a private native fixture',async()=>{
  test.skip(process.env[ADMIN_DR_FLAG]!=='true','Explicit private system-VM gate; no daemon or HTTP setup runs by default');
  test.setTimeout(3*60*60_000);
  const f=await requireAdminDrFixture();
  if(f.phase==='capture'||f.phase==='roundtrip')await capture(f);
  if(f.phase==='restore'||f.phase==='roundtrip')await restore(f);
  if(f.phase==='lifecycle')await lifecycle(f);
  console.info('Private administrative DR phase passed:',f.phase);
});
