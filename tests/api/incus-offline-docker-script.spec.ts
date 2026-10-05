import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { INCUS_OFFLINE_DOCKER_ARCHIVE_SCRIPT } from '../../orchestrator/server/utils/incus-docker-archive';

// Execute only the Python control flow. Every filesystem observation/mutation
// and every subprocess is virtual; unexpected operations fail rather than
// reaching this worker's devices, mounts, files or tar implementation.
const HARNESS = String.raw`
import builtins,io,json,os,re,stat,subprocess,sys,time,types
payload=json.load(sys.stdin);case=payload['case'];calls=[];reads=0;tar_ran=False;masked=False;stopped=False
base='/run/agentor-docker-offline';root=base+'/docker'
scsi='/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_docker'
virtio='/dev/disk/by-id/virtio-incus_docker'
directories={'/','/run'}
if case.get('agentorParent',False): directories.add('/run/agentor')
def exists(path):
 if path==scsi: return not case.get('missingDisk',False)
 if path==virtio: return case.get('secondSerial',False)
 if path=='/run/agentor/provisioned': return case.get('provisioned',False)
 if path=='/run/agentor/worker.env': return case.get('configured',False)
 return path in directories
def realpath(path):
 if path==scsi: return '/dev/vdb'
 if path==virtio: return '/dev/vdc' if case.get('ambiguousDisk',False) else '/dev/vdb'
 if path==root: return '/foreign' if case.get('rootSymlink',False) or tar_ran and case.get('rootChangeAfterTar',False) else root
 if path in directories: return path
 raise AssertionError('unexpected realpath '+path)
def observation(path):
 if path in ('/dev/vdb','/dev/vdc'):
  return types.SimpleNamespace(st_mode=stat.S_IFREG if case.get('regularDevice',False) else stat.S_IFBLK,
   st_rdev=os.makedev(7,0 if path=='/dev/vdb' else 1))
 if path in directories: return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=0,st_gid=0)
 raise FileNotFoundError(path)
def mkdir(path,mode=0o777,*args,**kwargs):
 calls.append(['mkdir',path,mode])
 if os.path.dirname(path) not in directories: raise FileNotFoundError('missing parent: '+os.path.dirname(path))
 if path in directories: raise FileExistsError(path)
 if path not in (base,root): raise AssertionError('unexpected mkdir '+path)
 directories.add(path)
def makedirs(path,mode=0o777,exist_ok=False):
 parent=os.path.dirname(path)
 if parent and parent not in directories: makedirs(parent,mode,True)
 if path not in directories: mkdir(path,mode)
 elif not exist_ok: raise FileExistsError(path)
def mountinfo():
 flags=case.get('mountFlags','ro,nodev,nosuid,noexec');device=case.get('mountDevice','7:0')
 if tar_ran and case.get('mountChangeAfterTar',False): device='7:1'
 entry='20 1 '+device+' '+case.get('mountRoot','/')+' '+root+' '+flags+' - '+case.get('mountFs','ext4')+' /dev/vdb ro,noload\n'
 if case.get('noMount',False): return ''
 if case.get('stacked',False): entry+=entry
 if case.get('nested',False): entry+='21 20 7:0 / '+root+'/containers rw - tmpfs tmpfs rw\n'
 if case.get('malformedMount',False): entry+='malformed\n'
 return entry
def opened(path,*args,**kwargs):
 global reads
 if path=='/proc/sys/kernel/random/boot_id':
  reads+=1
  changed=reads>=case.get('bootChangesAt',999)
  return io.StringIO('new-boot' if changed else 'original-boot')
 if path=='/proc/self/mountinfo': return io.StringIO(mountinfo())
 raise AssertionError('unexpected open '+path)
def run(args,**kwargs):
 global tar_ran,masked,stopped
 calls.append(['command',args])
 if args[0]=='/usr/bin/systemctl':
  services=['agentor-worker.service','docker.socket','docker.service','containerd.service']
  if args[1]=='mask':
   assert args[1:]==['mask','--runtime',*services];masked=True
   if case.get('maskFails',False): return subprocess.CompletedProcess(args,1,b'',b'')
   output=''
  elif args[1]=='stop':
   assert masked and args[1:]==['stop',*services];stopped=True
   if case.get('stopFails',False): return subprocess.CompletedProcess(args,1,b'',b'')
   output=''
  else:
   assert masked and stopped and args[1:4]==['show','--value','--property=ActiveState'] and args[4] in services
   output=case.get('unitState','active') if args[4]==case.get('activeService') else 'inactive'
 elif args[0]=='/usr/bin/lsblk':
  assert args[-1]=='/dev/vdb'
  output=case.get('deviceType','disk') if args[1:4]==['-dn','-o','TYPE'] else 'vdb\nvdb1' if case.get('partition',False) else 'vdb'
 elif args[0]=='/usr/sbin/blockdev':
  assert args[1:]==['--getro','/dev/vdb'];output='0' if case.get('writable',False) else '1'
 elif args[0]=='/usr/sbin/blkid':
  assert args[1:]==['-p','-o','export','/dev/vdb'];output='TYPE='+case.get('filesystem','ext4')
 elif args[0]=='/usr/sbin/dumpe2fs':
  assert args[1:]==['-h','/dev/vdb'];output='Filesystem state: '+('not clean' if case.get('dirty',False) else 'clean')
 elif args[0]=='/usr/bin/mount':
  assert args==['/usr/bin/mount','-t','ext4','-o','ro,noload,nodev,nosuid,noexec','/dev/vdb',root];output=''
 elif args[0]=='/usr/bin/tar':
  assert args==['/usr/bin/tar','--format=pax','--numeric-owner','--xattrs','--xattrs-include=*','--acls','--one-file-system','-cpf','-','-C',base,'docker']
  assert 0<kwargs['timeout']<=560
  tar_ran=True
  return subprocess.CompletedProcess(args,case.get('tarExit',0),b'',b'')
 else: raise AssertionError('unexpected command '+repr(args))
 assert kwargs['env']=={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','LANG':'C'}
 assert kwargs['timeout']==20
 return subprocess.CompletedProcess(args,0,output.encode(),b'')
builtins.open=opened;os.path.exists=exists;os.path.lexists=exists;os.path.realpath=realpath
os.stat=observation;os.lstat=observation;os.mkdir=mkdir;os.makedirs=makedirs;subprocess.run=run
try:
 exec(compile(payload['script'],'guest-offline-docker','exec'),{})
 result={'ok':True,'calls':calls,'bootReads':reads}
except Exception as error:
 result={'ok':False,'error':str(error),'calls':calls,'bootReads':reads}
print(json.dumps(result))
`;

function dryRun(scenario: Record<string, unknown> = {}) {
  const result = spawnSync('python3', ['-c', HARNESS], { input: JSON.stringify({ script: INCUS_OFFLINE_DOCKER_ARCHIVE_SCRIPT, case: scenario }), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { ok: boolean; error?: string; calls: Array<[string, any, any?]>; bootReads: number };
}
const commands = (result: ReturnType<typeof dryRun>, executable: string) => result.calls.filter(([kind, args]) => kind === 'command' && args[0] === executable);

test('offline fixed readonly ext4 capture tolerates absent unprovisioned parent without actual system operations', () => {
  const result = dryRun({ secondSerial: true });
  expect(result.ok, result.error).toBe(true);
  expect(commands(result, '/usr/bin/mount')).toHaveLength(1); expect(commands(result, '/usr/bin/tar')).toHaveLength(1);
  expect(commands(result, '/usr/bin/systemctl')).toHaveLength(6); expect(result.bootReads).toBe(3);
  expect(commands(result, '/usr/bin/systemctl').slice(0, 2).map(([, args]) => args)).toEqual([
    ['/usr/bin/systemctl', 'mask', '--runtime', 'agentor-worker.service', 'docker.socket', 'docker.service', 'containerd.service'],
    ['/usr/bin/systemctl', 'stop', 'agentor-worker.service', 'docker.socket', 'docker.service', 'containerd.service'],
  ]);
  expect(result.calls.filter(([kind]) => kind === 'mkdir')).toEqual([
    ['mkdir', '/run/agentor-docker-offline', 0o700], ['mkdir', '/run/agentor-docker-offline/docker', 0o700],
  ]);
});

test('offline guard rejects provisioned or active guests and ambiguous/nonwhole/writable/nonext4/dirty disks before mount or tar', () => {
  for (const scenario of [{ provisioned: true }, { configured: true }, { maskFails: true }, { stopFails: true },
    ...['agentor-worker.service','docker.service','docker.socket','containerd.service'].flatMap(activeService =>
      ['active', 'activating', 'deactivating', 'failed'].map(unitState => ({ activeService, unitState }))),
    { missingDisk: true }, { secondSerial: true, ambiguousDisk: true }, { regularDevice: true }, { deviceType: 'part' },
    { partition: true }, { writable: true }, { filesystem: 'xfs' }, { dirty: true }]) {
    const result = dryRun(scenario); expect(result.ok, JSON.stringify(scenario)).toBe(false);
    expect(commands(result, '/usr/bin/mount')).toHaveLength(0); expect(commands(result, '/usr/bin/tar')).toHaveLength(0);
    expect(result.calls.some(([kind]) => kind === 'mkdir')).toBe(false);
  }
});

test('offline exact mount proof rejects root/device/filesystem/flags/stack/children drift before tar', () => {
  for (const scenario of [{ mountDevice: '7:1' }, { mountRoot: '/subdirectory' }, { mountFs: 'xfs' }, { rootSymlink: true },
    { noMount: true }, { stacked: true }, { nested: true }, { malformedMount: true }, { bootChangesAt: 2 },
    ...['rw,nodev,nosuid,noexec','ro,nosuid,noexec','ro,nodev,noexec','ro,nodev,nosuid'].map(mountFlags => ({ mountFlags }))]) {
    const result = dryRun({ agentorParent: true, ...scenario });
    expect(result.ok, JSON.stringify(scenario)).toBe(false);
    expect(commands(result, '/usr/bin/mount')).toHaveLength(1); expect(commands(result, '/usr/bin/tar')).toHaveLength(0);
  }
});

test('offline final boot proof and unsuccessful tar prohibit final success after bytes may have streamed', () => {
  for (const scenario of [{ bootChangesAt: 3 }, { mountChangeAfterTar: true }, { rootChangeAfterTar: true }, { tarExit: 2 }]) {
    const result = dryRun({ agentorParent: true, ...scenario });
    expect(result.ok).toBe(false); expect(commands(result, '/usr/bin/tar')).toHaveLength(1);
    expect(result.error).toMatch(/boot\/mount identity changed|exact readonly ext4 root|logical archive failed/);
  }
});
