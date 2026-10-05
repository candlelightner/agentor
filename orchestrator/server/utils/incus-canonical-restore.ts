import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES,
  MAX_PORTABLE_MANAGED_VOLUME_EXPANDED_BYTES, validateIncusCanonicalRestoreArchive } from './portable-managed-volume-archive';

export const MAX_INCUS_CANONICAL_RESTORE_RAW_BYTES = MAX_PORTABLE_MANAGED_VOLUME_EXPANDED_BYTES;

/** Prepare unchanged canonical tar bytes in caller-owned private scratch.
 * This neither extracts filesystem state nor touches any runtime/storage. */
export async function prepareIncusCanonicalRestorePayload(
  payloadPath: string,
  role: 'workspace' | 'agents',
  privateWorkDir: string,
  options: { maxRawBytes?: number; signal?: AbortSignal } = {},
): Promise<{ archivePath: string; rawBytes: number; entries: number; expandedBytes: number }> {
  if (role !== 'workspace' && role !== 'agents') throw new Error('Invalid Incus canonical restore role');
  const requestedLimit = options.maxRawBytes ?? MAX_INCUS_CANONICAL_RESTORE_RAW_BYTES;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0)
    throw new Error('Invalid Incus canonical restore raw-byte limit');
  const maxRawBytes = Math.min(requestedLimit, MAX_INCUS_CANONICAL_RESTORE_RAW_BYTES);
  options.signal?.throwIfAborted();
  const directory = await lstat(privateWorkDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      directory.uid !== process.geteuid?.())
    throw new Error('Incus canonical restore scratch must be a caller-owned private non-symlink directory');
  const archivePath = join(privateWorkDir, `${role}-${randomUUID()}.tar`);
  let source: FileHandle | undefined, destination: FileHandle | undefined, created = false, rawBytes = 0;
  try {
    source = await open(payloadPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const input = await source.stat();
    if (!input.isFile() || input.size > MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES)
      throw new Error('Incus canonical restore gzip input must be a bounded regular file');
    options.signal?.throwIfAborted();
    destination = await open(archivePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      rawBytes += Buffer.byteLength(chunk);
      callback(rawBytes > maxRawBytes ? new Error('Incus canonical restore exceeds the raw-byte limit') : null, chunk);
    } });
    await pipeline(source.createReadStream(), createGunzip(), bounded, destination.createWriteStream(), { signal: options.signal });
    const summary = await validateIncusCanonicalRestoreArchive(archivePath, role,
      { maxExpandedBytes: maxRawBytes, signal: options.signal });
    return { archivePath, rawBytes, ...summary };
  } catch (error) {
    await destination?.close().catch(() => {});
    if (created) await rm(archivePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await source?.close().catch(() => {});
    await destination?.close().catch(() => {});
  }
}

/** Runs only on nonce-owned fresh destination compute with the fixed private
 * restore layout. No runtime config, account shares, host mounts or networking
 * are available while an untrusted validated archive is being extracted. */
export const INCUS_CANONICAL_RESTORE_SCRIPT = String.raw`
import os,re,stat,subprocess,sys
ROOTS={"workspace":"/restore/workspace","agents":"/restore/.agent-data"}
if len(sys.argv) not in (2,3):
    raise ValueError("Invalid canonical restore role")
role=sys.argv[1];managed=re.fullmatch(r"managed:([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})",role)
if managed:
    ROOTS[role]="/restore/managed/"+managed.group(1)+"/volume"
if role not in ROOTS or len(sys.argv)==3 and (sys.argv[2]!="empty" or managed):
    raise ValueError("Invalid canonical restore role")
root=ROOTS[role]
parents=("/restore/managed",os.path.dirname(root)) if managed else ()
for path in ("/restore",)+parents+tuple(ROOTS.values()):
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
# A missing payload is a fresh empty role, not authority to recursively alter
# another restored tree. Initialize only this verified mount root for agent.
if len(sys.argv)==3:
    os.chown(root,1000,1000)
    os.chmod(root,0o755 if sys.argv[1]=="workspace" else 0o700)
    sys.exit(0)
command=["/usr/bin/tar","--numeric-owner","--same-owner","--same-permissions",
    "--xattrs","--xattrs-include=*","--acls","--delay-directory-restore",
    "-xpf","-","-C",os.path.dirname(root)]
os.execve(command[0],command,{"PATH":"/usr/bin:/bin","LC_ALL":"C","LANG":"C"})
`;
