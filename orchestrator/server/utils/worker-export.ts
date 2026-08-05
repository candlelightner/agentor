import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import * as tar from 'tar-stream';
import type { Environment } from './environments';
import type { PortMapping } from './port-mapping-store';
import type { DomainMapping } from './domain-mapping-store';
import type { RepoConfig, MountConfig } from '../../shared/types';
import { AGENT_CREDENTIAL_MAPPINGS } from './user-credentials';
import { SHARED_DIRECTORY_MOUNT_POINTS } from './storage';

/** Bumped when the bundle layout changes incompatibly. */
export const WORKER_EXPORT_VERSION = 1;

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
export const CREDENTIAL_EXCLUDE_SUFFIXES = AGENT_CREDENTIAL_MAPPINGS.map((m) =>
  m.containerPath.startsWith(`${EXPORT_AGENTS_PATH}/`)
    ? m.containerPath.slice(EXPORT_AGENTS_PATH.length + 1)
    : m.containerPath,
);

/** The pre-shared-data Kilo auth path (`.kilo/data/auth.json`) is no longer a
 * bind mount target, but legacy per-worker volumes / export artifacts may
 * still carry it. Keep it stripped so an imported legacy agents tar never
 * resurrects a stale secret copy. */
export const LEGACY_KILO_AUTH_EXCLUDE_SUFFIX = '.kilo/data/auth.json';

/** Per-user directories bind-mounted inside the agents volume. Their contents
 * may contain secrets and belong to the account, not to one portable worker. */
export const SHARED_DATA_EXCLUDE_PREFIXES = [
  ...SHARED_DIRECTORY_MOUNT_POINTS,
  LEGACY_KILO_AUTH_EXCLUDE_SUFFIX,
];

/** File names inside the outer bundle tar. */
export const BUNDLE_FILES = {
  manifest: 'manifest.json',
  rootfs: 'rootfs.tar.gz',
  workspace: 'workspace.tar.gz',
  agents: 'agents.tar.gz',
} as const;

/** What a port mapping looks like once stripped of identity for re-creation. */
export type ExportedPortMapping = Pick<
  PortMapping,
  'externalPort' | 'type' | 'internalPort' | 'appType' | 'instanceId'
>;

export type ExportedDomainMapping = Pick<
  DomainMapping,
  'subdomain' | 'baseDomain' | 'path' | 'protocol' | 'wildcard' | 'internalPort'
>;

/** Import limits apply to the outer (already-compressed) bundle. They prevent a
 * hostile upload from creating arbitrary files or exhausting the data volume
 * before Docker ever sees it. Large legitimate worker exports remain supported. */
export const MAX_BUNDLE_ENTRY_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_BUNDLE_TOTAL_BYTES = 40 * 1024 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_INNER_ARCHIVE_BYTES = 100 * 1024 * 1024 * 1024;
export const MAX_INNER_ARCHIVE_ENTRIES = 1_000_000;

export interface WorkerExportManifest {
  version: number;
  exportedAt: string;
  /** Identity of the source worker (informational; not reused on import). */
  source: { id: string; displayName: string; containerName: string; imageName: string };
  /** The worker's own rebuild-time config, restored onto the new worker. */
  worker: { displayName: string; repos: RepoConfig[]; mounts: MountConfig[]; initScript: string };
  /** Full environment definition, embedded so the worker restores on a machine
   * that does not have the same environment. Matched/created on import. */
  environment: Environment;
  portMappings: ExportedPortMapping[];
  domainMappings: ExportedDomainMapping[];
  /** Which payloads the bundle contains. */
  contents: { rootfs: boolean; workspace: boolean; agents: boolean };
  /** Names only of worker-local secrets/files excluded from this bundle. */
  missingSecrets?: string[];
}

/** Pipe a readable through gzip into a file; return the written size in bytes. */
export async function writeGzipFile(src: NodeJS.ReadableStream, dest: string, signal?: AbortSignal): Promise<number> {
  await pipeline(src, createGzip(), createWriteStream(dest), { signal });
  return (await stat(dest)).size;
}

/** Re-pack an agents tar, dropping per-user files/directories, then gzip to a
 * file. Returns the written size. */
export async function writeFilteredAgentsGz(
  src: NodeJS.ReadableStream,
  dest: string,
  excludeSuffixes: string[],
  excludePrefixes: string[] = [],
  signal?: AbortSignal,
): Promise<number> {
  const extract = tar.extract();
  const pack = tar.pack();

  extract.on('entry', (header, stream, next) => {
    const relativeName = header.name
      .replace(/^\.?\//, '')
      .replace(/^\.agent-data\/?/, '');
    const excluded = excludeSuffixes.some((s) => relativeName.endsWith(s))
      || excludePrefixes.some((prefix) => relativeName === prefix || relativeName.startsWith(`${prefix}/`));
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

  const writeDone = pipeline(pack, createGzip(), createWriteStream(dest), { signal });
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
  workspacePath?: string;
  agentsPath?: string;
}

/** Scan a compressed tar before Docker extracts/imports it. Compressed-size
 * limits alone do not stop gzip bombs, so bound expanded bytes and entries and
 * reject paths that could escape an extraction root. */
export async function validateGzipTarPayload(
  filePath: string,
  maxExpandedBytes = MAX_INNER_ARCHIVE_BYTES,
  maxEntries = MAX_INNER_ARCHIVE_ENTRIES,
): Promise<void> {
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
      stream.resume();
      extract.destroy(new Error(
        entries > maxEntries
          ? 'Invalid worker export: archive contains too many entries'
          : 'Invalid worker export: archive contains an unsafe path',
      ));
      return;
    }
    stream.on('end', next);
    stream.resume();
  });
  await pipeline(createReadStream(filePath), createGunzip(), counter, extract);
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
      const limit = name === BUNDLE_FILES.manifest ? MAX_MANIFEST_BYTES : MAX_BUNDLE_ENTRY_BYTES;
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
    throw new Error(
      `Unsupported worker export: bundle version ${manifest.version} is newer than supported version ${WORKER_EXPORT_VERSION}`,
    );
  }

  for (const [key, file] of [
    ['rootfs', BUNDLE_FILES.rootfs],
    ['workspace', BUNDLE_FILES.workspace],
    ['agents', BUNDLE_FILES.agents],
  ] as const) {
    if (manifest.contents[key] !== present.has(file)) {
      throw new Error(`Invalid worker export: manifest contents.${key} does not match bundle payloads`);
    }
  }

  return {
    manifest,
    rootfsPath: present.has(BUNDLE_FILES.rootfs) ? join(destDir, BUNDLE_FILES.rootfs) : undefined,
    workspacePath: present.has(BUNDLE_FILES.workspace) ? join(destDir, BUNDLE_FILES.workspace) : undefined,
    agentsPath: present.has(BUNDLE_FILES.agents) ? join(destDir, BUNDLE_FILES.agents) : undefined,
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
  if (!isRecord(worker) || !isString(worker.displayName) || !isString(worker.initScript)
      || !Array.isArray(worker.repos) || !Array.isArray(worker.mounts)) {
    throw new Error('Invalid worker export: manifest.worker is invalid');
  }
  if (!worker.repos.every((repo) => isRecord(repo) && isString(repo.provider) && isString(repo.url)
      && (repo.branch === undefined || isString(repo.branch)))) {
    throw new Error('Invalid worker export: manifest.worker.repos is invalid');
  }
  if (!worker.mounts.every((mount) => isRecord(mount) && isString(mount.source) && isString(mount.target)
      && (mount.readOnly === undefined || typeof mount.readOnly === 'boolean'))) {
    throw new Error('Invalid worker export: manifest.worker.mounts is invalid');
  }
  if (!isRecord(value.environment) || !isString(value.environment.id) || !isString(value.environment.name)) {
    throw new Error('Invalid worker export: manifest.environment is invalid');
  }
  if (!Array.isArray(value.portMappings) || !Array.isArray(value.domainMappings)) {
    throw new Error('Invalid worker export: manifest mappings are invalid');
  }
  if (!value.portMappings.every((mapping) => isRecord(mapping)
      && Number.isInteger(mapping.externalPort) && Number.isInteger(mapping.internalPort)
      && (mapping.type === 'localhost' || mapping.type === 'external')
      && (mapping.appType === undefined || isString(mapping.appType))
      && (mapping.instanceId === undefined || isString(mapping.instanceId)))) {
    throw new Error('Invalid worker export: port mapping is invalid');
  }
  if (!isRecord(contents) || !['rootfs', 'workspace', 'agents'].every((k) => typeof contents[k] === 'boolean')) {
    throw new Error('Invalid worker export: manifest.contents is invalid');
  }
  if (value.missingSecrets !== undefined && (!Array.isArray(value.missingSecrets) || value.missingSecrets.length > 500 || value.missingSecrets.some((name) => typeof name !== 'string' || name.length < 1 || name.length > 255))) {
    throw new Error('Invalid worker export: manifest.missingSecrets is invalid');
  }

  // Older bundles may contain basic-auth credentials. Preserve import
  // compatibility but never propagate those credentials to restored mappings.
  value.domainMappings = value.domainMappings.map((mapping) => {
    if (!isRecord(mapping) || !isString(mapping.subdomain) || !isString(mapping.baseDomain)
        || !isString(mapping.path) || !['http', 'https', 'tcp'].includes(String(mapping.protocol))
        || typeof mapping.wildcard !== 'boolean' || !Number.isInteger(mapping.internalPort)) {
      throw new Error('Invalid worker export: domain mapping is invalid');
    }
    const { basicAuth: _secret, ...safe } = mapping;
    return safe;
  });
}
