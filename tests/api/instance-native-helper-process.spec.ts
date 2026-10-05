import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream } from 'node:fs';
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
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { createInstanceDataArchive, instanceVolumeArchiveName, instanceBundleFilename,
  sha256File, validateInstanceManifest } from '../../orchestrator/server/utils/instance-backup-bundle';
import type { InstanceBackupJob, InstanceBackupManifest } from '../../orchestrator/server/utils/instance-backup-types';

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
 * isolated inert recovery fixture, not the preserved acceptance installation;
 * full running-Orchestrator/public restore remains a separate required gate. */
for (const mode of ['retained', 'ordinary', 'omitted', 'rollback'] as const) test(mode === 'ordinary'
  ? 'real controlled helper process restores ordinary worker Docker data with stopped intent and exact account shares'
  : mode === 'omitted' ? 'real controlled helper process restores omitted agent state with writable private account parents'
  : mode === 'rollback' ? 'real controlled helper process rolls back acknowledged native data before restoring original control plane'
  : 'real controlled helper process restores retained native data and restarts only its exact recovery target', async () => {
  const ordinary = mode !== 'retained', rollback = mode === 'rollback';
  test.skip(process.env.INCUS_INSTANCE_HELPER_PROCESS_TEST !== 'true', 'Explicit serial approved disposable helper-process gate');
  test.setTimeout(900_000);
  const local = await mkdtemp(join(tmpdir(), 'agentor-native-helper-process-'));
  const source = join(local, 'source'), targetData = join(local, 'data'), build = join(local, 'image');
  const id = randomUUID(), volumeId = randomUUID(), jobId = randomUUID(), userId = (ordinary ? 'ordinary-' : 'retained-') + randomUUID();
  const remote = '/var/tmp/agentor-native-helper-process.' + jobId;
  const image = 'agentor-native-helper-process:' + jobId, targetName = 'native-recovery-' + jobId,
    helperName = 'agentor-instance-restore-' + jobId;
  const legacyName = 'agentor-native-rollback-' + jobId;
  const stamp = new Date().toISOString();
  const volume: StoredManagedVolume = { id: volumeId, userId, workerId: id, name: 'Retained native data',
    dockerName: 'agentor-persist-' + volumeId, target: '/srv/retained', purpose: 'persistent-path', storageRuntimeKind: 'incus-vm',
    attached: ordinary, seeded: true, state: ordinary ? 'ready' : 'detached',
    ...(!ordinary ? { retainedAfterAccountDeletion: true } : {}), createdAt: stamp, updatedAt: stamp };
  let targetId: string | undefined, helperId: string | undefined, imageId: string | undefined, completed = false, cleaned = false;
  let incarnation: string | undefined, policyAdded = false, computeSettled = true;
  let worker: WorkerRecord | undefined, options: IncusWorkerOptions | undefined;
  let dockerSource: string | undefined, dockerSourceDigest: string | undefined;
  let baseline: Awaited<ReturnType<IncusManagedVolumeRuntime['inspectVolume']>>;
  const config = { ...loadConfig(), dataDir: source, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusStoragePool: 'default', incusNetwork: 'incusbr0',
    incusWorkerImage: 'agentor-worker-phase10-preserve-ownership', incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key', incusServerCertPath: '/workspace/agentor-incus-tls/server.crt',
    incusDockerVolumeSize: '1GiB', incusInternalGatewayUrl: 'http://10.159.68.1:38000' };
  const runtime = new IncusWorkerRuntime(config), managedRuntime = new IncusManagedVolumeRuntime(config, runtime);
  const remoteData = remote + '/data';
  const accountPaths = ['credentials', 'kilo/config', 'kilo/data'].map(path => remoteData + '/users/' + userId + '/' + path);
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
`) + ' ' + quote(JSON.stringify(accountPaths)) + ' ' + (add ? 'add' : 'remove'));
  try {
    await Promise.all([mkdir(source), mkdir(join(targetData, 'admin'), { recursive: true }), mkdir(build)]);
    const installation = await backupInstallationId(source);
    const store = new ManagedVolumeStore(source); await store.init(); await store.save(volume);
    await writeFile(join(source, 'worker-config.key'), Buffer.alloc(32, 81).toString('base64') + '\n', { mode: 0o600 });
    if (ordinary) {
      // Reuse an operator-selected, previously accepted logical Docker capture,
      // unchanged. Never fabricate Docker internals or copy a physical device.
      dockerSource = process.env.INCUS_INSTANCE_HELPER_DOCKER_ARCHIVE;
      if (!dockerSource) throw new Error('Ordinary gate requires the accepted raw Docker archive fixture');
      dockerSourceDigest = await sha256File(dockerSource);
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
    const auth = join(local, 'auth.db'); await writeFile(auth, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096)]));
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
      backupId: jobId, sourceInstallationId: installation, createdByUserId: 'restored-admin', createdAt: stamp, agentorVersion: 'test',
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
    const remoteStage = remoteData + '/instance-restore-staging/restore-' + jobId;
    await writeFile(join(stage, 'restore-plan.json'), JSON.stringify({ version: 1, formatVersion: 2, jobId,
      dataArchive: remoteStage + '/unpacked/data.tar.gz', sourceInstallationId: installation,
      restoredOwnerId: 'restored-admin', stagingOwnerId: 'recovery-admin', restoreHostMountPolicies: false, manifest,
      volumes: manifest.volumes.map(v => ({ ...v, archive: remoteStage + '/unpacked/' + instanceBundleFilename(v.archive) })) }));
    const job: InstanceBackupJob = { schemaVersion: 1, id: jobId, userId: 'recovery-admin', operation: 'restore', provider: 'fake',
      status: 'running', phase: 'applying', progress: 70, bytesProcessed: 0, createdAt: stamp, updatedAt: stamp, logs: [] };
    await writeFile(join(targetData, 'admin/instance-backups.v1.json'), JSON.stringify({ schemaVersion: 1, jobs: [job], artifacts: [], remoteBackups: [] }));
    await writeFile(join(targetData, 'auth.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('old-target')]));
    await run(process.execPath, [fileURLToPath(new URL('../../orchestrator/build-instance-restore-native.mjs', import.meta.url)),
      join(build, 'instance-restore-native')], { env: {}, timeout: 60_000 });
    await copyFile(fileURLToPath(new URL('../../orchestrator/instance-restore-helper.mjs', import.meta.url)), join(build, 'instance-restore-helper.mjs'));
    await copyFile(fileURLToPath(new URL('../fixtures/instance-native-helper.Dockerfile', import.meta.url)), join(build, 'Dockerfile'));
    await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(runtime.client.getCustomVolume(config.incusStoragePool, volume.dockerName)).rejects.toMatchObject({ statusCode: 404 });
    expect((await runtime.client.request<{ driver: string }>('GET', '/1.0/storage-pools/' + config.incusStoragePool)).driver).toBe('dir');
    await root(`test ! -e ${quote(remote)} && mkdir -m 700 ${quote(remote)}`);
    await run('scp', [...scp, '-r', targetData, build, 'kata-test@172.19.0.1:' + remote + '/'], { timeout: 60_000 });
    if (ordinary) { await policy(true); policyAdded = true; }
    imageId = await root(`sudo docker build -q --label agentor.native-helper-fixture=${jobId} --build-arg REMOVE_VOLUME_HELPER_SLEEP=${rollback} -t ${quote(image)} ${quote(remote + '/image')}`, 120_000);
    expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await root(`sudo docker image inspect ${quote(image)} --format '{{.Id}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
      .toBe(imageId + ' ' + jobId);
    targetId = await root(`sudo docker run -d --name ${quote(targetName)} --label agentor.native-helper-fixture=${jobId} ` +
      `--network agentor-phase6-net --add-host agentor-kata-preflight:172.22.0.1 -e AGENTOR_INSTANCE_RECOVERY_MODE=true ` +
      `--mount type=bind,src=${remoteData},dst=${remoteData} ${quote(image)} node -e 'setInterval(()=>{},1000)'`);
    expect(targetId).toMatch(/^[a-f0-9]{64}$/);
    const env = [ 'AGENTOR_INSTANCE_RESTORE_NATIVE=true', `AGENTOR_INSTANCE_RESTORE_JOB=${jobId}`,
      `AGENTOR_INSTANCE_RESTORE_STAGE=${remoteStage}`, `AGENTOR_INSTANCE_RESTORE_DATA_DIR=${remoteData}`,
      `AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR=${targetId}`, 'CONTAINER_PREFIX=agentor-worker',
      'INCUS_ENDPOINT=https://agentor-kata-preflight:8443', 'INCUS_PROJECT=agentor', 'INCUS_NETWORK=incusbr0',
      'INCUS_STORAGE_POOL=default', 'INCUS_WORKER_IMAGE=agentor-worker-phase10-preserve-ownership',
      'INCUS_DOCKER_VOLUME_SIZE=1GiB', 'INCUS_INTERNAL_GATEWAY_URL=http://10.159.68.1:38000',
      'INCUS_CLIENT_CERT_PATH=/tls/client.crt', 'INCUS_CLIENT_KEY_PATH=/tls/client.key', 'INCUS_SERVER_CERT_PATH=/tls/server.crt' ];
    // Exact assigned credential files only; never inject them into the guest.
    const tlsRoot = '/var/tmp/agentor-phase6-production.SSkg3hQz/tls';
    const mounts = ['client.crt', 'client.key', 'server.crt'].map(file =>
      `--mount type=bind,src=${tlsRoot}/${file},dst=/tls/${file},readonly`);
    console.info('Exact native helper-process fixture', { remote, id, jobId, volumeId, installation, targetId });
    helperId = await root(`sudo docker create --name ${quote(helperName)} --label agentor.native-helper-fixture=${jobId} --user 0:0 ` +
      `--network agentor-phase6-net --add-host agentor-kata-preflight:172.22.0.1 --read-only --cap-drop ALL ` +
      `--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges:true --pids-limit 64 --memory 256m ` +
      `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock ` +
      `--mount type=bind,src=${remoteData},dst=${remoteData} ${mounts.join(' ')} ${env.map(v => '-e ' + quote(v)).join(' ')} ` +
      `${quote(image)} node .output/server/instance-restore-helper.mjs`);
    expect(helperId).toMatch(/^[a-f0-9]{64}$/);
    await root(`sudo docker start ${helperId}`);
    const code = await root(`sudo docker wait ${helperId}`, 600_000);
    const logs = await root(`sudo docker logs ${helperId}`);
    expect(code, logs).toBe(rollback ? '1' : '0');
    const ledger = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["jobs"][0]))')} ${quote(remoteData + '/admin/instance-backups.v1.json')}`)) as InstanceBackupJob;
    if (rollback) {
      // A prior native failure could otherwise satisfy rollback's final
      // absence assertions. This bounded exact-job daemon witness proves the
      // legacy leaf ran only AFTER acknowledged native apply returned.
      const witnessName = `agentor-instance-volume-${jobId}-${createHash('sha256').update(legacyName).digest('hex').slice(0, 12)}`;
      const eventOutput = await root(`sudo docker events --since ${Math.floor(Date.parse(stamp) / 1000)} --until ${Math.ceil(Date.now() / 1000)} ` +
        `--filter type=container --filter event=create --filter label=agentor.instance-restore-job=${jobId} --format '{{json .}}'`, 10_000);
      const witnesses = eventOutput.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
        Actor: { ID: string; Attributes: Record<string, string> };
      });
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]!.Actor.ID).toMatch(/^[a-f0-9]{64}$/);
      expect(witnesses[0]!.Actor.Attributes).toMatchObject({ name: witnessName, image,
        'agentor.instance-restore-volume-helper': 'true', 'agentor.instance-restore-job': jobId });
      expect(ledger).toMatchObject({ id: jobId, userId: 'recovery-admin', status: 'failed', phase: 'failed', retryable: true });
      expect(ledger.errorCode).not.toBe('INSTANCE_RESTORE_ROLLBACK_INCOMPLETE');
      expect(await root(`sudo docker inspect ${targetId} --format '{{.State.Running}}'`)).toBe('true');
      const oldDb = await root(`sudo python3 -c ${quote('import sys; print(open(sys.argv[1],"rb").read().hex())')} ${quote(remoteData + '/auth.db')}`);
      expect(oldDb).toBe(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('old-target')]).toString('hex'));
      await root(`test ! -e ${quote(remoteData + '/users')} && test ! -e ${quote(remoteData + '/instance-restore-rollback/' + jobId)}`);
      await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
      for (const name of [...['workspace', 'agents', 'docker'].map(role => config.containerPrefix + '-' + id + '-' + role), volume.dockerName])
        await expect(runtime.client.getCustomVolume(config.incusStoragePool, name)).rejects.toMatchObject({ statusCode: 404 });
      expect(await root(`sudo docker volume ls --format '{{.Name}}' --filter name=^${legacyName}$`)).toBe('');
      expect(await root(`sudo docker ps -aq --filter label=agentor.instance-restore-job=${jobId}`)).toBe('');
      expect(await sha256File(dockerSource!)).toBe(dockerSourceDigest);
      completed = true;
      console.info('Real legacy Docker start failure after acknowledged native apply: native cleanup settled BEFORE original control plane restored; only exact recovery target restarted');
      return;
    }
    expect(ledger).toMatchObject({ id: jobId, userId: 'restored-admin', status: 'succeeded', phase: 'complete' });
    expect(await root(`sudo docker inspect ${targetId} --format '{{.State.Running}}'`)).toBe('true');
    const record = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[0]))')} ` +
        quote(remoteData + (ordinary ? '/users/' : '/retained-storage/users/') + userId + '/managed-volumes.v1.json'))) as StoredManagedVolume;
    expect(record).toMatchObject({ id: volumeId, workerId: id, userId, seeded: true, attached: ordinary, state: ordinary ? 'ready' : 'detached',
      ...(!ordinary ? { retainedAfterAccountDeletion: true } : {}) });
    await root(`test ! -e ${quote(remoteData + '/instance-restore-rollback/' + jobId)}`);
    if (!ordinary) {
      await root(`test ! -e ${quote(remoteData + '/users')}`);
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
      await runtime.start(options!, incarnation); computeSettled = true;
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
      for (const containerId of [helperId, targetId]) if (containerId) {
        expect(await root(`sudo docker inspect ${containerId} --format '{{index .Config.Labels "agentor.native-helper-fixture"}}'`)).toBe(jobId);
        await root(`sudo docker rm -f ${containerId}`);
      }
      expect(await root(`sudo docker image inspect ${quote(image)} --format '{{.Id}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
        .toBe(imageId + ' ' + jobId);
      await root(`sudo docker image rm ${quote(imageId!)}`);
      if (policyAdded) { await policy(false); policyAdded = false; }
      await root(`sudo rm -rf ${quote(remote)}`); cleaned = true;
    }
    if (cleaned || !targetId && !helperId) await rm(local, { recursive: true, force: true });
    else console.error('Retained exact unconfirmed helper-process fixture', { local, remote, id, jobId, targetId, helperId });
    // Do not replace the primary assertion with a cleanup failure. Unknown
    // native submission deliberately keeps every exact fixture for diagnosis.
    if (completed) expect(cleaned, 'Acknowledged fixture cleanup must complete').toBe(true);
  }
});
