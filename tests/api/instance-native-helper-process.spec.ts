import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp, rm, stat, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { ManagedVolumeStore, type StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import type { IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { WorkerStore, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { WorkerConfigStore, type WorkerAppliedBootstrap } from '../../orchestrator/server/utils/worker-config-store-core';
import { StorageManager } from '../../orchestrator/server/utils/storage';
import { UserCredentialManager } from '../../orchestrator/server/utils/user-credentials';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { incusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';
import type { WorkerBackupRuntimeSource } from '../../orchestrator/server/utils/worker-backup-runtime';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { backupInstallationId, readBackupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { createInstanceDataArchive, instanceVolumeArchiveName, instanceBundleFilename,
  packInstanceBundle, inspectInstanceBundle, prepareInstanceNativeVolumeArchive, sha256File, validateInstanceManifest } from '../../orchestrator/server/utils/instance-backup-bundle';
import { decryptInstanceBackup, encryptInstanceBackup, inspectInstanceBackup } from '../../orchestrator/server/utils/instance-backup-crypto';
import { backupKeyFingerprint, validateRecoveryKit } from '../../orchestrator/server/utils/backup-keyring';
import type { InstanceBackupArtifact, InstanceBackupJob, InstanceBackupManifest, InstanceRestorePreflight } from '../../orchestrator/server/utils/instance-backup-types';
import type { BackupArtifact, BackupJob } from '../../orchestrator/server/utils/backup-types';

const run = promisify(execFile);
const ssh = ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1'];
const scp = ['-P', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes'];
const root = async (command: string, timeout = 30_000) => (await run('ssh', [...ssh, command], { timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Explicit approved guest only. Real constrained helper process, Docker stop/
 * restart, compiled native adapter and Incus data inverse. The target is an
 * isolated fixture, never the preserved acceptance installation. The app
 * variants run the current production build. Only app-rest-ordinary enters
 * through public kit import/upload/preflight/restore dispatch; other variants
 * explicitly exercise the controlled helper without claiming REST admission. */
for (const mode of ['retained', 'ordinary', 'omitted', 'rollback', 'app-retained', 'app-ordinary', 'app-rollback', 'app-rest-ordinary'] as const) test(mode === 'ordinary'
  ? 'real controlled helper process restores ordinary worker Docker data with stopped intent and exact account shares'
  : mode === 'omitted' ? 'real controlled helper process restores omitted agent state with writable private account parents'
  : mode === 'rollback' ? 'real controlled helper process rolls back acknowledged native data before restoring original control plane'
  : mode === 'app-retained' ? 'real running Orchestrator reloads authenticated native restore completion and retained data'
  : mode === 'app-ordinary' ? 'real running Orchestrator starts restored ordinary VM through authenticated REST with native Docker and worker identity'
  : mode === 'app-rollback' ? 'real running Orchestrator authenticates original control plane after witnessed native rollback'
  : mode === 'app-rest-ordinary' ? process.env.INCUS_ORIGINAL_PUBLIC_TEST === 'true'
    ? 'real authenticated worker backup restores its original Incus workspace without replacing other state'
    : 'real public instance restore imports an encrypted native bundle and restores ordinary VM Docker data through authenticated REST'
  : 'real controlled helper process restores retained native data and restarts only its exact recovery target', async () => {
  const originalPublic = mode === 'app-rest-ordinary' && process.env.INCUS_ORIGINAL_PUBLIC_TEST === 'true';
  const rest = mode === 'app-rest-ordinary' && !originalPublic, app = mode.startsWith('app-'), ordinary = originalPublic || rest || mode === 'app-ordinary' || mode !== 'retained' && !app,
    rollback = mode === 'rollback' || mode === 'app-rollback';
  test.skip(process.env.INCUS_INSTANCE_HELPER_PROCESS_TEST !== 'true', 'Explicit serial approved disposable helper-process gate');
  test.setTimeout(900_000);
  let retained: { version: 1; fixtureId: string; workerId: string; ownerId: string; volume: StoredManagedVolume;
    localDir: string; remoteDir: string; parentId: string; parentImageId: string; restoreJobId: string;
    failedCaptureJobId: string; incarnation: string; installation: string; source: WorkerBackupRuntimeSource;
    instance: Awaited<ReturnType<IncusWorkerRuntime['client']['getInstance']>>;
    volumes: Array<Awaited<ReturnType<IncusWorkerRuntime['client']['getCustomVolume']>>>;
    oldNft?: { table: string; json: unknown }; dockerArchive: { path: string; sha256: string } } | undefined;
  if (process.env.INCUS_INSTANCE_PRODUCER_FIXTURE_JSON) {
    if (!rest) throw new Error('Retained producer evidence only applies to app-rest-ordinary');
    const file = await open(process.env.INCUS_INSTANCE_PRODUCER_FIXTURE_JSON, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024)
        throw new Error('Retained producer parameters must be a bounded private operator file');
      retained = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (retained?.version !== 1 || retained.fixtureId !== 'ca689b40-52c9-47e3-a474-dbca60ce9570' ||
        retained.workerId !== '226664b9-08c0-4a82-8330-1b522fb29041' || retained.ownerId !== 'bec36cc0-e87e-43b5-80be-e9b2ff0e9604' ||
        retained.installation !== '910d9899-a051-413c-8e25-20142c3b90c3' || retained.incarnation !== '9ac3524c-0eee-48ec-a7f0-2f564a0ebaa2' ||
        retained.localDir !== '/tmp/agentor-native-helper-process-lvq2bi' ||
        retained.remoteDir !== '/var/tmp/agentor-native-helper-process.' + retained.fixtureId ||
        !/^3d10abd1[a-f0-9]{51}a7d6d$/.test(retained.parentId) || !/^sha256:[a-f0-9]{64}$/.test(retained.parentImageId) ||
        !/^3918948d-[a-f0-9-]{27}$/.test(retained.restoreJobId) || !/^9c6678b3-[a-f0-9-]{27}$/.test(retained.failedCaptureJobId) ||
        retained.volume.workerId !== retained.workerId || retained.volume.userId !== retained.ownerId)
      throw new Error('Retained producer parameters do not identify the explicitly approved fixture');
  }
  // Admit every ordinary source input before creating even a local fixture,
  // packaging an App or reaching SSH/Incus. Hash the verified regular file
  // through its no-follow descriptor once; later setup reuses this proof.
  let dockerSource: string | undefined, dockerSourceDigest: string | undefined;
  if (ordinary) {
    dockerSource = retained?.dockerArchive.path ?? process.env.INCUS_INSTANCE_HELPER_DOCKER_ARCHIVE;
    if (!dockerSource) throw new Error('Ordinary gate requires the accepted raw Docker archive fixture');
    const file = await open(dockerSource, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0) throw new Error('Ordinary gate requires a nonempty regular Docker archive fixture');
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      dockerSourceDigest = hash.digest('hex');
      if (retained) expect(dockerSourceDigest).toBe(retained.dockerArchive.sha256);
    } finally { await file.close(); }
  }
  const local = await mkdtemp(join(tmpdir(), 'agentor-native-helper-process-'));
  const followupNonce = randomUUID();
  const source = join(retained?.localDir ?? local, 'source'), targetData = join(local, 'data'), build = join(local, 'image');
  const id = retained?.workerId ?? randomUUID(), volumeId = retained?.volume.id ?? randomUUID(), jobId = retained?.fixtureId ?? randomUUID();
  let restoreJobId: string = retained?.restoreJobId ?? jobId;
  let userId = retained?.ownerId ?? (ordinary ? 'ordinary-' : 'retained-') + randomUUID();
  const appPort = 39000 + Number.parseInt(jobId.slice(0, 4), 16) % 1000;
  const remote = retained ? '/var/tmp/agentor-native-producer.' + followupNonce : '/var/tmp/agentor-native-helper-process.' + jobId;
  const image = 'agentor-native-helper-process:' + (retained ? followupNonce : jobId), targetName = 'native-recovery-' + (retained ? followupNonce : jobId),
    helperName = 'agentor-instance-restore-' + jobId;
  const legacyName = 'agentor-native-rollback-' + jobId;
  const stamp = new Date().toISOString();
  const volume: StoredManagedVolume = retained?.volume ?? { id: volumeId, userId, workerId: id, name: 'Retained native data',
    dockerName: 'agentor-persist-' + volumeId, target: '/srv/retained', purpose: 'persistent-path', storageRuntimeKind: 'incus-vm',
    attached: ordinary, seeded: true, state: ordinary ? 'ready' : 'detached',
    ...(!ordinary ? { retainedAfterAccountDeletion: true } : {}), createdAt: stamp, updatedAt: stamp };
  let targetId: string | undefined, helperId: string | undefined, imageId: string | undefined, completed = false, cleaned = false;
  let startupHolderId: string | undefined, helperRemovedByManager = false;
  let incarnation: string | undefined, policyAdded = false, computeSettled = true;
  let worker: WorkerRecord | undefined, options: IncusWorkerOptions | undefined;
  let stagingOwner = 'recovery-admin', restoredOwner = 'restored-admin';
  let originalInstallation: string | undefined;
  const sourceTable = 'agentor_restore_' + (retained ? followupNonce : jobId).slice(0, 8);
  let sourceRuleBaseline: string | undefined;
  const sourceRuleSnapshot = (value: string) => JSON.stringify(JSON.parse(value), (key, value) =>
    key === 'metainfo' ? undefined : key === 'counter' ? {} : value);
  let baseline: Awaited<ReturnType<IncusManagedVolumeRuntime['inspectVolume']>>;
  const config = { ...loadConfig(), dataDir: source, containerPrefix: app ? 'aphr-' + jobId.slice(0, 8) : 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusStoragePool: 'default', incusNetwork: 'incusbr0',
    incusWorkerImage: 'agentor-worker-phase10-preserve-ownership', incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key', incusServerCertPath: '/workspace/agentor-incus-tls/server.crt',
    incusDockerVolumeSize: '1GiB', incusInternalGatewayUrl: 'http://10.159.68.1:' + (app ? appPort : 38000) };
  const runtime = new IncusWorkerRuntime(config), managedRuntime = new IncusManagedVolumeRuntime(config, runtime);
  const remoteData = (retained?.remoteDir ?? remote) + '/data';
  const tlsRoot = '/var/tmp/agentor-phase6-production.SSkg3hQz/tls';
  const mounts = ['client.crt', 'client.key', 'server.crt'].map(file =>
    `--mount type=bind,src=${tlsRoot}/${file},dst=/tls/${file},readonly`);
  const admin = { email: `restore-${jobId}@agentor.test`, password: 'isolated-native-restore-' + jobId, name: 'Native Recovery Acceptance' };
  const operatorEnv = ['CONTAINER_PREFIX=' + config.containerPrefix, 'DOCKER_NETWORK=agentor-phase6-net',
    'INCUS_ENABLED=true', 'INCUS_ENDPOINT=https://agentor-kata-preflight:8443', 'INCUS_PROJECT=agentor',
    'INCUS_NETWORK=incusbr0', 'INCUS_STORAGE_POOL=default', 'INCUS_WORKER_IMAGE=agentor-worker-phase10-preserve-ownership',
    'INCUS_DOCKER_VOLUME_SIZE=1GiB', 'INCUS_INTERNAL_GATEWAY_URL=' + config.incusInternalGatewayUrl,
    'INCUS_CLIENT_CERT_PATH=/tls/client.crt', 'INCUS_CLIENT_KEY_PATH=/tls/client.key', 'INCUS_SERVER_CERT_PATH=/tls/server.crt'];
  const prepareImage = async () => {
    await run(process.execPath, [fileURLToPath(new URL('../../orchestrator/build-instance-restore-native.mjs', import.meta.url)),
      join(build, 'instance-restore-native')], { env: {}, timeout: 60_000 });
    await copyFile(fileURLToPath(new URL('../../orchestrator/instance-restore-helper.mjs', import.meta.url)), join(build, 'instance-restore-helper.mjs'));
    await copyFile(fileURLToPath(new URL(app ? '../fixtures/instance-native-app.Dockerfile' : '../fixtures/instance-native-helper.Dockerfile', import.meta.url)), join(build, 'Dockerfile'));
    if (app) await cp(fileURLToPath(new URL('../../orchestrator/.output', import.meta.url)), join(build, 'app-output'),
      { recursive: true, verbatimSymlinks: true });
    if (app) await run(process.execPath, ['--input-type=module', '-e',
      `const{default:WS}=await import(${JSON.stringify(join(build, 'app-output/server/node_modules/ws/wrapper.mjs'))});` +
      `if(typeof WS!=='function')throw Error('Fixture packaged WebSocket entry changed');`], { timeout: 10_000 });
    if (originalPublic) expect(await readFile(join(build, 'app-output/server/chunks/nitro/nitro.mjs'), 'utf8'))
      .toContain('replaceOriginalWorkspaceFromBackup'); // Cheap packaging seam before native source allocation.
    if (app) for (const file of ['volume-mount-helper.py', 'incus-volume-live-helper.py'])
      await copyFile(fileURLToPath(new URL('../../orchestrator/' + file, import.meta.url)), join(build, file));
    if (!retained) {
      await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(runtime.client.getCustomVolume(config.incusStoragePool, volume.dockerName)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect((await runtime.client.request<{ driver: string }>('GET', '/1.0/storage-pools/' + config.incusStoragePool)).driver).toBe('dir');
    await root(`test ! -e ${quote(remote)} && mkdir -m 700 ${quote(remote)}`);
    await run('scp', [...scp, '-r', targetData, build, 'kata-test@172.19.0.1:' + remote + '/'], { timeout: 60_000 });
    imageId = await root(`sudo docker build -q --label agentor.native-helper-fixture=${jobId} --build-arg REMOVE_VOLUME_HELPER_SLEEP=${rollback} -t ${quote(image)} ${quote(remote + '/image')}`, 120_000);
    expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await root(`sudo docker image inspect ${quote(image)} --format '{{.Id}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
      .toBe(imageId + ' ' + jobId);
  };
  const launchTarget = async () => {
    const args = app ? `${operatorEnv.concat(['DATA_DIR=' + remoteData, 'BETTER_AUTH_URL=http://127.0.0.1:3000'])
      .map(v => '-e ' + quote(v)).join(' ')} ` +
      `--mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock ${mounts.join(' ')}` : '';
    targetId = await root(`sudo docker run -d --name ${quote(targetName)} --label agentor.native-helper-fixture=${jobId} ` +
      `--network agentor-phase6-net --add-host agentor-kata-preflight:172.22.0.1 -e AGENTOR_INSTANCE_RECOVERY_MODE=true ` +
      `--mount type=bind,src=${remoteData},dst=${remoteData} ${app ? '-p 10.159.68.1:' + appPort + ':3000' : ''} ${args} ${quote(image)} ` +
      (app ? 'node .output/server/index.mjs' : `node -e 'setInterval(()=>{},1000)'`));
    expect(targetId).toMatch(/^[a-f0-9]{64}$/);
    if (app) {
      // Reuse the accepted Phase6 source-preservation rule on this exact App
      // IP/internal port. Own table only; no edits to Docker/Incus chains and
      // no blanket forwarding permission or worker-selected identity header.
      // Restricted project clients intentionally cannot read inherited bridge
      // configuration. Operator fixture discovery uses the authorized guest
      // CLI, never broader application credentials or a socket mount.
      const cidr = await root(`sudo incus network get ${quote(config.incusNetwork)} ipv4.address`);
      expect(cidr).toMatch(/^(?:\d+\.){3}\d+\/\d+$/);
      const dockerNetwork = JSON.parse(await root(`sudo docker network inspect agentor-phase6-net`)) as Array<{
        Id: string; Options: Record<string, string>;
      }>;
      expect(dockerNetwork[0]!.Id).toMatch(/^[a-f0-9]{64}$/);
      const bridge = dockerNetwork[0]!.Options['com.docker.network.bridge.name'] ?? 'br-' + dockerNetwork[0]!.Id.slice(0, 12);
      expect(bridge).toMatch(/^[A-Za-z0-9_.-]{1,15}$/);
      const ip = await root(`sudo docker inspect ${targetId} --format '{{(index .NetworkSettings.Networks "agentor-phase6-net").IPAddress}}'`);
      expect(ip).toMatch(/^(?:\d+\.){3}\d+$/);
      const spec = `table ip ${sourceTable} { chain postrouting { type nat hook postrouting priority 99; policy accept; ` +
        `iifname "${config.incusNetwork}" oifname "${bridge}" ip saddr ${cidr} ip daddr ${ip} tcp dport 3000 ` +
        `counter snat to ip saddr comment "agentor-restore-${jobId}";\n }\n}\n`;
      expect(await root(`sudo nft list tables`)).not.toContain('table ip ' + sourceTable);
      await root(`printf '%s\\n' ${quote(spec)} | sudo nft --check -f -`);
      await root(`printf '%s\\n' ${quote(spec)} | sudo nft -f -`);
      sourceRuleBaseline = sourceRuleSnapshot(await root(`sudo nft -j list table ip ${sourceTable}`));
    }
  };
  // Requests execute on loopback INSIDE only the exact fixture container.
  // Sign-in cookies stay inside the exact App fixture (including a private
  // producer session file) and never appear in tool/test output.
  const appRequest = async <T,>(path: string, body?: unknown, authenticated = true,
    timeoutMs = 30_000, privateFile?: { path: string; format: 'json' | 'binary' }, sessionPath?: string,
    method?: 'PUT'): Promise<{ status: number; body: T }> => {
    if (privateFile && body !== undefined) throw new Error('Fixture request cannot mix a private file and an inline body');
    if (sessionPath && !authenticated) throw new Error('Fixture private session requires an authenticated request');
    const script = `const base='http://127.0.0.1:3000';const headers={Origin:base,'Content-Type':'application/json'};` +
      (sessionPath ? `const{readFileSync:readSession,lstatSync:statSession}=await import('node:fs');const sp=${JSON.stringify(sessionPath)};` +
        `const ss=statSession(sp);if(!ss.isFile()||ss.isSymbolicLink()||(ss.mode&63)!==0)throw Error('Fixture session is not private');headers.Cookie=readSession(sp,'utf8');`
        : authenticated ? `const signed=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers,body:${JSON.stringify(JSON.stringify(admin))}});` +
        `if(!signed.ok)throw new Error('Fixture sign-in failed '+signed.status);headers.Cookie=signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');` : '') +
      (privateFile ? `const fs=await import('node:fs');const p=${JSON.stringify(privateFile.path)};const s=fs.lstatSync(p);` +
        `if(!s.isFile()||s.isSymbolicLink())throw Error('Fixture input is not a private regular file');` +
        (privateFile.format === 'binary' ? `headers['Content-Type']='application/octet-stream';headers['Content-Length']=String(s.size);` : '') : '') +
      `const r=await fetch(base+${JSON.stringify(path)},{headers,redirect:'manual'` +
      (privateFile ? `,method:'POST',body:${privateFile.format === 'binary' ? "fs.createReadStream(p),duplex:'half'" : "fs.readFileSync(p,'utf8')"}`
        : body === undefined ? '' : ",method:" + JSON.stringify(method ?? 'POST') + ',body:' + JSON.stringify(JSON.stringify(body))) + `});` +
      `console.log(JSON.stringify({status:r.status,body:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text()}));`;
    try {
      return JSON.parse(await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(script)}`, timeoutMs));
    } catch {
      // execFile errors include command arguments. Never print the synthetic
      // sign-in password or any cookie-bearing child-process diagnostics.
      throw new Error('Running fixture request failed: ' + path);
    }
  };
  const accountPaths = () => ['credentials', 'kilo/config', 'kilo/data'].map(path => remoteData + '/users/' + userId + '/' + path);
  // Same exact fixture-only ETag delta used by accepted native account gates.
  // No change to production restrictions or generic host-path authorization.
  const policy = (add: boolean) => root('sudo python3 -c ' + quote(String.raw`
import http.client,json,socket,sys
class Unix(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX);self.sock.connect('/var/lib/incus/unix.socket')
c=Unix('localhost');c.request('GET','/1.0/projects/agentor');r=c.getresponse();b=json.loads(r.read());etag=r.getheader('ETag')
assert r.status==200 and etag and b['type']=='sync'
p=b['metadata'];cfg=p['config'];assert cfg['restricted']=='true' and cfg['restricted.devices.disk']=='allow'
delta=json.loads(sys.argv[1]);paths=cfg.get('restricted.devices.disk.paths','').split(',')
if sys.argv[2]=='add':
 assert not any(x in paths for x in delta);paths+=delta
else:
 assert all(x in paths for x in delta);paths=[x for x in paths if x not in delta]
assert paths;cfg['restricted.devices.disk.paths']=','.join(paths)
c.request('PUT','/1.0/projects/agentor',json.dumps(dict(config=cfg,description=p['description'])),{'Content-Type':'application/json','If-Match':etag})
r=c.getresponse();b=json.loads(r.read());assert r.status==200 and b['type']=='sync',b
print('Exact account fixture delta confirmed')
`) + ' ' + quote(JSON.stringify(accountPaths())) + ' ' + (add ? 'add' : 'remove'));
  const runProducer = async (expectedSource: WorkerBackupRuntimeSource, installation: string) => {
    // Exercise the actual producer as well as the inverse: default SQLite
    // online backup, real quiescence checks, native inventory/capture and
    // encrypted publication through the configured local provider.
    if (retained) {
      // Read real current Docker proof, not guesses from an older archive.
      // Start/stop the SAME pinned VM once; never recreate or import its data.
      computeSettled = false;
      const started = await appRequest<{ ok: boolean }>('/api/containers/' + id + '/restart', {}, true, 360_000);
      expect(started.status).toBe(200); expect(started.body).toEqual({ ok: true });
      const current = await runtime.client.getInstance(options!.containerName);
      expect(current.config['volatile.uuid']).toBe(retained.incarnation);
      expect(await runtime.matchesWorkerIdentity(current, id, userId)).toBe(true); computeSettled = true;
    }
    const dockerProof = await runtime.client.exec(options!.containerName, ['bash', '-ec',
      'docker image inspect --format "{{.Id}}" agentor-archive-lower:proof; ' +
      'docker container inspect --format "{{.Id}}" archive-layer archive-stopped; ' +
      'base64 -w0 "$(docker volume inspect --format "{{.Mountpoint}}" archive-data)/ordinary"; echo']);
    expect(dockerProof.returnCode, dockerProof.stderr).toBe(0);
    const dockerProofLines = dockerProof.stdout.trim().split('\n'); expect(dockerProofLines).toHaveLength(4);
    const dockerIds = dockerProofLines.slice(0, 3), dockerVolumeBytes = Buffer.from(dockerProofLines[3]!, 'base64');
    expect(dockerVolumeBytes.length).toBeGreaterThan(0); expect(dockerVolumeBytes.toString().trim()).toBe('persistent');
    expect(dockerIds[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const container of dockerIds.slice(1)) expect(container).toMatch(/^[a-f0-9]{64}$/);
    const stopped = await appRequest<{ ok: boolean }>('/api/containers/' + id + '/stop', {}, true, 360_000);
    expect(stopped.status).toBe(200); expect(stopped.body).toEqual({ ok: true });
    const sourceInstance = await runtime.client.getInstance(options!.containerName);
    expect(sourceInstance.status).toBe('Stopped'); expect(sourceInstance.config['volatile.uuid']).toBe(incarnation);
    expect(await runtime.matchesWorkerIdentity(sourceInstance, id, userId)).toBe(true);
    const sourceNames = [...['workspace', 'agents', 'docker'].map(role => options!.containerName + '-' + role), volume.dockerName];
    const sourceVolumes = await Promise.all(sourceNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
    const privateRoot = '/tmp/agentor-producer-' + jobId, sessionFile = privateRoot + '/session',
      keyFile = privateRoot + '/recovery.json', encryptedFile = privateRoot + '/instance.backup';
    // Prepare one real session and freshly reauthenticated active key BEFORE
    // taking the write barrier. Polling uses that private cookie without an
    // auth POST or a waiver. Raw material stays outside snapshotted DATA_DIR.
    const prepare = `const fs=await import('node:fs');const base='http://127.0.0.1:3000';` +
      `const h={Origin:base,'Content-Type':'application/json'};` +
      `const signed=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:h,body:${JSON.stringify(JSON.stringify(admin))}});` +
      `if(!signed.ok)throw Error('Private producer sign-in failed');h.Cookie=signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');` +
      `const revealed=await fetch(base+'/api/backups/recovery-key/reveal',{method:'POST',headers:h,body:JSON.stringify({password:${JSON.stringify(admin.password)}})});` +
      `if(!revealed.ok)throw Error('Private producer reauthentication failed');const key=await revealed.json();` +
      `if(typeof key.keyMaterial!=='string'||typeof key.fingerprint!=='string')throw Error('Private producer key response invalid');` +
      `fs.mkdirSync(${JSON.stringify(privateRoot)},{mode:448});` +
      `fs.writeFileSync(${JSON.stringify(sessionFile)},h.Cookie,{mode:384,flag:'wx'});` +
      `fs.writeFileSync(${JSON.stringify(keyFile)},JSON.stringify(key),{mode:384,flag:'wx'});console.log(JSON.stringify({ready:true,fingerprint:key.fingerprint}));`;
    let keyFingerprint: string;
    try {
      const prepared = JSON.parse(await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(prepare)}`)) as { ready: boolean; fingerprint: string };
      expect(prepared.ready).toBe(true); expect(prepared.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/); keyFingerprint = prepared.fingerprint;
    } catch { throw new Error('Private producer session/key preparation failed'); }
      const capture = await appRequest<{ accepted: boolean; jobId: string }>('/api/admin/instance-backups',
        { provider: 'local', options: { includeWorkers: true, includeAgentData: true, includeDockerVolumes: true,
          includeLocalBackups: false, includeLogs: false }, requestId: (retained ? followupNonce : jobId) + '-capture' }, true, 30_000, undefined, sessionFile);
    expect(capture.status).toBe(202); expect(capture.body.accepted).toBe(true); expect(capture.body.jobId).toMatch(/^[a-f0-9-]{36}$/);
    await expect.poll(async () => {
      const state = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + capture.body.jobId,
        undefined, true, 30_000, undefined, sessionFile);
      expect(state.status).toBe(200); expect(state.body).not.toHaveProperty('restoreHelper');
      if (state.body.status === 'failed') throw new Error('Actual producer failed: ' + (state.body.errorCode ?? 'unknown'));
      return state.body.status;
    }, { timeout: 600_000, intervals: [1000, 2000] }).toBe('succeeded');
    const published = await appRequest<InstanceBackupArtifact>('/api/admin/instance-backups/artifacts/' + capture.body.jobId,
      undefined, true, 30_000, undefined, sessionFile);
    expect(published.status).toBe(200); expect(published.body).toMatchObject({ id: capture.body.jobId, userId,
      provider: 'local', formatVersion: 2, integrityStatus: 'verified', keyFingerprint, sourceInstallationId: installation });
    const download = `const fs=await import('node:fs');const{Readable}=await import('node:stream');const{pipeline}=await import('node:stream/promises');` +
      `const r=await fetch('http://127.0.0.1:3000/api/admin/instance-backups/artifacts/${capture.body.jobId}/download',` +
      `{headers:{Cookie:fs.readFileSync(${JSON.stringify(sessionFile)},'utf8')},redirect:'manual'});` +
      `if(r.status!==200||!r.body||Number(r.headers.get('content-length'))!==${published.body.size})throw Error('Private producer download failed');` +
      `await pipeline(Readable.fromWeb(r.body),fs.createWriteStream(${JSON.stringify(encryptedFile)},{mode:384,flags:'wx'}));` +
      `if(fs.statSync(${JSON.stringify(encryptedFile)}).size!==${published.body.size})throw Error('Private producer download length changed');console.log('Private encrypted producer download complete');`;
    try { await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(download)}`, 180_000); }
    catch { throw new Error('Private encrypted producer download failed'); }
    expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
      .toBe(`${targetId} ${imageId} ${jobId}`);
    // Only exact known private regular files are exported. The cookie never
    // leaves the App; key transfer has no stdout and remains mode0600.
    for (const [from, name] of [[encryptedFile, 'captured.backup'], [keyFile, 'captured-key.json']] as const) {
      await root(`sudo docker exec ${targetId} test -f ${quote(from)} && sudo docker exec ${targetId} test ! -L ${quote(from)}`);
      await root(`sudo docker cp ${targetId}:${quote(from)} ${quote(remote + '/export-' + name)} && ` +
        `sudo install -o kata-test -m 600 ${quote(remote + '/export-' + name)} ${quote(remote + '/' + name)}`);
      await run('scp', [...scp, 'kata-test@172.19.0.1:' + remote + '/' + name, join(local, name)], { timeout: 60_000 });
      const exported = await lstat(join(local, name)); expect(exported.isFile() && !exported.isSymbolicLink()).toBe(true);
      expect(exported.mode & 0o077).toBe(0);
    }
    let recovery: { keyMaterial: string; fingerprint: string };
    try { recovery = JSON.parse(await readFile(join(local, 'captured-key.json'), 'utf8')); }
    catch { throw new Error('Private producer recovery file invalid'); }
    expect(backupKeyFingerprint(recovery.keyMaterial)).toBe(keyFingerprint);
    const encryptedHeader = await inspectInstanceBackup(join(local, 'captured.backup'));
    expect(encryptedHeader.keyFingerprint).toBe(keyFingerprint); expect(encryptedHeader.metadata.backupId).toBe(capture.body.jobId);
    const capturedBundle = join(local, 'captured.tar'), capturedRoot = join(local, 'captured-unpacked'), rawRoot = join(local, 'captured-raw');
    await decryptInstanceBackup(join(local, 'captured.backup'), capturedBundle, recovery.keyMaterial, published.body.sha256);
    const captured = await inspectInstanceBundle(capturedBundle, capturedRoot);
    expect(captured.manifest).toMatchObject({ formatVersion: 2, backupId: capture.body.jobId, createdByUserId: userId,
      sourceInstallationId: installation, options: { includeWorkers: true, includeAgentData: true, includeDockerVolumes: true } });
    expect(captured.manifest.volumes.map(v => v.runtime?.role).sort()).toEqual(['agents', 'docker', 'managed', 'workspace']);
    const capturedWorkers = JSON.parse((await run('tar', ['-xzOf', captured.dataArchivePath, '--', 'users/' + userId + '/workers.json'])).stdout) as WorkerRecord[];
    expect(capturedWorkers).toHaveLength(1); expect(capturedWorkers[0]).toMatchObject({ id, userId, runtimeKind: 'incus-vm', desiredRuntimeStatus: 'stopped' });
    const snapshotDb = join(local, 'captured-auth.db');
    await writeFile(snapshotDb, (await run('tar', ['-xzOf', captured.dataArchivePath, '--', 'auth.db'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout, { mode: 0o600 });
    const sqlite = JSON.parse((await run('python3', ['-c',
      'import json,sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(dict(integrity=c.execute("pragma integrity_check").fetchone()[0],user=c.execute("select id,email,role from user where id=?",(sys.argv[2],)).fetchone()))); c.close()',
      snapshotDb, userId])).stdout);
    expect(sqlite).toEqual({ integrity: 'ok', user: [userId, admin.email, 'admin'] });
    await mkdir(rawRoot, { mode: 0o700 });
    for (const descriptor of captured.manifest.volumes) {
      expect(descriptor.ownerId).toBe(userId); expect(descriptor.workerId).toBe(id);
      if (!descriptor.runtime) throw new Error('Actual producer lost native volume authority');
      if (descriptor.runtime.role === 'managed') expect(descriptor.runtime).toEqual({ kind: 'incus-vm', role: 'managed', managedVolumeId: volumeId, target: volume.target });
      else expect(descriptor.runtime.source).toEqual(expectedSource);
      const raw = await prepareInstanceNativeVolumeArchive(captured.volumeArchives.get(descriptor.name)!, descriptor, rawRoot);
      const entry = descriptor.runtime.role === 'workspace' ? 'workspace/marker' : descriptor.runtime.role === 'agents' ? '.agent-data/marker'
        : descriptor.runtime.role === 'managed' ? 'volume/data' : 'docker/volumes/archive-data/_data/ordinary';
      const bytes = (await run('tar', ['-xOf', raw.archivePath, '--', entry], { encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
      expect(bytes).toEqual(descriptor.runtime.role === 'docker' ? dockerVolumeBytes : Buffer.from([0, 255, 128, 10, 61, 0]));
      if (descriptor.runtime.role === 'workspace') expect(descriptor.runtime.dockerData).toBe(true);
      if (descriptor.runtime.role === 'docker') {
        const files = (await run('tar', ['-tf', raw.archivePath], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n');
        expect(files).toContain('docker/image/overlay2/imagedb/content/sha256/' + dockerIds[0]!.slice(7));
        for (const container of dockerIds.slice(1)) expect(files).toContain('docker/containers/' + container + '/config.v2.json');
      }
    }
    expect(await runtime.client.getInstance(options!.containerName)).toEqual(sourceInstance);
    expect(await Promise.all(sourceNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(sourceVolumes);
    expect(await sha256File(dockerSource!)).toBe(dockerSourceDigest);
    console.info('Actual REST producer passed: default SQLite integrity/admin, v2 native roles and immutable source, binary workspace/agent/managed and Docker image/container/named-volume bytes, unchanged stopped source incarnation/devices/storage');
  };
  try {
    if (retained) {
      // This one approved retained fixture bypasses all source setup, admin
      // creation, synthetic plans/jobs, imports and inverse operations.
      expect(await readBackupInstallationId(source)).toBe(retained.installation);
      const oldParent = JSON.parse(await root(`sudo docker inspect ${retained.parentId} --format '{{json .}}'`)) as {
        Id: string; Image: string; Config: { Labels: Record<string, string> }; Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
      };
      expect(oldParent.Id).toBe(retained.parentId); expect(oldParent.Image).toBe(retained.parentImageId);
      expect(oldParent.Config.Labels['agentor.native-helper-fixture']).toBe(jobId);
      expect(oldParent.Mounts.some(m => m.Type === 'bind' && m.Source === remoteData && m.Destination === remoteData && m.RW)).toBe(true);
      const ledger = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["jobs"]))')} ` +
        quote(remoteData + '/admin/instance-backups.v1.json'))) as InstanceBackupJob[];
      const previous = ledger.find(j => j.id === retained!.restoreJobId), failed = ledger.find(j => j.id === retained!.failedCaptureJobId);
      expect(previous).toMatchObject({ operation: 'restore', userId, status: 'succeeded' }); expect(previous).not.toHaveProperty('restoreHelper');
      expect(failed).toMatchObject({ operation: 'create', userId, status: 'failed' }); expect(failed).not.toHaveProperty('restoreHelper');
      await root(`sudo test ! -e ${quote(remoteData + '/incus-backup-helpers')}`);
      const name = config.containerPrefix + '-' + id;
      expect(await runtime.client.getInstance(name)).toEqual(retained.instance);
      expect(retained.instance.status).toBe('Stopped'); expect(retained.instance.config['volatile.uuid']).toBe(retained.incarnation);
      expect(await runtime.matchesWorkerIdentity(retained.instance, id, userId)).toBe(true);
      const names = [...['workspace', 'agents', 'docker'].map(role => name + '-' + role), volume.dockerName];
      expect(retained.volumes.map(v => v.name).sort()).toEqual(names.toSorted());
      const currentVolumes = await Promise.all(names.map(n => runtime.client.getCustomVolume(config.incusStoragePool, n)));
      for (const current of currentVolumes) expect(current).toEqual(retained.volumes.find(v => v.name === current.name));
      const bootstrap = await new WorkerConfigStore(config).resolveAppliedBootstrap(userId, id);
      if (!bootstrap) throw new Error('Retained fixture applied source bootstrap is missing');
      options = { ...bootstrap, id, userId, containerName: name, managedVolumes: [volume] };
      const storage = new StorageManager({} as ConstructorParameters<typeof StorageManager>[0], config);
      storage.mode = 'directory'; storage.dataHostPath = remoteData; options.storageManager = storage;
      incarnation = retained.incarnation; baseline = await managedRuntime.inspectVolume(volume);
      expect(baseline).toEqual(retained.volumes.find(v => v.name === volume.dockerName));
      if (retained.oldNft) {
        expect(retained.oldNft.table).toBe('agentor_restore_' + jobId.slice(0, 8));
        expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${retained.oldNft.table}`)))
          .toBe(sourceRuleSnapshot(typeof retained.oldNft.json === 'string' ? retained.oldNft.json : JSON.stringify(retained.oldNft.json)));
      }
      await Promise.all([mkdir(targetData), mkdir(build)]);
      await prepareImage(); // Fresh context/tag only; SAME DATA source is not uploaded or overwritten.
      await root(`sudo docker stop --time 30 ${retained.parentId}`);
      expect(await root(`sudo docker inspect ${retained.parentId} --format '{{.Id}} {{.Image}} {{.State.Status}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
        .toBe(`${retained.parentId} ${retained.parentImageId} exited ${jobId}`);
      await launchTarget();
      await expect.poll(async () => {
        try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
      }, { timeout: 60_000 }).toBe(200);
      const existing = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + retained.restoreJobId);
      expect(existing.status).toBe(200); expect(existing.body).toMatchObject({ id: retained.restoreJobId, userId, status: 'succeeded' });
      policyAdded = true; // Exact inherited fixture-only account-path delta; never add/widen it again.
      await runProducer(retained.source, retained.installation);
      completed = true;
      console.info('Retained producer passed without repeating source allocation/import/inverse; original stopped control-plane fixture retained until verified cleanup');
      return;
    }
    await Promise.all([mkdir(source), mkdir(join(targetData, 'admin'), { recursive: true }), mkdir(build)]);
    if (app) {
      await prepareImage();
      if (mode === 'app-retained') {
        // A genuine running helper on this exact DATA mount must fence the
        // earliest service initialization, before auth migrations/secret writes.
        // The inert holder has no daemon socket or credentials and never writes.
        startupHolderId = await root(`sudo docker run -d --name ${quote('native-startup-holder-' + jobId)} ` +
          `--label agentor.native-helper-fixture=${jobId} --label agentor.instance-restore-helper=true ` +
          `--label agentor.instance-restore-job=${jobId} --network none --read-only --cap-drop ALL ` +
          `--security-opt no-new-privileges:true --pids-limit 16 --memory 64m ` +
          `--mount type=bind,src=${remoteData},dst=${remoteData} ${quote(image)} node -e 'setInterval(()=>{},1000)'`);
        expect(startupHolderId).toMatch(/^[a-f0-9]{64}$/);
        await root(`sudo test ! -e ${quote(remoteData + '/auth.db')} && sudo test ! -e ${quote(remoteData + '/auth.secret')}`);
      }
      await launchTarget();
      if (startupHolderId) {
        await expect.poll(() => root(`sudo docker logs --tail 80 ${targetId} 2>&1`), { timeout: 30_000 })
          .toContain('INSTANCE_RESTORE_HELPER_ACTIVE');
        expect(await root(`sudo docker logs --tail 80 ${targetId} 2>&1`))
          .toContain('A restore helper is still executing against this DATA mount');
        // Plugin rejection alone does not stop Nitro listening. Exercise real
        // HTTP handlers while the same-DATA holder is active: none may access
        // auth storage or proxies before the startup authority check passes.
        expect((await appRequest('/api/health', undefined, false)).status).toBe(503);
        expect((await appRequest('/api/auth/sign-in/email', admin, false)).status).toBe(503);
        expect((await appRequest('/editor/' + id + '/', undefined, false)).status).toBe(503);
        // Exercise the actual upgrade path, which bypasses event middleware.
        // A nonempty dummy cookie would open auth.db without the shared WS gate.
        const wsBlocked = await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(
          `const{default:WS}=await import('/app/.output/server/node_modules/ws/wrapper.mjs');` +
          `const s=new WS('ws://127.0.0.1:3000/ws/logs',{headers:{Cookie:'invalid-fixture-cookie=present'}});let opened=false;` +
          `await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{s.terminate();reject(Error('Startup WS did not close'))},5000);` +
          `s.on('open',()=>{opened=true});s.on('close',()=>{clearTimeout(timer);resolve()});s.on('error',()=>{clearTimeout(timer);reject(Error('Fixture WS transport failed'))})});` +
          `console.log(JSON.stringify({opened,closed:true}));`)}`, 10_000);
        expect(JSON.parse(wsBlocked)).toEqual({ opened: true, closed: true });
        await root(`sudo test ! -e ${quote(remoteData + '/auth.db')} && sudo test ! -e ${quote(remoteData + '/auth.secret')}`);
        expect(await root(`sudo docker inspect ${startupHolderId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}} {{index .Config.Labels "agentor.instance-restore-helper"}} {{index .Config.Labels "agentor.instance-restore-job"}}'`))
          .toBe(`${startupHolderId} ${imageId} ${jobId} true ${jobId}`);
        await root(`sudo docker stop --time 10 ${startupHolderId}`);
        expect(await root(`sudo docker inspect ${startupHolderId} --format '{{.Id}} {{.Image}} {{.State.Status}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
          .toBe(`${startupHolderId} ${imageId} exited ${jobId}`);
        await root(`sudo docker rm ${startupHolderId}`); startupHolderId = undefined;
        expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
          .toBe(`${targetId} ${imageId} ${jobId}`);
        await root(`sudo docker restart ${targetId}`);
      }
      await expect.poll(async () => {
        try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
      }, { timeout: 60_000 }).toBe(200);
      const created = await appRequest<{ id: string; role: string }>('/api/setup/create-admin', admin, false);
      expect(created.status).toBe(201); expect(created.body.role).toBe('admin');
      stagingOwner = restoredOwner = created.body.id; expect(stagingOwner).toMatch(/^[A-Za-z0-9_-]+$/);
      originalInstallation = JSON.parse(await root(`sudo python3 -c ${quote(
        'import json,os,sys; p=sys.argv[1]; print(json.dumps(open(p).read().strip() if os.path.exists(p) else None))')} ` +
        quote(remoteData + '/backup-installation-id'))) ?? undefined;
      if (ordinary) userId = volume.userId = stagingOwner;
    }
    const installation = await backupInstallationId(source);
    const store = new ManagedVolumeStore(source); await store.init(); await store.save(volume);
    await writeFile(join(source, 'worker-config.key'), Buffer.alloc(32, 81).toString('base64') + '\n', { mode: 0o600 });
    if (ordinary) {
      // Reuse an operator-selected, previously accepted logical Docker capture,
      // unchanged. Never fabricate Docker internals or copy a physical device.
      // Required archive/path/digest were admitted before any fixture resources.
      const workers = new WorkerStore(source); await workers.init();
      await workers.upsert({ id, userId, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'stopped',
        displayName: 'Controlled instance restored worker', createdAt: stamp, updatedAt: stamp });
      worker = workers.get(userId, id)!;
      const bootstrap: WorkerAppliedBootstrap = { version: 1, dockerEnabled: true, cpuLimit: 2, memoryLimit: '2GiB',
        userEnv: zeroUserEnvVars(userId), capabilitiesJson: [], instructionsJson: [],
        excludedGlobalEnvVarKeys: [], excludedGroupEnvVarKeys: [],
        environmentJson: { dockerEnabled: true, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
          exposeApis: { portMappings: false, domainMappings: false, usage: false } },
        workerJson: { id, displayName: worker.displayName, repos: [], initScript: '', gitName: '', gitEmail: '' } };
      await new WorkerConfigStore(config).markApplied(userId, id, bootstrap);
      options = { ...bootstrap, id, userId, containerName: config.containerPrefix + '-' + id };
      const storage = new StorageManager({} as ConstructorParameters<typeof StorageManager>[0], config);
      await new UserCredentialManager(storage).ensureUserDir(userId);
      for (const path of ['credentials', 'kilo/config', 'kilo/data', 'ssh'])
        await mkdir(join(source, 'users', userId, path), { recursive: true, mode: 0o700 });
      await writeFile(join(source, 'users', userId, 'ssh/authorized_keys'), '', { mode: 0o600 });
    }
    const auth = join(local, 'auth.db');
    if (app) {
      // Same SQLite online-backup primitive as production capture. No manually
      // authored authentication schema or fabricated source account.
      const snapshot = remoteData + '/auth-fixture.snapshot';
      await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(
        `import{createRequire}from'node:module';import{chmodSync}from'node:fs';const r=createRequire('/app/.output/server/package.json');` +
        `const db=new(r('better-sqlite3'))(${JSON.stringify(remoteData + '/auth.db')},{readonly:true});await db.backup(${JSON.stringify(snapshot)});chmodSync(${JSON.stringify(snapshot)},0o600);db.close();`)}`);
      const bytes = (await run('ssh', [...ssh, `sudo cat ${quote(snapshot)}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
      await writeFile(auth, bytes, { mode: 0o600 });
      const secret = (await run('ssh', [...ssh, `sudo cat ${quote(remoteData + '/auth.secret')}`],
        { encoding: 'buffer', maxBuffer: 1024 })).stdout;
      await writeFile(join(source, 'auth.secret'), secret, { mode: 0o600 });
    } else await writeFile(auth, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096)]));
    const stage = join(targetData, 'instance-restore-staging', 'restore-' + jobId), unpacked = join(stage, 'unpacked');
    await mkdir(unpacked, { recursive: true, mode: 0o700 });
    const backupOptions = { includeWorkers: true, includeAgentData: mode !== 'omitted', includeDockerVolumes: true, includeLocalBackups: false, includeLogs: false };
    const data = await createInstanceDataArchive({ dataDir: source, authSnapshotPath: auth, output: join(unpacked, 'data.tar.gz'), options: backupOptions });
    const payload = join(local, 'payload'); await mkdir(join(payload, 'volume'), { recursive: true });
    await run('sudo', ['python3', '-c', String.raw`
import os,sys
p=sys.argv[1];f=p+'/data';open(f,'wb').write(bytes([0,255,128,10,61,0]))
os.link(f,p+'/hard');os.chown(f,12345,23456);os.chmod(f,0o640)
os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]));os.utime(f,ns=(1700000000123456789,1700000000987654321))
`, join(payload, 'volume')]);
    const archiveName = instanceVolumeArchiveName(volume.dockerName), archive = join(unpacked, instanceBundleFilename(archiveName));
    await run('sudo', ['tar', '--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', payload, '-czf', archive, 'volume']);
    await run('sudo', ['chown', `${process.getuid!()}:${process.getgid!()}`, archive]);
    let manifest: InstanceBackupManifest = validateInstanceManifest({ kind: 'agentor-instance-backup', formatVersion: 2,
      backupId: jobId, sourceInstallationId: installation, createdByUserId: restoredOwner, createdAt: stamp, agentorVersion: 'test',
      storage: { mode: 'directory', containerPrefix: config.containerPrefix }, options: backupOptions,
      dataArchive: { archive: 'data.tar.gz', sha256: data.sha256, size: data.size },
      volumes: [{ name: volume.dockerName, kind: 'persistent-path', ownerId: userId, workerId: id, archive: archiveName,
        size: (await stat(archive)).size, sha256: await sha256File(archive),
        runtime: { kind: 'incus-vm', role: 'managed', managedVolumeId: volumeId, target: volume.target } }],
      plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
      hostMounts: { configuredPaths: [], contentsIncluded: false }, images: { definitions: 0, immutableDigests: [], layersIncluded: false },
      excludedDataPaths: data.excludedDataPaths });
    if (ordinary) {
      const identity = incusImageIdentity(await runtime.client.getImage((await runtime.client.getImageAlias(config.incusWorkerImage)).target));
      const imageSource: WorkerBackupRuntimeSource = { sourceImageId: identity.sourceImageId, recipeId: identity.recipeId,
        architecture: identity.architecture, converterVersion: identity.converterVersion, bootstrapGeneration: identity.bootstrapGeneration };
      for (const role of ['workspace', 'agents', 'docker'] as const) {
        if (role === 'agents' && mode === 'omitted') continue;
        const name = config.containerPrefix + '-' + id + '-' + role, archiveName = instanceVolumeArchiveName(name);
        const archive = join(unpacked, instanceBundleFilename(archiveName));
        if (role === 'docker') await pipeline(createReadStream(dockerSource!), createGzip(), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
        else {
          const stage = join(local, 'payload-' + role), wrapper = role === 'agents' ? '.agent-data' : role;
          await mkdir(join(stage, wrapper), { recursive: true });
          await writeFile(join(stage, wrapper, 'marker'), Buffer.from([0, 255, 128, 10, 61, 0]));
          await run('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--acls', '-C', stage, '-czf', archive, wrapper]);
        }
        manifest.volumes.push({ name, kind: role === 'workspace' ? 'worker-workspace' : role === 'agents' ? 'worker-agent-data' : 'worker-dind',
          ownerId: userId, workerId: id, archive: archiveName, size: (await stat(archive)).size, sha256: await sha256File(archive),
          runtime: role === 'workspace' ? { kind: 'incus-vm', role, source: imageSource, dockerData: true }
            : { kind: 'incus-vm', role, source: imageSource } });
      }
      manifest = validateInstanceManifest(manifest);
      expect(await sha256File(dockerSource!)).toBe(dockerSourceDigest);
    }
    if (rollback) {
      // A valid legacy payload reaches the existing legacy extraction leaf
      // AFTER native apply. Only the fixture image lacks that leaf's sleep
      // executable, producing a real Docker start failure, not a fake Incus
      // acknowledgement or production failpoint.
      const legacyStage = join(local, 'legacy-payload'); await mkdir(join(legacyStage, 'source'), { recursive: true });
      await writeFile(join(legacyStage, 'source/marker'), 'rollback-payload');
      const archiveName = instanceVolumeArchiveName(legacyName), archive = join(unpacked, instanceBundleFilename(archiveName));
      await run('tar', ['-C', legacyStage, '-czf', archive, 'source']);
      manifest.volumes.push({ name: legacyName, kind: 'traefik-certificates', archive: archiveName,
        size: (await stat(archive)).size, sha256: await sha256File(archive) });
      manifest = validateInstanceManifest(manifest);
    }
    let remoteStage = remoteData + '/instance-restore-staging/restore-' + restoreJobId;
    const readRestoreJob = async (): Promise<InstanceBackupJob | undefined> => JSON.parse(await root(
      `sudo python3 -c ${quote('import json,sys; print(json.dumps(next((j for j in json.load(open(sys.argv[1]))["jobs"] if j["id"]==sys.argv[2]), None)))')} ` +
      `${quote(remoteData + '/admin/instance-backups.v1.json')} ${quote(restoreJobId)}`)) ?? undefined;
    if (rest) {
      // Enter through actual authenticated transport. Source inputs use the
      // accepted codecs, never an installed synthetic job/staged helper plan.
      const material = randomBytes(32).toString('base64');
      const kit = validateRecoveryKit({ kind: 'agentor-backup-recovery-kit', version: 1, encryptionFormat: 2,
        keyMaterial: material, fingerprint: backupKeyFingerprint(material), createdAt: stamp });
      const bundle = join(local, 'public-instance.tar'), encrypted = join(local, 'public-instance.backup'), kitPath = join(local, 'public-kit.json');
      await packInstanceBundle(manifest, join(unpacked, 'data.tar.gz'),
        manifest.volumes.map(v => ({ manifest: v, path: join(unpacked, instanceBundleFilename(v.archive)) })), bundle);
      await encryptInstanceBackup(bundle, encrypted, material, { backupId: manifest.backupId,
        sourceInstallationId: manifest.sourceInstallationId, createdAt: manifest.createdAt, formatVersion: manifest.formatVersion });
      const header = await inspectInstanceBackup(encrypted);
      expect(header.keyFingerprint).toBe(kit.fingerprint); expect(header.metadata.formatVersion).toBe(2);
      await writeFile(kitPath, JSON.stringify({ kit }), { mode: 0o600 });
      const incoming = remote + '/rest-incoming', transfer = remoteData + '/fixture-rest-input';
      await root(`test ! -e ${quote(incoming)} && mkdir -m 700 ${quote(incoming)} && sudo test ! -e ${quote(transfer)}`);
      await run('scp', [...scp, encrypted, kitPath, 'kata-test@172.19.0.1:' + incoming + '/'], { timeout: 60_000 });
      await root(`sudo install -d -m 700 ${quote(transfer)} && ` +
        `sudo install -m 600 ${quote(incoming + '/public-instance.backup')} ${quote(transfer + '/instance.backup')} && ` +
        `sudo install -m 600 ${quote(incoming + '/public-kit.json')} ${quote(transfer + '/kit.json')}`);
      // Key bytes and auth cookies remain inside the exact App child process.
      const importedKit = await appRequest<{ imported: boolean; fingerprint: string }>('/api/backups/recovery-key/import',
        undefined, true, 30_000, { path: transfer + '/kit.json', format: 'json' });
      expect(importedKit.status).toBe(200); expect(importedKit.body).toMatchObject({ imported: true, fingerprint: kit.fingerprint });
      const accepted = await appRequest<{ accepted: boolean; jobId: string }>('/api/admin/instance-backups/import?requestId=' + jobId + '-upload',
        undefined, true, 180_000, { path: transfer + '/instance.backup', format: 'binary' });
      expect(accepted.status).toBe(202); expect(accepted.body.accepted).toBe(true);
      expect(accepted.body.jobId).toMatch(/^[a-f0-9-]{36}$/);
      await expect.poll(async () => {
        const verified = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + accepted.body.jobId);
        expect(verified.status).toBe(200); expect(verified.body).not.toHaveProperty('restoreHelper');
        if (verified.body.status === 'failed') throw new Error('Public fixture import verification failed: ' + (verified.body.errorCode ?? 'unknown'));
        return verified.body.status;
      }, { timeout: 180_000, intervals: [500, 1000] }).toBe('succeeded');
      if (ordinary) { await policy(true); policyAdded = true; }
      const preflight = await appRequest<InstanceRestorePreflight>('/api/admin/instance-backups/artifacts/' + jobId +
        '/preflight?restoreDockerVolumes=true&restoreHostMountPolicies=false');
      expect(preflight.status).toBe(200); expect(preflight.body).toMatchObject({ ready: true, blockers: [], volumeConflicts: [],
        sourceInstallationId: installation, destinationContainerPrefix: config.containerPrefix });
      const restoring = await appRequest<{ accepted: boolean; jobId: string }>('/api/admin/instance-backups/artifacts/' + jobId + '/restore',
        { options: { restoreDockerVolumes: true, restoreHostMountPolicies: false,
          confirmReplaceControlPlane: true, confirmExternalDependencies: true }, requestId: jobId + '-restore' });
      expect(restoring.status).toBe(202); expect(restoring.body.accepted).toBe(true);
      restoreJobId = restoring.body.jobId; expect(restoreJobId).toMatch(/^[a-f0-9-]{36}$/); expect(restoreJobId).not.toBe(jobId);
      remoteStage = remoteData + '/instance-restore-staging/restore-' + restoreJobId;
      // Poll the private ledger, not public status (which may settle the
      // helper). Never infer its identity from a name or disappearance.
      let receipt: InstanceBackupJob['restoreHelper'];
      await expect.poll(async () => {
        try { receipt = (await readRestoreJob())?.restoreHelper; } catch { receipt = undefined; }
        return Boolean(receipt);
      }, { timeout: 180_000, intervals: [250, 500] }).toBe(true);
      if (!receipt) throw new Error('Public restore helper acknowledgement was not observed');
      helperId = receipt.containerId;
      expect(helperId).toMatch(/^[a-f0-9]{64}$/); expect(receipt.imageId).toBe(imageId);
      const info = JSON.parse(await root(`sudo docker inspect ${helperId} --format '{{json .}}'`)) as {
        Id: string; Image: string; Config: { Labels: Record<string, string>; Env: string[] };
        Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
      };
      expect(info.Id).toBe(helperId); expect(info.Image).toBe(imageId);
      expect(info.Config.Labels).toMatchObject({ 'agentor.instance-restore-helper': 'true', 'agentor.instance-restore-job': restoreJobId });
      for (const required of [`AGENTOR_INSTANCE_RESTORE_JOB=${restoreJobId}`, `AGENTOR_INSTANCE_RESTORE_STAGE=${remoteStage}`,
        `AGENTOR_INSTANCE_RESTORE_DATA_DIR=${remoteData}`, `AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR=${targetId}`])
        expect(info.Config.Env.includes(required), 'Exact acknowledged helper environment matches operator authority').toBe(true);
      expect(info.Mounts.some(m => m.Source.startsWith('/var/lib/incus') || m.Destination.startsWith('/var/lib/incus'))).toBe(false);
      for (const path of ['/tls/client.crt', '/tls/client.key', '/tls/server.crt'])
        expect(info.Mounts.some(m => m.Destination === path && m.Type === 'bind' && !m.RW)).toBe(true);
      await expect.poll(() => root(`sudo docker inspect ${helperId} --format '{{.State.StartedAt}}'`),
        { timeout: 30_000 }).not.toMatch(/^0001-/);
      console.info('Public restore exact acknowledged fixture', { remote, id, jobId, restoreJobId, helperId, targetId });
    } else {
    await writeFile(join(stage, 'restore-plan.json'), JSON.stringify({ version: 1, formatVersion: 2, jobId,
      dataArchive: remoteStage + '/unpacked/data.tar.gz', sourceInstallationId: installation,
      restoredOwnerId: restoredOwner, stagingOwnerId: stagingOwner, restoreHostMountPolicies: false, manifest,
      volumes: manifest.volumes.map(v => ({ ...v, archive: remoteStage + '/unpacked/' + instanceBundleFilename(v.archive) })) }));
    const job: InstanceBackupJob = { schemaVersion: 1, id: jobId, userId: stagingOwner, operation: 'restore', provider: 'fake',
      status: 'running', phase: 'applying', progress: 70, bytesProcessed: 0, createdAt: stamp, updatedAt: stamp, logs: [] };
    await writeFile(join(targetData, 'admin/instance-backups.v1.json'), JSON.stringify({ schemaVersion: 1, jobs: [job], artifacts: [], remoteBackups: [] }));
    if (app) {
      // Normal App bootstrap owns DATA_DIR. Transfer through the exact private
      // fixture parent, then guest-only sudo installs staged inputs; never
      // widen production DATA or secret permissions to make scp succeed.
      const incoming = remote + '/incoming';
      await root(`test ! -e ${quote(incoming)} && mkdir -m 700 ${quote(incoming)}`);
      await run('scp', [...scp, '-r', join(targetData, 'instance-restore-staging'), join(targetData, 'admin'),
        'kata-test@172.19.0.1:' + incoming + '/'], { timeout: 60_000 });
      await root(`sudo cp -a ${quote(incoming + '/instance-restore-staging')} ${quote(remoteData + '/')} && ` +
        `sudo install -m 600 ${quote(incoming + '/admin/instance-backups.v1.json')} ${quote(remoteData + '/admin/instance-backups.v1.json')}`);
    }
    else {
      await writeFile(join(targetData, 'auth.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('old-target')]));
      await prepareImage();
    }
    if (ordinary) { await policy(true); policyAdded = true; }
    if (!app) await launchTarget();
    const env = [ 'AGENTOR_INSTANCE_RESTORE_NATIVE=true', `AGENTOR_INSTANCE_RESTORE_JOB=${jobId}`,
      `AGENTOR_INSTANCE_RESTORE_STAGE=${remoteStage}`, `AGENTOR_INSTANCE_RESTORE_DATA_DIR=${remoteData}`,
      `AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR=${targetId}`, 'CONTAINER_PREFIX=' + config.containerPrefix,
      'INCUS_ENDPOINT=https://agentor-kata-preflight:8443', 'INCUS_PROJECT=agentor', 'INCUS_NETWORK=incusbr0',
      'INCUS_STORAGE_POOL=default', 'INCUS_WORKER_IMAGE=agentor-worker-phase10-preserve-ownership',
      'INCUS_DOCKER_VOLUME_SIZE=1GiB', 'INCUS_INTERNAL_GATEWAY_URL=' + config.incusInternalGatewayUrl,
      'INCUS_CLIENT_CERT_PATH=/tls/client.crt', 'INCUS_CLIENT_KEY_PATH=/tls/client.key', 'INCUS_SERVER_CERT_PATH=/tls/server.crt' ];
    // Exact assigned credential files only; never inject them into the guest.
    console.info('Exact native helper-process fixture', { remote, id, jobId, volumeId, installation, targetId });
    helperId = await root(`sudo docker create --name ${quote(helperName)} --label agentor.native-helper-fixture=${jobId} ` +
      `--label agentor.instance-restore-helper=true --label agentor.instance-restore-job=${jobId} --user 0:0 ` +
      `--network agentor-phase6-net --add-host agentor-kata-preflight:172.22.0.1 --read-only --cap-drop ALL ` +
      `--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges:true --pids-limit 64 --memory 256m ` +
      `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock ` +
      `--mount type=bind,src=${remoteData},dst=${remoteData} ${mounts.join(' ')} ${env.map(v => '-e ' + quote(v)).join(' ')} ` +
      `${quote(image)} node .output/server/instance-restore-helper.mjs`);
    expect(helperId).toMatch(/^[a-f0-9]{64}$/);
    expect(await root(`sudo docker inspect ${helperId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}} {{index .Config.Labels "agentor.instance-restore-helper"}} {{index .Config.Labels "agentor.instance-restore-job"}}'`))
      .toBe(`${helperId} ${imageId} ${jobId} true ${jobId}`);
    job.restoreHelper = { containerId: helperId, imageId: imageId! };
    await writeFile(join(targetData, 'admin/instance-backups.v1.json'), JSON.stringify({ schemaVersion: 1, jobs: [job], artifacts: [], remoteBackups: [] }));
    const acknowledgement = remote + '/restore-helper-ack.json';
    await run('scp', [...scp, join(targetData, 'admin/instance-backups.v1.json'),
      'kata-test@172.19.0.1:' + acknowledgement], { timeout: 30_000 });
    await root(`sudo install -m 600 ${quote(acknowledgement)} ${quote(remoteData + '/admin/instance-backups.v1.json')}`);
    await root(`sudo docker start ${helperId}`);
    }
    if (!helperId) throw new Error('Exact helper acknowledgement is missing before terminal observation');
    const code = await root(`sudo docker wait ${helperId}`, 600_000);
    // Parent startup may remove a settled helper between wait and logs. Only
    // this acknowledged exact-ID terminal result permits optional diagnostics.
    const logs = await root(`sudo docker logs ${helperId}`).catch(error => {
      if (code === (rollback ? '1' : '0')) return 'Exact helper terminal result acknowledged; optional logs already removed';
      throw error;
    });
    expect(code, logs).toBe(rollback ? '1' : '0');
    const ledger = await readRestoreJob();
    if (!ledger) throw new Error('Exact restored job ledger is missing after helper completion');
    if (rollback) {
      // A prior native failure could otherwise satisfy rollback's final
      // absence assertions. This bounded exact-job daemon witness proves the
      // legacy leaf ran only AFTER acknowledged native apply returned.
      const witnessName = `agentor-instance-volume-${jobId}-${createHash('sha256').update(legacyName).digest('hex').slice(0, 12)}`;
      const eventOutput = await root(`sudo docker events --since ${Math.floor(Date.parse(stamp) / 1000)} --until ${Math.ceil(Date.now() / 1000)} ` +
        `--filter type=container --filter event=create --filter label=agentor.instance-restore-job=${jobId} ` +
        `--filter label=agentor.instance-restore-volume-helper=true --format '{{json .}}'`, 10_000);
      const witnesses = eventOutput.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
        Actor: { ID: string; Attributes: Record<string, string> };
      });
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]!.Actor.ID).toMatch(/^[a-f0-9]{64}$/);
      expect(witnesses[0]!.Actor.Attributes).toMatchObject({ name: witnessName, image,
        'agentor.instance-restore-volume-helper': 'true', 'agentor.instance-restore-job': jobId });
      expect(ledger).toMatchObject({ id: restoreJobId, userId: stagingOwner, status: 'failed', phase: 'failed', retryable: true });
      expect(ledger.errorCode).not.toBe('INSTANCE_RESTORE_ROLLBACK_INCOMPLETE');
      expect(await root(`sudo docker inspect ${targetId} --format '{{.State.Running}}'`)).toBe('true');
      if (app) {
        const restoredIdentity = JSON.parse(await root(`sudo python3 -c ${quote(
          'import json,os,sys; p=sys.argv[1]; print(json.dumps(open(p).read().strip() if os.path.exists(p) else None))')} ` +
          quote(remoteData + '/backup-installation-id'))) ?? undefined;
        expect(restoredIdentity).toBe(originalInstallation);
        expect(originalInstallation).not.toBe(installation);
        await expect.poll(async () => {
          try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
        }, { timeout: 60_000 }).toBe(200);
        const failed = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + restoreJobId);
        expect(failed.status).toBe(200); expect(failed.body).toMatchObject({ id: restoreJobId, userId: stagingOwner, status: 'failed', phase: 'failed' });
        expect(failed.body).not.toHaveProperty('restoreHelper');
        const settled = await readRestoreJob(); expect(settled).toBeDefined();
        expect(settled).not.toHaveProperty('restoreHelper');
        await root(`sudo test ! -e ${quote(remoteStage)}`);
        expect(await root(`sudo docker ps -aq --no-trunc --filter id=${helperId}`)).toBe('');
        helperRemovedByManager = true;
      } else {
        const oldDb = await root(`sudo python3 -c ${quote('import sys; print(open(sys.argv[1],"rb").read().hex())')} ${quote(remoteData + '/auth.db')}`);
        expect(oldDb).toBe(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('old-target')]).toString('hex'));
      }
      await root(`test ! -e ${quote(remoteData + '/users' + (app ? '/' + userId : ''))} && test ! -e ${quote(remoteData + '/instance-restore-rollback/' + restoreJobId)}`);
      await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
      for (const name of [...['workspace', 'agents', 'docker'].map(role => config.containerPrefix + '-' + id + '-' + role), volume.dockerName])
        await expect(runtime.client.getCustomVolume(config.incusStoragePool, name)).rejects.toMatchObject({ statusCode: 404 });
      expect(await root(`sudo docker volume ls --format '{{.Name}}' --filter name=^${legacyName}$`)).toBe('');
      expect(await root(`sudo docker ps -aq --filter label=agentor.instance-restore-job=${jobId} --filter label=agentor.instance-restore-volume-helper=true`)).toBe('');
      if (dockerSource) expect(await sha256File(dockerSource)).toBe(dockerSourceDigest);
      completed = true;
      console.info('Real legacy Docker start failure after acknowledged native apply: native cleanup settled BEFORE original control plane restored; only exact recovery target restarted');
      return;
    }
    expect(ledger).toMatchObject({ id: restoreJobId, userId: restoredOwner, status: 'succeeded', phase: 'complete' });
    expect(await root(`sudo docker inspect ${targetId} --format '{{.State.Running}}'`)).toBe('true');
    const record = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[0]))')} ` +
        quote(remoteData + (ordinary ? '/users/' : '/retained-storage/users/') + userId + '/managed-volumes.v1.json'))) as StoredManagedVolume;
    expect(record).toMatchObject({ id: volumeId, workerId: id, userId, seeded: true, attached: ordinary, state: ordinary ? 'ready' : 'detached',
      ...(!ordinary ? { retainedAfterAccountDeletion: true } : {}) });
    await root(`test ! -e ${quote(remoteData + '/instance-restore-rollback/' + restoreJobId)}`);
    if (!ordinary) {
      await root(`test ! -e ${quote(remoteData + '/users' + (app ? '/' + userId : ''))}`);
      await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
      for (const role of ['workspace', 'agents', 'docker'])
        await expect(runtime.client.getCustomVolume(config.incusStoragePool, config.containerPrefix + '-' + id + '-' + role)).rejects.toMatchObject({ statusCode: 404 });
    } else {
      const records = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))')} ` +
        quote(remoteData + '/users/' + userId + '/workers.json'))) as WorkerRecord[];
      expect(records).toEqual([worker]); // Original intent only after complete job.
      const instance = await runtime.client.getInstance(options!.containerName);
      incarnation = instance.config['volatile.uuid']; expect(incarnation).toBeTruthy();
      expect(instance.status).toBe('Stopped'); expect(instance.config['user.agentor.restore']).toBeUndefined();
      const storage = new StorageManager({} as ConstructorParameters<typeof StorageManager>[0], config);
      storage.mode = 'directory'; storage.dataHostPath = remoteData;
      options!.storageManager = storage; options!.managedVolumes = [record];
      computeSettled = false;
      if (app) {
        await expect.poll(async () => {
          try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
        }, { timeout: 60_000 }).toBe(200);
        // Existing dashboard restart starts stopped workers; no new endpoint
        // or frontend protocol is required for restored compute.
        const started = await appRequest<{ ok: boolean }>('/api/containers/' + id + '/restart', {}, true, 360_000);
        expect(started.status).toBe(200); expect(started.body).toEqual({ ok: true });
        const listed = await appRequest<Array<{ id: string; runtimeKind: string; status: string }>>('/api/containers');
        expect(listed.status).toBe(200); expect(listed.body.find(v => v.id === id)).toMatchObject({ runtimeKind: 'incus-vm', status: 'running' });
      } else await runtime.start(options!, incarnation);
      computeSettled = true;
      const checked = await runtime.client.exec(options!.containerName, ['bash', '-ec',
        (mode === 'omitted' ? 'test ! -e /home/agent/.agent-data/marker; ' : 'cmp /workspace/marker /home/agent/.agent-data/marker; ') +
        'runuser -u agent -- touch /home/agent/.agent-data/.kilo/state/helper-writable /home/agent/.agent-data/.codex/helper-writable; ' +
        'systemctl is-active --quiet agentor-worker; ' +
        'docker info --format "{{.Driver}}"; docker image inspect agentor-archive-lower:proof >/dev/null; ' +
        'docker container inspect archive-layer archive-stopped >/dev/null; docker volume inspect archive-data >/dev/null; ' +
        'docker run --rm -v archive-data:/data busybox:1.37.0 sh -ec \'test "$(cat /data/ordinary)" = persistent\'; ' +
        'curl --fail --silent http://127.0.0.1:8443/ >/dev/null; curl --fail --silent http://127.0.0.1:6080/ >/dev/null']);
      expect(checked.returnCode, checked.stdout + checked.stderr).toBe(0); expect(checked.stdout.trim()).toBe('overlay2');
      expect(await sha256File(dockerSource!)).toBe(dockerSourceDigest);
      if (app && !originalPublic) {
        const editor = await appRequest<string>('/editor/' + id + '/?folder=/workspace');
        expect(editor.status).toBe(200); expect(editor.body).toContain('code-server');
        const desktop = await appRequest<string>('/desktop/' + id + '/agentor.html');
        expect(desktop.status).toBe(200); expect(desktop.body).toContain('noVNC');
        const self = await runtime.client.exec(options!.containerName,
          ['curl', '--noproxy', '*', '-fsS', config.incusInternalGatewayUrl + '/api/worker-self/info']);
        expect(self.returnCode, self.stderr).toBe(0);
        expect(JSON.parse(self.stdout)).toMatchObject({ workerId: id, userId });
      }
    }
    baseline = await managedRuntime.inspectVolume(record); if (!ordinary) expect(baseline?.used_by).toEqual([]);
    const physical = '/var/lib/incus/storage-pools/default/custom/agentor_' + volume.dockerName;
    const contents = JSON.parse(await root(`sudo python3 -c ${quote(String.raw`import os,sys,stat,json,base64
p=sys.argv[1];s=os.lstat(p+'/data');assert os.path.realpath(p)==p
print(json.dumps(dict(data=base64.b64encode(open(p+'/data','rb').read()).decode(),uid=s.st_uid,gid=s.st_gid,
mode=stat.S_IMODE(s.st_mode),mtime=s.st_mtime_ns,hard=s.st_ino==os.stat(p+'/hard').st_ino,
xattr=base64.b64encode(os.getxattr(p+'/data','user.binary')).decode())))`)} ${quote(physical)}`));
    expect(contents).toEqual({ data: 'AP+ACj0A', uid: 12345, gid: 23456, mode: 0o640, mtime: 1700000000987654321,
      hard: true, xattr: 'AP+ACj0A' });
    if (app) {
      await expect.poll(async () => {
        try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
      }, { timeout: 60_000 }).toBe(200);
      const visible = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + restoreJobId);
      expect(visible.status).toBe(200); expect(visible.body).toMatchObject({ id: restoreJobId, userId: restoredOwner, status: 'succeeded', phase: 'complete' });
      expect(visible.body).not.toHaveProperty('restoreHelper');
      const settled = await readRestoreJob(); expect(settled).toBeDefined();
      expect(settled).not.toHaveProperty('restoreHelper');
      await root(`sudo test ! -e ${quote(remoteStage)}`);
      expect(await root(`sudo docker ps -aq --no-trunc --filter id=${helperId}`)).toBe('');
      helperRemovedByManager = true;
      console.info('Current running Orchestrator authenticated against restored SQLite and exposed completed native job after exact restart');
    }
    if (originalPublic) {
      // The existing controlled source setup is required; public whole-instance
      // inverse/producer acceptance is not repeated for this original-only gate.
      const path = '/workspace/public-original-' + id;
      await runtime.client.exec(options!.containerName, ['python3', '-c', String.raw`
import os,sys
p=sys.argv[1];os.mkdir(p);f=p+'/data';open(f,'wb').write(bytes([0,255,128,10,61,0]));os.link(f,p+'/hard')
os.chown(f,12345,23456);os.chmod(f,0o640);os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]))
os.utime(f,ns=(1700000000123456789,1700000000987654321))
`, path]).then(result => expect(result.returnCode, result.stderr).toBe(0));
      const capture = await appRequest<BackupJob>('/api/backups', { workspaceIds: [id], providerId: 'local', includeManagedVolumes: false });
      expect(capture.status).toBe(202); expect(capture.body.id).toMatch(/^[a-f0-9-]{36}$/);
      let captured: BackupJob | undefined;
      await expect.poll(async () => {
        const state = await appRequest<BackupJob>('/api/backup-jobs/' + capture.body.id); expect(state.status).toBe(200); captured = state.body;
        if (state.body.status === 'failed') throw new Error('Public worker backup failed: ' + (state.body.errorCode ?? 'unknown'));
        return state.body.status;
      }, { timeout: 300_000, intervals: [1000] }).toBe('succeeded');
      if (!captured?.artifactId) throw new Error('Actual worker backup artifact acknowledgement missing');
      expect(captured).toMatchObject({ encrypted: true, integrityVerified: true });
      const artifact = await appRequest<BackupArtifact>('/api/backups/' + captured.artifactId);
      expect(artifact.status).toBe(200); expect(artifact.body).toMatchObject({ userId, provider: 'local', formatVersion: 2,
        workspaceIds: [id], integrityStatus: 'verified' });
      expect(artifact.body.providerObjectId).toMatch(/^[a-f0-9-]{36}$/);
      const objectPath = remoteData + '/backup-objects/' + userId + '/' + artifact.body.providerObjectId + '.backup';
      // Read only the bounded encrypted envelope, never raw key material.
      // Creation's actual decrypt/inspect pass and restore's actual AES-GCM
      // authentication provide authority, not this descriptive header alone.
      const envelope = JSON.parse(await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(
        `import fs from'node:fs';const p=${JSON.stringify(objectPath)};const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==${artifact.body.size})throw Error('Encrypted worker object differs');` +
        `const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const b=Buffer.alloc(16400);const n=fs.readSync(fd,b,0,b.length,0);fs.closeSync(fd);` +
        `const magic=Buffer.from('AGENTOR-BACKUP-2\\n');if(!b.subarray(0,magic.length).equals(magic))throw Error('Worker object is not encrypted v2');` +
        `const e=b.indexOf(10,magic.length);if(e<0||e>=n)throw Error('Worker envelope invalid');console.log(b.subarray(magic.length,e).toString());`)}`));
      expect(envelope).toMatchObject({ version: 2, algorithm: 'aes-256-gcm', keyFingerprint: artifact.body.keyFingerprint,
        metadata: { workspaceIds: [id], formatVersion: 2 } });
      await runtime.client.exec(options!.containerName, ['python3', '-c',
        'import sys; p=sys.argv[1];open(p+"/data","wb").write(b"changed-after-capture");' +
        'open("/workspace/extra-after-"+sys.argv[2],"wb").write(b"must disappear");' +
        'open("/home/agent/.agent-data/marker","wb").write(b"agent-after-capture");' +
        'open("/root/original-public-"+sys.argv[2],"wb").write(b"compute-root-after-capture")', path, id])
        .then(result => expect(result.returnCode, result.stderr).toBe(0));
      const stopped = await appRequest('/api/containers/' + id + '/stop', {}, true, 360_000); expect(stopped.status).toBe(200);
      const before = await runtime.client.getInstance(options!.containerName); expect(before.status).toBe('Stopped');
      expect(before.config['volatile.uuid']).toBe(incarnation);
      const names = [...['workspace', 'agents', 'docker'].map(role => options!.containerName + '-' + role), volume.dockerName];
      const beforeVolumes = await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
      const lockPassword = 'original-fixture-' + jobId;
      expect((await appRequest('/api/containers/' + id + '/protection', { password: lockPassword }, true, 30_000, undefined, undefined, 'PUT')).status).toBe(200);
      const endpoint = '/api/backups/' + artifact.body.id + '/restore';
      expect((await appRequest(endpoint, { target: 'original', workspaceIds: [id] })).status).toBe(409);
      expect((await appRequest(endpoint, { target: 'original', workspaceIds: [id], confirmOverwrite: true })).status).toBe(423);
      expect((await appRequest(endpoint, { target: 'original', workspaceIds: [id], confirmOverwrite: true, lockPassword: 'incorrect-fixture' })).status).toBe(423);
      expect(await runtime.client.getInstance(options!.containerName)).toEqual(before);
      expect(await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(beforeVolumes);
      {
        computeSettled = false; // Any unknown native replacement keeps the exact original source/receipt.
        const restored = await appRequest<{ jobId: string }> (endpoint, { target: 'original', workspaceIds: [id], confirmOverwrite: true,
          lockPassword, requestId: jobId + '-original' });
        expect(restored.status).toBe(202); expect(restored.body.jobId).toMatch(/^[a-f0-9-]{36}$/);
        await expect.poll(async () => {
          const state = await appRequest<BackupJob>('/api/backup-jobs/' + restored.body.jobId); expect(state.status).toBe(200);
          if (state.body.status === 'failed') throw new Error('Public original restore failed: ' + (state.body.errorCode ?? 'unknown'));
          return state.body.status;
        }, { timeout: 300_000, intervals: [1000] }).toBe('succeeded');
        expect(await runtime.client.getInstance(options!.containerName)).toEqual(before);
        const expectedVolumes = structuredClone(beforeVolumes); expectedVolumes[0]!.config['user.agentor.workspace-preserve-ownership'] = 'true';
        expect(await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(expectedVolumes);
        await root(`sudo test ! -e ${quote(remoteData + '/incus-backup-helpers')} || sudo test -z "$(sudo ls -A ${quote(remoteData + '/incus-backup-helpers')})"`);
        const started = await appRequest('/api/containers/' + id + '/restart', { lockPassword }, true, 360_000); expect(started.status).toBe(200);
        expect((await runtime.client.getInstance(options!.containerName)).config['volatile.uuid']).toBe(incarnation);
        const checked = await runtime.client.exec(options!.containerName, ['python3', '-c', String.raw`
import os,stat,sys
p=sys.argv[1];f=p+'/data';s=os.stat(f)
assert open(f,'rb').read()==bytes([0,255,128,10,61,0]) and s.st_ino==os.stat(p+'/hard').st_ino
assert (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_mtime_ns)==(12345,23456,0o640,1700000000987654321)
assert os.getxattr(f,'user.binary')==bytes([0,255,128,10,61,0])
assert not os.path.lexists('/workspace/extra-after-'+sys.argv[2])
assert open('/home/agent/.agent-data/marker','rb').read()==b'agent-after-capture'
assert open('/root/original-public-'+sys.argv[2],'rb').read()==b'compute-root-after-capture'
`, path, id]);
        expect(checked.returnCode, checked.stderr).toBe(0); computeSettled = true;
        const retained = await runtime.client.exec(options!.containerName, ['bash', '-ec',
          'docker image inspect agentor-archive-lower:proof >/dev/null; docker container inspect archive-layer archive-stopped >/dev/null; ' +
          'docker run --rm -v archive-data:/data busybox:1.37.0 sh -ec \'test "$(cat /data/ordinary)" = persistent\'; ' +
          'python3 -c \'import sys;assert open(sys.argv[1]+"/data","rb").read()==bytes([0,255,128,10,61,0])\' "$1"', 'bash', volume.target]);
        expect(retained.returnCode, retained.stderr).toBe(0);
      }
      console.info('Actual encrypted worker backup/public original dispatch passed protection rejects, native kind/durable identity fence, stopped sameVM replacement and metadata-only workspace acknowledgement; agents/Docker/managed state retained');
    }
    if (rest) {
      const expectedSource = manifest.volumes.find(v => v.runtime?.role === 'workspace')!.runtime;
      if (expectedSource?.role !== 'workspace') throw new Error('Original native source proof missing');
      await runProducer(expectedSource.source, installation);
    }
    completed = true;
    console.info(ordinary ? 'Real constrained helper committed original stopped intent; explicit native start verified editor/desktop and Docker image/container/named-volume data'
      : 'Real constrained helper committed retained binary/native metadata, zero source references, no synthetic worker, exact Docker target restart');
  } catch (error) {
    console.error('Native helper-process gate primary failure', error instanceof Error ? error.message : 'Unknown failure');
    throw error;
  } finally {
    // A failed helper may have unknown native acknowledgement. Keep every
    // exact source/installed record and fixture; absence alone is not cleanup.
    if (completed && (rollback || baseline)) {
      if (ordinary && !rollback) {
        if (!computeSettled || !incarnation) throw new Error('Unconfirmed ordinary compute cleanup authority');
        const current = await runtime.client.getInstance(options!.containerName);
        expect(current.config['volatile.uuid']).toBe(incarnation);
        expect(await runtime.matchesWorkerIdentity(current, id, userId)).toBe(true);
        await runtime.remove(options!, incarnation); await runtime.removeStorage(options!);
      }
      if (!rollback) {
        const current = await managedRuntime.inspectVolume(volume);
        if (!current || current.used_by.length || current.project !== baseline!.project || current.created_at !== baseline!.created_at ||
            !isDeepStrictEqual(current.config, baseline!.config)) throw new Error('Exact fixture cleanup authority changed');
        await managedRuntime.delete(volume);
      }
      for (const containerId of [helperRemovedByManager ? undefined : helperId, targetId, retained?.parentId]) if (containerId) {
        expect(await root(`sudo docker inspect ${containerId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
          .toBe(`${containerId} ${containerId === retained?.parentId ? retained.parentImageId : imageId} ${jobId}`);
        await root(`sudo docker rm -f ${containerId}`);
      }
      if (sourceRuleBaseline) {
        expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${sourceTable}`))).toBe(sourceRuleBaseline);
        await root(`sudo nft delete table ip ${sourceTable}`);
      }
      expect(await root(`sudo docker image inspect ${quote(image)} --format '{{.Id}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
        .toBe(imageId + ' ' + jobId);
      await root(`sudo docker image rm ${quote(imageId!)}`);
      if (retained) {
        if (retained.oldNft) {
          expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${retained.oldNft.table}`)))
            .toBe(sourceRuleSnapshot(typeof retained.oldNft.json === 'string' ? retained.oldNft.json : JSON.stringify(retained.oldNft.json)));
          await root(`sudo nft delete table ip ${retained.oldNft.table}`);
        }
        expect(await root(`sudo docker image inspect ${retained.parentImageId} --format '{{.Id}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
          .toBe(`${retained.parentImageId} ${jobId}`);
        await root(`sudo docker image rm ${retained.parentImageId}`);
      }
      if (policyAdded) { await policy(false); policyAdded = false; }
      await root(`sudo rm -rf ${quote(remote)}`);
      if (retained) await root(`sudo rm -rf ${quote(retained.remoteDir)}`);
      cleaned = true;
    }
    if (cleaned || !targetId && !helperId && !startupHolderId) await rm(local, { recursive: true, force: true });
    else console.error('Retained exact unconfirmed helper-process fixture', { local, remote, id, jobId, restoreJobId, targetId, helperId, startupHolderId });
    // Do not replace the primary assertion with a cleanup failure. Unknown
    // native submission deliberately keeps every exact fixture for diagnosis.
    if (completed) expect(cleaned, 'Acknowledged fixture cleanup must complete').toBe(true);
  }
});
