import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config';

export interface EncryptedWorkerValue {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

async function keyMaterial(config: Config): Promise<Buffer> {
  const path = join(config.dataDir, 'worker-config.key');
  let secret = process.env.WORKER_CONFIG_ENCRYPTION_KEY?.trim() || '';
  if (secret) {
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length !== 32) throw new Error('WORKER_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    return Buffer.from(hkdfSync('sha256', decoded, Buffer.from('agentor-worker-config-v1'), Buffer.from('encryption-key'), 32));
  }
  try { secret = (await readFile(path, 'utf8')).trim(); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const generated = randomBytes(32).toString('base64');
    try { await writeFile(path, `${generated}\n`, { mode: 0o600, flag: 'wx' }); secret = generated; }
    catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code !== 'EEXIST') throw writeErr;
      secret = (await readFile(path, 'utf8')).trim();
    }
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Worker secret encryption key must be a regular non-symlink file');
  await chmod(path, 0o600);
  const decoded = Buffer.from(secret, 'base64');
  if (decoded.length !== 32) throw new Error('Worker secret encryption key is invalid');
  return Buffer.from(hkdfSync('sha256', decoded, Buffer.from('agentor-worker-config-v1'), Buffer.from('encryption-key'), 32));
}

export async function encryptWorkerValue(config: Config, plaintext: string, aad: string): Promise<EncryptedWorkerValue> {
  const key = await keyMaterial(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export async function decryptWorkerValue(config: Config, value: EncryptedWorkerValue, aad: string): Promise<string> {
  if (value.version !== 1 || value.algorithm !== 'aes-256-gcm') throw new Error('Unsupported worker secret encryption format');
  const decipher = createDecipheriv('aes-256-gcm', await keyMaterial(config), Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
