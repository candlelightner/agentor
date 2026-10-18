import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, readlink, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { useConfig, useWorkerStore, usePortMappingStore, useDomainMappingStore } from '../../orchestrator/server/utils/services';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { extractBundle } from '../../orchestrator/server/utils/worker-export';
import { validateAndExtractPortableManagedVolumePayload } from '../../orchestrator/server/utils/portable-managed-volume-archive';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).usePortMappingStore ??= usePortMappingStore;
(globalThis as any).useDomainMappingStore ??= useDomainMappingStore;
(globalThis as any).useWorkerConfigStore ??= useWorkerConfigStore;

test('real production running/stopped/archived managed export retains v6 binary filesystem state with unchanged source authority', async () => {
  test.skip(process.env.INCUS_MANAGED_BACKUP_TEST !== 'true', 'Explicit serial disposable managed backup gate');
  // One source plus three offline helpers require four image allocations.
  // HDD-backed fixtures need headroom without changing per-operation bounds.
  test.setTimeout(1_200_000);
  const config = useConfig();
  Object.assign(config, { containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusNetwork: 'incusbr0',
    incusStoragePool: process.env.INCUS_TEST_STORAGE_POOL || 'default', incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase9-host-mounts',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' });
  const id = randomUUID(), owner = { id, userId: 'managed-backup-' + randomUUID(), containerName: config.containerPrefix + '-' + id };
  const store = useWorkerStore(); await store.init();
  const managed = useManagedVolumeManager(); await managed.init();
  const runtime = new IncusWorkerRuntime(config), volumes = new IncusManagedVolumeRuntime(config, runtime);
  (managed as any).incus = volumes;
  const manager = new ContainerManager(new Proxy({}, { get: () => () => { throw new Error('Native backup must not call Docker'); } }) as any, config);
  manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  const environment = { id: 'managed-backup-gate', name: 'Managed backup gate', envVars: '', dockerEnabled: false,
    networkMode: 'full', allowedDomains: [], setupScript: '',
    exposeApis: { portMappings: false, domainMappings: false, usage: false }, cpuLimit: 1, memoryLimit: '1g' };
  manager.setEnvironmentStore({ getById: () => environment } as any);
  const target = '/srv/native-backup', stage = join(config.dataDir, 'managed-backup-gate-' + id);
  await mkdir(stage, { mode: 0o700 });
  let incarnation: string | undefined, submitted = false, cleaned = false, failure: unknown;
  let volume: Awaited<ReturnType<typeof managed.store.create>> | undefined;
  let detached: Awaited<ReturnType<typeof managed.store.create>> | undefined;
  try {
    await store.upsert({ ...owner, runtimeKind: 'incus-vm', status: 'active', displayName: 'Managed capture gate',
      desiredRuntimeStatus: 'running' } as any);
    console.info('Exact managed backup fixture', { ...owner, dataDir: config.dataDir, installation: await backupInstallationId(config.dataDir) });
    volume = await managed.store.create(owner.userId, id, target, 'Canonical managed data', 'incus-vm');
    await volumes.ensureVolume(volume); // Empty disposable fixture; not capture code.
    await managed.store.save({ ...volume, seeded: true, state: 'ready' });
    volume = managed.store.get(owner.userId, volume.id)!;
    detached = await managed.store.create(owner.userId, id, '/srv/detached-backup', 'Excluded detached data', 'incus-vm');
    await managed.store.save({ ...detached, attached: false, state: 'detached' });
    submitted = true;
    const instance = await runtime.create({ ...owner, start: true, dockerEnabled: false, managedVolumes: [volume],
      userEnv: zeroUserEnvVars(owner.userId), environmentJson: environment, capabilitiesJson: [], instructionsJson: [],
      workerJson: { id, displayName: 'Managed capture gate', repos: [], initScript: '', gitName: '', gitEmail: '' } });
    incarnation = instance.config['volatile.uuid']; expect(incarnation).toBeTruthy();
    manager.registerExternal({ ...owner, containerId: 'incus:' + incarnation, runtimeKind: 'incus-vm',
      status: 'running', environmentId: environment.id, displayName: 'Managed capture gate',
      imageName: config.incusWorkerImage, imageId: instance.config['image.source_image_id'],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    const exec = async (command: string[]) => {
      const result = await runtime.client.exec(owner.containerName, command);
      expect(result.returnCode, result.stderr).toBe(0); return result.stdout;
    };
    const seed = await exec(['/usr/bin/python3', '-c', String.raw`
import errno,json,os,struct,sys
root=sys.argv[1]
with open(root+'/canonical.bin','wb') as file: file.write(bytes([0,255,128,10])*32768)
os.chmod(root+'/canonical.bin',0o640)
os.chown(root+'/canonical.bin',12345,23456)
os.setxattr(root+'/canonical.bin','user.agentor_binary',bytes([0,255,128,10,61,0]))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(root+'/canonical.bin','system.posix_acl_access',acl)
os.setxattr(root,'system.posix_acl_default',acl)
try: os.setxattr(root+'/canonical.bin','security.capability',struct.pack('<IIIII',0x02000001,1<<10,0,0,0))
except OSError as error:
 if error.errno not in (errno.EPERM,errno.EACCES,errno.ENOTSUP): raise
os.link(root+'/canonical.bin',root+'/canonical-hardlink')
os.symlink('canonical.bin',root+'/canonical-symlink')
os.symlink(root+'/canonical.bin',root+'/absolute-symlink')
print(json.dumps({'xattrs':{name:list(os.getxattr(root+'/canonical.bin',name)) for name in os.listxattr(root+'/canonical.bin')},'defaultAcl':list(os.getxattr(root,'system.posix_acl_default'))}))
`, target]);
    const metadata = JSON.parse(seed), boot = await exec(['cat', '/proc/sys/kernel/random/boot_id']);
    const pid = await exec(['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service']);
    const recordSnapshot = managed.store.forWorker(owner.userId, id);
    let baseline = await volumes.inspectVolume(volume), compute = await runtime.client.getInstance(owner.containerName);
    const nativeExec = runtime.client.execStream.bind(runtime.client), helpers = new Set<string>();
    runtime.client.execStream = async (name, command, options) => {
      if (command[0] === '/usr/bin/python3' && command.at(-3) === 'managed') {
        expect(command.slice(-3)).toEqual(['managed', '[]', 'offline']);
        const helper = await runtime.client.getInstance(name); helpers.add(name);
        expect(helper.profiles).toEqual([]);
        expect(helper.config['user.agentor.worker']).toBe(id);
        expect(Object.keys(helper.devices).sort()).toEqual(['managed', 'root']);
        expect(helper.devices.managed).toEqual({ type: 'disk', source: volume!.dockerName,
          path: '/volume', pool: config.incusStoragePool, readonly: 'true' });
        const isolation = await runtime.client.exec(name, ['bash', '-ec',
          'test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; findmnt -n -o OPTIONS --mountpoint /volume']);
        expect(isolation.returnCode, isolation.stderr).toBe(0); expect(isolation.stdout.trim().split(',')).toContain('ro');
        const during = await runtime.client.getCustomVolume(config.incusStoragePool, volume!.dockerName);
        expect(during.config).toEqual(baseline!.config); expect(during.created_at).toBe(baseline!.created_at);
        expect(during.used_by).toHaveLength(baseline!.used_by.length + 1);
        if (store.get(owner.userId, id)?.status === 'active') {
          const original = await runtime.client.getInstance(owner.containerName);
          expect(original.status).toBe(compute.status); expect(original.config['volatile.uuid']).toBe(incarnation);
          expect(original.devices).toEqual(compute.devices);
        } else await expect(runtime.client.getInstance(owner.containerName)).rejects.toMatchObject({ statusCode: 404 });
      }
      return nativeExec(name, command, options);
    };
    const run = promisify(execFile);
    for (const mode of ['running', 'stopped', 'archived'] as const) {
      if (mode === 'stopped') {
        await runtime.stop(owner, incarnation); manager.get(id)!.status = 'stopped';
        await store.upsert({ ...store.get(owner.userId, id)!, desiredRuntimeStatus: 'stopped' });
        compute = await runtime.client.getInstance(owner.containerName);
      }
      if (mode === 'archived') {
        await runtime.remove(owner, incarnation); (manager as any).containers.delete(id);
        await store.upsert({ ...store.get(owner.userId, id)!, status: 'archived' });
      }
      baseline = await volumes.inspectVolume(volume);
      const bundle = join(stage, mode + '.tar'), result = await manager.exportWorker(id, {
        includeRootfs: false, includeWorkspace: false, includeAgents: false, includeManagedVolumes: true });
      await pipeline(result.stream, createWriteStream(bundle, { mode: 0o600 }));
      const extracted = await extractBundle(bundle, join(stage, mode + '-bundle'));
      expect(extracted.manifest.version).toBe(6); expect(extracted.manifest.runtime?.kind).toBe('incus-vm');
      expect(extracted.manifest.managedVolumes).toEqual([{ target, name: volume.name, archive: 'volumes/0.tar' }]);
      expect(extracted.manifest.localPersistence).toEqual(expect.arrayContaining([
        { path: target, included: true }, { path: detached.target, included: false }]));
      const inner = await validateAndExtractPortableManagedVolumePayload(extracted.managedVolumesPath!,
        extracted.manifest.managedVolumes!, join(stage, mode + '-payload'));
      const restored = join(stage, mode + '-restored'); await mkdir(restored);
      await run('/usr/bin/tar', ['--xattrs', '--xattrs-include=*', '--xattrs-exclude=security.capability',
        '--acls', '--no-same-owner', '-xpf', inner[0]!.archivePath, '-C', restored]);
      const file = join(restored, 'volume/canonical.bin');
      expect(await readFile(file)).toEqual(Buffer.from(Array.from({ length: 32768 }, () => [0,255,128,10]).flat()));
      expect((await lstat(file)).ino).toBe((await lstat(join(restored, 'volume/canonical-hardlink'))).ino);
      expect(await readlink(join(restored, 'volume/canonical-symlink'))).toBe('canonical.bin');
      expect(await readlink(join(restored, 'volume/absolute-symlink'))).toBe(target + '/canonical.bin');
      const observed = await run('python3', ['-c', String.raw`
import json,os,sys,tarfile
with tarfile.open(sys.argv[1]) as archive:
 entry=archive.getmember('volume/canonical.bin')
 print(json.dumps({'uid':entry.uid,'gid':entry.gid,'mode':entry.mode,
 'xattrs':{name:list(os.getxattr(sys.argv[2],name)) for name in os.listxattr(sys.argv[2])},
 'rawXattrs':{name[13:]:list(value.encode('utf-8','surrogateescape')) for name,value in entry.pax_headers.items() if name.startswith('SCHILY.xattr.')},
 'defaultAcl':list(os.getxattr(sys.argv[3],'system.posix_acl_default'))}))
`, inner[0]!.archivePath, file, join(restored, 'volume')]);
      const restoredMetadata = JSON.parse(observed.stdout);
      expect(restoredMetadata).toMatchObject({ uid: 12345, gid: 23456, mode: 0o640, defaultAcl: metadata.defaultAcl });
      expect(restoredMetadata.rawXattrs).toEqual(metadata.xattrs);
      // Local worker lacks CAP_SETFCAP; raw PAX preserves that optional guest
      // attribute, while GNU extraction verifies all locally supported attrs.
      for (const [name, value] of Object.entries(metadata.xattrs)) if (name !== 'security.capability')
        expect(restoredMetadata.xattrs[name]).toEqual(value);
      expect(await volumes.inspectVolume(volume)).toEqual(baseline);
      expect(managed.store.forWorker(owner.userId, id)).toEqual(recordSnapshot);
      expect(await readdir(join(config.dataDir, 'incus-backup-helpers'))).toEqual([]);
      if (mode === 'running') {
        expect(await exec(['cat', '/proc/sys/kernel/random/boot_id'])).toBe(boot);
        expect(await exec(['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service'])).toBe(pid);
      }
    }
    expect(helpers.size).toBe(3);
    await volumes.delete(volume); await managed.store.forget(owner.userId, volume.id);
    await managed.store.forget(owner.userId, detached.id);
    await runtime.removeStorage(owner); await store.delete(owner.userId, id); cleaned = true;
    await rm(stage, { recursive: true });
    console.info('Production managed export running/stopped/archived, v6 coverage, binary attrs/ACLs/links and unchanged source metadata passed');
  } catch (error) { failure = error; console.error('Managed backup gate failed', error); throw error; }
  finally {
    try {
      if (!cleaned && (!submitted || incarnation)) {
        if (incarnation) await runtime.remove(owner, incarnation);
        if (volume) { await volumes.delete(volume); await managed.store.forget(owner.userId, volume.id); }
        if (detached) await managed.store.forget(owner.userId, detached.id);
        if (incarnation) await runtime.removeStorage(owner);
        if (store.get(owner.userId, id)) await store.delete(owner.userId, id);
        cleaned = true;
      }
    } catch (error) {
      console.error('Exact managed backup cleanup unresolved; preserve private registry', { ...owner, incarnation, dataDir: config.dataDir });
      if (!failure) throw error;
    } finally { runtime.client.dispose(); }
  }
});
