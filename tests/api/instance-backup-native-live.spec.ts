import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InstanceBackupManager } from '../../orchestrator/server/utils/instance-backup-manager';
import { FakeBackupProvider } from '../../orchestrator/server/utils/backup-provider';
import { backupKeyFingerprint } from '../../orchestrator/server/utils/backup-keyring';
import { decryptInstanceBackup } from '../../orchestrator/server/utils/instance-backup-crypto';
import { inspectInstanceBundle, prepareInstanceNativeVolumeArchive } from '../../orchestrator/server/utils/instance-backup-bundle';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import type { StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import { useConfig, useContainerManager, useWorkerStore, useStorageManager, usePortMappingStore, useDomainMappingStore } from '../../orchestrator/server/utils/services';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import { isWorkerLifecycleMutationPending } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { instanceSnapshotActive } from '../../orchestrator/server/utils/instance-snapshot-gate';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).usePortMappingStore ??= usePortMappingStore;
(globalThis as any).useDomainMappingStore ??= useDomainMappingStore;
(globalThis as any).useWorkerConfigStore ??= useWorkerConfigStore;

test('production native whole-instance capture preserves stopped canonical, disabled Docker, detached and deleted-owner managed data', async () => {
  test.skip(process.env.INCUS_INSTANCE_BACKUP_TEST !== 'true', 'Explicit serial disposable whole-instance capture gate');
  test.setTimeout(1_500_000);
  const config = useConfig(), priorConfig = { ...config };
  Object.assign(config, { containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusDockerVolumeSize: '1GiB', incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' });
  const id = randomUUID(), userId = randomUUID(), nonce = randomUUID();
  const owner = { id, userId, containerName: config.containerPrefix + '-' + id };
  const stage = join(config.dataDir, 'instance-native-gate-' + id); await mkdir(stage, { mode: 0o700 });
  const workers = useWorkerStore(); await workers.init();
  const managed = useManagedVolumeManager(); await managed.init();
  const containers = useContainerManager(), storage = useStorageManager();
  const runtime = new IncusWorkerRuntime(config), volumes = new IncusManagedVolumeRuntime(config, runtime);
  const prior = { runtime: (containers as any).incusRuntime, workerStore: (containers as any).workerStore,
    managed: (managed as any).incus, mode: storage.mode, init: storage.init };
  containers.setIncusRuntime(runtime); containers.setWorkerStore(workers); (managed as any).incus = volumes;
  storage.mode = 'directory'; storage.init = async () => {}; // Existing control-plane mount topology, not native data selection.
  const material = Buffer.alloc(32, 85).toString('base64'), provider = new FakeBackupProvider(join(stage, 'provider'));
  const dockerCalls: string[] = [];
  let advertiseLegacyCollisions = true;
  const docker = { listVolumes: async () => ({ Volumes: advertiseLegacyCollisions ? [
    ...['workspace', 'agents', 'docker'].map(role => ({ Name: owner.containerName + '-' + role })),
    { Name: 'retained-migration-path', Labels: { 'agentor.worker-id': id } },
  ] : [] }), getVolume: (name: string) => { dockerCalls.push(name); throw new Error('Native instance data must never use Docker volume inspection'); } };
  const backup = new InstanceBackupManager({ dataDir: config.dataDir, docker: docker as any,
    authSnapshot: path => writeFile(path, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096)])),
    preflightCreate: async () => { expect(containers.get(id)?.status ?? 'stopped').toBe('stopped'); },
    backupManager: { instanceBackupProvider: () => provider,
      resolveInstanceRecoveryMaterial: async () => ({ material, fingerprint: backupKeyFingerprint(material) }) } as any });
  let incarnation: string | undefined, submitted = false, removed = false;
  let attached: StoredManagedVolume | undefined, detached: StoredManagedVolume | undefined;
  const fixtureVolumes = () => {
    if (!attached || !detached) throw new Error('Fixture managed storage was not initialized');
    return [attached, detached] as const;
  };
  const exec = async (command: string[]) => {
    const result = await runtime.client.exec(owner.containerName, command);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0); return result.stdout.trim();
  };
  const seed = async (path: string, marker: string) => exec(['python3', '-c', String.raw`
import os,sys
p=sys.argv[1];os.makedirs(p,exist_ok=True);f=p+'/data'
open(f,'wb').write(sys.argv[2].encode()+bytes([0,255,128,10,61,0]))
os.chown(f,12345,23456);os.chmod(f,0o640);os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]))
os.link(f,p+'/hard');os.symlink(p+'/data',p+'/link')
`, path, marker]);
  const baseline = async () => ({ instance: removed ? undefined : await runtime.client.getInstance(owner.containerName),
    volumes: await Promise.all([...['workspace', 'agents', 'docker'].map(role => owner.containerName + '-' + role),
      ...fixtureVolumes().map(v => v.dockerName)].map(name => runtime.client.getCustomVolume(config.incusStoragePool, name))),
    records: managed.store.forWorker(userId, id), worker: workers.findById(id) });
  try {
    console.info('Exact whole-instance native fixture', { ...owner, nonce, dataDir: config.dataDir, installation: await backupInstallationId(config.dataDir) });
    await workers.upsert({ ...owner, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'running', displayName: 'Instance capture gate' } as any);
    attached = await managed.store.create(userId, id, '/srv/instance-attached', 'Attached capture', 'incus-vm');
    detached = await managed.store.create(userId, id, '/srv/instance-detached', 'Detached capture', 'incus-vm');
    for (const v of [attached, detached]) {
      await volumes.ensureVolume(v); await managed.store.save({ ...v, seeded: true, state: 'ready' });
    }
    attached = managed.store.get(userId, attached.id)!; detached = managed.store.get(userId, detached.id)!;
    const options = { ...owner, start: true, recreationNonce: nonce, dockerEnabled: true,
      capabilitiesJson: [], instructionsJson: [],
      managedVolumes: [attached, detached], cpuLimit: 2, memoryLimit: '2GiB', userEnv: zeroUserEnvVars(userId),
      environmentJson: { dockerEnabled: true, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
        exposeApis: { portMappings: false, domainMappings: false, usage: false } },
      workerJson: { id, displayName: 'Instance capture gate', repos: [], initScript: '', gitName: '', gitEmail: '' } } satisfies IncusWorkerOptions;
    submitted = true;
    const instance = await runtime.create({ ...options, start: false });
    incarnation = instance.config['volatile.uuid'];
    await runtime.start(options, incarnation);
    (containers as any).containers.set(id, { ...owner, runtimeKind: 'incus-vm', containerId: 'incus:' + incarnation,
      status: 'running', displayName: 'Instance capture gate', mounts: [], repos: [], imageName: config.incusWorkerImage });
    await seed('/workspace/instance', 'workspace'); await seed('/home/agent/.agent-data/instance', 'agents');
    await seed(attached.target, 'attached'); await seed(detached.target, 'detached');
    await exec(['docker', 'volume', 'create', 'instance-persist']);
    await seed('/var/lib/docker/volumes/instance-persist/_data', 'docker');
    await runtime.stop(owner, incarnation); containers.get(id)!.status = 'stopped';
    await workers.upsert({ ...workers.findById(id)!, desiredRuntimeStatus: 'stopped' });
    // Only the disposable fixture is changed: stopped compute detaches one
    // seeded volume. Capture itself must never alter source devices/records.
    let compute = await runtime.client.getInstance(owner.containerName);
    const devices = structuredClone(compute.devices); delete devices[volumes.deviceKey(detached)];
    await runtime.client.updateInstanceDevices(owner.containerName, devices);
    await managed.store.save({ ...detached, attached: false, state: 'detached' }); detached = managed.store.get(userId, detached.id)!;
    // Docker capability is now disabled while its volume/data remain canonical.
    const retainedOnly = process.env.INCUS_INSTANCE_BACKUP_RETAINED_ONLY === 'true';
    if (!retainedOnly) {
      await runtime.start({ ...options, managedVolumes: [attached], dockerEnabled: false,
        environmentJson: { ...options.environmentJson, dockerEnabled: false } }, incarnation);
      expect(await exec(['bash', '-ec', 'if systemctl is-active --quiet docker; then exit 1; fi; echo disabled'])).toBe('disabled');
      await runtime.stop(owner, incarnation);
    }
    const nativeExec = runtime.client.execStream.bind(runtime.client);
    runtime.client.execStream = async (name, command, opts) => {
      if (name.startsWith('abk-')) {
        expect(instanceSnapshotActive()).toBe(true); expect(isWorkerLifecycleMutationPending(id)).toBe(true);
        const helper = await runtime.client.getInstance(name);
        expect(helper.profiles).toEqual([]); expect(Object.values(helper.devices).some(d => d.type === 'nic')).toBe(false);
      }
      return nativeExec(name, command, opts);
    };
    const run = promisify(execFile);
    const modes = retainedOnly ? ['retained-deleted-owner'] as const : ['stopped', 'retained-deleted-owner'] as const;
    for (const mode of modes) {
      if (mode === 'retained-deleted-owner') {
        await runtime.remove(owner, incarnation); removed = true; containers.unregisterExternal(id);
        await workers.delete(userId, id);
        // This retained-only case has no legacy fixtures. Do not invent
        // unrelated Docker-labelled orphan volumes after the source is gone.
        advertiseLegacyCollisions = false;
        await managed.store.save({ ...attached, attached: false, state: 'detached' });
        await managed.retainDeletedOwner(userId);
      }
      const before = await baseline();
      const job = await backup.create(userId, 'fake', {});
      await expect.poll(async () => {
        const current = await backup.getJob(job.id);
        if (current?.status === 'failed') throw new Error(JSON.stringify(current));
        return current?.status;
      }, { timeout: 600_000, intervals: [1000] }).toBe('succeeded');
      const artifact = (await backup.list(userId)).artifacts.find(a => a.id === job.id)!;
      expect(artifact.formatVersion).toBe(2); expect(dockerCalls).toEqual([]);
      expect(await baseline()).toEqual(before);
      const bundle = join(stage, mode + '.tar'), unpack = join(stage, mode + '-unpack'), rawDir = join(stage, mode + '-raw');
      await mkdir(rawDir, { mode: 0o700 });
      await decryptInstanceBackup(join(config.dataDir, 'instance-backup-artifacts', artifact.id + '.backup'), bundle, material, artifact.sha256);
      const inspected = await inspectInstanceBundle(bundle, unpack);
      expect(inspected.manifest.volumes).toHaveLength(mode === 'stopped' ? 5 : 2);
      for (const v of inspected.manifest.volumes) {
        expect(v.runtime?.kind).toBe('incus-vm');
        const raw = await prepareInstanceNativeVolumeArchive(inspected.volumeArchives.get(v.name)!, v, rawDir);
        const role = v.runtime!.role;
        const entry = role === 'workspace' ? 'workspace/instance/data' : role === 'agents' ? '.agent-data/instance/data'
          : role === 'docker' ? 'docker/volumes/instance-persist/_data/data' : 'volume/data';
        const marker = role === 'managed' ? v.name === attached.dockerName ? 'attached' : 'detached' : role;
        const content = (await run('tar', ['-xOf', raw.archivePath, '--', entry], { encoding: 'buffer' })).stdout;
        expect(content).toEqual(Buffer.concat([Buffer.from(marker), Buffer.from([0,255,128,10,61,0])]));
      }
      console.info('Native whole-instance gate passed', mode, artifact.id, inspected.manifest.volumes.map(v => v.runtime!.role));
      await provider.delete(userId, artifact.providerObjectId);
      await (backup as any).store.removeArtifact(artifact.id);
      await rm((backup as any).artifactPath(artifact.id));
      await rm(bundle); await rm(unpack, { recursive: true }); await rm(rawDir, { recursive: true });
    }
  } catch (error) {
    console.error('Native instance capture gate failed:', error instanceof Error ? error.message : 'unknown failure'); throw error;
  } finally {
    if (incarnation) {
      if (!removed) await runtime.remove(owner, incarnation);
      for (const v of [attached, detached].filter((v): v is StoredManagedVolume => !!v)) {
        const current = managed.store.get(userId, v.id)!;
        await volumes.delete(current); await managed.store.forget(userId, v.id);
      }
      await runtime.removeStorage(owner);
      if (workers.findById(id)) await workers.delete(userId, id);
      containers.unregisterExternal(id);
      await rm(stage, { recursive: true, force: true });
    } else if (submitted) throw new Error('Unknown native fixture creation; retain exact registry for diagnosis');
    Object.assign(config, priorConfig); containers.setIncusRuntime(prior.runtime); (containers as any).workerStore = prior.workerStore;
    (managed as any).incus = prior.managed; storage.mode = prior.mode; storage.init = prior.init;
  }
});
