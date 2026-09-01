import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import type { Config } from './config';
import { BackupKeyring, deriveBackupArchiveKey } from './backup-keyring';

async function key(config: Config): Promise<Buffer> {
  const keyPath = join(config.dataDir, 'backup.key');
  let secret = process.env.BACKUP_ENCRYPTION_KEY?.trim() || '';
  if (!secret) try { secret = (await readFile(keyPath, 'utf8')).trim(); } catch {}
  if (!secret) {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    secret = randomBytes(32).toString('hex');
    await writeFile(keyPath, secret, { mode: 0o600, flag: 'wx' }).catch(async()=>{secret=(await readFile(keyPath,'utf8')).trim();});
  }
  if (!secret) throw new Error('Dedicated backup encryption key is unavailable');
  if (!process.env.BACKUP_ENCRYPTION_KEY) {
    const info = await lstat(keyPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup encryption key must be a regular non-symlink file');
    await chmod(keyPath, 0o600);
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from('agentor-backups-v1'), Buffer.from('archive-key'), 32));
}

export async function encryptBackup(config: Config, input: string, output: string, onBytes?: (bytes: number) => void): Promise<{ size: number; sha256: string }> {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', await key(config), iv);
  const hash = createHash('sha256'); let size = 0;
  const counter = new Transform({ transform(chunk, _enc, cb) { size += chunk.length; hash.update(chunk); onBytes?.(size); cb(null, chunk); } });
  const header = Buffer.concat([Buffer.from('AGENTOR-BACKUP-1\n'), iv]);
  await writeFile(output, header, { mode: 0o600 });
  await pipeline(createReadStream(input), cipher, counter, createWriteStream(output, { flags: 'a', mode: 0o600 }));
  const tag = cipher.getAuthTag(); await writeFile(output, tag, { flag: 'a' }); hash.update(tag);
  return { size: header.length + size + tag.length, sha256: hash.digest('hex') };
}

export async function decryptBackup(config: Config, input: string, output: string, expectedSha256: string): Promise<void> {
  return decryptBackupV1WithArchiveKey(input, output, expectedSha256, await key(config));
}

/** Cross-instance adoption of a legacy v1 object has no key identifier in its
 * envelope. Callers may try owner-authorized keyring candidates with this
 * function; AES-GCM authentication, not an error message, decides the match. */
export async function decryptBackupV1WithMaterial(
  input: string,
  output: string,
  expectedSha256: string | undefined,
  material: string,
): Promise<void> {
  return decryptBackupV1WithArchiveKey(
    input,
    output,
    expectedSha256,
    deriveBackupArchiveKey(material),
  );
}

async function decryptBackupV1WithArchiveKey(input: string, output: string, expectedSha256: string | undefined, archiveKey: Buffer): Promise<void> {
  const prefix = Buffer.from('AGENTOR-BACKUP-1\n'); const size=(await stat(input)).size;
  if(size<prefix.length+28)throw new Error('Invalid encrypted backup');
  const header=Buffer.alloc(prefix.length+12),tag=Buffer.alloc(16);
  const fh=await import('node:fs/promises').then(m=>m.open(input,'r'));try{await fh.read(header,0,header.length,0);await fh.read(tag,0,16,size-16);}finally{await fh.close();}
  if(!header.subarray(0,prefix.length).equals(prefix))throw new Error('Invalid encrypted backup');
  const start=header.length,end=size-17;const hash=createHash('sha256');
  await pipeline(createReadStream(input,{start,end}),new Transform({transform(chunk,_e,cb){hash.update(chunk);cb();}}));hash.update(tag);
  if(expectedSha256 && hash.digest('hex')!==expectedSha256)throw new Error('Backup integrity verification failed');
  const decipher=createDecipheriv('aes-256-gcm',archiveKey,header.subarray(prefix.length));decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(input,{start,end}),decipher,createWriteStream(output,{mode:0o600}));
  } catch {
    throw new Error('Backup authentication failed');
  }
}

const V2_PREFIX = Buffer.from('AGENTOR-BACKUP-2\n');
const MAX_V2_HEADER_BYTES = 16 * 1024;
export interface BackupV2RemoteMetadata { backupId?: string; sourceInstallationId?: string; createdAt?: string; workspaceIds?: string[]; formatVersion?: number; }
export interface BackupV2Header { version: 2; algorithm: 'aes-256-gcm'; keyFingerprint: string; metadata: BackupV2RemoteMetadata; }

/** Read bounded untrusted discovery metadata. It becomes authenticated only after decryptBackupV2 succeeds. */
export async function inspectBackupV2(input: string): Promise<BackupV2Header> {
  const handle = await import('node:fs/promises').then((m) => m.open(input, 'r'));
  try {
    const stat = await handle.stat();
    if (stat.size < V2_PREFIX.length + 2 + 12 + 16 || stat.size > Number.MAX_SAFE_INTEGER) throw new Error('Unsupported backup format');
    const bounded = Buffer.alloc(Math.min(MAX_V2_HEADER_BYTES + V2_PREFIX.length, stat.size));
    await handle.read(bounded, 0, bounded.length, 0);
    if (!bounded.subarray(0, V2_PREFIX.length).equals(V2_PREFIX)) throw new Error('Unsupported backup format');
    const end = bounded.indexOf(10, V2_PREFIX.length);
    if (end < 0 || end - V2_PREFIX.length > MAX_V2_HEADER_BYTES || stat.size < end + 1 + 12 + 16) throw new Error('Invalid backup header');
    return validateV2Header(JSON.parse(bounded.subarray(V2_PREFIX.length, end).toString('utf8')));
  } catch (error) { if (error instanceof Error && /Unsupported backup format|Invalid backup header/.test(error.message)) throw error; throw new Error('Invalid backup header'); } finally { await handle.close(); }
}

/** Digest used by persisted artifact records. It intentionally matches the
 * historical encryptBackup return value (ciphertext plus GCM tag), while v2
 * additionally authenticates its clear discovery header as AAD. */
export async function encryptedBackupPayloadSha256(input: string): Promise<string> {
  const size = (await stat(input)).size;
  const prefix = Buffer.alloc(Math.max(V2_PREFIX.length, Buffer.byteLength('AGENTOR-BACKUP-1\n')));
  const handle = await import('node:fs/promises').then((m) => m.open(input, 'r'));
  try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
  let start: number;
  if (prefix.subarray(0, V2_PREFIX.length).equals(V2_PREFIX))
    start = (await readV2Preamble(input)).ciphertextStart;
  else {
    const v1 = Buffer.from('AGENTOR-BACKUP-1\n');
    if (!prefix.subarray(0, v1.length).equals(v1) || size < v1.length + 28)
      throw new Error('Unsupported backup format');
    start = v1.length + 12;
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(input, { start, end: size - 1 }), new Transform({
    transform(chunk, _encoding, callback) { hash.update(chunk); callback(); },
  }));
  return hash.digest('hex');
}

export async function encryptBackupV2(config: Config, ownerId: string, input: string, output: string, metadata: BackupV2RemoteMetadata, keyring = new BackupKeyring(config), onBytes?: (bytes: number) => void): Promise<{ size: number; sha256: string; header: BackupV2Header }> {
  const active = await keyring.active(ownerId);
  const header = validateV2Header({ version: 2, algorithm: 'aes-256-gcm', keyFingerprint: active.fingerprint, metadata });
  const headerBytes = Buffer.from(JSON.stringify(header));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', deriveBackupArchiveKey(active.material), iv);
  const hash = createHash('sha256'); let size = 0;
  cipher.setAAD(Buffer.concat([V2_PREFIX, headerBytes]));
  const counter = new Transform({ transform(chunk, _enc, cb) { size += chunk.length; hash.update(chunk); onBytes?.(size); cb(null, chunk); } });
  await writeFile(output, Buffer.concat([V2_PREFIX, headerBytes, Buffer.from('\n'), iv]), { mode: 0o600 });
  await pipeline(createReadStream(input), cipher, counter, createWriteStream(output, { flags: 'a', mode: 0o600 }));
  const tag = cipher.getAuthTag(); await writeFile(output, tag, { flag: 'a' }); hash.update(tag);
  return { size: V2_PREFIX.length + headerBytes.length + 1 + iv.length + size + tag.length, sha256: hash.digest('hex'), header };
}

export async function decryptBackupV2(config: Config, ownerId: string, input: string, output: string, expectedSha256?: string, keyring = new BackupKeyring(config)): Promise<BackupV2Header> {
  const header = await inspectBackupV2(input); const material = await keyring.find(ownerId, header.keyFingerprint);
  if (!material) throw new Error('Required recovery key is unavailable');
  const size = (await stat(input)).size, raw = await readV2Preamble(input);
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(input, { start: raw.ciphertextStart, end: size - 17 }),
    new Transform({
      // This pass only hashes. Emitting the chunk from the terminal Transform
      // would leave its readable side unconsumed and can deadlock once a
      // backup exceeds the stream high-water mark.
      transform(chunk, _enc, cb) { hash.update(chunk); cb(); },
    }),
  );
  hash.update(raw.tag); const actualSha256 = hash.digest('hex');
  if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error('Backup integrity verification failed');
  const decipher = createDecipheriv('aes-256-gcm', deriveBackupArchiveKey(material), raw.iv);
  decipher.setAAD(raw.aad); decipher.setAuthTag(raw.tag);
  try { await pipeline(createReadStream(input, { start: raw.ciphertextStart, end: size - 17 }), decipher, createWriteStream(output, { mode: 0o600 })); }
  catch { throw new Error('Backup authentication failed'); }
  return header;
}

async function readV2Preamble(input: string) {
  const handle = await import('node:fs/promises').then((m) => m.open(input, 'r'));
  try {
    const size = (await handle.stat()).size, bounded = Buffer.alloc(Math.min(MAX_V2_HEADER_BYTES + V2_PREFIX.length + 1 + 12, size));
    await handle.read(bounded, 0, bounded.length, 0); if (!bounded.subarray(0, V2_PREFIX.length).equals(V2_PREFIX)) throw new Error('Invalid backup header');
    const headerEnd = bounded.indexOf(10, V2_PREFIX.length); if (headerEnd < 0 || headerEnd - V2_PREFIX.length > MAX_V2_HEADER_BYTES || size < headerEnd + 1 + 12 + 16) throw new Error('Invalid backup header');
    const headerBytes = bounded.subarray(V2_PREFIX.length, headerEnd); validateV2Header(JSON.parse(headerBytes.toString('utf8')));
    return { aad: Buffer.concat([V2_PREFIX, headerBytes]), iv: bounded.subarray(headerEnd + 1, headerEnd + 13), tag: await readTag(handle, size), ciphertextStart: headerEnd + 13 };
  } catch (error) { if (error instanceof Error && error.message === 'Invalid backup header') throw error; throw new Error('Invalid backup header'); } finally { await handle.close(); }
}
async function readTag(handle: any, size: number) { const tag = Buffer.alloc(16); await handle.read(tag, 0, 16, size - 16); return tag; }
function validateV2Header(value: any): BackupV2Header {
  const metadata = value?.metadata; const strings = ['backupId', 'sourceInstallationId', 'createdAt'];
  if (!value || value.version !== 2 || value.algorithm !== 'aes-256-gcm' || typeof value.keyFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.keyFingerprint) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid backup header');
  const result: BackupV2RemoteMetadata = {};
  for (const key of strings) if (metadata[key] !== undefined) { if (typeof metadata[key] !== 'string' || Buffer.byteLength(metadata[key]) > 512) throw new Error('Invalid backup header'); (result as any)[key] = metadata[key]; }
  if (metadata.formatVersion !== undefined) { if (!Number.isInteger(metadata.formatVersion) || metadata.formatVersion < 1 || metadata.formatVersion > 1000) throw new Error('Invalid backup header'); result.formatVersion = metadata.formatVersion; }
  if (metadata.workspaceIds !== undefined) { if (!Array.isArray(metadata.workspaceIds) || metadata.workspaceIds.length > 100 || metadata.workspaceIds.some((id: unknown) => typeof id !== 'string' || id.length < 1 || id.length > 200)) throw new Error('Invalid backup header'); result.workspaceIds = [...metadata.workspaceIds]; }
  return { version: 2, algorithm: 'aes-256-gcm', keyFingerprint: value.keyFingerprint, metadata: result };
}
