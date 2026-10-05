import { AGENT_CREDENTIAL_MAPPINGS } from './user-credentials';
import { normalizeBackupPath } from './backup-paths';

/** These are existing worker entrypoint aliases, not arbitrary guest links. */
export const INCUS_SELECTED_ALIASES: Record<string, string> = {
  ...Object.fromEntries(['.claude', '.gemini', '.codex', '.agents', '.vscode', '.claude.json']
    .map(name => ['/home/agent/' + name, '/home/agent/.agent-data/' + name])),
  '/home/agent/.config/kilo': '/home/agent/.agent-data/.kilo/config',
  '/home/agent/.local/share/kilo': '/home/agent/.agent-data/.kilo/shared-data',
  '/home/agent/.local/state/kilo': '/home/agent/.agent-data/.kilo/state',
  '/home/agent/.cache/kilo': '/home/agent/.agent-data/.kilo/cache',
};

export function nativeSelectedBackupPath(value: string): string {
  const path = normalizeBackupPath(value).replace(/\/$/, '') || '/';
  if (path === '/') throw Object.assign(new Error('Incus root filesystem is disposable; select individual data paths instead'),
    { statusCode: 409, code: 'INCUS_DISPOSABLE_ROOTFS' });
  if (['/proc', '/sys', '/dev', '/run'].some(root => path === root || path.startsWith(root + '/')))
    throw Object.assign(new Error('Ephemeral guest filesystems and runtime secrets are not portable backup data'),
      { statusCode: 409, code: 'INCUS_EPHEMERAL_BACKUP_PATH' });
  if (['/var/lib/docker', '/var/lib/containerd'].some(root => path === root || path.startsWith(root + '/')))
    throw Object.assign(new Error('Native Docker data requires a quiesced logical Docker backup'),
      { statusCode: 409, code: 'INCUS_DOCKER_BACKUP_REQUIRED' });
  return path;
}

/** Selected GNU/PAX capture only: bounded non-recursive member list skips
 * specials and unselected nested mounts BEFORE emitting binary metadata.
 * Runtime proves native storage/grants; this script proves guest mount and
 * alias identity without trusting arbitrary realpath resolution. */
export const INCUS_SELECTED_ARCHIVE_SCRIPT = String.raw`
import json,os,re,stat,subprocess,sys
ALIASES=` + JSON.stringify(INCUS_SELECTED_ALIASES) + String.raw`
CREDENTIALS=` + JSON.stringify(AGENT_CREDENTIAL_MAPPINGS.filter(mapping => mapping.fileBind !== false)
  .map(mapping => ({ path: mapping.containerPath, file: mapping.fileName }))) + String.raw`
if len(sys.argv)!=3: raise ValueError('Invalid selected archive request')
selected=sys.argv[1];spec=json.loads(sys.argv[2])
if not selected.startswith('/') or selected=='/' or os.path.normpath(selected)!=selected or '\0' in selected:
    raise ValueError('Invalid selected archive path')
if not isinstance(spec,dict) or set(spec)!={'mounts','credentials'} or not isinstance(spec['credentials'],bool) or \
    not isinstance(spec['mounts'],list) or len(spec['mounts'])>1024:
    raise ValueError('Invalid selected archive source proof')
for path in spec['mounts']:
    if not isinstance(path,str) or not path.startswith('/') or os.path.normpath(path)!=path:
        raise ValueError('Invalid selected source mount')
source=selected
for alias,target in sorted(ALIASES.items(),key=lambda item:len(item[0]),reverse=True):
    if selected==alias or selected.startswith(alias+'/'):
        if not stat.S_ISLNK(os.lstat(alias).st_mode) or os.readlink(alias)!=target:
            raise ValueError('Built-in agent alias identity changed')
        source=target+selected[len(alias):];break
for root in ('/proc','/sys','/dev','/run','/var/lib/docker','/var/lib/containerd'):
    if source==root or source.startswith(root+'/'): raise ValueError('Nonportable selected source')
# Only a proven built-in alias may resolve an ancestor. The selected leaf
# itself can be an inert symlink; GNU tar never dereferences it.
parent=os.path.dirname(source)
if os.path.realpath(parent)!=parent: raise ValueError('Selected archive ancestor is a symlink')
readable=subprocess.run(['/usr/sbin/runuser','-u','agent','--','/usr/bin/python3','-c',
    'import os,sys;os.lstat(sys.argv[1]);sys.exit(0 if os.access(sys.argv[1],os.R_OK) else 3)',source],
    env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if readable.returncode: raise ValueError('Selected archive is missing or unreadable by agent')
with open('/proc/self/mountinfo','rb') as file: raw=file.read(1024*1024+1)
if len(raw)>1024*1024: raise ValueError('Selected mount observation exceeds limit')
def decode(value):
    return re.sub(rb'\\([0-7]{3})',lambda m:bytes([int(m.group(1),8)]),value).decode('utf-8','surrogateescape')
mounts={}
for line in raw.splitlines():
    fields=line.split()
    if len(fields)<10 or b'-' not in fields: raise ValueError('Invalid selected mount observation')
    path=decode(fields[4]);mounts.setdefault(path,[]).append(fields)
for path in spec['mounts']:
    if len(mounts.get(path,[]))!=1: raise ValueError('Native source mount is unavailable or stacked')
approved=set(spec['mounts']);credential_mounts=set()
if spec['credentials']:
    if '/run/agentor/account-credentials' not in approved: raise ValueError('Account source is not native-authorized')
    for mapping in CREDENTIALS:
        path=mapping['path']
        # Only selections containing this exact file opt into its bytes.
        if not (source==path or path.startswith(source+'/')): continue
        expected='/run/agentor/account-credentials/'+mapping['file']
        a=os.lstat(expected);b=os.lstat(path)
        if not stat.S_ISREG(a.st_mode) or not stat.S_ISREG(b.st_mode) or a.st_nlink!=1 or \
            (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino) or len(mounts.get(path,[]))!=1:
            raise ValueError('Credential bind is stale or ambiguous; reprovision before backup')
        credential_mounts.add(path)
# A selected mount/subpath needs native authority. Unknown guest-created
# overlays never become portable storage authority just by sharing a path.
covering=[path for path in mounts if path!='/' and (source==path or source.startswith(path+'/'))]
if any(path not in approved and path not in credential_mounts for path in covering):
    raise ValueError('Selected source is covered by an unapproved guest mount')
excluded={path for path in mounts if path.startswith(source+'/') and path not in credential_mounts}
excluded.update(('/proc','/sys','/dev','/run','/var/lib/docker','/var/lib/containerd'))
basename=os.path.basename(source);wrapper=os.path.basename(selected)
command=['/usr/bin/tar','--format=pax','--numeric-owner','--xattrs','--xattrs-include=*','--acls',
    '--no-recursion','--null','--verbatim-files-from','-C',os.path.dirname(source)]
if basename!=wrapper:
    # Only the fixed Kilo aliases above change their basename. Transform
    # member/hardlink names, never symlink values or user-controlled patterns.
    if wrapper!='kilo' or basename not in ('config','shared-data','state','cache'):
        raise ValueError('Unsupported selected wrapper remapping')
    command+=['--transform=flags=rh;s#^'+basename+r'\(/\|$\)#kilo\1#']
command+=['-cpf','-','-T','-']
process=subprocess.Popen(command,stdin=subprocess.PIPE,env={'PATH':'/usr/bin:/bin','LC_ALL':'C','LANG':'C'})
count=0;name_bytes=0;pending=[source]
try:
    while pending:
        path=pending.pop()
        if path in excluded: continue
        st=os.lstat(path)
        if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode)): continue
        member=os.path.relpath(path,os.path.dirname(source))
        encoded=os.fsencode(member);count+=1;name_bytes+=len(encoded)+1
        if count>1000000 or name_bytes>64*1024*1024 or len(encoded)>4096:
            raise ValueError('Selected archive member observation exceeds limit')
        process.stdin.write(encoded+b'\0')
        if stat.S_ISDIR(st.st_mode):
            with os.scandir(path) as entries:
                children=[]
                for entry in entries:
                    children.append(entry.path)
                    if len(children)+len(pending)+count>1000000:
                        raise ValueError('Selected archive traversal exceeds limit')
            pending.extend(sorted(children,reverse=True))
    process.stdin.close()
    code=process.wait()
    if code: raise ValueError('Selected archive tar failed: '+str(code))
finally:
    if process.poll() is None: process.kill();process.wait()
`;
