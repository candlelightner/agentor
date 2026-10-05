import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { INCUS_DOCKER_RESTORE_SCRIPT } from '../../orchestrator/server/utils/incus-docker-restore';

// All guest filesystem/process operations are virtual. Unknown operations
// fail closed instead of ever accessing this worker's devices or filesystem.
const HARNESS = String.raw`
import builtins,io,json,os,re,stat,subprocess,sys,time,types
input=json.load(sys.stdin);case=input['case'];calls=[];reads=0;mounted=False;tar_ran=False
base='/run/agentor-docker-restore';root=base+'/docker';directories={'/','/run'};lost=False
scsi='/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_docker';virtio='/dev/disk/by-id/virtio-incus_docker'
services=['agentor-worker.service','docker.socket','docker.service','containerd.service']
def exists(path):
 if path==scsi: return not case.get('missingDisk',False)
 if path==virtio: return case.get('secondSerial',False)
 if path=='/run/agentor/provisioned': return case.get('provisioned',False)
 if path=='/run/agentor/worker.env': return case.get('configured',False)
 return path in directories
def realpath(path):
 if path==scsi: return '/dev/vdb'
 if path==virtio: return '/dev/vdc' if case.get('ambiguousDisk',False) else '/dev/vdb'
 if path==root: return '/foreign' if case.get('rootReplacement',False) or tar_ran and case.get('rootChangesAfterTar',False) else root
 raise AssertionError('unexpected realpath '+path)
def observation(path):
 if path in ('/dev/vdb','/dev/vdc'):
  minor=1 if path=='/dev/vdc' or tar_ran and case.get('deviceChangesAfterTar',False) else 0
  return types.SimpleNamespace(st_mode=stat.S_IFREG if case.get('regularDevice',False) else stat.S_IFBLK,st_rdev=os.makedev(7,minor))
 if path==root: return types.SimpleNamespace(st_mode=stat.S_IFREG if case.get('rootFile',False) else stat.S_IFDIR)
 if path==root+'/lost+found' and lost:
  return types.SimpleNamespace(st_mode=stat.S_IFREG if case.get('lostFile',False) else stat.S_IFDIR)
 if path in directories: return types.SimpleNamespace(st_mode=stat.S_IFDIR)
 raise FileNotFoundError(path)
def mkdir(path,mode=0o777):
 calls.append(['mkdir',path,mode]);assert path in (base,root) and mode==0o700
 if os.path.dirname(path) not in directories: raise FileNotFoundError(path)
 if path in directories: raise FileExistsError(path)
 directories.add(path)
def listdir(path):
 if path==root: return ['lost+found','data'] if case.get('populated',False) else ['lost+found'] if lost else []
 if path==root+'/lost+found': return ['retained-data'] if case.get('lostNonempty',False) else []
 raise AssertionError('unexpected listdir '+path)
def islink(path):
 assert path==root+'/lost+found';return case.get('lostSymlink',False)
def rmdir(path):
 global lost
 calls.append(['rmdir',path]);assert path==root+'/lost+found' and lost and not listdir(path);lost=False
def mountinfo():
 if not mounted:
  if case.get('alreadyMounted',False): return '1 0 7:0 / /elsewhere rw - ext4 /dev/vdb rw\n'
  if case.get('destinationMounted',False): return '1 0 8:0 / '+base+'/overlay rw - tmpfs tmpfs rw\n'
  return ''
 fields='20 1 '+case.get('mountDevice','7:0')+' '+case.get('mountRoot','/')+' '+root+' '+case.get('mountFlags','rw,nodev,nosuid,noexec')+' - '+case.get('mountFs','ext4')+' /dev/vdb rw\n'
 if case.get('noMount',False): return ''
 if case.get('stacked',False): fields+=fields
 if case.get('secondDeviceMount',False): fields+='21 1 7:0 / /elsewhere rw - ext4 /dev/vdb rw\n'
 if case.get('nested',False): fields+='21 20 8:0 / '+root+'/nested rw - tmpfs tmpfs rw\n'
 if case.get('malformedMount',False): fields+='malformed\n'
 return fields
def opened(path,*args,**kwargs):
 global reads
 if path=='/proc/sys/kernel/random/boot_id':
  reads+=1;return io.StringIO('new-boot' if reads>=case.get('bootChangesAt',999) else 'original-boot')
 if path=='/proc/self/mountinfo': return io.StringIO(mountinfo())
 raise AssertionError('unexpected open '+path)
def run(args,**kwargs):
 global mounted,tar_ran,lost
 calls.append(['command',args]);assert kwargs['env']=={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','LANG':'C'}
 code=0;error=b''
 if args[0]=='/usr/bin/systemctl':
  if args[1]=='mask': assert args[1:]==['mask','--runtime',*services];code=1 if case.get('maskFails',False) else 0;output=''
  elif args[1]=='stop': assert args[1:]==['stop',*services];code=1 if case.get('stopFails',False) else 0;output=''
  else:
   assert args[1:4]==['show','--value','--property=ActiveState'] and args[4] in services
   output=case.get('unitState','active') if args[4]==case.get('activeService') else 'inactive'
 elif args[0]=='/usr/bin/lsblk':
  assert args[-1]=='/dev/vdb'
  output=case.get('deviceType','disk') if args[1:4]==['-dn','-o','TYPE'] else 'vdb\nvdb1' if case.get('partition',False) else 'vdb'
 elif args[0]=='/usr/sbin/blockdev': assert args[1:]==['--getro','/dev/vdb'];output='1' if case.get('readonly',False) else '0'
 elif args[0]=='/usr/sbin/wipefs':
  assert args[1:]==['--no-act','--json','/dev/vdb'];code=1 if case.get('wipeProbeError',False) else 0
  output='not-json' if case.get('malformedProbe',False) else json.dumps({'signatures':[{'type':'ext4'}] if case.get('nonblank',False) else []})
 elif args[0]=='/usr/sbin/blkid':
  assert args[1:]==['-p','-o','export','/dev/vdb'];code=case.get('blkidCode',2)
  output='TYPE=ext4' if case.get('blkidSignature',False) else '';error=b'Input/output error' if case.get('blkidStderr',False) else b''
 elif args[0]=='/usr/sbin/mkfs.ext4': assert args==['/usr/sbin/mkfs.ext4','-q','/dev/vdb'];lost=True;output=''
 elif args[0]=='/usr/bin/mount':
  assert args==['/usr/bin/mount','-t','ext4','-o','rw,nodev,nosuid,noexec','/dev/vdb',root];mounted=True;output=''
 elif args[0]=='/usr/bin/tar':
  assert args==['/usr/bin/tar','--numeric-owner','--same-owner','--same-permissions','--xattrs','--xattrs-include=*','--acls','--delay-directory-restore','-xpf','-','-C',base]
  assert 0<kwargs['timeout']<=1750;tar_ran=True
  return subprocess.CompletedProcess(args,case.get('tarExit',0),b'',b'')
 elif args[0]=='/usr/bin/sync': assert args==['/usr/bin/sync','-f',root];output=''
 else: raise AssertionError('unexpected command '+repr(args))
 assert kwargs['timeout']==30
 return subprocess.CompletedProcess(args,code,output.encode(),error)
builtins.open=opened;os.path.exists=exists;os.path.lexists=exists;os.path.realpath=realpath;os.path.islink=islink
os.stat=observation;os.lstat=observation;os.mkdir=mkdir;os.listdir=listdir;os.rmdir=rmdir;subprocess.run=run
try:
 exec(compile(input['script'],'guest-docker-restore','exec'),{})
 result={'ok':True,'calls':calls,'bootReads':reads}
except Exception as error: result={'ok':False,'error':str(error),'calls':calls,'bootReads':reads}
print(json.dumps(result))
`;

function dryRun(scenario: Record<string, unknown> = {}) {
  const result = spawnSync('python3', ['-c', HARNESS], { input: JSON.stringify({ script: INCUS_DOCKER_RESTORE_SCRIPT, case: scenario }), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { ok: boolean; error?: string; calls: Array<[string, any, any?]>; bootReads: number };
}
const commands = (result: ReturnType<typeof dryRun>, executable: string) => result.calls.filter(([kind, args]) => kind === 'command' && args[0] === executable);

test('Docker inverse dry success requires exact blank whole disk and fixed nonforced format, mount, tar and sync', () => {
  const result = dryRun({ secondSerial: true }); expect(result.ok, result.error).toBe(true);
  expect(commands(result, '/usr/sbin/mkfs.ext4').map(([, args]) => args)).toEqual([['/usr/sbin/mkfs.ext4', '-q', '/dev/vdb']]);
  expect(commands(result, '/usr/bin/mount')).toHaveLength(1); expect(commands(result, '/usr/bin/tar')).toHaveLength(1);
  expect(commands(result, '/usr/bin/sync')).toHaveLength(1); expect(result.bootReads).toBe(5);
  expect(result.calls.filter(([kind]) => kind === 'rmdir')).toEqual([['rmdir', '/run/agentor-docker-restore/docker/lost+found']]);
  expect(result.calls.filter(([kind]) => kind === 'mkdir')).toEqual([
    ['mkdir', '/run/agentor-docker-restore', 0o700], ['mkdir', '/run/agentor-docker-restore/docker', 0o700],
  ]);
});

test('Docker inverse rejects provenance, units, ambiguous/readonly/nonwhole/mounted/nonblank and failed probes before formatting', () => {
  const cases = [{ provisioned: true }, { configured: true }, { maskFails: true }, { stopFails: true },
    ...['agentor-worker.service','docker.socket','docker.service','containerd.service'].flatMap(activeService =>
      ['active','activating','deactivating','failed'].map(unitState => ({ activeService, unitState }))),
    { missingDisk: true }, { secondSerial: true, ambiguousDisk: true }, { regularDevice: true },
    { deviceType: 'part' }, { partition: true }, { readonly: true }, { alreadyMounted: true }, { destinationMounted: true },
    { nonblank: true }, { wipeProbeError: true }, { malformedProbe: true }, { blkidCode: 1 }, { blkidCode: 0 },
    { blkidSignature: true }, { blkidStderr: true }, { bootChangesAt: 2 }];
  for (const scenario of cases) {
    const result = dryRun(scenario); expect(result.ok, JSON.stringify(scenario)).toBe(false);
    expect(commands(result, '/usr/sbin/mkfs.ext4'), JSON.stringify(scenario)).toHaveLength(0);
    expect(commands(result, '/usr/bin/mount')).toHaveLength(0); expect(commands(result, '/usr/bin/tar')).toHaveLength(0);
    expect(result.calls.some(([kind]) => kind === 'mkdir')).toBe(false);
  }
});

test('Docker inverse rejects mount overlays, wrong identity and unexpected lost+found before extracting any bytes', () => {
  for (const scenario of [{ noMount: true }, { stacked: true }, { secondDeviceMount: true }, { nested: true }, { malformedMount: true },
    { mountDevice: '7:1' }, { mountRoot: '/subtree' }, { mountFs: 'xfs' }, { rootReplacement: true }, { rootFile: true },
    { bootChangesAt: 3 }, ...['ro,nodev,nosuid,noexec','rw,nosuid,noexec','rw,nodev,noexec','rw,nodev,nosuid'].map(mountFlags => ({ mountFlags })),
    { populated: true }, { lostFile: true }, { lostSymlink: true }, { lostNonempty: true }]) {
    const result = dryRun(scenario); expect(result.ok, JSON.stringify(scenario)).toBe(false);
    expect(commands(result, '/usr/sbin/mkfs.ext4')).toHaveLength(1); expect(commands(result, '/usr/bin/tar')).toHaveLength(0);
    expect(result.calls.some(([kind]) => kind === 'rmdir')).toBe(false);
  }
});

test('Docker inverse post-extraction identity/boot failures and unsuccessful tar never return final success', () => {
  for (const scenario of [{ tarExit: 2 }, { bootChangesAt: 4 }, { bootChangesAt: 5 },
    { deviceChangesAfterTar: true }, { rootChangesAfterTar: true }]) {
    const result = dryRun(scenario); expect(result.ok).toBe(false); expect(commands(result, '/usr/bin/tar')).toHaveLength(1);
    expect(result.error).toMatch(/boot or mount identity changed|logical extraction failed/);
    expect(commands(result, '/usr/bin/sync')).toHaveLength('bootChangesAt' in scenario && scenario.bootChangesAt === 5 ? 1 : 0);
  }
});
