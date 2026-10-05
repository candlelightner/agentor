import { posix } from 'node:path';
import { nativeSelectedBackupPath, INCUS_SELECTED_ALIASES } from './incus-selected-archive';
import { AGENT_CREDENTIAL_MAPPINGS } from './user-credentials';
import { pathsOverlap } from './managed-volume-store';

const BOOTSTRAP = ['/restore', '/bin', '/sbin', '/lib', '/lib64', '/usr', '/boot', '/root',
  '/proc', '/sys', '/dev', '/run', '/var/run', '/var/lib/docker', '/var/lib/containerd',
  '/etc/systemd', '/etc/init.d', '/etc/netplan', '/etc/NetworkManager', '/etc/ssh',
  '/etc/sudoers', '/etc/sudoers.d', '/etc/fstab', '/etc/crypttab', '/etc/passwd',
  '/etc/group', '/etc/shadow', '/etc/gshadow', '/etc/ld.so.preload', '/etc/ld.so.conf',
  '/home/agent/.ssh'];
const ACCOUNT_PATHS = [...AGENT_CREDENTIAL_MAPPINGS.filter(item => item.fileBind !== false).map(item => item.containerPath),
  '/home/agent/.agent-data/.kilo/config', '/home/agent/.agent-data/.kilo/shared-data'];

export interface IncusSelectedRestoreDestination { path: string; resolved: string; destination: string }

function resolveKnownAlias(path: string): string {
  for (const [alias, target] of Object.entries(INCUS_SELECTED_ALIASES).sort(([a], [b]) => b.length - a.length))
    if (path === alias || path.startsWith(alias + '/')) return target + path.slice(alias.length);
  return path;
}

/** Current destination grants, never portable source paths, authorize restore.
 * Canonical descendants remain additive; whole roots use canonical payloads.
 * Ordinary explicit application files may inhabit the fresh disposable root. */
export function planIncusSelectedRestore(paths: string[], authority: {
  accountShares: boolean; hostTargets: string[]; managedTargets: string[];
}): IncusSelectedRestoreDestination[] {
  if (paths.length > 32) throw new Error('Too many selected restore destinations');
  const plans = paths.map(value => {
    const path = nativeSelectedBackupPath(value);
    if (path !== value || ['/workspace', '/home/agent/.agent-data'].includes(path))
      throw new Error('Canonical restore roots require their fixed-role payload');
    const resolved = resolveKnownAlias(path);
    if (BOOTSTRAP.some(root => pathsOverlap(resolved, root)))
      throw new Error('Selected restore overlaps disposable bootstrap or ephemeral system state');
    if ([...authority.hostTargets, ...authority.managedTargets,
      ...(authority.accountShares ? ACCOUNT_PATHS : [])].some(root => pathsOverlap(resolved, resolveKnownAlias(root))))
      throw new Error('Selected restore conflicts with current account, host or managed storage authority');
    const destination = resolved.startsWith('/workspace/') ? '/restore' + resolved
      : resolved.startsWith('/home/agent/.agent-data/') ? '/restore/.agent-data' + resolved.slice('/home/agent/.agent-data'.length)
        : resolved;
    if (posix.basename(path) !== posix.basename(destination) &&
      !(posix.basename(path) === 'kilo' && ['state', 'cache', 'config', 'shared-data'].includes(posix.basename(destination))))
      throw new Error('Unrecognized selected alias wrapper remapping');
    return { path, resolved, destination };
  });
  if (plans.some((item, index) => plans.some((other, j) => index !== j && pathsOverlap(item.resolved, other.resolved))))
    throw new Error('Selected restore destinations overlap after alias resolution');
  return plans;
}

/** A bounded validated-name prefix then unchanged raw tar on the same stdin.
 * Exact os.read avoids buffered read-ahead stealing tar bytes. This is only
 * selected extraction into the existing isolated import, not a transport SDK.
 * No services, account shares or host devices exist while it runs. */
export const INCUS_SELECTED_RESTORE_SCRIPT = String.raw`
import json,os,re,stat,struct,subprocess,sys
def read_exact(count):
    data=bytearray()
    while len(data)<count:
        part=os.read(0,count-len(data))
        if not part: raise ValueError('Truncated selected destination proof')
        data.extend(part)
    return bytes(data)
size=struct.unpack('>I',read_exact(4))[0]
if not 0<size<=64*1024*1024: raise ValueError('Selected destination proof exceeds limit')
proof=json.loads(read_exact(size));destination=proof['destination'];wrapper=proof['wrapper'];mount_roots=proof['mounts']
if not destination.startswith('/') or os.path.normpath(destination)!=destination or '\0' in destination:
    raise ValueError('Invalid selected destination')
if not wrapper or '/' in wrapper or wrapper in ('.','..'): raise ValueError('Invalid selected wrapper')
if os.path.lexists('/run/agentor/provisioned') or os.path.lexists('/run/agentor/worker.env'):
    raise ValueError('Selected restore must be unprovisioned')
for service in ('agentor-worker.service','docker.service'):
    result=subprocess.run(['/usr/bin/systemctl','is-active','--quiet',service],env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
    if result.returncode not in (3,4): raise ValueError('Selected restore services must be inactive')
with open('/proc/self/mountinfo','rb') as file: raw=file.read(1024*1024+1)
if len(raw)>1024*1024: raise ValueError('Selected mount proof exceeds limit')
mounts=[]
for line in raw.splitlines():
    fields=line.split()
    if len(fields)<10 or b'-' not in fields: raise ValueError('Invalid selected mount proof')
    mounts.append(re.sub(rb'\\([0-7]{3})',lambda m:bytes([int(m.group(1),8)]),fields[4]).decode('utf-8','surrogateescape'))
for root in mount_roots:
    if mounts.count(root)!=1: raise ValueError('Selected private storage mount missing or stacked')
if any(path!='/' and (destination==path or destination.startswith(path+'/') or path.startswith(destination+'/'))
       and path not in mount_roots for path in mounts):
    raise ValueError('Selected destination has an unexpected guest mount')
def parents(path,create=False):
    current='/'
    for part in path.strip('/').split('/'):
        current=os.path.join(current,part)
        try: mode=os.lstat(current).st_mode
        except FileNotFoundError:
            if not create: continue
            os.mkdir(current,0o755);os.chown(current,1000,1000);mode=os.lstat(current).st_mode
        if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode): raise ValueError('Selected destination ancestor is not a directory')
parent=os.path.dirname(destination);parents(parent)
members=proof['members']
if not isinstance(members,list) or not 0<len(members)<=1000000: raise ValueError('Invalid selected member proof')
for member in members:
    name=member['name'];kind=member['type']
    if not isinstance(name,str) or '\0' in name or os.path.normpath(name)!=name or \
       (name!=wrapper and not name.startswith(wrapper+'/')) or kind not in ('file','directory','symlink','hardlink'):
        raise ValueError('Invalid selected write path')
    target=destination+name[len(wrapper):]
    parents(os.path.dirname(target))
    if kind=='directory' and os.path.lexists(target) and not stat.S_ISDIR(os.lstat(target).st_mode):
        raise ValueError('Selected directory conflicts with an existing non-directory')
    if kind!='directory' and os.path.lexists(target) and stat.S_ISDIR(os.lstat(target).st_mode):
        raise ValueError('Selected file conflicts with an existing directory')
# Do not create parents until every write path has passed the no-follow proof.
parents(parent,True)
# Break old file hardlinks and replace inert symlink leaves without touching
# nonempty directories or additive unselected data. GNU --unlink-first would
# attempt to remove those directories and fail even after a valid preflight.
for member in members:
    if member['type']!='directory':
        target=destination+member['name'][len(wrapper):]
        if os.path.lexists(target): os.unlink(target)
command=['/usr/bin/tar','--numeric-owner','--same-owner','--same-permissions',
    '--xattrs','--xattrs-include=*','--acls','--delay-directory-restore','-xpf','-','-C',parent]
basename=os.path.basename(destination)
if basename!=wrapper:
    if wrapper!='kilo' or basename not in ('state','cache','config','shared-data'):
        raise ValueError('Invalid selected inverse wrapper')
    command+=['--transform=flags=rh;s#^kilo'+r'\(/\|$\)#'+basename+r'\1#']
os.execve(command[0],command,{'PATH':'/usr/bin:/bin','LC_ALL':'C','LANG':'C'})
`;
