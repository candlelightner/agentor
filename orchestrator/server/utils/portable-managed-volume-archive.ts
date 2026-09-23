import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";
import {
  PORTABLE_MANAGED_VOLUME_ROOT,
  parsePortableManagedVolumeEntries,
  type PortableManagedVolumeEntry,
} from "./portable-managed-volume-format";

export const MAX_PORTABLE_MANAGED_VOLUME_ARCHIVE_ENTRIES = 1_000_000;
export const MAX_PORTABLE_MANAGED_VOLUME_EXPANDED_BYTES = 100 * 1024 * 1024 * 1024;
/** Raw inner tar bytes may be highly compressible, so retain the independent
 * 100 GiB aggregate/expanded ceiling below. The completed gzip member must fit
 * the worker bundle's 20 GiB per-member import boundary. */
export const MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_PORTABLE_PAX_BYTES = 64 * 1024;
const MAX_PORTABLE_TAR_PATH_BYTES = 4096;
const MAX_TAR_END_BLOCKS = 20;

export interface PortableManagedVolumeArchiveLimits {
  maxEntries?: number;
  maxExpandedBytes?: number;
  /** Original, unchanged mount target. Required to retain confined absolute symlinks. */
  target?: string;
  signal?: AbortSignal;
}

export interface PortableManagedVolumeArchiveSummary {
  entries: number;
  expandedBytes: number;
}

interface RawTarEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "hardlink";
  size: number;
  linkName?: string;
  headerOffset: number;
  dataOffset: number;
}

interface RawTarScan {
  entries: RawTarEntry[];
  expandedBytes: number;
}

/** Validate the exact raw tar dialect accepted for a portable volume. */
export async function validatePortableManagedVolumeArchive(
  archivePath: string,
  limits: PortableManagedVolumeArchiveLimits = {},
): Promise<PortableManagedVolumeArchiveSummary> {
  const scan = await scanRawTar(archivePath, {
    maxEntries: limits.maxEntries ?? MAX_PORTABLE_MANAGED_VOLUME_ARCHIVE_ENTRIES,
    maxExpandedBytes: limits.maxExpandedBytes ?? MAX_PORTABLE_MANAGED_VOLUME_EXPANDED_BYTES,
    allowPortablePax: true,
    signal: limits.signal,
  });
  validateInnerEntries(scan.entries, limits.target);
  return { entries: scan.entries.length, expandedBytes: scan.expandedBytes };
}

export async function writePortableManagedVolumePayload(
  items: Array<{ entry: PortableManagedVolumeEntry; archivePath: string }>,
  outputPath: string,
  options: {
    signal?: AbortSignal;
    /** Optional stricter caller ceiling; never raises the production maximum. */
    maxCompressedBytes?: number;
  } = {},
): Promise<{ bytes: number }> {
  const entries = parsePortableManagedVolumeEntries(items.map((item) => item.entry));
  if (entries.length !== items.length) throw invalidArchive("payload item mismatch");
  const sizes: number[] = [];
  let aggregateBytes = 0;
  let outerTarBytes = 1024;
  for (const item of items) {
    throwIfAborted(options.signal);
    const info = await requireRegularFile(item.archivePath);
    aggregateBytes += info.size;
    outerTarBytes += 512 + Math.ceil(info.size / 512) * 512;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES ||
        !Number.isSafeInteger(outerTarBytes) || outerTarBytes > payloadContainerLimit(items.length))
      throw invalidArchive("managed-volume payload exceeds the aggregate size limit");
    sizes.push(info.size);
    await validatePortableManagedVolumeArchive(item.archivePath, {
      target: item.entry.target,
      signal: options.signal,
    });
  }

  const pack = tar.pack();
  const outputByteLimit = compressedPayloadLimit(
    items.length,
    options.maxCompressedBytes,
  );
  const output = createWriteStream(outputPath, { mode: 0o600 });
  let outputBytes = 0;
  const outputLimit = new Transform({
    transform(chunk, _encoding, callback) {
      outputBytes += Buffer.byteLength(chunk);
      callback(outputBytes > outputByteLimit
        ? invalidArchive("compressed managed-volume payload exceeds the size limit")
        : null, chunk);
    },
  });
  const writing = pipeline(pack, createGzip(), outputLimit, output, { signal: options.signal });
  try {
    for (let index = 0; index < items.length; index += 1) {
      throwIfAborted(options.signal);
      const item = items[index]!;
      const destination = pack.entry({
        name: entries[index]!.archive,
        type: "file",
        size: sizes[index]!,
        mode: 0o600,
        uid: 0,
        gid: 0,
        mtime: new Date(0),
      });
      await pipeline(createReadStream(item.archivePath), destination, { signal: options.signal });
    }
    pack.finalize();
    await writing;
    return { bytes: (await stat(outputPath)).size };
  } catch (error) {
    pack.destroy(error instanceof Error ? error : new Error(String(error)));
    await writing.catch(() => {});
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function validateAndExtractPortableManagedVolumePayload(
  payloadPath: string,
  entriesInput: PortableManagedVolumeEntry[],
  destination: string,
  options: {
    signal?: AbortSignal;
    /** Optional stricter caller ceiling; never raises the production maximum. */
    maxCompressedBytes?: number;
  } = {},
): Promise<Array<{ entry: PortableManagedVolumeEntry; archivePath: string }>> {
  const entries = parsePortableManagedVolumeEntries(entriesInput);
  const payloadInfo = await requireRegularFile(payloadPath);
  if (payloadInfo.size > compressedPayloadLimit(entries.length, options.maxCompressedBytes))
    throw invalidArchive("compressed managed-volume payload exceeds the size limit");
  await prepareEmptyDestination(destination);
  const rawPayload = join(destination, ".managed-volumes.payload.tar");
  const volumeDirectory = join(destination, "volumes");
  let createdVolumeDirectory = false;
  try {
    let expanded = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        expanded += Buffer.byteLength(chunk);
        callback(expanded > payloadContainerLimit(entries.length)
          ? invalidArchive("managed-volume payload exceeds the size limit")
          : null, chunk);
      },
    });
    await pipeline(
      createReadStream(payloadPath),
      createGunzip(),
      counter,
      createWriteStream(rawPayload, { mode: 0o600, flags: "wx" }),
      { signal: options.signal },
    );

    const scan = await scanRawTar(rawPayload, {
      maxEntries: entries.length,
      maxExpandedBytes: MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES,
      allowPortablePax: false,
      signal: options.signal,
    });
    validateOuterEntries(scan.entries, entries);
    await mkdir(volumeDirectory, { mode: 0o700 });
    createdVolumeDirectory = true;

    const extracted: Array<{ entry: PortableManagedVolumeEntry; archivePath: string }> = [];
    for (let index = 0; index < scan.entries.length; index += 1) {
      throwIfAborted(options.signal);
      const rawEntry = scan.entries[index]!;
      const entry = entries[index]!;
      const archivePath = join(destination, ...entry.archive.split("/"));
      await pipeline(
        createReadStream(rawPayload, {
          start: rawEntry.dataOffset,
          end: rawEntry.size === 0 ? rawEntry.dataOffset - 1 : rawEntry.dataOffset + rawEntry.size - 1,
        }),
        createWriteStream(archivePath, { mode: 0o600, flags: "wx" }),
        { signal: options.signal },
      );
      await validatePortableManagedVolumeArchive(archivePath, {
        target: entry.target,
        signal: options.signal,
      });
      extracted.push({ entry, archivePath });
    }
    await rm(rawPayload, { force: true });
    return extracted;
  } catch (error) {
    await rm(rawPayload, { force: true }).catch(() => {});
    if (createdVolumeDirectory)
      await rm(volumeDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function scanRawTar(
  archivePath: string,
  options: { maxEntries: number; maxExpandedBytes: number; allowPortablePax: boolean; signal?: AbortSignal },
): Promise<RawTarScan> {
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0 ||
      !Number.isSafeInteger(options.maxExpandedBytes) || options.maxExpandedBytes < 0)
    throw new Error("Invalid portable managed-volume archive limits");
  const info = await requireRegularFile(archivePath);
  const metadataAllowance = Math.min(
    options.maxEntries * (MAX_PORTABLE_PAX_BYTES + 1536),
    1024 * 1024 * 1024,
  );
  const rawLimit = options.maxExpandedBytes + metadataAllowance + MAX_TAR_END_BLOCKS * 512;
  if (!Number.isSafeInteger(rawLimit) || info.size > rawLimit)
    throw invalidArchive("raw archive exceeds the size limit");
  const handle = await open(archivePath, "r");
  const entries: RawTarEntry[] = [];
  let offset = 0;
  let expandedBytes = 0;
  let zeroBlocks = 0;
  let pendingPax: Record<string, string> | undefined;
  try {
    while (offset < info.size) {
      throwIfAborted(options.signal);
      const block = Buffer.alloc(512);
      const { bytesRead } = await handle.read(block, 0, block.length, offset);
      if (bytesRead !== 512) throw invalidArchive("truncated tar header");
      if (block.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        offset += 512;
        if (zeroBlocks >= 2) break;
        continue;
      }
      if (zeroBlocks !== 0) throw invalidArchive("non-zero data after tar end marker");
      verifyChecksum(block);
      const name = readTarPath(block, 0, 100, block, 345, 155);
      const size = readTarNumber(block, 124, 12, "size");
      const typeFlag = block[156] ?? 0;
      const dataOffset = offset + 512;
      const padded = Math.ceil(size / 512) * 512;
      if (!Number.isSafeInteger(padded) || dataOffset + padded > info.size)
        throw invalidArchive("truncated tar entry");
      if (typeFlag === 120) {
        if (!options.allowPortablePax || pendingPax || size > MAX_PORTABLE_PAX_BYTES)
          throw invalidArchive("archive contains unsupported PAX metadata");
        const body = Buffer.alloc(size);
        const { bytesRead: paxBytesRead } = await handle.read(body, 0, size, dataOffset);
        if (paxBytesRead !== size) throw invalidArchive("truncated PAX metadata");
        pendingPax = parsePortablePax(body);
        offset = dataOffset + padded;
        continue;
      }
      const type = parseType(typeFlag);
      const effectiveName = pendingPax?.path ?? name;
      const linkName = type === "symlink" || type === "hardlink"
        ? pendingPax?.linkpath ?? readTarString(block, 157, 100)
        : undefined;
      if (pendingPax?.linkpath !== undefined && type !== "symlink" && type !== "hardlink")
        throw invalidArchive("PAX linkpath applies to a non-link entry");
      pendingPax = undefined;
      // Parse all numeric identity/mode fields strictly even though the values
      // are preserved verbatim for Docker rather than interpreted here.
      readTarNumber(block, 100, 8, "mode");
      readTarNumber(block, 108, 8, "uid");
      readTarNumber(block, 116, 8, "gid");
      readTarNumber(block, 136, 12, "mtime");
      if (type !== "file" && size !== 0) throw invalidArchive("non-file tar entry has data");
      expandedBytes += size;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > options.maxExpandedBytes)
        throw invalidArchive("archive exceeds the expanded size limit");
      if (entries.length >= options.maxEntries)
        throw invalidArchive("archive contains too many entries");
      entries.push({ name: effectiveName, type, size, linkName, headerOffset: offset, dataOffset });
      offset = dataOffset + padded;
    }
    if (zeroBlocks < 2) throw invalidArchive("tar is missing its end marker");
    if (pendingPax) throw invalidArchive("PAX metadata is missing its target entry");
    const trailingStart = offset;
    if (info.size - trailingStart > (MAX_TAR_END_BLOCKS - 2) * 512)
      throw invalidArchive("tar contains excessive trailing zero blocks");
    while (offset < info.size) {
      throwIfAborted(options.signal);
      const length = Math.min(64 * 1024, info.size - offset);
      const trailing = Buffer.alloc(length);
      const { bytesRead } = await handle.read(trailing, 0, length, offset);
      if (bytesRead !== length || !trailing.every((byte) => byte === 0))
        throw invalidArchive("tar contains data after its end marker");
      offset += length;
    }
    return { entries, expandedBytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
  } finally {
    await handle.close();
  }
}

function validateInnerEntries(entries: RawTarEntry[], target?: string): void {
  const paths = new Map<string, RawTarEntry["type"]>();
  const regularFiles = new Set<string>();
  let rootSeen = false;
  for (const entry of entries) {
    const name = canonicalInnerName(entry.name, entry.type);
    const bareName = stripDirectorySlash(name);
    if (paths.has(bareName)) throw invalidArchive("archive contains a duplicate or type-conflicting path");
    paths.set(bareName, entry.type);
    if (name === PORTABLE_MANAGED_VOLUME_ROOT) {
      if (entry.type !== "directory") throw invalidArchive("volume root must be a directory");
      rootSeen = true;
    }
    if (entry.type === "symlink") {
      validateSymlink(name, entry.linkName!, target);
    } else if (entry.type === "hardlink") {
      const target = canonicalLinkTarget(entry.linkName!);
      if (!regularFiles.has(target))
        throw invalidArchive("hardlink must target an earlier regular file");
    } else if (entry.type === "file") {
      regularFiles.add(name);
    }
  }
  if (!rootSeen) throw invalidArchive("archive is missing the volume/ root directory");
  for (const [ancestor, type] of paths) {
    if (type === "directory") continue;
    for (const path of paths.keys()) {
      if (path.startsWith(`${ancestor}/`))
        throw invalidArchive("archive writes below an explicit non-directory path");
    }
  }
}

function validateOuterEntries(entries: RawTarEntry[], expected: PortableManagedVolumeEntry[]): void {
  if (entries.length !== expected.length) throw invalidArchive("payload members do not match the manifest");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "file" || entry.name !== expected[index]!.archive)
      throw invalidArchive("payload members do not match the manifest");
  }
}

function canonicalInnerName(name: string, type: RawTarEntry["type"]): string {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") ||
      name.startsWith("./") || Buffer.byteLength(name) > MAX_PORTABLE_TAR_PATH_BYTES ||
      name.split("/").includes(".."))
    throw invalidArchive("archive contains an unsafe path");
  const directory = type === "directory";
  const bare = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  if (!bare || posix.normalize(bare) !== bare || (!directory && name.endsWith("/")))
    throw invalidArchive("archive contains a non-canonical path");
  const canonical = directory ? `${bare}/` : bare;
  if (canonical !== PORTABLE_MANAGED_VOLUME_ROOT && !canonical.startsWith(PORTABLE_MANAGED_VOLUME_ROOT))
    throw invalidArchive("archive path is outside volume/");
  return canonical;
}

function validateSymlink(name: string, linkTarget: string, mountTarget?: string): void {
  if (!linkTarget || linkTarget.includes("\0") || linkTarget.includes("\\") ||
      Buffer.byteLength(linkTarget) > MAX_PORTABLE_TAR_PATH_BYTES)
    throw invalidArchive("archive contains an unsafe symlink");
  if (linkTarget.startsWith("/")) {
    if (!mountTarget || mountTarget === "/" || posix.normalize(linkTarget) !== linkTarget ||
        (linkTarget !== mountTarget && !linkTarget.startsWith(`${mountTarget}/`)))
      throw invalidArchive("archive absolute symlink escapes its unchanged target");
    return;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(stripDirectorySlash(name)), linkTarget));
  if (resolved !== "volume" && !resolved.startsWith("volume/"))
    throw invalidArchive("archive symlink escapes volume/");
}

function canonicalLinkTarget(target: string): string {
  if (!target || target.includes("\0") || target.includes("\\") || target.startsWith("/") ||
      target.endsWith("/") || target.startsWith("./") || target.split("/").includes("..") ||
      Buffer.byteLength(target) > MAX_PORTABLE_TAR_PATH_BYTES ||
      posix.normalize(target) !== target || !target.startsWith(PORTABLE_MANAGED_VOLUME_ROOT))
    throw invalidArchive("archive contains an unsafe hardlink");
  return target;
}

function parseType(value: number): RawTarEntry["type"] {
  if (value === 0 || value === 48) return "file";
  if (value === 53) return "directory";
  if (value === 50) return "symlink";
  if (value === 49) return "hardlink";
  // This explicitly rejects devices, FIFOs, GNU long names/links, sparse
  // records and global PAX headers. A bounded per-file PAX allowlist is
  // consumed before this point solely for path/linkpath fidelity.
  throw invalidArchive("archive contains an unsupported tar entry type");
}

function parsePortablePax(body: Buffer): Record<string, string> {
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw invalidArchive("PAX record length is invalid");
    const lengthText = body.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw invalidArchive("PAX record length is invalid");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > body.length || body[end - 1] !== 0x0a)
      throw invalidArchive("PAX record is truncated");
    const record = body.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw invalidArchive("PAX record is invalid");
    const key = record.subarray(0, equals).toString("ascii");
    if (key !== "path" && key !== "linkpath")
      throw invalidArchive("PAX metadata key is not allowed");
    if (Object.prototype.hasOwnProperty.call(values, key))
      throw invalidArchive("PAX metadata contains a duplicate key");
    const rawValue = record.subarray(equals + 1);
    const value = rawValue.toString("utf8");
    if (!value || Buffer.from(value, "utf8").compare(rawValue) !== 0 ||
        /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value) > MAX_PORTABLE_TAR_PATH_BYTES)
      throw invalidArchive("PAX path metadata is invalid");
    values[key] = value;
    offset = end;
  }
  if (Object.keys(values).length === 0) throw invalidArchive("PAX metadata is empty");
  return values;
}

function verifyChecksum(block: Buffer): void {
  const expected = readTarNumber(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < block.length; index += 1)
    actual += index >= 148 && index < 156 ? 32 : block[index]!;
  if (expected !== actual) throw invalidArchive("tar header checksum is invalid");
}

function readTarPath(
  nameBlock: Buffer, nameOffset: number, nameLength: number,
  prefixBlock: Buffer, prefixOffset: number, prefixLength: number,
): string {
  const name = readTarString(nameBlock, nameOffset, nameLength);
  const prefix = readTarString(prefixBlock, prefixOffset, prefixLength);
  if (!name) throw invalidArchive("tar entry has no name");
  return prefix ? `${prefix}/${name}` : name;
}

function readTarString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const bytes = nul < 0 ? field : field.subarray(0, nul);
  if (nul >= 0 && field.subarray(nul).some((byte) => byte !== 0))
    throw invalidArchive("tar string field has data after NUL");
  const value = bytes.toString("utf8");
  if (Buffer.from(value, "utf8").compare(bytes) !== 0 || /[\u0000-\u001f\u007f]/.test(value))
    throw invalidArchive("tar string field is invalid");
  return value;
}

function readTarNumber(block: Buffer, offset: number, length: number, fieldName: string): number {
  const field = block.subarray(offset, offset + length);
  if (field[0]! & 0x80) {
    const copy = Buffer.from(field);
    const negative = (copy[0]! & 0x40) !== 0;
    copy[0] = copy[0]! & 0x7f;
    let value = 0n;
    for (const byte of copy) value = value * 256n + BigInt(byte);
    if (negative) throw invalidArchive(`tar ${fieldName} is negative`);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidArchive(`tar ${fieldName} is too large`);
    return Number(value);
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) throw invalidArchive(`tar ${fieldName} is invalid`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw invalidArchive(`tar ${fieldName} is too large`);
  return value;
}

async function requireRegularFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw invalidArchive("archive input must be a regular file");
  return info;
}

async function prepareEmptyDestination(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalidArchive("extraction destination must be a directory");
  if ((await readdir(destination)).length !== 0) throw invalidArchive("extraction destination must be empty");
}

function payloadContainerLimit(memberCount: number): number {
  return MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES +
    (memberCount * 2 + MAX_TAR_END_BLOCKS) * 512;
}

function compressedPayloadLimit(memberCount: number, stricterLimit?: number): number {
  if (
    stricterLimit !== undefined &&
    (!Number.isSafeInteger(stricterLimit) || stricterLimit <= 0)
  )
    throw new Error("Invalid portable managed-volume compressed payload limit");
  const raw = payloadContainerLimit(memberCount);
  // RFC 1951 stored blocks can add five bytes per 16 KiB, plus a small gzip
  // wrapper/trailer. Keep that framing calculation distinct from the worker
  // bundle's per-member cap: large but sufficiently compressible raw payloads
  // remain valid, while the writer can never publish an unimportable member.
  return Math.min(
    raw + Math.ceil(raw / 16_384) * 5 + 64,
    MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES,
    stricterLimit ?? Number.MAX_SAFE_INTEGER,
  );
}

function stripDirectorySlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function invalidArchive(detail: string): Error {
  return new Error(`Invalid portable managed-volume archive: ${detail}`);
}
