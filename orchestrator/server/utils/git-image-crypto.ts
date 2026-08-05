import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface GitImageCiphertext { version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string }

let cachedKey: Promise<Buffer> | undefined;

async function loadKey(): Promise<Buffer> {
  const configured = process.env.GIT_IMAGE_CATALOG_ENCRYPTION_KEY?.trim();
  if (configured) {
    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32) throw new Error('GIT_IMAGE_CATALOG_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    return key;
  }
  const path = join(process.env.DATA_DIR || '/data', 'git-image-catalog.key');
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Git image catalog key must be a regular file');
      if ((stat.mode & 0o077) !== 0) throw new Error('Git image catalog key permissions must be 0600');
      const key = await handle.readFile();
      if (key.length !== 32) throw new Error('Git image catalog key has an invalid length');
      return key;
    } finally { await handle.close(); }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const key = randomBytes(32);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
  return key;
}

function key() { return (cachedKey ??= loadKey()); }
export function gitImageCredentialAad(ownerId: string, connectionId: string, kind: string) {
  return `agentor:git-image-catalog:v1:${ownerId}:${connectionId}:${kind}`;
}
export async function encryptGitImageCredential(value: string, aad: string): Promise<GitImageCiphertext> {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', await key(), iv); cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export async function decryptGitImageCredential(value: GitImageCiphertext, aad: string): Promise<string> {
  if (value?.version !== 1 || value.algorithm !== 'aes-256-gcm') throw new Error('Unsupported Git image credential format');
  const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(value.iv, 'base64')); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
