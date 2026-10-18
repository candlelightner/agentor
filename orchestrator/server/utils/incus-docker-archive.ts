import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncusClient } from './incus-client';

/** One tmpfs-only quiescence receipt, not a backup/transaction journal. The
 * transient unit owns the fixed tar reader's entire process group. Post-stop
 * cleanup runs even if the Orchestrator or exec wrapper disappears. Revocation
 * also fences late exec startup after an ambiguous websocket handshake. */
export const INCUS_DOCKER_BACKUP_SCRIPT = String.raw`
import fcntl,json,os,re,stat,subprocess,sys,time
mode,nonce,volume,boot=sys.argv[1:]
if mode not in ('capture','cleanup','cancel') or not re.fullmatch('[a-f0-9-]{36}',nonce) or \
 not re.fullmatch('[a-f0-9-]{36}',boot) or not re.fullmatch('[A-Za-z0-9_-]{1,64}',volume): raise ValueError('Invalid Docker capture authority')
base='/run/agentor/docker-backup-'+nonce;unit='agentor-docker-backup-'+nonce+'.service'
env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','LANG':'C'}
deadline=time.monotonic()+(590 if mode=='capture' else 360 if mode=='cancel' else 110)
def command(args,limit=20):
 left=deadline-time.monotonic()
 if left<=0: raise TimeoutError('Docker backup cleanup deadline exceeded')
 result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=min(limit,left))
 if result.returncode: raise ValueError('Docker backup command failed: '+args[0])
 if len(result.stdout)>65536: raise ValueError('Docker backup observation exceeds limit')
 return result.stdout.decode('utf-8').strip()
def regular(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1:
  os.close(fd);raise ValueError('Invalid Docker backup receipt permissions')
 with os.fdopen(fd,'rb') as f: data=f.read(65537)
 if len(data)>65536: raise ValueError('Docker backup receipt exceeds limit')
 return json.loads(data)
def identity():
 if open('/proc/sys/kernel/random/boot_id').read().strip()!=boot: raise ValueError('Docker backup guest boot changed')
 s=os.lstat(base)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o700 or os.path.realpath(base)!=base:
  raise ValueError('Docker backup private directory changed')
def prove():
 identity()
 spec=regular('/run/agentor/docker-storage.json')
 if spec.get('serial')!='incus_docker' or spec.get('volume')!=volume: raise ValueError('Docker backup storage configuration changed')
 disks=set()
 for path in ('/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_docker','/dev/disk/by-id/virtio-incus_docker'):
  if os.path.exists(path):
   disk=os.path.realpath(path)
   if not stat.S_ISBLK(os.stat(disk).st_mode): raise ValueError('Invalid Docker backup disk')
   disks.add(disk)
 if len(disks)!=1: raise ValueError('Docker backup disk is ambiguous')
 disk=next(iter(disks));device=os.stat(disk).st_rdev
 if command(['/usr/bin/lsblk','-dn','-o','TYPE',disk])!='disk' or \
  len(command(['/usr/bin/lsblk','-nr','-o','NAME',disk]).splitlines())!=1:
  raise ValueError('Docker backup source is not one whole disk')
 observation=json.loads(command(['/usr/bin/findmnt','--json','--mountpoint','/var/lib/docker','-o','TARGET,SOURCE,FSTYPE,MAJ:MIN']))
 entries=observation.get('filesystems',[])
 if len(entries)!=1 or entries[0].get('target')!='/var/lib/docker' or entries[0].get('fstype')!='ext4' or \
  entries[0].get('maj:min')!=str(os.major(device))+':'+str(os.minor(device)) or os.path.realpath('/var/lib/docker')!='/var/lib/docker':
  raise ValueError('Docker backup source is not the exact ext4 mount')
 with open('/proc/self/mountinfo') as f: raw=f.read(1024*1024+1)
 if len(raw)>1024*1024: raise ValueError('Docker mount observation exceeds limit')
 roots=[]
 for line in raw.splitlines():
  fields=line.split()
  if len(fields)<10: raise ValueError('Docker mount observation is invalid')
  path=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),fields[4])
  if path=='/var/lib/docker': roots.append(fields)
 if len(roots)!=1 or roots[0][2]!=str(os.major(device))+':'+str(os.minor(device)) or roots[0][3]!='/' or \
  'rw' not in roots[0][5].split(','):
  raise ValueError('Docker source must be one whole ext4 mount, not a bind or stack')
 return device
def write(data):
 path=base+'/state.new';fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(fd,'w') as f: json.dump(data,f);f.flush();os.fsync(f.fileno())
  os.replace(path,base+'/state.json')
 finally:
  if os.path.exists(path): os.unlink(path)
def locked():
 fd=os.open(base+'/lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1:
  os.close(fd);raise ValueError('Invalid Docker backup lock')
 end=time.monotonic()+10
 while True:
  try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);return fd
  except BlockingIOError:
   if time.monotonic()>end: os.close(fd);raise TimeoutError('Docker archive reader is not settled')
   time.sleep(.1)
def units():
 result={}
 for name in ('docker.socket','docker.service','containerd.service'):
  value=command(['/usr/bin/systemctl','show','--value','--property=ActiveState',name])
  if value not in ('active','inactive'): raise ValueError('Docker unit state is transitional or failed')
  result[name]=value
 return result
def archive_unit_state():
 result=subprocess.run(['/usr/bin/systemctl','show','--property=LoadState','--property=ActiveState',unit],
  stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=10)
 values=dict(line.split('=',1) for line in result.stdout.decode().strip().splitlines())
 if result.returncode not in (0,1) or set(values)!=set(('LoadState','ActiveState')) or \
  result.returncode and values!={'LoadState':'not-found','ActiveState':'inactive'}:
  raise ValueError('Docker archive unit observation is unavailable')
 return values['ActiveState']
def containers():
 ids=command(['/usr/bin/docker','container','ls','--all','--quiet','--no-trunc']).splitlines()
 if len(ids)>256 or len(ids)!=len(set(ids)) or any(not re.fullmatch('[a-f0-9]{64}',i) for i in ids):
  raise ValueError('Docker container inventory exceeds limit or is ambiguous')
 if not ids: return {}
 fmt='{{.Id}} {{.State.Status}} {{.State.Running}} {{.State.Paused}} {{.State.Restarting}} {{.HostConfig.AutoRemove}} {{.HostConfig.RestartPolicy.Name}}'
 lines=command(['/usr/bin/docker','inspect','--format',fmt,*ids]).splitlines();result={}
 for line in lines:
  fields=line.split()
  if len(fields)!=7 or fields[0] not in ids or fields[0] in result or fields[1] not in ('running','paused','created','exited') or \
   fields[2] not in ('true','false') or fields[3] not in ('true','false') or fields[4]!='false' or fields[5]!='false' or \
   fields[6] not in ('no','always','on-failure','unless-stopped'):
   raise ValueError('Docker backup requires settled non-auto-remove containers')
  if mode=='capture' and fields[2]=='false' and fields[6]=='always':
   raise ValueError('Stopped always-policy container could execute on daemon restart; use offline Docker backup')
  result[fields[0]]={'running':fields[2]=='true','paused':fields[3]=='true'}
 if set(result)!=set(ids): raise ValueError('Docker container observation is incomplete')
 return result
def quiescent():
 if any(value!='inactive' for value in units().values()): raise ValueError('Docker is not quiescent')
 with open('/proc/self/mountinfo') as f: raw=f.read(1024*1024+1)
 if len(raw)>1024*1024: raise ValueError('Docker mount observation exceeds limit')
 for line in raw.splitlines():
  fields=line.split();path=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),fields[4])
  if path.startswith('/var/lib/docker/'): raise ValueError('Docker source has surviving nested mounts')
  if path=='/var/lib/docker' and fields[2]!=str(os.major(source))+':'+str(os.minor(source)):
   raise ValueError('Docker source has a stacked mount')
 # A second daemon or surviving shim invalidates quiescence despite unit state.
 for item in os.scandir('/proc'):
  if not item.name.isdigit(): continue
  try:
   with open(item.path+'/comm') as f: name=f.read(64).strip()
  except FileNotFoundError: continue
  if name in ('dockerd','containerd','containerd-shim','containerd-shim-runc-v2') or name.startswith('containerd-shim'):
   raise ValueError('Docker source still has daemon/container processes')
def restore():
 if not os.path.exists(base+'/state.json'):
  write({'nonce':nonce,'volume':volume,'boot':boot,'phase':'restored','unchanged':True});return
 state=regular(base+'/state.json')
 if (state.get('nonce'),state.get('volume'),state.get('boot'))!=(nonce,volume,boot): raise ValueError('Docker receipt identity changed')
 if state.get('phase')=='restored': return
 if state.get('phase') not in ('capturing','archived'): raise ValueError('Docker receipt phase is unknown')
 original=state['units'];expected=state['containers']
 if set(original)!=set(units()) or original.get('docker.service')!='active': raise ValueError('Invalid prior Docker units')
 command(['/usr/bin/systemctl','start',*[name for name,value in original.items() if value=='active']],40)
 current=containers()
 if set(current)!=set(expected): raise ValueError('Docker container identity changed during backup')
 unexpected=[i for i,value in current.items() if value['running'] and not expected[i]['running']]
 if unexpected: command(['/usr/bin/docker','stop','--time','10',*unexpected],20)
 current=containers();missing=[i for i,value in expected.items() if value['running'] and not current[i]['running']]
 if missing: command(['/usr/bin/docker','start',*missing],30)
 current=containers()
 for action,wanted in (('pause',True),('unpause',False)):
  ids=[i for i,value in expected.items() if value['running'] and value['paused']==wanted and current[i]['paused']!=wanted]
  if ids: command(['/usr/bin/docker',action,*ids],10)
 inactive=[name for name,value in original.items() if value=='inactive']
 if inactive: command(['/usr/bin/systemctl','stop',*inactive],20)
 if units()!=original or containers()!=expected: raise ValueError('Prior Docker runtime state could not be restored')
 prove();state['phase']='restored';write(state)
if mode=='cancel':
 identity()
 try: fd=os.open(base+'/revoked',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
 except FileExistsError: pass
 active=archive_unit_state()
 if active not in ('inactive','failed',''):
  command(['/usr/bin/systemctl','stop',unit],260)
 active=archive_unit_state()
 if active not in ('inactive','failed',''): raise ValueError('Docker archive unit did not settle')
source=prove()
fd=locked()
try:
 if mode=='capture':
  if os.path.lexists(base+'/revoked') or os.path.lexists(base+'/state.json'): raise ValueError('Docker capture is revoked or already attempted')
  original=units()
  if original['docker.service']!='active': raise ValueError('Docker inactive storage requires offline capture')
  info=json.loads(command(['/usr/bin/docker','info','--format','{{json .}}']))
  if info.get('DockerRootDir')!='/var/lib/docker' or info.get('Driver')!='overlay2' or info.get('LiveRestoreEnabled') is not False:
   raise ValueError('Docker data root/driver/live-restore is not eligible')
  state={'nonce':nonce,'volume':volume,'boot':boot,'phase':'capturing','units':original,'containers':containers()};write(state)
  if os.path.lexists(base+'/revoked'): raise ValueError('Docker capture revoked before quiescence')
  command(['/usr/bin/systemctl','stop','docker.socket','docker.service','containerd.service'],40)
  if prove()!=source: raise ValueError('Docker source changed');
  quiescent()
  if os.path.lexists(base+'/revoked'): raise ValueError('Docker capture revoked before archive')
  result=subprocess.run(['/usr/bin/tar','--format=pax','--numeric-owner','--xattrs','--xattrs-include=*','--acls',
   '--one-file-system','-cpf','-','-C','/var/lib','docker'],env=env,timeout=max(1,deadline-time.monotonic()))
  if result.returncode: raise ValueError('Docker logical archive failed')
  prove();quiescent();state['phase']='archived';write(state)
 else:
  restore()
  if mode=='cancel': print(json.dumps({'restored':True}))
finally: os.close(fd)
`;

/** Fixed readonly offline block capture. Never initialize, replay the journal,
 * repair a filesystem or inspect Docker internals. The owning helper is stopped
 * and removed before the caller's lifecycle fence can be released. */
export const INCUS_OFFLINE_DOCKER_ARCHIVE_SCRIPT = String.raw`
import json,os,re,stat,subprocess,time
env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','LANG':'C'}
deadline=time.monotonic()+560
boot=open('/proc/sys/kernel/random/boot_id').read().strip()
def command(args):
 result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=20)
 if result.returncode or len(result.stdout)>65536: raise ValueError('Offline Docker observation failed: '+args[0])
 return result.stdout.decode().strip()
if os.path.lexists('/run/agentor/provisioned') or os.path.lexists('/run/agentor/worker.env'):
 raise ValueError('Offline Docker helper is provisioned')
# Only this disposable, networkless helper is changed. Native package units
# can be pulled in on boot despite disablement; none may access the source.
services=('agentor-worker.service','docker.socket','docker.service','containerd.service')
command(['/usr/bin/systemctl','mask','--runtime',*services])
command(['/usr/bin/systemctl','stop',*services])
for service in services:
 state=command(['/usr/bin/systemctl','show','--value','--property=ActiveState',service])
 if state!='inactive': raise ValueError('Offline Docker helper unit is not inactive: '+service+' '+state)
disks=set()
for path in ('/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_docker','/dev/disk/by-id/virtio-incus_docker'):
 if os.path.exists(path):
  disk=os.path.realpath(path)
  if not stat.S_ISBLK(os.stat(disk).st_mode): raise ValueError('Invalid offline Docker block device')
  disks.add(disk)
if len(disks)!=1: raise ValueError('Offline Docker disk identity is ambiguous')
disk=next(iter(disks));device=os.stat(disk).st_rdev
if command(['/usr/bin/lsblk','-dn','-o','TYPE',disk])!='disk' or \
 len(command(['/usr/bin/lsblk','-nr','-o','NAME',disk]).splitlines())!=1 or \
 command(['/usr/sbin/blockdev','--getro',disk])!='1':
 raise ValueError('Offline Docker disk must be one readonly whole block device')
signature=dict(line.split('=',1) for line in command(['/usr/sbin/blkid','-p','-o','export',disk]).splitlines())
if signature.get('TYPE')!='ext4': raise ValueError('Offline Docker filesystem must be existing ext4')
header=command(['/usr/sbin/dumpe2fs','-h',disk])
if not re.search(r'^Filesystem state:\s+clean\s*$',header,re.M):
 raise ValueError('Offline Docker filesystem is not clean; no repair or journal replay is allowed')
base='/run/agentor-docker-offline';root=base+'/docker'
os.mkdir(base,0o700);os.mkdir(root,0o700)
command(['/usr/bin/mount','-t','ext4','-o','ro,noload,nodev,nosuid,noexec',disk,root])
def prove():
 if open('/proc/sys/kernel/random/boot_id').read().strip()!=boot or os.path.realpath(root)!=root:
  raise ValueError('Offline Docker boot/mount identity changed')
 with open('/proc/self/mountinfo') as f: raw=f.read(1024*1024+1)
 if len(raw)>1024*1024: raise ValueError('Offline Docker mount observation exceeds limit')
 entries=[]
 for line in raw.splitlines():
  fields=line.split()
  if len(fields)<10 or '-' not in fields: raise ValueError('Invalid offline Docker mount observation')
  path=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),fields[4])
  if path.startswith(root+'/'): raise ValueError('Offline Docker has nested mounts')
  if path==root: entries.append(fields)
 if len(entries)!=1: raise ValueError('Offline Docker mount is ambiguous')
 fields=entries[0];separator=fields.index('-')
 if fields[2]!=str(os.major(device))+':'+str(os.minor(device)) or fields[3]!='/' or \
  not {'ro','nodev','nosuid','noexec'}.issubset(fields[5].split(',')) or fields[separator+1]!='ext4':
  raise ValueError('Offline Docker is not the exact readonly ext4 root')
prove()
result=subprocess.run(['/usr/bin/tar','--format=pax','--numeric-owner','--xattrs','--xattrs-include=*','--acls',
 '--one-file-system','-cpf','-','-C',base,'docker'],env=env,timeout=max(1,deadline-time.monotonic()))
if result.returncode: raise ValueError('Offline Docker logical archive failed')
prove()
`;

/** Native ownership/boot/source proof is caller-owned. Cleanup intentionally
 * ignores caller cancellation, but must not mutate another VM incarnation. */
export async function openIncusDockerArchive(client: IncusClient, name: string, volume: string, boot: string,
  validate: () => Promise<void>, signal?: AbortSignal): Promise<PassThrough> {
  await validate(); signal?.throwIfAborted();
  const nonce = randomUUID(), dir = '/run/agentor/docker-backup-' + nonce, script = dir + '/capture.py';
  const unit = 'agentor-docker-backup-' + nonce + '.service';
  const prepared = await client.exec(name, ['/usr/bin/mkdir', '-m', '700', '--', dir]);
  if (prepared.returnCode !== 0) throw new Error('Docker backup private directory could not be allocated');
  await client.pushFile(name, script, INCUS_DOCKER_BACKUP_SCRIPT, { uid: 0, gid: 0, mode: 0o600 });
  const args = [nonce, volume, boot];
  let cleanup: Promise<void> | undefined;
  const settle = () => cleanup ??= (async () => {
    await validate();
    const session = await client.execStream(name, ['/usr/bin/python3', script, 'cancel', ...args], {
      command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeoutMs: 370_000 });
    let output = ''; session.stderr.resume();
    const reading = (async () => { for await (const chunk of session.stdout) {
      output += chunk.toString(); if (output.length > 4096) throw new Error('Docker backup cleanup returned excessive output');
    } })(); reading.catch(() => {}); session.stdin.end();
    try {
      const [code] = await Promise.all([session.result, reading]);
      if (code !== 0 || JSON.parse(output).restored !== true) throw new Error('Docker backup cleanup did not restore prior state');
      await validate();
    } finally { session.close(); }
  })();
  let session: Awaited<ReturnType<IncusClient['execStream']>>;
  try {
    await validate(); signal?.throwIfAborted();
    session = await client.execStream(name, ['/usr/bin/systemd-run', '--quiet', '--pipe', '--wait', '--collect', '--unit=' + unit,
      '-p', 'Type=exec', '-p', 'KillMode=control-group', '-p', 'RuntimeMaxSec=600', '-p', 'TimeoutStopSec=120',
      '-p', 'ExecStopPost=/usr/bin/python3 ' + script + ' cleanup ' + args.join(' '),
      '/usr/bin/python3', script, 'capture', ...args], { command: [], user: 0, group: 0, cwd: '/',
        environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, signal, timeoutMs: 15 * 60_000 });
  } catch (error) {
    try { await settle(); } catch { throw new Error('Docker backup startup/cleanup authority unresolved; verify native Docker recovery'); }
    throw error;
  }
  let completed = false;
  // Delay destruction completion until uncancelled recovery settles. Pipeline
  // cancellation must not release the caller's lifecycle fence prematurely.
  const output = new PassThrough({ destroy(error, callback) {
    session.close();
    if (completed) callback(error);
    else void settle().then(() => callback(error), () => callback(new Error('Docker backup cleanup unresolved; verify native Docker recovery')));
  } }); output.on('error', () => {}); session.stderr.resume();
  session.stdout.on('error', error => output.destroy(error)); session.stdout.pipe(output, { end: false }); session.stdin.end();
  void session.result.then(async code => {
    await settle();
    if (code !== 0) throw new Error('Native Docker capture failed; verify quiescence, auto-remove containers and runtime recovery');
    signal?.throwIfAborted(); completed = true; output.end();
  }).catch(async error => {
    try { await settle(); } catch { error = new Error('Docker backup cleanup unresolved; verify native Docker recovery'); }
    output.destroy(error);
  });
  return output;
}
