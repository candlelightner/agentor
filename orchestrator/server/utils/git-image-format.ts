import { createHash } from "node:crypto";
import { renderDefinitionDockerfile, type ImageDefinition } from "./image-catalog";

export const LEGACY_GIT_IMAGE_CATALOG_PATH = ".agentor/image-catalog.v1.json";
export const GIT_IMAGE_CATALOG_PATH = ".agentor/image-catalog.v2.json";
export const GIT_IMAGE_CATALOG_FORMAT = {
  schema: "https://agentor.dev/schemas/image-catalog/v2",
  version: 2,
  layout: {
    manifest: GIT_IMAGE_CATALOG_PATH,
    dockerfile: "images/<id>/Dockerfile",
    metadata: "images/<id>/metadata.json",
    context: "images/<id>/context/**",
  },
  notes: [
    "Catalog recovery is separate from workspace backups.",
    "Credentials and secret values are never part of this format.",
    "Version digests are immutable OCI references; context paths contain the original file bytes.",
  ],
} as const;

export interface GitCatalogEntry {
  id: string;
  name: string;
  description: string;
  baseImage: string;
  dockerfilePath: string;
  metadataPath: string;
  contextPrefix: string;
  definitionHash: string;
  versions: Array<{
    version: string;
    digest: string;
    baseImage: string;
    createdAt: string;
    promoted?: boolean;
    ghcr?: { reference: string; digest: string };
  }>;
  promotedVersion?: string;
  build?: {
    mode: "local" | "github-actions";
    workflow?: string;
    publishGhcr?: boolean;
  };
}
export interface GitCatalogManifest {
  schema: string;
  version: 1 | 2;
  generatedAt: string;
  entries: GitCatalogEntry[];
}
export type GitFileMap = Record<string, string>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function hashDefinition(
  value: Pick<
    ImageDefinition,
    "name" | "description" | "baseImage" | "dockerfileFragment" | "contextFiles" | "provisioning"
  >,
) {
  return createHash("sha256")
    .update(
      stable({
        name: value.name,
        description: value.description,
        baseImage: value.baseImage,
        dockerfileFragment: value.dockerfileFragment,
        contextFiles: [...value.contextFiles].sort((a, b) =>
          a.path.localeCompare(b.path),
        ),
        provisioning: value.provisioning || [],
      }),
    )
    .digest("hex");
}
function hashLegacyDefinition(
  value: Pick<
    ImageDefinition,
    "name" | "description" | "baseImage" | "dockerfileFragment" | "contextFiles"
  >,
) {
  return createHash("sha256")
    .update(
      stable({
        name: value.name,
        description: value.description,
        baseImage: value.baseImage,
        dockerfileFragment: value.dockerfileFragment,
        contextFiles: [...value.contextFiles].sort((a, b) =>
          a.path.localeCompare(b.path),
        ),
      }),
    )
    .digest("hex");
}
function safeId(id: string) {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(id))
    throw new Error("Catalog entry ID is invalid");
  return id;
}
function safeContext(path: string) {
  if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/.test(path))
    throw new Error("Catalog context path is invalid");
  return path;
}
const SECRET_MATERIAL_RE =
  /(?:\b(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)\b\s*[=:]\s*["']?[^\s"']{8,}|\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s"']{8,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,})/i;
function assertGitSafe(value: unknown) {
  const text = stable(value).replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/g, "");
  if (SECRET_MATERIAL_RE.test(text))
    throw new Error("Image catalog must not contain secret values");
}

export function serializeCatalog(
  definitions: ImageDefinition[],
  options: {
    buildMode: "local" | "github-actions";
    workflow?: string;
    publishGhcr?: boolean;
    ghcrByDigest?: Record<string, string>;
  },
): GitFileMap {
  const files: GitFileMap = {};
  const entries: GitCatalogEntry[] = definitions.map((definition) => {
    assertGitSafe({
      name: definition.name,
      description: definition.description,
      dockerfileFragment: definition.dockerfileFragment,
      provisioning: definition.provisioning,
      contextFiles: definition.contextFiles.map((file) => ({
        ...file,
        contentBase64: Buffer.from(file.contentBase64, "base64").toString("utf8"),
      })),
    });
    const id = safeId(definition.id),
      prefix = `images/${id}`;
    files[`${prefix}/Dockerfile`] = `${renderDefinitionDockerfile(definition)}\n`;
    const metadata = {
      id,
      name: definition.name,
      description: definition.description,
      baseImage: definition.baseImage,
      formatVersion: 2,
      dockerfileFragment: definition.dockerfileFragment,
      provisioning: definition.provisioning || [],
      contextFiles: definition.contextFiles.map(({ path, role, destination }) => ({ path, role: role || "asset", destination })),
    };
    files[`${prefix}/metadata.json`] = `${JSON.stringify(metadata, null, 2)}\n`;
    for (const context of definition.contextFiles)
      files[`${prefix}/context/${safeContext(context.path)}`] = Buffer.from(
        context.contentBase64,
        "base64",
      ).toString("base64");
    return {
      ...metadata,
      dockerfilePath: `${prefix}/Dockerfile`,
      metadataPath: `${prefix}/metadata.json`,
      contextPrefix: `${prefix}/context/`,
      definitionHash: hashDefinition(definition),
      promotedVersion: definition.promotedVersion,
      build: {
        mode: options.buildMode,
        workflow: options.workflow,
        publishGhcr: options.publishGhcr,
      },
      versions: definition.versions.map((v) => {
        const reference = options.ghcrByDigest?.[v.digest] || (v.runtimeImage?.startsWith("ghcr.io/") ? v.runtimeImage : undefined);
        if (
          reference &&
          !/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$/i.test(
            reference,
          )
        )
          throw Object.assign(new Error(
            "GHCR references must be immutable digest references",
          ), { statusCode: 400 });
        if (reference && reference.slice(reference.lastIndexOf('@') + 1).toLowerCase() !== v.digest.toLowerCase())
          throw Object.assign(new Error("GHCR reference digest must match the built image digest"), { statusCode: 400 });
        return {
          version: v.version,
          digest: v.digest,
          baseImage: v.baseImage,
          createdAt: v.createdAt,
          promoted: v.promoted,
          ...(reference ? { ghcr: { reference, digest: v.digest } } : {}),
        };
      }),
    };
  });
  const manifest: GitCatalogManifest = {
    schema: GIT_IMAGE_CATALOG_FORMAT.schema,
    version: 2,
    generatedAt: new Date().toISOString(),
    entries,
  };
  files[GIT_IMAGE_CATALOG_PATH] = `${JSON.stringify(manifest, null, 2)}\n`;
  return files;
}

export function parseCatalog(
  files: GitFileMap,
): Array<{
  remoteId: string;
  definition: Omit<
    ImageDefinition,
    "id" | "ownerId" | "createdAt" | "updatedAt"
  >;
  hash: string;
  build?: GitCatalogEntry["build"];
}> {
  const manifestPath = files[GIT_IMAGE_CATALOG_PATH]
    ? GIT_IMAGE_CATALOG_PATH
    : LEGACY_GIT_IMAGE_CATALOG_PATH;
  const raw = files[manifestPath];
  if (!raw)
    throw new Error(
      "Repository does not contain an Agentor image catalog manifest",
    );
  let manifest: GitCatalogManifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error("Image catalog manifest is invalid JSON");
  }
  if (
    !((manifest?.schema === "https://agentor.dev/schemas/image-catalog/v1" && manifest.version === 1) ||
      (manifest?.schema === GIT_IMAGE_CATALOG_FORMAT.schema && manifest.version === 2)) ||
    !Array.isArray(manifest.entries)
  )
    throw new Error("Unsupported image catalog format");
  return manifest.entries.map((entry) => {
    safeId(entry.id);
    const metadataRaw = files[entry.metadataPath],
      dockerfile = files[entry.dockerfilePath];
    if (!metadataRaw || !dockerfile)
      throw new Error(`Catalog entry ${entry.id} is incomplete`);
    const metadata = JSON.parse(metadataRaw);
    if (!dockerfile.startsWith(`FROM ${entry.baseImage}\n`))
      throw new Error(
        `Catalog entry ${entry.id} Dockerfile base does not match metadata`,
      );
    const contextMetadata = Array.isArray(metadata.contextFiles) ? metadata.contextFiles : [];
    const contextFiles = Object.entries(files)
      .filter(([p]) => p.startsWith(entry.contextPrefix))
      .map(([p, contentBase64]) => {
        const path = safeContext(p.slice(entry.contextPrefix.length));
        const detail = contextMetadata.find((value: any) => value?.path === path);
        return { path, contentBase64, ...(detail?.role ? { role: detail.role } : {}), ...(detail?.destination ? { destination: detail.destination } : {}) };
      });
    const fragmentWithTerminator = dockerfile.slice(
      `FROM ${entry.baseImage}\n`.length,
    );
    const definition = {
      name: String(metadata.name),
      description: String(metadata.description || ""),
      baseImage: String(metadata.baseImage),
      dockerfileFragment: metadata.formatVersion === 2 ? String(metadata.dockerfileFragment || "") : (fragmentWithTerminator.endsWith("\n")
        ? fragmentWithTerminator.slice(0, -1)
        : fragmentWithTerminator),
      contextFiles,
      ...(metadata.formatVersion === 2 && Array.isArray(metadata.provisioning)
        ? { provisioning: metadata.provisioning }
        : {}),
      versions: Array.isArray(entry.versions) ? entry.versions : [],
      promotedVersion: entry.promotedVersion,
    };
    if (manifest.version === 2 && `${renderDefinitionDockerfile(definition)}\n` !== dockerfile)
      throw new Error(`Catalog entry ${entry.id} Dockerfile integrity failed`);
    // v1 stored a digest which predates provisioning.  Keep using it to
    // authenticate the legacy bytes, but return the current canonical digest:
    // recovered definitions are persisted in the current shape and links are
    // compared with hashDefinition() on subsequent pulls.
    const integrityHash = manifest.version === 1
      ? hashLegacyDefinition(definition)
      : hashDefinition(definition);
    if (integrityHash !== entry.definitionHash)
      throw new Error(`Catalog entry ${entry.id} failed integrity validation`);
    return { remoteId: entry.id, definition, hash: hashDefinition(definition), build: entry.build };
  });
}
