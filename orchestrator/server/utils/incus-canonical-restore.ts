/** Runs only on nonce-owned fresh destination compute with the fixed private
 * restore layout. No runtime config, account shares, host mounts or networking
 * are available while an untrusted validated archive is being extracted. */
export const INCUS_CANONICAL_RESTORE_SCRIPT = String.raw`
import os,re,stat,subprocess,sys
ROOTS={"workspace":"/restore/workspace","agents":"/restore/.agent-data"}
if len(sys.argv)!=2 or sys.argv[1] not in ROOTS:
    raise ValueError("Invalid canonical restore role")
root=ROOTS[sys.argv[1]]
for path in ("/restore",)+tuple(ROOTS.values()):
    if not stat.S_ISDIR(os.lstat(path).st_mode) or os.path.realpath(path)!=path:
        raise ValueError("Canonical restore path must be a non-symlink directory")
if os.path.lexists("/run/agentor/provisioned") or os.path.lexists("/run/agentor/worker.env"):
    raise ValueError("Canonical restore guest must be unprovisioned")
for service in ("agentor-worker.service","docker.service"):
    result=subprocess.run(["/usr/bin/systemctl","is-active","--quiet",service],
        env={"PATH":"/usr/bin:/bin","LC_ALL":"C"},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if result.returncode not in (3,4):
        raise ValueError("Canonical restore guest service must be inactive")
with open("/proc/self/mountinfo","rb") as source:
    raw=source.read(1024*1024+1)
if len(raw)>1024*1024:
    raise ValueError("Canonical restore mount observation exceeds limit")
mounts=[]
for line in raw.splitlines():
    fields=line.split()
    if len(fields)<10 or b"-" not in fields:
        raise ValueError("Invalid canonical restore mount observation")
    path=re.sub(rb"\\([0-7]{3})",lambda m:bytes([int(m.group(1),8)]),fields[4]).decode("utf-8","surrogateescape")
    mounts.append(path)
    if path in ROOTS.values() and b"rw" not in fields[5].split(b","):
        raise ValueError("Canonical restore storage must be writable")
for path in ROOTS.values():
    if mounts.count(path)!=1 or any(m.startswith(path+"/") for m in mounts):
        raise ValueError("Canonical restore private mount is missing or has overlays")
with os.scandir(root) as entries:
    if next(entries,None) is not None:
        raise ValueError("Canonical restore destination must be empty")
command=["/usr/bin/tar","--numeric-owner","--same-owner","--same-permissions",
    "--xattrs","--xattrs-include=*","--acls","--delay-directory-restore",
    "-xpf","-","-C","/restore"]
os.execve(command[0],command,{"PATH":"/usr/bin:/bin","LC_ALL":"C","LANG":"C"})
`;
