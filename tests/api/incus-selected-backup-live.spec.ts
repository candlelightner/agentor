import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { StorageManager } from '../../orchestrator/server/utils/storage';
import { useConfig, useContainerManager, useDomainMappingStore, usePortMappingStore, useWorkerStore, useDockerService } from '../../orchestrator/server/utils/services';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { withOwnerWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { extractBundle } from '../../orchestrator/server/utils/worker-export';
import { extractIncusSelectedRestorePayload } from '../../orchestrator/server/utils/portable-managed-volume-archive';
import { INCUS_SELECTED_ARCHIVE_SCRIPT } from '../../orchestrator/server/utils/incus-selected-archive';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).usePortMappingStore ??= usePortMappingStore;
(globalThis as any).useDomainMappingStore ??= useDomainMappingStore;
(globalThis as any).useWorkerConfigStore ??= useWorkerConfigStore;

test('real production BackupManager selected native capture preserves data and current account authority without reboot or fallback', async () => {
  test.skip(process.env.INCUS_SELECTED_BACKUP_TEST !== 'true', 'Explicit serial disposable selected capture gate');
  test.setTimeout(900_000);
  const ssh = ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
    '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1'];
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const host = (script: string) => execFileSync('ssh', [...ssh, 'bash -ec ' + quote(script)], { encoding: 'utf8', timeout: 60_000 }).trim();
  const root = host('sudo -u ubuntu mktemp -d /var/tmp/agentor-selected-account.XXXXXXXX');
  if (!/^\/var\/tmp\/agentor-selected-account\.[A-Za-z0-9]+$/.test(root)) throw new Error('Invalid exact account fixture path');
  const dirs = [root + '/credentials', root + '/kilo/config', root + '/kilo/data'];
  // Host-only fixture policy mutation: one fresh GET/ETag preserves concurrent
  // unrelated restrictions. Cleanup removes ONLY this exact fixture delta.
  const policy = (add: boolean) => host('sudo python3 -c ' + quote(String.raw`
import http.client,json,socket,sys
class Unix(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX);self.sock.connect('/var/lib/incus/unix.socket')
c=Unix('localhost');c.request('GET','/1.0/projects/agentor');r=c.getresponse();body=json.loads(r.read());etag=r.getheader('ETag')
assert r.status==200 and etag and body['type']=='sync'
p=body['metadata'];cfg=p['config'];assert cfg['restricted']=='true' and cfg['restricted.devices.disk']=='allow'
delta=json.loads(sys.argv[1]);paths=[p for p in cfg.get('restricted.devices.disk.paths','').split(',') if p]
if sys.argv[2]=='add':
 assert not any(p in paths for p in delta);paths+=delta
else:
 assert all(p in paths for p in delta);paths=[p for p in paths if p not in delta]
assert paths
cfg['restricted.devices.disk.paths']=','.join(paths)
c.request('PUT','/1.0/projects/agentor',json.dumps(dict(config=cfg,description=p['description'])),{'Content-Type':'application/json','If-Match':etag})
r=c.getresponse();result=json.loads(r.read());assert r.status==200 and result['type']=='sync',result
print('Exact fixture policy delta '+sys.argv[2]+' confirmed')
`) + ' ' + quote(JSON.stringify(dirs)) + ' ' + (add ? 'add' : 'remove'));
  const serviceConfig = useConfig(), priorConfig = { ...serviceConfig };
  const config = { ...serviceConfig, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusNetwork: 'incusbr0', incusStoragePool: process.env.INCUS_TEST_STORAGE_POOL || 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  Object.assign(serviceConfig, config);
  const id = randomUUID(), userId = randomUUID(), name = 'agentor-worker-' + id;
  const dir = join(config.dataDir, 'selected-capture-' + id); await mkdir(dir, { mode: 0o700 });
  const runtime = new IncusWorkerRuntime(config), manager = useContainerManager(), store = useWorkerStore(); await store.init();
  const originalExecStream = runtime.client.execStream.bind(runtime.client);
  runtime.client.execStream = async (...args: Parameters<typeof originalExecStream>) => {
    const session = await originalExecStream(...args);
    // Dummy-account fixture only. Never add worker stderr/body logging to the
    // production transport; record bounded fixed-script failure evidence here.
    if (args[1][2] === INCUS_SELECTED_ARCHIVE_SCRIPT) {
      let diagnostic = '';
      session.stderr.on('data', chunk => { if (diagnostic.length < 16_384) diagnostic += chunk.toString().slice(0, 16_384 - diagnostic.length); });
      void session.result.then(code => {
        if (code) console.info('Dummy selected capture failed', { path: args[1][3], code, diagnostic });
      }).catch(() => {});
    }
    return session;
  };
  const storage = new StorageManager({} as any, config); storage.dataHostPath = root; storage.getUserHostDir = () => root;
  const prior = { runtime: (manager as any).incusRuntime, storage: (manager as any).storageManager,
    workerStore: (manager as any).workerStore, environmentStore: (manager as any).environmentStore };
  manager.setIncusRuntime(runtime); manager.setStorageManager(storage); manager.setWorkerStore(store);
  const environment = { id: randomUUID(), name: 'Selected capture fixture', dockerEnabled: false, networkMode: 'full', allowedDomains: [],
    setupScript: '', envVars: '', exposeApis: { portMappings: false, domainMappings: false, usage: false }, cpuLimit: 1, memoryLimit: '1GiB' };
  manager.setEnvironmentStore({ getById: () => environment } as any);
  const backup = new BackupManager({ dataDir: config.dataDir }), docker = useDockerService(), originalArchive = docker.getArchive;
  docker.getArchive = async () => { throw new Error('Native selection must never call Docker archive'); };
  const opts = { id, userId, containerName: name, dockerEnabled: false, start: false, recreationNonce: randomUUID(),
    cpuLimit: 1, memoryLimit: '1GiB', userEnv: zeroUserEnvVars(userId), storageManager: storage,
    environmentJson: environment, workerJson: { id, displayName: 'Selected native capture', repos: [], initScript: '', gitName: '', gitEmail: '' },
    capabilitiesJson: [], instructionsJson: [] } satisfies IncusWorkerOptions;
  let submitted = false, cleaned = false, policyAdded = false, incarnation: string | undefined;
  const exec = async (command: string[]) => {
    const result = await runtime.client.exec(name, command); expect(result.returnCode, result.stderr).toBe(0); return result.stdout;
  };
  const capture = async (paths: string[], suffix: string) => {
    const destination = join(dir, suffix + '.tar'), controller = new AbortController();
    await withOwnerWorkerLifecycleMutation(userId, id, () =>
      (backup as any).exportWorkspaceBundleWithLifecycleFenceHeld(userId, id, destination, controller.signal, paths));
    return destination;
  };
  try {
    host('sudo -u ubuntu mkdir -p ' + dirs.map(quote).join(' ') + '; sudo -u ubuntu chmod 700 ' + dirs.map(quote).join(' ') +
      '; sudo -u ubuntu python3 -c ' + quote("import os,sys;root=sys.argv[1]\nfor n in ('claude','codex','gemini'):\n p=root+'/credentials/'+n+'.json';open(p,'wb').write(b'dummy-selected-account-'+n.encode());os.chmod(p,0o600)\nopen(root+'/kilo/data/auth.json','wb').write(b'dummy-selected-kilo')") + ' ' + quote(root));
    policyAdded = true; policy(true);
    await store.upsert({ id, userId, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'running',
      displayName: 'Selected capture fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    console.info('Exact selected production fixture', { dir, root, id, userId, nonce: opts.recreationNonce, installation: await backupInstallationId(config.dataDir) });
    submitted = true;
    const created = await runtime.create(opts); incarnation = created.config['volatile.uuid']; expect(incarnation).toBeTruthy();
    await runtime.start(opts, incarnation);
    manager.registerExternal({ id, userId, containerName: name, containerId: 'incus:' + incarnation, runtimeKind: 'incus-vm',
      status: 'running', displayName: 'Selected capture fixture', environmentId: environment.id,
      imageName: config.incusWorkerImage, imageId: created.config['volatile.base_image'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    await exec(['python3', '-c', String.raw`
import os,struct
p='/workspace/selected [literal]*';os.mkdir(p);os.chmod(p,0o751);os.chown(p,1000,1000)
open(p+'/data','wb').write(bytes([0,255,128,10,61,0])*1024)
os.chown(p+'/data',12345,23456);os.chmod(p+'/data',0o640)
os.setxattr(p+'/data','user.binary',bytes([0,255,128,10,61,0]))
os.setxattr(p+'/data','security.capability',struct.pack('<IIIII',0x02000001,1<<10,0,0,0))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,34567),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p+'/data','system.posix_acl_access',acl);os.setxattr(p,'system.posix_acl_default',acl)
os.link(p+'/data',p+'/hard');os.symlink('/external/data',p+'/absolute');os.mkfifo(p+'/nonportable-fifo')
os.utime(p+'/data',ns=(1700000000123456789,1700000000987654321))
os.mkdir(p+'/nested');open('/etc/agentor-selected-fixture','wb').write(b'outside-workspace-selected-file')
os.chmod('/etc/agentor-selected-fixture',0o644)
`]);
    await exec(['mount', '-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', '/workspace/selected [literal]*/nested']);
    await exec(['python3', '-c', "open('/workspace/selected [literal]*/nested/secret','w').write('nested-not-selected')"]);
    const expectedMetadata = JSON.parse(await exec(['python3', '-c', String.raw`
import base64,json,os
p='/workspace/selected [literal]*'
print(json.dumps(dict(attrs={key:base64.b64encode(os.getxattr(p+'/data',key)).decode()
 for key in ('user.binary','system.posix_acl_access','security.capability')},
 default=base64.b64encode(os.getxattr(p,'system.posix_acl_default')).decode())))
`]));
    const before = await runtime.client.getInstance(name), boot = await exec(['cat', '/proc/sys/kernel/random/boot_id']);
    const pid = await exec(['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service']);
    const paths = ['/workspace/selected [literal]*', '/etc/agentor-selected-fixture', '/home/agent/.codex/auth.json', '/home/agent/.local/share/kilo'];
    const bundle = await capture(paths, 'selected'), extracted = await extractBundle(bundle, join(dir, 'extracted'));
    expect(extracted.manifest.runtime?.kind).toBe('incus-vm'); expect(extracted.manifest.contents).toMatchObject({ rootfs: false, workspace: false, agents: false, backupPaths: true });
    expect(extracted.manifest.backupPaths?.map(entry => entry.path)).toEqual(paths);
    const archives = await extractIncusSelectedRestorePayload(extracted.backupPathsPath!, extracted.manifest.backupPaths!, join(dir, 'selected-payloads'));
    const restored = join(dir, 'inspected'); await mkdir(restored);
    // Restore the exact validated fixture as root: capabilities and numeric
    // owners cannot be faithfully inspected after unprivileged extraction.
    for (const archive of archives) execFileSync('sudo', ['tar', '--xattrs', '--xattrs-include=*', '--acls', '--same-owner', '-xf', archive.archivePath, '-C', restored]);
    expect(await readFile(join(restored, 'auth.json'), 'utf8')).toBe('dummy-selected-account-codex');
    expect(await readFile(join(restored, 'kilo/auth.json'), 'utf8')).toBe('dummy-selected-kilo');
    expect(await readFile(join(restored, 'agentor-selected-fixture'), 'utf8')).toBe('outside-workspace-selected-file');
    const metadata = JSON.parse(execFileSync('sudo', ['python3', '-c', String.raw`
import base64,json,os,sys,tarfile
with tarfile.open(sys.argv[1],'r:') as t:
 p='selected [literal]*';e=t.getmember(p+'/data');s=os.stat(sys.argv[2]+'/'+p+'/data')
 print(json.dumps(dict(names=t.getnames(),uid=e.uid,gid=e.gid,mode=e.mode,mtime=str(s.st_mtime_ns),
 owner=[s.st_uid,s.st_gid],restoredMode=s.st_mode&0o7777,
 hard=s.st_ino==os.stat(sys.argv[2]+'/'+p+'/hard').st_ino,
 attrs={key:base64.b64encode(os.getxattr(sys.argv[2]+'/'+p+'/data',key)).decode() for key in ('user.binary','system.posix_acl_access','security.capability')},
 default=base64.b64encode(os.getxattr(sys.argv[2]+'/'+p,'system.posix_acl_default')).decode(),
 sha256=__import__('hashlib').sha256(open(sys.argv[2]+'/'+p+'/data','rb').read()).hexdigest())))
`, archives[0]!.archivePath, restored], { encoding: 'utf8' }));
    expect(metadata).toMatchObject({ uid: 12345, gid: 23456, mode: 0o640, mtime: '1700000000987654321', hard: true });
    expect(metadata).toMatchObject({ owner: [12345,23456], restoredMode: 0o640, ...expectedMetadata });
    expect(metadata.attrs['user.binary']).toBe(Buffer.from([0,255,128,10,61,0]).toString('base64'));
    expect(metadata.names.some((name: string) => name.includes('nested') || name.includes('fifo'))).toBe(false);
    expect(metadata.sha256)
      .toBe(createHash('sha256').update(Buffer.concat(Array.from({ length: 1024 }, () => Buffer.from([0,255,128,10,61,0])))).digest('hex'));
    for (const [path, code] of [['/', 'INCUS_DISPOSABLE_ROOTFS'], ['/run/agentor/worker.env', 'INCUS_EPHEMERAL_BACKUP_PATH'],
      ['/var/lib/docker', 'INCUS_DOCKER_BACKUP_UNAVAILABLE']] as const) await expect(capture([path], 'denied-' + code)).rejects.toMatchObject({ code });
    await exec(['python3', '-c', "open('/run/agentor/account-credentials/new-codex','wb').write(b'dummy-replaced');os=__import__('os');os.replace('/run/agentor/account-credentials/new-codex','/run/agentor/account-credentials/codex.json')"]);
    await expect(capture(['/home/agent/.codex/auth.json'], 'stale-bind')).rejects.toThrow(/Selected native archive capture failed/);
    // Capture must NOT repair the pinned bind or restart guest/services.
    expect(await exec(['cat', '/proc/sys/kernel/random/boot_id'])).toBe(boot);
    expect(await exec(['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service'])).toBe(pid);
    const after = await runtime.client.getInstance(name); expect(after.devices).toEqual(before.devices);
    expect(after.config['volatile.uuid']).toBe(incarnation);
    console.info('Production selected backup gate passed: metadata, explicit account/Kilo aliases, external readable file, literal mount/special exclusion, stale-bind denial, unchanged boot/service/native disks, zero Docker');
  } finally {
    if (submitted) {
      try {
        if (incarnation) await runtime.remove(opts, incarnation);
        else await runtime.rollbackRecreation(opts, { nonce: opts.recreationNonce, initialCreate: true });
        await runtime.removeStorage(opts); await store.delete(userId, id); (manager as any).containers.delete(id); cleaned = true;
      } catch (error) { console.error('Exact selected capture fixture retained', { dir, root, id, incarnation, error: String(error) }); }
    } else cleaned = true;
    if (cleaned && policyAdded) { policy(false); policyAdded = false; }
    if (cleaned && !policyAdded) {
      host('sudo rm -r -- ' + quote(root)); await rm(dir, { recursive: true, force: true });
    }
    docker.getArchive = originalArchive;
    Object.assign(serviceConfig, priorConfig); Object.assign(manager, { incusRuntime: prior.runtime, storageManager: prior.storage,
      workerStore: prior.workerStore, environmentStore: prior.environmentStore });
  }
  expect(cleaned, 'Exact fixture cleanup must be confirmed').toBe(true);
});
