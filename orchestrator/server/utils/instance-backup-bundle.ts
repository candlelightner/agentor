import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  type WriteStream,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";
import type {
  InstanceBackupManifest,
  InstanceBackupOptions,
  InstanceBackupVolumeManifest,
} from "./instance-backup-types";
import { randomUUID } from 'node:crypto';
import { parseWorkerBackupRuntime } from './worker-backup-runtime';
import { isCanonicalPortableManagedVolumeTarget } from './portable-managed-volume-format';
import { MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES, MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES,
  validateIncusCanonicalRestoreArchive, validateIncusDockerRestoreArchive,
  validatePortableManagedVolumeArchive } from './portable-managed-volume-archive';

const MANIFEST = "manifest.json";
const DATA_ARCHIVE = "data.tar.gz";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 2_000_000;
const MAX_VOLUMES = 100_000;

export interface InstanceBundleEntry {
  name: string;
  path: string;
  size: number;
}

export interface InspectedInstanceBundle {
  manifest: InstanceBackupManifest;
  dataArchivePath: string;
  volumeArchives: Map<string, string>;
}

export function instanceVolumeArchiveName(volumeName: string): string {
  assertDockerVolumeName(volumeName);
  return `volumes/${Buffer.from(volumeName).toString("base64url")}.tar.gz`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return hash.digest("hex");
}

export async function createInstanceDataArchive(input: {
  dataDir: string;
  authSnapshotPath: string;
  output: string;
  options: InstanceBackupOptions;
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
}): Promise<{ size: number; sha256: string; excludedDataPaths: string[] }> {
  const dataRoot = resolve(input.dataDir);
  const excludedDataPaths = excludedPaths(input.options);
  const pack = tar.pack();
  const gzip = createGzip({ level: 6 });
  let compressedBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      input.onBytes?.(compressedBytes);
      callback(null, chunk);
    },
  });
  const writing = pipeline(
    pack,
    gzip,
    counter,
    createWriteStream(input.output, { mode: 0o600 }),
    input.signal ? { signal: input.signal } : {},
  );
  try {
    await addPathTree(pack, dataRoot, "", excludedDataPaths, input.signal);
    await addRegularFile(pack, input.authSnapshotPath, "auth.db", input.signal);
    pack.finalize();
    await writing;
  } catch (error) {
    pack.destroy(error instanceof Error ? error : undefined);
    await writing.catch(() => {});
    await rm(input.output, { force: true }).catch(() => {});
    throw error;
  }
  return {
    size: (await stat(input.output)).size,
    sha256: await sha256File(input.output),
    excludedDataPaths,
  };
}

export async function packInstanceBundle(
  manifest: InstanceBackupManifest,
  dataArchive: string,
  volumeArchives: Array<{ manifest: InstanceBackupVolumeManifest; path: string }>,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  validateInstanceManifest(manifest);
  const manifestPath = `${output}.manifest`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  const entries: InstanceBundleEntry[] = [
    {
      name: MANIFEST,
      path: manifestPath,
      size: (await stat(manifestPath)).size,
    },
    {
      name: DATA_ARCHIVE,
      path: dataArchive,
      size: (await stat(dataArchive)).size,
    },
    ...volumeArchives.map(({ manifest: volume, path }) => ({
      name: volume.archive,
      path,
      size: volume.size,
    })),
  ];
  const declared = new Set([
    MANIFEST,
    manifest.dataArchive.archive,
    ...manifest.volumes.map((volume) => volume.archive),
  ]);
  if (
    entries.length !== declared.size ||
    entries.some((entry) => !declared.has(entry.name))
  )
    throw new Error("Instance backup manifest does not match its payloads");
  const pack = tar.pack();
  const writing = pipeline(
    pack,
    createWriteStream(output, { mode: 0o600 }),
    signal ? { signal } : {},
  );
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_BUNDLE_BYTES
      )
        throw new Error("Instance backup payload exceeds the size limit");
      await pipeline(
        createReadStream(entry.path),
        pack.entry({ name: entry.name, type: "file", size: entry.size, mode: 0o600 }),
        signal ? { signal } : {},
      );
    }
    pack.finalize();
    await writing;
  } catch (error) {
    pack.destroy(error instanceof Error ? error : undefined);
    await writing.catch(() => {});
    await rm(output, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(manifestPath, { force: true }).catch(() => {});
  }
}

export async function inspectInstanceBundle(
  input: string,
  destination: string,
  signal?: AbortSignal,
): Promise<InspectedInstanceBundle> {
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BUNDLE_BYTES)
    throw new Error("Invalid instance backup bundle");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const extracted = new Map<string, string>();
  const seen = new Set<string>();
  let total = 0;
  const extract = tar.extract();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const source = createReadStream(input);
    const outputs = new Set<WriteStream>();
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      source.destroy();
      extract.destroy();
      for (const output of outputs) output.destroy();
      rejectPromise(error);
    };
    extract.on("entry", (header, stream, next) => {
      try {
        signal?.throwIfAborted();
        if (header.type !== "file" || !safeBundleName(header.name))
          throw new Error("Invalid instance backup bundle entry");
        if (seen.has(header.name))
          throw new Error("Duplicate instance backup bundle entry");
        const size = header.size;
        if (
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > MAX_BUNDLE_BYTES ||
          total + size > MAX_BUNDLE_BYTES
        )
          throw new Error("Instance backup bundle exceeds the size limit");
        total += size;
        seen.add(header.name);
        const target = join(destination, safeBundleFilename(header.name));
        const output = createWriteStream(target, { mode: 0o600 });
        outputs.add(output);
        pipeline(stream, output, signal ? { signal } : {})
          .then(() => {
            outputs.delete(output);
            extracted.set(header.name, target);
            if (!settled) next();
          })
          .catch(fail);
      } catch (error) {
        stream.resume();
        fail(error);
      }
    });
    extract.on("finish", () => {
      if (!settled) {
        settled = true;
        resolvePromise();
      }
    });
    extract.on("error", fail);
    source.on("error", fail);
    source.pipe(extract);
  });
  const manifestPath = extracted.get(MANIFEST);
  if (!manifestPath || (await stat(manifestPath)).size > MAX_MANIFEST_BYTES)
    throw new Error("Instance backup manifest is missing or too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("Invalid instance backup manifest");
  }
  const manifest = validateInstanceManifest(parsed);
  const expectedNames = new Set([
    MANIFEST,
    manifest.dataArchive.archive,
    ...manifest.volumes.map((volume) => volume.archive),
  ]);
  if (
    expectedNames.size !== extracted.size ||
    [...extracted.keys()].some((name) => !expectedNames.has(name))
  )
    throw new Error("Instance backup payloads do not match the manifest");
  const dataArchivePath = extracted.get(manifest.dataArchive.archive)!;
  await verifyPayload(dataArchivePath, manifest.dataArchive);
  await validateTarGzip(dataArchivePath, true, signal);
  const volumeArchives = new Map<string, string>();
  for (const volume of manifest.volumes) {
    const path = extracted.get(volume.archive)!;
    await verifyPayload(path, volume);
    if (volume.runtime) {
      const privateScratch = await mkdtemp(join(destination, '.native-volume-check-'));
      try { await prepareInstanceNativeVolumeArchive(path, volume, privateScratch, { signal }); }
      finally { await rm(privateScratch, { recursive: true, force: true }); }
    } else await validateTarGzip(path, false, signal);
    volumeArchives.set(volume.name, path);
  }
  return { manifest, dataArchivePath, volumeArchives };
}

export function validateInstanceManifest(
  value: unknown,
): InstanceBackupManifest {
  const input = value as any;
  if (
    !input ||
    input.kind !== "agentor-instance-backup" ||
    ![1, 2].includes(input.formatVersion) ||
    !safeId(input.backupId) ||
    !bounded(input.sourceInstallationId, 200) ||
    !safeId(input.createdByUserId) ||
    !iso(input.createdAt) ||
    !bounded(input.agentorVersion, 100) ||
    !input.storage ||
    !["directory", "volume"].includes(input.storage.mode) ||
    !bounded(input.storage.containerPrefix, 100) ||
    !validOptions(input.options) ||
    input.dataArchive?.archive !== DATA_ARCHIVE ||
    !sha(input.dataArchive.sha256) ||
    !safeSize(input.dataArchive.size) ||
    !Array.isArray(input.volumes) ||
    input.volumes.length > MAX_VOLUMES ||
    !input.volumes.every((volume: unknown) => validVolume(volume, input.formatVersion, input.storage.containerPrefix)) ||
    new Set(input.volumes.map((item: any) => item.name)).size !==
      input.volumes.length ||
    new Set(input.volumes.map((item: any) => item.archive)).size !==
      input.volumes.length ||
    !input.plugins ||
    !count(input.plugins.platformDefinitionCount) ||
    !count(input.plugins.ownerDefinitionCount) ||
    !count(input.plugins.installationCount) ||
    !input.hostMounts ||
    input.hostMounts.contentsIncluded !== false ||
    !Array.isArray(input.hostMounts.configuredPaths) ||
    input.hostMounts.configuredPaths.length > 100_000 ||
    input.hostMounts.configuredPaths.some(
      (path: unknown) => !bounded(path, 4096) || !String(path).startsWith("/"),
    ) ||
    !input.images ||
    !count(input.images.definitions) ||
    input.images.layersIncluded !== false ||
    !Array.isArray(input.images.immutableDigests) ||
    input.images.immutableDigests.length > 100_000 ||
    input.images.immutableDigests.some(
      (digest: unknown) =>
        typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest),
    ) ||
    !Array.isArray(input.excludedDataPaths) ||
    input.excludedDataPaths.length > 100 ||
    input.excludedDataPaths.some(
      (path: unknown) => !bounded(path, 4096) || String(path).startsWith("/"),
    )
  )
    throw new Error("Invalid instance backup manifest");
  return structuredClone(input) as InstanceBackupManifest;
}

/** Native volume validation/extraction receives unchanged raw bytes in private
 * scratch. This grants no instance, mount, filesystem or worker-ID authority. */
export async function prepareInstanceNativeVolumeArchive(
  payloadPath: string,
  volume: InstanceBackupVolumeManifest,
  privateWorkDir: string,
  options: { signal?: AbortSignal; maxRawBytes?: number } = {},
): Promise<{ archivePath: string; rawBytes: number; entries: number; expandedBytes: number }> {
  if (!validVolume(volume, 2) || !volume.runtime)
    throw new Error('Invalid native instance volume descriptor');
  const requested = options.maxRawBytes ?? MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(requested) || requested <= 0)
    throw new Error('Invalid native instance volume raw-byte limit');
  const maxRawBytes = Math.min(requested, MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES);
  options.signal?.throwIfAborted();
  const directory = await lstat(privateWorkDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      directory.uid !== process.geteuid?.())
    throw new Error('Native instance volume scratch must be a caller-owned private directory');
  const archivePath = join(privateWorkDir, `native-${randomUUID()}.tar`);
  let input: Awaited<ReturnType<typeof open>> | undefined, output: Awaited<ReturnType<typeof open>> | undefined;
  let created = false, rawBytes = 0;
  try {
    input = await open(payloadPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await input.stat();
    if (!info.isFile() || info.size > MAX_PORTABLE_MANAGED_VOLUME_COMPRESSED_PAYLOAD_BYTES)
      throw new Error('Native instance volume gzip input must be a bounded regular file');
    output = await open(archivePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      rawBytes += Buffer.byteLength(chunk);
      callback(rawBytes > maxRawBytes ? new Error('Native instance volume exceeds the raw-byte limit') : null, chunk);
    } });
    await pipeline(input.createReadStream(), createGunzip(), bounded, output.createWriteStream(), { signal: options.signal });
    const runtime = volume.runtime, limits = { maxExpandedBytes: maxRawBytes, signal: options.signal };
    const summary = runtime.role === 'managed'
      ? await validatePortableManagedVolumeArchive(archivePath, { ...limits, target: runtime.target, requirePosixUstar: true })
      : runtime.role === 'docker' ? await validateIncusDockerRestoreArchive(archivePath, limits)
        : await validateIncusCanonicalRestoreArchive(archivePath, runtime.role, limits);
    return { archivePath, rawBytes, ...summary };
  } catch (error) {
    await output?.close().catch(() => {});
    if (created) await rm(archivePath, { force: true }).catch(() => {});
    throw error;
  } finally { await input?.close().catch(() => {}); await output?.close().catch(() => {}); }
}

async function addPathTree(
  pack: tar.Pack,
  root: string,
  relativePath: string,
  exclusions: string[],
  signal?: AbortSignal,
): Promise<void> {
  const directory = join(root, relativePath);
  const handle = await opendir(directory);
  const names: string[] = [];
  for await (const entry of handle) names.push(entry.name);
  names.sort();
  for (const name of names) {
    signal?.throwIfAborted();
    const childRelative = relativePath ? `${relativePath}/${name}` : name;
    if (excluded(childRelative, exclusions)) continue;
    if (childRelative === "auth.db" || /^auth\.db-(?:wal|shm)$/.test(childRelative))
      continue;
    const full = join(root, ...childRelative.split("/"));
    const info = await lstat(full);
    if (info.isDirectory()) {
      await entryPromise(pack, {
        name: `${childRelative}/`,
        type: "directory",
        size: 0,
        mode: info.mode & 0o7777,
        mtime: info.mtime,
        uid: info.uid,
        gid: info.gid,
      });
      await addPathTree(pack, root, childRelative, exclusions, signal);
    } else if (info.isFile()) {
      await addRegularFile(pack, full, childRelative, signal);
    } else if (info.isSymbolicLink()) {
      const linkname = await readlink(full);
      assertContainedSymlink(childRelative, linkname);
      await entryPromise(pack, {
        name: childRelative,
        type: "symlink",
        size: 0,
        linkname,
        mode: info.mode & 0o7777,
        mtime: info.mtime,
        uid: info.uid,
        gid: info.gid,
      });
    }
  }
}

async function addRegularFile(
  pack: tar.Pack,
  fullPath: string,
  archiveName: string,
  signal?: AbortSignal,
) {
  const file = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Instance backup input changed while reading");
    const entry = pack.entry({
      name: archiveName,
      type: "file",
      size: info.size,
      mode: info.mode & 0o7777,
      mtime: info.mtime,
      uid: info.uid,
      gid: info.gid,
    });
    await pipeline(
      // Freeze this entry at the size observed through the already-open
      // no-follow descriptor. Append-only logs may continue while explicitly
      // included, but bytes arriving after the snapshot boundary cannot spill
      // past the tar header's declared size.
      file.createReadStream({
        autoClose: false,
        start: 0,
        end: Math.max(0, info.size - 1),
      }),
      entry,
      signal ? { signal } : {},
    );
  } finally {
    await file.close().catch(() => {});
  }
}

async function entryPromise(pack: tar.Pack, header: tar.Headers) {
  await new Promise<void>((resolvePromise, rejectPromise) =>
    pack.entry(header, (error) =>
      error ? rejectPromise(error) : resolvePromise(),
    ).end(),
  );
}

async function verifyPayload(
  path: string,
  expected: { size: number; sha256: string },
) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== expected.size ||
    (await sha256File(path)) !== expected.sha256
  )
    throw new Error("Instance backup payload integrity check failed");
}

async function validateTarGzip(
  path: string,
  requireAuthDb: boolean,
  signal?: AbortSignal,
) {
  let bytes = 0;
  let entries = 0;
  let authDb = false;
  const tree = new Map<string, "file" | "directory" | "symlink" | "hardlink">();
  const extract = tar.extract();
  const expanded = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > MAX_EXPANDED_BYTES
          ? new Error("Instance backup archive exceeds the expanded-size limit")
          : null,
        chunk,
      );
    },
  });
  extract.on("entry", (header, stream, next) => {
    try {
      signal?.throwIfAborted();
      if (++entries > MAX_ENTRIES)
        throw new Error("Instance backup archive contains too many entries");
      const name = safeTarName(header.name);
      if (
        requireAuthDb &&
        [
          "instance-backup-artifacts",
          "instance-restore-staging",
          "instance-restore-rollback",
        ].includes(name.split("/")[0]!)
      )
        throw new Error("Instance backup data archive uses a reserved recovery path");
      const kind = normalizedEntryKind(header.type);
      if (!kind) throw new Error("Instance backup archive contains a special entry");
      assertTreeEntry(tree, name, kind);
      if (kind === "symlink") {
        assertContainedSymlink(
          name,
          header.linkname,
          requireAuthDb ? undefined : "source",
        );
      } else if (kind === "hardlink") {
        if (requireAuthDb)
          throw new Error("Instance backup archive contains a special entry");
        assertContainedHardlink(tree, header.linkname, "source");
      } else if (header.linkname)
        throw new Error("Instance backup archive contains an unexpected link target");
      tree.set(name, kind);
      if (name === "auth.db" && kind === "file") authDb = true;
      stream.on("end", next);
      stream.resume();
    } catch (error) {
      stream.resume();
      stream.on("end", () => next(error as Error));
    }
  });
  await pipeline(
    createReadStream(path),
    createGunzip(),
    expanded,
    extract,
    signal ? { signal } : {},
  );
  if (requireAuthDb && !authDb)
    throw new Error("Instance backup data archive has no authentication database");
}

function assertTreeEntry(
  tree: Map<string, "file" | "directory" | "symlink" | "hardlink">,
  name: string,
  kind: "file" | "directory" | "symlink" | "hardlink",
) {
  if (tree.has(name)) throw new Error("Instance backup archive has a duplicate entry");
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = tree.get(parts.slice(0, index).join("/"));
    if (ancestor && ancestor !== "directory")
      throw new Error("Instance backup archive traverses a non-directory");
  }
  for (const existing of tree.keys())
    if (existing.startsWith(`${name}/`) && kind !== "directory")
      throw new Error("Instance backup archive replaces an existing parent");
}

function excluded(path: string, exclusions: string[]) {
  return exclusions.some((value) => {
    if (!value.includes("*"))
      return path === value || path.startsWith(`${value}/`);
    const expression = new RegExp(
      `^${value
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+")}(?:/|$)`,
    );
    return expression.test(path);
  });
}

function excludedPaths(options: InstanceBackupOptions): string[] {
  const result = [
    "tmp",
    "instance-backup-artifacts",
    "instance-restore-staging",
    "instance-restore-rollback",
    // Host-local native operation/UUID cleanup receipts cannot become restore
    // authority on another installation. Canonical data is captured separately.
    "incus-backup-helpers",
    "system-state/users/volume-sizing/volume-size-jobs.v1.json",
    "system-state/users/volume-sizing/volume-size-cache.v1.json",
    "admin/instance-backups.v1.json",
    "export-artifacts",
  ];
  if (!options.includeLogs) result.push("logs");
  if (!options.includeLocalBackups)
    result.push("backup-objects", "backup-fake");
  if (!options.includeWorkers) {
    result.push("users/*/workspaces", "users/*/agents");
  } else if (!options.includeAgentData) {
    result.push("users/*/agents");
  }
  return result.sort();
}

function safeBundleName(name: string) {
  return (
    name === MANIFEST ||
    name === DATA_ARCHIVE ||
    /^volumes\/[A-Za-z0-9_-]{1,512}\.tar\.gz$/.test(name)
  );
}

function safeBundleFilename(name: string) {
  if (name === MANIFEST) return "manifest.json";
  if (name === DATA_ARCHIVE) return "data.tar.gz";
  return `volume-${basename(name, ".tar.gz")}.tar.gz`;
}

function safeTarName(value: string) {
  const raw = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    !raw ||
    raw.startsWith("/") ||
    raw.includes("\0") ||
    raw.split("/").includes("..")
  )
    throw new Error("Instance backup archive contains an unsafe path");
  const normalized = posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === ".")
    throw new Error("Instance backup archive contains an unsafe path");
  return normalized;
}

function normalizedEntryKind(value: unknown) {
  if (value === "file") return "file" as const;
  if (value === "directory") return "directory" as const;
  if (value === "symlink") return "symlink" as const;
  if (value === "link") return "hardlink" as const;
  return undefined;
}

function assertContainedHardlink(
  tree: Map<string, "file" | "directory" | "symlink" | "hardlink">,
  linkname: unknown,
  requiredRoot: string,
) {
  if (typeof linkname !== "string")
    throw new Error("Instance backup archive contains an unsafe hard link");
  const target = safeTarName(linkname);
  if (
    (target !== requiredRoot && !target.startsWith(`${requiredRoot}/`)) ||
    tree.get(target) !== "file"
  )
    throw new Error(
      "Instance backup archive hard link must target a prior regular file inside its archive root",
    );
}

function assertContainedSymlink(
  entryName: string,
  linkname: unknown,
  requiredRoot?: string,
): asserts linkname is string {
  if (
    typeof linkname !== "string" ||
    !linkname ||
    linkname.includes("\0") ||
    linkname.length > 4096
  )
    throw new Error("Instance backup archive contains an unsafe symlink");

  // Docker volume payloads are restored into an isolated helper container.
  // Their prevalidated entry tree cannot write through a symlink, while the
  // preserved link may legitimately target the eventual worker filesystem.
  if (posix.isAbsolute(linkname)) {
    if (requiredRoot) return;
    throw new Error("Instance backup archive contains an unsafe symlink");
  }
  const resolved = posix.normalize(posix.join(posix.dirname(entryName), linkname));
  if (
    !resolved ||
    resolved === ".." ||
    resolved.startsWith("../") ||
    (requiredRoot &&
      resolved !== requiredRoot &&
      !resolved.startsWith(`${requiredRoot}/`))
  )
    throw new Error("Instance backup archive contains a symlink outside its archive root");
}

function validVolume(value: any, version: number, prefix?: string) {
  try {
    assertDockerVolumeName(value?.name);
  } catch {
    return false;
  }
  return (
    [
      "worker-workspace",
      "worker-agent-data",
      "worker-dind",
      "admin-workspace",
      "admin-agent-data",
      "persistent-path",
      "traefik-certificates",
    ].includes(value.kind) &&
    optionalId(value.ownerId) &&
    optionalId(value.workerId) &&
    optionalId(value.groupId) &&
    value.archive === instanceVolumeArchiveName(value.name) &&
    sha(value.sha256) &&
    safeSize(value.size) &&
    (value.runtime === undefined ? true : version === 2 && validNativeVolume(value, prefix))
  );
}

function exactKeys(value: unknown, keys: string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validNativeVolume(volume: any, prefix?: string): boolean {
  const runtime = volume.runtime;
  if (!runtime || runtime.kind !== 'incus-vm' || !safeId(volume.ownerId) || !safeId(volume.workerId) || volume.groupId !== undefined)
    return false;
  if (runtime.role === 'managed') return exactKeys(runtime, ['kind', 'role', 'managedVolumeId', 'target']) &&
    typeof runtime.managedVolumeId === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(runtime.managedVolumeId) &&
    isCanonicalPortableManagedVolumeTarget(runtime.target) && volume.kind === 'persistent-path' &&
    volume.name === 'agentor-persist-' + runtime.managedVolumeId;
  const kinds = { workspace: 'worker-workspace', agents: 'worker-agent-data', docker: 'worker-dind' } as const;
  if (!Object.hasOwn(kinds, runtime.role) || !exactKeys(runtime, ['kind', 'role', 'source']) ||
      !exactKeys(runtime.source, ['sourceImageId', 'recipeId', 'architecture', 'converterVersion', 'bootstrapGeneration']) ||
      volume.kind !== kinds[runtime.role as keyof typeof kinds]) return false;
  try { parseWorkerBackupRuntime({ version: 1, kind: 'incus-vm', source: runtime.source }); }
  catch { return false; }
  // A full manifest pins its authoring prefix. The private gzip decoder also
  // rejects descriptors whose core name cannot have any safe source prefix.
  const suffix = `-${volume.workerId}-${runtime.role}`;
  return prefix !== undefined ? volume.name === prefix + suffix
    : volume.name.endsWith(suffix) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume.name.slice(0, -suffix.length));
}

export function assertDockerVolumeName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)
  )
    throw new Error("Invalid Docker volume name in instance backup");
}

function validOptions(value: any): value is InstanceBackupOptions {
  return (
    value &&
    [
      "includeWorkers",
      "includeAgentData",
      "includeDockerVolumes",
      "includeLocalBackups",
      "includeLogs",
    ].every((key) => typeof value[key] === "boolean")
  );
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
}
function iso(value: unknown) {
  return bounded(value, 64) && Number.isFinite(Date.parse(value));
}
function safeId(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
}
function optionalId(value: unknown) {
  return value === undefined || safeId(value);
}
function sha(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function safeSize(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_BUNDLE_BYTES;
}
function count(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000_000;
}
