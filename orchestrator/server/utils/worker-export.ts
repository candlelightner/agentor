import { createGzip, createGunzip, constants as zlibConstants } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { posix as posixPath } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import * as tar from 'tar-stream';
import type { Environment } from './environments';
import type { PortMapping } from './port-mapping-store';
import type { DomainMapping } from './domain-mapping-store';
import type { RepoConfig, MountConfig } from '../../shared/types';
import { AGENT_CREDENTIAL_MAPPINGS } from './user-credentials';
import { SHARED_DIRECTORY_MOUNT_POINTS } from './storage';
import type { PortablePluginConfiguration } from './plugin-portability';
import { MAX_RECONSTRUCTION_BYTES, parseWorkerReconstruction, type WorkerReconstruction } from './worker-reconstruction';

/** Bumped when the bundle layout changes incompatibly. */
export const WORKER_EXPORT_VERSION = 5;

/** Container paths whose contents are exported as separate volume tars (their
 * data lives in volumes, which `docker export` deliberately omits). */
export const EXPORT_WORKSPACE_PATH = '/workspace';
export const EXPORT_AGENTS_PATH = '/home/agent/.agent-data';
/** Parent dirs the volume tars are restored under (tar entries are prefixed
 * with the basename of the source path). */
export const RESTORE_WORKSPACE_PARENT = '/';
export const RESTORE_AGENTS_PARENT = '/home/agent';

/** Per-user OAuth credential files that live inside the agents dir as bind
 * mounts (the worker owner's secrets) — stripped from the agents tar on export
 * so an export never leaks another user's tokens.
 *
 * Derived from the single `AGENT_CREDENTIAL_MAPPINGS` registry (the source of
 * truth for credential paths) so adding a new agent there automatically extends
 * the export strip list — the two can never drift. Each entry is the agent's
 * container credential path with the agents-volume prefix removed, e.g.
 * `/home/agent/.agent-data/.claude/.credentials.json` → `.claude/.credentials.json`.
 * The export tars `/home/agent/.agent-data`, so tar entries are prefixed with
 * the `.agent-data/` basename and these suffixes match via `endsWith`. */
export const CREDENTIAL_EXCLUDE_SUFFIXES = AGENT_CREDENTIAL_MAPPINGS.map((m) => (m.containerPath.startsWith(`${EXPORT_AGENTS_PATH}/`) ? m.containerPath.slice(EXPORT_AGENTS_PATH.length + 1) : m.containerPath));

/** The pre-shared-data Kilo auth path (`.kilo/data/auth.json`) is no longer a
 * bind mount target, but legacy per-worker volumes / export artifacts may
 * still carry it. Keep it stripped so an imported legacy agents tar never
 * resurrects a stale secret copy. */
export const LEGACY_KILO_AUTH_EXCLUDE_SUFFIX = '.kilo/data/auth.json';

/** Per-user directories bind-mounted inside the agents volume. Their contents
 * may contain secrets and belong to the account, not to one portable worker. */
export const SHARED_DATA_EXCLUDE_PREFIXES = [...SHARED_DIRECTORY_MOUNT_POINTS, LEGACY_KILO_AUTH_EXCLUDE_SUFFIX];

/** File names inside the outer bundle tar. */
export const BUNDLE_FILES = {
  manifest: 'manifest.json',
  rootfs: 'rootfs.tar.gz',
  legacyRootfs: 'rootfs.tar',
  workspace: 'workspace.tar.gz',
  agents: 'agents.tar.gz',
  backupPaths: 'backup-paths.tar.gz',
  plugins: 'plugins.json',
  reconstruction: 'reconstruction.json',
} as const;

/** What a port mapping looks like once stripped of identity for re-creation. */
export type ExportedPortMapping = Pick<PortMapping, 'externalPort' | 'type' | 'internalPort' | 'appType' | 'instanceId'>;

export type ExportedDomainMapping = Pick<DomainMapping, 'subdomain' | 'baseDomain' | 'path' | 'protocol' | 'wildcard' | 'internalPort'>;

/** Import limits apply to the outer (already-compressed) bundle. They prevent a
 * hostile upload from creating arbitrary files or exhausting the data volume
 * before Docker ever sees it. Large legitimate worker exports remain supported. */
export const MAX_BUNDLE_ENTRY_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_BUNDLE_TOTAL_BYTES = 40 * 1024 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_PLUGIN_CONFIGURATION_BYTES = 16 * 1024 * 1024;
export const MAX_INNER_ARCHIVE_BYTES = 100 * 1024 * 1024 * 1024;
export const MAX_INNER_ARCHIVE_ENTRIES = 1_000_000;
/** The compressed backup-paths member contains several individual tar files.
 * Bound its aggregate expanded size before staging those files to prevent a
 * gzip bomb from bypassing the per-inner-archive limits. */
export const MAX_BACKUP_PATH_PAYLOAD_BYTES = MAX_INNER_ARCHIVE_BYTES;

export interface WorkerExportManifest {
  version: number;
  exportedAt: string;
  /** Identity of the source worker (informational; not reused on import). */
  source: {
    id: string;
    displayName: string;
    containerName: string;
    imageName: string;
  };
  /** The worker's own rebuild-time config, restored onto the new worker. */
  worker: {
    displayName: string;
    repos: RepoConfig[];
    mounts: MountConfig[];
    initScript: string;
  };
  /** Full environment definition, embedded so the worker restores on a machine
   * that does not have the same environment. Matched/created on import. */
  environment: Environment;
  portMappings: ExportedPortMapping[];
  domainMappings: ExportedDomainMapping[];
  /** Which payloads the bundle contains. */
  contents: { rootfs: boolean; workspace: boolean; agents: boolean; backupPaths?: boolean; plugins?: boolean; reconstruction?: boolean };
  /** Explicit, non-default absolute paths selected for a backup.  Their
   * archives are only present in backup bundles, never ordinary exports. */
  backupPaths?: Array<{ path: string; archive: string }>;
  /** Names only of worker-local secrets/files excluded from this bundle. */
  missingSecrets?: string[];
}

/** Pipe a readable through gzip into a file; return the written size in bytes. */
export async function writeGzipFile(src: NodeJS.ReadableStream, dest: string, signal?: AbortSignal): Promise<number> {
  // Root filesystem exports are routinely several GiB. The default level 6
  // made an otherwise-streaming export spend 30+ minutes compressing the
  // standard worker image. Level 1 keeps the same portable gzip/tar format and
  // import path while making the explicit advanced capture operationally
  // usable; disk limits still bound the resulting (slightly larger) artifact.
  if (existsSync('/usr/bin/pigz')) {
    const gzip = spawn('/usr/bin/pigz', ['-1', '-c'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    });
    let stderr = '';
    gzip.stderr.setEncoding('utf8');
    gzip.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    const exited = new Promise<void>((resolve, reject) => {
      gzip.once('error', reject);
      gzip.once('close', (code, childSignal) => (code === 0 ? resolve() : reject(new Error(`Parallel gzip failed${childSignal ? ` (${childSignal})` : ''}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))));
    });
    await Promise.all([pipeline(src, gzip.stdin, { signal }), pipeline(gzip.stdout, createWriteStream(dest), { signal }), exited]);
  } else {
    await pipeline(src, createGzip({ level: zlibConstants.Z_BEST_SPEED }), createWriteStream(dest), { signal });
  }
  return (await stat(dest)).size;
}

/** Re-pack an agents tar, dropping per-user files/directories, then gzip to a
 * file. Returns the written size. */
export async function writeFilteredAgentsGz(src: NodeJS.ReadableStream, dest: string, excludeSuffixes: string[], excludePrefixes: string[] = [], signal?: AbortSignal): Promise<number> {
  const extract = tar.extract();
  const pack = tar.pack();

  extract.on('entry', (header, stream, next) => {
    const relativeName = header.name.replace(/^\.?\//, '').replace(/^\.agent-data\/?/, '');
    const excluded = excludeSuffixes.some((s) => relativeName.endsWith(s)) || excludePrefixes.some((prefix) => relativeName === prefix || relativeName.startsWith(`${prefix}/`));
    if (excluded) {
      stream.on('end', next);
      stream.resume();
      return;
    }
    const entry = pack.entry(header, next);
    stream.pipe(entry);
  });
  extract.on('finish', () => pack.finalize());
  extract.on('error', (err) => pack.destroy(err));

  const writeDone = pipeline(pack, createGzip(), createWriteStream(dest), {
    signal,
  });
  // Drive src → extract with pipeline (not a bare .pipe) so a src error tears
  // down extract → pack and rejects, instead of hanging forever waiting for an
  // 'end'/'finish' that never comes.
  await Promise.all([pipeline(src, extract, { signal }), writeDone]);
  return (await stat(dest)).size;
}

/** Build the outer bundle tar as a readable stream, sourcing each entry from a
 * temp file (sizes are known via stat, so no buffering). */
export function packBundle(files: { name: string; path: string }[]): Readable {
  const pack = tar.pack();
  (async () => {
    for (const f of files) {
      const size = (await stat(f.path)).size;
      await new Promise<void>((resolve, reject) => {
        const entry = pack.entry({ name: f.name, size }, (err) => (err ? reject(err) : resolve()));
        createReadStream(f.path).pipe(entry);
      });
    }
    pack.finalize();
  })().catch((err) => pack.destroy(err instanceof Error ? err : new Error(String(err))));
  return pack;
}

/** Write the manifest JSON to a file. */
export async function writeManifest(manifest: WorkerExportManifest, dest: string): Promise<void> {
  // Domain basic-auth passwords are runtime credentials, not portable worker
  // configuration. Sanitize at the serialization boundary as defense in depth:
  // callers compiled against an older type cannot accidentally export them.
  const safeManifest = {
    ...manifest,
    domainMappings: manifest.domainMappings.map((mapping) => {
      const { basicAuth: _secret, ...safe } = mapping as ExportedDomainMapping & { basicAuth?: unknown };
      return safe;
    }),
  } as WorkerExportManifest;
  await writeFile(dest, JSON.stringify(safeManifest, null, 2));
}

export interface ExtractedBundle {
  manifest: WorkerExportManifest;
  /** Absolute paths to the extracted part files that were present. */
  rootfsPath?: string;
  rootfsCompressed?: boolean;
  workspacePath?: string;
  agentsPath?: string;
  backupPathsPath?: string;
  pluginConfigurationPath?: string;
  reconstructionPath?: string;
}

/** Scan a compressed tar before Docker extracts/imports it. Compressed-size
 * limits alone do not stop gzip bombs, so bound expanded bytes and entries and
 * reject paths that could escape an extraction root. */
export async function validateGzipTarPayload(filePath: string, maxExpandedBytes = MAX_INNER_ARCHIVE_BYTES, maxEntries = MAX_INNER_ARCHIVE_ENTRIES): Promise<void> {
  let expandedBytes = 0;
  let entries = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += Buffer.byteLength(chunk);
      if (expandedBytes > maxExpandedBytes) {
        callback(new Error('Invalid worker export: expanded archive exceeds the size limit'));
        return;
      }
      callback(null, chunk);
    },
  });
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    entries += 1;
    const name = header.name.replace(/\\/g, '/');
    const unsafe = name.includes('\0') || name.startsWith('/') || name.split('/').includes('..');
    if (entries > maxEntries || unsafe) {
      const error = new Error(entries > maxEntries ? 'Invalid worker export: archive contains too many entries' : 'Invalid worker export: archive contains an unsafe path');
      stream.on('end', () => next(error));
      stream.resume();
      return;
    }
    stream.on('end', next);
    stream.resume();
  });
  await pipeline(createReadStream(filePath), createGunzip(), counter, extract);
}

/** Validate an uncompressed tar payload. Version 2 stores Docker's already
 * streamed export verbatim: recompressing a multi-GiB base filesystem added
 * tens of minutes and substantial staging I/O without improving correctness. */
export async function validateTarPayload(filePath: string, maxExpandedBytes = MAX_INNER_ARCHIVE_BYTES, maxEntries = MAX_INNER_ARCHIVE_ENTRIES): Promise<void> {
  let expandedBytes = 0;
  let entries = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += Buffer.byteLength(chunk);
      callback(expandedBytes > maxExpandedBytes ? new Error('Invalid worker export: expanded archive exceeds the size limit') : null, chunk);
    },
  });
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    entries += 1;
    const name = header.name.replace(/\\/g, '/');
    const unsafe = name.includes('\0') || name.startsWith('/') || name.split('/').includes('..');
    if (entries > maxEntries || unsafe) {
      const error = new Error(entries > maxEntries ? 'Invalid worker export: archive contains too many entries' : 'Invalid worker export: archive contains an unsafe path');
      stream.on('end', () => next(error));
      stream.resume();
      return;
    }
    stream.on('end', next);
    stream.resume();
  });
  await pipeline(createReadStream(filePath), counter, extract);
}

/** Explicit backup paths can be restored under arbitrary absolute parents,
 * including intentionally selected authentication locations. Unlike ordinary
 * volume payloads, their archive must therefore contain only plain files and
 * directories: links, devices, and FIFOs could redirect Docker extraction
 * outside the recorded path even when member names themselves are safe. */
export async function validateBackupPathTarPayload(filePath: string): Promise<void> {
  let expandedBytes = 0;
  let entries = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += Buffer.byteLength(chunk);
      callback(expandedBytes > MAX_INNER_ARCHIVE_BYTES ? new Error('Invalid backup path archive: expanded archive exceeds the size limit') : null, chunk);
    },
  });
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    entries += 1;
    const name = header.name.replace(/\\/g, '/');
    const unsafeName = name.includes('\0') || name.startsWith('/') || name.split('/').includes('..');
    const safeType = header.type === 'file' || header.type === 'directory';
    // A regular entry has no meaningful link target. Reject it too, rather
    // than depending on tar implementation-specific link semantics.
    const hasLinkTarget = typeof header.linkname === 'string' && header.linkname.length > 0;
    if (entries > MAX_INNER_ARCHIVE_ENTRIES || unsafeName || !safeType || hasLinkTarget) {
      const error = new Error(entries > MAX_INNER_ARCHIVE_ENTRIES ? 'Invalid backup path archive: archive contains too many entries' : 'Invalid backup path archive: archive contains an unsafe entry');
      stream.on('end', () => next(error));
      stream.resume();
      return;
    }
    stream.on('end', next);
    stream.resume();
  });
  await pipeline(createReadStream(filePath), counter, extract);
}

/**
 * Re-pack an explicit absolute-path archive before it is persisted or restored.
 * Docker's getArchive() intentionally preserves links; rejecting all of them
 * makes normal selections such as `/` unusable (`/bin -> /usr/bin`).  The
 * sanitizer instead retains ordinary files, directories, and safe links while
 * making it impossible for a later member to write through a symlink. Device
 * nodes, FIFOs, sockets, and other special entries are omitted: they are not
 * portable worker data and must not be recreated by putArchive().
 */
export async function sanitizeBackupPathTarPayload(
  source: string,
  destination: string,
  selectedPath: string,
  signal?: AbortSignal,
): Promise<{ omittedSpecialEntries: number }> {
  if (!safeAbsoluteBackupPath(selectedPath))
    throw new Error("Invalid selected backup path");
  signal?.throwIfAborted();
  let expandedBytes = 0;
  let entries = 0;
  let omittedSpecialEntries = 0;
  const kinds = new Map<string, "file" | "directory" | "symlink" | "link">();
  const extract = tar.extract();
  const pack = tar.pack();
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += Buffer.byteLength(chunk);
      callback(
        expandedBytes > MAX_INNER_ARCHIVE_BYTES
          ? new Error("Invalid backup path archive: expanded archive exceeds the size limit")
          : null,
        chunk,
      );
    },
  });
  let failed: Error | undefined;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = error instanceof Error ? error : new Error(String(error));
    // The pipeline that observed the original error will reject. Destroy the
    // peer streams without re-emitting that error: tar-stream can otherwise
    // surface a second unhandled error from a nested `next()` callback.
    extract.destroy();
    pack.destroy();
  };
  extract.on("entry", (header, stream, next) => {
    entries += 1;
    try {
      if (entries > MAX_INNER_ARCHIVE_ENTRIES)
        throw new Error("Invalid backup path archive: archive contains too many entries");
      const type = backupEntryType(header.type);
      if (!type) {
        // Omit non-portable special entries. Consume their bodies so tar-stream
        // can continue parsing the trusted Docker archive.
        omittedSpecialEntries += 1;
        stream.on("end", next);
        stream.resume();
        return;
      }
      // Docker may represent getArchive("/") with a leading `.` directory.
      // It has no restoration value when putArchive targets `/`; omit that
      // one wrapper while retaining every real child member.
      if (selectedPath === "/" && type === "directory" && rootDirectoryMember(header.name)) {
        stream.on("end", next);
        stream.resume();
        return;
      }
      const name = archiveMemberName(header.name);
      assertBackupMemberWithinSelection(name, selectedPath);
      assertArchiveTreeSafe(kinds, name, type);
      const linkname = typeof header.linkname === "string" ? header.linkname : "";
      if (type === "symlink") assertSafeSymlinkTarget(linkname, selectedPath, name);
      if (type === "link") assertSafeHardlinkTarget(kinds, name, linkname);
      const uid = validatedArchiveOwnerId(header.uid, "uid");
      const gid = validatedArchiveOwnerId(header.gid, "gid");
      kinds.set(name, type);
      const safeHeader: tar.Headers = {
        name,
        type,
        size: type === "file" ? header.size : 0,
        mode: header.mode,
        mtime: header.mtime,
        ...(uid === undefined ? {} : { uid }),
        ...(gid === undefined ? {} : { gid }),
        ...(type === "symlink" || type === "link" ? { linkname } : {}),
      };
      const entry = pack.entry(safeHeader, (error) => {
        if (error) fail(error);
        next(error || undefined);
      });
      stream.on("error", fail);
      entry.on("error", fail);
      stream.pipe(entry);
    } catch (error) {
      stream.resume();
      fail(error);
    }
  });
  extract.on("finish", () => pack.finalize());
  extract.on("error", fail);
  pack.on("error", fail);
  try {
    await Promise.all([
      pipeline(createReadStream(source), counter, extract, { signal }),
      pipeline(pack, createWriteStream(destination, { mode: 0o600 }), { signal }),
    ]);
  } catch (error) {
    throw failed ?? error;
  }
  return { omittedSpecialEntries };
}

function validatedArchiveOwnerId(
  value: number | undefined,
  field: "uid" | "gid",
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new Error(`Invalid backup path archive: invalid ${field}`);
  return value;
}

/** Docker getArchive(path) preserves the selected resource as the top-level
 * tar member. Requiring that wrapper for non-root selections prevents a
 * crafted backup for `/a/selected` from writing a sibling below `/a` when it
 * is later passed to putArchive(`/a`). Root selection deliberately retains
 * its existing semantics: any safe relative member is allowed. */
function assertBackupMemberWithinSelection(name: string, selectedPath: string) {
  if (selectedPath === "/") return;
  const wrapper = posixPath.basename(selectedPath);
  if (name !== wrapper && !name.startsWith(`${wrapper}/`))
    throw new Error("Invalid backup path archive: entry is outside the selected path");
}

function archiveMemberName(value: string): string {
  const raw = value.replace(/\\/g, "/");
  if (raw.startsWith("/") || raw.includes("\0") || raw.split("/").includes(".."))
    throw new Error("Invalid backup path archive: archive contains an unsafe entry");
  const normalized = posixPath.normalize(raw).replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".")
    throw new Error("Invalid backup path archive: archive contains an unsafe entry");
  return normalized;
}

function rootDirectoryMember(value: string): boolean {
  return value.replace(/\\/g, "/").replace(/\/+$/, "") === ".";
}

function backupEntryType(value: unknown): "file" | "directory" | "symlink" | "link" | undefined {
  return value === "file" || value === "directory" || value === "symlink" || value === "link"
    ? value
    : undefined;
}

function assertArchiveTreeSafe(
  kinds: Map<string, "file" | "directory" | "symlink" | "link">,
  name: string,
  type: "file" | "directory" | "symlink" | "link",
) {
  if (kinds.has(name))
    throw new Error("Invalid backup path archive: duplicate entry");
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = kinds.get(parts.slice(0, index).join("/"));
    if (ancestor && ancestor !== "directory")
      throw new Error("Invalid backup path archive: entry traverses a non-directory");
  }
  for (const existing of kinds.keys())
    if (existing.startsWith(`${name}/`) && type !== "directory")
      throw new Error("Invalid backup path archive: entry replaces an existing parent");
}

function assertSafeSymlinkTarget(target: string, selectedPath: string, member: string) {
  if (!target || target.includes("\0") || target.includes("\\"))
    throw new Error("Invalid backup path archive: unsafe symlink target");
  const restoreParent = selectedPath === "/" ? "/" : posixPath.dirname(selectedPath);
  const memberPath = posixPath.join(restoreParent, member);
  const resolved = target.startsWith("/")
    ? resolveInsideRoot(target)
    : resolveInsideRoot(posixPath.join(posixPath.dirname(memberPath), target));
  if (!resolved)
    throw new Error("Invalid backup path archive: unsafe symlink target");
}

function resolveInsideRoot(value: string): string | undefined {
  const segments: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!segments.length) return undefined;
      segments.pop();
    } else segments.push(part);
  }
  return `/${segments.join("/")}`;
}

function assertSafeHardlinkTarget(
  kinds: Map<string, "file" | "directory" | "symlink" | "link">,
  name: string,
  target: string,
) {
  if (!target || target.startsWith("/") || target.includes("\0") || target.includes("\\"))
    throw new Error("Invalid backup path archive: unsafe hardlink target");
  const direct = tryArchiveRelative(target);
  const relative = tryArchiveRelative(posixPath.join(posixPath.dirname(name), target));
  const resolved = [direct, relative].find((candidate) => candidate && kinds.get(candidate) === "file");
  if (!resolved)
    throw new Error("Invalid backup path archive: hardlink target must be an earlier regular file in the archive");
}

function tryArchiveRelative(value: string): string | undefined {
  try { return archiveMemberName(value); } catch { return undefined; }
}

/** Extract the outer bundle tar into `destDir`, returning the parsed manifest
 * and the paths of any extracted payloads. */
export async function extractBundle(bundlePath: string, destDir: string): Promise<ExtractedBundle> {
  await mkdir(destDir, { recursive: true });
  const known = new Set<string>(Object.values(BUNDLE_FILES));
  const present = new Set<string>();
  let totalBytes = 0;
  const extract = tar.extract();

  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const name = header.name;
      if (!known.has(name)) {
        reject(new Error(`Invalid worker export: unexpected bundle entry "${name}"`));
        extract.destroy();
        return;
      }
      if (header.type !== 'file') {
        reject(new Error(`Invalid worker export: bundle entry "${name}" must be a regular file`));
        extract.destroy();
        return;
      }
      if (present.has(name)) {
        reject(new Error(`Invalid worker export: duplicate bundle entry "${name}"`));
        extract.destroy();
        return;
      }
      const size = header.size ?? 0;
      const limit = name === BUNDLE_FILES.manifest
        ? MAX_MANIFEST_BYTES
        : name === BUNDLE_FILES.plugins
          ? MAX_PLUGIN_CONFIGURATION_BYTES
          : name === BUNDLE_FILES.reconstruction
            ? MAX_RECONSTRUCTION_BYTES
          : MAX_BUNDLE_ENTRY_BYTES;
      if (!Number.isSafeInteger(size) || size < 0 || size > limit || totalBytes + size > MAX_BUNDLE_TOTAL_BYTES) {
        reject(new Error(`Invalid worker export: bundle entry "${name}" exceeds the size limit`));
        extract.destroy();
        return;
      }
      totalBytes += size;
      present.add(name);
      pipeline(stream, createWriteStream(join(destDir, name)))
        .then(() => next())
        .catch((err) => reject(err));
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    createReadStream(bundlePath).pipe(extract);
  });

  if (!present.has(BUNDLE_FILES.manifest)) {
    throw new Error('Invalid worker export: manifest.json missing');
  }
  const manifestRaw = await readFile(join(destDir, BUNDLE_FILES.manifest), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    throw new Error('Invalid worker export: manifest.json is not valid JSON');
  }
  assertValidManifest(parsed);
  const manifest = parsed;

  // Enforce the version gate the constant promises: reject a bundle produced by
  // a newer, incompatible exporter rather than silently restoring it with
  // mismatched semantics. Older versions (<= current) are still accepted.
  if (manifest.version > WORKER_EXPORT_VERSION) {
    throw new Error(`Unsupported worker export: bundle version ${manifest.version} is newer than supported version ${WORKER_EXPORT_VERSION}`);
  }

  const rootfsFile = present.has(BUNDLE_FILES.rootfs) ? BUNDLE_FILES.rootfs : present.has(BUNDLE_FILES.legacyRootfs) ? BUNDLE_FILES.legacyRootfs : undefined;
  if (present.has(BUNDLE_FILES.rootfs) && present.has(BUNDLE_FILES.legacyRootfs)) throw new Error('Invalid worker export: duplicate root filesystem payload');
  if (rootfsFile && ((manifest.version === 2 && rootfsFile !== BUNDLE_FILES.legacyRootfs) || (manifest.version !== 2 && rootfsFile !== BUNDLE_FILES.rootfs))) throw new Error(`Invalid worker export: root filesystem payload does not match bundle version ${manifest.version}`);
  for (const [key, filePresent] of [
    ['rootfs', Boolean(rootfsFile)],
    ['workspace', present.has(BUNDLE_FILES.workspace)],
    ['agents', present.has(BUNDLE_FILES.agents)],
    ['backupPaths', present.has(BUNDLE_FILES.backupPaths)],
    ['plugins', present.has(BUNDLE_FILES.plugins)],
    ['reconstruction', present.has(BUNDLE_FILES.reconstruction)],
  ] as const) {
    const declared = (manifest.contents as any)[key];
    const optionalAbsent = (key === 'backupPaths' || key === 'plugins' || key === 'reconstruction') && declared === undefined && !filePresent;
    if (declared !== filePresent && !optionalAbsent) {
      throw new Error(`Invalid worker export: manifest contents.${key} does not match bundle payloads`);
    }
  }

  return {
    manifest,
    rootfsPath: rootfsFile ? join(destDir, rootfsFile) : undefined,
    rootfsCompressed: rootfsFile === BUNDLE_FILES.rootfs,
    workspacePath: present.has(BUNDLE_FILES.workspace) ? join(destDir, BUNDLE_FILES.workspace) : undefined,
    agentsPath: present.has(BUNDLE_FILES.agents) ? join(destDir, BUNDLE_FILES.agents) : undefined,
    backupPathsPath: present.has(BUNDLE_FILES.backupPaths) ? join(destDir, BUNDLE_FILES.backupPaths) : undefined,
    pluginConfigurationPath: present.has(BUNDLE_FILES.plugins) ? join(destDir, BUNDLE_FILES.plugins) : undefined,
    reconstructionPath: present.has(BUNDLE_FILES.reconstruction) ? join(destDir, BUNDLE_FILES.reconstruction) : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Validate fields consumed by import before any Docker/container operation.
 * Unknown manifest fields remain tolerated for forward-compatible metadata,
 * while credentials from legacy exports are discarded below. */
function assertValidManifest(value: unknown): asserts value is WorkerExportManifest {
  if (!isRecord(value) || !Number.isInteger(value.version) || (value.version as number) < 1) {
    throw new Error('Invalid worker export: manifest.version is missing or invalid');
  }
  if (!isString(value.exportedAt) || !Number.isFinite(Date.parse(value.exportedAt))) {
    throw new Error('Invalid worker export: manifest.exportedAt is missing or invalid');
  }
  const source = value.source;
  const worker = value.worker;
  const contents = value.contents;
  if (!isRecord(source) || !['id', 'displayName', 'containerName', 'imageName'].every((k) => isString(source[k]))) {
    throw new Error('Invalid worker export: manifest.source is invalid');
  }
  if (!isRecord(worker) || !isString(worker.displayName) || !isString(worker.initScript) || !Array.isArray(worker.repos) || !Array.isArray(worker.mounts)) {
    throw new Error('Invalid worker export: manifest.worker is invalid');
  }
  if (!worker.repos.every((repo) => isRecord(repo) && isString(repo.provider) && isString(repo.url) && (repo.branch === undefined || isString(repo.branch)))) {
    throw new Error('Invalid worker export: manifest.worker.repos is invalid');
  }
  if (!worker.mounts.every((mount) => isRecord(mount) && isString(mount.source) && isString(mount.target) && (mount.readOnly === undefined || typeof mount.readOnly === 'boolean'))) {
    throw new Error('Invalid worker export: manifest.worker.mounts is invalid');
  }
  if (!isRecord(value.environment) || !isString(value.environment.id) || !isString(value.environment.name)) {
    throw new Error('Invalid worker export: manifest.environment is invalid');
  }
  if (!Array.isArray(value.portMappings) || !Array.isArray(value.domainMappings)) {
    throw new Error('Invalid worker export: manifest mappings are invalid');
  }
  if (!value.portMappings.every((mapping) => isRecord(mapping) && Number.isInteger(mapping.externalPort) && Number.isInteger(mapping.internalPort) && (mapping.type === 'localhost' || mapping.type === 'external') && (mapping.appType === undefined || isString(mapping.appType)) && (mapping.instanceId === undefined || isString(mapping.instanceId)))) {
    throw new Error('Invalid worker export: port mapping is invalid');
  }
  if (!isRecord(contents) || !['rootfs', 'workspace', 'agents'].every((k) => typeof contents[k] === 'boolean') || (contents.backupPaths !== undefined && typeof contents.backupPaths !== 'boolean') || (contents.plugins !== undefined && typeof contents.plugins !== 'boolean') || (contents.reconstruction !== undefined && typeof contents.reconstruction !== 'boolean')) {
    throw new Error('Invalid worker export: manifest.contents is invalid');
  }
  if (value.backupPaths !== undefined && (!Array.isArray(value.backupPaths) || value.backupPaths.length > 32 || new Set(value.backupPaths.map((entry: any) => entry?.path)).size !== value.backupPaths.length || new Set(value.backupPaths.map((entry: any) => entry?.archive)).size !== value.backupPaths.length || value.backupPaths.some((entry) => !isRecord(entry) || !isString(entry.path) || !safeAbsoluteBackupPath(entry.path) || !isString(entry.archive) || !/^paths\/[0-9]{1,2}\.tar$/.test(entry.archive)))) {
    throw new Error('Invalid worker export: manifest.backupPaths is invalid');
  }
  if (contents.backupPaths === true && !value.backupPaths?.length)
    throw new Error('Invalid worker export: manifest.backupPaths is missing');
  if (value.missingSecrets !== undefined && (!Array.isArray(value.missingSecrets) || value.missingSecrets.length > 500 || value.missingSecrets.some((name) => typeof name !== 'string' || name.length < 1 || name.length > 255))) {
    throw new Error('Invalid worker export: manifest.missingSecrets is invalid');
  }

  // Older bundles may contain basic-auth credentials. Preserve import
  // compatibility but never propagate those credentials to restored mappings.
  value.domainMappings = value.domainMappings.map((mapping) => {
    if (!isRecord(mapping) || !isString(mapping.subdomain) || !isString(mapping.baseDomain) || !isString(mapping.path) || !['http', 'https', 'tcp'].includes(String(mapping.protocol)) || typeof mapping.wildcard !== 'boolean' || !Number.isInteger(mapping.internalPort)) {
      throw new Error('Invalid worker export: domain mapping is invalid');
    }
    const { basicAuth: _secret, ...safe } = mapping;
    return safe;
  });
}

export async function writeWorkerReconstruction(path: string, reconstruction: WorkerReconstruction): Promise<number> {
  const payload = `${JSON.stringify(parseWorkerReconstruction(reconstruction))}\n`;
  const bytes = Buffer.byteLength(payload);
  if (bytes > MAX_RECONSTRUCTION_BYTES) throw Object.assign(new Error('Worker reconstruction metadata is too large'), { statusCode: 413 });
  await writeFile(path, payload, { mode: 0o600 });
  return bytes;
}

export async function readWorkerReconstruction(path: string): Promise<WorkerReconstruction> {
  const payload = await readFile(path);
  if (payload.byteLength > MAX_RECONSTRUCTION_BYTES) throw Object.assign(new Error('Worker reconstruction metadata is too large'), { statusCode: 400 });
  try { return parseWorkerReconstruction(JSON.parse(payload.toString('utf8'))); }
  catch (error) { if ((error as any)?.statusCode) throw error; throw Object.assign(new Error('Invalid worker reconstruction metadata'), { statusCode: 400 }); }
}

function safeAbsoluteBackupPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.includes('\0') && !path.includes('\\') && path.startsWith('/') && posixPath.normalize(path) === path;
}

/** Extract the individually archived selected paths from an additive backup
 * payload. Names are manifest-controlled fixed `paths/N.tar` entries; each
 * inner archive is subsequently validated before Docker receives it. */
export async function extractBackupPathArchives(payload: string, destDir: string, entries: Array<{ path: string; archive: string }>): Promise<Array<{ path: string; archivePath: string }>> {
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  const wanted = new Set(entries.map((entry) => entry.archive));
  const found = new Set<string>();
  const extract = tar.extract();
  let expandedBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += Buffer.byteLength(chunk);
      callback(
        expandedBytes > MAX_BACKUP_PATH_PAYLOAD_BYTES
          ? new Error('Invalid backup path payload: expanded archive exceeds the size limit')
          : null,
        chunk,
      );
    },
  });
  extract.on('entry', (header, stream, next) => {
    if (header.type !== 'file' || !wanted.has(header.name) || found.has(header.name) || !Number.isSafeInteger(header.size) || header.size! < 0 || header.size! > MAX_BUNDLE_ENTRY_BYTES) {
      stream.resume(); next(new Error('Invalid backup path payload')); return;
    }
    found.add(header.name);
    pipeline(stream, createWriteStream(join(destDir, header.name.replace('/', '-')), { mode: 0o600 }))
      .then(() => next(), (error) => next(error instanceof Error ? error : new Error(String(error))));
  });
  await pipeline(createReadStream(payload), createGunzip(), counter, extract);
  if (found.size !== wanted.size) throw new Error('Backup path payload is incomplete');
  return entries.map((entry) => ({ path: entry.path, archivePath: join(destDir, entry.archive.replace('/', '-')) }));
}
