import { expect,test } from '@playwright/test';
import { adminDrPhase,validateAdminDrReceipt,validateAdminDrContainer,adminDrConfig,type AdminDrFixture } from '../helpers/private-admin-native-dr-fixture';

function fixture():AdminDrFixture {
 const nonce='11111111-1111-4111-8111-111111111111',root='/var/lib/agentor-native-dr/'+nonce;
 return {phase:'roundtrip',vm:{version:1,kind:'agentor-private-native-dr-vm',nonce,bootId:'22222222-2222-4222-8222-222222222222',machineId:'a'.repeat(32),root,
 config:{dataDir:root+'/control',containerPrefix:'agentor-worker',incusEnabled:true,incusEndpoint:'https://127.0.0.1:18443',incusProject:'agdr11111111',
 incusNetwork:'agdr11111111n',incusStoragePool:'agdr11111111p',incusWorkerImage:'agdr11111111-worker',incusInternalGatewayUrl:'http://10.231.0.1:38000',
 incusNetworkHostEndpoint:'',incusNetworkHostServerCertPath:'',incusConverterStoragePool:'',incusConverterSeedFingerprint:'',
 incusClientCertPath:root+'/tls/client.crt',incusClientKeyPath:root+'/tls/client.key',incusServerCertPath:root+'/tls/server.crt'}},
 receipt:{version:1,nonce,globalId:'33333333-3333-4333-8333-333333333333',groupId:'44444444-4444-4444-8444-444444444444',groupAdminId:'55555555-5555-4555-8555-555555555555',
 workerImage:'sha256:'+'a'.repeat(64),nativeFingerprint:'b'.repeat(64),source:{containerId:'c'.repeat(64),ownerId:'source-owner',email:'source@example.test',password:'fixture-private-password'},
 recovery:{containerId:'d'.repeat(64),ownerId:'recovery-owner',email:'recovery@example.test',password:'fixture-private-password'}}};
}
function container(f:AdminDrFixture,side:'source'|'recovery',recovery:boolean):any {
 const config=adminDrConfig(f,side);
 const values={DATA_DIR:'/data',BETTER_AUTH_URL:'http://127.0.0.1:'+(side==='source'?'38000':'38001'),INCUS_ENABLED:'true',INCUS_ENDPOINT:'https://host.docker.internal:18443',
 INCUS_PROJECT:config.incusProject,INCUS_STORAGE_POOL:config.incusStoragePool,INCUS_NETWORK:config.incusNetwork,INCUS_WORKER_IMAGE:config.incusWorkerImage,
 INCUS_NETWORK_HOST_ENDPOINT:'https://host.docker.internal:18445',INCUS_NETWORK_HOST_SERVER_CERT_PATH:'/native-tls/server.crt',
 INCUS_CLIENT_CERT_PATH:'/native-tls/client.crt',INCUS_CLIENT_KEY_PATH:'/native-tls/client.key',INCUS_SERVER_CERT_PATH:'/native-tls/server.crt',
 WORKER_IMAGE:f.receipt.workerImage,CONTAINER_PREFIX:'agentor-worker',AGENTOR_INSTANCE_RECOVERY_MODE:String(recovery),DOCKER_NETWORK:'private-control'};
 return {Id:f.receipt[side].containerId,State:{Running:true},Config:{Labels:{'agentor.native-dr-fixture':f.vm.nonce},Env:Object.entries(values).map(([k,v])=>k+'='+v)},
 HostConfig:{Privileged:false,NetworkMode:'private-control',PidMode:'',Devices:[],ExtraHosts:['host.docker.internal:host-gateway'],PortBindings:{'3000/tcp':[{HostIp:'127.0.0.1',HostPort:side==='source'?'38000':'38001'}]}},
 NetworkSettings:{Networks:{'private-control':{}}},Mounts:[{Type:'bind',Source:config.dataDir,Destination:'/data',RW:true},
 {Type:'bind',Source:f.vm.root+'/tls',Destination:'/native-tls',RW:false},{Type:'bind',Source:'/var/run/docker.sock',Destination:'/var/run/docker.sock',RW:true}]};
}
test('only explicit native admin phases and exact private receipt shape are admitted',()=>{
 const f=fixture();expect(()=>validateAdminDrReceipt(f.receipt,f.vm.nonce)).not.toThrow();
 for(const p of ['capture','restore','roundtrip','lifecycle'])expect(adminDrPhase(p)).toBe(p);
 for(const p of [undefined,'','all','production',null,['capture']])expect(()=>adminDrPhase(p)).toThrow();
 for(const change of [{nonce:'wrong'},{endpoint:'https://production'},{globalId:f.receipt.groupId},{workerImage:'agentor-worker:latest'},
 {workerImage:[f.receipt.workerImage]},{nativeFingerprint:[f.receipt.nativeFingerprint]},{source:{...f.receipt.source,password:undefined}},{recovery:{...f.receipt.recovery,containerId:f.receipt.source.containerId}},
 {recovery:{...f.receipt.recovery,ownerId:f.receipt.source.ownerId}}])expect(()=>validateAdminDrReceipt({...f.receipt,...change},f.vm.nonce)).toThrow();
});
for(const side of ['source','recovery'] as const)test(`exact ${side} container binds local credentials, project, DATA and recovery mode`,()=>{
 const f=fixture(),value=container(f,side,side==='recovery');
 expect(()=>validateAdminDrContainer(value,f,side,side==='recovery')).not.toThrow();
 for(const mutate of [(v:any)=>v.Id='e'.repeat(64),(v:any)=>v.Config.Labels['agentor.native-dr-fixture']='wrong',
 (v:any)=>v.HostConfig.PortBindings['3000/tcp'][0].HostIp='0.0.0.0',(v:any)=>v.HostConfig.Privileged=true,
 (v:any)=>v.HostConfig.NetworkMode='host',(v:any)=>v.HostConfig.PidMode='host',(v:any)=>v.HostConfig.Devices=[{PathOnHost:'/dev/sda'}],
 (v:any)=>v.Mounts[0].Source='/data',(v:any)=>v.Mounts[1].RW=true,(v:any)=>v.Config.Env.push('INCUS_ENDPOINT=https://foreign'),
 (v:any)=>v.Config.Env.push('INCUS_NETWORK_HOST_ENDPOINT=https://foreign'),(v:any)=>v.HostConfig.ExtraHosts=[],(v:any)=>delete v.NetworkSettings.Networks['private-control']]){
  const copy=structuredClone(value);mutate(copy);expect(()=>validateAdminDrContainer(copy,f,side,side==='recovery')).toThrow();
 }
 expect(()=>validateAdminDrContainer(value,f,side,side!=='recovery')).toThrow();
});
test('destination derives only the second local project and private DATA root; copied source identity never selects endpoints',()=>{
 const f=fixture(),source=adminDrConfig(f,'source'),dest=adminDrConfig(f,'recovery');
 expect(dest.incusEndpoint).toBe(source.incusEndpoint);expect(dest.incusProject).toBe(source.incusProject+'r');
 expect(dest.dataDir).toBe(f.vm.root+'/recovery');expect(dest.incusStoragePool).toBe(source.incusStoragePool);
 expect(dest.incusNetworkHostEndpoint).toBe('');
});

import { execFileSync } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,readFile,stat,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_DR_SAMPLE_SCRIPT,adminDrSampleContent,adminDrDigest } from '../helpers/private-admin-native-dr-fixture';
test('the actual readonly sample script checks exact bytes, inode links, xattr and unchanged link text in an owned temporary tree',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-admin-dr-sample-'));
 try {
  const directory=join(root,'native-dr-fixture');await mkdir(directory);
  const data=adminDrSampleContent(fixture().receipt.globalId,'workspace');await writeFile(join(directory,'data.bin'),data);
  execFileSync('python3',['-c',"import os,sys; p=sys.argv[1]; os.link(p+'/data.bin',p+'/hard'); os.symlink('data.bin',p+'/link'); os.setxattr(p+'/data.bin','user.native-dr',bytes([0,255,128,10,61,0]))",directory]);
  const result=JSON.parse(execFileSync('python3',['-c',ADMIN_DR_SAMPLE_SCRIPT,root],{encoding:'utf8'}));
  expect(result).toMatchObject({sha256:adminDrDigest(data),size:data.length,xattr:'00ff800a3d00',hardlink:true,symlink:'data.bin'});
  await rm(join(directory,'hard'));await writeFile(join(directory,'hard'),data);
  expect(()=>execFileSync('python3',['-c',ADMIN_DR_SAMPLE_SCRIPT,root],{stdio:'pipe'})).toThrow();
 } finally {await rm(root,{recursive:true,force:true});}
});

// Import the actual config in a short-lived child with an owned TMPDIR.
test('module configuration preserves its diagnostic store for the admin gate and cleans ordinary temporary data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-admin-dr-config-'));
 try {
  const {transpileModule,ModuleKind}=await import('typescript');
  const config=join(root,'modules.cjs');
  await writeFile(config,transpileModule(await readFile(new URL('../playwright.modules.config.ts',import.meta.url),'utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText);
  for(const live of [false,true]) {
   const value=execFileSync(process.execPath,['-e',"require(process.argv[1]); process.stdout.write(process.env.DATA_DIR)",config],
     {encoding:'utf8',env:{PATH:process.env.PATH,TMPDIR:root,NODE_PATH:fileURLToPath(new URL('../node_modules',import.meta.url)),...(live?{INCUS_ADMIN_INSTANCE_DR_TEST:'true'}:{})}}).trim();
   expect(value.startsWith(root+'/agentor-incus-acceptance-')).toBe(true);
   expect(await stat(value).then(()=>true,()=>false)).toBe(live);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
