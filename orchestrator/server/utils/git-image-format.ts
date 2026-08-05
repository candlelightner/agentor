import { createHash } from "node:crypto";
import type { ImageDefinition } from "./image-catalog";

export const GIT_IMAGE_CATALOG_PATH = ".agentor/image-catalog.v1.json";
export const GIT_IMAGE_CATALOG_FORMAT = {
  schema: "https://agentor.dev/schemas/image-catalog/v1",
  version: 1,
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
  schema: typeof GIT_IMAGE_CATALOG_FORMAT.schema;
  version: 1;
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
    const id = safeId(definition.id),
      prefix = `images/${id}`;
    files[`${prefix}/Dockerfile`] =
      `FROM ${definition.baseImage}\n${definition.dockerfileFragment}\n`;
    const metadata = {
      id,
      name: definition.name,
      description: definition.description,
      baseImage: definition.baseImage,
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
    version: 1,
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
  const raw = files[GIT_IMAGE_CATALOG_PATH];
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
    manifest?.schema !== GIT_IMAGE_CATALOG_FORMAT.schema ||
    manifest.version !== 1 ||
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
    const contextFiles = Object.entries(files)
      .filter(([p]) => p.startsWith(entry.contextPrefix))
      .map(([p, contentBase64]) => ({
        path: safeContext(p.slice(entry.contextPrefix.length)),
        contentBase64,
      }));
    const fragmentWithTerminator = dockerfile.slice(
      `FROM ${entry.baseImage}\n`.length,
    );
    const definition = {
      name: String(metadata.name),
      description: String(metadata.description || ""),
      baseImage: String(metadata.baseImage),
      dockerfileFragment: fragmentWithTerminator.endsWith("\n")
        ? fragmentWithTerminator.slice(0, -1)
        : fragmentWithTerminator,
      contextFiles,
      versions: Array.isArray(entry.versions) ? entry.versions : [],
      promotedVersion: entry.promotedVersion,
    };
    const actual = hashDefinition(definition);
    if (actual !== entry.definitionHash)
      throw new Error(`Catalog entry ${entry.id} failed integrity validation`);
    return { remoteId: entry.id, definition, hash: actual, build: entry.build };
  });
}
