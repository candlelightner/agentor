/** Fixed guest-only workspace replacement. Raw bytes are validated by the
 * existing canonical codec before the caller streams them into the prepared
 * stage with GNU tar. A commit acknowledgement must precede `finish`; unknown
 * execution never grants permission to clear the existing helper receipt. */
export const INCUS_WORKSPACE_REPLACE_SCRIPT = String.raw`
import os,re,shutil,stat,subprocess,sys
ROOT='/target'
MOUNTINFO='/proc/self/mountinfo'
if len(sys.argv)!=3 or sys.argv[1] not in ('prepare','commit','finish') or not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',sys.argv[2]):
    raise ValueError('Invalid fixed workspace replacement command')
mode,nonce=sys.argv[1:];stage='.agentor-restore-stage-'+nonce;rollback='.agentor-restore-rollback-'+nonce
reserved=('.agentor-restore-stage','.agentor-restore-rollback')
if any(os.path.lexists(p) for p in ('/run/agentor/provisioned','/run/agentor/worker.env','/run/agentor/runtime.env')):
    raise ValueError('Workspace replacement guest must be unprovisioned')
for service in ('agentor-worker.service','docker.service','docker.socket','containerd.service'):
    result=subprocess.run(['/usr/bin/systemctl','show','--no-pager','--property=LoadState,ActiveState,SubState',service],
        env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode!=0 or len(result.stdout)>4096:
        raise ValueError('Workspace service state observation failed: '+service)
    fields=result.stdout.decode('ascii').splitlines();state={}
    for field in fields:
        key,separator,value=field.partition('=')
        if separator!='=' or key not in ('LoadState','ActiveState','SubState') or key in state:
            raise ValueError('Workspace service state observation is malformed: '+service)
        state[key]=value
    if state.get('LoadState') not in ('loaded','masked','not-found') or state.get('ActiveState')!='inactive' or state.get('SubState')!='dead':
        raise ValueError('Workspace replacement service must be inactive/dead: '+service)
for path in ('/',ROOT):
    if not stat.S_ISDIR(os.lstat(path).st_mode) or os.path.realpath(path)!=path:
        raise ValueError('Workspace target must be a non-symlink directory')
with open(MOUNTINFO,'rb') as file: raw=file.read(1024*1024+1)
if len(raw)>1024*1024: raise ValueError('Workspace mount proof exceeds limit')
mounts=[]
for line in raw.splitlines():
    fields=line.split()
    if len(fields)<10 or b'-' not in fields: raise ValueError('Invalid workspace mount proof')
    path=re.sub(rb'\\([0-7]{3})',lambda m:bytes([int(m.group(1),8)]),fields[4]).decode('utf-8','surrogateescape')
    mounts.append((path,fields[5].split(b','),fields[fields.index(b'-')+1]))
target=[item for item in mounts if item[0]==ROOT]
if len(target)!=1 or b'rw' not in target[0][1] or b'ro' in target[0][1] or target[0][2]!=b'virtiofs' or any(p.startswith(ROOT+'/') for p,_,_ in mounts):
    raise ValueError('Workspace requires one RW virtiofs mount without child overlays')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
root=os.open(ROOT,flags)
def metadata(fd):
    value=os.fstat(fd)
    return (value.st_uid,value.st_gid,stat.S_IMODE(value.st_mode),value.st_atime_ns,value.st_mtime_ns,
        {name:os.getxattr(fd,name) for name in os.listxattr(fd)})
def apply_metadata(fd,value):
    uid,gid,permissions,atime,mtime,attrs=value
    current=os.fstat(fd)
    if (current.st_uid,current.st_gid)!=(uid,gid): os.fchown(fd,uid,gid)
    os.fchmod(fd,permissions)
    for name in os.listxattr(fd):
        if name not in attrs: os.removexattr(fd,name)
    for name,data in attrs.items(): os.setxattr(fd,name,data)
    os.utime(fd,ns=(atime,mtime))
def directory(name,parent): return os.open(name,flags,dir_fd=parent)
def exists(name,parent):
    try: os.stat(name,dir_fd=parent,follow_symlinks=False);return True
    except FileNotFoundError: return False
def check_markers(allowed):
    if any(name.startswith(reserved) and name not in allowed for name in os.listdir(root)):
        raise ValueError('Unsettled workspace replacement marker exists')
try:
    if mode=='prepare':
        check_markers(set())
        before=metadata(root)
        os.mkdir(stage,0o700,dir_fd=root)
        apply_metadata(root,before)
        prepared=directory(stage,root)
        try: os.fsync(prepared);os.fsync(root)
        finally: os.close(prepared)
        print('workspace-replace-prepared')
    else:
        check_markers({stage,rollback})
        staged=directory(stage,root)
        try:
            if os.listdir(staged)!=['workspace']: raise ValueError('Workspace stage wrapper is invalid')
            source=directory('workspace',staged)
            try:
                if mode=='finish':
                    if os.listdir(source): raise ValueError('Committed workspace stage must be empty')
                    saved=metadata(root);old=directory(rollback,root);os.close(old)
                    shutil.rmtree(ROOT+'/'+rollback);shutil.rmtree(ROOT+'/'+stage)
                    apply_metadata(root,saved)
                    os.fsync(root)
                    print('workspace-replace-finished')
                else:
                    if exists(rollback,root): raise ValueError('Workspace rollback marker already exists')
                    promoted_names=sorted(os.listdir(source))
                    if any(name.startswith(reserved) for name in promoted_names): raise ValueError('Workspace payload collides with replacement markers')
                    before=metadata(root);after=metadata(source)
                    os.mkdir(rollback,0o700,dir_fd=root);old=directory(rollback,root)
                    moved=[];promoted=[]
                    try:
                        for name in os.listdir(root):
                            if name in (stage,rollback): continue
                            os.rename(name,name,src_dir_fd=root,dst_dir_fd=old);moved.append(name)
                        apply_metadata(old,before)
                        for name in promoted_names:
                            os.rename(name,name,src_dir_fd=source,dst_dir_fd=root);promoted.append(name)
                        apply_metadata(root,after)
                        for fd in (source,old,staged,root): os.fsync(fd)
                    except Exception:
                        for name in reversed(promoted): os.rename(name,name,src_dir_fd=root,dst_dir_fd=source)
                        for name in reversed(moved): os.rename(name,name,src_dir_fd=old,dst_dir_fd=root)
                        os.close(old);old=None
                        os.rmdir(rollback,dir_fd=root)
                        shutil.rmtree(ROOT+'/'+stage)
                        apply_metadata(root,before)
                        os.fsync(root)
                        print('workspace-replace-rolled-back')
                        raise
                    finally:
                        if old is not None: os.close(old)
                    # Old canonical bytes remain until a separate acknowledged
                    # commit permits finish. SIGKILL/transport loss is unknown.
                    print('workspace-replace-committed')
            finally: os.close(source)
        finally: os.close(staged)
finally: os.close(root)
`;
