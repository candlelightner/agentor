import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import type { Config } from '../../orchestrator/server/utils/config';
import { readPrivateNativeDrFile, requirePrivateNativeDrFixture, type PrivateNativeDrFixture } from './private-native-dr-fixture';

export const ADMIN_DR_FLAG = 'INCUS_ADMIN_INSTANCE_DR_TEST';
export const ADMIN_DR_RECEIPT = '/run/agentor-native-dr/administrative.json';
export type AdminDrPhase = 'capture' | 'restore' | 'roundtrip' | 'lifecycle';
export type AdminDrSide = 'source' | 'recovery';
interface Login { containerId: string; ownerId: string; email: string; password: string }
export interface AdminDrReceipt {
  version: 1; nonce: string; globalId: string; groupId: string; groupAdminId: string;
  workerImage: string; nativeFingerprint: string; source: Login; recovery: Login;
}
export interface AdminDrFixture { vm: PrivateNativeDrFixture; receipt: AdminDrReceipt; phase: AdminDrPhase }
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export function parseAdminDrJson(value:string):any { try{return JSON.parse(value);}catch{throw new Error('Invalid private administrative DR JSON (contents withheld)');} }
const failure = () => new Error('Administrative DR requires the exact root-private disposable guest fixture; no transport was authorized');
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
}
export function adminDrPhase(value: unknown): AdminDrPhase {
  if (typeof value !== 'string' || !['capture','restore','roundtrip','lifecycle'].includes(value)) throw failure();
  return value as AdminDrPhase;
}
export function validateAdminDrReceipt(value: unknown, nonce: string): asserts value is AdminDrReceipt {
  if (!keys(value, 'globalId,groupAdminId,groupId,nativeFingerprint,nonce,recovery,source,version,workerImage')) throw failure();
  const v = value as unknown as AdminDrReceipt;
  if (v.version !== 1 || v.nonce !== nonce || !uuid.test(nonce) || ![v.globalId,v.groupId,v.groupAdminId].every(id => typeof id === 'string' && uuid.test(id)) ||
      new Set([v.globalId,v.groupId,v.groupAdminId]).size !== 3 || typeof v.workerImage !== 'string' || typeof v.nativeFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.workerImage) || !/^[a-f0-9]{64}$/.test(v.nativeFingerprint)) throw failure();
  for (const login of [v.source,v.recovery]) if (!keys(login, 'containerId,email,ownerId,password') ||
      typeof login.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(login.containerId) ||
      typeof login.ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(login.ownerId) ||
      typeof login.email !== 'string' || login.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(login.email) ||
      typeof login.password !== 'string' || login.password.length < 12 || login.password.length > 256) throw failure();
  if (v.source.containerId === v.recovery.containerId || v.source.ownerId === v.recovery.ownerId) throw failure();
}
export async function requireAdminDrFixture(): Promise<AdminDrFixture> {
  const vm = await requirePrivateNativeDrFixture(); // First: boot/uid/machine/kernel nonce, before any API/CLI/imported service.
  const phase = adminDrPhase(process.env.INCUS_ADMIN_INSTANCE_DR_PHASE);
  const receipt: unknown = parseAdminDrJson(await readPrivateNativeDrFile(ADMIN_DR_RECEIPT, 8192));
  validateAdminDrReceipt(receipt, vm.nonce);
  const path = vm.root + '/recovery', info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) || await realpath(path) !== path) throw failure();
  return { vm, receipt, phase };
}
export function adminDrConfig(f: AdminDrFixture, side: AdminDrSide): Config {
  const base = 'agdr' + f.vm.nonce.slice(0,8);
  return { ...f.vm.config, dataDir: f.vm.root + (side === 'source' ? '/control' : '/recovery'),
    incusProject: base + (side === 'source' ? '' : 'r'), incusNetwork: base + (side === 'source' ? 'n' : 'rn'),
    workerImage: f.receipt.workerImage, workerImagePrefix: '', incusDockerVolumeSize: '1GiB' } as Config;
}
export const adminDrUrl = (side: AdminDrSide) => 'http://127.0.0.1:' + (side === 'source' ? 38000 : 38001);

/** Pure checks run against an exact ID returned by the guest-local Docker socket.
 * The VM receipt is mandatory first; these bindings alone never authorize a host. */
export function validateAdminDrContainer(info: any, f: AdminDrFixture, side: AdminDrSide, recoveryMode: boolean): void {
  const config = adminDrConfig(f,side), env = new Map<string,string>();
  for (const value of info?.Config?.Env ?? []) {
    if(typeof value !== 'string') throw failure(); const index = value.indexOf('='); if(index < 1 || env.has(value.slice(0,index))) throw failure();
    env.set(value.slice(0,index),value.slice(index+1));
  }
  const bindings = info?.HostConfig?.PortBindings?.['3000/tcp'];
  if (info?.Id !== f.receipt[side].containerId || info.State?.Running !== true || info.Config?.Labels?.['agentor.native-dr-fixture'] !== f.vm.nonce ||
      info.HostConfig?.Privileged || info.HostConfig?.NetworkMode === 'host' || info.HostConfig?.PidMode === 'host' ||
      info.HostConfig?.Devices?.length || !Array.isArray(bindings) || bindings.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== (side === 'source' ? '38000' : '38001')) throw failure();
  const expected = { DATA_DIR:'/data', BETTER_AUTH_URL:adminDrUrl(side), INCUS_ENABLED:'true',
    INCUS_ENDPOINT:'https://host.docker.internal:18443', INCUS_PROJECT:config.incusProject,
    INCUS_STORAGE_POOL:config.incusStoragePool, INCUS_NETWORK:config.incusNetwork, INCUS_WORKER_IMAGE:config.incusWorkerImage,
    INCUS_NETWORK_HOST_ENDPOINT:'https://host.docker.internal:18445', INCUS_NETWORK_HOST_SERVER_CERT_PATH:'/native-tls/server.crt',
    INCUS_CLIENT_CERT_PATH:'/native-tls/client.crt', INCUS_CLIENT_KEY_PATH:'/native-tls/client.key', INCUS_SERVER_CERT_PATH:'/native-tls/server.crt',
    WORKER_IMAGE:f.receipt.workerImage, CONTAINER_PREFIX:'agentor-worker', AGENTOR_INSTANCE_RECOVERY_MODE:String(recoveryMode) };
  if (Object.entries(expected).some(([key,value]) => env.get(key) !== value) ||
      !info.HostConfig?.ExtraHosts?.includes('host.docker.internal:host-gateway') || !env.get('DOCKER_NETWORK') ||
      !info.NetworkSettings?.Networks?.[env.get('DOCKER_NETWORK')!]) throw failure();
  for (const [destination,source,readonly] of [['/data',config.dataDir,false],['/native-tls',f.vm.root+'/tls',true],
    ['/var/run/docker.sock','/var/run/docker.sock',false]] as const) {
    const mounts = (info.Mounts ?? []).filter((m:any) => m.Destination === destination);
    if (mounts.length !== 1 || mounts[0].Type !== 'bind' || mounts[0].Source !== source || mounts[0].RW !== !readonly) throw failure();
  }
}
export async function fixtureDocker(args: string[]): Promise<string> {
  try { return (await promisify(execFile)('docker',['--host','unix:///var/run/docker.sock',...args],
    { timeout:60_000,maxBuffer:2*1024*1024,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/root'}})).stdout; }
  catch { throw new Error('Disposable guest Docker verification failed (output withheld)'); }
}
export async function assertAdminDrPackage(f: AdminDrFixture, side: AdminDrSide, recoveryMode: boolean) {
  const info = JSON.parse(await fixtureDocker(['inspect','--type','container',f.receipt[side].containerId]))[0];
  validateAdminDrContainer(info,f,side,recoveryMode);
  const script = `import {readFile,stat} from 'node:fs/promises'; import {createHash} from 'node:crypto';
const root='/app/.output/server/'; const helper=await readFile(root+'instance-restore-helper.mjs');
if(!(await stat(root+'instance-restore-native/index.mjs')).isFile() || !(await stat(root+'incus-bootstrap')).isDirectory()) throw Error('Missing packaged native recovery');
const m=await import(root+'instance-restore-native/index.mjs');
for(const k of ['planInstanceAdministrativeRestore','applyInstanceAdministrativeRestore','prepareInstanceLegacyAdministrativeVolumeArchive']) if(typeof m[k]!=='function') throw Error('Missing packaged admin recovery');
console.log(createHash('sha256').update(helper).digest('hex'));`;
  const hash = (await fixtureDocker(['exec',f.receipt[side].containerId,'node','--input-type=module','-e',script])).trim();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw failure();
  return { image:info.Image as string, helperSha256:hash };
}

/** Loopback-only, bounded test HTTP client; credentials and response bodies are
 * deliberately absent from errors and Playwright request tracing. */
export class AdminDrHttp {
  private cookie = '';
  constructor(readonly side: AdminDrSide) {}
  async request(path: string, method='GET', body?: unknown, raw?: Buffer): Promise<Buffer> {
    if (!/^\/api\/[A-Za-z0-9_/?=.-]+$/.test(path)) throw failure();
    const response = await fetch(adminDrUrl(this.side)+path,{ method,redirect:'manual',signal:AbortSignal.timeout(45*60_000),
      headers:{Origin:adminDrUrl(this.side),Cookie:this.cookie,...(raw ? {'Content-Type':'application/octet-stream','Content-Length':String(raw.length)} : body !== undefined ? {'Content-Type':'application/json'} : {})},
      body: raw ? new Uint8Array(raw) : (body === undefined ? undefined : JSON.stringify(body)) });
    const cookies=response.headers.getSetCookie(); if(cookies.length) this.cookie=cookies.map(v=>v.split(';',1)[0]).join('; ');
    if (!response.ok) { await response.body?.cancel(); throw new Error('Administrative fixture HTTP '+response.status+' at '+path.split('?')[0]); }
    const limit=path.endsWith('/download') ? 512*1024*1024 : 2*1024*1024, chunks:Uint8Array[]=[]; let size=0;
    if(response.body) for await(const chunk of response.body as any) { size+=chunk.length; if(size>limit) { await response.body.cancel().catch(()=>{}); throw new Error('Administrative fixture response exceeds bound'); } chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async json(path:string,method='GET',body?:unknown):Promise<any> { return parseAdminDrJson((await this.request(path,method,body)).toString('utf8')); }
  async login(login: Pick<Login,'email'|'password'|'ownerId'>) {
    const response=await this.json('/api/auth/sign-in/email','POST',{email:login.email,password:login.password});
    if(response.user?.id !== login.ownerId || !this.cookie) throw new Error('Disposable administrative account identity differs');
  }
}
export const adminDrDigest = (value:Buffer|string) => createHash('sha256').update(value).digest('hex');

export const adminDrSampleContent = (id:string,role:string) => Buffer.concat([Buffer.from('agentor-native-dr/'+id+'/'+role+'\n'),Buffer.from([0,255,128,10,61,0])]);
export const ADMIN_DR_SAMPLE_SCRIPT = String.raw`import hashlib,json,os,stat,sys
root=sys.argv[1]+'/native-dr-fixture'
if os.path.realpath(root)!=root or not stat.S_ISDIR(os.lstat(root).st_mode): raise ValueError('Fixture directory missing')
def metadata(path):
 s=os.lstat(path)
 return dict(uid=s.st_uid,gid=s.st_gid,mode=stat.S_IMODE(s.st_mode),mtimeNs=str(s.st_mtime_ns))
path=root+'/data.bin';s=os.lstat(path)
if not stat.S_ISREG(s.st_mode) or not 1<=s.st_size<=65536: raise ValueError('Fixture data must be a bounded regular file')
with open(path,'rb') as f: data=f.read(65537)
if len(data)!=s.st_size: raise ValueError('Fixture data changed')
hard=os.lstat(root+'/hard');link=os.lstat(root+'/link')
if not stat.S_ISREG(hard.st_mode) or hard.st_ino!=s.st_ino or hard.st_dev!=s.st_dev or not stat.S_ISLNK(link.st_mode): raise ValueError('Fixture links changed')
print(json.dumps(dict(root=metadata(root),file=metadata(path),sha256=hashlib.sha256(data).hexdigest(),size=len(data),xattr=os.getxattr(path,'user.native-dr').hex(),hardlink=True,symlink=os.readlink(root+'/link'))))
`;
