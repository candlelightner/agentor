import { AGENT_CREDENTIAL_MAPPINGS } from './user-credentials';
import { SHARED_DIRECTORY_MOUNT_POINTS } from './storage';

const agentsRoot = '/home/agent/.agent-data';
const exclusions = {
  suffixes: AGENT_CREDENTIAL_MAPPINGS.map(mapping => mapping.containerPath.startsWith(agentsRoot + '/')
    ? mapping.containerPath.slice(agentsRoot.length + 1) : mapping.containerPath),
  prefixes: [...SHARED_DIRECTORY_MOUNT_POINTS, '.kilo/data/auth.json'],
};

/** Fixed canonical roots only. Literal mount exclusions prevent both virtiofs
 * and same-filesystem bind overlays entering portable worker data. Filtering
 * happens before tar emits PAX records, preserving arbitrary binary xattrs. */
export const INCUS_CANONICAL_ARCHIVE_SCRIPT = String.raw`
import json,os,re,stat,sys
RULES=` + JSON.stringify(exclusions) + String.raw`
ROOTS={"workspace":"/workspace","agents":"/home/agent/.agent-data"}
if len(sys.argv)!=3 or sys.argv[1] not in ROOTS:
    raise ValueError("Invalid canonical archive role")
root=ROOTS[sys.argv[1]]
if not stat.S_ISDIR(os.lstat(root).st_mode) or os.path.realpath(root)!=root:
    raise ValueError("Canonical archive root must be a non-symlink directory")
extra=json.loads(sys.argv[2])
if not isinstance(extra,list) or len(extra)>1024 or any(not isinstance(path,str) or len(path)>4096 or
    not path.startswith("/") or "\0" in path or os.path.normpath(path)!=path for path in extra):
    raise ValueError("Invalid canonical archive exclusions")
with open("/proc/self/mountinfo","rb") as source:
    raw=source.read(1024*1024+1)
if len(raw)>1024*1024:
    raise ValueError("Canonical mount observation exceeds limit")
def decode(value):
    return re.sub(rb"\\([0-7]{3})",lambda match:bytes([int(match.group(1),8)]),value).decode("utf-8","surrogateescape")
mounts=[]
for line in raw.splitlines():
    fields=line.split()
    if len(fields)<10 or b"-" not in fields:
        raise ValueError("Invalid canonical mount observation")
    mounts.append(decode(fields[4]))
if mounts.count(root)!=1:
    raise ValueError("Canonical persistent root is not unambiguously mounted")
if any(path==root or root.startswith(path+"/") for path in extra):
    raise ValueError("An external overlay covers the canonical archive root")
basename=os.path.basename(root)
paths=set(path for path in mounts+extra if path.startswith(root+"/"))
command=["/usr/bin/tar","--numeric-owner","--xattrs","--acls","--one-file-system",
    "--no-wildcards","--anchored"]
for path in sorted(paths):
    command.append("--exclude="+basename+"/"+path[len(root)+1:])
if sys.argv[1]=="agents":
    for prefix in RULES["prefixes"]:
        command.append("--exclude="+basename+"/"+prefix)
    command.extend(["--wildcards","--wildcards-match-slash"])
    for suffix in RULES["suffixes"]:
        command.append("--exclude=*/"+suffix)
    command.append("--no-wildcards")
command.extend(["-cpf","-","-C",os.path.dirname(root),"--",basename])
os.execve(command[0],command,{"PATH":"/usr/bin:/bin","LC_ALL":"C","LANG":"C"})
`;
