import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import type { Config } from './config';

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
  const prefix = Buffer.from('AGENTOR-BACKUP-1\n'); const size=(await stat(input)).size;
  if(size<prefix.length+28)throw new Error('Invalid encrypted backup');
  const header=Buffer.alloc(prefix.length+12),tag=Buffer.alloc(16);
  const fh=await import('node:fs/promises').then(m=>m.open(input,'r'));try{await fh.read(header,0,header.length,0);await fh.read(tag,0,16,size-16);}finally{await fh.close();}
  if(!header.subarray(0,prefix.length).equals(prefix))throw new Error('Invalid encrypted backup');
  const start=header.length,end=size-17;const hash=createHash('sha256');
  await pipeline(createReadStream(input,{start,end}),new Transform({transform(chunk,_e,cb){hash.update(chunk);cb();}}));hash.update(tag);
  if(hash.digest('hex')!==expectedSha256)throw new Error('Backup integrity verification failed');
  const decipher=createDecipheriv('aes-256-gcm',await key(config),header.subarray(prefix.length));decipher.setAuthTag(tag);
  await pipeline(createReadStream(input,{start,end}),decipher,createWriteStream(output,{mode:0o600}));
}
