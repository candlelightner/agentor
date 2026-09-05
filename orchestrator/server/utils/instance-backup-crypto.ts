import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { backupKeyFingerprint } from "./backup-keyring";

const PREFIX = Buffer.from("AGENTOR-INSTANCE-BACKUP-1\n");
const MAX_HEADER_BYTES = 16 * 1024;

export interface InstanceBackupHeader {
  version: 1;
  algorithm: "aes-256-gcm";
  keyFingerprint: string;
  metadata: {
    backupId: string;
    sourceInstallationId: string;
    createdAt: string;
    formatVersion: 1;
  };
}

function archiveKey(material: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(material),
      Buffer.from("agentor-instance-backups-v1"),
      Buffer.from("archive-key"),
      32,
    ),
  );
}

export async function encryptInstanceBackup(
  input: string,
  output: string,
  material: string,
  metadata: InstanceBackupHeader["metadata"],
  onBytes?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string; header: InstanceBackupHeader }> {
  signal?.throwIfAborted();
  const header = validateInstanceBackupHeader({
    version: 1,
    algorithm: "aes-256-gcm",
    keyFingerprint: backupKeyFingerprint(material),
    metadata,
  });
  const headerBytes = Buffer.from(JSON.stringify(header));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", archiveKey(material), iv);
  cipher.setAAD(Buffer.concat([PREFIX, headerBytes]));
  const hash = createHash("sha256");
  let encryptedBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      encryptedBytes += chunk.length;
      hash.update(chunk);
      onBytes?.(encryptedBytes);
      callback(null, chunk);
    },
  });
  try {
    await writeFile(
      output,
      Buffer.concat([PREFIX, headerBytes, Buffer.from("\n"), iv]),
      { mode: 0o600 },
    );
    await pipeline(
      createReadStream(input),
      cipher,
      counter,
      createWriteStream(output, { flags: "a", mode: 0o600 }),
      signal ? { signal } : {},
    );
    signal?.throwIfAborted();
    const tag = cipher.getAuthTag();
    await writeFile(output, tag, { flag: "a" });
    hash.update(tag);
    return {
      size: PREFIX.length + headerBytes.length + 1 + iv.length + encryptedBytes + tag.length,
      sha256: hash.digest("hex"),
      header,
    };
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    throw error;
  }
}

export async function inspectInstanceBackup(
  input: string,
): Promise<InstanceBackupHeader> {
  return (await readPreamble(input)).header;
}

/** Parse only the bounded discovery preamble returned by a provider range
 * request. No integrity decision is made until the complete object is adopted. */
export function inspectInstanceBackupPrefix(
  input: Buffer,
): InstanceBackupHeader {
  if (input.length < PREFIX.length + 2 + 12)
    throw new Error("Unsupported instance backup format");
  if (!input.subarray(0, PREFIX.length).equals(PREFIX))
    throw new Error("Unsupported instance backup format");
  const end = input.indexOf(10, PREFIX.length);
  if (
    end < 0 ||
    end - PREFIX.length > MAX_HEADER_BYTES ||
    input.length < end + 1 + 12
  )
    throw new Error("Invalid instance backup header");
  try {
    return validateInstanceBackupHeader(
      JSON.parse(input.subarray(PREFIX.length, end).toString("utf8")),
    );
  } catch {
    throw new Error("Invalid instance backup header");
  }
}

export async function encryptedInstancePayloadSha256(
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const preamble = await readPreamble(input);
  const size = (await stat(input)).size;
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(input, {
      start: preamble.ciphertextStart,
      end: size - 1,
    }),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
    signal ? { signal } : {},
  );
  return hash.digest("hex");
}

export async function decryptInstanceBackup(
  input: string,
  output: string,
  material: string,
  expectedSha256?: string,
  signal?: AbortSignal,
): Promise<InstanceBackupHeader> {
  signal?.throwIfAborted();
  const preamble = await readPreamble(input);
  if (backupKeyFingerprint(material) !== preamble.header.keyFingerprint)
    throw new Error("Required recovery key is unavailable");
  const size = (await stat(input)).size;
  const actualSha256 = await encryptedInstancePayloadSha256(input, signal);
  if (expectedSha256 && actualSha256 !== expectedSha256)
    throw new Error("Instance backup integrity verification failed");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    archiveKey(material),
    preamble.iv,
  );
  decipher.setAAD(preamble.aad);
  decipher.setAuthTag(preamble.tag);
  try {
    await pipeline(
      createReadStream(input, {
        start: preamble.ciphertextStart,
        end: size - 17,
      }),
      decipher,
      createWriteStream(output, { mode: 0o600 }),
      signal ? { signal } : {},
    );
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new Error("Instance backup authentication failed");
  }
  return preamble.header;
}

async function readPreamble(input: string): Promise<{
  header: InstanceBackupHeader;
  aad: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertextStart: number;
}> {
  const handle = await open(input, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < PREFIX.length + 2 + 12 + 16)
      throw new Error("Unsupported instance backup format");
    const bounded = Buffer.alloc(
      Math.min(size, PREFIX.length + MAX_HEADER_BYTES + 1 + 12),
    );
    await handle.read(bounded, 0, bounded.length, 0);
    if (!bounded.subarray(0, PREFIX.length).equals(PREFIX))
      throw new Error("Unsupported instance backup format");
    const end = bounded.indexOf(10, PREFIX.length);
    if (
      end < 0 ||
      end - PREFIX.length > MAX_HEADER_BYTES ||
      size < end + 1 + 12 + 16
    )
      throw new Error("Invalid instance backup header");
    const headerBytes = bounded.subarray(PREFIX.length, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      throw new Error("Invalid instance backup header");
    }
    const header = validateInstanceBackupHeader(parsed);
    const tag = Buffer.alloc(16);
    await handle.read(tag, 0, tag.length, size - tag.length);
    return {
      header,
      aad: Buffer.concat([PREFIX, headerBytes]),
      iv: bounded.subarray(end + 1, end + 13),
      tag,
      ciphertextStart: end + 13,
    };
  } finally {
    await handle.close();
  }
}

function validateInstanceBackupHeader(value: unknown): InstanceBackupHeader {
  const input = value as any;
  const metadata = input?.metadata;
  if (
    !input ||
    input.version !== 1 ||
    input.algorithm !== "aes-256-gcm" ||
    typeof input.keyFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(input.keyFingerprint) ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.formatVersion !== 1 ||
    !bounded(metadata.backupId, 200) ||
    !bounded(metadata.sourceInstallationId, 200) ||
    !bounded(metadata.createdAt, 64) ||
    !Number.isFinite(Date.parse(metadata.createdAt))
  )
    throw new Error("Invalid instance backup header");
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyFingerprint: input.keyFingerprint,
    metadata: {
      backupId: metadata.backupId,
      sourceInstallationId: metadata.sourceInstallationId,
      createdAt: metadata.createdAt,
      formatVersion: 1,
    },
  };
}

function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max
  );
}
