import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusWorkerStorage } from '../../orchestrator/server/utils/incus-worker-storage';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { validateIncusSelectedRestoreArchive, validateIncusDockerRestoreArchive } from '../../orchestrator/server/utils/portable-managed-volume-archive';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { useConfig } from '../../orchestrator/server/utils/services';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

// Capability evidence only: this deliberately does not claim production backup
// integration. All formatting and disk switching are confined to a fresh,
// nonce-owned fixture. Canonical source storage is never formatted or detached
// while running. No other fixture or production host is in scope.
test('native Docker logical archive retains overlay deletions and special named-volume metadata on fresh ext4', async () => {
  test.skip(process.env.INCUS_DOCKER_ARCHIVE_PROOF_TEST !== 'true', 'Explicit serial disposable Docker archive proof');
  test.setTimeout(900_000);
  const config = { ...useConfig(), containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusDockerVolumeSize: '1GiB', incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  const id = randomUUID(), userId = randomUUID(), nonce = randomUUID(), name = 'agentor-worker-' + id;
  const installation = await backupInstallationId(config.dataDir);
  const runtime = new IncusWorkerRuntime(config), client = runtime.client;
  const storage = new IncusWorkerStorage(client, config, installation);
  const dir = join(config.dataDir, 'docker-archive-proof-' + id); await mkdir(dir, { mode: 0o700 });
  const opts = { id, userId, containerName: name, dockerEnabled: true, start: false, recreationNonce: nonce,
    cpuLimit: 2, memoryLimit: '2GiB', userEnv: zeroUserEnvVars(userId),
    environmentJson: { dockerEnabled: true, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '', exposeApis: {} },
    workerJson: { id, displayName: 'Docker archive proof', repos: [], initScript: '', gitName: '', gitEmail: '' },
    capabilitiesJson: [], instructionsJson: [] };
  const copyName = 'docker-proof-' + id + '-docker';
  const copyConfig = { size: '1GiB', 'user.agentor.installation': installation, 'user.agentor.id': id,
    'user.agentor.owner': userId, 'user.agentor.archive-proof': nonce };
  let incarnation: string | undefined, copyAcknowledged = false, sourceSubmitted = false;
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
    console.info('Exact Docker archive proof fixture', { dir, id, userId, nonce, installation, copyName });
    sourceSubmitted = true;
    const created = await runtime.create(opts); incarnation = created.config['volatile.uuid']; expect(incarnation).toBeTruthy();
    await runtime.start(opts, incarnation);
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
    // All test containers are already stopped. This does not pretend that
    // daemon shutdown alone quiesces guest-root configured live-restore.
    await shell(`test -z "$(docker ps -q)"; systemctl stop docker.socket docker.service containerd.service
! systemctl is-active --quiet docker.socket; ! systemctl is-active --quiet docker.service; ! systemctl is-active --quiet containerd.service
test -z "$(findmnt -rn -t overlay -o TARGET)"`);
    const archive = await shell(`tar --format=pax --numeric-owner --xattrs --xattrs-include='*' --acls -cf /workspace/docker-proof.tar -C /var/lib docker
stat -c %s /workspace/docker-proof.tar`);
    expect(Number(archive)).toBeLessThan(64 * 1024 * 1024);
    const bytes = (await client.pullFile(name, '/workspace/docker-proof.tar')).content;
    const local = join(dir, 'docker.tar'); await writeFile(local, bytes, { mode: 0o600, flag: 'wx' });
    // Generic selected/canonical dialect must continue rejecting devices/FIFOs.
    await expect(validateIncusSelectedRestoreArchive(local, '/var/lib/docker')).rejects.toThrow();
    const validated = await validateIncusDockerRestoreArchive(local);
    expect(validated.entries).toBeGreaterThan(10);
    const source = await storage.inspectVolume(opts, 'docker'); expect(source).toBeTruthy();
    await runtime.stop(opts, incarnation);
    const stopped = await prove();
    await client.createCustomVolume(config.incusStoragePool, { name: copyName, content_type: 'block', config: copyConfig });
    copyAcknowledged = true;
    const fresh = await client.getCustomVolume(config.incusStoragePool, copyName);
    expect(fresh.content_type).toBe('block'); expect(fresh.used_by).toEqual([]);
    for (const [key, value] of Object.entries(copyConfig)) expect(fresh.config[key]).toBe(value);
    const devices = { ...stopped.devices, verifybackup: { type: 'disk', pool: config.incusStoragePool, source: copyName } };
    delete devices.eth0;
    await client.updateInstanceDevices(name, devices, undefined, stopped);
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
    const switched = { ...beforeSwitch.devices, docker: { type: 'disk', pool: config.incusStoragePool, source: copyName }, eth0: stopped.devices.eth0! };
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
    console.info('Docker logical proof passed', { archiveBytes: bytes.length, specialFiles: ['char', 'block', 'fifo'], overlay: JSON.parse(overlay.stdout) });
  } finally {
    // Ambiguous create outcomes are deliberately left for exact diagnosis.
    // Name read-back is never a substitute for an acknowledged incarnation.
    if (incarnation) {
      await prove(); await runtime.remove(opts, incarnation); await runtime.removeStorage(opts);
    } else if (sourceSubmitted) throw new Error('Docker archive source creation authority unresolved; retain fixture registry');
    if (copyAcknowledged) {
      const copy = await client.getCustomVolume(config.incusStoragePool, copyName);
      expect(copy.content_type).toBe('block'); expect(copy.used_by).toEqual([]);
      for (const key of Object.keys(copyConfig).filter(key => key.startsWith('user.'))) expect(copy.config[key]).toBe(copyConfig[key as keyof typeof copyConfig]);
      await client.deleteCustomVolume(config.incusStoragePool, copyName);
    }
  }
});
