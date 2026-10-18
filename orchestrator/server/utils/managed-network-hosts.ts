import { isIP } from 'node:net';

const MAX_NAMES = 2048;
const MAX_BYTES = 48 * 1024;
const SAFE_NAME = /^[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9_])?$/;

/** Desired peer aliases only. No caller-supplied paths, markers or shell text. */
export function normalizeManagedNetworkHosts(input: unknown): Array<{ address: string; names: string[] }> {
  if (!Array.isArray(input) || input.length > MAX_NAMES) throw new Error('Invalid managed network hosts');
  const addresses = new Map<string, Set<string>>();
  let suppliedNames = 0;
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['address', 'names'].includes(key)) ||
        typeof item.address !== 'string' || isIP(item.address) !== 4 ||
        !Array.isArray(item.names) || !item.names.length)
      throw new Error('Invalid managed network hosts');
    const names = addresses.get(item.address) ?? new Set<string>();
    for (const name of item.names) {
      if (++suppliedNames > MAX_NAMES || typeof name !== 'string' ||
          !/^[A-Za-z0-9_.-]+$/.test(name) || !SAFE_NAME.test(name.toLowerCase()))
        throw new Error('Invalid managed network host name or name limit exceeded');
      names.add(name.toLowerCase());
    }
    addresses.set(item.address, names);
  }
  const result = [...addresses].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([address, names]) => ({ address, names: [...names].sort() }));
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES)
    throw new Error('Managed network hosts exceeds the output size limit');
  return result;
}

/** argv: check|apply, normalized JSON. A fixed-path guest writer, not host RPC.
 * Bind-file /etc/hosts cannot be replaced by rename. Lock and write its captured
 * regular inode directly; unchanged data is never rewritten or chmod/chowned. */
export const MANAGED_NETWORK_HOSTS_SCRIPT = String.raw`
import fcntl,ipaddress,json,os,re,stat,sys,time
PATH="/etc/hosts"
MAX_NAMES=2048
MAX_OUTPUT=48*1024
MAX_FILE=1024*1024
BEGIN=b"# BEGIN AGENTOR MANAGED NETWORK HOSTS"
END=b"# END AGENTOR MANAGED NETWORK HOSTS"
NAME=re.compile(r"[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9_])?",re.ASCII)

def invalid(message):
    raise ValueError(message)

if len(sys.argv)!=3 or sys.argv[1] not in ("check","apply"):
    invalid("Managed hosts requires mode and normalized JSON")
if len(sys.argv[2].encode("utf-8"))>MAX_OUTPUT:
    invalid("Managed hosts input exceeds size limit")
items=json.loads(sys.argv[2])
if not isinstance(items,list) or len(items)>MAX_NAMES:
    invalid("Invalid managed hosts input")
addresses={}
count=0
for item in items:
    if not isinstance(item,dict) or set(item)!={"address","names"} or not isinstance(item["address"],str):
        invalid("Invalid managed hosts address")
    address=item["address"]
    if str(ipaddress.IPv4Address(address))!=address:
        invalid("Managed hosts requires strict IPv4")
    if not isinstance(item["names"],list) or not item["names"]:
        invalid("Invalid managed hosts names")
    names=addresses.setdefault(address,set())
    for name in item["names"]:
        count+=1
        if count>MAX_NAMES or not isinstance(name,str) or not name.isascii() or not NAME.fullmatch(name.lower()):
            invalid("Invalid managed hosts name or count")
        names.add(name.lower())
normalized=[{"address":address,"names":sorted(names)} for address,names in sorted(addresses.items())]
encoded=json.dumps(normalized,separators=(",",":"),ensure_ascii=True).encode("ascii")
if len(encoded)>MAX_OUTPUT:
    invalid("Managed hosts output exceeds size limit")
body=b"".join((item["address"]+" "+" ".join(item["names"])+"\n").encode("ascii") for item in normalized)
section=BEGIN+b"\n"+body+END+b"\n" if normalized else b""
if len(section)>MAX_OUTPUT:
    invalid("Managed hosts section exceeds size limit")

fd=os.open(PATH,(os.O_RDONLY if sys.argv[1]=="check" else os.O_RDWR)|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
try:
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size>MAX_FILE:
        invalid("Managed hosts file must be regular and bounded")
    deadline=time.monotonic()+5
    while True:
        try:
            fcntl.flock(fd,(fcntl.LOCK_SH if sys.argv[1]=="check" else fcntl.LOCK_EX)|fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic()>=deadline:
                invalid("Managed hosts lock timed out")
            time.sleep(0.02)
    info=os.fstat(fd)
    current=bytearray()
    while len(current)<=MAX_FILE:
        chunk=os.read(fd,min(65536,MAX_FILE+1-len(current)))
        if not chunk:
            break
        current.extend(chunk)
    if len(current)>MAX_FILE:
        invalid("Managed hosts file exceeds size limit")
    current=bytes(current)
    lines=current.splitlines(keepends=True)
    starts=[]
    ends=[]
    for index,line in enumerate(lines):
        bare=line[:-1] if line.endswith(b"\n") else line
        for marker,found in ((BEGIN,starts),(END,ends)):
            if marker in bare:
                if bare!=marker:
                    invalid("Malformed managed hosts marker")
                found.append(index)
    if starts or ends:
        if len(starts)!=1 or len(ends)!=1 or starts[0]>=ends[0]:
            invalid("Duplicate or malformed managed hosts section")
        desired=b"".join(lines[:starts[0]])+section+b"".join(lines[ends[0]+1:])
    else:
        desired=section+current
    if len(desired)>MAX_FILE:
        invalid("Managed hosts result exceeds file size limit")
    path_info=os.stat(PATH,follow_symlinks=False)
    if (path_info.st_dev,path_info.st_ino)!=(info.st_dev,info.st_ino) or not stat.S_ISREG(path_info.st_mode):
        invalid("Managed hosts file identity changed")
    if desired==current:
        sys.exit(0)
    if sys.argv[1]=="check":
        sys.exit(3)
    os.lseek(fd,0,os.SEEK_SET)
    written=0
    while written<len(desired):
        size=os.write(fd,desired[written:])
        if size<=0:
            invalid("Managed hosts write failed")
        written+=size
    os.ftruncate(fd,len(desired))
    os.fsync(fd)
finally:
    os.close(fd)
`;
