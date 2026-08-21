import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Docker from "dockerode";
import { pack } from "tar-stream";
import type { Readable } from "node:stream";

export type ImageBuildStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";
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
}
export interface ImageDefinition {
  id: string;
  ownerId: string;
  /** Absent for the owner/global catalog; set for a group-private catalog. */
  groupId?: string;
  name: string;
  description: string;
  baseImage: string;
  dockerfileFragment: string;
  contextFiles: Array<{ path: string; contentBase64: string }>;
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
  status: ImageBuildStatus;
  phase: string;
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
}
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
const REDACT =
  /(?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*[=:]\s*)?[^\s]{8,}/gi;

function now() {
  return new Date().toISOString();
}
function httpError(statusCode: number, message: string): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  throw error;
}
function safeLog(value: string): string {
  return value
    .replace(/\/var\/run\/docker\.sock/gi, "[redacted-path]")
    .replace(REDACT, (match) =>
      /TOKEN|SECRET|PASSWORD|API_KEY|IMAGE_BUILD_MUST_NEVER/i.test(match)
        ? "[redacted]"
        : match,
    );
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
          build.error = "Build interrupted by orchestrator restart.";
          build.recovery = "restart-failed-safe";
          build.completedAt = build.updatedAt = now();
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
  definition(id: string, ownerId: string, admin: boolean) {
    const item = this.definitionRecord(id, ownerId, admin);
    this.assertDefinitionAvailable(id);
    return item;
  }
  async create(ownerId: string, input: any) {
    return this.mutate(() => {
      const cleaned = validateDefinition(input);
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
    return this.mutate(() => {
      const item = this.definition(id, ownerId, admin);
      if (item.groupId) httpError(404, "Image definition not found");
      Object.assign(item, validateDefinition(input), { updatedAt: now() });
      return item;
    });
  }
  async createForGroup(ownerId: string, groupId: string, input: any) {
    return this.mutate(() => {
      const cleaned = validateDefinition(input);
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
    return this.mutate(() => {
      const item = this.definitionForGroup(id, ownerId, groupId);
      Object.assign(item, validateDefinition(input), { updatedAt: now() });
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
    const { build, definition, snapshot } = await this.mutate(() => {
      if (this.definitionDeletion(id))
        httpError(409, "Image definition is being deleted");
      const definition = this.definition(id, ownerId, admin);
      const requestedBase =
        input.baseImage === undefined
          ? definition.baseImage
          : validateBaseImage(input.baseImage);
      const stamp = now();
      const build: ImageBuild = {
        id: randomUUID(),
        definitionId: id,
        ownerId: definition.ownerId,
        groupId: definition.groupId,
        status: "queued",
        phase: "queued",
        createdAt: stamp,
        updatedAt: stamp,
        logs: [],
        builder,
      };
      this.state.builds.push(build);
      const snapshot: ImageDefinition = {
        ...definition,
        baseImage: requestedBase,
        contextFiles: definition.contextFiles.map((file) => ({ ...file })),
        versions: definition.versions.map((version) => ({ ...version })),
      };
      return { build, definition, snapshot };
    });
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
  private async advanceControlled(
    build: ImageBuild,
    definition: ImageDefinition,
    snapshot: ImageDefinition,
  ) {
    const started = Date.now();
    const pendingProgressLogs: string[] = [];
    const version = `v${definition.versions.length + 1}`;
    const tag = `agentor-custom-${createHash("sha256").update(definition.ownerId).digest("hex").slice(0, 12)}-${definition.id.slice(0, 12)}:${version}-${build.id.slice(0, 8)}`;
    try {
      await this.mutate(() => {
        build.artifactTag = tag;
        build.status = "running";
        build.phase = "validating";
        build.startedAt = build.updatedAt = now();
      });
      const configuredBase = resolveControlledBase(snapshot.baseImage);
      const pinnedBase = await this.resolvePinnedBase(configuredBase);
      await this.mutate(() => {
        build.baseDigest = pinnedBase.digest;
      });
      const dockerfile = [
        `FROM ${pinnedBase.reference}`,
        "USER root",
        snapshot.dockerfileFragment || "# no additional image steps",
        "USER agent",
        "WORKDIR /workspace",
      ].join("\n");
      await this.mutate(() => {
        build.phase = "building";
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
        definition.versions.push({
          version,
          digest,
          runtimeImage: digest,
          artifactTag: tag,
          baseImage: snapshot.baseImage,
          baseDigest: pinnedBase.digest,
          createdAt: stamp,
        });
        definition.baseImage = snapshot.baseImage;
        definition.updatedAt = stamp;
        Object.assign(build, {
          status: "succeeded",
          phase: "complete",
          digest,
          version,
          completedAt: stamp,
          updatedAt: stamp,
          durationMs: Date.now() - started,
          cache: {
            enabled: true,
            hits: definition.versions.length > 1 ? 1 : 0,
          },
        });
      });
    } catch (error) {
      await this.removeControlledArtifact(tag);
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
  private advance(
    build: ImageBuild,
    definition: ImageDefinition,
    snapshot: ImageDefinition,
    input: any,
  ): Promise<void> {
    const duration = Math.max(
      100,
      Math.min(Number(input.fakeDurationMs) || 600, 30_000),
    );
    const phases = ["validating", "building", "recording-digest"];
    let index = 0;
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
            build.updatedAt = now();
            build.logs.push(safeLog(`[fake-builder] ${phase}`));
            delete this.state.faults[build.ownerId];
            build.status = "failed";
            build.phase = "failed";
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
          build.updatedAt = now();
          build.logs.push(safeLog(`[fake-builder] ${phase}`));
          definition.versions.push({
            version,
            digest,
            baseImage: snapshot.baseImage,
            createdAt: stamp,
          });
          definition.baseImage = snapshot.baseImage;
          definition.updatedAt = stamp;
          Object.assign(build, {
            status: "succeeded",
            phase: "complete",
            digest,
            version,
            completedAt: stamp,
            updatedAt: stamp,
            durationMs: Date.now() - started,
            cache: {
              enabled: true,
              hits: definition.versions.length > 1 ? 1 : 0,
            },
          });
        });
        finish();
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
      build.status = "cancelled";
      build.phase = "cancelled";
      build.completedAt = build.updatedAt = now();
      return build;
    });
    if (!["cancelled"].includes(b.status)) return publicBuild(b);
    this.buildSettlers.get(id)?.();
    this.buildSettlers.delete(id);
    // Cancellation is not complete until the underlying fake timer or Docker
    // build stream has unwound and its finally cleanup has run. This keeps a
    // following definition deletion from racing live build work.
    await this.definitionBuilds.get(b.definitionId)?.catch(() => undefined);
    return publicBuild(b);
  }
  logs(id: string, ownerId: string, admin: boolean, after = 0) {
    return this.build(id, ownerId, admin)
      .logs.slice(Math.max(0, after))
      .map(safeLog)
      .join("\n");
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
    httpError(400, "Approved image base is unavailable for controlled builds");
  return resolved;
}
function validateBaseImage(value: unknown) {
  const baseImage = String(value || "");
  if (!APPROVED_BASE_RE.test(baseImage))
    httpError(400, "Base image is not approved");
  return baseImage;
}
function normalizeState(value: any): State {
  const definitions = Array.isArray(value?.definitions)
    ? value.definitions
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => ({
          ...item,
          versions: Array.isArray(item.versions) ? item.versions : [],
          contextFiles: Array.isArray(item.contextFiles)
            ? item.contextFiles
            : [],
          gitRecovery: normalizeGitRecovery(item.gitRecovery),
        }))
    : [];
  const builds = Array.isArray(value?.builds) ? value.builds : [];
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
function validateDefinition(input: any) {
  if (!input || typeof input !== "object")
    httpError(400, "Definition body is required");
  const name = String(input.name || "").trim();
  if (!name || name.length > 100) httpError(400, "Invalid definition name");
  const baseImage = validateBaseImage(input.baseImage);
  const dockerfileFragment = String(input.dockerfileFragment || "");
  if (
    dockerfileFragment.length > 256 * 1024 ||
    FORBIDDEN_FRAGMENT.test(dockerfileFragment)
  )
    httpError(
      400,
      "Dockerfile fragment violates build policy: safe package downloads with apt, pip, npm, or similar tools are allowed; do not include FROM, USER, ENTRYPOINT, CMD, ENV/ARG secrets, EXPOSE, VOLUME, remote ADD, curl|sh, wget|sh, Docker socket mounts, or privilege changes",
    );
  if (!Array.isArray(input.contextFiles))
    httpError(400, "contextFiles must be an array");
  const seen = new Set<string>();
  let total = 0;
  const contextFiles = input.contextFiles.map((f: any) => {
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
      httpError(400, "Invalid build context path");
    seen.add(folded);
    const value = String(f?.contentBase64 || "");
    if (
      value.length > Math.ceil(MAX_CONTEXT_FILE / 3) * 4 + 4 ||
      value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      )
    )
      httpError(400, "Build context content must be canonical base64");
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value)
      httpError(400, "Build context content must be canonical base64");
    const size = decoded.length;
    if (
      !Number.isSafeInteger(size) ||
      size > MAX_CONTEXT_FILE ||
      (total += size) > MAX_CONTEXT_TOTAL
    )
      httpError(400, "Build context is too large");
    return { path, contentBase64: value };
  });
  return {
    name,
    description: String(input.description || "").slice(0, 1000),
    baseImage,
    dockerfileFragment,
    contextFiles,
  };
}

let singleton: ImageCatalogManager | undefined;
export function useImageCatalogManager() {
  return (singleton ??= new ImageCatalogManager(
    join(process.env.DATA_DIR || "/data", "image-catalog"),
  ));
}
