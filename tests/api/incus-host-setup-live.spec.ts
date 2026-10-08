import { test, expect } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncusClient } from '../../orchestrator/server/utils/incus-client';
import { incusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { resolveIncusPrimaryLease } from '../../orchestrator/server/utils/incus-worker-network';

const run = promisify(execFile), q = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const ssh = ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1'];
const scp = ['-P', '22375', ...ssh.slice(2, -1)];
const scripts = ['setup-incus-host.sh', 'check-incus-host.sh', 'agentor-incus-network-service.py',
  'incus-managed-network-policy.py', 'incus-host-mount-policy.py', 'incus-host-mount-sources.py'];
type Context = { version: number; projectMarker: string; workerImage: string; workerImageId: string;
  appBaseImage: string; appBaseImageId: string };
type DockerInfo = { Id: string; Image: string; Created: string; Config: { Labels: Record<string, string> };
  State: { Running: boolean }; Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }> };
type Worker = { id: string; userId: string; runtimeKind: string; containerId: string; containerName: string; status: string };
// Existing operator-only Unix observation, not an application credential or proxy.
// Output contains hashes, never guest config, Docker Env, private keys or data.
const baselineScript = String.raw`import hashlib,http.client,json,socket,subprocess
class Unix(http.client.HTTPConnection):
 def connect(self):self.sock=socket.socket(socket.AF_UNIX);self.sock.connect('/var/lib/incus/unix.socket')
def get(path):
 c=Unix('localhost',timeout=15);c.request('GET',path);r=c.getresponse();v=json.loads(r.read());assert r.status==200;return v['metadata']
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
out={}
cache_volume=get('/1.0').get('config',{}).get('storage.images_volume','')
for project in get('/1.0/projects?recursion=1'):
 p=project['name'];out['project/'+p]=digest({k:project.get(k) for k in ('name','description','config')})
 for item in get('/1.0/instances?project='+p+'&recursion=1'):
  out['vm/'+p+'/'+item['name']]=digest({k:item.get(k) for k in ('name','type','config','devices','profiles')})
 for image in get('/1.0/images?project='+p+'&recursion=1'):
  value={k:image.get(k) for k in ('fingerprint','type','architecture','properties','created_at')}
  value['aliases']=sorted(image.get('aliases',[]),key=lambda x:json.dumps(x,sort_keys=True))
  out['image/'+p+'/'+image['fingerprint']]=digest(value)
for pool in get('/1.0/storage-pools?recursion=1'):
 out['pool/'+pool['name']]=digest({k:pool.get(k) for k in ('name','description','driver','config')})
 for volume in get('/1.0/storage-pools/'+pool['name']+'/volumes?all-projects=true&recursion=1'):
  value={k:volume.get(k) for k in ('name','type','content_type','project','description','config','created_at')}
  if pool['name']+'/'+volume['name']!=cache_volume:value['used_by']=sorted(volume.get('used_by',[]))
  out['volume/'+pool['name']+'/'+volume.get('project','default')+'/'+volume['type']+'/'+volume['name']]=digest(value)
for network in get('/1.0/networks?recursion=1'):out['network/'+network['name']]=digest({k:network.get(k) for k in ('name','description','type','managed','config')})
for cert in get('/1.0/certificates?recursion=1'):out['certificate/'+cert['fingerprint']]=digest({k:cert.get(k) for k in ('fingerprint','name','type','restricted','projects')})
ids=subprocess.check_output(['docker','ps','-aq','--no-trunc'],text=True).split()
for container in json.loads(subprocess.check_output(['docker','inspect',*ids],text=True)) if ids else []:
 value={k:container.get(k) for k in ('Id','Image','Created')};value['Mounts']=sorted(container.get('Mounts',[]),key=lambda x:json.dumps(x,sort_keys=True))
 networks=container['NetworkSettings'].get('Networks',{})
 for n in networks.values():
  for key in ('Aliases','DNSNames'):
   if isinstance(n.get(key),list):n[key]=sorted(n[key])
 out['docker/'+container['Id']]=digest(value|{'labels':container['Config'].get('Labels'),'networks':networks})
print(json.dumps(out,sort_keys=True))`;

test('operator Incus setup repeats without changing retained resources and boots a public default-worker canary', async () => {
  test.skip(process.env.INCUS_HOST_SETUP_TEST !== 'true', 'Root-exclusive approved disposable-host setup acceptance');
  test.setTimeout(65 * 60_000);
  const path = process.env.INCUS_CUSTOM_IMAGE_FIXTURE_JSON;
  if (!path || !process.env.INCUS_ENDPOINT) throw new Error('Approved private source context and narrowed HTTPS forward required');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let context: Context;
  try { const stat = await file.stat(); expect(stat.isFile() && stat.uid === process.getuid?.() && !(stat.mode & 0o077) && stat.size < 16384).toBe(true);
    context = JSON.parse(await file.readFile('utf8')) as Context;
  } finally { await file.close(); }
  expect(context.version).toBe(1); expect(context.projectMarker).toMatch(/^[a-f0-9-]{36}$/);
  expect(context.workerImageId).toBe('sha256:38b656283e26e5b070b97a49ead034903480ccaf0fd465825f6e985819745b5f');
  expect(context.appBaseImageId).toBe('sha256:99f3293534e6c68ccf4852fa665272087a992acbe00a784c87033b2537bfb816');
  expect(context.workerImage).toBe('agentor-custom-base:' + context.projectMarker.slice(0, 8));
  expect(context.appBaseImage).toBe('agentor-custom-app-base:' + context.projectMarker.slice(0, 8));
  const fixtureId = randomUUID(), local = await mkdtemp(join(tmpdir(), 'agentor-host-setup-'));
  const remote = '/home/kata-test/agentor-host-setup.' + fixtureId, hostData = remote + '/data', transport = remote + '/transport';
  const scratch = '/mnt/kata-extra/agentor-host-setup.' + fixtureId, build = join(local, 'image'), tree = join(local, 'trusted');
  const installation = await backupInstallationId(join(local, 'data')), short = installation.replaceAll('-', '').slice(0, 8);
  const project = 'as' + short, network = 'as' + short, pool = 'as' + short;
  const appName = 'agentor-host-setup-' + fixtureId, image = 'agentor-host-setup:' + fixtureId, prefix = 'as' + short;
  const certificateDir = '/etc/agentor/incus/' + installation, configPath = certificateDir + '/config.json';
  let appId = '', imageId = '', worker: Worker | undefined, incarnation: string | undefined, complete = false, phase = 'read-only preflight';
  let client: IncusClient | undefined;
  const root = async (command: string, timeout = 30_000) => {
    try { return (await run('ssh', [...ssh, command], { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
    catch (error) {
      const failure = error as { code?: string | number; signal?: string; stdout?: string; stderr?: string };
      // Keep bounded operator diagnostics private; never print command output
      // that could contain session cookies or credential-bearing configuration.
      await writeFile(join(local, 'failed-command-private.json'), JSON.stringify({ phase, ...failure,
        stdout: failure.stdout?.slice(0, 4 * 1024 * 1024), stderr: failure.stderr?.slice(0, 4 * 1024 * 1024) }), { mode: 0o600 });
      throw new Error('Owned host-setup fixture failed during ' + phase + '; secret-bearing diagnostics withheld');
    }
  };
  const inspect = async (id: string): Promise<DockerInfo> => JSON.parse(await root(`sudo docker inspect ${q(id)} --format ` +
    q('{"Id":{{json .Id}},"Image":{{json .Image}},"Created":{{json .Created}},"Config":{"Labels":{{json .Config.Labels}}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}}}')));
  const snapshot = async (): Promise<Record<string, string>> => JSON.parse(await root(`sudo python3 -c ${q(baselineScript)}`));
  const request = async <T,>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', timeout = 30_000): Promise<{ status: number; body: T }> => {
    const script = `const fs=await import('node:fs');const{request}=await import('node:http');const p='/fixture/session';const h={Origin:'http://127.0.0.1:3000','Content-Type':'application/json'};` +
      `if(fs.existsSync(p)){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&63))throw Error('Session is not private');h.Cookie=fs.readFileSync(p,'utf8')}` +
      `const b=${JSON.stringify(body === undefined ? '' : JSON.stringify(body))};if(b)h['Content-Length']=String(Buffer.byteLength(b));` +
      `const out=await new Promise((resolve,reject)=>{let t;const r=request({hostname:'127.0.0.1',port:3000,path:${JSON.stringify(path)},method:${JSON.stringify(method)},headers:h},s=>{const a=[];let n=0;s.on('data',x=>{n+=x.length;if(n>1048576){s.destroy();reject(Error('Response bound'))}else a.push(x)});s.on('error',reject);s.on('end',()=>{clearTimeout(t);const v=Buffer.concat(a).toString();resolve({status:s.statusCode,body:String(s.headers['content-type']).includes('application/json')?JSON.parse(v):v})})});r.on('error',reject);t=setTimeout(()=>r.destroy(Error('Deadline')),${timeout});r.end(b)});console.log(JSON.stringify(out));`;
    return JSON.parse(await root(`sudo docker exec ${appId} node --input-type=module -e ${q(script)}`, timeout + 10_000));
  };
  const outputs = (stdout: string) => Object.fromEntries(stdout.split('\n').flatMap(line => {
    const match = /^(INCUS_[A-Z_]+)=(.*)$/.exec(line); return match ? [[match[1]!, match[2]!]] : [];
  }));
  const config = async () => JSON.parse(await root(`sudo cat ${q(configPath)}`)) as { installation: string; pool: string; project: string;
    network: string; listen: string; internalUrl: string; sourceTable: string; defaultImage: { phase: string; fingerprint: string; recipeId: string; alias: string; sourceImageId: string } };
  const launch = async (env: Record<string, string>, tls = false) => {
    if (appId) {
      const previous = await inspect(appId); expect(previous.Id).toBe(appId); expect(previous.Image).toBe(imageId);
      expect(previous.Config.Labels['agentor.host-setup-fixture']).toBe(fixtureId);
      expect(previous.Mounts.find(mount => mount.Destination === '/data')).toMatchObject({ Type: 'bind', Source: hostData, RW: true });
      await root(`sudo docker stop --time 30 ${appId}`); await root(`sudo docker rm ${appId}`); appId = '';
    }
    const files = tls ? ['client.crt', 'client.key', 'server.crt', 'policy.crt'].map(name => '--mount ' +
      q('type=bind,src=' + certificateDir + '/' + name + ',dst=/run/agentor-incus/' + name + ',readonly')).join(' ') : '';
    const publish = tls ? '-p ' + q(env.INCUS_WORKER_GATEWAY + ':' + env.INCUS_INTERNAL_PORT + ':3000') : '';
    const values = { DATA_DIR: '/data', DOCKER_NETWORK: 'agentor-phase6-net', CONTAINER_PREFIX: prefix,
      WORKER_IMAGE_PREFIX: '', WORKER_IMAGE: context.workerImage, BETTER_AUTH_URL: 'http://127.0.0.1:3000',
      AGENTOR_INSTANCE_RECOVERY_MODE: 'true', ...env };
    appId = await root(`sudo docker run -d --name ${q(appName)} --label agentor.host-setup-fixture=${fixtureId} --network agentor-phase6-net ` +
      `--add-host agentor-kata-preflight:172.22.0.1 --mount ${q('type=bind,src=' + hostData + ',dst=/data')} ` +
      `--mount ${q('type=bind,src=' + transport + ',dst=/fixture')} --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock ` +
      `${files} ${publish} ${Object.entries(values).map(([name, value]) => '-e ' + q(name + '=' + value)).join(' ')} ${q(image)} node .output/server/index.mjs`);
    expect(appId).toMatch(/^[a-f0-9]{64}$/);
    await expect.poll(async () => { try { return (await request('/api/health')).status; } catch { return 0; } }, { timeout: 90_000 }).toBe(200);
  };
  try {
    // Fail read-only before staging/install if root has not deliberately arranged the shared listener.
    expect(await root("sudo incus --force-local config get core.https_address")).toBe('172.22.0.1:8443');
    expect(await root('sudo test -d /sys/module/br_netfilter && findmnt -n -o UUID --target /mnt/kata-extra'))
      .toBe('3b92cc64-d51d-4111-93dd-6de56440529b');
    for (const pinned of [{ tag: context.workerImage, id: context.workerImageId }, { tag: context.appBaseImage, id: context.appBaseImageId }])
      expect(await root(`sudo docker image inspect ${q(pinned.tag)} --format '{{.Id}}'`)).toBe(pinned.id);
    await root(`sudo python3 -c ${q("import shutil,socket;assert shutil.disk_usage('/mnt/kata-extra').free>=40*1024**3;s=socket.socket();s.bind(('172.22.0.1',18447));s.close()")}`);
    const original = await snapshot(); await writeFile(join(local, 'original-resources.json'), JSON.stringify(original), { mode: 0o600, flag: 'wx' });
    const assertOriginal = async () => { const now = await snapshot(); for (const [key, value] of Object.entries(original)) expect(now[key], key).toBe(value); };
    const repo = fileURLToPath(new URL('../../', import.meta.url)), output = join(repo, 'orchestrator/.output');
    const manifest = JSON.parse(await readFile(join(output, 'server/incus-bootstrap/manifest.json'), 'utf8')) as
      { version: number; files: Array<{ name: string; size: number; mode: number; sha256: string }> };
    expect(manifest.version).toBe(1); expect(manifest.files).toHaveLength(12);
    for (const relative of ['scripts', 'worker', 'worker/vm']) {
      const stat = await lstat(join(repo, relative)); expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
    }
    await mkdir(build); await mkdir(tree); await mkdir(join(tree, 'scripts')); await mkdir(join(tree, 'worker')); await mkdir(join(tree, 'worker/vm'));
    const vmFiles = (await import('node:fs/promises')).readdir;
    const canonical = ['scripts/build-incus-worker-image.sh', 'worker/entrypoint.sh',
      ...(await vmFiles(join(repo, 'worker/vm'))).map(name => 'worker/vm/' + name).sort()];
    expect(canonical).toHaveLength(12);
    expect(manifest.files.map(file => file.name).sort()).toEqual([...canonical].sort());
    for (const name of [...canonical, ...scripts.map(name => 'scripts/' + name)]) {
      const source = join(repo, name), stat = await lstat(source); expect(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024).toBe(true);
      if (canonical.includes(name)) expect(manifest.files.find(file => file.name === name)).toEqual({ name, size: stat.size,
        mode: stat.mode & 0o777, sha256: createHash('sha256').update(await readFile(source)).digest('hex') });
      await copyFile(source, join(tree, name)); await (await import('node:fs/promises')).chmod(join(tree, name), stat.mode & 0o777);
    }
    await cp(output, join(build, 'app-output'), { recursive: true, verbatimSymlinks: true });
    await cp(join(output, 'server/instance-restore-native'), join(build, 'instance-restore-native'), { recursive: true, verbatimSymlinks: true });
    for (const name of ['instance-restore-helper.mjs', 'volume-mount-helper.py', 'incus-volume-live-helper.py']) await copyFile(join(repo, 'orchestrator', name), join(build, name));
    await writeFile(join(build, 'Dockerfile'), await readFile(join(repo, 'tests/fixtures/instance-native-app.Dockerfile'), 'utf8'));
    phase = 'isolated current package and trusted source staging';
    await root(`test ! -e ${q(remote)} && mkdir -m 700 ${q(remote)} ${q(hostData)} ${q(transport)} && sudo test ! -e ${q(scratch)} && sudo mkdir -m 700 ${q(scratch)}`);
    await run('scp', [...scp, '-r', build, tree, join(local, 'data'), 'kata-test@172.19.0.1:' + remote + '/'], { timeout: 60_000 });
    imageId = await root(`sudo docker build -q --label agentor.host-setup-fixture=${fixtureId} --build-arg BASE_IMAGE=${q(context.appBaseImage)} -t ${q(image)} ${q(remote + '/image')}`, 180_000);
    expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/); await launch({ INCUS_ENABLED: 'false' });
    const admin = { email: 'setup-' + fixtureId + '@agentor.test', password: randomBytes(24).toString('base64url'), name: 'Host setup acceptance' };
    const created = await request<{ id: string; role: string }>('/api/setup/create-admin', admin); expect(created.status).toBe(201); expect(created.body.role).toBe('admin');
    const owner = created.body.id; expect(owner).toMatch(/^[A-Za-z0-9_-]+$/);
    const login = `const fs=await import('node:fs');const b='http://127.0.0.1:3000';const r=await fetch(b+'/api/auth/sign-in/email',{method:'POST',headers:{Origin:b,'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({ email: admin.email, password: admin.password }))}});if(!r.ok)throw Error('Sign-in failed');const v=await r.json();if(v.user?.id!==${JSON.stringify(owner)}||v.user?.role!=='admin')throw Error('Wrong session');const c=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(!c)throw Error('Missing cookie');fs.writeFileSync('/fixture/session',c,{mode:384,flag:'wx'});console.log('Private admin session prepared');`;
    expect(await root(`sudo docker exec ${appId} node --input-type=module -e ${q(login)}`)).toBe('Private admin session prepared');
    const installer = `sudo bash ${q(remote + '/trusted/scripts/setup-incus-host.sh')} --orchestrator-container ${q(appName)} --docker-network agentor-phase6-net ` +
      `--project ${project} --network ${network} --storage-pool ${pool} --tls-name agentor-kata-preflight --https-port 8443 --policy-port 18447 --internal-port 3079 ` +
      `--trusted-worker-image ${q(context.workerImage)} --image-work-dir ${q(scratch)}`;
    console.info('Exact owned setup progress context; root monitors private receipt/artifact progress without replay',
      { fixtureId, local, remote, scratch, installation, project, network, pool });
    phase = 'first real operator setup/default conversion (monitor private phase/files; never replay unknown dispatch)';
    // The nested builder owns its 45-minute conversion deadline. Transport
    // also includes setup/download/import; expiration never authorizes replay.
    const first = outputs(await root(installer, 55 * 60_000)), firstConfig = await config();
    await writeFile(join(local, 'setup-config-first.json'), JSON.stringify(firstConfig), { mode: 0o600, flag: 'wx' });
    expect(firstConfig).toMatchObject({ installation, project, network, pool, listen: '172.22.0.1',
      defaultImage: { phase: 'ready', sourceImageId: context.workerImageId } });
    expect(first.INCUS_CONVERTER_SEED_FINGERPRINT).toBe(firstConfig.defaultImage.fingerprint);
    expect(first.INCUS_WORKER_IMAGE).toBe(firstConfig.defaultImage.alias); expect(first.INCUS_API_HOST_ADDRESS).toBe('172.22.0.1');
    expect(first.INCUS_PROJECT).toBe(project); expect(first.INCUS_STORAGE_POOL).toBe(pool);
    await assertOriginal();
    const certificates = await root(`sudo sha256sum ${['client.crt', 'client.key', 'server.crt', 'policy.crt'].map(name => q(certificateDir + '/' + name)).join(' ')}`);
    phase = 'second actual operator setup/idempotent reuse';
    expect(outputs(await root(installer, 180_000))).toEqual(first); expect(await config()).toEqual(firstConfig);
    expect(await root(`sudo sha256sum ${['client.crt', 'client.key', 'server.crt', 'policy.crt'].map(name => q(certificateDir + '/' + name)).join(' ')}`)).toBe(certificates);
    await assertOriginal();
    const env = { INCUS_ENABLED: 'true', INCUS_ENDPOINT: first.INCUS_ENDPOINT!, INCUS_PROJECT: project, INCUS_NETWORK: network,
      INCUS_STORAGE_POOL: pool, INCUS_CONVERTER_STORAGE_POOL: first.INCUS_CONVERTER_STORAGE_POOL!, INCUS_WORKER_IMAGE: first.INCUS_WORKER_IMAGE!,
      INCUS_CONVERTER_SEED_FINGERPRINT: first.INCUS_CONVERTER_SEED_FINGERPRINT!, INCUS_NETWORK_HOST_ENDPOINT: first.INCUS_NETWORK_HOST_ENDPOINT!,
      INCUS_INTERNAL_GATEWAY_URL: first.INCUS_INTERNAL_GATEWAY_URL!, INCUS_WORKER_GATEWAY: first.INCUS_WORKER_GATEWAY!, INCUS_INTERNAL_PORT: first.INCUS_INTERNAL_PORT!,
      INCUS_CLIENT_CERT_PATH: '/run/agentor-incus/client.crt', INCUS_CLIENT_KEY_PATH: '/run/agentor-incus/client.key',
      INCUS_SERVER_CERT_PATH: '/run/agentor-incus/server.crt', INCUS_NETWORK_HOST_SERVER_CERT_PATH: '/run/agentor-incus/policy.crt' };
    phase = 'current controller redeploy using generated restricted project/four readonly files'; await launch(env, true);
    const controller = await inspect(appId); expect(controller.Mounts.filter(mount => mount.Destination.startsWith('/run/agentor-incus/'))).toHaveLength(4);
    for (const name of ['client.crt', 'client.key', 'server.crt', 'policy.crt']) expect(controller.Mounts.find(mount => mount.Destination === '/run/agentor-incus/' + name))
      .toMatchObject({ Type: 'bind', Source: certificateDir + '/' + name, RW: false });
    expect(controller.Mounts.some(mount => mount.Source.startsWith('/var/lib/incus') || mount.Destination.startsWith('/var/lib/incus'))).toBe(false);
    await root(`sudo bash ${q(remote + '/trusted/scripts/setup-incus-host.sh')} --routing --config ${q(configPath)}`);
    const checker = `sudo bash ${q(remote + '/trusted/scripts/check-incus-host.sh')} --endpoint ${q(first.INCUS_ENDPOINT!)} --project ${project} --network ${network} --storage-pool ${pool} ` +
      `--client-cert-path ${q(certificateDir + '/client.crt')} --client-key-path ${q(certificateDir + '/client.key')} --server-cert-path ${q(certificateDir + '/server.crt')} ` +
      `--network-host-endpoint ${q(first.INCUS_NETWORK_HOST_ENDPOINT!)} --network-host-server-cert-path ${q(certificateDir + '/policy.crt')} --installation-id ${installation} ` +
      `--docker-network agentor-phase6-net --orchestrator-container ${q(appName)} --internal-gateway-url ${q(first.INCUS_INTERNAL_GATEWAY_URL!)} ` +
      `--source-nat-table ${q(firstConfig.sourceTable)} --connect-address 172.22.0.1`;
    phase = 'actual read-only post-redeploy checker';
    const checked = await root(checker); expect(checked).toContain('Read-only prerequisites checked'); expect(checked).not.toMatch(/FAIL |UNKNOWN /);
    await writeFile(join(local, 'checker.txt'), checked, { mode: 0o600, flag: 'wx' });
    await mkdir(join(local, 'tls'), { mode: 0o700 });
    for (const name of ['client.crt', 'client.key', 'server.crt']) {
      const copy = transport + '/' + name;
      await root(`sudo test ! -e ${q(copy)} && sudo cp --no-clobber ${q(certificateDir + '/' + name)} ${q(copy)} && sudo chown kata-test:kata-test ${q(copy)} && sudo chmod 600 ${q(copy)}`);
      await run('scp', [...scp, 'kata-test@172.19.0.1:' + copy, join(local, 'tls', name)], { timeout: 30_000 });
    }
    client = new IncusClient({ endpoint: process.env.INCUS_ENDPOINT, project, clientCertPath: join(local, 'tls/client.crt'),
      clientKeyPath: join(local, 'tls/client.key'), serverCertPath: join(local, 'tls/server.crt') });
    expect((await client.getReadiness()).ready).toBe(true);
    const derived = incusImageIdentity(await client.getImage(firstConfig.defaultImage.fingerprint));
    expect(derived).toMatchObject({ sourceImageId: context.workerImageId, recipeId: firstConfig.defaultImage.recipeId });
    phase = 'real authenticated default Incus worker create/start/data/source-identity canary';
    const environment = await request<{ id: string }>('/api/environments', { name: 'Setup default canary', networkMode: 'full', dockerEnabled: false, cpuLimit: 1, memoryLimit: '1024m' });
    expect(environment.status).toBe(201);
    const createdWorker = await request<Worker>('/api/containers', { displayName: 'Setup canary', environmentId: environment.body.id }, 'POST', 300_000);
    expect(createdWorker.status).toBe(201); worker = createdWorker.body; expect(worker).toMatchObject({ runtimeKind: 'incus-vm', userId: owner, status: 'running' });
    expect(worker.containerName).toBe(prefix + '-' + worker.id);
    const vm = await client.getInstance(worker.containerName); incarnation = vm.config['volatile.uuid'];
    expect(incarnation).toMatch(/^[a-f0-9-]{36}$/); expect(worker.containerId).toBe('incus:' + incarnation);
    expect(vm.config).toMatchObject({ 'user.agentor.installation': installation, 'user.agentor.id': worker.id, 'user.agentor.owner': owner,
      'volatile.base_image': firstConfig.defaultImage.fingerprint });
    expect(vm.devices.eth0).toMatchObject({ network, 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true', 'security.mac_filtering': 'true' });
    const guest = await client.exec(worker.containerName, ['bash', '-ec',
      'test "$(cat /proc/1/comm)" = systemd; systemctl is-active --quiet incus-agent agentor-worker.service; ' +
      'runuser -u agent -- sudo -n true; runuser -u agent -- tmux has-session -t main; ' +
      'test ! -e /run/agentor-incus/client.key; test ! -e /run/agentor-incus/client.crt; ' +
      'printf setup-canary >/workspace/setup-canary; printf setup-agent >/home/agent/.agent-data/setup-canary; ' +
      'curl --max-time 10 -fsS ' + q(first.INCUS_INTERNAL_GATEWAY_URL! + '/api/worker-self/info')]);
    expect(guest.returnCode).toBe(0); expect(JSON.parse(guest.stdout).workerId).toBe(worker.id);
    expect((await request('/editor/' + worker.id + '/?folder=/workspace')).status).toBe(200);
    expect((await request('/desktop/' + worker.id + '/agentor.html')).status).toBe(200);
    const lease = resolveIncusPrimaryLease(vm, await client.listInstances(), await client.getNetwork(network), await client.getNetworkLeases(network), network);
    expect(lease.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect((await request('/api/containers/' + worker.id + '/stop', {}, 'POST', 120_000)).status).toBe(200);
    expect((await request('/api/containers/' + worker.id + '/restart', {}, 'POST', 300_000)).status).toBe(200);
    const restarted = await client.getInstance(worker.containerName); expect(restarted.config['volatile.uuid']).toBe(incarnation);
    const persisted = await client.exec(worker.containerName, ['bash', '-ec', 'test "$(cat /workspace/setup-canary)" = setup-canary; test "$(cat /home/agent/.agent-data/setup-canary)" = setup-agent']);
    expect(persisted.returnCode).toBe(0); await assertOriginal();
    const current = await client.getInstance(worker.containerName); expect(current.config['volatile.uuid']).toBe(incarnation);
    expect((await request('/api/containers/' + worker.id, undefined, 'DELETE', 120_000)).status).toBe(200);
    await expect(client.getInstance(worker.containerName)).rejects.toMatchObject({ statusCode: 404 }); worker = undefined;
    for (const role of ['workspace', 'agents', 'docker']) await expect(client.getCustomVolume(pool, current.name + '-' + role)).rejects.toMatchObject({ statusCode: 404 });
    await assertOriginal(); complete = true;
    await writeFile(join(local, 'accepted-context.json'), JSON.stringify({ fixtureId, local, remote, hostData, scratch, installation, appId, imageId,
      project, network, pool, configPath, first, firstConfig, checker, certificates, original }, null, 2), { mode: 0o600, flag: 'wx' });
    console.info('Actual setup/repeated reuse/checker/default canary accepted; exact installed fixtures retained for subsequent root-only gates',
      { fixtureId, local, remote, appId, imageId, installation, project, network, pool, fingerprint: derived.fingerprint });
  } finally {
    // Installer effects are intentional operator state. Never destroy a partial
    // installation or replay uncertain image/guest operations from its names.
    if (!complete) console.error('Owned setup fixture retained without guessed cleanup', { fixtureId, local, remote, phase, appId, imageId, workerId: worker?.id, incarnation });
    client?.dispose();
  }
});
