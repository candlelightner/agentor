import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  validateAndExtractPortableManagedVolumePayload,
  validatePortableManagedVolumeArchive,
  writePortableManagedVolumePayload,
  MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES,
  MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES,
} from "../../orchestrator/server/utils/portable-managed-volume-archive";

type TarItem = { name: string; type?: string; body?: Buffer | string; linkname?: string; mode?: number };

async function writeTar(path: string, items: TarItem[]): Promise<void> {
  const chunks: Buffer[] = [];
  for (const item of items) {
    const body = item.body === undefined ? Buffer.alloc(0) : Buffer.from(item.body);
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, item.name);
    writeOctal(header, 100, 8, item.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = ({ file: 48, directory: 53, symlink: 50, link: 49,
      "pax-header": 120, "global-pax": 103, "gnu-long-path": 76, fifo: 54 } as Record<string, number>)[item.type ?? "file"]!;
    if (item.linkname) writeString(header, 157, 100, item.linkname);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    let checksum = 0; for (const byte of header) checksum += byte;
    const checksumField = `${checksum.toString(8).padStart(6, "0")}\0 `;
    header.write(checksumField, 148, 8, "ascii");
    chunks.push(header, body);
    const padding = (512 - body.length % 512) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  await writeFile(path, Buffer.concat(chunks));
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error("test tar field is too long");
  bytes.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function paxRecord(key: string, value: string): Buffer {
  const content = `${key}=${value}\n`;
  let length = Buffer.byteLength(content) + 2;
  while (true) {
    const candidate = `${length} ${content}`;
    const actual = Buffer.byteLength(candidate);
    if (actual === length) return Buffer.from(candidate);
    length = actual;
  }
}

async function writeGzipTar(path: string, items: TarItem[]): Promise<void> {
  const raw = `${path}.raw`;
  await writeTar(raw, items);
  await pipeline(createReadStream(raw), createGzip(), createWriteStream(path));
  await rm(raw);
}

const ordinaryItems = (): TarItem[] => [
  { name: "volume/", type: "directory", mode: 0o751 },
  { name: "volume/file.txt", body: "portable data\0\xff", mode: 0o640 },
  { name: "volume/sub/", type: "directory", mode: 0o750 },
  { name: "volume/sub/link", type: "symlink", linkname: "../file.txt" },
  { name: "volume/hard", type: "link", linkname: "volume/file.txt" },
];

test("strict validator accepts canonical files, modes, and safe relative links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-archive-"));
  try {
    const archive = join(dir, "volume.tar");
    await writeTar(archive, ordinaryItems());
    await expect(validatePortableManagedVolumeArchive(archive)).resolves.toEqual({
      entries: 5,
      expandedBytes: Buffer.byteLength("portable data\0\xff"),
    });
    await expect(validatePortableManagedVolumeArchive(archive, { maxEntries: 4 })).rejects.toThrow(/too many entries/i);
    await expect(validatePortableManagedVolumeArchive(archive, { maxExpandedBytes: 2 })).rejects.toThrow(/size limit/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("validator interoperates with real GNU ustar output used by Docker-style archives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-gnu-"));
  try {
    const stage = join(dir, "stage"), volume = join(stage, "volume"), archive = join(dir, "gnu.tar");
    await mkdir(join(volume, "sub"), { recursive: true });
    await writeFile(join(volume, "file.txt"), "gnu data");
    await chmod(join(volume, "file.txt"), 0o640);
    await symlink("../file.txt", join(volume, "sub", "relative-link"));
    await link(join(volume, "file.txt"), join(volume, "hard-link"));
    execFileSync("tar", ["--format=ustar", "--numeric-owner", "--owner=123", "--group=456", "-C", stage, "-cf", archive, "volume"]);
    const result = await validatePortableManagedVolumeArchive(archive);
    expect(result.entries).toBeGreaterThanOrEqual(5);
    expect(result.expandedBytes).toBe(Buffer.byteLength("gnu data"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bounded path/linkpath PAX preserves long names and target-confined absolute symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-pax-"));
  try {
    const archive = join(dir, "pax.tar");
    const longName = `volume/${"long-segment-".repeat(14)}file.txt`;
    await writeTar(archive, [
      { name: "volume/", type: "directory" },
      { name: "PaxHeaders/file", type: "pax-header", body: paxRecord("path", longName) },
      { name: "volume/placeholder", body: "long data" },
      { name: "volume/absolute", type: "symlink", linkname: "/home/agent/data/file.txt" },
    ]);
    await expect(validatePortableManagedVolumeArchive(archive, { target: "/home/agent/data" })).resolves.toEqual({
      entries: 3,
      expandedBytes: Buffer.byteLength("long data"),
    });
    await expect(validatePortableManagedVolumeArchive(archive)).rejects.toThrow(/absolute symlink/i);
    await expect(validatePortableManagedVolumeArchive(archive, { target: "/srv/other" })).rejects.toThrow(/escapes/i);

    const longLinkArchive = join(dir, "pax-link.tar");
    const longRelativeLink = `${"child/".repeat(20)}target`;
    await writeTar(longLinkArchive, [
      { name: "volume/", type: "directory" },
      { name: "PaxHeaders/link", type: "pax-header", body: paxRecord("linkpath", longRelativeLink) },
      { name: "volume/link", type: "symlink", linkname: "placeholder" },
    ]);
    await expect(validatePortableManagedVolumeArchive(longLinkArchive)).resolves.toMatchObject({ entries: 2 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("payload packing and extraction preserve exact inner tar bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-payload-"));
  try {
    const inner = join(dir, "inner.tar"), payload = join(dir, "managed-volumes.tar.gz"), destination = join(dir, "extract");
    await writeTar(inner, ordinaryItems());
    const entry = { target: "/srv/data", name: "data", archive: "volumes/0.tar" };
    const written = await writePortableManagedVolumePayload([{ entry, archivePath: inner }], payload);
    expect(written.bytes).toBeGreaterThan(0);
    const extracted = await validateAndExtractPortableManagedVolumePayload(payload, [entry], destination);
    expect(extracted).toEqual([{ entry, archivePath: join(destination, "volumes", "0.tar") }]);
    expect(await readFile(extracted[0]!.archivePath)).toEqual(await readFile(inner));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an explicit empty manifest has a valid exact empty payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-empty-"));
  try {
    const payload = join(dir, "managed-volumes.tar.gz"), destination = join(dir, "extract");
    await writePortableManagedVolumePayload([], payload);
    await expect(validateAndExtractPortableManagedVolumePayload(payload, [], destination)).resolves.toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("raw validator rejects traversal, duplicates, PAX/GNU extensions, specials, and broken tar framing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-malicious-"));
  try {
    const cases: Array<{ name: string; items: TarItem[]; message: RegExp }> = [
      { name: "traversal", items: [{ name: "volume/", type: "directory" }, { name: "volume/../escape", body: "x" }], message: /unsafe path/i },
      { name: "duplicate", items: [{ name: "volume/", type: "directory" }, { name: "volume/file", body: "a" }, { name: "volume/file", body: "b" }], message: /duplicate/i },
      { name: "pax-unknown", items: [{ name: "volume/", type: "directory" }, { name: "pax", type: "pax-header", body: paxRecord("SCHILY.xattr.user.bad", "value") }, { name: "volume/file", body: "x" }], message: /pax metadata key/i },
      { name: "global-pax", items: [{ name: "volume/", type: "directory" }, { name: "global", type: "global-pax" }], message: /unsupported/i },
      { name: "gnu-long", items: [{ name: "volume/", type: "directory" }, { name: "long", type: "gnu-long-path" }], message: /unsupported/i },
      { name: "fifo", items: [{ name: "volume/", type: "directory" }, { name: "volume/fifo", type: "fifo" }], message: /unsupported/i },
    ];
    for (const item of cases) {
      const archive = join(dir, `${item.name}.tar`);
      await writeTar(archive, item.items);
      await expect(validatePortableManagedVolumeArchive(archive)).rejects.toThrow(item.message);
    }
    const valid = join(dir, "valid.tar"), corrupt = join(dir, "checksum.tar"), truncated = join(dir, "truncated.tar");
    await writeTar(valid, ordinaryItems());
    const bytes = await readFile(valid);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(corrupt, bytes);
    await expect(validatePortableManagedVolumeArchive(corrupt)).rejects.toThrow(/checksum/i);
    await writeFile(truncated, (await readFile(valid)).subarray(0, 600));
    await expect(validatePortableManagedVolumeArchive(truncated)).rejects.toThrow(/truncated|end marker/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("normalized type collisions and descendants below non-directories fail in either order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-collisions-"));
  try {
    const cases: TarItem[][] = [
      [{ name: "volume/", type: "directory" }, { name: "volume/a/", type: "directory" }, { name: "volume/a", body: "x" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/a", body: "x" }, { name: "volume/a/", type: "directory" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/a/", type: "directory" }, { name: "volume/a", type: "symlink", linkname: "." }],
      [{ name: "volume/", type: "directory" }, { name: "volume/a", type: "symlink", linkname: "." }, { name: "volume/a/", type: "directory" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/a", body: "x" }, { name: "volume/a/child", body: "y" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/a/child", body: "y" }, { name: "volume/a", body: "x" }],
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const archive = join(dir, `${index}.tar`);
      await writeTar(archive, cases[index]!);
      await expect(validatePortableManagedVolumeArchive(archive)).rejects.toThrow(/duplicate|non-directory/i);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("links cannot escape, point forward, target non-files, or receive writes in either order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-links-"));
  try {
    const attacks: TarItem[][] = [
      [{ name: "volume/", type: "directory" }, { name: "volume/link", type: "symlink", linkname: "../../escape" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/link", type: "symlink", linkname: "/etc" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/hard", type: "link", linkname: "volume/later" }, { name: "volume/later", body: "x" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/dir/", type: "directory" }, { name: "volume/hard", type: "link", linkname: "volume/dir" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/link", type: "symlink", linkname: "." }, { name: "volume/link/child", body: "x" }],
      [{ name: "volume/", type: "directory" }, { name: "volume/link/child", body: "x" }, { name: "volume/link", type: "symlink", linkname: "." }],
    ];
    for (let index = 0; index < attacks.length; index += 1) {
      const archive = join(dir, `${index}.tar`);
      await writeTar(archive, attacks[index]!);
      await expect(validatePortableManagedVolumeArchive(archive)).rejects.toThrow(/symlink|hardlink|writes through|non-directory/i);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("outer payload must contain exactly the manifest members and cleans partial output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-outer-"));
  try {
    const inner = join(dir, "inner.tar"), payload = join(dir, "payload.gz"), destination = join(dir, "extract");
    await writeTar(inner, ordinaryItems());
    const body = await readFile(inner);
    await writeGzipTar(payload, [
      { name: "volumes/0.tar", body },
      { name: "volumes/attacker.tar", body },
    ]);
    const entry = { target: "/srv/data", name: "data", archive: "volumes/0.tar" };
    await expect(validateAndExtractPortableManagedVolumePayload(payload, [entry], destination)).rejects.toThrow(/members do not match|too many entries/i);
    expect(await readdir(destination)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("abort rejects and removes staging artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-abort-"));
  try {
    const inner = join(dir, "inner.tar"), payload = join(dir, "payload.gz"), destination = join(dir, "extract");
    await writeTar(inner, ordinaryItems());
    const entry = { target: "/srv/data", name: "data", archive: "volumes/0.tar" };
    await writePortableManagedVolumePayload([{ entry, archivePath: inner }], payload);
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(validateAndExtractPortableManagedVolumePayload(payload, [entry], destination, { signal: controller.signal })).rejects.toThrow(/cancelled|abort/i);
    expect(await readdir(destination)).toEqual([]);
    await expect(lstat(join(destination, ".managed-volumes.payload.tar"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("raw trailing-zero work and aggregate payload inputs are bounded before output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-volume-bounds-"));
  try {
    const ordinary = join(dir, "ordinary.tar");
    await writeTar(ordinary, ordinaryItems());
    await appendFile(ordinary, Buffer.alloc(19 * 512));
    await expect(validatePortableManagedVolumeArchive(ordinary)).rejects.toThrow(/trailing zero/i);

    const sparse = join(dir, "oversized.tar"), output = join(dir, "payload.gz");
    await writeFile(sparse, "");
    await truncate(sparse, MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES + 1);
    const entry = { target: "/srv/data", name: "data", archive: "volumes/0.tar" };
    await expect(writePortableManagedVolumePayload([{ entry, archivePath: sparse }], output)).rejects.toThrow(/aggregate size/i);
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("payload writer never publishes a gzip member beyond the outer bundle ceiling", async () => {
  expect(MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES).toBe(
    20 * 1024 * 1024 * 1024,
  );
  expect(MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES).toBeGreaterThan(
    MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES,
  );

  const dir = await mkdtemp(join(tmpdir(), "portable-volume-compressed-bound-"));
  try {
    const inner = join(dir, "inner.tar"), output = join(dir, "payload.gz");
    await writeTar(inner, ordinaryItems());
    const entry = { target: "/srv/data", name: "data", archive: "volumes/0.tar" };
    await expect(writePortableManagedVolumePayload(
      [{ entry, archivePath: inner }],
      output,
      // Exercise the production writer's byte-counting path cheaply. Caller
      // limits are always capped by the 20 GiB production maximum.
      { maxCompressedBytes: 64 },
    )).rejects.toThrow(/compressed managed-volume payload exceeds/i);
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
