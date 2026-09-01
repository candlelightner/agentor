import type { ImageDefinition, ImageVersion } from "./image-catalog";
import { useImageCatalogManager } from "./image-catalog";

/** Deliberately separate from manifest.json: definitions may contain a bounded
 * build context which is too large for the general manifest limit. */
export const WORKER_RECONSTRUCTION_SCHEMA_VERSION = 1 as const;
export const MAX_RECONSTRUCTION_BYTES = 300 * 1024 * 1024;

export type WorkerImageReconstruction =
  | { kind: "platform-default" }
  | {
      /** A per-worker/imported image has no reusable catalog definition. It
       * must never be mistaken for the platform default during a workspace-
       * only backup restore. */
      kind: "unmanaged";
      runtimeImage?: string;
      digest?: string;
    }
  | {
      kind: "custom";
      definitionId: string;
      version: string;
      digest: string;
      runtimeImage?: string;
      catalogSource?: {
        kind: "git";
        connectionId: string;
        remoteId: string;
        hash: string;
      };
      /** A secret-free recipe for a later catalog recovery/rebuild. */
      definition?: Pick<ImageDefinition, "name" | "description" | "baseImage" | "dockerfileFragment" | "contextFiles" | "provisioning" | "provisioningMode" | "pluginComposition">;
      imageVersion?: Pick<
        ImageVersion,
        "baseImage" | "baseDigest" | "provisioning" | "contextFiles" | "provisioningMode"
      > & Pick<ImageDefinition, "pluginComposition">;
    };

type CustomImageReconstruction = Extract<
  WorkerImageReconstruction,
  { kind: "custom" }
>;
type PortableImageDefinition = NonNullable<
  CustomImageReconstruction["definition"]
>;
type PortableImageVersion = NonNullable<
  CustomImageReconstruction["imageVersion"]
>;

export interface WorkerReconstruction {
  schemaVersion: typeof WORKER_RECONSTRUCTION_SCHEMA_VERSION;
  image: WorkerImageReconstruction;
  /** Names only; values are never reconstruction metadata. */
  requiredSecretNames: string[];
}

export function snapshotWorkerReconstruction(worker: { imageDefinitionId?: string; imageVersion?: string; imageDigest?: string; imageRuntimeReference?: string; importedImage?: string; imageId?: string }, definition?: ImageDefinition): WorkerReconstruction {
  if (!worker.imageDefinitionId || !worker.imageVersion || !worker.imageDigest) {
    const runtimeImage = worker.importedImage ?? worker.imageRuntimeReference;
    const digest = /^sha256:[0-9a-f]{64}$/i.test(worker.imageDigest ?? "")
      ? worker.imageDigest
      : /^sha256:[0-9a-f]{64}$/i.test(worker.imageId ?? "")
        ? worker.imageId
        : undefined;
    if (runtimeImage || worker.imageDefinitionId || worker.imageVersion || worker.imageDigest)
      return {
        schemaVersion: 1,
        image: {
          kind: "unmanaged",
          ...(runtimeImage ? { runtimeImage } : {}),
          ...(digest ? { digest } : {}),
        },
        requiredSecretNames: [],
      };
    return { schemaVersion: 1, image: { kind: "platform-default" }, requiredSecretNames: [] };
  }
  const version = definition?.versions.find((item) => item.version === worker.imageVersion);
  return {
    schemaVersion: 1,
    image: {
      kind: "custom", definitionId: worker.imageDefinitionId, version: worker.imageVersion,
      digest: worker.imageDigest, ...(worker.imageRuntimeReference ? { runtimeImage: worker.imageRuntimeReference } : {}),
      ...(definition?.gitRecovery
        ? {
            catalogSource: {
              kind: "git" as const,
              ...structuredClone(definition.gitRecovery),
            },
          }
        : {}),
      ...(definition ? { definition: recipe(definition) } : {}),
      ...(version && version.digest === worker.imageDigest ? { imageVersion: versionRecipe(version) } : {}),
    },
    requiredSecretNames: [],
  };
}

function recipe(value: ImageDefinition): PortableImageDefinition {
  return { name: value.name, description: value.description, baseImage: value.baseImage, dockerfileFragment: value.dockerfileFragment, contextFiles: structuredClone(value.contextFiles), ...(value.provisioning ? { provisioning: structuredClone(value.provisioning) } : {}), provisioningMode: value.provisioningMode, ...(value.pluginComposition ? { pluginComposition: structuredClone(value.pluginComposition) } : {}) };
}
function versionRecipe(value: ImageVersion): PortableImageVersion {
  return { baseImage: value.baseImage, ...(value.baseDigest ? { baseDigest: value.baseDigest } : {}), ...(value.provisioning ? { provisioning: structuredClone(value.provisioning) } : {}), ...(value.contextFiles ? { contextFiles: structuredClone(value.contextFiles) } : {}), ...(value.provisioningMode ? { provisioningMode: value.provisioningMode } : {}), ...(value.pluginComposition ? { pluginComposition: structuredClone(value.pluginComposition) } : {}) };
}

export function parseWorkerReconstruction(input: unknown): WorkerReconstruction {
  if (!record(input) || input.schemaVersion !== 1 || !Array.isArray(input.requiredSecretNames) || input.requiredSecretNames.some(safeNameNot)) invalid();
  const image = input.image;
  if (!record(image) || !["platform-default", "unmanaged", "custom"].includes(image.kind)) invalid();
  if (image.kind === "platform-default") return { schemaVersion: 1, image: { kind: "platform-default" }, requiredSecretNames: [...new Set(input.requiredSecretNames)].sort() };
  if (image.kind === "unmanaged") {
    if (
      (image.runtimeImage !== undefined && !safeString(image.runtimeImage)) ||
      (image.digest !== undefined && !/^sha256:[0-9a-f]{64}$/i.test(image.digest)) ||
      (image.runtimeImage === undefined && image.digest === undefined)
    ) invalid();
    return {
      schemaVersion: 1,
      image: {
        kind: "unmanaged",
        ...(image.runtimeImage ? { runtimeImage: image.runtimeImage } : {}),
        ...(image.digest ? { digest: image.digest } : {}),
      },
      requiredSecretNames: [...new Set(input.requiredSecretNames)].sort(),
    };
  }
  if (![image.definitionId, image.version, image.digest].every(safeString) || !/^sha256:[0-9a-f]{64}$/i.test(image.digest) || (image.runtimeImage !== undefined && !safeString(image.runtimeImage)) || (image.definition !== undefined && !record(image.definition)) || (image.imageVersion !== undefined && !record(image.imageVersion)) || (image.catalogSource !== undefined && !validCatalogSource(image.catalogSource))) invalid();
  // Reuse the catalog's secret scanner and controlled-build input validation
  // before accepting an untrusted recipe, even though import itself does not
  // rebuild it.
  // Do not preserve arbitrary archive-controlled fields.  The reconstruction
  // file is untrusted input and its embedded recipe may later be offered for
  // recovery, so return only the catalog's canonical safe representation.
  let definition: PortableImageDefinition | undefined;
  let imageVersion: PortableImageVersion | undefined;
  try {
    if (image.definition !== undefined)
      definition = useImageCatalogManager().validate(image.definition).definition;
    if (image.imageVersion !== undefined) {
      // A version recipe is an override of the definition's build inputs.
      // Validate it through the exact same controlled-build policy; empty
      // values inherit from the embedded definition when present.
      const source = image.definition ?? {};
      const candidate = {
        name: source.name ?? "Recovered worker image",
        description: source.description ?? "",
        baseImage: image.imageVersion.baseImage ?? source.baseImage,
        dockerfileFragment: source.dockerfileFragment ?? "",
        contextFiles: image.imageVersion.contextFiles ?? source.contextFiles,
        provisioning: image.imageVersion.provisioning ?? source.provisioning,
        provisioningMode: image.imageVersion.provisioningMode ?? source.provisioningMode,
        pluginComposition: image.imageVersion.pluginComposition ?? source.pluginComposition,
      };
      const validated = useImageCatalogManager().validate(candidate).definition;
      imageVersion = {
        baseImage: validated.baseImage,
        ...(validated.provisioning
          ? { provisioning: structuredClone(validated.provisioning) }
          : {}),
        ...(validated.contextFiles.length
          ? { contextFiles: structuredClone(validated.contextFiles) }
          : {}),
        provisioningMode: validated.provisioningMode,
        ...(validated.pluginComposition
          ? { pluginComposition: structuredClone(validated.pluginComposition) }
          : {}),
      };
    }
  } catch { invalid(); }
  return {
    schemaVersion: 1,
    image: {
      kind: "custom",
      definitionId: image.definitionId,
      version: image.version,
      digest: image.digest,
      ...(image.runtimeImage ? { runtimeImage: image.runtimeImage } : {}),
      ...(image.catalogSource ? { catalogSource: structuredClone(image.catalogSource) } : {}),
      ...(definition ? { definition } : {}),
      ...(imageVersion ? { imageVersion } : {}),
    },
    requiredSecretNames: [...new Set(input.requiredSecretNames)].sort(),
  };
}

export type ReconstructionResolution =
  | { state: "legacy" | "platform-default" | "resolved"; image?: { imageDefinitionId: string; imageVersion: string; imageDigest: string; imageRuntimeReference?: string } }
  | { state: "unresolved"; code: "IMAGE_DEPENDENCY_UNRESOLVED"; required: WorkerImageReconstruction };

/** Safe preflight used both by import and recovery UI/MCP inspection. */
export async function resolveWorkerReconstruction(userId: string, reconstruction?: WorkerReconstruction): Promise<ReconstructionResolution> {
  if (!reconstruction) return { state: "legacy" };
  if (reconstruction.image.kind === "platform-default") return { state: "platform-default" };
  if (reconstruction.image.kind === "unmanaged")
    return {
      state: "unresolved",
      code: "IMAGE_DEPENDENCY_UNRESOLVED",
      required: reconstruction.image,
    };
  const required = reconstruction.image;
  const catalog = useImageCatalogManager(); await catalog.init();
  const definitionIds = new Set([required.definitionId]);
  if (required.catalogSource) {
    for (const definition of catalog.list(userId, false))
      if (
        definition.gitRecovery?.remoteId === required.catalogSource.remoteId &&
        definition.gitRecovery.hash === required.catalogSource.hash
      )
        definitionIds.add(definition.id);
  }
  for (const definitionId of definitionIds) {
    try {
      const selected = catalog.resolveSelection(
        userId,
        definitionId,
        required.version,
      );
      if (selected && selected.digest === required.digest)
        return {
          state: "resolved",
          image: {
            imageDefinitionId: selected.definitionId,
            imageVersion: selected.version,
            imageDigest: selected.digest,
            ...(selected.runtimeImage
              ? { imageRuntimeReference: selected.runtimeImage }
              : {}),
          },
        };
    } catch {
      // A missing, incompatible, validating, or otherwise unusable local
      // version stays unresolved; never weaken catalog readiness semantics.
    }
  }
  // A captured runtime reference is useful diagnostic/recovery metadata, but
  // its syntax alone cannot prove that the destination can pull it or that the
  // local Docker daemon already has it. Git/catalog recovery must first adopt
  // the exact digest into the ordinary image catalog, preserving readiness and
  // ownership checks rather than failing later during worker creation.
  return { state: "unresolved", code: "IMAGE_DEPENDENCY_UNRESOLVED", required };
}

function record(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeString(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value); }
function validCatalogSource(value: unknown): boolean {
  if (!record(value) || value.kind !== "git") return false;
  return (
    typeof value.connectionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.connectionId,
    ) &&
    typeof value.remoteId === "string" &&
    /^[A-Za-z0-9._-]{1,100}$/.test(value.remoteId) &&
    typeof value.hash === "string" &&
    /^[0-9a-f]{64}$/.test(value.hash)
  );
}
function safeNameNot(value: unknown) { return !safeString(value) || String(value).length > 255; }
function invalid(): never { throw Object.assign(new Error("Invalid worker reconstruction metadata"), { statusCode: 400 }); }
