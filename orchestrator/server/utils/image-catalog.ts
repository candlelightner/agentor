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
  name: string;
  description: string;
  baseImage: string;
  dockerfileFragment: string;
  contextFiles: Array<{ path: string; contentBase64: string }>;
  createdAt: string;
  updatedAt: string;
  versions: ImageVersion[];
  promotedVersion?: string;
}
export interface ImageBuild {
  id: string;
  definitionId: string;
  ownerId: string;
  status: ImageBuildStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  digest?: string;
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
}

const APPROVED_BASE_RE = /^agentor-worker:approved-[a-zA-Z0-9._-]+$/;
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const MAX_CONTEXT_FILE = 100 * 1024 * 1024;
const MAX_CONTEXT_TOTAL = 250 * 1024 * 1024;
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
  };
  private initialized?: Promise<void>;
  private saveChain = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private buildStreams = new Map<string, Readable>();
  private definitionBuilds = new Map<string, Promise<void>>();
  private buildSettlers = new Map<string, () => void>();
  private docker = new Docker({ socketPath: "/var/run/docker.sock" });
  constructor(private dataDir: string) {}

  init(): Promise<void> {
    return (this.initialized ??= this.load());
  }
  private async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = normalizeState(
        JSON.parse(await readFile(this.path(), "utf8")),
      );
    } catch {
      /* first boot/corrupt file: empty fail-closed catalog */
    }
    for (const build of this.state.builds)
      if (build.status === "queued" || build.status === "running") {
        build.status = "failed";
        build.phase = "failed";
        build.error = "Build interrupted by orchestrator restart.";
        build.recovery = "restart-failed-safe";
        build.completedAt = build.updatedAt = now();
      }
    await this.persist();
  }
  private path() {
    return join(this.dataDir, "image-catalog.json");
  }
  private persist() {
    this.saveChain = this.saveChain.then(async () => {
      const tmp = `${this.path()}.tmp.${process.pid}`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2), {
        mode: 0o600,
      });
      await rename(tmp, this.path());
    });
    return this.saveChain;
  }

  list(ownerId: string, admin: boolean) {
    return this.state.definitions.filter((d) => admin || d.ownerId === ownerId);
  }
  ownerIds() {
    return [
      ...new Set(
        this.state.definitions.map((definition) => definition.ownerId),
      ),
    ];
  }
  async forgetOwner(ownerId: string) {
    const definitions = this.state.definitions.filter(
      (definition) => definition.ownerId === ownerId,
    );
    const ids = new Set(definitions.map((definition) => definition.id));
    for (const build of this.state.builds.filter(
      (candidate) => candidate.ownerId === ownerId,
    )) {
      const timer = this.timers.get(build.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(build.id);
      this.buildStreams.get(build.id)?.destroy();
      this.buildStreams.delete(build.id);
    }
    await Promise.all(
      definitions
        .flatMap((definition) => definition.versions)
        .map(
          (version) =>
            version.artifactTag ||
            (version.runtimeImage &&
            !version.runtimeImage.startsWith("ghcr.io/")
              ? version.runtimeImage
              : undefined),
        )
        .filter(Boolean)
        .map((image) =>
          this.docker
            .getImage(image!)
            .remove({ force: true })
            .catch(() => {}),
        ),
    );
    this.state.definitions = this.state.definitions.filter(
      (definition) => definition.ownerId !== ownerId,
    );
    this.state.builds = this.state.builds.filter(
      (build) => build.ownerId !== ownerId,
    );
    delete this.state.userDefaults[ownerId];
    for (const [userId, value] of Object.entries(this.state.userDefaults))
      if (ids.has(value.definitionId)) delete this.state.userDefaults[userId];
    if (
      this.state.systemDefault &&
      ids.has(this.state.systemDefault.definitionId)
    )
      this.state.systemDefault = undefined;
    delete this.state.faults[ownerId];
    await this.persist();
  }
  definition(id: string, ownerId: string, admin: boolean) {
    const item = this.state.definitions.find((d) => d.id === id);
    if (!item) httpError(404, "Image definition not found");
    if (!admin && item.ownerId !== ownerId) httpError(403, "Forbidden");
    return item;
  }
  async create(ownerId: string, input: any) {
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
    await this.persist();
    return item;
  }
  async importRecovered(ownerId: string, input: any) {
    const cleaned = validateDefinition(input);
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
    };
    this.state.definitions.push(item);
    await this.persist();
    return item;
  }
  validate(input: unknown) {
    return { valid: true, definition: validateDefinition(input) };
  }
  async removeDefinition(id: string, ownerId: string, admin: boolean) {
    const item = this.definition(id, ownerId, admin);
    if (
      Object.values(this.state.userDefaults).some(
        (d) => d.definitionId === id,
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
    await Promise.all(
      item.versions.map((version) =>
        version.artifactTag || version.runtimeImage
          ? this.docker
              .getImage(version.artifactTag || version.runtimeImage!)
              .remove({ force: true })
              .catch(() => {})
          : Promise.resolve(),
      ),
    );
    this.state.definitions = this.state.definitions.filter((d) => d.id !== id);
    await this.persist();
  }

  async startBuild(
    id: string,
    ownerId: string,
    admin: boolean,
    input: any = {},
  ) {
    const definition = this.definition(id, ownerId, admin);
    const builder = input.builder ?? "controlled";
    if (builder !== "fake" && builder !== "controlled")
      httpError(400, "Unknown image builder");
    if (
      builder === "fake" &&
      process.env.NODE_ENV === "production" &&
      process.env.ALLOW_FAKE_IMAGE_BUILDER !== "true"
    )
      httpError(403, "Fake builder is disabled in production");
    const requestedBase =
      input.baseImage === undefined
        ? definition.baseImage
        : validateBaseImage(input.baseImage);
    const stamp = now();
    const build: ImageBuild = {
      id: randomUUID(),
      definitionId: id,
      ownerId: definition.ownerId,
      status: "queued",
      phase: "queued",
      createdAt: stamp,
      updatedAt: stamp,
      logs: [],
      builder,
    };
    this.state.builds.push(build);
    await this.persist();
    const snapshot: ImageDefinition = {
      ...definition,
      baseImage: requestedBase,
      contextFiles: definition.contextFiles.map((file) => ({ ...file })),
      versions: definition.versions.map((version) => ({ ...version })),
    };
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
    const version = `v${definition.versions.length + 1}`;
    const tag = `agentor-custom-${createHash("sha256").update(definition.ownerId).digest("hex").slice(0, 12)}-${definition.id.slice(0, 12)}:${version}-${build.id.slice(0, 8)}`;
    try {
      build.artifactTag = tag;
      build.status = "running";
      build.phase = "validating";
      build.startedAt = build.updatedAt = now();
      await this.persist();
      const base = resolveControlledBase(snapshot.baseImage);
      const dockerfile = [
        `FROM ${base}`,
        "USER root",
        snapshot.dockerfileFragment || "# no additional image steps",
        "USER agent",
        "WORKDIR /workspace",
      ].join("\n");
      build.phase = "building";
      build.updatedAt = now();
      await this.persist();
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
          ...(resourceLimits
            ? { memory: 2 * 1024 * 1024 * 1024, cpuquota: 100000 }
            : {}),
          labels: {
            "agentor.image-definition": definition.id,
            "agentor.image-owner-hash": createHash("sha256")
              .update(definition.ownerId)
              .digest("hex"),
          },
        };
        const stream = await this.docker.buildImage(context as any, options);
        this.buildStreams.set(build.id, stream as unknown as Readable);
        await new Promise<void>((resolve, reject) => {
          let daemonError: Error | undefined;
          this.docker.modem.followProgress(
            stream,
            (error: Error | null) =>
              error || daemonError ? reject(error || daemonError) : resolve(),
            (event: any) => {
              const daemonMessage = String(
                event?.errorDetail?.message || event?.error || "",
              );
              if (daemonMessage) daemonError = new Error(daemonMessage);
              const line = safeLog(
                String(event?.stream || event?.status || "").trim(),
              );
              if (line) {
                build.logs.push(line);
                if (build.logs.length > 2000)
                  build.logs.splice(0, build.logs.length - 2000);
              }
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
        await this.docker
          .getImage(tag)
          .remove({ force: true })
          .catch(() => {});
        build.logs.push(
          "Builder host cannot apply legacy cgroup limits; retrying with platform defaults.",
        );
        await runBuild(false);
      }
      if ((build.status as ImageBuildStatus) === "cancelled") {
        await this.docker
          .getImage(tag)
          .remove({ force: true })
          .catch(() => {});
        return;
      }
      build.phase = "recording-digest";
      build.updatedAt = now();
      await this.persist();
      const image = await this.docker.getImage(tag).inspect();
      const digest = /^sha256:[0-9a-f]{64}$/.test(image.Id)
        ? image.Id
        : `sha256:${createHash("sha256")
            .update(image.Id || tag)
            .digest("hex")}`;
      const stamp = now();
      definition.versions.push({
        version,
        digest,
        runtimeImage: digest,
        artifactTag: tag,
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
        cache: { enabled: true, hits: definition.versions.length > 1 ? 1 : 0 },
      });
      await this.persist();
    } catch {
      await this.docker
        .getImage(tag)
        .remove({ force: true })
        .catch(() => {});
      if (build.status !== "cancelled") {
        build.status = "failed";
        build.phase = "failed";
        build.error = "Controlled image build failed.";
        build.completedAt = build.updatedAt = now();
        build.durationMs = Date.now() - started;
        await this.persist();
      }
    } finally {
      this.buildStreams.delete(build.id);
    }
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
      this.buildSettlers.set(build.id, resolve);
      const step = async () => {
        if (["cancelled", "failed"].includes(build.status)) {
          this.buildSettlers.delete(build.id);
          resolve();
          return;
        }
        if (input.fakePauseUntilRestart) {
          build.status = "running";
          build.phase = "building";
          build.updatedAt = now();
          await this.persist();
          this.timers.set(
            build.id,
            setTimeout(() => void step(), 100),
          );
          return;
        }
        const phase = phases[index++];
        build.status = "running";
        build.phase = phase!;
        build.startedAt ||= now();
        build.updatedAt = now();
        build.logs.push(safeLog(`[fake-builder] ${phase}`));
        const fault = this.state.faults[build.ownerId];
        if (fault?.failPhase === phase) {
          const failureMessage = fault?.message;
          delete this.state.faults[build.ownerId];
          build.status = "failed";
          build.phase = "failed";
          build.error = "Controlled image build failed.";
          build.logs.push(safeLog(failureMessage || "failure"));
          build.completedAt = build.updatedAt = now();
          build.durationMs = Date.now() - started;
          await this.persist();
          this.buildSettlers.delete(build.id);
          resolve();
          return;
        }
        if (index < phases.length) {
          await this.persist();
          this.timers.set(
            build.id,
            setTimeout(() => void step(), duration / phases.length),
          );
          return;
        }
        const digest = `sha256:${createHash("sha256").update(`${definition.id}:${snapshot.baseImage}:${snapshot.dockerfileFragment}:${now()}`).digest("hex")}`;
        const version = `v${definition.versions.length + 1}`;
        const stamp = now();
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
        await this.persist();
        this.buildSettlers.delete(build.id);
        resolve();
      };
      this.timers.set(
        build.id,
        setTimeout(() => void step(), 0),
      );
    });
  }
  build(id: string, ownerId: string, admin: boolean) {
    const b = this.state.builds.find((x) => x.id === id);
    if (!b) httpError(404, "Build not found");
    if (!admin && b.ownerId !== ownerId) httpError(403, "Forbidden");
    return b;
  }
  async cancelBuild(id: string, ownerId: string, admin: boolean) {
    const b = this.build(id, ownerId, admin);
    if (!["queued", "running"].includes(b.status)) return publicBuild(b);
    clearTimeout(this.timers.get(id));
    this.buildStreams.get(id)?.destroy();
    b.status = "cancelled";
    b.phase = "cancelled";
    b.completedAt = b.updatedAt = now();
    await this.persist();
    this.buildSettlers.get(id)?.();
    this.buildSettlers.delete(id);
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

  async promote(id: string, version: string, ownerId: string, admin: boolean) {
    const d = this.definition(id, ownerId, admin);
    const v = findVersion(d, version);
    d.promotedVersion = version;
    for (const item of d.versions) item.promoted = item.version === version;
    await this.persist();
    return { promotedVersion: version, promotedDigest: v.digest };
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
    const d = this.definition(id, ownerId, admin);
    findVersion(d, version);
    if (
      d.promotedVersion === version ||
      Object.values(this.state.userDefaults).some(
        (x) => x.definitionId === id && x.version === version,
      ) ||
      (this.state.systemDefault?.definitionId === id &&
        this.state.systemDefault.version === version) ||
      (await this.workerUsesVersion(id, version))
    )
      httpError(409, "Image version is referenced");
    const removed = findVersion(d, version);
    if (removed.artifactTag || removed.runtimeImage)
      await this.docker
        .getImage(removed.artifactTag || removed.runtimeImage!)
        .remove({ force: true })
        .catch(() => {});
    d.versions = d.versions.filter((v) => v.version !== version);
    await this.persist();
  }
  version(id: string, version: string, ownerId: string, admin: boolean) {
    return findVersion(this.definition(id, ownerId, admin), version);
  }

  async setUserDefault(ownerId: string, definitionId: string, version: string) {
    const d = this.definition(definitionId, ownerId, false);
    const v = findVersion(d, version);
    this.state.userDefaults[ownerId] = { definitionId, version };
    await this.persist();
    return { source: "user", definitionId, version, digest: v.digest };
  }
  async setSystemDefault(
    definitionId: string,
    version: string,
    ownerId: string,
  ) {
    const d = this.definition(definitionId, ownerId, true);
    const v = findVersion(d, version);
    this.state.systemDefault = { definitionId, version };
    await this.persist();
    return { source: "system", definitionId, version, digest: v.digest };
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
    const built = findVersion(
      definition,
      selectedVersion || definition.promotedVersion || "",
    );
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
  async setFault(ownerId: string, fault: any) {
    this.state.faults[ownerId] = {
      failPhase: String(fault.failPhase || ""),
      message: safeLog(String(fault.message || "")),
    };
    await this.persist();
    return { configured: true };
  }
  async simulateRestart() {
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
    await this.persist();
    return { recovered: true };
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
    const visible = this.list(ownerId, admin);
    const visibleIds = new Set(visible.map((definition) => definition.id));
    let partialArtifactsRemoved = 0,
      bytesReclaimed = 0,
      unusedVersionsRemoved = 0;
    if (input.failedBuilds)
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
    if (input.unusedArtifacts)
      for (const definition of visible) {
        const retained: ImageVersion[] = [];
        for (const version of definition.versions) {
          if (await this.versionReferenced(definition.id, version.version)) {
            retained.push(version);
            continue;
          }
          bytesReclaimed += await this.imageSize(
            version.artifactTag || version.runtimeImage,
          );
          await this.removeImage(version.artifactTag || version.runtimeImage);
          unusedVersionsRemoved++;
        }
        definition.versions = retained;
      }
    await this.persist();
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
        (await this.docker.getImage(reference).inspect()).Size || 0,
      );
    } catch {
      return 0;
    }
  }
  private async removeImage(reference?: string) {
    if (!reference) return false;
    try {
      await this.docker.getImage(reference).remove({ force: true });
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
  if (alias === "agentor-worker:approved-latest")
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
        }))
    : [];
  return {
    definitions,
    builds: Array.isArray(value?.builds) ? value.builds : [],
    userDefaults:
      value?.userDefaults && typeof value.userDefaults === "object"
        ? value.userDefaults
        : {},
    systemDefault: value?.systemDefault,
    faults:
      value?.faults && typeof value.faults === "object" ? value.faults : {},
  };
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
    httpError(400, "Dockerfile fragment violates build policy");
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
