import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { prepareIncusCanonicalRestorePayload } from '../../orchestrator/server/utils/incus-canonical-restore';
import { sha256File } from '../../orchestrator/server/utils/instance-backup-bundle';

// Root built this exact child from the accepted control-plane image with only
// signed Alpine GNU tar/ACL packages; no source-worker OCI code executes here.
const run = promisify(execFile), image = 'sha256:ef5b9f2ecd690ec6f3e414b18cb0d96f46b51ad424efbc5db3b7c57f90ccd613';
const ssh = ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1'];
const scp = ['-P', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes'];
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const root = async (s: string) => (await run('ssh', [...ssh, s], { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim();
type Container = { Id: string; Image: string; Created: string; Config: { User: string; Env: string[]; Labels: Record<string, string> };
  State: { Running: boolean; Status: string }; HostConfig: { NetworkMode: string; Privileged: boolean; ReadonlyRootfs: boolean;
    CapDrop: string[]; CapAdd: string[] | null; SecurityOpt: string[] }; Mounts: Array<{ Type: string; Name?: string; Source: string; Destination: string; RW: boolean }> };
type Volume = { Name: string; CreatedAt: string; Driver: string; Mountpoint: string; Labels: Record<string, string>; Options: unknown };

test('stopped legacy fixture GNU capture preserves native migration metadata with minimal trusted-reader capabilities', async () => {
  test.skip(process.env.LEGACY_INCUS_MIGRATION_CAPTURE_TEST !== 'true', 'Root-exclusive approved disposable-host capture proof');
  test.setTimeout(300_000);
  const job = randomUUID(), volumeName = 'agentor-legacy-capture-' + job, sourceName = 'agentor-legacy-source-' + job;
  const remote = '/var/tmp/agentor-legacy-capture.' + job, local = await mkdtemp(join(tmpdir(), 'agentor-legacy-capture-'));
  let source: Container | undefined, volume: Volume | undefined, completed = false;
  let remoteIdentity: { dev: number; ino: number; uid: number; gid: number; mode: number } | undefined;
  const readers: Container[] = [];
  const inspect = async (id: string): Promise<Container> => JSON.parse(await root(`sudo docker inspect ${quote(id)} --format '{{json .}}'`));
  const inspectVolume = async (): Promise<Volume> => JSON.parse(await root(`sudo docker volume inspect ${quote(volumeName)} --format '{{json .}}'`));
  const sourceMetadata = async () => JSON.parse(await root(`sudo python3 -c ${quote(String.raw`import os,stat,sys,json,base64
p=sys.argv[1]+'/workspace';f=p+'/data';s=os.lstat(f);d=os.lstat(p+'/opaque')
print(json.dumps(dict(data=base64.b64encode(open(f,'rb').read()).decode(),uid=s.st_uid,gid=s.st_gid,mode=stat.S_IMODE(s.st_mode),
mtime=str(s.st_mtime_ns),ctime=str(s.st_ctime_ns),hard=s.st_ino==os.lstat(p+'/hard').st_ino,link=os.readlink(p+'/sym'),
user=base64.b64encode(os.getxattr(f,'user.binary')).decode(),opaque=base64.b64encode(os.getxattr(p+'/opaque','trusted.overlay.opaque')).decode() if 'trusted.overlay.opaque' in os.listxattr(p+'/opaque') else None,
directory=dict(uid=d.st_uid,gid=d.st_gid,mode=stat.S_IMODE(d.st_mode),mtime=str(d.st_mtime_ns),ctime=str(d.st_ctime_ns)))))`)} ${quote(volume!.Mountpoint)}`));
  const checkSource = async () => {
    const current = await inspect(source!.Id);
    expect(current.Id).toBe(source!.Id); expect(current.Created).toBe(source!.Created); expect(current.Image).toBe(image);
    expect(current.Config.Labels['agentor.migration-capture-fixture']).toBe(job); expect(current.Mounts).toEqual(source!.Mounts);
    expect(current.State.Running).toBe(false); expect(current.State.Status).toBe('exited');
    expect(await inspectVolume()).toEqual(volume);
  };
  try {
    expect(await root(`sudo docker image inspect ${quote(image)} --format '{{.Id}}'`)).toBe(image);
    expect(await root(`sudo docker image inspect ${quote(image)} --format '{{index .Config.Labels "agentor.migration-capture-trusted-parent"}}'`))
      .toBe('sha256:a7177ef19047d9c0f56d1858599015f55f334831d3cc60b823cd915fa22c38e2');
    expect(await root(`sudo docker volume ls --format '{{.Name}}' --filter name=^${volumeName}$`)).toBe('');
    await root(`test ! -e ${quote(remote)} && mkdir -m 700 ${quote(remote)}`);
    remoteIdentity = JSON.parse(await root(`python3 -c ${quote(String.raw`import os,stat,json,sys
p=sys.argv[1];s=os.lstat(p);assert os.path.realpath(p)==p and stat.S_ISDIR(s.st_mode) and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700
print(json.dumps(dict(dev=s.st_dev,ino=s.st_ino,uid=s.st_uid,gid=s.st_gid,mode=stat.S_IMODE(s.st_mode))))`)} ${quote(remote)}`));
    await root(`sudo docker volume create --label agentor.migration-capture-fixture=${job} ${quote(volumeName)}`);
    volume = await inspectVolume(); expect(volume.Name).toBe(volumeName); expect(volume.CreatedAt).toBeTruthy();
    expect(volume.Driver).toBe('local'); expect(volume.Labels['agentor.migration-capture-fixture']).toBe(job);
    expect(volume.Mountpoint).toMatch(/^\/var\/lib\/docker\/volumes\/agentor-legacy-capture-[a-f0-9-]{36}\/_data$/);
    const sourceId = await root(`sudo docker run -d --name ${quote(sourceName)} --label agentor.migration-capture-fixture=${job} ` +
      `--network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount type=volume,src=${volumeName},dst=/workspace,volume-nocopy ` +
      `--entrypoint node ${quote(image)} -e 'setInterval(()=>{},1000)'`);
    expect(sourceId).toMatch(/^[a-f0-9]{64}$/); await root(`sudo docker stop --time 10 ${sourceId}`); source = await inspect(sourceId);
    await root(`sudo python3 -c ${quote(String.raw`import os,sys,errno
p=sys.argv[1]+'/workspace';os.mkdir(p);f=p+'/data';open(f,'wb').write(bytes([0,255,128,10,61,0]));os.link(f,p+'/hard');os.symlink('data',p+'/sym')
os.chown(f,12345,23456);os.chmod(f,0o640);os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]));os.utime(f,ns=(1700000000123456789,1700000000987654321))
os.mkdir(p+'/opaque');os.chown(p+'/opaque',34567,45678);os.chmod(p+'/opaque',0o750)
try:os.setxattr(p+'/opaque','trusted.overlay.opaque',b'y')
except OSError as e:
 if e.errno not in (errno.ENOTSUP,errno.EOPNOTSUPP):raise
os.utime(p+'/opaque',ns=(1700000000123456789,1700000000987654321))`)} ${quote(volume.Mountpoint)}`);
    await checkSource(); const before = await sourceMetadata();
    expect(before).toMatchObject({ data: 'AP+ACj0A', uid: 12345, gid: 23456, mode: 0o640, mtime: '1700000000987654321', hard: true, link: 'data', user: 'AP+ACj0A' });
    let acceptedCaps: string[] | undefined;
    for (const [index, caps] of [[], ['DAC_READ_SEARCH'], ['DAC_READ_SEARCH', 'SYS_ADMIN']].entries()) {
      if (acceptedCaps) break;
      const output = remote + '/probe-' + index; await root(`mkdir -m 700 ${quote(output)} && sudo chown root:root ${quote(output)}`);
      const id = await root(`sudo docker create --name ${quote('agentor-legacy-reader-' + job + '-' + index)} --label agentor.migration-capture-fixture=${job} ` +
        `--network none --read-only --user 0:0 --cap-drop ALL ${caps.map(cap => '--cap-add ' + cap).join(' ')} --security-opt no-new-privileges:true ` +
        `--pids-limit 64 --memory 256m --mount type=volume,src=${volumeName},dst=/source,readonly,volume-nocopy --mount type=bind,src=${output},dst=/out ` +
        `--entrypoint /bin/sh ${quote(image)} -ec ${quote("tar --version | grep -q 'GNU tar'; exec tar --sort=name --format=pax --numeric-owner --acls --xattrs --xattrs-include='*' -cpf /out/archive.tar -C /source workspace")}`);
      expect(id).toMatch(/^[a-f0-9]{64}$/); const reader = await inspect(id); readers.push(reader);
      expect(reader.Image).toBe(image); expect(reader.Config.User).toBe('0:0'); expect(reader.Created).toBeTruthy();
      expect(reader.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'] });
      expect((reader.HostConfig.CapAdd ?? []).map(cap => cap.replace(/^CAP_/, ''))).toEqual(caps);
      expect(reader.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
      expect(reader.Mounts).toHaveLength(2); expect(reader.Mounts.find(m => m.Destination === '/source')).toMatchObject({ Type: 'volume', Name: volumeName, RW: false });
      expect(reader.Mounts.find(m => m.Destination === '/out')).toMatchObject({ Type: 'bind', Source: output, RW: true });
      expect(reader.Config.Env.some(value => /^(?:GITHUB_TOKEN|GH_TOKEN|.*PASSWORD|.*SECRET|INCUS_CLIENT_KEY)=/.test(value))).toBe(false);
      await root(`sudo docker start ${id}`); const code = await root(`sudo docker wait ${id}`);
      await checkSource(); expect(isDeepStrictEqual(await sourceMetadata(), before)).toBe(true);
      if (code !== '0') {
        expect(caps.length).toBe(0);
        expect(await root(`sudo docker logs --tail 20 ${id} 2>&1`)).toMatch(/Permission denied/i);
        continue;
      }
      await root(`sudo chown kata-test ${quote(output)} ${quote(output + '/archive.tar')} && sudo chmod 600 ${quote(output + '/archive.tar')}`);
      const raw = join(local, 'probe-' + index + '.tar'); await run('scp', [...scp, 'kata-test@172.19.0.1:' + output + '/archive.tar', raw], { timeout: 60_000 });
      const attrs = JSON.parse((await run('python3', ['-c', String.raw`import tarfile,sys,json,base64,decimal
t=tarfile.open(sys.argv[1]);f=t.getmember('workspace/data');h=t.getmember('workspace/hard');s=t.getmember('workspace/sym');d=t.getmember('workspace/opaque')
print(json.dumps(dict(data=base64.b64encode(t.extractfile(f).read()).decode(),uid=f.uid,gid=f.gid,mode=f.mode,
mtime=str(int(decimal.Decimal(f.pax_headers['mtime'])*1000000000)),hard=h.islnk() and h.linkname=='workspace/data',link=s.linkname,
user=base64.b64encode(f.pax_headers.get('SCHILY.xattr.user.binary','').encode('utf8','surrogateescape')).decode(),
opaque=d.pax_headers.get('SCHILY.xattr.trusted.overlay.opaque'),directory=dict(uid=d.uid,gid=d.gid,mode=d.mode,mtime=str(int(decimal.Decimal(d.pax_headers['mtime'])*1000000000))))))`, raw])).stdout);
      expect(attrs).toMatchObject({ data: before.data, uid: before.uid, gid: before.gid, mode: before.mode, mtime: before.mtime, hard: before.hard, link: before.link, user: before.user,
        directory: { uid: before.directory.uid, gid: before.directory.gid, mode: before.directory.mode, mtime: before.directory.mtime } });
      if (before.opaque && attrs.opaque !== 'y') { expect(caps).toEqual(['DAC_READ_SEARCH']); continue; }
      expect(attrs.opaque ?? null).toBe(before.opaque ? 'y' : null);
      const gzip = join(local, 'accepted.tar.gz'), preparedDir = join(local, 'prepared'); await mkdir(preparedDir, { mode: 0o700 });
      await pipeline(createReadStream(raw), createGzip(), createWriteStream(gzip, { mode: 0o600, flags: 'wx' }));
      const prepared = await prepareIncusCanonicalRestorePayload(gzip, 'workspace', preparedDir, { maxRawBytes: 1024 * 1024 });
      expect(await sha256File(prepared.archivePath)).toBe(await sha256File(raw)); acceptedCaps = caps;
    }
    expect(acceptedCaps, 'Bounded trusted reader must preserve all available xattrs without privileged mode').toBeDefined();
    await checkSource(); expect(isDeepStrictEqual(await sourceMetadata(), before)).toBe(true); completed = true;
    console.info('Legacy stopped source raw GNU metadata capture validated unchanged through accepted native parser', { job, sourceId: source.Id, volumeName, capabilities: acceptedCaps, trustedOverlayOpaque: Boolean(before.opaque) });
  } finally {
    if (completed && source && volume) {
      await checkSource();
      for (const reader of readers) { const current = await inspect(reader.Id); expect(current.Id).toBe(reader.Id); expect(current.Created).toBe(reader.Created); expect(current.Image).toBe(image); expect(current.Config.Labels['agentor.migration-capture-fixture']).toBe(job); expect(current.State.Running).toBe(false); await root(`sudo docker rm ${reader.Id}`); }
      await root(`sudo docker rm ${source.Id}`); expect(await inspectVolume()).toEqual(volume); await root(`sudo docker volume rm ${quote(volumeName)}`);
      const currentDirectory = JSON.parse(await root(`sudo python3 -c ${quote(String.raw`import os,stat,json,sys
p=sys.argv[1];s=os.lstat(p);assert os.path.realpath(p)==p and stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
print(json.dumps(dict(dev=s.st_dev,ino=s.st_ino,uid=s.st_uid,gid=s.st_gid,mode=stat.S_IMODE(s.st_mode))))`)} ${quote(remote)}`));
      expect(currentDirectory).toEqual(remoteIdentity);
      await root(`sudo rm -rf ${quote(remote)}`); await rm(local, { recursive: true, force: true });
    } else console.error('Retained unconfirmed owned legacy capture fixture', { local, remote, job, sourceId: source?.Id, volumeName });
  }
});
