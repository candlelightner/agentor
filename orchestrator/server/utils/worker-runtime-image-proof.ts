import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/** Identity that survives a Docker save/load without relying on mutable tags. */
export interface PortableImageIdentity {
  version: 1;
  configDigest: string;
  platform: { os: string; architecture: string; variant?: string };
}

export interface ImageProofLimits {
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxMetadataBytes?: number;
  maxMetadataTotalBytes?: number;
  maxExpandedBytes?: number;
  maxDurationMs?: number;
}

export interface ImageProofOptions {
  signal?: AbortSignal;
  /** May only tighten the built-in ceilings. */
  limits?: ImageProofLimits;
}

const MAX_ARCHIVE_BYTES = 100 * 1024 ** 3;
const MAX_ENTRIES = 100_000;
const MAX_METADATA_BYTES = 2 * 1024 ** 2;
const MAX_METADATA_TOTAL_BYTES = 64 * 1024 ** 2;
const MAX_EXPANDED_BYTES = 100 * 1024 ** 3;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_TRAILER_BYTES = 20 * 512;
const SHA = /^sha256:[a-f0-9]{64}$/;
const BLOB = /^blobs\/sha256\/([a-f0-9]{64})$/;
const CLASSIC_CONFIG = /^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/;

interface Entry { size: number; digest: string; type: "file" | "directory"; metadata?: Buffer; expandedDigest?: string }
interface Leaf { configDigest: string; layerDigests: string[]; platform: PortableImageIdentity["platform"]; graphDigests: string[] }

function invalid(message: string): Error {
  return new Error(`Invalid Docker image archive: ${message}`);
}

function limit(value: number | undefined, ceiling: number, label: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw invalid(`invalid ${label} limit`);
  return value;
}

class TarReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;
  bytes = 0;

  constructor(stream: Readable, private readonly maxBytes: number, private readonly check: () => void) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async read(size: number, onChunk?: (chunk: Buffer) => void | Promise<void>): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      this.check();
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        this.check();
        if (next.done) throw invalid("truncated tar archive");
        if (!Buffer.isBuffer(next.value)) throw invalid("non-binary tar stream");
        this.chunk = next.value;
        this.offset = 0;
        if (this.chunk.length === 0) continue;
      }
      const count = Math.min(remaining, this.chunk.length - this.offset);
      this.bytes += count;
      if (this.bytes > this.maxBytes) throw invalid("archive byte limit exceeded");
      const part = this.chunk.subarray(this.offset, this.offset + count);
      await onChunk?.(part);
      this.offset += count;
      remaining -= count;
    }
  }

  async block(): Promise<Buffer> {
    const block = Buffer.allocUnsafe(512);
    let at = 0;
    await this.read(512, (chunk) => { chunk.copy(block, at); at += chunk.length; });
    return block;
  }

  async trailer(): Promise<void> {
    let total = 0;
    const check = (chunk: Buffer) => {
      this.check();
      total += chunk.length;
      this.bytes += chunk.length;
      if (total > MAX_TRAILER_BYTES || this.bytes > this.maxBytes) throw invalid("excess tar trailer");
      if (chunk.some((byte) => byte !== 0)) throw invalid("nonzero tar trailer");
    };
    if (this.offset < this.chunk.length) check(this.chunk.subarray(this.offset));
    for (;;) {
      const next = await this.iterator.next();
      if (next.done) return;
      if (!Buffer.isBuffer(next.value)) throw invalid("non-binary tar stream");
      check(next.value);
    }
  }
}

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  const value = raw.subarray(0, end < 0 ? raw.length : end);
  if (value.includes(0) || value.some((byte) => byte > 0x7e || (byte < 0x20 && byte !== 0x09)))
    throw invalid("nonportable tar header text");
  return value.toString("ascii");
}

function octal(block: Buffer, offset: number, length: number): number {
  const value = field(block, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw invalid("non-octal tar header value");
  const result = parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw invalid("tar header value overflow");
  return result;
}

function header(block: Buffer): { name: string; size: number; type: "file" | "directory" } {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  if (stored !== sum) throw invalid("tar header checksum mismatch");
  const magic = field(block, 257, 6);
  if (magic && magic !== "ustar") throw invalid("unsupported tar format");
  const prefix = field(block, 345, 155);
  const plain = field(block, 0, 100);
  const name = prefix ? `${prefix}/${plain}` : plain;
  const components = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  if (!name || name.startsWith("/") || name.startsWith("./") || name.includes("\\") ||
      components.some((part) => part === "" || part === "." || part === "..") ||
      name.length > 255) throw invalid("unsafe tar path");
  const size = octal(block, 124, 12);
  const kind = block[156];
  if (kind === 53) {
    if (size !== 0 || !name.endsWith("/")) throw invalid("invalid tar directory");
    return { name, size, type: "directory" };
  }
  if (kind !== 0 && kind !== 48) throw invalid("unsupported tar entry type");
  if (name.endsWith("/")) throw invalid("file path ends in slash");
  return { name, size, type: "file" };
}

function looksLikeTarHeader(block: Buffer): boolean {
  try { header(block); return true; } catch { return false; }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max = MAX_ENTRIES): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(`${label} is not a bounded array`);
  return value;
}

function json(bytes: Buffer | undefined, label: string): Record<string, unknown> | unknown[] {
  if (!bytes) throw invalid(`${label} metadata missing or too large`);
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("non-object JSON");
    return parsed as Record<string, unknown> | unknown[];
  } catch { throw invalid(`malformed ${label} JSON`); }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw invalid(`invalid ${label} digest`);
  return value;
}

function platform(config: Record<string, unknown>): PortableImageIdentity["platform"] {
  const os = config.os;
  const architecture = config.architecture;
  const variant = config.variant;
  if (typeof os !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(os) ||
      typeof architecture !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(architecture) ||
      (variant !== undefined && (typeof variant !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(variant))))
    throw invalid("invalid image config platform");
  return { os, architecture, ...(variant === undefined ? {} : { variant }) };
}

function equalPlatform(a: PortableImageIdentity["platform"], b: PortableImageIdentity["platform"]): boolean {
  return a.os === b.os && a.architecture === b.architecture && a.variant === b.variant;
}

function requiredEntry(entries: Map<string, Entry>, name: string, expectedSize?: number): Entry {
  const found = entries.get(name);
  if (!found || found.type !== "file" || (expectedSize !== undefined && found.size !== expectedSize))
    throw invalid(`missing or mis-sized referenced entry ${name}`);
  return found;
}

function descriptor(input: unknown, label: string): { mediaType: string; digest: string; size: number; platform?: PortableImageIdentity["platform"] } {
  const value = object(input, label);
  if (typeof value.mediaType !== "string" || value.mediaType.length > 128 ||
      !Number.isSafeInteger(value.size) || (value.size as number) < 0) throw invalid(`invalid ${label} descriptor`);
  let expectedPlatform: PortableImageIdentity["platform"] | undefined;
  if (value.platform !== undefined) expectedPlatform = platform(object(value.platform, `${label} platform`));
  return { mediaType: value.mediaType, digest: digest(value.digest, label), size: value.size as number, platform: expectedPlatform };
}

function configFor(entries: Map<string, Entry>, configDigest: string): { platform: PortableImageIdentity["platform"]; diffIds: string[] } {
  const file = requiredEntry(entries, `blobs/sha256/${configDigest.slice(7)}`);
  if (file.digest !== configDigest) throw invalid("image config digest mismatch");
  const config = object(json(file.metadata, "image config"), "image config");
  const rootfs = object(config.rootfs, "image rootfs");
  if (rootfs.type !== "layers") throw invalid("unsupported image rootfs type");
  const diffIds = array(rootfs.diff_ids, "image diff IDs").map((item) => digest(item, "diff ID"));
  return { platform: platform(config), diffIds };
}

const MANIFEST_TYPES = new Set(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]);
const INDEX_TYPES = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);
const CONFIG_TYPES = new Set(["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"]);
const TAR_LAYER_TYPES = new Set(["application/vnd.oci.image.layer.v1.tar", "application/vnd.docker.image.rootfs.diff.tar"]);
const GZIP_LAYER_TYPES = new Set(["application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip"]);

function ociLeaves(entries: Map<string, Entry>, root: Record<string, unknown>, rootDigest: string,
  expectedPlatform: PortableImageIdentity["platform"] | undefined, check: () => void): Leaf[] {
  const leaves: Leaf[] = [];
  const visiting = new Set<string>();
  const seenChildren = new Set<string>();
  let visits = 0;
  function walk(index: Record<string, unknown>, depth: number, ancestors: string[], indexPlatform?: PortableImageIdentity["platform"]): void {
    if (depth > 4 || index.schemaVersion !== 2) throw invalid("invalid or deeply nested OCI index");
    for (const item of array(index.manifests, "OCI index manifests", 10_000)) {
      check();
      visits += 1;
      if (visits > 10_000) throw invalid("OCI graph visit limit exceeded");
      const desc = descriptor(item, "OCI index child");
      if (indexPlatform && desc.platform && !equalPlatform(indexPlatform, desc.platform))
        throw invalid("OCI nested platform descriptors disagree");
      // Docker save can retain an original multi-platform index while exporting
      // only the requested native platform's content. Exclude a foreign branch
      // only when its authenticated descriptor declares a different platform.
      if (expectedPlatform && desc.platform && !equalPlatform(desc.platform, expectedPlatform)) continue;
      if (seenChildren.has(desc.digest)) throw invalid("repeated OCI graph child");
      seenChildren.add(desc.digest);
      const path = `blobs/sha256/${desc.digest.slice(7)}`;
      const entry = requiredEntry(entries, path, desc.size);
      if (entry.digest !== desc.digest) throw invalid("OCI index child digest mismatch");
      if (visiting.has(desc.digest)) throw invalid("cyclic OCI index");
      const child = object(json(entry.metadata, "OCI index child"), "OCI index child");
      if (INDEX_TYPES.has(desc.mediaType)) {
        visiting.add(desc.digest);
        walk(child, depth + 1, [...ancestors, desc.digest], indexPlatform ?? desc.platform);
        visiting.delete(desc.digest);
      } else if (MANIFEST_TYPES.has(desc.mediaType)) {
        if (child.schemaVersion !== 2 || (child.mediaType !== undefined && child.mediaType !== desc.mediaType))
          throw invalid("OCI manifest schema/media type mismatch");
        const config = descriptor(child.config, "OCI config");
        if (!CONFIG_TYPES.has(config.mediaType)) throw invalid("unsupported OCI config media type");
        const configEntry = requiredEntry(entries, `blobs/sha256/${config.digest.slice(7)}`, config.size);
        if (configEntry.digest !== config.digest) throw invalid("OCI config digest mismatch");
        const parsedConfig = configFor(entries, config.digest);
        for (const declared of [indexPlatform, desc.platform]) {
          if (declared && !equalPlatform(declared, parsedConfig.platform)) throw invalid("OCI platform disagrees with image config");
        }
        const layers = array(child.layers, "OCI layers").map((layer) => descriptor(layer, "OCI layer"));
        if (layers.length !== parsedConfig.diffIds.length) throw invalid("OCI layer count disagrees with image config");
        const layerDigests = layers.map((layer, i) => {
          if (!TAR_LAYER_TYPES.has(layer.mediaType) && !GZIP_LAYER_TYPES.has(layer.mediaType))
            throw invalid("unsupported OCI layer media type");
          const found = requiredEntry(entries, `blobs/sha256/${layer.digest.slice(7)}`, layer.size);
          const expanded = GZIP_LAYER_TYPES.has(layer.mediaType) ? found.expandedDigest : found.digest;
          if (found.digest !== layer.digest || parsedConfig.diffIds[i] !== expanded)
            throw invalid("OCI layer digest disagrees with image config");
          return layer.digest;
        });
        leaves.push({ configDigest: config.digest, layerDigests, platform: parsedConfig.platform, graphDigests: [...ancestors, desc.digest] });
      } else throw invalid("unsupported OCI index child media type");
    }
  }
  walk(root, 0, [rootDigest]);
  return leaves;
}

function classicLeaves(entries: Map<string, Entry>, check: () => void): Leaf[] {
  const root = json(requiredEntry(entries, "manifest.json").metadata, "Docker manifest");
  const leaves: Leaf[] = [];
  for (const item of array(root, "Docker manifest", 1000)) {
    check();
    const manifest = object(item, "Docker manifest item");
    if (typeof manifest.Config !== "string" || !CLASSIC_CONFIG.test(manifest.Config))
      throw invalid("invalid Docker config path");
    const file = requiredEntry(entries, manifest.Config);
    const configDigest = file.digest;
    if (manifest.Config === `${configDigest.slice(7)}.json` || manifest.Config === `blobs/sha256/${configDigest.slice(7)}`) {
      // The path and raw bytes independently identify the same config.
    } else throw invalid("Docker config path/digest mismatch");
    const config = object(json(file.metadata, "Docker config"), "Docker config");
    const rootfs = object(config.rootfs, "Docker rootfs");
    if (rootfs.type !== "layers") throw invalid("unsupported Docker rootfs type");
    const diffIds = array(rootfs.diff_ids, "Docker diff IDs").map((value) => digest(value, "diff ID"));
    const layers = array(manifest.Layers, "Docker layers").map((value) => {
      if (typeof value !== "string") throw invalid("invalid Docker layer path");
      return requiredEntry(entries, value);
    });
    if (layers.length !== diffIds.length || layers.some((layer, i) => layer.digest !== diffIds[i] && layer.expandedDigest !== diffIds[i]))
      throw invalid("Docker layers disagree with image config");
    leaves.push({ configDigest, layerDigests: layers.map((layer) => layer.digest), platform: platform(config), graphDigests: [] });
  }
  return leaves;
}

/** Verify an entire docker-save tar stream against its immutable Docker image ID.
 * No archive member is extracted; large layer bodies are hashed incrementally.
 * The accepted tar dialect is deliberately limited to ordinary ustar files and
 * directories, which is what Docker save emits for these portable archives.
 */
export async function readImageProof(
  stream: Readable,
  immutableImageId: string,
  expectedPlatform?: PortableImageIdentity["platform"],
  options: ImageProofOptions = {},
): Promise<PortableImageIdentity> {
  let validated: {
    imageId: string; maxArchiveBytes: number; maxEntries: number; maxMetadataBytes: number;
    maxMetadataTotalBytes: number; maxExpandedBytes: number; maxDurationMs: number;
  };
  try {
    validated = {
      imageId: digest(immutableImageId, "immutable image ID"),
      maxArchiveBytes: limit(options.limits?.maxArchiveBytes, MAX_ARCHIVE_BYTES, "archive bytes"),
      maxEntries: limit(options.limits?.maxEntries, MAX_ENTRIES, "entries"),
      maxMetadataBytes: limit(options.limits?.maxMetadataBytes, MAX_METADATA_BYTES, "metadata bytes"),
      maxMetadataTotalBytes: limit(options.limits?.maxMetadataTotalBytes, MAX_METADATA_TOTAL_BYTES, "metadata total bytes"),
      maxExpandedBytes: limit(options.limits?.maxExpandedBytes, MAX_EXPANDED_BYTES, "expanded bytes"),
      maxDurationMs: limit(options.limits?.maxDurationMs, MAX_DURATION_MS, "duration"),
    };
  } catch (error) {
    stream.destroy();
    throw error;
  }
  const { imageId, maxArchiveBytes, maxEntries, maxMetadataBytes, maxMetadataTotalBytes, maxExpandedBytes, maxDurationMs } = validated;
  const deadline = Date.now() + maxDurationMs;
  const check = () => {
    if (options.signal?.aborted) throw invalid("aborted");
    if (Date.now() > deadline) throw invalid("verification timed out");
  };
  const entries = new Map<string, Entry>();
  let metadataTotal = 0;
  let expandedTotal = 0;
  let ended = false;
  let activeGzip: ReturnType<typeof createGunzip> | undefined;
  const stop = (reason: Error) => {
    activeGzip?.destroy(reason);
    stream.destroy(reason);
  };
  const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : invalid("aborted"));
  const timer = setTimeout(() => stop(invalid("verification timed out")), maxDurationMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw invalid("aborted");
    const reader = new TarReader(stream, maxArchiveBytes, check);
    let count = 0;
    for (;;) {
      check();
      const block = await reader.block();
      if (block.every((byte) => byte === 0)) {
        const second = await reader.block();
        if (!second.every((byte) => byte === 0)) throw invalid("missing second tar end block");
        await reader.trailer();
        ended = true;
        break;
      }
      count += 1;
      if (count > maxEntries) throw invalid("tar entry limit exceeded");
      const item = header(block);
      if (entries.has(item.name)) throw invalid("duplicate tar entry");
      if (item.size > maxArchiveBytes - reader.bytes) throw invalid("tar entry exceeds archive byte limit");
      const hash = createHash("sha256");
      const blobMatch = BLOB.exec(item.name);
      const mayBeMetadata = item.type === "file" && item.size <= maxMetadataBytes &&
        (item.name === "manifest.json" || item.name === "index.json" || item.name === "oci-layout" ||
         /^[a-f0-9]{64}\.json$/.test(item.name) || blobMatch);
      const capturePotential = mayBeMetadata && metadataTotal + item.size <= maxMetadataTotalBytes;
      const chunks: Buffer[] = [];
      // OCI blob metadata has no filename extension. Hold only a 512-byte
      // lookahead until it is distinguishable from gzip or a tar layer header.
      // Layer bodies themselves always continue through the hashing stream.
      const metadataProbe = Buffer.alloc(Math.min(item.size, 512));
      let metadataProbeLength = 0;
      const fixedMetadata = item.name === "manifest.json" || item.name === "index.json" || item.name === "oci-layout";
      let capture = capturePotential && fixedMetadata;
      let captureDecided = fixedMetadata || !capturePotential;
      const compressedBlob = Boolean(blobMatch) && item.size >= 2;
      const first = Buffer.alloc(2);
      let firstLength = 0;
      let gzip: ReturnType<typeof createGunzip> | undefined;
      let gzipDone: Promise<void> | undefined;
      let inflateError: Error | undefined;
      const expandedHash = createHash("sha256");
      const writeCompressed = async (part: Buffer) => {
        if (!gzip || part.length === 0) return;
        if (!gzip.write(part)) await once(gzip, "drain");
        if (inflateError) throw inflateError;
      };
      try {
        await reader.read(item.size, async (part) => {
          hash.update(part);
          if (capturePotential) {
            if (captureDecided) {
              if (capture) chunks.push(Buffer.from(part));
            } else {
              const used = Math.min(metadataProbe.length - metadataProbeLength, part.length);
              part.copy(metadataProbe, metadataProbeLength, 0, used);
              metadataProbeLength += used;
              if (metadataProbeLength === metadataProbe.length) {
                captureDecided = true;
                const jsonStart = metadataProbe.findIndex((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
                capture = jsonStart >= 0 && metadataProbe[jsonStart] === 0x7b &&
                  (metadataProbe.length < 512 || !looksLikeTarHeader(metadataProbe));
                if (capture) {
                  chunks.push(Buffer.from(metadataProbe));
                  if (part.length > used) chunks.push(Buffer.from(part.subarray(used)));
                }
              }
            }
          }
          if (!compressedBlob) return;
          if (firstLength < 2) {
            const used = Math.min(2 - firstLength, part.length);
            part.copy(first, firstLength, 0, used);
            firstLength += used;
            if (firstLength < 2) return;
            if (first[0] === 0x1f && first[1] === 0x8b) {
              gzip = createGunzip();
              activeGzip = gzip;
              gzipDone = finished(gzip);
              // Keep an early zlib error observed until the entry is finalized.
              gzipDone.catch(() => {});
              gzip.on("error", (error: Error) => { inflateError = error; });
              gzip.on("data", (chunk: Buffer) => {
                try { check(); } catch (error) {
                  gzip!.destroy(error instanceof Error ? error : invalid("verification stopped"));
                  return;
                }
                expandedTotal += chunk.length;
                if (expandedTotal > maxExpandedBytes) {
                  gzip!.destroy(invalid("expanded layer byte limit exceeded"));
                  return;
                }
                expandedHash.update(chunk);
              });
              await writeCompressed(first);
            }
            if (gzip) await writeCompressed(part.subarray(used));
            return;
          }
          if (gzip) await writeCompressed(part);
        });
        if (gzip) {
          gzip.end();
          await gzipDone;
          check();
          activeGzip = undefined;
        }
      } catch (error) {
        gzip?.destroy(error instanceof Error ? error : invalid("gzip processing failed"));
        activeGzip = undefined;
        await gzipDone?.catch(() => {});
        throw error;
      }
      const padding = (512 - item.size % 512) % 512;
      await reader.read(padding, (part) => {
        if (part.some((byte) => byte !== 0)) throw invalid("nonzero tar entry padding");
      });
      const entry: Entry = { size: item.size, digest: `sha256:${hash.digest("hex")}`, type: item.type };
      if (gzip) entry.expandedDigest = `sha256:${expandedHash.digest("hex")}`;
      if (capture) {
        entry.metadata = Buffer.concat(chunks, item.size);
        metadataTotal += item.size;
      }
      if (blobMatch && entry.digest !== `sha256:${blobMatch[1]}`) throw invalid("blob path/digest mismatch");
      entries.set(item.name, entry);
    }
    if (!ended || !entries.has("manifest.json")) throw invalid("Docker manifest missing");
    const classic = classicLeaves(entries, check);
    if (classic.length === 0) throw invalid("Docker manifest contains no image");
    let leaves = classic;
    let rootDigest: string | undefined;
    if (entries.has("oci-layout") || entries.has("index.json")) {
      if (!entries.has("oci-layout") || !entries.has("index.json")) throw invalid("incomplete OCI layout");
      const layout = object(json(entries.get("oci-layout")?.metadata, "OCI layout"), "OCI layout");
      if (layout.imageLayoutVersion !== "1.0.0") throw invalid("unsupported OCI layout version");
      const rootEntry = requiredEntry(entries, "index.json");
      rootDigest = rootEntry.digest;
      const root = object(json(rootEntry.metadata, "OCI index"), "OCI index");
      leaves = ociLeaves(entries, root, rootDigest, expectedPlatform, check);
      for (const leaf of leaves) {
        if (!classic.some((item) => item.configDigest === leaf.configDigest &&
            JSON.stringify(item.layerDigests) === JSON.stringify(leaf.layerDigests) && equalPlatform(item.platform, leaf.platform)))
          throw invalid("OCI graph disagrees with Docker manifest");
      }
      for (const item of classic) {
        if (expectedPlatform && !equalPlatform(item.platform, expectedPlatform)) continue;
        if (!leaves.some((leaf) => leaf.configDigest === item.configDigest &&
            JSON.stringify(leaf.layerDigests) === JSON.stringify(item.layerDigests) && equalPlatform(leaf.platform, item.platform)))
          throw invalid("Docker manifest contains image outside OCI graph");
      }
    }
    const candidates = leaves.filter((leaf) =>
      (leaf.configDigest === imageId || leaf.graphDigests.includes(imageId)) &&
      (!expectedPlatform || equalPlatform(leaf.platform, expectedPlatform)));
    if (candidates.length !== 1) throw invalid("immutable image ID does not select exactly one platform/image");
    return { version: 1, configDigest: candidates[0]!.configDigest, platform: candidates[0]!.platform };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (!ended) stream.destroy();
  }
}
