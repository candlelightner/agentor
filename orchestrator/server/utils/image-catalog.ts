import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Docker from "dockerode";
import { pack } from "tar-stream";
import type { Readable } from "node:stream";
import type { PluginCommand } from "./plugin-manifest";

export type ImageBuildStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ImageProvisioningMode = "safe" | "advanced";
export type ImageReadiness =
  | "validating"
  | "ready"
  | "ready-with-warnings"
  | "built-incompatible"
  | "validation-unavailable";
export type ImageBuildOutcome =
  | "validation-pending"
  | "ready"
  | "ready-with-warnings"
  | "built-incompatible"
  | "validation-unavailable"
  | "build-failed"
  | "test-worker-ready"
  | "test-worker-failed"
  | "cancelled";
export interface ImageCompatibilityCheck {
  id: string;
  name: string;
  kind: "core" | "plugin";
  required: boolean;
  state: "passed" | "failed" | "warning" | "unavailable";
  /** Bounded, secret-redacted evidence only. */
  message: string;
  pluginDefinitionId?: string;
}
export interface ImageCompatibility {
  state: "pending" | "passed" | "warnings" | "incompatible" | "unavailable";
  coreState: "pending" | "passed" | "failed" | "unavailable";
  pluginState:
    "none" | "pending" | "passed" | "warnings" | "failed" | "unavailable";
  checks: ImageCompatibilityCheck[];
  requiredFailures: string[];
  warnings: string[];
  startedAt?: string;
  completedAt?: string;
  infrastructureError?: string;
}
export interface ImagePluginSelection {
  definitionId: string;
  validation: "required" | "optional";
}
export interface ImagePluginSnapshot extends ImagePluginSelection {
  name: string;
  definitionHash: string;
  provisioning?: ProvisioningStep[];
  contextFiles?: ContextFile[];
  validationCommand?: PluginCommand;
  requiresAdvancedProvisioning?: boolean;
}
export interface ImageProvisioningDiagnostic {
  code: "safe-mode-blocked" | "invalid-definition" | "invalid-build-context";
  blockedField: string;
  blockedStep?: { index: number; type: string };
  constraint: string;
  reason: string;
  remediation: string;
  advancedModeAvailable: boolean;
  advancedModeWarning?: string;
  dockerAttempted: false;
}
export interface ImageVersion {
  version: string;
  digest: string;
  baseImage: string;
  /** Content-addressed base actually used by the controlled build. */
  baseDigest?: string;
  createdAt: string;
  promoted?: boolean;
  /** Immutable runtime reference returned by the controlled builder. Fake test
   * builds intentionally leave this unset and run the standard worker image. */
  runtimeImage?: string;
  artifactTag?: string;
  recovered?: boolean;
  /** Immutable, secret-free source recipe that produced this version. */
  provisioning?: ProvisioningStep[];
  contextFiles?: ContextFile[];
  provisioningMode?: ImageProvisioningMode;
  pluginComposition?: ImagePluginSnapshot[];
  readiness?: ImageReadiness;
  compatibility?: ImageCompatibility;
}
export type ContextFile = {
  path: string;
  contentBase64: string;
  /** Assets are copied into the image; scripts can additionally be run by a
   * structured `script` provisioning step. */
  role?: "asset" | "script";
  /** Absolute, controlled destination in the derived image. */
  destination?: string;
};
export type ProvisioningStep =
  | { type: "packages"; manager: "apt" | "npm" | "pip"; packages: string[] }
  | { type: "command"; command: string }
  | {
      type: "script";
      path: string;
      interpreter: "sh" | "bash" | "python3" | "node";
    };
export interface ImageDefinition {
  id: string;
  ownerId: string;
  /** Absent for the owner/global catalog; set for a group-private catalog. */
  groupId?: string;
  name: string;
  description: string;
  baseImage: string;
  dockerfileFragment: string;
  contextFiles: ContextFile[];
  /** Ordered, server-rendered build recipe. Legacy fragments remain readable
   * for catalog/Git compatibility but new definitions should use this field. */
  provisioning?: ProvisioningStep[];
  /** Missing persisted values normalize to Safe mode. */
  provisioningMode: ImageProvisioningMode;
  /** Reusable plugin build contributions selected for this image. */
  pluginComposition?: ImagePluginSelection[];
  createdAt: string;
  updatedAt: string;
  versions: ImageVersion[];
  promotedVersion?: string;
  /** Durable server-minted provenance used only to reconcile a Git import
   * whose independent GitImageStore commit failed afterwards. */
  gitRecovery?: {
    connectionId: string;
    remoteId: string;
    hash: string;
  };
}
export interface ImageBuild {
  id: string;
  definitionId: string;
  ownerId: string;
  groupId?: string;
  operation?: "build" | "validation" | "test-worker";
  requestId?: string;
  requestFingerprint?: string;
  status: ImageBuildStatus;
  phase: string;
  progress?: number;
  outcome?: ImageBuildOutcome;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  digest?: string;
  baseDigest?: string;
  version?: string;
  error?: string;
  recovery?: string;
  logs: string[];
  builder: "fake" | "controlled";
  cache?: { enabled: boolean; hits: number };
  /** Mutable, orchestrator-owned tag used only for cleanup/inspection. Workers
   * are always launched from `ImageVersion.runtimeImage`, never this tag. */
  artifactTag?: string;
  dockerAttempted?: boolean;
  imageCreated?: boolean;
  validationStarted?: boolean;
  validationState?: ImageCompatibility["state"];
  compatibility?: ImageCompatibility;
  diagnostic?: ImageProvisioningDiagnostic;
  warnings?: string[];
  workerId?: string;
}
type ImageDefinitionSnapshot = Omit<ImageDefinition, "pluginComposition"> & {
  pluginComposition?: ImagePluginSnapshot[];
};
interface State {
  definitions: ImageDefinition[];
  builds: ImageBuild[];
  userDefaults: Record<string, { definitionId: string; version: string }>;
  systemDefault?: { definitionId: string; version: string };
  faults: Record<string, { failPhase?: string; message?: string }>;
  deletions: ImageDeletion[];
}
interface ImageDeletion {
  id: string;
  kind: "definition" | "version";
  definitionId: string;
  ownerId: string;
  version?: string;
  references: string[];
  createdAt: string;
}

const APPROVED_BASE_RE = /^agentor-worker:approved-[a-zA-Z0-9._-]+$/;
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const MAX_CONTEXT_FILE = 100 * 1024 * 1024;
const MAX_CONTEXT_TOTAL = 250 * 1024 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IMAGE_DELETE_TIMEOUT_MS = 30_000;
const MIN_BUILD_TIMEOUT_MS = 1_000;
const MAX_BUILD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN_FRAGMENT =
  /(^|\n)\s*(?:FROM|USER|ENTRYPOINT|CMD|ONBUILD|STOPSIGNAL|HEALTHCHECK|VOLUME|EXPOSE)\s|\bADD\s+https?:|docker\.sock|--mount\s*=\s*type=(?:bind|secret|ssh)|\bcurl\b.*\|\s*(?:sh|bash)|\bwget\b.*\|\s*(?:sh|bash)|\b(?:ENV|ARG)\b[^\n]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|\$\{?[^\s}]*?(?:TOKEN|SECRET|PASSWORD|API_KEY)/i;
const SECRET_VALUE =
  /(?:\b(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)\b\s*[=:]\s*["']?[^\s"']{8,}|\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s"']{8,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|IMAGE_BUILD_MUST_NEVER_LEAK)/i;
const SAFE_DESTINATION_RE =
  /^\/opt\/agentor-context\/(?!\.\.(?:\/|$))(?!.*\/\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const SAFE_PACKAGE_RE = /^[a-zA-Z0-9@._+:/=~^-]+$/;
const REDACT =
  /(?:\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s"'`]+|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[=:]\s*["']?[^\s"']+|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|IMAGE_BUILD_MUST_NEVER_LEAK[^\s]*)/gi;

function now() {
  return new Date().toISOString();
}
export type ImageCatalogError = Error & {
  statusCode?: number;
  code?: string;
  diagnostic?: ImageProvisioningDiagnostic;
};
function httpError(
  statusCode: number,
  message: string,
  details?: Pick<ImageCatalogError, "code" | "diagnostic">,
): never {
  const error = new Error(message) as ImageCatalogError;
  error.statusCode = statusCode;
  if (details?.code) error.code = details.code;
  if (details?.diagnostic) error.diagnostic = details.diagnostic;
  throw error;
}
export function imageCatalogErrorData(error: unknown) {
  const candidate = error as ImageCatalogError;
  return candidate?.diagnostic
    ? { code: candidate.code, diagnostic: candidate.diagnostic }
    : undefined;
}
function safeModeBlocked(
  blockedField: string,
  constraint: string,
  reason: string,
  remediation: string,
  blockedStep?: ImageProvisioningDiagnostic["blockedStep"],
): never {
  const diagnostic: ImageProvisioningDiagnostic = {
    code: "safe-mode-blocked",
    blockedField,
    ...(blockedStep ? { blockedStep } : {}),
    constraint,
    reason,
    remediation,
    advancedModeAvailable: true,
    advancedModeWarning:
      "Advanced mode permits unrestricted build-time shell behavior inside the controlled Docker/BuildKit build boundary. It may produce an unusable worker image, but it does not grant host authority, a raw Docker socket, an arbitrary base image, or a full Dockerfile.",
    dockerAttempted: false,
  };
  httpError(
    400,
    `Blocked by Safe mode at ${blockedField}. Docker was not attempted. Use the structured remediation in this response, or explicitly choose Advanced mode for intentional unrestricted build-time shell behavior.`,
    { code: "safe-mode-blocked", diagnostic },
  );
}
function invalidDefinition(
  blockedField: string,
  constraint: string,
  reason: string,
  remediation: string,
  message: string,
): never {
  httpError(400, `${message} Docker was not attempted.`, {
    code: "invalid-definition",
    diagnostic: {
      code: "invalid-definition",
      blockedField,
      constraint,
      reason,
      remediation,
      advancedModeAvailable: false,
      dockerAttempted: false,
    },
  });
}
function invalidBuildContext(
  blockedField: string,
  constraint: string,
  reason: string,
  remediation: string,
  message: string,
): never {
  httpError(400, `${message} Docker was not attempted.`, {
    code: "invalid-build-context",
    diagnostic: {
      code: "invalid-build-context",
      blockedField,
      constraint,
      reason,
      remediation,
      advancedModeAvailable: false,
      dockerAttempted: false,
    },
  });
}
function safeLog(value: string): string {
  return value
    .replace(/\/var\/run\/docker\.sock/gi, "[redacted-path]")
    .replace(REDACT, "[redacted]");
}
function safeBuildDiagnostic(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : String(error || "Unknown builder error");
  // Docker errors can contain multi-line transport details. Keep the useful
  // first line bounded and redact it before it becomes durable metadata.
  return (
    safeLog(message.replace(/[\r\n]+/g, " ").trim()).slice(0, 500) ||
    "Unknown builder error"
  );
}
function controlledBuildTimeoutMs() {
  const configured = Number(process.env.IMAGE_BUILD_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_BUILD_TIMEOUT_MS;
  return Math.min(
    MAX_BUILD_TIMEOUT_MS,
    Math.max(MIN_BUILD_TIMEOUT_MS, configured),
  );
}
function withBuildTimeout<T>(
  promise: Promise<T>,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${operation} timed out`));
    }, controlledBuildTimeoutMs());
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
function withImageDeleteTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Docker image cleanup timed out"));
    }, DEFAULT_IMAGE_DELETE_TIMEOUT_MS);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
function isDockerNotFound(error: unknown) {
  const candidate = error as {
    statusCode?: number;
    status?: number;
    reason?: string;
    message?: string;
  };
  return (
    candidate?.statusCode === 404 ||
    candidate?.status === 404 ||
    /(?:no such image|image not found)/i.test(
      `${candidate?.reason || ""} ${candidate?.message || ""}`,
    )
  );
}
function followDockerProgressBounded(
  docker: Docker,
  stream: NodeJS.ReadableStream,
  operation: string,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => {
      (stream as Readable).destroy();
      finish(new Error(`${operation} timed out`));
    }, controlledBuildTimeoutMs());
    docker.modem.followProgress(stream, finish);
  });
}
function publicBuild(build: ImageBuild) {
  const { logs: _logs, ...result } = build;
  return result;
}

export class ImageCatalogManager {
  private state: State = {
    definitions: [],
    builds: [],
    userDefaults: {},
    faults: {},
    deletions: [],
  };
  private initialized?: Promise<void>;
  private mutationChain = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private buildStreams = new Map<string, Readable>();
  private validationContainers = new Map<string, Docker.Container>();
  private definitionBuilds = new Map<string, Promise<void>>();
  private buildSettlers = new Map<string, () => void>();
  private docker = new Docker({ socketPath: "/var/run/docker.sock" });
  constructor(
    private dataDir: string,
    private readonly stateWriter?: (state: unknown) => Promise<void>,
  ) {}

  init(): Promise<void> {
    return (this.initialized ??= this.load());
  }
  private async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = normalizeState(
        JSON.parse(await readFile(this.path(), "utf8")),
      );
    } catch (error: any) {
      // A missing file is the only empty-catalog case. Treating a corrupt or
      // transiently unreadable catalog as empty would let the recovery write
      // below overwrite the last durable inventory and orphan built images.
      if (error?.code !== "ENOENT") throw error;
    }
    await this.mutate(() => {
      for (const build of this.state.builds)
        if (build.status === "queued" || build.status === "running") {
          build.status = "failed";
          build.phase = "failed";
          build.progress = 100;
          build.outcome = build.imageCreated
            ? "validation-unavailable"
            : build.operation === "test-worker"
              ? "test-worker-failed"
              : "build-failed";
          build.error = build.imageCreated
            ? "The image artifact was retained, but its operation was interrupted by an orchestrator restart. Compatibility validation can be retried."
            : "Image operation interrupted by orchestrator restart.";
          build.recovery = "restart-failed-safe";
          build.completedAt = build.updatedAt = now();
          if (
            build.imageCreated &&
            build.version &&
            build.operation !== "test-worker"
          ) {
            const version = this.state.definitions
              .find((definition) => definition.id === build.definitionId)
              ?.versions.find(
                (candidate) => candidate.version === build.version,
              );
            if (version) {
              version.readiness = "validation-unavailable";
              version.compatibility = {
                state: "unavailable",
                coreState: "unavailable",
                pluginState: "unavailable",
                checks: version.compatibility?.checks || [],
                requiredFailures: [],
                warnings: [],
                completedAt: now(),
                infrastructureError:
                  "Validation was interrupted by an orchestrator restart.",
              };
            }
          }
        }
    });
    for (const deletion of [...this.state.deletions])
      await this.finalizeDeletion(deletion.id);
  }
  private path() {
    return join(this.dataDir, "image-catalog.json");
  }
  private async writeState() {
    if (this.stateWriter) {
      await this.stateWriter(structuredClone(this.state));
      return;
    }
    const tmp = `${this.path()}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    await rename(tmp, this.path());
  }
  private mutate<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.mutationChain.then(async () => {
      const previous = structuredClone(this.state);
      try {
        const value = await operation();
        await this.writeState();
        return value;
      } catch (error) {
        this.restoreState(previous);
        throw error;
      }
    });
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private restoreState(previous: State) {
    const restoreObjects = <T extends { id: string }>(
      current: T[],
      saved: T[],
    ) =>
      saved.map((value) => {
        const existing = current.find((candidate) => candidate.id === value.id);
        if (!existing) return structuredClone(value);
        for (const key of Object.keys(existing) as Array<keyof T>)
          delete existing[key];
        Object.assign(existing, structuredClone(value));
        return existing;
      });
    this.state.definitions = restoreObjects(
      this.state.definitions,
      previous.definitions,
    );
    this.state.builds = restoreObjects(this.state.builds, previous.builds);
    this.state.userDefaults = structuredClone(previous.userDefaults);
    this.state.systemDefault = structuredClone(previous.systemDefault);
    this.state.faults = structuredClone(previous.faults);
    this.state.deletions = structuredClone(previous.deletions);
  }

  list(ownerId: string, admin: boolean) {
    return this.state.definitions.filter(
      // The owner dashboard must be able to inventory its group-private
      // definitions too. Group-admin credentials never call this method:
      // their MCP path is listForGroup(), which remains group-bound.
      (d) => admin || d.ownerId === ownerId,
    );
  }
  listForGroup(ownerId: string, groupId: string) {
    return this.state.definitions.filter(
      (d) => d.ownerId === ownerId && d.groupId === groupId,
    );
  }
  listForGroupHierarchy(
    ownerId: string,
    visibleGroupIds: Iterable<string>,
    manageableGroupIds: Iterable<string>,
  ) {
    const visible = new Set(visibleGroupIds);
    const manageable = new Set(manageableGroupIds);
    return this.state.definitions
      .filter(
        (d) => d.ownerId === ownerId && (!d.groupId || visible.has(d.groupId)),
      )
      .map((definition) => ({
        ...definition,
        access: {
          readable: true,
          usable: true,
          manageable:
            !!definition.groupId && manageable.has(definition.groupId),
          owningGroupId: definition.groupId,
        },
      }));
  }
  ownerIds() {
    return [
      ...new Set(
        this.state.definitions.map((definition) => definition.ownerId),
      ),
    ];
  }
  async forgetOwner(ownerId: string) {
    const deletionIds = await this.mutate(() => {
      const definitions = this.state.definitions.filter(
        (definition) => definition.ownerId === ownerId,
      );
      const ids = new Set(definitions.map((definition) => definition.id));
      for (const build of this.state.builds.filter(
        (candidate) => candidate.ownerId === ownerId,
      )) {
        if (build.status === "queued" || build.status === "running") {
          build.status = "cancelled";
          build.phase = "cancelled";
          build.completedAt = build.updatedAt = now();
        }
      }
      delete this.state.userDefaults[ownerId];
      for (const [userId, value] of Object.entries(this.state.userDefaults))
        if (ids.has(value.definitionId)) delete this.state.userDefaults[userId];
      if (
        this.state.systemDefault &&
        ids.has(this.state.systemDefault.definitionId)
      )
        this.state.systemDefault = undefined;
      delete this.state.faults[ownerId];
      const pending: string[] = [];
      for (const definition of definitions) {
        const existing = this.definitionDeletion(definition.id);
        if (existing) {
          pending.push(existing.id);
          continue;
        }
        const references = [
          ...definition.versions.map(
            (version) =>
              version.artifactTag ||
              (version.runtimeImage &&
              !version.runtimeImage.startsWith("ghcr.io/")
                ? version.runtimeImage
                : undefined),
          ),
          ...this.state.builds
            .filter((build) => build.definitionId === definition.id)
            .map((build) => build.artifactTag),
        ].filter((value): value is string => Boolean(value));
        const deletion: ImageDeletion = {
          id: randomUUID(),
          kind: "definition",
          definitionId: definition.id,
          ownerId,
          references: [...new Set(references)],
          createdAt: now(),
        };
        this.state.deletions.push(deletion);
        pending.push(deletion.id);
      }
      return pending;
    });
    const builds = this.state.builds.filter(
      (candidate) => candidate.ownerId === ownerId,
    );
    for (const build of builds) {
      const timer = this.timers.get(build.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(build.id);
      this.buildStreams.get(build.id)?.destroy();
      this.buildStreams.delete(build.id);
      this.buildSettlers.get(build.id)?.();
      this.buildSettlers.delete(build.id);
    }
    await Promise.all(
      [...new Set(builds.map((build) => build.definitionId))].map((id) =>
        this.definitionBuilds.get(id)?.catch(() => undefined),
      ),
    );
    for (const deletionId of deletionIds)
      await this.finalizeDeletion(deletionId);
    await this.mutate(() => {
      this.state.builds = this.state.builds.filter(
        (build) => build.ownerId !== ownerId,
      );
    });
  }
  private definitionRecord(id: string, ownerId: string, admin: boolean) {
    const item = this.state.definitions.find((d) => d.id === id);
    if (!item) httpError(404, "Image definition not found");
    if (!admin && item.ownerId !== ownerId) httpError(403, "Forbidden");
    return item;
  }
  private definitionDeletion(id: string) {
    return this.state.deletions.find(
      (deletion) =>
        deletion.kind === "definition" && deletion.definitionId === id,
    );
  }
  private versionDeletion(id: string, version: string) {
    return this.state.deletions.find(
      (deletion) =>
        deletion.kind === "version" &&
        deletion.definitionId === id &&
        deletion.version === version,
    );
  }
  private assertDefinitionAvailable(id: string) {
    if (this.definitionDeletion(id))
      httpError(409, "Image definition is being deleted");
  }
  private assertVersionAvailable(id: string, version: string) {
    this.assertDefinitionAvailable(id);
    if (this.versionDeletion(id, version))
      httpError(409, "Image version is being deleted");
  }
  private assertVersionReady(version: ImageVersion, action: string) {
    if (
      version.readiness === undefined ||
      version.readiness === "ready" ||
      version.readiness === "ready-with-warnings"
    )
      return;
    const reason =
      version.readiness === "validating"
        ? "Agentor compatibility validation is still running"
        : version.readiness === "built-incompatible"
          ? "the image was built but is incompatible with required Agentor checks"
          : "the image was built but compatibility validation is unavailable";
    httpError(409, `Cannot ${action}: ${reason}`);
  }
  definition(id: string, ownerId: string, admin: boolean) {
    const item = this.definitionRecord(id, ownerId, admin);
    this.assertDefinitionAvailable(id);
    return item;
  }
  async create(ownerId: string, input: any) {
    const cleaned = validateDefinition(input);
    await this.resolvePluginComposition(
      ownerId,
      undefined,
      cleaned.pluginComposition,
      cleaned.provisioningMode,
    );
    return this.mutate(() => {
      const stamp = now();
      const item: ImageDefinition = {
        id: randomUUID(),
        ownerId,
        ...cleaned,
        createdAt: stamp,
        updatedAt: stamp,
        versions: [],
      };
      this.state.definitions.push(item);
      return item;
    });
  }
  async update(id: string, ownerId: string, admin: boolean, input: any) {
    const cleaned = validateDefinition(input);
    const current = this.definition(id, ownerId, admin);
    if (current.groupId) httpError(404, "Image definition not found");
    await this.resolvePluginComposition(
      current.ownerId,
      undefined,
      cleaned.pluginComposition,
      cleaned.provisioningMode,
    );
    return this.mutate(() => {
      const item = this.definition(id, ownerId, admin);
      if (item.groupId) httpError(404, "Image definition not found");
      item.provisioning = undefined;
      item.pluginComposition = undefined;
      Object.assign(item, cleaned, { updatedAt: now() });
      return item;
    });
  }
  async createForGroup(ownerId: string, groupId: string, input: any) {
    const cleaned = validateDefinition(input);
    await this.resolvePluginComposition(
      ownerId,
      groupId,
      cleaned.pluginComposition,
      cleaned.provisioningMode,
    );
    return this.mutate(() => {
      const stamp = now();
      const item: ImageDefinition = {
        id: randomUUID(),
        ownerId,
        groupId,
        ...cleaned,
        createdAt: stamp,
        updatedAt: stamp,
        versions: [],
      };
      this.state.definitions.push(item);
      return item;
    });
  }
  definitionForGroup(id: string, ownerId: string, groupId: string) {
    const item = this.state.definitions.find(
      (d) => d.id === id && d.ownerId === ownerId && d.groupId === groupId,
    );
    if (!item) httpError(404, "Image definition not found");
    this.assertDefinitionAvailable(id);
    return item;
  }
  async updateForGroup(
    id: string,
    ownerId: string,
    groupId: string,
    input: any,
  ) {
    const cleaned = validateDefinition(input);
    await this.resolvePluginComposition(
      ownerId,
      groupId,
      cleaned.pluginComposition,
      cleaned.provisioningMode,
    );
    return this.mutate(() => {
      const item = this.definitionForGroup(id, ownerId, groupId);
      item.provisioning = undefined;
      item.pluginComposition = undefined;
      Object.assign(item, cleaned, { updatedAt: now() });
      return item;
    });
  }
  async importRecovered(
    ownerId: string,
    input: any,
    gitRecoveryInput?: ImageDefinition["gitRecovery"],
  ) {
    const cleaned = validateDefinition(input);
    const gitRecovery = normalizeGitRecovery(gitRecoveryInput);
    if (gitRecoveryInput && !gitRecovery)
      httpError(500, "Git recovery provenance is invalid");
    const versions: ImageVersion[] = (
      Array.isArray(input.versions) ? input.versions : []
    ).map((value: any) => {
      const digest = String(value?.digest || "");
      if (!/^sha256:[0-9a-f]{64}$/.test(digest))
        httpError(400, "Recovered image digest is invalid");
      const reference = value?.ghcr?.reference
        ? String(value.ghcr.reference)
        : "";
      if (
        reference &&
        (!/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$/i.test(
          reference,
        ) ||
          !reference.endsWith(`@${digest}`))
      )
        httpError(400, "Recovered GHCR reference is not pinned to its digest");
      return {
        version: String(value?.version || "").slice(0, 100),
        digest,
        baseImage: String(value?.baseImage || cleaned.baseImage),
        createdAt: Number.isFinite(Date.parse(value?.createdAt))
          ? new Date(value.createdAt).toISOString()
          : now(),
        promoted: Boolean(value?.promoted),
        runtimeImage: reference || undefined,
        recovered: true,
      };
    });
    if (
      versions.some((value) => !value.version) ||
      new Set(versions.map((value) => value.version)).size !== versions.length
    )
      httpError(400, "Recovered image versions are invalid");
    const stamp = now();
    const promotedVersion = versions.some(
      (value) => value.version === input.promotedVersion,
    )
      ? input.promotedVersion
      : undefined;
    const item: ImageDefinition = {
      id: randomUUID(),
      ownerId,
      ...cleaned,
      createdAt: stamp,
      updatedAt: stamp,
      versions,
      promotedVersion,
      ...(gitRecovery ? { gitRecovery } : {}),
    };
    return this.mutate(() => {
      this.state.definitions.push(item);
      return item;
    });
  }
  validate(input: unknown) {
    return { valid: true, definition: validateDefinition(input) };
  }
  async removeDefinition(id: string, ownerId: string, admin: boolean) {
    const deletion = await this.mutate(async () => {
      const item = this.definitionRecord(id, ownerId, admin);
      const pending = this.definitionDeletion(id);
      if (pending) return pending;
      if (
        this.definitionBuilds.has(id) ||
        this.state.builds.some(
          (build) =>
            build.definitionId === id &&
            (build.status === "queued" || build.status === "running"),
        ) ||
        Object.values(this.state.userDefaults).some(
          (value) => value.definitionId === id,
        ) ||
        this.state.systemDefault?.definitionId === id ||
        (
          await Promise.all(
            item.versions.map((version) =>
              this.workerUsesVersion(id, version.version),
            ),
          )
        ).some(Boolean)
      )
        httpError(409, "Image definition is referenced");
      const references = [
        ...item.versions.map(
          (version) => version.artifactTag || version.runtimeImage,
        ),
        ...this.state.builds
          .filter((build) => build.definitionId === id)
          .map((build) => build.artifactTag),
      ].filter((value): value is string => Boolean(value));
      const intent: ImageDeletion = {
        id: randomUUID(),
        kind: "definition",
        definitionId: id,
        ownerId: item.ownerId,
        references: [...new Set(references)],
        createdAt: now(),
      };
      this.state.deletions.push(intent);
      return intent;
    });
    await this.finalizeDeletion(deletion.id);
  }

  private async resolvePluginComposition(
    ownerId: string,
    groupId: string | undefined,
    selections: ImagePluginSelection[] | undefined,
    mode: ImageProvisioningMode,
  ): Promise<ImagePluginSnapshot[]> {
    if (!selections?.length) return [];
    const { usePluginDefinitionStore } = await import("./services");
    const store = usePluginDefinitionStore();
    await store.init();
    const snapshots: ImagePluginSnapshot[] = [];
    const destinations = new Set<string>();
    for (const [index, selection] of selections.entries()) {
      const plugin = store.getById(selection.definitionId);
      const visible =
        plugin &&
        (plugin.scope === "platform" ||
          (plugin.userId === ownerId &&
            (plugin.scope === "owner" ||
              (plugin.scope === "group" && plugin.groupId === groupId))));
      if (!visible || !plugin)
        httpError(404, "Selected plugin build contribution was not found");
      if (plugin.scope === "worker")
        httpError(400, "Worker-scoped plugins cannot be composed into images");
      const imageBuild = plugin.manifest.imageBuild;
      if (!imageBuild)
        httpError(
          400,
          `Plugin ${plugin.name} has no build-time image contribution`,
        );
      if (imageBuild.requiresAdvancedProvisioning && mode !== "advanced")
        safeModeBlocked(
          `pluginComposition[${index}]`,
          `plugin ${plugin.name} declares that its build contribution requires Advanced provisioning`,
          "Agentor never changes an image definition's provisioning mode on behalf of a plugin.",
          "Review the plugin contribution and explicitly change the image definition to Advanced mode if unrestricted build-time shell behavior is intentional.",
          { index, type: "plugin" },
        );
      const prefix = `plugins/${plugin.id}`;
      const contextFiles: ContextFile[] = (imageBuild.contextFiles || []).map(
        (file) => ({
          ...file,
          path: `${prefix}/${file.path}`,
        }),
      );
      const provisioning: ProvisioningStep[] = (
        imageBuild.provisioning || []
      ).map((step) =>
        step.type === "script"
          ? { ...step, path: `${prefix}/${step.path}` }
          : structuredClone(step),
      );
      validateProvisioning(
        provisioning,
        contextFiles,
        mode,
        `pluginComposition[${index}].provisioning`,
      );
      for (const file of contextFiles) {
        const destination =
          file.destination || defaultContextDestination(file.path);
        if (destinations.has(destination))
          httpError(400, "Plugin build-context destinations must not collide");
        destinations.add(destination);
      }
      snapshots.push({
        ...selection,
        name: plugin.name,
        definitionHash: plugin.definitionHash,
        ...(provisioning.length ? { provisioning } : {}),
        ...(contextFiles.length ? { contextFiles } : {}),
        ...(imageBuild.validation
          ? {
              validationCommand: structuredClone(imageBuild.validation.command),
            }
          : {}),
        ...(imageBuild.requiresAdvancedProvisioning
          ? { requiresAdvancedProvisioning: true }
          : {}),
      });
    }
    return snapshots;
  }

  async startBuild(
    id: string,
    ownerId: string,
    admin: boolean,
    input: any = {},
  ) {
    const builder = input.builder ?? "controlled";
    if (builder !== "fake" && builder !== "controlled")
      httpError(400, "Unknown image builder");
    if (
      builder === "fake" &&
      process.env.NODE_ENV === "production" &&
      process.env.ALLOW_FAKE_IMAGE_BUILDER !== "true"
    )
      httpError(403, "Fake builder is disabled in production");
    const requestId = normalizeRequestId(input.requestId);
    const current = this.definition(id, ownerId, admin);
    const requestedBase =
      input.baseImage === undefined
        ? current.baseImage
        : validateBaseImage(input.baseImage);
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          operation: "build",
          definitionId: id,
          builder,
          requestedBase:
            input.baseImage === undefined ? null : requestedBase,
        }),
      )
      .digest("hex");
    if (requestId) {
      const duplicate = this.state.builds.find(
        (candidate) =>
          candidate.ownerId === current.ownerId &&
          candidate.definitionId === id &&
          (candidate.operation || "build") === "build" &&
          candidate.requestId === requestId,
      );
      if (duplicate) {
        if (duplicate.requestFingerprint !== requestFingerprint)
          httpError(
            409,
            "requestId already identifies a different image build request",
          );
        return publicBuild(duplicate);
      }
    }
    // Alias resolution is a static preflight. Reject before a durable build is
    // admitted so an invalid approved-base alias cannot masquerade as an
    // attempted Docker/BuildKit failure.
    if (builder === "controlled") resolveControlledBase(requestedBase);
    const pluginSnapshots = await this.resolvePluginComposition(
      current.ownerId,
      current.groupId,
      current.pluginComposition,
      current.provisioningMode,
    );
    const combinedContext = [
      ...current.contextFiles.map((file) => ({ ...file })),
      ...pluginSnapshots.flatMap((plugin) =>
        (plugin.contextFiles || []).map((file) => ({ ...file })),
      ),
    ];
    assertCombinedContext(combinedContext);
    const { build, definition, snapshot } = await this.mutate(() => {
      if (this.definitionDeletion(id))
        httpError(409, "Image definition is being deleted");
      const definition = this.definition(id, ownerId, admin);
      if (requestId) {
        const duplicate = this.state.builds.find(
          (candidate) =>
            candidate.ownerId === definition.ownerId &&
            candidate.definitionId === id &&
            (candidate.operation || "build") === "build" &&
            candidate.requestId === requestId,
        );
        if (duplicate) {
          if (duplicate.requestFingerprint !== requestFingerprint)
            httpError(
              409,
              "requestId already identifies a different image build request",
            );
          return {
            build: duplicate,
            definition,
            snapshot: undefined,
          };
        }
      }
      const stamp = now();
      const build: ImageBuild = {
        id: randomUUID(),
        definitionId: id,
        ownerId: definition.ownerId,
        groupId: definition.groupId,
        operation: "build",
        ...(requestId ? { requestId, requestFingerprint } : {}),
        status: "queued",
        phase: "queued",
        progress: 0,
        dockerAttempted: false,
        imageCreated: false,
        createdAt: stamp,
        updatedAt: stamp,
        logs: [],
        builder,
      };
      this.state.builds.push(build);
      const snapshot: ImageDefinitionSnapshot = {
        ...definition,
        baseImage: requestedBase,
        contextFiles: combinedContext,
        provisioning: definition.provisioning?.map((step) =>
          structuredClone(step),
        ),
        pluginComposition: pluginSnapshots.map((plugin) =>
          structuredClone(plugin),
        ),
        versions: definition.versions.map((version) => ({ ...version })),
      };
      return { build, definition, snapshot };
    });
    if (!snapshot) return publicBuild(build);
    const previous = this.definitionBuilds.get(id) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        if (build.status === "cancelled") return;
        if (builder === "fake")
          await this.advance(build, definition, snapshot, input);
        else await this.advanceControlled(build, definition, snapshot);
      });
    this.definitionBuilds.set(id, execution);
    void execution.finally(() => {
      if (this.definitionBuilds.get(id) === execution)
        this.definitionBuilds.delete(id);
    });
    return publicBuild(build);
  }
  async startValidation(
    id: string,
    versionName: string,
    ownerId: string,
    admin: boolean,
    input: any = {},
  ) {
    const definition = this.definition(id, ownerId, admin);
    const requestId = normalizeRequestId(input.requestId);
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          operation: "validation",
          definitionId: id,
          version: versionName,
        }),
      )
      .digest("hex");
    if (requestId) {
      const duplicate = this.state.builds.find(
        (candidate) =>
          candidate.ownerId === definition.ownerId &&
          candidate.definitionId === id &&
          candidate.operation === "validation" &&
          candidate.requestId === requestId,
      );
      if (duplicate) {
        if (duplicate.requestFingerprint !== requestFingerprint)
          httpError(
            409,
            "requestId already identifies a different validation request",
          );
        return publicBuild(duplicate);
      }
    }
    const version = findVersion(definition, versionName);
    const reference = version.artifactTag || version.runtimeImage;
    if (!reference)
      httpError(409, "This version has no retained image artifact to validate");
    let createdJob = false;
    const build = await this.mutate(() => {
      if (requestId) {
        const duplicate = this.state.builds.find(
          (candidate) =>
            candidate.ownerId === definition.ownerId &&
            candidate.definitionId === id &&
            candidate.operation === "validation" &&
            candidate.requestId === requestId,
        );
        if (duplicate) {
          if (duplicate.requestFingerprint !== requestFingerprint)
            httpError(
              409,
              "requestId already identifies a different validation request",
            );
          return duplicate;
        }
      }
      const stamp = now();
      const job: ImageBuild = {
        id: randomUUID(),
        definitionId: id,
        ownerId: definition.ownerId,
        groupId: definition.groupId,
        operation: "validation",
        ...(requestId ? { requestId, requestFingerprint } : {}),
        status: "queued",
        phase: "queued",
        progress: 0,
        outcome: "validation-pending",
        digest: version.digest,
        version: version.version,
        artifactTag: version.artifactTag,
        dockerAttempted: false,
        imageCreated: true,
        validationState: "pending",
        createdAt: stamp,
        updatedAt: stamp,
        logs: [],
        builder: "controlled",
      };
      this.state.builds.push(job);
      createdJob = true;
      return job;
    });
    if (!createdJob) return publicBuild(build);
    const snapshot: ImageDefinitionSnapshot = {
      ...definition,
      contextFiles: version.contextFiles?.map((file) => ({ ...file })) || [],
      provisioning: version.provisioning?.map((step) => structuredClone(step)),
      provisioningMode: version.provisioningMode || definition.provisioningMode,
      pluginComposition: version.pluginComposition?.map((plugin) =>
        structuredClone(plugin),
      ),
      versions: definition.versions.map((entry) => ({ ...entry })),
    };
    const previous = this.definitionBuilds.get(id) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        if (build.status === "cancelled") return;
        const started = Date.now();
        try {
          const compatibility = await this.runCompatibilityValidation(
            build,
            version,
            snapshot,
            reference,
          );
          if ((build.status as ImageBuildStatus) !== "cancelled")
            await this.mutate(() =>
              this.applyCompatibility(build, version, compatibility, started),
            );
        } catch (error) {
          if ((build.status as ImageBuildStatus) !== "cancelled") {
            const diagnostic = safeBuildDiagnostic(error);
            await this.mutate(() => {
              const unavailable: ImageCompatibility = {
                state: "unavailable",
                coreState: "unavailable",
                pluginState: "unavailable",
                checks: [],
                requiredFailures: [],
                warnings: [],
                completedAt: now(),
                infrastructureError: `Agentor compatibility validation could not complete: ${diagnostic}`,
              };
              this.applyCompatibility(build, version, unavailable, started);
            });
          }
        }
      });
    this.definitionBuilds.set(id, execution);
    void execution.finally(() => {
      if (this.definitionBuilds.get(id) === execution)
        this.definitionBuilds.delete(id);
    });
    return publicBuild(build);
  }
  async startTestWorker(
    id: string,
    versionName: string,
    ownerId: string,
    admin: boolean,
    input: any = {},
  ) {
    const definition = this.definition(id, ownerId, admin);
    const requestId = normalizeRequestId(input.requestId);
    const requestedDisplayName =
      input.displayName === undefined ? null : String(input.displayName);
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          operation: "test-worker",
          definitionId: id,
          version: versionName,
          displayName: requestedDisplayName,
        }),
      )
      .digest("hex");
    if (requestId) {
      const duplicate = this.state.builds.find(
        (candidate) =>
          candidate.ownerId === definition.ownerId &&
          candidate.definitionId === id &&
          candidate.operation === "test-worker" &&
          candidate.requestId === requestId,
      );
      if (duplicate) {
        if (duplicate.requestFingerprint !== requestFingerprint)
          httpError(
            409,
            "requestId already identifies a different test-worker request",
          );
        return publicBuild(duplicate);
      }
    }
    const version = findVersion(definition, versionName);
    this.assertVersionReady(version, "create a test worker");
    if (!version.runtimeImage)
      httpError(
        409,
        "This version has no runnable image artifact; run a controlled build first",
      );
    const displayName = String(
      input.displayName || `${definition.name} smoke test`,
    ).slice(0, 100);
    let createdJob = false;
    const build = await this.mutate(() => {
      if (requestId) {
        const duplicate = this.state.builds.find(
          (candidate) =>
            candidate.ownerId === definition.ownerId &&
            candidate.definitionId === id &&
            candidate.operation === "test-worker" &&
            candidate.requestId === requestId,
        );
        if (duplicate) {
          if (duplicate.requestFingerprint !== requestFingerprint)
            httpError(
              409,
              "requestId already identifies a different test-worker request",
            );
          return duplicate;
        }
      }
      const stamp = now();
      const job: ImageBuild = {
        id: randomUUID(),
        definitionId: id,
        ownerId: definition.ownerId,
        groupId: definition.groupId,
        operation: "test-worker",
        ...(requestId ? { requestId, requestFingerprint } : {}),
        status: "queued",
        phase: "queued",
        progress: 0,
        digest: version.digest,
        version: version.version,
        dockerAttempted: false,
        imageCreated: true,
        createdAt: stamp,
        updatedAt: stamp,
        logs: [],
        builder: "controlled",
      };
      this.state.builds.push(job);
      createdJob = true;
      return job;
    });
    if (!createdJob) return publicBuild(build);
    const previous = this.definitionBuilds.get(id) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        if (build.status === "cancelled") return;
        const started = Date.now();
        try {
          await this.mutate(() => {
            build.status = "running";
            build.phase = "creating-test-worker";
            build.progress = 20;
            build.startedAt = build.updatedAt = now();
          });
          const { useContainerManager } = await import("./services");
          const worker = await useContainerManager().create({
            userId: definition.ownerId,
            displayName,
            imageDefinitionId: definition.id,
            imageVersion: version.version,
            imageDigest: version.digest,
            imageRuntimeReference: version.runtimeImage,
          });
          if ((build.status as ImageBuildStatus) === "cancelled") {
            await useContainerManager()
              .remove(worker.id)
              .catch(() => undefined);
            return;
          }
          await this.mutate(() => {
            build.status = "succeeded";
            build.phase = "completed";
            build.progress = 100;
            build.outcome = "test-worker-ready";
            build.workerId = worker.id;
            build.logs.push("Test worker created and running.");
            build.completedAt = build.updatedAt = now();
            build.durationMs = Date.now() - started;
          });
        } catch (error) {
          if ((build.status as ImageBuildStatus) !== "cancelled") {
            const diagnostic = safeBuildDiagnostic(error);
            await this.mutate(() => {
              build.status = "failed";
              build.phase = "failed";
              build.progress = 100;
              build.outcome = "test-worker-failed";
              build.error = `Test worker creation failed: ${diagnostic}`;
              build.logs.push(`[test-worker] ${diagnostic}`);
              build.completedAt = build.updatedAt = now();
              build.durationMs = Date.now() - started;
            });
          }
        }
      });
    this.definitionBuilds.set(id, execution);
    void execution.finally(() => {
      if (this.definitionBuilds.get(id) === execution)
        this.definitionBuilds.delete(id);
    });
    return publicBuild(build);
  }
  private async advanceControlled(
    build: ImageBuild,
    definition: ImageDefinition,
    snapshot: ImageDefinitionSnapshot,
  ) {
    const started = Date.now();
    const pendingProgressLogs: string[] = [];
    const version = `v${definition.versions.length + 1}`;
    const tag = `agentor-custom-${createHash("sha256").update(definition.ownerId).digest("hex").slice(0, 12)}-${definition.id.slice(0, 12)}:${version}-${build.id.slice(0, 8)}`;
    let builtVersion: ImageVersion | undefined;
    try {
      await this.mutate(() => {
        build.artifactTag = tag;
        build.status = "running";
        build.phase = "preflight";
        build.progress = 5;
        build.startedAt = build.updatedAt = now();
      });
      const configuredBase = resolveControlledBase(snapshot.baseImage);
      const pinnedBase = await this.resolvePinnedBase(configuredBase);
      await this.mutate(() => {
        build.baseDigest = pinnedBase.digest;
      });
      const dockerfile = renderDefinitionDockerfile(
        snapshot,
        pinnedBase.reference,
      );
      await this.mutate(() => {
        build.phase = "building";
        build.progress = 25;
        build.updatedAt = now();
      });
      const daemonInfo = await withBuildTimeout(
        this.docker.info(),
        "Docker builder information",
      );
      const supportsMemoryLimit = daemonInfo.MemoryLimit !== false;
      const supportsCpuQuota = daemonInfo.CPUCfsQuota !== false;
      const supportsConfiguredLimits = supportsMemoryLimit && supportsCpuQuota;
      if (!supportsConfiguredLimits) {
        await this.mutate(() => {
          build.logs.push(
            "Builder host cannot apply the configured cgroup limits; using the controlled platform boundary without cgroup limits.",
          );
        });
      }
      const runBuild = async (resourceLimits: boolean) => {
        // A build context is a one-shot stream. Recreate it for a controlled
        // retry rather than reusing an already-consumed tar stream.
        const context = pack();
        context.entry({ name: "Dockerfile", mode: 0o600 }, dockerfile);
        for (const file of snapshot.contextFiles)
          context.entry(
            { name: file.path, mode: 0o600 },
            Buffer.from(file.contentBase64, "base64"),
          );
        context.finalize();
        const options: Docker.ImageBuildOptions = {
          t: tag,
          rm: true,
          forcerm: true,
          networkmode: "default",
          ...(resourceLimits && supportsConfiguredLimits
            ? { memory: 2 * 1024 * 1024 * 1024 }
            : {}),
          ...(resourceLimits && supportsConfiguredLimits
            ? { cpuquota: 100000 }
            : {}),
          labels: {
            "agentor.image-definition": definition.id,
            "agentor.image-owner-hash": createHash("sha256")
              .update(definition.ownerId)
              .digest("hex"),
          },
        };
        await this.mutate(() => {
          build.dockerAttempted = true;
          build.progress = 35;
          build.updatedAt = now();
        });
        const stream = await withBuildTimeout(
          this.docker.buildImage(context as any, options),
          "Docker build startup",
        );
        this.buildStreams.set(build.id, stream as unknown as Readable);
        await new Promise<void>((resolve, reject) => {
          let daemonError: Error | undefined;
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            error ? reject(error) : resolve();
          };
          const timeout = setTimeout(() => {
            (stream as unknown as Readable).destroy();
            finish(new Error("Controlled image build timed out"));
          }, controlledBuildTimeoutMs());
          this.docker.modem.followProgress(
            stream,
            (error: Error | null) => finish(error || daemonError),
            (event: any) => {
              const daemonMessage = String(
                event?.errorDetail?.message || event?.error || "",
              );
              if (daemonMessage) daemonError = new Error(daemonMessage);
              const line = safeLog(
                String(event?.stream || event?.status || "").trim(),
              );
              if (line) pendingProgressLogs.push(line);
            },
          );
        });
      };
      try {
        await runBuild(true);
      } catch (error) {
        // Some nested-Docker hosts expose a threaded cgroup hierarchy where
        // the legacy build API cannot apply its per-build limits at all. The
        // controlled daemon boundary, policy validation, and context limits
        // still apply; retrying without unusable legacy cgroup flags keeps
        // builds functional there. Do not weaken limits for ordinary failures.
        if (!/cannot enter cgroupv2|cgroup configuration/i.test(String(error)))
          throw error;
        await this.removeControlledArtifact(tag);
        await this.mutate(() => {
          build.logs.push(...pendingProgressLogs.splice(0));
          build.logs.push(
            "Builder host cannot apply legacy cgroup limits; retrying with platform defaults.",
          );
          if (build.logs.length > 2000)
            build.logs.splice(0, build.logs.length - 2000);
        });
        await runBuild(false);
      }
      if ((build.status as ImageBuildStatus) === "cancelled") {
        await this.removeControlledArtifact(tag);
        return;
      }
      await this.mutate(() => {
        build.logs.push(...pendingProgressLogs.splice(0));
        if (build.logs.length > 2000)
          build.logs.splice(0, build.logs.length - 2000);
        build.phase = "recording-digest";
        build.progress = 65;
        build.updatedAt = now();
      });
      const image = await withBuildTimeout(
        this.docker.getImage(tag).inspect(),
        "Built image inspection",
      );
      const digest = /^sha256:[0-9a-f]{64}$/.test(image.Id)
        ? image.Id
        : `sha256:${createHash("sha256")
            .update(image.Id || tag)
            .digest("hex")}`;
      const stamp = now();
      await this.mutate(() => {
        builtVersion = {
          version,
          digest,
          runtimeImage: digest,
          artifactTag: tag,
          baseImage: snapshot.baseImage,
          baseDigest: pinnedBase.digest,
          provisioning: snapshot.provisioning?.map((step) =>
            structuredClone(step),
          ),
          contextFiles: snapshot.contextFiles.map((file) => ({ ...file })),
          provisioningMode: snapshot.provisioningMode,
          pluginComposition: snapshot.pluginComposition?.map((plugin) =>
            structuredClone(plugin),
          ),
          readiness: "validating",
          compatibility: this.pendingCompatibility(),
          createdAt: stamp,
        };
        definition.versions.push(builtVersion);
        definition.baseImage = snapshot.baseImage;
        definition.updatedAt = stamp;
        Object.assign(build, {
          status: "running",
          phase: "image-created",
          progress: 70,
          outcome: "validation-pending",
          imageCreated: true,
          digest,
          version,
          updatedAt: stamp,
          cache: {
            enabled: true,
            hits: definition.versions.length > 1 ? 1 : 0,
          },
        });
      });
      if (!builtVersion)
        throw new Error("Built image version was not recorded");
      const compatibility = await this.runCompatibilityValidation(
        build,
        builtVersion,
        snapshot,
        tag,
        image,
      );
      if (build.status !== "cancelled")
        await this.mutate(() =>
          this.applyCompatibility(build, builtVersion!, compatibility, started),
        );
    } catch (error) {
      if (!build.imageCreated) await this.removeControlledArtifact(tag);
      if (build.status !== "cancelled") {
        // Failures before Docker accepts the context (such as an unknown
        // approved-base alias) emit no progress event. Preserve a sanitized
        // diagnostic so this cannot look like an empty Dockerfile failure.
        const diagnostic = safeBuildDiagnostic(error);
        const terminalize = () => {
          build.logs.push(...pendingProgressLogs.splice(0));
          build.logs.push(`[builder] ${diagnostic}`);
          if (build.logs.length > 2000)
            build.logs.splice(0, build.logs.length - 2000);
          build.status = "failed";
          build.phase = "failed";
          build.progress = 100;
          build.outcome = build.imageCreated
            ? "validation-unavailable"
            : "build-failed";
          build.error = `Controlled image build failed: ${diagnostic}`;
          build.completedAt = build.updatedAt = now();
          build.durationMs = Date.now() - started;
        };
        try {
          await this.mutate(terminalize);
        } catch {
          // Persistence can fail while recording the terminal state. Never
          // leave the live execution running or the per-definition queue
          // wedged; restart recovery will fail the last durable running record.
          terminalize();
          build.recovery = "persistence-failed-safe";
        }
      }
    } finally {
      this.buildStreams.delete(build.id);
    }
  }
  private async resolvePinnedBase(configuredReference: string) {
    let image: Docker.ImageInspectInfo;
    try {
      image = await withBuildTimeout(
        this.docker.getImage(configuredReference).inspect(),
        "Approved base inspection",
      );
    } catch {
      let stream: NodeJS.ReadableStream;
      try {
        stream = await withBuildTimeout(
          this.docker.pull(configuredReference),
          "Approved base pull startup",
        );
        await followDockerProgressBounded(
          this.docker,
          stream,
          "Approved base pull",
        );
        image = await withBuildTimeout(
          this.docker.getImage(configuredReference).inspect(),
          "Approved base inspection",
        );
      } catch {
        httpError(500, "Approved image base could not be pinned safely");
      }
    }
    const digest = String(image.Id || "");
    if (!/^sha256:[0-9a-f]{64}$/.test(digest))
      httpError(500, "Approved image base could not be pinned safely");
    return { reference: digest, digest };
  }
  private async removeControlledArtifact(reference: string) {
    await withBuildTimeout(
      this.docker.getImage(reference).remove({ force: true }),
      "Controlled build artifact cleanup",
    ).catch(() => {});
  }
  private pendingCompatibility(): ImageCompatibility {
    return {
      state: "pending",
      coreState: "pending",
      pluginState: "pending",
      checks: [],
      requiredFailures: [],
      warnings: [],
      startedAt: now(),
    };
  }
  private async runCompatibilityValidation(
    build: ImageBuild,
    version: ImageVersion,
    snapshot: ImageDefinitionSnapshot,
    reference: string,
    image?: Docker.ImageInspectInfo,
  ): Promise<ImageCompatibility> {
    const startedAt = now();
    await this.mutate(() => {
      const pending = this.pendingCompatibility();
      pending.startedAt = startedAt;
      build.status = "running";
      build.phase = "validating";
      build.progress = 80;
      build.outcome = "validation-pending";
      build.validationStarted = true;
      build.validationState = "pending";
      build.compatibility = pending;
      version.readiness = "validating";
      version.compatibility = structuredClone(pending);
      build.logs.push(
        "[validation] Agentor compatibility validation started in an isolated, secret-free container.",
      );
      build.updatedAt = now();
    });
    const checks: ImageCompatibilityCheck[] = [];
    try {
      const inspected =
        image ||
        (await withBuildTimeout(
          this.docker.getImage(reference).inspect(),
          "Compatibility image inspection",
        ));
      const configuredUser = String(inspected.Config?.User || "");
      const configuredWorkdir = String(inspected.Config?.WorkingDir || "");
      const configuredEntrypoint = inspected.Config?.Entrypoint || [];
      const runtimeIntact =
        configuredUser === "agent" &&
        configuredWorkdir === "/workspace" &&
        configuredEntrypoint.includes("/home/agent/entrypoint.sh");
      checks.push({
        id: "core-runtime-config",
        name: "Agentor runtime image configuration",
        kind: "core",
        required: true,
        state: runtimeIntact ? "passed" : "failed",
        message: runtimeIntact
          ? "Runtime user, workspace, and Agentor entrypoint are intact."
          : "The derived image no longer declares Agentor's agent user, /workspace working directory, or worker entrypoint.",
      });
      const coreCommand = await this.runValidationCommand(
        build,
        reference,
        [
          "/bin/sh",
          "-lc",
          "id agent >/dev/null && test -d /workspace && test -x /home/agent/entrypoint.sh && test -x /home/agent/init.sh && command -v tmux >/dev/null && command -v agentor-management-mcp >/dev/null && command -v agentor-worker-mcp >/dev/null",
        ],
        "/workspace",
        60,
      );
      checks.push({
        id: "core-worker-contract",
        name: "Agentor worker bootstrap contract",
        kind: "core",
        required: true,
        state: coreCommand.passed ? "passed" : "failed",
        message: coreCommand.passed
          ? "Required worker bootstrap files, user, session tooling, and MCP bridges are available."
          : coreCommand.message,
      });
      for (const plugin of snapshot.pluginComposition || []) {
        if (!plugin.validationCommand || build.status === "cancelled") continue;
        const result = await this.runValidationCommand(
          build,
          reference,
          plugin.validationCommand.argv,
          plugin.validationCommand.cwd || "/workspace",
          plugin.validationCommand.timeoutSeconds || 30,
        );
        checks.push({
          id: `plugin-${plugin.definitionId}`,
          name: `${plugin.name} image capability`,
          kind: "plugin",
          required: plugin.validation === "required",
          state: result.passed
            ? "passed"
            : plugin.validation === "required"
              ? "failed"
              : "warning",
          message: result.passed
            ? "Plugin image check passed without runtime secrets or allocated resources."
            : result.message,
          pluginDefinitionId: plugin.definitionId,
        });
      }
    } catch (error) {
      if (build.status === "cancelled") throw error;
      const diagnostic = safeBuildDiagnostic(error);
      const unavailable: ImageCompatibility = {
        state: "unavailable",
        coreState: "unavailable",
        pluginState: "unavailable",
        checks,
        requiredFailures: [],
        warnings: [],
        startedAt,
        completedAt: now(),
        infrastructureError: `Agentor compatibility validation could not complete: ${diagnostic}`,
      };
      await this.mutate(() => {
        build.logs.push(`[validation] unavailable: ${diagnostic}`);
        if (build.logs.length > 2000)
          build.logs.splice(0, build.logs.length - 2000);
      });
      return unavailable;
    }
    const requiredFailures = checks
      .filter((check) => check.required && check.state === "failed")
      .map((check) => check.name);
    const warnings = checks
      .filter((check) => check.state === "warning")
      .map((check) => `${check.name}: ${check.message}`);
    const coreFailed = checks.some(
      (check) => check.kind === "core" && check.state === "failed",
    );
    const plugins = checks.filter((check) => check.kind === "plugin");
    const pluginRequiredFailed = plugins.some(
      (check) => check.required && check.state === "failed",
    );
    const compatibility: ImageCompatibility = {
      state:
        coreFailed || pluginRequiredFailed
          ? "incompatible"
          : warnings.length
            ? "warnings"
            : "passed",
      coreState: coreFailed ? "failed" : "passed",
      pluginState: plugins.length
        ? pluginRequiredFailed
          ? "failed"
          : warnings.length
            ? "warnings"
            : "passed"
        : "none",
      checks,
      requiredFailures,
      warnings,
      startedAt,
      completedAt: now(),
    };
    await this.mutate(() => {
      for (const check of checks)
        build.logs.push(
          `[validation] ${check.state}: ${check.name} — ${safeLog(check.message)}`,
        );
      if (build.logs.length > 2000)
        build.logs.splice(0, build.logs.length - 2000);
    });
    return compatibility;
  }
  private async runValidationCommand(
    build: ImageBuild,
    reference: string,
    argv: string[],
    workingDir: string,
    timeoutSeconds: number,
  ): Promise<{ passed: boolean; message: string }> {
    let container: Docker.Container | undefined;
    const run = async (resourceLimits: boolean) => {
      container = await this.docker.createContainer({
        Image: reference,
        Entrypoint: argv,
        Cmd: [],
        User: "agent",
        WorkingDir: workingDir,
        NetworkDisabled: true,
        AttachStdout: false,
        AttachStderr: false,
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          ...(resourceLimits
            ? {
                Memory: 512 * 1024 * 1024,
                NanoCpus: 500_000_000,
                PidsLimit: 256,
              }
            : {}),
          Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
        },
        Labels: {
          "agentor.image-validation": build.id,
          "agentor.image-definition": build.definitionId,
        },
      });
      this.validationContainers.set(build.id, container);
      try {
        await container.start();
        const wait = container.wait();
        const result = await new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(
            () => {
              void container?.kill().catch(() => undefined);
              reject(new Error("Compatibility check timed out"));
            },
            Math.max(1, Math.min(timeoutSeconds, 300)) * 1000,
          );
          wait.then(
            (value) => {
              clearTimeout(timeout);
              resolve(value);
            },
            (error) => {
              clearTimeout(timeout);
              reject(error);
            },
          );
        });
        const exitCode = Number(result?.StatusCode);
        return exitCode === 0
          ? { passed: true, message: "Check passed." }
          : {
              passed: false,
              message: `Compatibility command exited with code ${Number.isFinite(exitCode) ? exitCode : "unknown"}.`,
            };
      } finally {
        this.validationContainers.delete(build.id);
        await container.remove({ force: true }).catch(() => undefined);
        container = undefined;
      }
    };
    try {
      return await run(true);
    } catch (error) {
      // Nested Docker can expose a threaded cgroup v2 hierarchy in which OCI
      // cannot apply per-container legacy resource flags. Keep every actual
      // validation boundary (no network, read-only root, no capabilities,
      // no-new-privileges, bounded tmpfs) and retry only that known platform
      // incompatibility with the daemon's own resource defaults.
      if (
        !/cannot enter cgroupv2|cgroup configuration/i.test(String(error)) ||
        build.status === "cancelled"
      )
        throw error;
      await this.mutate(() => {
        build.logs.push(
          "Validator host cannot apply legacy cgroup limits; retrying inside the controlled validation boundary with platform defaults.",
        );
      });
      return await run(false);
    }
  }
  private applyCompatibility(
    build: ImageBuild,
    version: ImageVersion,
    compatibility: ImageCompatibility,
    started: number,
  ) {
    const stamp = now();
    version.compatibility = structuredClone(compatibility);
    build.compatibility = structuredClone(compatibility);
    build.validationState = compatibility.state;
    build.warnings = [...compatibility.warnings];
    if (compatibility.state === "passed") {
      version.readiness = "ready";
      build.status = "succeeded";
      build.outcome = "ready";
    } else if (compatibility.state === "warnings") {
      version.readiness = "ready-with-warnings";
      build.status = "succeeded";
      build.outcome = "ready-with-warnings";
    } else if (compatibility.state === "incompatible") {
      version.readiness = "built-incompatible";
      build.status = "succeeded";
      build.outcome = "built-incompatible";
      build.error =
        "The image was built, but required Agentor compatibility checks failed.";
    } else {
      version.readiness = "validation-unavailable";
      build.status = "failed";
      build.outcome = "validation-unavailable";
      build.error =
        compatibility.infrastructureError ||
        "The image was built, but Agentor compatibility validation could not complete.";
    }
    build.phase = "completed";
    build.progress = 100;
    build.completedAt = build.updatedAt = stamp;
    build.durationMs = Date.now() - started;
  }
  private advance(
    build: ImageBuild,
    definition: ImageDefinition,
    snapshot: ImageDefinitionSnapshot,
    input: any,
  ): Promise<void> {
    const duration = Math.max(
      100,
      Math.min(Number(input.fakeDurationMs) || 600, 30_000),
    );
    const phases = ["preflight", "building", "image-created", "validating"];
    let index = 0;
    let builtVersion: ImageVersion | undefined;
    const started = Date.now();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const timer = this.timers.get(build.id);
        if (timer) clearTimeout(timer);
        this.timers.delete(build.id);
        this.buildSettlers.delete(build.id);
        resolve();
      };
      const terminalize = async (error: unknown) => {
        try {
          await this.mutate(() => {
            if (build.status === "cancelled") return;
            const stamp = now();
            build.status = "failed";
            build.phase = "failed";
            build.progress = 100;
            build.outcome = "build-failed";
            build.error = "Controlled image build failed.";
            build.logs.push(
              safeLog(error instanceof Error ? error.message : String(error)),
            );
            build.completedAt = build.updatedAt = stamp;
            build.durationMs = Date.now() - started;
          });
        } catch {
          // The state writer may remain unavailable. The execution still has
          // to unwind so cancellation/deletion cannot wait forever; the last
          // durable queued/running record is failed safely during restart.
          if (build.status !== "cancelled") {
            const stamp = now();
            build.status = "failed";
            build.phase = "failed";
            build.progress = 100;
            build.outcome = "build-failed";
            build.error = "Controlled image build failed.";
            build.recovery = "persistence-failed-safe";
            build.completedAt = build.updatedAt = stamp;
            build.durationMs = Date.now() - started;
          }
        } finally {
          finish();
        }
      };
      const schedule = (delay: number) => {
        this.timers.set(
          build.id,
          setTimeout(() => void step().catch(terminalize), delay),
        );
      };
      this.buildSettlers.set(build.id, finish);
      const step = async () => {
        if (["cancelled", "failed"].includes(build.status)) {
          finish();
          return;
        }
        if (builtVersion) {
          const compatibility = fakeCompatibility(input.fakeValidationOutcome);
          await this.mutate(() =>
            this.applyCompatibility(
              build,
              builtVersion!,
              compatibility,
              started,
            ),
          );
          finish();
          return;
        }
        if (input.fakePauseUntilRestart) {
          await this.mutate(() => {
            build.status = "running";
            build.phase = "building";
            build.updatedAt = now();
          });
          schedule(100);
          return;
        }
        const phase = phases[index++];
        const fault = this.state.faults[build.ownerId];
        if (fault && fault.failPhase === phase) {
          const failureMessage = fault.message;
          await this.mutate(() => {
            build.status = "running";
            build.phase = phase!;
            build.startedAt ||= now();
            build.progress = Math.min(90, index * 22);
            build.updatedAt = now();
            build.logs.push(safeLog(`[fake-builder] ${phase}`));
            delete this.state.faults[build.ownerId];
            build.status = "failed";
            build.phase = "failed";
            build.progress = 100;
            build.outcome = "build-failed";
            build.error = "Controlled image build failed.";
            build.logs.push(safeLog(failureMessage || "failure"));
            build.completedAt = build.updatedAt = now();
            build.durationMs = Date.now() - started;
          });
          finish();
          return;
        }
        if (index < phases.length) {
          await this.mutate(() => {
            build.status = "running";
            build.phase = phase!;
            build.startedAt ||= now();
            build.updatedAt = now();
            build.logs.push(safeLog(`[fake-builder] ${phase}`));
          });
          schedule(duration / phases.length);
          return;
        }
        const digest = `sha256:${createHash("sha256").update(`${definition.id}:${snapshot.baseImage}:${snapshot.dockerfileFragment}:${now()}`).digest("hex")}`;
        const version = `v${definition.versions.length + 1}`;
        const stamp = now();
        await this.mutate(() => {
          build.status = "running";
          build.phase = phase!;
          build.startedAt ||= now();
          build.progress = Math.min(90, index * 22);
          build.updatedAt = now();
          build.logs.push(safeLog(`[fake-builder] ${phase}`));
          builtVersion = {
            version,
            digest,
            baseImage: snapshot.baseImage,
            provisioning: snapshot.provisioning?.map((entry) =>
              structuredClone(entry),
            ),
            contextFiles: snapshot.contextFiles.map((entry) => ({ ...entry })),
            provisioningMode: snapshot.provisioningMode,
            pluginComposition: snapshot.pluginComposition?.map((entry) =>
              structuredClone(entry),
            ),
            readiness: "validating",
            compatibility: this.pendingCompatibility(),
            createdAt: stamp,
          };
          definition.versions.push(builtVersion);
          definition.baseImage = snapshot.baseImage;
          definition.updatedAt = stamp;
          Object.assign(build, {
            status: "running",
            phase: "validating",
            progress: 90,
            outcome: "validation-pending",
            validationStarted: true,
            validationState: "pending",
            digest,
            version,
            updatedAt: stamp,
            cache: {
              enabled: true,
              hits: definition.versions.length > 1 ? 1 : 0,
            },
          });
        });
        // Persist an observable validation-pending state before applying the
        // fake result. Real controlled builds naturally spend time in this
        // phase; the deterministic fake builder must expose the same durable
        // state to REST, UI, and MCP pollers.
        schedule(duration / phases.length);
      };
      schedule(0);
    });
  }
  build(id: string, ownerId: string, admin: boolean) {
    const b = this.state.builds.find((x) => x.id === id);
    if (!b) httpError(404, "Build not found");
    if (!admin && b.ownerId !== ownerId) httpError(403, "Forbidden");
    return b;
  }
  buildForGroup(id: string, ownerId: string, groupId: string) {
    const build = this.state.builds.find(
      (candidate) =>
        candidate.id === id &&
        candidate.ownerId === ownerId &&
        candidate.groupId === groupId,
    );
    if (!build) httpError(404, "Build not found");
    return build;
  }
  async cancelBuild(id: string, ownerId: string, admin: boolean) {
    const b = await this.mutate(() => {
      const build = this.build(id, ownerId, admin);
      if (!["queued", "running"].includes(build.status)) return build;
      clearTimeout(this.timers.get(id));
      this.buildStreams.get(id)?.destroy();
      void this.validationContainers
        .get(id)
        ?.kill()
        .catch(() => undefined);
      build.status = "cancelled";
      build.phase = "cancelled";
      build.progress = 100;
      build.outcome = "cancelled";
      build.completedAt = build.updatedAt = now();
      if (
        build.imageCreated &&
        build.version &&
        build.operation !== "test-worker"
      ) {
        const definition = this.state.definitions.find(
          (candidate) => candidate.id === build.definitionId,
        );
        const version = definition?.versions.find(
          (candidate) => candidate.version === build.version,
        );
        if (version?.readiness === "validating") {
          version.readiness = "validation-unavailable";
          version.compatibility = {
            state: "unavailable",
            coreState: "unavailable",
            pluginState: "unavailable",
            checks: version.compatibility?.checks || [],
            requiredFailures: [],
            warnings: [],
            completedAt: now(),
            infrastructureError: "Compatibility validation was cancelled.",
          };
        }
      }
      return build;
    });
    if (!["cancelled"].includes(b.status)) return publicBuild(b);
    this.buildSettlers.get(id)?.();
    this.buildSettlers.delete(id);
    // Persist and signal promptly. The serialized execution promise owns its
    // existing cleanup/finally path; callers can poll the already-terminal job
    // without waiting for Docker/BuildKit or validation teardown.
    void this.definitionBuilds.get(b.definitionId)?.catch(() => undefined);
    return publicBuild(b);
  }
  logs(id: string, ownerId: string, admin: boolean, after = 0) {
    return this.build(id, ownerId, admin)
      .logs.slice(Math.max(0, after))
      .map(safeLog)
      .join("\n");
  }
  logPage(
    id: string,
    ownerId: string,
    admin: boolean,
    afterOrOptions: number | { after?: number; limit?: number } = 0,
    limit = 200,
  ) {
    const build = this.build(id, ownerId, admin);
    const after =
      typeof afterOrOptions === "object"
        ? Number(afterOrOptions.after || 0)
        : afterOrOptions;
    if (typeof afterOrOptions === "object")
      limit = Number(afterOrOptions.limit || limit);
    const cursor = Math.max(0, Math.min(Number(after) || 0, build.logs.length));
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    const entries = build.logs
      .slice(cursor, cursor + boundedLimit)
      .map(safeLog);
    return {
      entries,
      logs: entries.join("\n"),
      after: cursor,
      nextAfter: cursor + entries.length,
      nextCursor: cursor + entries.length,
      hasMore: cursor + entries.length < build.logs.length,
      phase: build.phase,
    };
  }
  publicBuild(id: string, ownerId: string, admin: boolean) {
    return publicBuild(this.build(id, ownerId, admin));
  }
  publicBuilds(ownerId: string, admin: boolean) {
    return this.state.builds
      .filter((build) => admin || build.ownerId === ownerId)
      .slice(-50)
      .reverse()
      .map(publicBuild);
  }

  async promote(id: string, version: string, ownerId: string, admin: boolean) {
    return this.mutate(() => {
      const d = this.definition(id, ownerId, admin);
      this.assertVersionAvailable(id, version);
      const v = findVersion(d, version);
      this.assertVersionReady(v, "promote this version");
      d.promotedVersion = version;
      for (const item of d.versions) item.promoted = item.version === version;
      return { promotedVersion: version, promotedDigest: v.digest };
    });
  }
  async rollback(id: string, version: string, ownerId: string, admin: boolean) {
    return this.promote(id, version, ownerId, admin);
  }
  async deleteVersion(
    id: string,
    version: string,
    ownerId: string,
    admin: boolean,
  ) {
    const deletion = await this.mutate(async () => {
      const d = this.definitionRecord(id, ownerId, admin);
      this.assertDefinitionAvailable(id);
      const pending = this.versionDeletion(id, version);
      if (pending) return pending;
      const removed = findVersion(d, version);
      if (
        d.promotedVersion === version ||
        Object.values(this.state.userDefaults).some(
          (value) => value.definitionId === id && value.version === version,
        ) ||
        (this.state.systemDefault?.definitionId === id &&
          this.state.systemDefault.version === version) ||
        (await this.workerUsesVersion(id, version))
      )
        httpError(409, "Image version is referenced");
      const reference = removed.artifactTag || removed.runtimeImage;
      const intent: ImageDeletion = {
        id: randomUUID(),
        kind: "version",
        definitionId: id,
        ownerId: d.ownerId,
        version,
        references: reference ? [reference] : [],
        createdAt: now(),
      };
      this.state.deletions.push(intent);
      return intent;
    });
    await this.finalizeDeletion(deletion.id);
  }
  version(id: string, version: string, ownerId: string, admin: boolean) {
    this.assertVersionAvailable(id, version);
    return findVersion(this.definition(id, ownerId, admin), version);
  }

  async setUserDefault(ownerId: string, definitionId: string, version: string) {
    return this.mutate(() => {
      const d = this.definition(definitionId, ownerId, false);
      if (d.groupId) httpError(404, "Image definition not found");
      this.assertVersionAvailable(definitionId, version);
      const v = findVersion(d, version);
      this.assertVersionReady(v, "set this version as the user default");
      this.state.userDefaults[ownerId] = { definitionId, version };
      return { source: "user", definitionId, version, digest: v.digest };
    });
  }
  async setSystemDefault(
    definitionId: string,
    version: string,
    ownerId: string,
  ) {
    return this.mutate(() => {
      const d = this.definition(definitionId, ownerId, true);
      if (d.groupId) httpError(404, "Image definition not found");
      this.assertVersionAvailable(definitionId, version);
      const v = findVersion(d, version);
      this.assertVersionReady(v, "set this version as the system default");
      this.state.systemDefault = { definitionId, version };
      return { source: "system", definitionId, version, digest: v.digest };
    });
  }
  effectiveDefault(ownerId: string) {
    const value = this.state.userDefaults[ownerId] ?? this.state.systemDefault;
    if (!value)
      return {
        source: "platform",
        definitionId: null,
        version: null,
        digest: null,
      };
    const d = this.state.definitions.find((x) => x.id === value.definitionId)!;
    return {
      source: this.state.userDefaults[ownerId] ? "user" : "system",
      ...value,
      digest: findVersion(d, value.version).digest,
    };
  }
  resolveSelection(ownerId: string, definitionId?: string, version?: string) {
    let selectedDefinition = definitionId;
    let selectedVersion = version;
    let systemSelection = false;
    if (!selectedDefinition) {
      const fallback =
        this.state.userDefaults[ownerId] ?? this.state.systemDefault;
      if (!fallback) return undefined;
      selectedDefinition = fallback.definitionId;
      selectedVersion = fallback.version;
      systemSelection =
        !this.state.userDefaults[ownerId] && Boolean(this.state.systemDefault);
    }
    const definition = this.definition(
      selectedDefinition,
      ownerId,
      systemSelection,
    );
    const resolvedVersion = selectedVersion || definition.promotedVersion || "";
    this.assertVersionAvailable(definition.id, resolvedVersion);
    const built = findVersion(definition, resolvedVersion);
    this.assertVersionReady(built, "create a worker from this version");
    if (built.recovered && !built.runtimeImage)
      httpError(
        409,
        "Recovered image metadata has no pullable immutable GHCR reference; rebuild this version locally",
      );
    return {
      definitionId: definition.id,
      version: built.version,
      digest: built.digest,
      runtimeImage: built.runtimeImage,
    };
  }
  resolveSelectionForGroup(
    ownerId: string,
    groupId: string,
    definitionId?: string,
    version?: string,
  ) {
    if (!definitionId) return this.resolveSelection(ownerId);
    const definition = this.state.definitions.find(
      (candidate) =>
        candidate.id === definitionId &&
        candidate.ownerId === ownerId &&
        (!candidate.groupId || candidate.groupId === groupId),
    );
    if (!definition) httpError(404, "Image definition not found");
    this.assertDefinitionAvailable(definition.id);
    const resolvedVersion = version || definition.promotedVersion || "";
    this.assertVersionAvailable(definition.id, resolvedVersion);
    const built = findVersion(definition, resolvedVersion);
    this.assertVersionReady(built, "create a worker from this version");
    if (built.recovered && !built.runtimeImage)
      httpError(
        409,
        "Recovered image metadata has no runnable immutable reference",
      );
    return {
      definitionId: definition.id,
      version: built.version,
      digest: built.digest,
      runtimeImage: built.runtimeImage,
    };
  }
  resolveSelectionForGroupHierarchy(
    ownerId: string,
    allowedGroupIds: Iterable<string>,
    definitionId?: string,
    version?: string,
  ) {
    if (!definitionId) return this.resolveSelection(ownerId);
    const allowed = new Set(allowedGroupIds);
    const definition = this.state.definitions.find(
      (candidate) =>
        candidate.id === definitionId &&
        candidate.ownerId === ownerId &&
        (!candidate.groupId || allowed.has(candidate.groupId)),
    );
    if (!definition) httpError(404, "Image definition not found");
    this.assertDefinitionAvailable(definition.id);
    const resolvedVersion = version || definition.promotedVersion || "";
    this.assertVersionAvailable(definition.id, resolvedVersion);
    const built = findVersion(definition, resolvedVersion);
    this.assertVersionReady(built, "create a worker from this version");
    if (built.recovered && !built.runtimeImage)
      httpError(
        409,
        "Recovered image metadata has no runnable immutable reference",
      );
    return {
      definitionId: definition.id,
      version: built.version,
      digest: built.digest,
      runtimeImage: built.runtimeImage,
    };
  }
  async setFault(ownerId: string, fault: any) {
    return this.mutate(() => {
      this.state.faults[ownerId] = {
        failPhase: String(fault.failPhase || ""),
        message: safeLog(String(fault.message || "")),
      };
      return { configured: true };
    });
  }
  async simulateRestart() {
    return this.mutate(() => {
      for (const b of this.state.builds)
        if (b.status === "queued" || b.status === "running") {
          clearTimeout(this.timers.get(b.id));
          b.status = "failed";
          b.phase = "failed";
          b.error = "Build interrupted by orchestrator restart.";
          b.recovery = "restart-failed-safe";
          b.completedAt = b.updatedAt = now();
          this.buildSettlers.get(b.id)?.();
          this.buildSettlers.delete(b.id);
        }
      return { recovered: true };
    });
  }
  async usage(ownerId: string, admin: boolean) {
    const visible = this.list(ownerId, admin);
    const definitions = await Promise.all(
      visible.map(async (d) => ({
        id: d.id,
        bytes: (
          await Promise.all(
            d.versions.map((version) =>
              this.imageSize(version.artifactTag || version.runtimeImage),
            ),
          )
        ).reduce((sum, size) => sum + size, 0),
      })),
    );
    const visibleIds = new Set(visible.map((definition) => definition.id));
    const partialBuildBytes = (
      await Promise.all(
        this.state.builds
          .filter(
            (build) =>
              visibleIds.has(build.definitionId) &&
              !build.imageCreated &&
              ["queued", "running", "failed", "cancelled"].includes(
                build.status,
              ),
          )
          .map((build) => this.imageSize(build.artifactTag)),
      )
    ).reduce((sum, size) => sum + size, 0);
    return {
      totalBytes: definitions.reduce((n, x) => n + x.bytes, 0),
      definitions,
      partialBuildBytes,
    };
  }
  async cleanup(ownerId: string, admin: boolean, input: any = {}) {
    let partialArtifactsRemoved = 0;
    let bytesReclaimed = 0;
    let unusedVersionsRemoved = 0;
    if (input.failedBuilds)
      await this.mutate(async () => {
        const visible = this.list(ownerId, admin);
        const visibleIds = new Set(visible.map((definition) => definition.id));
        for (const build of this.state.builds) {
          if (
            !visibleIds.has(build.definitionId) ||
            !["failed", "cancelled"].includes(build.status) ||
            build.imageCreated ||
            !build.artifactTag
          )
            continue;
          bytesReclaimed += await this.imageSize(build.artifactTag);
          if (await this.removeImage(build.artifactTag))
            partialArtifactsRemoved++;
          build.artifactTag = undefined;
        }
      });
    if (input.unusedArtifacts) {
      const candidates = this.list(ownerId, admin).flatMap((definition) =>
        definition.versions.map((version) => ({
          definitionId: definition.id,
          ownerId: definition.ownerId,
          version: version.version,
          reference: version.artifactTag || version.runtimeImage,
        })),
      );
      for (const candidate of candidates) {
        if (
          this.definitionDeletion(candidate.definitionId) ||
          this.versionDeletion(candidate.definitionId, candidate.version) ||
          (await this.versionReferenced(
            candidate.definitionId,
            candidate.version,
          ))
        )
          continue;
        bytesReclaimed += await this.imageSize(candidate.reference);
        await this.deleteVersion(
          candidate.definitionId,
          candidate.version,
          candidate.ownerId,
          admin,
        );
        unusedVersionsRemoved++;
      }
    }
    return { partialArtifactsRemoved, unusedVersionsRemoved, bytesReclaimed };
  }
  diagnostics() {
    return {
      boundary: "orchestrator-controlled-docker-buildkit",
      rawDockerSocket: false,
      secretsInContext: false,
      hostExecution: false,
      buildNetwork: "docker-default-egress",
      socketConsumer: "orchestrator-only",
      cancellation:
        "best-effort Docker build-stream abort followed by artifact cleanup",
    };
  }

  private async finalizeDeletion(id: string) {
    const deletion = this.state.deletions.find((item) => item.id === id);
    if (!deletion) return;
    for (const reference of deletion.references) {
      try {
        await withImageDeleteTimeout(
          this.docker.getImage(reference).remove({ force: true }),
        );
      } catch (error) {
        if (isDockerNotFound(error)) continue;
        const failure = new Error("Docker image cleanup failed") as Error & {
          statusCode?: number;
        };
        failure.statusCode = 502;
        throw failure;
      }
    }
    await this.mutate(() => {
      const current = this.state.deletions.find((item) => item.id === id);
      if (!current) return;
      if (current.kind === "definition") {
        this.state.definitions = this.state.definitions.filter(
          (definition) => definition.id !== current.definitionId,
        );
        this.state.builds = this.state.builds.filter(
          (build) => build.definitionId !== current.definitionId,
        );
      } else {
        const definition = this.state.definitions.find(
          (item) => item.id === current.definitionId,
        );
        if (definition)
          definition.versions = definition.versions.filter(
            (version) => version.version !== current.version,
          );
      }
      this.state.deletions = this.state.deletions.filter(
        (item) => item.id !== id,
      );
    });
  }

  private async versionReferenced(definitionId: string, version: string) {
    const definition = this.state.definitions.find(
      (candidate) => candidate.id === definitionId,
    );
    return (
      definition?.promotedVersion === version ||
      Object.values(this.state.userDefaults).some(
        (value) =>
          value.definitionId === definitionId && value.version === version,
      ) ||
      (this.state.systemDefault?.definitionId === definitionId &&
        this.state.systemDefault.version === version) ||
      (await this.workerUsesVersion(definitionId, version))
    );
  }
  private async workerUsesVersion(definitionId: string, version: string) {
    const { useWorkerStore } = await import("./services");
    return useWorkerStore()
      .list()
      .some(
        (worker) =>
          worker.imageDefinitionId === definitionId &&
          worker.imageVersion === version,
      );
  }
  private async imageSize(reference?: string) {
    if (!reference) return 0;
    try {
      return Number(
        (
          await withImageDeleteTimeout(
            this.docker.getImage(reference).inspect(),
          )
        ).Size || 0,
      );
    } catch {
      return 0;
    }
  }
  private async removeImage(reference?: string) {
    if (!reference) return false;
    try {
      await withImageDeleteTimeout(
        this.docker.getImage(reference).remove({ force: true }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

function findVersion(definition: ImageDefinition, version: string) {
  const item = definition.versions.find((v) => v.version === version);
  if (!item) httpError(404, "Image version not found");
  return item;
}
function resolveControlledBase(alias: string): string {
  // `approved-default` is the stable spelling used by existing catalogs;
  // `approved-latest` remains compatible with the original UI default.
  if (
    alias === "agentor-worker:approved-latest" ||
    alias === "agentor-worker:approved-default"
  )
    return `${process.env.WORKER_IMAGE_PREFIX || ""}${process.env.WORKER_IMAGE || "agentor-worker:latest"}`;
  let configured: Record<string, string> = {};
  try {
    configured = JSON.parse(process.env.AGENTOR_APPROVED_IMAGE_BASES || "{}");
  } catch {
    httpError(500, "Approved image base configuration is invalid");
  }
  const resolved = configured[alias];
  if (!resolved || !/^[a-zA-Z0-9./:@_-]+$/.test(resolved))
    invalidDefinition(
      "baseImage",
      "the approved Agentor base alias must be configured by the platform",
      "Agentor controls the worker base image in both Safe and Advanced modes.",
      "Choose an available agentor-worker:approved-* alias or ask the platform administrator to configure it.",
      "Approved image base is unavailable for controlled builds.",
    );
  return resolved;
}
function validateBaseImage(value: unknown) {
  const baseImage = String(value || "");
  if (!APPROVED_BASE_RE.test(baseImage))
    invalidDefinition(
      "baseImage",
      "only agentor-worker:approved-* base aliases are accepted",
      "The Agentor worker contract and generated Dockerfile begin from a platform-approved base even in Advanced mode.",
      "Select an approved Agentor worker base alias; arbitrary base images are not enabled by Advanced provisioning.",
      "Base image is not approved.",
    );
  return baseImage;
}
function normalizeReadiness(value: unknown): ImageReadiness {
  return value === "validating" ||
    value === "ready-with-warnings" ||
    value === "built-incompatible" ||
    value === "validation-unavailable"
    ? value
    : "ready";
}
function normalizeCompatibility(
  value: any,
  readiness?: unknown,
): ImageCompatibility {
  const normalizedReadiness = normalizeReadiness(readiness);
  const inferredState: ImageCompatibility["state"] =
    normalizedReadiness === "validating"
      ? "pending"
      : normalizedReadiness === "ready-with-warnings"
        ? "warnings"
        : normalizedReadiness === "built-incompatible"
          ? "incompatible"
          : normalizedReadiness === "validation-unavailable"
            ? "unavailable"
            : "passed";
  const state = [
    "pending",
    "passed",
    "warnings",
    "incompatible",
    "unavailable",
  ].includes(value?.state)
    ? value.state
    : inferredState;
  return {
    state,
    coreState: ["pending", "passed", "failed", "unavailable"].includes(
      value?.coreState,
    )
      ? value.coreState
      : state === "pending"
        ? "pending"
        : state === "incompatible"
          ? "failed"
          : state === "unavailable"
            ? "unavailable"
            : "passed",
    pluginState: [
      "none",
      "pending",
      "passed",
      "warnings",
      "failed",
      "unavailable",
    ].includes(value?.pluginState)
      ? value.pluginState
      : "none",
    checks: Array.isArray(value?.checks) ? value.checks : [],
    requiredFailures: Array.isArray(value?.requiredFailures)
      ? value.requiredFailures.map(String)
      : [],
    warnings: Array.isArray(value?.warnings) ? value.warnings.map(String) : [],
    ...(typeof value?.startedAt === "string"
      ? { startedAt: value.startedAt }
      : {}),
    ...(typeof value?.completedAt === "string"
      ? { completedAt: value.completedAt }
      : {}),
    ...(typeof value?.infrastructureError === "string"
      ? {
          infrastructureError: safeLog(value.infrastructureError).slice(0, 500),
        }
      : {}),
  };
}
function normalizeState(value: any): State {
  const definitions = Array.isArray(value?.definitions)
    ? value.definitions
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => ({
          ...item,
          versions: Array.isArray(item.versions)
            ? item.versions.map((version: any) => ({
                ...version,
                provisioningMode:
                  version?.provisioningMode === "advanced"
                    ? "advanced"
                    : "safe",
                readiness: normalizeReadiness(version?.readiness),
                compatibility: normalizeCompatibility(
                  version?.compatibility,
                  version?.readiness,
                ),
                pluginComposition: Array.isArray(version?.pluginComposition)
                  ? version.pluginComposition
                  : undefined,
              }))
            : [],
          contextFiles: Array.isArray(item.contextFiles)
            ? item.contextFiles.map((file: any) => ({
                ...file,
                role: file?.role === "script" ? "script" : "asset",
                destination:
                  typeof file?.destination === "string"
                    ? file.destination
                    : defaultContextDestination(String(file?.path || "")),
              }))
            : [],
          provisioning: Array.isArray(item.provisioning)
            ? item.provisioning
            : undefined,
          provisioningMode:
            item.provisioningMode === "advanced" ? "advanced" : "safe",
          pluginComposition: Array.isArray(item.pluginComposition)
            ? item.pluginComposition
            : undefined,
          gitRecovery: normalizeGitRecovery(item.gitRecovery),
        }))
    : [];
  const builds: ImageBuild[] = Array.isArray(value?.builds)
    ? value.builds.map((build: any) => ({
        ...build,
        operation:
          build?.operation === "validation" ||
          build?.operation === "test-worker"
            ? build.operation
            : "build",
        dockerAttempted: Boolean(build?.dockerAttempted),
        imageCreated: Boolean(build?.imageCreated || build?.digest),
        outcome:
          build?.outcome ||
          (build?.status === "succeeded"
            ? "ready"
            : build?.status === "cancelled"
              ? "cancelled"
              : build?.status === "failed"
                ? "build-failed"
                : undefined),
        progress: Number.isFinite(build?.progress)
          ? Math.max(0, Math.min(100, Number(build.progress)))
          : ["succeeded", "failed", "cancelled"].includes(build?.status)
            ? 100
            : 0,
        compatibility: build?.compatibility
          ? normalizeCompatibility(build.compatibility, build.outcome)
          : undefined,
        logs: Array.isArray(build?.logs)
          ? build.logs.map(String).slice(-2000)
          : [],
      }))
    : [];
  return {
    definitions,
    builds,
    userDefaults:
      value?.userDefaults && typeof value.userDefaults === "object"
        ? value.userDefaults
        : {},
    systemDefault: value?.systemDefault,
    faults:
      value?.faults && typeof value.faults === "object" ? value.faults : {},
    deletions: normalizeDeletions(value?.deletions, definitions, builds),
  };
}
function normalizeDeletions(
  value: unknown,
  definitions: ImageDefinition[],
  builds: ImageBuild[],
): ImageDeletion[] {
  if (!Array.isArray(value)) return [];
  return value.map((item): ImageDeletion => {
    if (!item || typeof item !== "object")
      throw new Error("Image deletion journal is invalid");
    const candidate = item as Record<string, unknown>;
    const id = String(candidate.id || "");
    const definitionId = String(candidate.definitionId || "");
    const ownerId = String(candidate.ownerId || "");
    const kind = candidate.kind;
    const version =
      candidate.version === undefined ? undefined : String(candidate.version);
    if (
      !/^[0-9a-f-]{36}$/i.test(id) ||
      !ownerId ||
      (kind !== "definition" && kind !== "version") ||
      (kind === "version" && !version) ||
      !Number.isFinite(Date.parse(String(candidate.createdAt)))
    )
      throw new Error("Image deletion journal is invalid");
    const definition = definitions.find((entry) => entry.id === definitionId);
    if (!definition || definition.ownerId !== ownerId)
      throw new Error("Image deletion journal is invalid");
    const allowedReferences = new Set(
      kind === "definition"
        ? [
            ...definition.versions.map(
              (entry) => entry.artifactTag || entry.runtimeImage,
            ),
            ...builds
              .filter((entry) => entry.definitionId === definitionId)
              .map((entry) => entry.artifactTag),
          ].filter((entry): entry is string => Boolean(entry))
        : [
            definition.versions.find((entry) => entry.version === version)
              ?.artifactTag ||
              definition.versions.find((entry) => entry.version === version)
                ?.runtimeImage,
          ].filter((entry): entry is string => Boolean(entry)),
    );
    const references = Array.isArray(candidate.references)
      ? [...new Set(candidate.references.map(String).filter(Boolean))]
      : [];
    if (references.some((reference) => !allowedReferences.has(reference)))
      throw new Error("Image deletion journal is invalid");
    return {
      id,
      kind,
      definitionId,
      ownerId,
      ...(version ? { version } : {}),
      references,
      createdAt: new Date(String(candidate.createdAt)).toISOString(),
    };
  });
}
function normalizeGitRecovery(
  value: unknown,
): ImageDefinition["gitRecovery"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>,
    connectionId = String(candidate.connectionId || ""),
    remoteId = String(candidate.remoteId || ""),
    hash = String(candidate.hash || "").toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      connectionId,
    ) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(remoteId) ||
    !/^[0-9a-f]{64}$/.test(hash)
  )
    return undefined;
  return { connectionId, remoteId, hash };
}
function defaultContextDestination(path: string) {
  return `/opt/agentor-context/${path}`;
}
function normalizeRequestId(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const requestId = String(value);
  if (
    requestId.length > 200 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/.test(requestId)
  )
    httpError(400, "requestId must be a stable 1-200 character identifier");
  return requestId;
}
function assertCombinedContext(files: ContextFile[]) {
  let total = 0;
  const paths = new Set<string>();
  const destinations = new Set<string>();
  for (const file of files) {
    const path = file.path.toLowerCase();
    const destination =
      file.destination || defaultContextDestination(file.path);
    if (paths.has(path) || destinations.has(destination))
      httpError(
        400,
        "Combined image and plugin build-context paths or destinations collide",
        {
          code: "invalid-build-context",
          diagnostic: {
            code: "invalid-build-context",
            blockedField: "contextFiles",
            constraint:
              "combined build-context paths and destinations must be unique",
            reason:
              "Ambiguous COPY targets would make the generated image recipe nondeterministic.",
            remediation:
              "Rename the image or plugin context file/destination and start the build again.",
            advancedModeAvailable: false,
            dockerAttempted: false,
          },
        },
      );
    paths.add(path);
    destinations.add(destination);
    total += Buffer.from(file.contentBase64, "base64").length;
    if (total > MAX_CONTEXT_TOTAL)
      invalidBuildContext(
        "contextFiles",
        `the combined image and plugin context must not exceed ${MAX_CONTEXT_TOTAL} bytes`,
        "Agentor bounds build-context storage and Docker transfer size.",
        "Remove unnecessary assets or split the experiment into smaller image definitions.",
        "Combined image and plugin build context is too large.",
      );
  }
}
function fakeCompatibility(value: unknown): ImageCompatibility {
  const completedAt = now();
  if (value === "unavailable")
    return {
      state: "unavailable",
      coreState: "unavailable",
      pluginState: "unavailable",
      checks: [],
      requiredFailures: [],
      warnings: [],
      startedAt: completedAt,
      completedAt,
      infrastructureError:
        "Simulated compatibility validator infrastructure failure.",
    };
  const warning = value === "warnings";
  const incompatible = value === "incompatible";
  const checks: ImageCompatibilityCheck[] = [
    {
      id: "core-fake-validation",
      name: "Agentor worker contract",
      kind: "core",
      required: true,
      state: incompatible ? "failed" : "passed",
      message: incompatible
        ? "Simulated required Agentor compatibility failure."
        : "Simulated Agentor compatibility check passed.",
    },
    ...(warning
      ? [
          {
            id: "plugin-fake-warning",
            name: "Optional plugin capability",
            kind: "plugin" as const,
            required: false,
            state: "warning" as const,
            message: "Simulated optional plugin warning.",
          },
        ]
      : []),
  ];
  return {
    state: incompatible ? "incompatible" : warning ? "warnings" : "passed",
    coreState: incompatible ? "failed" : "passed",
    pluginState: warning ? "warnings" : "none",
    checks,
    requiredFailures: incompatible ? ["Agentor worker contract"] : [],
    warnings: warning
      ? ["Optional plugin capability: Simulated optional plugin warning."]
      : [],
    startedAt: completedAt,
    completedAt,
  };
}
/** Render only instructions selected by the structured recipe. This is also
 * used by Git export so its human-readable Dockerfile matches local builds. */
export function renderDefinitionDockerfile(
  definition: Pick<
    ImageDefinition,
    "dockerfileFragment" | "contextFiles" | "provisioning"
  > & {
    baseImage?: string;
    pluginComposition?: Array<
      ImagePluginSelection & Partial<ImagePluginSnapshot>
    >;
  },
  baseReference = definition.baseImage,
) {
  const lines = [`FROM ${baseReference}`, "USER root"];
  const files = definition.contextFiles || [];
  for (const file of files)
    // Context tar entries are mode 0600. Make the final runtime user their
    // owner so copied assets (and optional launch scripts) remain readable
    // after the generated Dockerfile switches back to `agent`.
    lines.push(
      `COPY --chown=agent:agent ${file.path} ${file.destination || defaultContextDestination(file.path)}`,
    );
  if (definition.provisioning?.length) {
    for (const step of definition.provisioning) {
      if (step.type === "packages") {
        const packages = step.packages.join(" ");
        if (step.manager === "apt")
          lines.push(
            `RUN apt-get update && apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/*`,
          );
        else if (step.manager === "npm")
          lines.push(`RUN npm install --global ${packages}`);
        else
          lines.push(
            `RUN python3 -m pip install --no-cache-dir --break-system-packages ${packages}`,
          );
      } else if (step.type === "command")
        lines.push(`RUN ["/bin/sh", "-c", ${JSON.stringify(step.command)}]`);
      else
        lines.push(
          `RUN ${step.interpreter} ${files.find((file) => file.path === step.path)?.destination || defaultContextDestination(step.path)}`,
        );
    }
  } else if (definition.dockerfileFragment)
    lines.push(definition.dockerfileFragment);
  else lines.push("# no additional image steps");
  for (const plugin of definition.pluginComposition || []) {
    lines.push(
      `# plugin image contribution: ${plugin.name || plugin.definitionId}`,
    );
    renderProvisioningLines(lines, plugin.provisioning || [], files);
  }
  lines.push("USER agent", "WORKDIR /workspace");
  return lines.join("\n");
}
function renderProvisioningLines(
  lines: string[],
  provisioning: ProvisioningStep[],
  files: ContextFile[],
) {
  for (const step of provisioning) {
    if (step.type === "packages") {
      const packages = step.packages.join(" ");
      if (step.manager === "apt")
        lines.push(
          `RUN apt-get update && apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/*`,
        );
      else if (step.manager === "npm")
        lines.push(`RUN npm install --global ${packages}`);
      else
        lines.push(
          `RUN python3 -m pip install --no-cache-dir --break-system-packages ${packages}`,
        );
    } else if (step.type === "command")
      lines.push(`RUN ["/bin/sh", "-c", ${JSON.stringify(step.command)}]`);
    else
      lines.push(
        `RUN ${step.interpreter} ${files.find((file) => file.path === step.path)?.destination || defaultContextDestination(step.path)}`,
      );
  }
}
function assertNoSecret(value: string, subject: string) {
  // Runtime-variable references are templates, not secret material. Preserve
  // them so non-secret launch/config assets do not false-positive while still
  // scanning literal values and common bearer/private-key forms.
  const withoutReferences = value.replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/g, "");
  if (SECRET_VALUE.test(withoutReferences))
    httpError(400, `${subject} must not contain secrets`);
}
function validateProvisioning(
  input: unknown,
  contextFiles: ContextFile[],
  mode: ImageProvisioningMode,
  fieldPrefix = "provisioning",
) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 100)
    invalidDefinition(
      fieldPrefix,
      "provisioning must be an ordered list of at most 100 structured steps",
      "Agentor renders each accepted step into its controlled Dockerfile.",
      "Use a list of package, command, or context-script steps and split oversized recipes.",
      "Provisioning is invalid.",
    );
  return input.map((raw: any, index): ProvisioningStep => {
    if (!raw || typeof raw !== "object")
      httpError(400, "Invalid provisioning step");
    if (raw.type === "packages") {
      const manager = String(raw.manager || "");
      const packages: string[] = Array.isArray(raw.packages)
        ? raw.packages.map(String)
        : [];
      if (
        !(["apt", "npm", "pip"] as string[]).includes(manager) ||
        !packages.length ||
        packages.length > 100 ||
        packages.some(
          (item) => item.startsWith("-") || !SAFE_PACKAGE_RE.test(item),
        )
      )
        invalidDefinition(
          `${fieldPrefix}[${index}]`,
          "package steps require apt, npm, or pip and 1-100 non-option package specifications",
          "Structured package installation prevents package-manager flags from escaping the generated recipe.",
          "Choose a supported manager and provide package names or pinned specifications without leading options.",
          "Package provisioning is invalid.",
        );
      for (const item of packages) assertNoSecret(item, "Package provisioning");
      return {
        type: "packages",
        manager: manager as "apt" | "npm" | "pip",
        packages,
      };
    }
    if (raw.type === "command") {
      const command = String(raw.command || "").trim();
      if (!command || command.length > 16 * 1024)
        invalidDefinition(
          `${fieldPrefix}[${index}]`,
          "command steps must contain at most 16384 characters",
          "Build instructions are bounded before Agentor renders the generated Dockerfile.",
          "Remove the empty step or move a larger secret-free script into the bounded build context.",
          "Command provisioning is empty or too large.",
        );
      assertNoSecret(command, "Command provisioning");
      if (
        mode === "safe" &&
        (/[\r\n]/.test(command) || FORBIDDEN_FRAGMENT.test(`RUN ${command}`))
      )
        safeModeBlocked(
          `${fieldPrefix}[${index}]`,
          "the command requests shell behavior outside the constrained command policy",
          "Safe mode protects the required Agentor base, runtime user, entrypoint, build boundary, and secret/runtime separation.",
          "Use structured package steps, copy a secret-free context asset, split simple commands into separate steps, and avoid Docker directives, socket/mount access, secret references, and unverified remote-script pipes.",
          { index, type: "command" },
        );
      return { type: "command", command };
    }
    if (raw.type === "script") {
      const path = String(raw.path || ""),
        interpreter = String(raw.interpreter || "");
      const context = contextFiles.find((file) => file.path === path);
      if (
        !context ||
        context.role !== "script" ||
        !(["sh", "bash", "python3", "node"] as string[]).includes(interpreter)
      )
        invalidDefinition(
          `${fieldPrefix}[${index}]`,
          "script steps must reference a context file marked as script and use sh, bash, python3, or node",
          "Agentor resolves scripts only from the controlled build context.",
          "Upload the script, mark its role as script, and choose a supported interpreter.",
          "Script provisioning is invalid.",
        );
      return {
        type: "script",
        path,
        interpreter: interpreter as "sh" | "bash" | "python3" | "node",
      };
    }
    invalidDefinition(
      `${fieldPrefix}[${index}]`,
      "only package, command, and context-script provisioning steps are supported",
      "Agentor generates the Dockerfile rather than accepting arbitrary step objects.",
      "Rewrite the step using one of the supported structured types.",
      "Provisioning step type is invalid.",
    );
  });
}
function validatePluginComposition(
  input: unknown,
): ImagePluginSelection[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 50)
    httpError(400, "pluginComposition must contain at most 50 selections");
  const seen = new Set<string>();
  const result = input.map((raw: any): ImagePluginSelection => {
    const definitionId = String(raw?.definitionId || "");
    const validation =
      raw?.validation === "optional"
        ? "optional"
        : raw?.validation === "required"
          ? "required"
          : "";
    if (!definitionId || !validation || seen.has(definitionId))
      httpError(400, "Plugin composition selections are invalid or duplicated");
    seen.add(definitionId);
    return { definitionId, validation };
  });
  return result.length ? result : undefined;
}
function validateDefinition(input: any) {
  if (!input || typeof input !== "object")
    httpError(400, "Definition body is required");
  const name = String(input.name || "").trim();
  if (!name || name.length > 100) httpError(400, "Invalid definition name");
  assertNoSecret(name, "Definition name");
  const description = String(input.description || "").slice(0, 1000);
  assertNoSecret(description, "Definition description");
  const baseImage = validateBaseImage(input.baseImage);
  const provisioningMode: ImageProvisioningMode =
    input.provisioningMode === undefined || input.provisioningMode === "safe"
      ? "safe"
      : input.provisioningMode === "advanced"
        ? "advanced"
        : httpError(400, "provisioningMode must be safe or advanced");
  const dockerfileFragment = String(input.dockerfileFragment || "");
  if (dockerfileFragment.length > 256 * 1024)
    httpError(400, "Dockerfile fragment is too large");
  assertNoSecret(dockerfileFragment, "Dockerfile fragment");
  if (provisioningMode === "advanced" && dockerfileFragment.trim())
    invalidDefinition(
      "dockerfileFragment",
      "Advanced provisioning accepts arbitrary shell only through structured command or context-script steps",
      "Agentor must keep control of the generated Dockerfile, approved base, build stages, and final worker user.",
      "Move every legacy RUN operation into provisioning command steps and upload reusable scripts through the bounded build context. Remove all raw Dockerfile directives.",
      "Raw Dockerfile fragments are unavailable in Advanced mode.",
    );
  if (FORBIDDEN_FRAGMENT.test(dockerfileFragment))
    safeModeBlocked(
      "dockerfileFragment",
      "the legacy fragment contains a Docker directive, socket/mount access, secret reference, or unverified remote-script pipe that Safe mode does not allow",
      "The generated image must retain Agentor's approved base and worker runtime contract.",
      "Move build-time shell work into structured provisioning steps; use package steps or secret-free build-context scripts where possible.",
    );
  if (!Array.isArray(input.contextFiles))
    httpError(400, "contextFiles must be an array");
  const seen = new Set<string>();
  let total = 0;
  const contextFiles = input.contextFiles.map((f: any, index: number) => {
    const path = String(f?.path || "");
    const folded = path.toLowerCase();
    if (
      !SAFE_PATH_RE.test(path) ||
      path.startsWith("./") ||
      path.includes("//") ||
      path.endsWith("/") ||
      folded === "dockerfile" ||
      folded === ".dockerignore" ||
      seen.has(folded) ||
      f?.type === "symlink"
    )
      invalidBuildContext(
        `contextFiles[${index}].path`,
        "context paths must be unique canonical relative files and cannot replace Dockerfile or .dockerignore",
        "Traversal, symlinks, reserved files, and ambiguous paths could escape or alter Agentor's generated build boundary.",
        "Rename the file to a unique relative path without traversal, repeated separators, or a trailing slash.",
        "Build context path is invalid.",
      );
    seen.add(folded);
    const value = String(f?.contentBase64 || "");
    if (
      value.length > Math.ceil(MAX_CONTEXT_FILE / 3) * 4 + 4 ||
      value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      )
    )
      invalidBuildContext(
        `contextFiles[${index}].contentBase64`,
        "build-context bytes must use canonical base64 within the per-file limit",
        "Agentor validates exact bytes before creating the Docker build context.",
        "Encode the intended file bytes once as canonical base64 and keep the file within the documented limit.",
        "Build context content is invalid.",
      );
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value)
      invalidBuildContext(
        `contextFiles[${index}].contentBase64`,
        "build-context bytes must round-trip as canonical base64",
        "Noncanonical encodings make content validation and hashing ambiguous.",
        "Re-encode the original file bytes using standard canonical base64.",
        "Build context content is invalid.",
      );
    const size = decoded.length;
    if (
      !Number.isSafeInteger(size) ||
      size > MAX_CONTEXT_FILE ||
      (total += size) > MAX_CONTEXT_TOTAL
    )
      invalidBuildContext(
        `contextFiles[${index}].contentBase64`,
        "each context file and the combined context must remain within Agentor's size limits",
        "Context limits bound storage and Docker/BuildKit transfer cost.",
        "Remove unnecessary bytes or split the image experiment into smaller definitions.",
        "Build context is too large.",
      );
    const decodedText = decoded.toString("utf8");
    assertNoSecret(decodedText, "Build context content");
    const role = f?.role === undefined ? "asset" : String(f.role);
    const destination = String(
      f?.destination || defaultContextDestination(path),
    );
    if (
      (role !== "asset" && role !== "script") ||
      !SAFE_DESTINATION_RE.test(destination) ||
      destination.includes("//") ||
      destination.endsWith("/")
    )
      invalidBuildContext(
        `contextFiles[${index}]`,
        "context roles are asset or script and destinations must be canonical files below /opt/agentor-context",
        "Controlled destinations prevent context files from overwriting the worker-image contract directly.",
        "Choose asset or script and a unique file destination below /opt/agentor-context.",
        "Build context role or destination is invalid.",
      );
    return {
      path,
      contentBase64: value,
      role: role as "asset" | "script",
      destination,
    };
  });
  const provisioning = validateProvisioning(
    input.provisioning,
    contextFiles,
    provisioningMode,
  );
  const pluginComposition = validatePluginComposition(input.pluginComposition);
  return {
    name,
    description,
    baseImage,
    dockerfileFragment,
    contextFiles,
    provisioningMode,
    ...(provisioning ? { provisioning } : {}),
    ...(pluginComposition ? { pluginComposition } : {}),
  };
}

let singleton: ImageCatalogManager | undefined;
export function useImageCatalogManager() {
  return (singleton ??= new ImageCatalogManager(
    join(process.env.DATA_DIR || "/data", "image-catalog"),
  ));
}
