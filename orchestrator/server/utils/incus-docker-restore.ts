/** Runs only inside new nonce-owned, isolated initial-import compute. Native
 * authority proves the fixed disk is newly allocated; blank-media checks are
 * additional guards, never authority to format an arbitrary unused device. */
export const INCUS_DOCKER_RESTORE_SCRIPT = String.raw`
import json,os,re,stat,subprocess,time
env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','LANG':'C'}
deadline=time.monotonic()+1750
boot=open('/proc/sys/kernel/random/boot_id').read().strip()
def command(args):
 result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=30)
 if result.returncode or len(result.stdout)>65536: raise ValueError('Docker restore observation failed: '+args[0])
 return result.stdout.decode().strip()
if os.path.lexists('/run/agentor/provisioned') or os.path.lexists('/run/agentor/worker.env'):
 raise ValueError('Docker restore destination is provisioned')
services=('agentor-worker.service','docker.socket','docker.service','containerd.service')
command(['/usr/bin/systemctl','mask','--runtime',*services])
command(['/usr/bin/systemctl','stop',*services])
for service in services:
 if command(['/usr/bin/systemctl','show','--value','--property=ActiveState',service])!='inactive':
  raise ValueError('Docker restore destination unit is not inactive')
disks=set()
for path in ('/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_docker','/dev/disk/by-id/virtio-incus_docker'):
 if os.path.exists(path):
  disk=os.path.realpath(path)
  if not stat.S_ISBLK(os.stat(disk).st_mode): raise ValueError('Invalid Docker restore device')
  disks.add(disk)
if len(disks)!=1: raise ValueError('Docker restore disk identity is ambiguous')
disk=next(iter(disks));device=os.stat(disk).st_rdev
if command(['/usr/bin/lsblk','-dn','-o','TYPE',disk])!='disk' or \
 len(command(['/usr/bin/lsblk','-nr','-o','NAME',disk]).splitlines())!=1 or \
 command(['/usr/sbin/blockdev','--getro',disk])!='0':
 raise ValueError('Docker restore requires one writable whole device')
base='/run/agentor-docker-restore';root=base+'/docker'
def mounts():
 with open('/proc/self/mountinfo') as source: raw=source.read(1024*1024+1)
 if len(raw)>1024*1024: raise ValueError('Docker restore mount observation exceeds limit')
 result=[]
 for line in raw.splitlines():
  fields=line.split()
  if len(fields)<10 or '-' not in fields: raise ValueError('Invalid Docker restore mount observation')
  fields[4]=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),fields[4]);result.append(fields)
 return result
number=str(os.major(device))+':'+str(os.minor(device))
if any(fields[2]==number or fields[4]==base or fields[4].startswith(base+'/') for fields in mounts()):
 raise ValueError('Docker restore device or destination is already mounted')
# Both probes must positively complete. No signature or probe error may be
# interpreted as permission to erase a previously initialized destination.
signatures=json.loads(command(['/usr/sbin/wipefs','--no-act','--json',disk]))
if signatures.get('signatures')!=[]: raise ValueError('Docker restore disk is not blank')
probe=subprocess.run(['/usr/sbin/blkid','-p','-o','export',disk],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=30)
if probe.returncode!=2 or probe.stdout or probe.stderr: raise ValueError('Docker restore disk already has a signature or is ambiguous')
if open('/proc/sys/kernel/random/boot_id').read().strip()!=boot: raise ValueError('Docker restore boot changed')
os.mkdir(base,0o700);os.mkdir(root,0o700)
# No -F, repair, signature erasure, or retry on existing filesystems.
command(['/usr/sbin/mkfs.ext4','-q',disk])
command(['/usr/bin/mount','-t','ext4','-o','rw,nodev,nosuid,noexec',disk,root])
def prove():
 if open('/proc/sys/kernel/random/boot_id').read().strip()!=boot or os.path.realpath(root)!=root or \
  not stat.S_ISDIR(os.lstat(root).st_mode) or os.stat(disk).st_rdev!=device:
  raise ValueError('Docker restore boot or mount identity changed')
 entries=mounts();matching=[fields for fields in entries if fields[2]==number]
 if len(matching)!=1 or sum(fields[4]==root for fields in entries)!=1 or any(fields[4].startswith(root+'/') for fields in entries):
  raise ValueError('Docker restore mount is missing, stacked or has overlays')
 fields=matching[0];separator=fields.index('-')
 if fields[4]!=root or fields[3]!='/' or fields[separator+1]!='ext4' or \
  not {'rw','nodev','nosuid','noexec'}.issubset(fields[5].split(',')):
  raise ValueError('Docker restore requires the exact whole writable ext4 root')
prove()
# This sole empty directory was created by the just-proven successful mkfs.
# Never recursively delete anything, even in the fresh destination.
names=os.listdir(root)
if names!=['lost+found'] or os.path.islink(root+'/lost+found') or \
 not stat.S_ISDIR(os.lstat(root+'/lost+found').st_mode) or os.listdir(root+'/lost+found'):
 raise ValueError('Fresh Docker restore filesystem is unexpectedly populated')
os.rmdir(root+'/lost+found')
result=subprocess.run(['/usr/bin/tar','--numeric-owner','--same-owner','--same-permissions',
 '--xattrs','--xattrs-include=*','--acls','--delay-directory-restore','-xpf','-','-C',base],
 env=env,timeout=max(1,deadline-time.monotonic()))
if result.returncode: raise ValueError('Docker restore logical extraction failed')
prove()
command(['/usr/bin/sync','-f',root])
prove()
`;
