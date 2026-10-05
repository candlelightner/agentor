import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { mkdir, mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { InstanceBackupStore } from '../../orchestrator/server/utils/instance-backup-store';
import type { InstanceBackupJob } from '../../orchestrator/server/utils/instance-backup-types';
import type { IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import type { StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import type { WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import type { IncusCustomVolume } from '../../orchestrator/server/utils/incus-client';
import { validatePortableManagedVolumeArchive } from '../../orchestrator/server/utils/portable-managed-volume-archive';

const run = promisify(execFile);
const buildScript = fileURLToPath(new URL('../../orchestrator/build-instance-restore-native.mjs', import.meta.url));
const importNative = new Function('path', 'return import(path)') as
  (path: string) => Promise<typeof import('../../orchestrator/instance-restore-native')>;
const inspectScript = String.raw`
import base64,json,os,stat,sys
p=sys.argv[1];s=os.lstat(p+'/data')
print(json.dumps(dict(bytes=base64.b64encode(open(p+'/data','rb').read()).decode(),
 uid=s.st_uid,gid=s.st_gid,mode=stat.S_IMODE(s.st_mode),mtime=s.st_mtime_ns,
 hard=os.stat(p+'/data').st_ino==os.stat(p+'/hard').st_ino,
 attr=base64.b64encode(os.getxattr(p+'/data','user.binary')).decode())))
`;

for (const retainedOnly of [false, true]) test(`real compiled detached inverse ${retainedOnly ? 'retains deleted-owner authority after temporary compute/core cleanup' : 'promotes mixed data without attaching historical volumes'}`, async () => {
  test.skip(process.env.INCUS_INSTANCE_DETACHED_RESTORE_TEST !== 'true', 'Explicit serial disposable native restore gate');
  test.setTimeout(900_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-instance-detached-inverse-'));
  const id = randomUUID(), userId = 'detached-restore-' + randomUUID(), nonce = randomUUID();
  const config = { ...loadConfig(), dataDir, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusStoragePool: 'default', incusNetwork: 'incusbr0',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000', incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key', incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  const options: IncusWorkerOptions = { id, userId, containerName: config.containerPrefix + '-' + id, start: false, recreationNonce: nonce,
    dockerEnabled: false, cpuLimit: 2, memoryLimit: '2GiB', userEnv: zeroUserEnvVars(userId),
    capabilitiesJson: [], instructionsJson: [],
    environmentJson: { dockerEnabled: false, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
      exposeApis: { portMappings: false, domainMappings: false, usage: false } },
    workerJson: { id, displayName: 'Detached inverse gate', repos: [], initScript: '', gitName: '', gitEmail: '' },
  } satisfies IncusWorkerOptions;
  let native: Awaited<ReturnType<typeof importNative>> | undefined;
  let runtime: InstanceType<typeof import('../../orchestrator/instance-restore-native')['IncusWorkerRuntime']> | undefined;
  let incarnation: string | undefined, submitted = false, settled = true, cleaned = false;
  let records: StoredManagedVolume[] = [];
  const nativeBaselines = new Map<string, IncusCustomVolume>();
  const fixtureUid = process.getuid?.(), fixtureGid = process.getgid?.();
  const marker: NonNullable<WorkerRecord['incusRecreation']> = { nonce, initialCreate: true, importIncomplete: true };
  const job: InstanceBackupJob = { schemaVersion: 1, id: nonce, userId: 'recovery-admin', provider: 'fake', operation: 'restore',
    status: 'running', phase: 'native-inverse', progress: 82, bytesProcessed: 0, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), logs: [] };
  try {
    if (fixtureUid === undefined || fixtureGid === undefined) throw new Error('Native fixtures require Unix numeric identities');
    await run(process.execPath, [buildScript, join(dataDir, 'adapter')], { env: {}, timeout: 45_000 });
    native = await importNative(pathToFileURL(join(dataDir, 'adapter/index.mjs')).href);
    runtime = new native.IncusWorkerRuntime(config);
    const managed = new native.ManagedVolumeStore(dataDir), workers = new native.WorkerStore(dataDir), jobs = new InstanceBackupStore(dataDir);
    await Promise.all([managed.init(), workers.init(), jobs.init()]); await jobs.saveJob(job);
    console.info('Exact compiled detached inverse fixture', { dataDir, id, userId, nonce, retainedOnly,
      installation: await backupInstallationId(dataDir) });
    const stamp = new Date().toISOString(), payloads: Array<{ volume: StoredManagedVolume; archivePath: string }> = [];
    const expected = new Map<string, unknown>();
    for (let index = 0; index < 2; index++) {
      const volumeId = randomUUID(), attached = !retainedOnly && index === 0;
      // Historical targets may overlap. Their UUID-private extraction roots
      // remain disjoint; only the currently attached record is operational.
      const volume: StoredManagedVolume = { id: volumeId, workerId: id, userId,
        dockerName: 'agentor-persist-' + volumeId, name: 'Logical restore ' + index, target: '/srv/restored-data',
        purpose: 'persistent-path', storageRuntimeKind: 'incus-vm', attached, seeded: false, state: 'pending',
        createdAt: stamp, updatedAt: stamp, ...(!attached ? { retainedAfterAccountDeletion: true } : {}) };
      await managed.save(volume); records.push(managed.get(userId, volumeId)!);
      const stage = join(dataDir, 'input-' + volumeId); await mkdir(join(stage, 'volume'), { recursive: true });
      await run('sudo', ['python3', '-c', String.raw`
import os,sys
p=sys.argv[1];f=p+'/data';open(f,'wb').write(sys.argv[2].encode()+bytes([0,255,128,10,61,0]))
os.link(f,p+'/hard');os.chown(f,12345,23456);os.chmod(f,0o640)
os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]));os.utime(f,ns=(1700000000123456789,1700000000987654321))
`, join(stage, 'volume'), volumeId]);
      expected.set(volumeId, JSON.parse((await run('sudo', ['python3', '-c', inspectScript, join(stage, 'volume')])).stdout));
      const archivePath = join(dataDir, volumeId + '.tar');
      await run('sudo', ['tar', '--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', stage, '-cf', archivePath, 'volume']);
      await run('sudo', ['chown', `${fixtureUid}:${fixtureGid}`, archivePath]);
      await validatePortableManagedVolumeArchive(archivePath, { target: volume.target, requirePosixUstar: true });
      payloads.push({ volume: records.at(-1)!, archivePath });
    }
    if (!retainedOnly) await workers.upsert({ id, userId, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'stopped',
      displayName: 'Mixed restored data', createdAt: stamp, updatedAt: stamp, incusRecreation: marker });
    const validate = async () => {
      await Promise.all([managed.init(), workers.init(), jobs.reload()]);
      const currentJob = jobs.getJob(nonce);
      if (!currentJob || currentJob.operation !== 'restore' || currentJob.status !== 'running' || currentJob.userId !== job.userId)
        throw new Error('Controlled restore job authority changed');
      if (!isDeepStrictEqual(managed.forWorker(userId, id).sort((a, b) => a.id.localeCompare(b.id)),
          [...records].sort((a, b) => a.id.localeCompare(b.id)))) throw new Error('Detached restore records changed');
      if (retainedOnly) {
        if (workers.list().length) throw new Error('Deleted-owner restore acquired a WorkerRecord');
        await expect(lstat(join(dataDir, 'users'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const record = workers.get(userId, id);
        if (!record || record.status !== 'active' || record.desiredRuntimeStatus !== 'stopped' || record.deletionPending ||
            !isDeepStrictEqual(record.incusRecreation, marker)) throw new Error('Mixed worker restore authority changed');
      }
    };
    await validate();
    options.managedVolumes = records.filter(volume => volume.attached);
    const detached = records.filter(volume => !volume.attached);
    submitted = true; settled = false;
    const created = await runtime.createCanonicalRestore(options, undefined, false, detached);
    incarnation = created.config['volatile.uuid'];
    if (!incarnation) throw new Error('Detached inverse create acknowledgement lacks incarnation');
    settled = true; marker.replacementIncarnation = incarnation;
    if (!retainedOnly) await workers.transitionIncusRecreation(userId, id,
      { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker });
    const baseline = await Promise.all(records.map(volume => runtime!.client.getCustomVolume(config.incusStoragePool, volume.dockerName)));
    for (const [index, record] of records.entries()) nativeBaselines.set(record.id, baseline[index]!);
    settled = false;
    await runtime.restoreCanonicalArchives(options, incarnation, {}, validate, undefined,
      payloads.filter(item => item.volume.attached), [], payloads.filter(item => !item.volume.attached));
    settled = true;
    for (const volume of records) {
      const root = `/restore/managed/${volume.id}/volume`;
      const result = await runtime.client.exec(options.containerName, ['python3', '-c', inspectScript, root]);
      expect(result.returnCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expected.get(volume.id));
    }
    const inactive = await runtime.client.exec(options.containerName, ['bash', '-ec',
      'test ! -e /run/agentor/provisioned; test ! -e /run/agentor/worker.env; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; test "$(ls /sys/class/net | wc -l)" = 1']);
    expect(inactive.returnCode, inactive.stdout + inactive.stderr).toBe(0);
    if (retainedOnly) {
      // No fake worker or operational grant: exact temporary compute/core
      // cleanup must acknowledge BEFORE retained data becomes seeded.
      await validate(); settled = false;
      await runtime.remove(options, incarnation); await runtime.removeStorage(options);
      settled = true;
      await expect(runtime.client.getInstance(options.containerName)).rejects.toMatchObject({ statusCode: 404 });
      for (const [index, volume] of records.entries()) {
        const current = await runtime.client.getCustomVolume(config.incusStoragePool, volume.dockerName);
        expect(current.project).toBe(baseline[index]!.project);
        expect(current.type).toBe(baseline[index]!.type);
        expect(current.content_type).toBe(baseline[index]!.content_type);
        expect(current.created_at).toBe(baseline[index]!.created_at);
        expect(current.config).toEqual(baseline[index]!.config);
        expect(current.used_by).toEqual([]);
      }
    }
    for (let index = 0; index < records.length; index++) {
      await validate(); const volume = records[index]!;
      if (retainedOnly) {
        const current = await runtime.client.getCustomVolume(config.incusStoragePool, volume.dockerName);
        expect(current.project).toBe(baseline[index]!.project);
        expect(current.type).toBe(baseline[index]!.type);
        expect(current.content_type).toBe(baseline[index]!.content_type);
        expect(current.created_at).toBe(baseline[index]!.created_at);
        expect(current.config).toEqual(baseline[index]!.config);
        expect(current.used_by).toEqual([]);
      }
      await managed.save({ ...volume, seeded: true, state: volume.attached ? 'ready' : 'detached' });
      records[index] = managed.get(userId, volume.id)!;
      await validate();
    }
    if (!retainedOnly) {
      options.managedVolumes = records.filter(volume => volume.attached);
      settled = false;
      await runtime.finishCanonicalRestore(options, incarnation, validate, 'stopped', records.filter(volume => !volume.attached));
      settled = true;
      const promoted = await runtime.client.getInstance(options.containerName);
      expect(promoted.status).toBe('Stopped');
      for (const volume of records) expect(!!promoted.devices['m' + volume.id.replaceAll('-', '').slice(0, 6)]).toBe(volume.attached);
    }
    await validate();
    for (const [index, volume] of records.entries()) {
      const current = await runtime.client.getCustomVolume(config.incusStoragePool, volume.dockerName);
      expect(current.config).toEqual(baseline[index]!.config);
      expect(current.created_at).toBe(baseline[index]!.created_at);
      expect(current.used_by.length).toBe(volume.attached ? 1 : 0);
      expect(volume.state).toBe(volume.attached ? 'ready' : 'detached');
    }
    console.info('Compiled detached inverse preserved binary metadata, logical IDs, target history, desired attachment and exact native data authority', { retainedOnly });
  } catch (error) {
    console.error('Detached inverse live gate failed', error instanceof Error ? error.message : String(error)); throw error;
  } finally {
    if (submitted && settled && incarnation && runtime && native) {
      try {
        await runtime.rollbackRecreation(options, marker); await runtime.removeStorage(options);
        for (const volume of records) {
          const current = await new native.IncusManagedVolumeRuntime(config, runtime).inspectVolume(volume);
          const baseline = nativeBaselines.get(volume.id);
          if (!current || !baseline || current.used_by.length || current.project !== baseline.project ||
              current.created_at !== baseline.created_at || !isDeepStrictEqual(current.config, baseline.config))
            throw new Error('Fixture volume cleanup authority is unavailable');
          await runtime.client.deleteCustomVolume(config.incusStoragePool, volume.dockerName);
        }
        cleaned = true;
      } catch (error) { console.error('Exact detached inverse fixture retained', { dataDir, id, nonce, incarnation, error: String(error) }); }
    } else if (!submitted) cleaned = true;
    else console.error('Unconfirmed detached inverse mutation retained', { dataDir, id, nonce, incarnation });
    if (cleaned) await rm(dataDir, { recursive: true, force: true });
    expect(cleaned, 'Unknown native authority must retain its exact durable fixture').toBe(true);
  }
});
