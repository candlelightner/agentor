import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import type { IncusInstance } from '../../orchestrator/server/utils/incus-client';
import { IncusWorkerStorage } from '../../orchestrator/server/utils/incus-worker-storage';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { validateIncusSelectedRestoreArchive, validateIncusDockerRestoreArchive } from '../../orchestrator/server/utils/portable-managed-volume-archive';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { useConfig, useContainerManager, useWorkerStore, useDockerService, usePortMappingStore, useDomainMappingStore } from '../../orchestrator/server/utils/services';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';
import { extractBundle } from '../../orchestrator/server/utils/worker-export';
import { withOwnerWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { INCUS_OFFLINE_DOCKER_ARCHIVE_SCRIPT } from '../../orchestrator/server/utils/incus-docker-archive';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).usePortMappingStore ??= usePortMappingStore;
(globalThis as any).useDomainMappingStore ??= useDomainMappingStore;
(globalThis as any).useWorkerConfigStore ??= useWorkerConfigStore;

// Production running/offline capture plus fresh-ext4 inverse capability, not
// production restore parity. Formatting and disk switching are confined to a
// fresh, nonce-owned fixture. Canonical storage is never formatted or detached
// while running. No other fixture or production host is in scope.
test('native Docker logical archive retains overlay deletions and special named-volume metadata on fresh ext4', async () => {
  test.skip(process.env.INCUS_DOCKER_ARCHIVE_PROOF_TEST !== 'true', 'Explicit serial disposable Docker archive proof');
  test.setTimeout(900_000);
  const serviceConfig = useConfig(), priorConfig = { ...serviceConfig };
  const config = { ...serviceConfig, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusNetwork: 'incusbr0', incusStoragePool: process.env.INCUS_TEST_STORAGE_POOL || 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusDockerVolumeSize: '1GiB', incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  const id = randomUUID(), userId = randomUUID(), nonce = randomUUID(), name = 'agentor-worker-' + id;
  const installation = await backupInstallationId(config.dataDir);
  const runtime = new IncusWorkerRuntime(config), client = runtime.client;
  const storage = new IncusWorkerStorage(client, config, installation);
  const dir = join(config.dataDir, 'docker-archive-proof-' + id); await mkdir(dir, { mode: 0o700 });
  const opts: IncusWorkerOptions = { id, userId, containerName: name, dockerEnabled: true, start: false, recreationNonce: nonce,
    cpuLimit: 2, memoryLimit: '2GiB', userEnv: zeroUserEnvVars(userId),
    environmentJson: { dockerEnabled: true, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
      exposeApis: { portMappings: false, domainMappings: false, usage: false } },
    workerJson: { id, displayName: 'Docker archive proof', repos: [], initScript: '', gitName: '', gitEmail: '' },
    capabilitiesJson: [], instructionsJson: [] };
  Object.assign(serviceConfig, config);
  const manager = useContainerManager(), store = useWorkerStore(); await store.init();
  const prior = { runtime: (manager as any).incusRuntime, storage: (manager as any).storageManager,
    workerStore: (manager as any).workerStore, environmentStore: (manager as any).environmentStore };
  manager.setIncusRuntime(runtime); manager.setWorkerStore(store); (manager as any).storageManager = undefined;
  manager.setEnvironmentStore({ getById: () => ({ id: 'docker-proof', name: 'Docker archive proof', ...opts.environmentJson }) } as any);
  const backup = new BackupManager({ dataDir: config.dataDir }), docker = useDockerService(), originalArchive = docker.getArchive;
  docker.getArchive = async () => { throw new Error('Native Docker logical data must never use legacy getArchive'); };
  const copyName = 'docker-proof-' + id + '-docker';
  const copyConfig = { size: '1GiB', 'user.agentor.installation': installation, 'user.agentor.id': id,
    'user.agentor.owner': userId, 'user.agentor.archive-proof': nonce };
  let incarnation: string | undefined, copyAcknowledged = false, sourceSubmitted = false, sourceRemoved = false;
  const exec = async (command: string[]) => {
    const result = await client.exec(name, command); expect(result.returnCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    return result;
  };
  const shell = async (script: string) => (await exec(['bash', '-ec', script])).stdout.trim();
  const prove = async () => {
    const instance = await client.getInstance(name);
    expect(instance.config['volatile.uuid']).toBe(incarnation);
    expect(instance.config['user.agentor.installation']).toBe(installation);
    expect(instance.config['user.agentor.id']).toBe(id);
    expect(instance.config['user.agentor.owner']).toBe(userId);
    expect(instance.config['user.agentor.recreation']).toBe(nonce);
    return instance;
  };
  const waitAgent = async () => {
    await expect.poll(async () => { try { return (await client.exec(name, ['true'])).returnCode; } catch { return -1; } },
      { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
  };
  const metadataScript = String.raw`
import os,stat,json,sys
root=sys.argv[1];out={}
for name in ['.']+sorted(os.listdir(root)):
 p=root+'/'+name;s=os.lstat(p)
 out[name]=dict(mode=s.st_mode,uid=s.st_uid,gid=s.st_gid,mtime=s.st_mtime_ns,rdev=s.st_rdev,
  attrs={n:os.getxattr(p,n,follow_symlinks=False).hex() for n in sorted(os.listxattr(p,follow_symlinks=False))},
  data=open(p,'rb').read().hex() if stat.S_ISREG(s.st_mode) else None,
  link=os.readlink(p) if stat.S_ISLNK(s.st_mode) else None)
assert os.stat(root+'/data').st_ino==os.stat(root+'/hard').st_ino
print(json.dumps(out,sort_keys=True))`;
  try {
    await store.upsert({ id, userId, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'running',
      displayName: 'Docker archive proof', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    console.info('Exact Docker archive proof fixture', { dir, id, userId, nonce, installation, copyName });
    sourceSubmitted = true;
    const created = await runtime.create(opts); incarnation = created.config['volatile.uuid']; expect(incarnation).toBeTruthy();
    await runtime.start(opts, incarnation);
    manager.registerExternal({ id, userId, containerName: name, containerId: 'incus:' + incarnation, runtimeKind: 'incus-vm',
      status: 'running', displayName: 'Docker archive proof', environmentId: 'docker-proof', imageName: config.incusWorkerImage,
      imageId: created.config['volatile.base_image'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    expect(await shell('docker info --format "{{.Driver}}"')).toBe('overlay2');
    await shell(`docker pull busybox:1.37.0; mkdir -p /workspace/docker-archive-build
printf 'FROM busybox:1.37.0\nRUN mkdir /lowerdir && echo old > /lowerdir/old && echo lower > /lowerfile\n' > /workspace/docker-archive-build/Dockerfile
docker build --network=none -t agentor-archive-lower:proof /workspace/docker-archive-build
docker run --name archive-layer agentor-archive-lower:proof sh -ec 'rm /lowerfile; rm -rf /lowerdir; mkdir /lowerdir; echo upper > /lowerdir/new'
docker volume create archive-data
docker run --rm -v archive-data:/data busybox:1.37.0 sh -ec 'echo persistent > /data/ordinary'
docker create --name archive-stopped -v archive-data:/data agentor-archive-lower:proof true`);
    const upper = await shell('docker inspect --format "{{.GraphDriver.Data.UpperDir}}" archive-layer');
    const mountpoint = await shell('docker volume inspect --format "{{.Mountpoint}}" archive-data');
    expect(upper).toMatch(/^\/var\/lib\/docker\/overlay2\/[a-f0-9]+\/diff$/);
    expect(mountpoint).toBe('/var/lib/docker/volumes/archive-data/_data');
    await exec(['python3', '-c', String.raw`
import os,stat,struct,sys
p=sys.argv[1]
open(p+'/data','wb').write(bytes([0,255,128,10,61,0])*1024)
os.chown(p+'/data',12345,23456);os.chmod(p+'/data',0o640)
os.setxattr(p+'/data','user.binary',bytes([0,255,128,10,61,0]))
os.setxattr(p+'/data','security.capability',struct.pack('<IIIII',0x02000001,1<<10,0,0,0))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',t,m,i) for t,m,i in [(1,6,0xffffffff),(2,4,34567),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p+'/data','system.posix_acl_access',acl)
os.setxattr(p,'system.posix_acl_default',acl);os.setxattr(p,'user.directory',bytes([0,255,128]))
os.chown(p,1000,1000);os.chmod(p,0o751)
os.link(p+'/data',p+'/hard');os.symlink('/outside-guest-link',p+'/inert')
os.mkfifo(p+'/fifo',0o600);os.mknod(p+'/char',stat.S_IFCHR|0o600,os.makedev(1,3))
os.mknod(p+'/block',stat.S_IFBLK|0o600,os.makedev(7,199))
for n in os.listdir(p):os.utime(p+'/'+n,ns=(1710000000123456789,1710000000123456789),follow_symlinks=False)
os.utime(p,ns=(1710000000123456789,1710000000123456789))
`, mountpoint]);
    const expected = (await exec(['python3', '-c', metadataScript, mountpoint])).stdout.trim();
    await client.pushFile(name, '/workspace/expected-docker-metadata.json', expected, { uid: 0, gid: 0, mode: 0o600 });
    const overlay = await exec(['python3', '-c', String.raw`
import os,stat,json,sys
p=sys.argv[1];out={}
for rel in ('lowerfile','lowerdir'):
 s=os.lstat(p+'/'+rel);out[rel]=dict(mode=s.st_mode,rdev=s.st_rdev,
 attrs={n:os.getxattr(p+'/'+rel,n).hex() for n in os.listxattr(p+'/'+rel)})
assert stat.S_ISCHR(out['lowerfile']['mode']) and out['lowerfile']['rdev']==0 or out['lowerfile']['attrs'].get('trusted.overlay.whiteout')=='79'
assert out['lowerdir']['attrs'].get('trusted.overlay.opaque')=='79'
print(json.dumps(out,sort_keys=True))`, upper]);
    console.info('Actual native overlay representation', overlay.stdout.trim());
    const service = await shell('systemctl show --property=MainPID --value agentor-worker.service');
    const dockerPid = await shell('systemctl show --property=MainPID --value docker.service');
    await shell('docker create --restart=always --name archive-unsafe busybox:1.37.0 sh -ec "echo must-not-run"');
    const denied = await runtime.openDockerArchive(opts, incarnation!, async () => { await prove(); });
    await expect((async () => { for await (const _chunk of denied) { /* no capture authority */ } })()).rejects.toThrow();
    expect(await shell('systemctl show --property=MainPID --value docker.service')).toBe(dockerPid);
    expect(await shell('docker inspect --format "{{.State.Status}}" archive-unsafe')).toBe('created');
    await shell('docker rm archive-unsafe; docker run -d --name archive-running busybox:1.37.0 sleep 3600; docker run -d --name archive-paused busybox:1.37.0 sleep 3600; docker pause archive-paused');
    // Same-device bind and stack are ineligible BEFORE quiescing Docker.
    for (const subdirectory of [false, true]) {
      await shell('mkdir -p /var/lib/docker/agentor-proof-empty; mount --bind ' +
        (subdirectory ? '/var/lib/docker/agentor-proof-empty' : '/var/lib/docker') + ' /var/lib/docker');
      try {
        const rejected = await runtime.openDockerArchive(opts, incarnation!, async () => { await prove(); });
        await expect((async () => { for await (const _chunk of rejected) { /* no authority */ } })()).rejects.toThrow();
      } finally { await shell('umount /var/lib/docker'); }
      expect(await shell('systemctl show --property=MainPID --value docker.service')).toBe(dockerPid);
    }
    await shell('rmdir /var/lib/docker/agentor-proof-empty; dd if=/dev/zero of=/var/lib/docker/agentor-cancel-fixture bs=1M count=16 status=none');
    const controller = new AbortController();
    await withOwnerWorkerLifecycleMutation(userId, id, async () => {
      const cancelled = await manager.getSelectedBackupArchiveWithLifecycleFenceHeld(id, '/var/lib/docker', controller.signal);
      const sink = new Writable({ write(_chunk, _encoding, callback) {
        controller.abort(new Error('Intentional exact Docker capture cancellation')); callback();
      } });
      await expect(pipeline(cancelled, sink, { signal: controller.signal })).rejects.toThrow(/cancellation|abort/i);
      expect(await shell('docker inspect --format "{{.State.Running}} {{.State.Paused}}" archive-running')).toBe('true false');
      expect(await shell('docker inspect --format "{{.State.Running}} {{.State.Paused}}" archive-paused')).toBe('true true');
    });
    await shell('rm -- /var/lib/docker/agentor-cancel-fixture');
    // Exercise the actual shared BackupManager wire format, not just the
    // production primitive. The bundle contains bytes, never host extraction.
    const bundle = join(dir, 'native-docker-bundle.tar');
    await withOwnerWorkerLifecycleMutation(userId, id, () =>
      (backup as any).exportWorkspaceBundleWithLifecycleFenceHeld(userId, id, bundle, new AbortController().signal, ['/var/lib/docker/']));
    const extracted = await extractBundle(bundle, join(dir, 'bundle'));
    expect(extracted.manifest.runtime?.kind).toBe('incus-vm'); expect(extracted.manifest.contents.rootfs).toBe(false);
    expect(extracted.manifest.backupPaths).toEqual([{ path: '/var/lib/docker', archive: 'paths/0.tar' }]);
    const local = join(dir, 'docker.tar');
    await writeFile(local, execFileSync('/usr/bin/tar', ['-xzOf', extracted.backupPathsPath!, 'paths/0.tar'],
      { maxBuffer: 64 * 1024 * 1024 }), { mode: 0o600, flag: 'wx' });
    expect(await shell('systemctl show --property=MainPID --value agentor-worker.service')).toBe(service);
    expect(await shell('docker inspect --format "{{.State.Running}} {{.State.Paused}}" archive-running')).toBe('true false');
    expect(await shell('docker inspect --format "{{.State.Running}} {{.State.Paused}}" archive-paused')).toBe('true true');
    const bytes = await readFile(local); expect(bytes.length).toBeLessThan(64 * 1024 * 1024);
    await client.pushFile(name, '/workspace/docker-proof.tar', bytes, { uid: 0, gid: 0, mode: 0o600 });
    // Generic selected/canonical dialect must continue rejecting devices/FIFOs.
    await expect(validateIncusSelectedRestoreArchive(local, '/var/lib/docker')).rejects.toThrow();
    const validated = await validateIncusDockerRestoreArchive(local);
    expect(validated.entries).toBeGreaterThan(10);
    const source = await storage.inspectVolume(opts, 'docker'); expect(source).toBeTruthy();
    await runtime.stop(opts, incarnation);
    manager.get(id)!.status = 'stopped';
    const stopped = await prove();
    const offlineCancellation = new AbortController(), originalExecStream = client.execStream;
    client.execStream = async (...args: Parameters<typeof originalExecStream>) => {
      const session = await originalExecStream.apply(client, args);
      if (args[1][0] === '/usr/bin/python3' && args[1][2] === INCUS_OFFLINE_DOCKER_ARCHIVE_SCRIPT)
        session.stdout.once('data', () => offlineCancellation.abort(new Error('Intentional exact offline Docker cancellation')));
      return session;
    };
    try {
      await withOwnerWorkerLifecycleMutation(userId, id, () =>
        expect(manager.captureOfflineDockerBackupWithLifecycleFenceHeld(id, join(dir, 'cancelled-offline.tar'), offlineCancellation.signal))
          .rejects.toThrow(/abort|cancel/i));
      expect(offlineCancellation.signal.aborted).toBe(true);
      expect((await prove()).devices).toEqual(stopped.devices);
      expect(await client.getCustomVolume(config.incusStoragePool, source!.name)).toEqual(source);
      expect((await client.listInstances()).filter(instance => instance.config['user.agentor.installation'] === installation &&
        instance.config['user.agentor.helper'] === 'offline-backup')).toEqual([]);
    } finally { client.execStream = originalExecStream; }
    const stoppedBundle = join(dir, 'stopped-docker-bundle.tar');
    await withOwnerWorkerLifecycleMutation(userId, id, () =>
      (backup as any).exportWorkspaceBundleWithLifecycleFenceHeld(userId, id, stoppedBundle, new AbortController().signal, ['/var/lib/docker'])
        .catch((error: any) => { console.error('Exact stopped Docker archive failure', error.guestExitCode, error.guestDiagnostic); throw error; }));
    const stoppedExtracted = await extractBundle(stoppedBundle, join(dir, 'stopped-bundle'));
    expect(stoppedExtracted.manifest.backupPaths).toEqual([{ path: '/var/lib/docker', archive: 'paths/0.tar' }]);
    const stoppedRaw = join(dir, 'stopped-docker.tar');
    await writeFile(stoppedRaw, execFileSync('/usr/bin/tar', ['-xzOf', stoppedExtracted.backupPathsPath!, 'paths/0.tar'],
      { maxBuffer: 64 * 1024 * 1024 }), { mode: 0o600, flag: 'wx' });
    expect((await validateIncusDockerRestoreArchive(stoppedRaw)).entries).toBeGreaterThan(10);
    expect((await prove()).devices).toEqual(stopped.devices);
    expect(await client.getCustomVolume(config.incusStoragePool, source!.name)).toEqual(source);
    await runtime.start(opts, incarnation); manager.get(id)!.status = 'running';
    expect(await shell('docker info --format "{{.Driver}}"')).toBe('overlay2');
    expect(JSON.parse((await exec(['python3', '-c', metadataScript, mountpoint])).stdout)).toEqual(JSON.parse(expected));
    console.info('Stopped Docker capture/cancellation and original-data restart passed');
    await runtime.stop(opts, incarnation); manager.get(id)!.status = 'stopped';
    const beforeCopy = await prove();
    await client.createCustomVolume(config.incusStoragePool, { name: copyName, content_type: 'block', config: copyConfig });
    copyAcknowledged = true;
    const fresh = await client.getCustomVolume(config.incusStoragePool, copyName);
    expect(fresh.content_type).toBe('block'); expect(fresh.used_by).toEqual([]);
    for (const [key, value] of Object.entries(copyConfig)) expect(fresh.config[key]).toBe(value);
    const devices: IncusInstance['devices'] = { ...beforeCopy.devices, verifybackup: { type: 'disk', pool: config.incusStoragePool, source: copyName } };
    delete devices.eth0;
    await client.updateInstanceDevices(name, devices, undefined, beforeCopy);
    await client.startInstance(name); await waitAgent(); await prove();
    // Fixed test device identity only. Never format a canonical or guessed disk.
    await shell(`test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker.service
dev=/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_verifybackup
test -b "$dev"; test -z "$(wipefs --no-act --noheadings -o TYPE "$dev")"
test "$(lsblk -dn -o TYPE "$dev")" = disk
test "$(lsblk -nr -o NAME "$dev" | wc -l)" = 1
mkfs.ext4 -F "$dev" >/dev/null; mkdir -p /restore/docker; mount -t ext4 -o nodev,nosuid "$dev" /restore/docker
tar --numeric-owner --same-owner --same-permissions --xattrs --xattrs-include='*' --acls -xf /workspace/docker-proof.tar -C /restore
sync; umount /restore/docker`);
    await runtime.stop(opts, incarnation);
    const beforeSwitch = await prove();
    const switched: IncusInstance['devices'] = { ...beforeSwitch.devices, docker: { type: 'disk', pool: config.incusStoragePool, source: copyName }, eth0: beforeCopy.devices.eth0! };
    delete switched.verifybackup;
    await client.updateInstanceDevices(name, switched, undefined, beforeSwitch);
    await client.startInstance(name); await waitAgent(); await prove();
    await client.pushFile(name, '/run/agentor', '', { type: 'directory', mode: 0o711 });
    await client.pushFile(name, '/run/agentor/docker-storage.json', JSON.stringify({ serial: 'incus_docker', volume: copyName, initialize: false }),
      { uid: 0, gid: 0, mode: 0o600 });
    await shell('systemctl start agentor-docker-storage.service; systemctl unmask docker.service docker.socket; systemctl start docker.service');
    const restoredOverlay = await exec(['python3', '-c', String.raw`
import os,json,sys
p=sys.argv[1];out={}
for rel in ('lowerfile','lowerdir'):
 s=os.lstat(p+'/'+rel);out[rel]=dict(mode=s.st_mode,rdev=s.st_rdev,
 attrs={n:os.getxattr(p+'/'+rel,n).hex() for n in os.listxattr(p+'/'+rel)})
print(json.dumps(out,sort_keys=True))`, upper]);
    expect(JSON.parse(restoredOverlay.stdout)).toEqual(JSON.parse(overlay.stdout));
    expect(await shell('docker info --format "{{.Driver}}"')).toBe('overlay2');
    await shell(`docker image inspect agentor-archive-lower:proof >/dev/null; docker container inspect archive-layer archive-stopped >/dev/null
docker volume inspect archive-data >/dev/null
docker run --rm -v archive-data:/data busybox:1.37.0 sh -ec 'test "$(cat /data/ordinary)" = persistent'
docker run --rm agentor-archive-lower:proof sh -ec 'test -f /lowerfile; test "$(cat /lowerdir/old)" = old'
docker commit archive-layer agentor-archive-retained:proof >/dev/null
docker run --rm agentor-archive-retained:proof sh -ec 'test ! -e /lowerfile; test ! -e /lowerdir/old; test "$(cat /lowerdir/new)" = upper'`);
    // The retained writable layer must hide both lower entries after restore.
    const restoredUpper = await shell('docker inspect --format "{{.GraphDriver.Data.UpperDir}}" archive-layer');
    expect(restoredUpper).toBe(upper);
    const inspectLayer = await shell(`docker export archive-layer | tar -tf - | python3 -c 'import sys; n=set(sys.stdin.read().splitlines()); assert "lowerfile" not in n and "lowerdir/old" not in n and "lowerdir/new" in n'`);
    expect(inspectLayer).toBe('');
    const actual = (await exec(['python3', '-c', metadataScript, mountpoint])).stdout.trim();
    expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
    const unchanged = await storage.inspectVolume(opts, 'docker');
    expect(unchanged?.config).toEqual(source?.config); expect(unchanged?.used_by).toEqual([]);
    await runtime.remove(opts, incarnation); sourceRemoved = true;
    await store.upsert({ ...store.get(userId, id)!, status: 'archived', desiredRuntimeStatus: 'stopped' }); manager.unregisterExternal(id);
    const archivedBundle = join(dir, 'archived-docker-bundle.tar');
    await withOwnerWorkerLifecycleMutation(userId, id, () =>
      (backup as any).exportWorkspaceBundleWithLifecycleFenceHeld(userId, id, archivedBundle, new AbortController().signal, ['/var/lib/docker/']));
    const archivedExtracted = await extractBundle(archivedBundle, join(dir, 'archived-bundle'));
    expect(archivedExtracted.manifest.backupPaths).toEqual([{ path: '/var/lib/docker', archive: 'paths/0.tar' }]);
    const archivedRaw = join(dir, 'archived-docker.tar');
    await writeFile(archivedRaw, execFileSync('/usr/bin/tar', ['-xzOf', archivedExtracted.backupPathsPath!, 'paths/0.tar'],
      { maxBuffer: 64 * 1024 * 1024 }), { mode: 0o600, flag: 'wx' });
    expect((await validateIncusDockerRestoreArchive(archivedRaw)).entries).toBeGreaterThan(10);
    const finalSource = await storage.inspectVolume(opts, 'docker'); expect(finalSource).toEqual(unchanged);
    console.info('Archived Docker readonly capture and original block authority passed');
    console.info('Docker logical proof passed', { archiveBytes: bytes.length, specialFiles: ['char', 'block', 'fifo'], overlay: JSON.parse(overlay.stdout) });
  } finally {
    // Ambiguous create outcomes are deliberately left for exact diagnosis.
    // Name read-back is never a substitute for an acknowledged incarnation.
    if (incarnation) {
      if (!sourceRemoved) { await prove(); await runtime.remove(opts, incarnation); }
      await runtime.removeStorage(opts);
      await store.delete(userId, id); manager.unregisterExternal(id);
    } else if (sourceSubmitted) throw new Error('Docker archive source creation authority unresolved; retain fixture registry');
    if (copyAcknowledged) {
      const copy = await client.getCustomVolume(config.incusStoragePool, copyName);
      expect(copy.content_type).toBe('block'); expect(copy.used_by).toEqual([]);
      for (const key of Object.keys(copyConfig).filter(key => key.startsWith('user.'))) expect(copy.config[key]).toBe(copyConfig[key as keyof typeof copyConfig]);
      await client.deleteCustomVolume(config.incusStoragePool, copyName);
    }
    docker.getArchive = originalArchive;
    Object.assign(serviceConfig, priorConfig); Object.assign(manager, { incusRuntime: prior.runtime, storageManager: prior.storage,
      workerStore: prior.workerStore, environmentStore: prior.environmentStore });
  }
});
