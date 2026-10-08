import { test, expect } from '@playwright/test';
import { randomUUID, randomBytes } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { IncusClient } from '../../orchestrator/server/utils/incus-client';
import { incusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';
import type { WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { legacyMigrationMountIdentity } from '../../orchestrator/server/utils/legacy-incus-migration-capture';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';

const run = promisify(execFile), q = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const ssh = ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1'];
const scp = ['-P', '22375', ...ssh.slice(2, -1)];
type Context = { project: string; projectMarker: string; network: string; tlsRoot: string; credentialsDir: string;
  workerImage: string; workerImageId: string; incusWorkerImage: string; seedFingerprint: string; appBaseImage: string; appBaseImageId: string };
type Worker = { id: string; userId: string; containerId: string; containerName: string; runtimeKind: 'legacy-docker' | 'incus-vm'; status: string };
type DockerInfo = { Id: string; Image: string; Created: string; Config: { Labels: Record<string, string> }; State: { Running: boolean };
  Mounts: Array<{ Type: string; Source: string; Destination: string; Name?: string }>;
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> } };
type MigrationStatus = { kind: string; phase: string; sourceRetained: boolean; recoveryRequired: boolean };
const metadataScript = String.raw`
import os,sys,stat,json,base64
paths=['/workspace/migration-proof','/home/agent/.agent-data/migration-proof']
if sys.argv[1]=='write':
 for p in paths:
  open(p,'wb').write(bytes([0,255,128,10,61,0]));os.chown(p,int(sys.argv[2]),int(sys.argv[2]));os.chmod(p,0o640)
  os.link(p,p+'.hard');os.setxattr(p,'user.binary',bytes([0,255,128,10]));os.utime(p,ns=(1700000000123456789,1700000000123456789))
out=[]
for p in paths:
 s=os.stat(p);out.append(dict(data=base64.b64encode(open(p,'rb').read()).decode(),uid=s.st_uid,gid=s.st_gid,mode=stat.S_IMODE(s.st_mode),
 mtime=str(s.st_mtime_ns),xattr=base64.b64encode(os.getxattr(p,'user.binary')).decode(),hard=s.st_ino==os.stat(p+'.hard').st_ino))
print(json.dumps(out))`;
const safeMigrationFailure = (status: number, input: unknown) => {
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const known = ['Forbidden: admin role required', 'Unauthorized', 'Invalid migration request', 'Worker not found', 'Current platform-admin migration authority is required'];
  const message = [body.statusMessage, body.message].find(value => typeof value === 'string' && known.includes(value));
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
  const code = [body.code, data.code].find(value => typeof value === 'string' && /^(?:WORKER_MIGRATION_|INCUS_|LEGACY_MIGRATION_)[A-Z0-9_]{1,80}$/.test(value));
  return 'Migration POST failed: ' + JSON.stringify({ status, code, message: message ?? 'Non-allowlisted error body withheld' });
};

test('public explicit legacy migration preserves source through validation, native data and exact finalization', async () => {
  test.skip(process.env.LEGACY_INCUS_MIGRATION_PUBLIC_TEST !== 'true', 'Explicit serial approved disposable migration gate');
  test.setTimeout(25 * 60_000);
  const contextFile = process.env.INCUS_CUSTOM_IMAGE_FIXTURE_JSON;
  if (!contextFile || !process.env.INCUS_ENDPOINT) throw new Error('Provide the approved private custom context and local forwarded Incus HTTPS endpoint');
  const fd = await open(contextFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let context: Context;
  try {
    const stat = await fd.stat(); expect(stat.isFile() && stat.uid === process.getuid?.() && !(stat.mode & 0o077) && stat.size < 16384).toBe(true);
    const input = JSON.parse(await fd.readFile('utf8')) as Record<string, unknown>;
    expect(input.version).toBe(1);
    const fields = ['project', 'projectMarker', 'network', 'tlsRoot', 'credentialsDir', 'workerImage', 'workerImageId', 'incusWorkerImage', 'seedFingerprint', 'appBaseImage', 'appBaseImageId'] as const;
    for (const field of fields) if (typeof input[field] !== 'string') throw new Error('Approved fixture context lacks a required nonsecret field');
    context = Object.fromEntries(fields.map(field => [field, input[field]])) as Context;
  } finally { await fd.close(); }
  expect(context.project).toBe('agimg10b'); expect(context.workerImageId).toBe('sha256:38b656283e26e5b070b97a49ead034903480ccaf0fd465825f6e985819745b5f');
  expect(context.projectMarker).toMatch(/^[a-f0-9-]{36}$/);
  expect(context.appBaseImageId).toBe('sha256:99f3293534e6c68ccf4852fa665272087a992acbe00a784c87033b2537bfb816');
  expect(context.workerImage).toBe('agentor-custom-base:' + context.projectMarker.slice(0, 8));
  expect(context.appBaseImage).toBe('agentor-custom-app-base:' + context.projectMarker.slice(0, 8));
  expect(context.network).toMatch(/^[A-Za-z0-9_-]{1,15}$/); expect(context.seedFingerprint).toMatch(/^[a-f0-9]{64}$/);
  for (const path of [context.credentialsDir, context.tlsRoot]) expect(path).toMatch(/^\/(?:workspace|var\/tmp)\/[A-Za-z0-9_./-]+$/);
  const client = new IncusClient({ endpoint: process.env.INCUS_ENDPOINT, project: context.project,
    clientCertPath: join(context.credentialsDir, 'client.crt'), clientKeyPath: join(context.credentialsDir, 'client.key'), serverCertPath: join(context.credentialsDir, 'server.crt') });
  const fixtureId = randomUUID(), local = await mkdtemp(join(tmpdir(), 'legacy-incus-migration-live-'));
  const remote = '/var/tmp/agentor-migration-' + fixtureId, data = remote + '/data', transport = remote + '/transport';
  const build = join(local, 'image'), image = 'agentor-migration-live:' + fixtureId, appName = 'migration-app-' + fixtureId;
  const network = 'migration-' + fixtureId.slice(0, 8), prefix = 'amig-' + fixtureId.slice(0, 8), chain = 'AMIG_' + fixtureId.slice(0, 8), table = 'amig_' + fixtureId.slice(0, 8);
  const admin = { email: 'migration-' + fixtureId + '@agentor.test', password: randomBytes(24).toString('base64url'), name: 'Migration acceptance' };
  const secret = randomBytes(32).toString('hex');
  let appId = '', imageId = '', owner = '', gateway = '', internalPort = '', installation = '', completed = false, policyAdded = false;
  let bridge = '', dockerCidr = '', incusCidr = '', nftBaseline = '', forwardBaseline = '';
  let phase = 'deterministic preflight';
  const workers: Worker[] = [], destinations = new Map<string, string>();
  const root = async (command: string, timeout = 30_000) => {
    try { return (await run('ssh', [...ssh, command], { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
    catch { throw new Error('Owned migration fixture command failed during ' + phase + '; secret-bearing command diagnostics are withheld'); }
  };
  const inspect = async (id: string): Promise<DockerInfo> => {
    const value = JSON.parse(await root(`sudo docker inspect ${q(id)} --format '{{json .}}'`)) as DockerInfo;
    // Never expose Docker Config.Env (cookies/fixture auth secrets) in assertion diffs.
    return { Id: value.Id, Image: value.Image, Created: value.Created, Config: { Labels: value.Config.Labels },
      State: { Running: value.State.Running }, Mounts: value.Mounts, NetworkSettings: { Networks: value.NetworkSettings.Networks } };
  };
  const records = async () => JSON.parse(await root(`sudo docker exec ${appId} node -e ${q(
    `const f=require('node:fs');const p=${JSON.stringify(data + '/users/' + owner + '/workers.json')};const s=f.lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error('Record source changed');console.log(f.readFileSync(p,'utf8'));`)}`)) as WorkerRecord[];
  const request = async <T,>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', timeout = 30_000): Promise<{ status: number; body: T }> => {
    const script = `const fs=await import('node:fs');const{request}=await import('node:http');const p='/fixture/session';const h={Origin:'http://127.0.0.1:3000','Content-Type':'application/json'};` +
      `if(fs.existsSync(p)){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&63))throw Error('Session is not private');h.Cookie=fs.readFileSync(p,'utf8')}` +
      `const b=${JSON.stringify(body === undefined ? '' : JSON.stringify(body))};if(b)h['Content-Length']=String(Buffer.byteLength(b));` +
      `const out=await new Promise((resolve,reject)=>{let t;const r=request({hostname:'127.0.0.1',port:3000,path:${JSON.stringify(path)},method:${JSON.stringify(method)},headers:h},s=>{const a=[];let n=0;s.on('data',x=>{n+=x.length;if(n>1048576){s.destroy();reject(Error('Response bound'))}else a.push(x)});s.on('error',reject);s.on('end',()=>{clearTimeout(t);const v=Buffer.concat(a).toString();resolve({status:s.statusCode,body:String(s.headers['content-type']).includes('application/json')?JSON.parse(v):v})})});r.on('error',reject);t=setTimeout(()=>r.destroy(Error('Deadline')),${timeout});r.end(b)});console.log(JSON.stringify(out));`;
    return JSON.parse(await root(`sudo docker exec ${appId} node --input-type=module -e ${q(script)}`, timeout + 10_000)) as { status: number; body: T };
  };
  const accounts = () => ['credentials', 'kilo/config', 'kilo/data'].map(role => data + '/users/' + owner + '/' + role);
  const policy = async (add: boolean) => root(`sudo python3 -c ${q(String.raw`
import http.client,json,socket,sys
class Unix(http.client.HTTPConnection):
 def connect(self):self.sock=socket.socket(socket.AF_UNIX);self.sock.connect('/var/lib/incus/unix.socket')
c=Unix('localhost',timeout=15);path='/1.0/projects/'+sys.argv[1];c.request('GET',path);r=c.getresponse();p=json.loads(r.read())['metadata'];tag=r.getheader('ETag');assert r.status==200 and tag
cfg=p['config'];assert cfg['restricted']=='true' and cfg['restricted.devices.disk']=='allow'
delta=json.loads(sys.argv[2]);paths=[x for x in cfg.get('restricted.devices.disk.paths','').split(',') if x]
assert all(x not in paths for x in delta) if sys.argv[3]=='add' else all(x in paths for x in delta)
cfg['restricted.devices.disk.paths']=','.join(sorted(paths+delta if sys.argv[3]=='add' else [x for x in paths if x not in delta]));assert cfg['restricted.devices.disk.paths']
c.request('PUT',path,json.dumps(dict(config=cfg,description=p['description'])),{'Content-Type':'application/json','If-Match':tag});r=c.getresponse();b=json.loads(r.read());assert r.status==200 and b['type']=='sync'
`)} ${q(context.project)} ${q(JSON.stringify(accounts()))} ${add ? 'add' : 'remove'}`);
  const normalizedNft = (value: string) => JSON.stringify(JSON.parse(value), (key, value) => key === 'metainfo' ? undefined : key === 'counter' ? {} : value);
  const launch = async (enabled: boolean) => {
    if (appId) {
      const old = await inspect(appId); expect(old.Id).toBe(appId); expect(old.Image).toBe(imageId); expect(old.Config.Labels['agentor.migration-fixture']).toBe(fixtureId);
      await root(`sudo docker stop --time 30 ${appId}`); await root(`sudo docker rm ${appId}`); appId = '';
    }
    const env = ['DATA_DIR=' + data, 'CONTAINER_PREFIX=' + prefix, 'DOCKER_NETWORK=' + network, 'WORKER_IMAGE=' + context.workerImage,
      'WORKER_IMAGE_PREFIX=', 'BETTER_AUTH_URL=http://127.0.0.1:3000', 'BETTER_AUTH_SECRET=' + secret, 'AGENTOR_INSTANCE_RECOVERY_MODE=true',
      'INCUS_ENABLED=' + String(enabled), 'INCUS_ENDPOINT=https://agentor-kata-preflight:8443', 'INCUS_PROJECT=' + context.project,
      'INCUS_NETWORK=' + context.network, 'INCUS_STORAGE_POOL=' + (process.env.INCUS_STORAGE_POOL || 'default'), 'INCUS_WORKER_IMAGE=' + context.incusWorkerImage,
      'INCUS_CLIENT_CERT_PATH=/tls/client.crt', 'INCUS_CLIENT_KEY_PATH=/tls/client.key', 'INCUS_SERVER_CERT_PATH=/tls/server.crt',
      'INCUS_DOCKER_VOLUME_SIZE=1GiB', 'INCUS_INTERNAL_GATEWAY_URL=http://' + gateway + ':' + (internalPort || '3079')];
    const tls = ['client.crt', 'client.key', 'server.crt'].map(file => '--mount ' + q(`type=bind,src=${context.tlsRoot}/${file},dst=/tls/${file},readonly`));
    appId = await root(`sudo docker run -d --name ${q(appName)} --label agentor.migration-fixture=${fixtureId} --network ${q(network)} --network-alias agentor-orchestrator ` +
      `--add-host agentor-kata-preflight:${q(process.env.LEGACY_INCUS_MIGRATION_HOST_API_ADDRESS || '172.22.0.1')} ` +
      `--mount ${q(`type=bind,src=${data},dst=${data}`)} --mount ${q(`type=bind,src=${transport},dst=/fixture`)} --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock ` +
      `${tls.join(' ')} ${env.map(value => '-e ' + q(value)).join(' ')} -p ${q(gateway + ':' + internalPort + ':3000')} ${q(image)} node .output/server/index.mjs`);
    expect(appId).toMatch(/^[a-f0-9]{64}$/);
    if (!internalPort) internalPort = await root(`sudo docker inspect ${appId} --format '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}'`);
    expect(internalPort).toMatch(/^\d{1,5}$/);
    const address = (await inspect(appId)).NetworkSettings.Networks[network]!.IPAddress; expect(isIP(address)).toBe(4);
    const rules = [
      `-i ${bridge} -o ${context.network} -s ${dockerCidr} -d ${incusCidr} -j ACCEPT`,
      `-i ${context.network} -o ${bridge} -s ${incusCidr} -d ${dockerCidr} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
      `-i ${context.network} -o ${bridge} -s ${incusCidr} -d ${address} -p tcp --dport 3000 -j ACCEPT`];
    if (forwardBaseline) expect(await root(`sudo iptables -w -S ${chain}`)).toBe(forwardBaseline);
    await root(`sudo iptables -w -F ${chain}`);
    for (const rule of rules) await root(`sudo iptables -w -A ${chain} ${rule} -m comment --comment ${q(fixtureId)}`);
    forwardBaseline = await root(`sudo iptables -w -S ${chain}`);
    if (nftBaseline) { expect(normalizedNft(await root(`sudo nft -j list table ip ${table}`))).toBe(nftBaseline); await root(`sudo nft delete table ip ${table}`); }
    else {
      const tables = JSON.parse(await root('sudo nft -j list tables')) as { nftables: Array<{ table?: { family: string; name: string } }> };
      expect(tables.nftables.some(entry => entry.table?.family === 'ip' && entry.table.name === table)).toBe(false);
    }
    const spec = `table ip ${table} { chain postrouting { type nat hook postrouting priority 99; policy accept; iifname "${context.network}" oifname "${bridge}" ip saddr ${incusCidr} ip daddr ${address} tcp dport 3000 counter snat to ip saddr comment "${fixtureId}";\n }\n}\n`;
    await root(`printf '%s\n' ${q(spec)} | sudo nft --check -f -`); await root(`printf '%s\n' ${q(spec)} | sudo nft -f -`);
    nftBaseline = normalizedNft(await root(`sudo nft -j list table ip ${table}`));
    await expect.poll(async () => { try { return (await request('/api/health')).status; } catch { return 0; } }, { timeout: 60_000 }).toBe(200);
  };
  const dockerExec = (id: string, argv: string[], timeout = 30_000) => root(`sudo docker exec -u root ${id} ${argv.map(q).join(' ')}`, timeout);
  const create = async (dockerEnabled: boolean) => {
    const environment = await request<{ id: string }>('/api/environments', { name: 'Migration fixture ' + String(dockerEnabled), dockerEnabled,
      cpuLimit: 1, memoryLimit: '1024m', networkMode: 'full', exposeApis: { portMappings: true, domainMappings: true, usage: true } });
    expect(environment.status).toBe(201);
    const created = await request<Worker>('/api/containers', { displayName: 'Legacy migration fixture', environmentId: environment.body.id }, 'POST', 180_000);
    expect(created.status).toBe(201); expect(created.body.runtimeKind).toBe('legacy-docker'); expect(created.body.userId).toBe(owner);
    expect(created.body.id).toMatch(/^[a-f0-9-]{36}$/); expect(created.body.containerName).toBe(prefix + '-' + created.body.id);
    expect(created.body.containerId).toMatch(/^[a-f0-9]{64}$/); workers.push(created.body); return created.body;
  };
  const migrate = async (worker: Worker, dockerEnabled: boolean) => {
    phase = 'explicit migration of owned worker ' + worker.id;
    const before = await inspect(worker.containerId); expect(before.Config.Labels['agentor.id']).toBe(worker.id); expect(before.Image).toBe(context.workerImageId);
    const bytes = JSON.parse(await dockerExec(before.Id, ['python3', '-c', metadataScript, 'read'])) as unknown;
    const volumes = before.Mounts.filter(m => m.Type === 'volume').map(m => m.Name!).filter(Boolean);
    const volumeProofs = await Promise.all(volumes.map(name => root(`sudo docker volume inspect ${q(name)}`)));
    const started = await request<MigrationStatus>('/api/admin/workers/' + worker.id + '/incus-migration', {}, 'POST', 600_000);
    expect(started.status, safeMigrationFailure(started.status, started.body)).toBe(200);
    expect(started.body).toMatchObject({ kind: 'incus-vm', phase: 'retained', sourceRetained: true, recoveryRequired: false });
    const status = await request<MigrationStatus>('/api/admin/workers/' + worker.id + '/incus-migration'); expect(status.body).toEqual(started.body);
    const source = await inspect(before.Id); expect(source).toMatchObject({ Id: before.Id, Image: before.Image, Created: before.Created, State: { Running: false } });
    expect(legacyMigrationMountIdentity(source.Mounts as Parameters<typeof legacyMigrationMountIdentity>[0]))
      .toEqual(legacyMigrationMountIdentity(before.Mounts as Parameters<typeof legacyMigrationMountIdentity>[0]));
    expect(await Promise.all(volumes.map(name => root(`sudo docker volume inspect ${q(name)}`)))).toEqual(volumeProofs);
    const saved = (await records()).find(record => record.id === worker.id)!; expect(saved.runtimeKind).toBe('incus-vm'); expect(saved.incusMigration?.phase).toBe('retained');
    const vm = await client.getInstance(worker.containerName), incarnation = vm.config['volatile.uuid']; expect(incarnation).toBe(saved.incusMigration!.destinationIncarnation);
    expect(incarnation).toMatch(/^[a-f0-9-]{36}$/);
    expect(vm.config).toMatchObject({ 'user.agentor.id': worker.id, 'user.agentor.owner': owner, 'user.agentor.installation': installation });
    expect(vm.config['volatile.base_image']).toBe(context.seedFingerprint); expect(vm.profiles).toEqual([]); destinations.set(worker.id, incarnation!);
    expect(vm.devices.eth0).toMatchObject({ 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true', 'security.mac_filtering': 'true' });
    const persisted = await client.exec(worker.containerName, ['python3', '-c', metadataScript, 'read']); expect(persisted.returnCode, persisted.stderr).toBe(0); expect(JSON.parse(persisted.stdout)).toEqual(bytes);
    const proof = await client.exec(worker.containerName, ['bash', '-ec', 'test "$(cat /proc/1/comm)" = systemd; systemctl is-active --quiet incus-agent agentor-worker; test -f /run/agentor/provisioned; ' +
      'runuser -u agent -- sudo -n true; test ! -e /tls/client.key; test ! -e /tls/client.crt; test ! -e /root/migration-disposable-root; curl -fsS http://127.0.0.1:8443/ >/dev/null; curl -fsS http://127.0.0.1:6080/ >/dev/null']);
    expect(proof.returnCode, proof.stderr).toBe(0);
    const editor = await request<string>('/editor/' + worker.id + '/?folder=/workspace'); expect(editor.status).toBe(200); expect(editor.body).toContain('code-server');
    const desktop = await request<string>('/desktop/' + worker.id + '/agentor.html'); expect(desktop.status).toBe(200); expect(desktop.body).toContain('noVNC');
    const self = await client.exec(worker.containerName, ['curl', '--noproxy', '*', '-fsS', 'http://' + gateway + ':' + internalPort + '/api/worker-self/info']);
    expect(self.returnCode, self.stderr).toBe(0); expect(JSON.parse(self.stdout)).toMatchObject({ workerId: worker.id, userId: owner });
    if (dockerEnabled) {
      const docker = await client.exec(worker.containerName, ['bash', '-ec', 'test "$(docker info --format "{{.Driver}}")" = overlay2; docker image inspect busybox:1.37.0 >/dev/null; docker container inspect retained-inner >/dev/null; docker run --rm -v migration-data:/data busybox:1.37.0 sh -ec \'test "$(cat /data/marker)" = migration-inner\'']);
      expect(docker.returnCode, docker.stderr).toBe(0);
    } else expect((await client.exec(worker.containerName, ['systemctl', 'is-active', 'docker'])).returnCode).not.toBe(0);
    const names = ['workspace', 'agents', ...(dockerEnabled ? ['docker'] : [])].map(role => worker.containerName + '-' + role);
    const nativeBefore = await Promise.all(names.map(name => client.getCustomVolume(process.env.INCUS_STORAGE_POOL || 'default', name)));
    const finalized = await request<MigrationStatus>('/api/admin/workers/' + worker.id + '/incus-migration/finalize', {}, 'POST', 120_000);
    expect(finalized.status).toBe(200); expect(finalized.body).toMatchObject({ kind: 'incus-vm', phase: 'none', sourceRetained: false });
    expect((await records()).find(record => record.id === worker.id)?.incusMigration).toBeUndefined();
    expect(await client.getInstance(worker.containerName)).toEqual(vm);
    expect(await Promise.all(names.map(name => client.getCustomVolume(process.env.INCUS_STORAGE_POOL || 'default', name)))).toEqual(nativeBefore);
    await root(`sudo docker inspect ${before.Id} >/dev/null 2>&1 && exit 1 || test "$(sudo docker ps -aq --no-trunc --filter id=${before.Id})" = ''`);
    for (const name of volumes) expect(await root(`sudo docker volume ls --format '{{.Name}}' --filter name=^${q(name)}$`)).toBe('');
    for (const directory of saved.incusMigration!.sourceDirectories ?? []) { expect(directory.path).toContain(data + '/'); await root(`sudo test ! -e ${q(directory.path)}`); }
  };
  const removeNative = async (worker: Worker) => {
    const vm = await client.getInstance(worker.containerName); expect(vm.config['volatile.uuid']).toBe(destinations.get(worker.id));
    expect(vm.config['user.agentor.installation']).toBe(installation); expect(vm.config['user.agentor.id']).toBe(worker.id);
    expect((await request('/api/containers/' + worker.id, undefined, 'DELETE', 120_000)).status).toBe(200);
    await expect(client.getInstance(worker.containerName)).rejects.toMatchObject({ statusCode: 404 });
    destinations.delete(worker.id);
  };
  try {
    const alias = await client.getImageAlias(context.incusWorkerImage); expect(alias.target).toBe(context.seedFingerprint);
    expect(incusImageIdentity(await client.getImage(alias.target)).sourceImageId).toBe(context.workerImageId);
    await mkdir(build); await mkdir(join(local, 'data'), { mode: 0o700 });
    installation = await backupInstallationId(join(local, 'data'));
    const output = fileURLToPath(new URL('../../orchestrator/.output', import.meta.url));
    expect(await readFile(join(output, 'server/chunks/nitro/nitro.mjs'), 'utf8')).toContain('migrateLegacyWorker');
    await cp(output, join(build, 'app-output'), { recursive: true, verbatimSymlinks: true });
    await cp(join(output, 'server/instance-restore-native'), join(build, 'instance-restore-native'), { recursive: true, verbatimSymlinks: true });
    for (const file of ['instance-restore-helper.mjs', 'volume-mount-helper.py', 'incus-volume-live-helper.py']) await copyFile(fileURLToPath(new URL('../../orchestrator/' + file, import.meta.url)), join(build, file));
    await writeFile(join(build, 'Dockerfile'), await readFile(fileURLToPath(new URL('../fixtures/instance-native-app.Dockerfile', import.meta.url)), 'utf8') + '\nRUN apk add --no-cache tar acl\n');
    phase = 'approved disposable prerequisites and isolated package build';
    await root('sudo test -d /sys/module/br_netfilter && test "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables)" = 1 && test "$(cat /proc/sys/net/bridge/bridge-nf-call-ip6tables)" = 1');
    for (const [tag, id] of [[context.workerImage, context.workerImageId], [context.appBaseImage, context.appBaseImageId]]) expect(await root(`sudo docker image inspect ${q(tag!)} --format '{{.Id}}'`)).toBe(id);
    await root(`test ! -e ${q(remote)} && mkdir -m 700 ${q(remote)} && mkdir -m 700 ${q(data)} ${q(transport)}`);
    await run('scp', [...scp, '-r', build, join(local, 'data'), 'kata-test@172.19.0.1:' + remote + '/'], { timeout: 60_000 });
    imageId = await root(`sudo docker build -q --label agentor.migration-fixture=${fixtureId} --build-arg BASE_IMAGE=${q(context.appBaseImage)} -t ${q(image)} ${q(remote + '/image')}`, 180_000);
    expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    await root(`sudo docker network create --label agentor.migration-fixture=${fixtureId} ${q(network)}`);
    const net = JSON.parse(await root(`sudo docker network inspect ${q(network)}`)) as Array<{ Id: string; Options: Record<string, string>; IPAM: { Config: Array<{ Subnet: string }> } }>;
    bridge = net[0]!.Options['com.docker.network.bridge.name'] ?? 'br-' + net[0]!.Id.slice(0, 12); expect(bridge).toMatch(/^[A-Za-z0-9_.-]{1,15}$/);
    dockerCidr = net[0]!.IPAM.Config[0]!.Subnet; expect(dockerCidr).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
    const primary = await root(`sudo incus --force-local --project default network get ${q(context.network)} ipv4.address`); const [ip, bits] = primary.split('/'); expect(isIP(ip!)).toBe(4); gateway = ip!;
    expect(bits).toMatch(/^\d{1,2}$/); expect(Number(bits)).toBeGreaterThanOrEqual(1); expect(Number(bits)).toBeLessThanOrEqual(32);
    expect(isIP(process.env.LEGACY_INCUS_MIGRATION_HOST_API_ADDRESS || '172.22.0.1')).toBe(4);
    const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
    const number = (ip!.split('.').reduce((n, octet) => (n << 8) | Number(octet), 0) & mask) >>> 0;
    incusCidr = [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join('.') + '/' + bits;
    expect(await root('sudo iptables -S')).not.toContain('-N ' + chain); await root(`sudo iptables -w -N ${chain}`);
    await root(`sudo iptables -w -I DOCKER-USER 1 -m comment --comment ${q(fixtureId)} -j ${chain}`);
    phase = 'legacy controller boot and real account creation'; await launch(false);
    const createdAdmin = await request<{ id: string; role: string }>('/api/setup/create-admin', admin);
    expect(createdAdmin.status).toBe(201); expect(createdAdmin.body.role).toBe('admin');
    owner = createdAdmin.body.id; expect(owner).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    const signIn = `const fs=await import('node:fs');const base='http://127.0.0.1:3000';const r=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({ email: admin.email, password: admin.password }))}});if(!r.ok)throw Error('Sign-in failed');const b=await r.json();if(b.user?.id!==${JSON.stringify(owner)}||b.user?.role!=='admin')throw Error('Admin session identity differs');const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');if(!cookie)throw Error('Admin session cookie missing');fs.writeFileSync('/fixture/session',cookie,{mode:384,flag:'wx'});console.log('Private real admin session prepared');`;
    expect(await root(`sudo docker exec ${appId} node --input-type=module -e ${q(signIn)}`)).toBe('Private real admin session prepared');
    const dockerEnabled = process.env.LEGACY_INCUS_MIGRATION_DOCKER_TEST === 'true';
    const simple = await create(dockerEnabled); await dockerExec(simple.containerId, ['python3', '-c', metadataScript, 'write', '12345']);
    if (dockerEnabled) await dockerExec(simple.containerId, ['bash', '-ec',
      'test "$(docker info --format "{{.Driver}}")" = overlay2; docker pull busybox:1.37.0; docker run --name retained-inner -v migration-data:/data busybox:1.37.0 sh -ec \'printf migration-inner >/data/marker\''], 120_000);
    await dockerExec(simple.containerId, ['sh', '-c', 'printf fixture-root-only >/root/migration-disposable-root']);
    expect(await root(`sudo docker exec ${appId} cat ${q(data + '/backup-installation-id')}`)).toBe(installation);
    await policy(true); policyAdded = true;
    const legacyBefore = await inspect(simple.containerId); phase = 'same controller DATA redeploy with Incus enabled'; await launch(true);
    expect((await request<Worker[]>('/api/containers')).body.find(worker => worker.id === simple.id)).toMatchObject({ runtimeKind: 'legacy-docker', containerId: simple.containerId });
    expect((await records()).find(record => record.id === simple.id)?.incusMigration).toBeUndefined(); expect((await inspect(simple.containerId)).Id).toBe(legacyBefore.Id);
    await migrate(simple, dockerEnabled);
    completed = true;
  } finally {
    if (completed) {
      phase = 'identity-pinned successful fixture cleanup';
      for (const worker of workers) {
        if (destinations.has(worker.id)) await removeNative(worker);
      }
      if (policyAdded) await policy(false);
      const app = await inspect(appId); expect(app.Id).toBe(appId); expect(app.Image).toBe(imageId); expect(app.Config.Labels['agentor.migration-fixture']).toBe(fixtureId);
      await root(`sudo docker stop --time 30 ${appId}`); await root(`sudo docker rm ${appId}`);
      expect(normalizedNft(await root(`sudo nft -j list table ip ${table}`))).toBe(nftBaseline); await root(`sudo nft delete table ip ${table}`);
      expect(await root(`sudo iptables -w -S ${chain}`)).toBe(forwardBaseline);
      await root(`sudo iptables -w -D DOCKER-USER -m comment --comment ${q(fixtureId)} -j ${chain}`);
      await root(`sudo iptables -w -F ${chain}`); await root(`sudo iptables -w -X ${chain}`);
      const info = JSON.parse(await root(`sudo docker network inspect ${q(network)}`)) as Array<{ Labels: Record<string, string>; Containers: Record<string, unknown> }>;
      expect(info[0]!.Labels['agentor.migration-fixture']).toBe(fixtureId); expect(Object.keys(info[0]!.Containers)).toEqual([]); await root(`sudo docker network rm ${q(network)}`);
      expect(await root(`sudo docker image inspect ${q(image)} --format '{{.Id}} {{index .Config.Labels "agentor.migration-fixture"}}'`)).toBe(imageId + ' ' + fixtureId); await root(`sudo docker image rm ${q(image)}`);
      await rm(local, { recursive: true, force: true });
      console.info('Owned public migration fixtures removed; exact private host DATA/transport retained for root-reviewed disposal', { remote, fixtureId });
    } else console.error('Unconfirmed migration fixture retained; no guessed cleanup', { local, remote, fixtureId, appId, imageId, workers: workers.map(worker => worker.id) });
    client.dispose();
  }
});
