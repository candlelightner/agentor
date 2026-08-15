import { randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from "unique-names-generator";
import type { Config } from "./config";
import { getAppType } from "./apps";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import * as tar from "tar-stream";
import { DockerService } from "./docker";
import type {
  EnvironmentJsonPayload,
  CapabilityJsonEntry,
  InstructionJsonEntry,
  WorkerJsonPayload,
  ImageConfigOverride,
} from "./docker";
import { normalizeExcludedGlobalEnvVarKeys, zeroUserEnvVars } from "./user-env-store";
import {
  WORKER_EXPORT_VERSION,
  BUNDLE_FILES,
  EXPORT_WORKSPACE_PATH,
  EXPORT_AGENTS_PATH,
  RESTORE_WORKSPACE_PARENT,
  RESTORE_AGENTS_PARENT,
  CREDENTIAL_EXCLUDE_SUFFIXES,
  SHARED_DATA_EXCLUDE_PREFIXES,
  writeManifest,
  writeGzipFile,
  writeFilteredAgentsGz,
  packBundle,
  extractBundle,
  validateGzipTarPayload,
  validateTarPayload,
} from "./worker-export";
import { recordWorkspaceTombstone } from "./workspace-tombstones";
import type { WorkerExportManifest } from "./worker-export";
import type {
  AppInstanceInfo,
  TmuxWindow,
  FileEntry,
  FileListing,
  MoveConflict,
} from "../../shared/types";
import { getAllGitCloneDomains } from "./git-providers";
import { getAllAgentApiDomains } from "./agent-config";
import {
  getPackageManagerDomains,
  DEFAULT_ENVIRONMENT_ID,
} from "./environments";
import { getUserById } from "./auth";
import type { EnvironmentStore, Environment } from "./environments";
import type { WorkerStore, WorkerRecord } from "./worker-store";
import type { UserCredentialManager } from "./user-credentials";
import type { UserEnvVarStore } from "./user-env-store";
import type { CapabilityStore } from "./capability-store";
import type { InstructionStore } from "./instruction-store";
import type { StorageManager } from "./storage";
import type {
  ExposeApis,
  ServiceStatus,
  ContainerInfo,
  ContainerStatus,
  CreateContainerRequest,
  UpdateContainerSettingsRequest,
  RepoConfig,
  MountConfig,
  UserEnvVars,
} from "../../shared/types";
import {
  normalizeClientPath,
  normalizeClientPathList,
  validateName,
  toContainerPath,
  parentRelPath,
  baseName,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_UPLOAD_ENTRIES,
} from "./workspace-path";
import {
  probeLstat,
  probeList,
  runProbeCheckMany,
} from "./workspace-probe-runner";
import { buildWorkspaceZip, demuxSingleFileFromTar } from "./workspace-zip";
import {
  useWorkerConfigStore,
  parseDotEnv,
  type WorkerConfigInputEntry,
} from "./worker-config-store";

interface ResolvedEnvConfig {
  cpuLimit?: number;
  memoryLimit?: string;
  dockerEnabled?: boolean;
  environmentJson: EnvironmentJsonPayload;
  capabilitiesJson: CapabilityJsonEntry[];
  instructionsJson: InstructionJsonEntry[];
}

function normalizeWorkerConfiguration(
  input: NonNullable<CreateContainerRequest["workerConfiguration"]>,
): WorkerConfigInputEntry[] {
  const variables = new Map<string, string>();
  if (input.envFile !== undefined)
    for (const entry of parseDotEnv(input.envFile))
      variables.set(entry.key, entry.value);
  for (const entry of input.variables ?? []) {
    if (variables.has(entry.key) && input.envFile === undefined)
      throw new Error(`Duplicate configuration name: "${entry.key}"`);
    variables.set(entry.key, entry.value);
  }
  return [
    ...[...variables].map(([key, value]) => ({
      kind: "variable" as const,
      key,
      value,
    })),
    ...(input.secrets ?? []).map(({ key, value }) => ({
      kind: "secret" as const,
      key,
      value,
    })),
    ...(input.secretFiles ?? []).map(({ name, path, content }) => ({
      kind: "secretFile" as const,
      key: name,
      fileName: path,
      value: content,
    })),
  ];
}

/** The worker's UUID `id` — the only identifying label on a worker container.
 * Everything else (userId, config) lives in the WorkerStore record. The
 * `agentor.managed` label string is owned by `docker.ts` (read/written there). */
const WORKER_ID_LABEL = "agentor.id";
/** Repo prefix for per-worker images created by `docker import` on restore. */
const IMPORT_IMAGE_PREFIX = "agentor-import-";

export class ContainerManager {
  /** Reattach a freshly created/rebuilt worker to owner-managed networks. Failure
   * is logged only: the worker lifecycle succeeded and the network remains
   * inspectable/reconcilable rather than leaving a half-created worker. */
  private async reconcileManagedNetworksForWorker(userId: string) {
    const [{ useManagedNetworkStore }, { useManagedNetworkManager }] =
      await Promise.all([
        import("./services"),
        import("./managed-network-manager"),
      ]);
    for (const network of useManagedNetworkStore().listForUser(userId))
      await useManagedNetworkManager()
        .reconcile(network)
        .catch((error) =>
          useLogger().warn(
            `[container] managed network reconcile failed: ${error instanceof Error ? error.message : error}`,
          ),
        );
  }
  /** Keyed by the worker's UUID `id` (stable across rebuild/unarchive). */
  private containers: Map<string, ContainerInfo> = new Map();
  private dockerService: DockerService;
  private config: Config;
  private environmentStore?: EnvironmentStore;
  private workerStore?: WorkerStore;
  private userCredentialManager?: UserCredentialManager;
  private userEnvStore?: UserEnvVarStore;
  private capabilityStore?: CapabilityStore;
  private instructionStore?: InstructionStore;
  private storageManager?: StorageManager;
  constructor(dockerService: DockerService, config: Config) {
    this.dockerService = dockerService;
    this.config = config;
  }

  setEnvironmentStore(store: EnvironmentStore): void {
    this.environmentStore = store;
  }

  setWorkerStore(store: WorkerStore): void {
    this.workerStore = store;
  }

  setUserCredentialManager(manager: UserCredentialManager): void {
    this.userCredentialManager = manager;
  }

  setUserEnvStore(store: UserEnvVarStore): void {
    this.userEnvStore = store;
  }

  setCapabilityStore(store: CapabilityStore): void {
    this.capabilityStore = store;
  }

  setInstructionStore(store: InstructionStore): void {
    this.instructionStore = store;
  }

  setStorageManager(manager: StorageManager): void {
    this.storageManager = manager;
  }

  /** Build the globally unique Docker container name from the worker's UUID `id`:
   * `<containerPrefix>-<id>`. UUIDs are DNS-label-safe. */
  buildContainerName(id: string): string {
    return `${this.config.containerPrefix}-${id}`;
  }

  /** VS Code tunnel name — must be 3-20 alphanumeric + hyphens. The worker `id`
   * already guarantees global uniqueness; take a userId-prefixed slice so it
   * fits the length cap. */
  private buildTunnelName(userId: string, workerId: string): string {
    const shortId = userId.slice(0, 8);
    return `${shortId}-${workerId}`.slice(0, 20);
  }

  private async resolveUserEnvAndBinds(
    userId: string,
    excludedKeys: unknown = [],
    workerId?: string,
    excludedGroupKeys: unknown = [],
    targetGroupId?: string,
  ): Promise<{ userEnv: UserEnvVars; credentialBinds: string[]; groupSecrets: Array<{kind:"secret";key:string;value:string}> }> {
    const source =
      this.userEnvStore?.getOrDefault(userId) ?? zeroUserEnvVars(userId);
    const excluded = new Set(normalizeExcludedGlobalEnvVarKeys(source, excludedKeys));
    const merged = new Map(source.envVars.filter(({ key }) => !excluded.has(key)).map((entry) => [entry.key, entry.value]));
    const groupSecrets: Array<{kind:"secret";key:string;value:string}>=[];
    if (workerId) {
      const [{ useWorkerGroupStore }, { resolveGroupEnv }] = await Promise.all([import("./services"), import("./worker-group-env")]);
      const memberships = targetGroupId ? [useWorkerGroupStore().get(userId,targetGroupId)].filter(Boolean) : useWorkerGroupStore().listForUser(userId).filter((group) => group.workerIds.includes(workerId));
      if (memberships.length > 1) throw Object.assign(new Error("Worker has conflicting group memberships"), { statusCode: 409 });
      if (memberships[0]) {
        const groupExcluded = new Set(Array.isArray(excludedGroupKeys) ? excludedGroupKeys.filter((key): key is string => typeof key === "string") : []);
        const groupEnv = await resolveGroupEnv(userId, memberships[0].id);
        for (const { key, value } of groupEnv.entries) if (!groupExcluded.has(key)) groupSecrets.push({kind:"secret",key,value});
      }
    }
    const userEnv = { ...source, envVars: [...merged].map(([key,value])=>({key,value})) };
    const credentialBinds: string[] = [];
    if (this.userCredentialManager && userId) {
      await this.userCredentialManager.ensureUserDir(userId);
      credentialBinds.push(
        ...this.userCredentialManager.getBindMountsForUser(userId),
      );
    }
    if (this.storageManager && userId) {
      await this.storageManager.ensureUserSshDir(userId);
      await this.storageManager.ensureUserKiloConfigDir(userId);
      await this.storageManager.ensureUserKiloSharedDataDir(userId);
      try {
        credentialBinds.push(
          this.storageManager.getSshAuthorizedKeysBind(userId),
        );
      } catch (err) {
        useLogger().warn(
          `[container] unable to build ssh authorized_keys bind for user ${userId}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        credentialBinds.push(this.storageManager.getKiloConfigBind(userId));
      } catch (err) {
        useLogger().warn(
          `[container] unable to build Kilo config bind for user ${userId}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        credentialBinds.push(this.storageManager.getKiloSharedDataBind(userId));
      } catch (err) {
        useLogger().warn(
          `[container] unable to build Kilo shared-data bind for user ${userId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { userEnv, credentialBinds, groupSecrets };
  }

  /** Resolve the worker's git identity live from the owning user. The worker
   * references the owner by `userId` only — name/email are never snapshotted onto
   * the worker record, so they always reflect the user's current profile. */
  private resolveGitIdentity(userId: string): {
    gitName: string;
    gitEmail: string;
  } {
    const user = getUserById(userId);
    return { gitName: user?.name ?? "", gitEmail: user?.email ?? "" };
  }

  private resolveCapabilitiesAndInstructions(
    enabledCapabilityIds: string[] | null | undefined,
    enabledInstructionIds: string[] | null | undefined,
    exposeApis: ExposeApis,
  ): {
    capabilitiesJson: CapabilityJsonEntry[];
    instructionsJson: InstructionJsonEntry[];
  } {
    const instructionsJson: InstructionJsonEntry[] = [];
    if (this.instructionStore) {
      const allEntries = this.instructionStore.list();
      const enabledEntries =
        enabledInstructionIds === null || enabledInstructionIds === undefined
          ? allEntries
          : allEntries.filter((i) => enabledInstructionIds!.includes(i.id));

      for (const entry of enabledEntries) {
        instructionsJson.push({ name: entry.name, content: entry.content });
      }
    }

    const capabilitiesJson: CapabilityJsonEntry[] = [];
    if (this.capabilityStore) {
      const allCapabilities = this.capabilityStore.list();
      let enabledCapabilities =
        enabledCapabilityIds === null || enabledCapabilityIds === undefined
          ? allCapabilities
          : allCapabilities.filter((s) => enabledCapabilityIds!.includes(s.id));

      // Keyed by the built-in capability's slug, which is its `name` (the id is
      // now a derived UUID). Gated on `builtIn` so a user's custom capability
      // that happens to share the name is never auto-filtered.
      const apiCapabilityFilter: Record<string, keyof ExposeApis> = {
        "port-mapping": "portMappings",
        "domain-mapping": "domainMappings",
        usage: "usage",
      };
      enabledCapabilities = enabledCapabilities.filter((s) => {
        const apiKey = s.builtIn ? apiCapabilityFilter[s.name] : undefined;
        return !apiKey || exposeApis[apiKey];
      });

      for (const capability of enabledCapabilities) {
        capabilitiesJson.push({
          name: capability.name,
          content: capability.content,
        });
      }
    }

    return { capabilitiesJson, instructionsJson };
  }

  private resolveEnvironmentConfig(environmentId?: string): ResolvedEnvConfig {
    const defaultExposeApis: ExposeApis = {
      portMappings: true,
      domainMappings: true,
      usage: true,
    };

    if (!this.environmentStore) {
      const { capabilitiesJson, instructionsJson } =
        this.resolveCapabilitiesAndInstructions(null, null, defaultExposeApis);
      return {
        environmentJson: {
          networkMode: "full",
          allowedDomains: [],
          dockerEnabled: true,
          setupScript: "",
          envVars: "",
          exposeApis: defaultExposeApis,
        },
        capabilitiesJson,
        instructionsJson,
      };
    }

    const resolvedId = environmentId || DEFAULT_ENVIRONMENT_ID;
    const env = this.environmentStore.getById(resolvedId);
    if (!env) throw new Error(`Environment not found: ${resolvedId}`);

    let domains: string[] = [];
    if (env.networkMode === "package-managers") {
      domains = [...getPackageManagerDomains()];
    } else if (env.networkMode === "custom") {
      domains = [...env.allowedDomains];
      if (env.includePackageManagerDomains) {
        domains.push(...getPackageManagerDomains());
      }
    }

    if (env.networkMode !== "full" && env.networkMode !== "block-all") {
      domains.push(...getAllAgentApiDomains());
      domains.push(...getAllGitCloneDomains());
    }

    const exposeApis: ExposeApis = env.exposeApis ?? defaultExposeApis;
    const { capabilitiesJson, instructionsJson } =
      this.resolveCapabilitiesAndInstructions(
        env.enabledCapabilityIds,
        env.enabledInstructionIds,
        exposeApis,
      );

    const dockerEnabled = env.dockerEnabled ?? true;

    return {
      cpuLimit: env.cpuLimit != null ? env.cpuLimit : undefined,
      memoryLimit: env.memoryLimit || undefined,
      dockerEnabled,
      environmentJson: {
        networkMode: env.networkMode || "full",
        allowedDomains: domains,
        dockerEnabled,
        setupScript: env.setupScript || "",
        envVars: env.envVars || "",
        exposeApis,
      },
      capabilitiesJson,
      instructionsJson,
    };
  }

  /** Derive the effective resource limits + DinD flag for a worker from its
   * resolved environment config, falling back to the orchestrator defaults.
   * Identical across create/rebuild/unarchive/import — extracted so the four
   * lifecycle paths can never drift. */
  private deriveLimits(env: ResolvedEnvConfig): {
    cpuLimit?: number;
    memoryLimit?: string;
    dockerEnabled: boolean;
  } {
    return {
      cpuLimit: env.cpuLimit ?? this.config.defaultCpuLimit ?? undefined,
      memoryLimit:
        env.memoryLimit || this.config.defaultMemoryLimit || undefined,
      dockerEnabled: env.dockerEnabled ?? true,
    };
  }

  private static readonly STATE_MAP: Record<string, ContainerStatus> = {
    running: "running",
    exited: "stopped",
    created: "creating",
    dead: "error",
    removing: "removing",
  };

  async sync(): Promise<void> {
    const dockerContainers = await this.dockerService.listContainers();

    // Administrative workspaces are registered explicitly by their dedicated
    // runtime and intentionally do not carry the ordinary `agentor.id` worker
    // label. Preserve those external registrations across inventory refreshes;
    // otherwise the clear below makes terminal/editor/desktop routes forget a
    // healthy admin workspace until its runtime happens to register it again.
    // The dedicated runtime remains authoritative for start/stop/rebuild/remove
    // and updates or unregisters these entries explicitly. `listContainers()`
    // only returns `agentor.managed=true`; administrative containers are
    // deliberately `agentor.managed=false`, so they cannot be reconciled from
    // this filtered inventory.
    const external = Array.from(this.containers.values()).filter(
      (info) => Boolean(info.administrativeKind),
    );

    this.containers.clear();

    for (const dc of dockerContainers) {
      const containerName =
        dc.Names[0]?.replace(/^\//, "") || dc.Id.slice(0, 12);
      const labels = dc.Labels ?? {};
      // The worker UUID `id` is the only identifying label; resolve the
      // authoritative record (with userId + config) from the WorkerStore.
      const labelId = labels[WORKER_ID_LABEL] ?? "";
      // DockerService also discovers Agentor-owned auxiliary containers (for
      // example the persistent administrative workspace).  They deliberately
      // have no ordinary-worker identity and must never be projected into the
      // user-scoped WorkerStore.  Besides corrupting the inventory, doing so
      // supplies an empty owner id and can abort the services plugin during an
      // orchestrator restart before the administrative runtime is registered.
      if (!labelId) continue;
      const worker = labelId ? this.workerStore?.findById(labelId) : undefined;

      const id = worker?.id ?? labelId;
      const now = new Date().toISOString();

      this.containers.set(id, {
        id,
        userId: worker?.userId ?? "",
        createdAt: worker?.createdAt ?? now,
        updatedAt: worker?.updatedAt ?? now,
        containerId: dc.Id,
        containerName,
        displayName: worker?.displayName ?? containerName,
        imageName: dc.Image,
        imageId: dc.ImageID,
        status: ContainerManager.STATE_MAP[dc.State] || "error",
        repos: worker?.repos,
        mounts: worker?.mounts,
        initScript: worker?.initScript,
        environmentId: worker?.environmentId,
        excludedGlobalEnvVarKeys: worker?.excludedGlobalEnvVarKeys ?? [],
        excludedGroupEnvVarKeys: worker?.excludedGroupEnvVarKeys ?? [],
        pendingRebuild: worker?.pendingRebuild,
        importedImage: worker?.importedImage,
        imageDefinitionId: worker?.imageDefinitionId,
        imageVersion: worker?.imageVersion,
        imageDigest: worker?.imageDigest,
        imageRuntimeReference: worker?.imageRuntimeReference,
      });
    }

    for (const info of external) this.containers.set(info.id, info);

    useLogger().debug(`[container] synced ${this.containers.size} containers`);
  }

  list(): ContainerInfo[] {
    return Array.from(this.containers.values());
  }
  /** Register a platform-managed runtime (currently the trusted administrative
   * workspace) for reuse by terminal/editor/desktop APIs without persisting it
   * as an ordinary user worker. */
  registerExternal(info: ContainerInfo): void {
    this.containers.set(info.id, info);
  }
  unregisterExternal(id: string): void {
    this.containers.delete(id);
  }
  private assertOrdinaryMutation(info: ContainerInfo) {
    if (info.administrativeKind || info.userId === "__agentor_admin__") {
      const error = new Error(
        "Administrative workspace lifecycle requires the dedicated confirmed admin API",
      ) as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
  }

  /** Look up a worker by its UUID `id`. */
  get(id: string): ContainerInfo | undefined {
    return this.containers.get(id);
  }

  /** Resolve a worker `id` to its current Docker container id (for dockerode
   * calls). Throws if the worker is unknown. */
  private dockerIdFor(id: string): string {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    return info.containerId;
  }

  /** Find an active worker by its globally unique Docker container name. */
  findByContainerName(containerName: string): ContainerInfo | undefined {
    for (const c of this.containers.values()) {
      if (c.containerName === containerName) return c;
    }
    return undefined;
  }

  /** Suggest a friendly display-name slug (e.g. `happy-panda`) for a new worker,
   * avoiding collisions with the user's existing display names where possible.
   * Display names are free-form and not required to be unique — this is only a
   * convenience default for the create form. */
  suggestDisplayName(userId: string): string {
    const taken = new Set<string>();
    for (const c of this.containers.values()) {
      if (c.userId === userId && c.displayName)
        taken.add(c.displayName.toLowerCase());
    }
    for (const w of this.workerStore?.listForUser(userId) ?? []) {
      if (w.displayName) taken.add(w.displayName.toLowerCase());
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = uniqueNamesGenerator({
        dictionaries: [adjectives, animals],
        separator: "-",
        style: "lowerCase",
      });
      if (!taken.has(candidate)) return candidate;
    }
    return `worker-${nanoid(6).toLowerCase()}`;
  }

  async create(request: CreateContainerRequest): Promise<ContainerInfo> {
    const userId = request.userId ?? "";
    if (!userId) throw new Error("create: userId is required");

    const envConfig = this.resolveEnvironmentConfig(request.environmentId);

    // The worker's identity is an immutable UUID `id`. The user-facing label is
    // the free-form, editable `displayName` (defaulted to a friendly slug when
    // the user provides none). The Docker container is described by the separate
    // `containerId` (assigned by Docker) and `containerName` (`<prefix>-<id>`).
    const id = randomUUID();
    const displayName =
      request.displayName?.trim() || this.suggestDisplayName(userId);
    const containerName = this.buildContainerName(id);
    const workerConfigStore = useWorkerConfigStore();

    const repos = request.repos?.filter((r) => r.url) || [];

    // Resource limits are an environment property (no per-worker override).
    const { cpuLimit, memoryLimit, dockerEnabled } =
      this.deriveLimits(envConfig);

    // Git identity resolved live from the owner — never stored on the worker.
    const { gitName, gitEmail } = this.resolveGitIdentity(userId);

    const workerJson: WorkerJsonPayload = {
      id,
      displayName,
      repos,
      initScript: request.initScript?.trim() || "",
      gitName,
      gitEmail,
    };

    const accountEnv = this.userEnvStore?.getOrDefault(userId) ?? zeroUserEnvVars(userId);
    const excludedGlobalEnvVarKeys = normalizeExcludedGlobalEnvVarKeys(accountEnv, request.excludedGlobalEnvVarKeys);
    if (request.excludedGroupEnvVarKeys !== undefined &&
        (!Array.isArray(request.excludedGroupEnvVarKeys) || request.excludedGroupEnvVarKeys.some((key) => typeof key !== "string")))
      throw Object.assign(new Error("excludedGroupEnvVarKeys must be an array of strings"), { statusCode: 400 });
    const excludedGroupEnvVarKeys = [...new Set(request.excludedGroupEnvVarKeys ?? [])].sort();
    if (excludedGroupEnvVarKeys.length) {
      if (!request.targetWorkerGroupId)
        throw Object.assign(new Error("Group environment exclusions require an authorized target worker group"), { statusCode: 400 });
      const [{ useWorkerGroupStore }, { publicGroupEnvKeys }] = await Promise.all([
        import("./services"),
        import("./worker-group-env"),
      ]);
      const group = useWorkerGroupStore().get(userId, request.targetWorkerGroupId);
      if (!group)
        throw Object.assign(new Error("Worker group not found"), { statusCode: 404 });
      const allowed = new Set((await publicGroupEnvKeys(userId, group.id)).effectiveKeys);
      if (excludedGroupEnvVarKeys.some((key) => !allowed.has(key)))
        throw Object.assign(new Error("Unknown group environment variable key"), { statusCode: 400 });
    }
    const { userEnv, credentialBinds, groupSecrets } =
      await this.resolveUserEnvAndBinds(userId, excludedGlobalEnvVarKeys, id, excludedGroupEnvVarKeys, request.targetWorkerGroupId);
    if (request.workerConfiguration) {
      await workerConfigStore.replace(
        userId,
        id,
        normalizeWorkerConfiguration(request.workerConfiguration),
      );
    }
    const workerConfig = await workerConfigStore.resolveValues(userId, id);

    const container = await this.dockerService
      .createWorkerContainer({
        userId,
        id,
        containerName,
        cpuLimit,
        memoryLimit,
        mounts: request.mounts,
        dockerEnabled,
        credentialBinds,
        environmentJson: envConfig.environmentJson,
        capabilitiesJson: envConfig.capabilitiesJson,
        instructionsJson: envConfig.instructionsJson,
        workerJson,
        storageManager: this.storageManager,
        userEnv,
        workerConfig: [...groupSecrets, ...workerConfig],
        image: request.imageRuntimeReference,
      })
      .catch(async (err) => {
        await workerConfigStore.remove(userId, id).catch(() => {});
        throw err;
      });

    const imageName =
      request.imageRuntimeReference ||
      this.config.workerImagePrefix + this.config.workerImage;
    const now = new Date().toISOString();

    const mounts = request.mounts?.length ? request.mounts : undefined;
    const initScript = request.initScript?.trim() || undefined;

    const containerInfo: ContainerInfo = {
      id,
      userId,
      createdAt: now,
      updatedAt: now,
      containerId: container.id,
      containerName,
      displayName,
      imageName,
      imageId: request.imageDigest || "",
      status: "running",
      repos: repos.length > 0 ? repos : undefined,
      mounts,
      initScript,
      environmentId: request.environmentId,
      excludedGlobalEnvVarKeys,
      excludedGroupEnvVarKeys,
      pendingRebuild: false,
      imageDefinitionId: request.imageDefinitionId,
      imageVersion: request.imageVersion,
      imageDigest: request.imageDigest,
      imageRuntimeReference: request.imageRuntimeReference,
    };

    this.containers.set(id, containerInfo);

    // If persisting the record fails (disk full, EACCES on the per-user
    // workers.json, …), the container is already created + started — roll it
    // back (container, in-memory entry, volumes) so a failed create doesn't
    // leak an orphan worker the store doesn't know about. Mirrors importWorker.
    try {
      if (this.workerStore) {
        await this.workerStore.upsert(
          this.containerInfoToWorkerRecord(containerInfo),
        );
      }
      await workerConfigStore.markApplied(userId, id);
    } catch (err) {
      this.containers.delete(id);
      await workerConfigStore.remove(userId, id).catch(() => {});
      await this.dockerService.removeContainer(container.id).catch(() => {});
      if (this.storageManager) {
        await this.storageManager
          .removeWorkerWorkspace(userId, id, containerName)
          .catch(() => {});
        await this.storageManager
          .removeWorkerAgents(userId, id, containerName)
          .catch(() => {});
        if (dockerEnabled)
          await this.storageManager
            .removeWorkerDocker(containerName)
            .catch(() => {});
      }
      throw err;
    }

    // Attach log collector to the new container
    useLogCollector()
      .attach(containerName, container.id, "worker", displayName)
      .catch(() => {});

    useLogger().info(
      `[container] created worker ${containerName} (${container.id.slice(0, 12)})`,
    );
    await this.reconcileManagedNetworksForWorker(userId);

    return containerInfo;
  }

  private assertRunning(id: string): ContainerInfo {
    const info = this.containers.get(id);
    if (!info || info.status !== "running") {
      throw new Error("Worker container is not running");
    }
    return info;
  }

  async uploadToWorkspace(id: string, tarBuffer: Buffer): Promise<void> {
    const info = this.assertRunning(id);
    await this.dockerService.putWorkspaceArchive(info.containerId, tarBuffer);
  }

  async downloadWorkspace(id: string): Promise<NodeJS.ReadableStream> {
    const info = this.assertRunning(id);
    return this.dockerService.getWorkspaceArchive(info.containerId);
  }

  // --- Full /workspace file manager ---
  //
  // All methods below operate ONLY through Docker exec/getArchive/putArchive
  // against the running worker, as uid 1000 (`agent`). Client paths are
  // lexically validated (workspace-path.ts) and re-checked in-container via
  // realpath/lstat containment (workspace-probe.ts) so a symlink can never
  // redirect an operation outside /workspace. Host workspace paths are never
  // used. Errors carry `statusCode` so `rethrowAsHttpError` preserves them.

  /** Resolve a worker id to its container id, throwing a 409-tagged error when
   *  the worker is not running (so the route maps it to 409, not 500). */
  private dockerIdForFiles(id: string): string {
    const info = this.containers.get(id);
    if (!info) {
      const err = new Error("Container not found") as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    if (info.status !== "running") {
      const err = new Error("Worker container is not running") as Error & {
        statusCode?: number;
      };
      err.statusCode = 409;
      throw err;
    }
    return info.containerId;
  }

  /** `GET /api/containers/:id/files?path=` — lazy one-level directory listing
   *  (dirs first, then by name) with symlink-escape metadata. `path` defaults
   *  to the workspace root. */
  async listFiles(id: string, path: string): Promise<FileListing> {
    const containerId = this.dockerIdForFiles(id);
    const rel = normalizeClientPath(path, { allowRoot: true });
    return probeList(this.dockerService, containerId, rel);
  }

  /**
   * `POST /api/containers/:id/files/upload` — extract uploaded files into the
   *  destination directory `destRel` (relative to /workspace). `entries` are
   *  the multipart parts already sanitised to relative paths with their data.
   *  Escaping targets (incl. nested paths whose parent is an escaping symlink)
   *  are rejected via check_many BEFORE any byte is written, regardless of
   *  `overwrite`. When `overwrite` is false, conflicting existing targets are
   *  additionally reported via 409. Total bytes/entries are capped (413). Tar
   *  entries are written uid/gid 1000 with directory/file modes.
   */
  async uploadFiles(
    id: string,
    destRel: string,
    entries: { rel: string; data: Buffer; isDir?: boolean }[],
    overwrite: boolean,
  ): Promise<{ uploaded: number }> {
    const containerId = this.dockerIdForFiles(id);
    const dest = normalizeClientPath(destRel, { allowRoot: true });

    // Destination must exist and be a directory contained in /workspace.
    const destEntry = await probeLstat(this.dockerService, containerId, dest);
    if (destEntry.type !== "directory") {
      const err = new Error(
        "Upload destination is not a directory",
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }

    if (entries.length === 0) {
      const err = new Error("No files provided") as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }
    if (entries.length > MAX_UPLOAD_ENTRIES) {
      const err = new Error(
        `Upload exceeds the ${MAX_UPLOAD_ENTRIES} entry limit`,
      ) as Error & { statusCode?: number };
      err.statusCode = 413;
      throw err;
    }

    // Compute target relative paths (under /workspace) and enforce the total
    // byte cap before packing anything.
    const targets: { rel: string; data: Buffer; isDir?: boolean }[] = [];
    let totalBytes = 0;
    const seenTargets = new Set<string>();
    for (const e of entries) {
      // Each part's own relative path is validated here (defence in depth —
      // the route also validates). Empty/`.`/`..`/backslash/absolute are rejected.
      const partRel = normalizeClientPath(e.rel, { allowRoot: false });
      const targetRel = dest === "" ? partRel : `${dest}/${partRel}`;
      if (seenTargets.has(targetRel)) continue;
      seenTargets.add(targetRel);
      if (!e.isDir) totalBytes += e.data.length;
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
        const err = new Error(
          `Upload exceeds the ${MAX_UPLOAD_TOTAL_BYTES} byte limit`,
        ) as Error & { statusCode?: number };
        err.statusCode = 413;
        throw err;
      }
      targets.push({ rel: targetRel, data: e.data, isDir: e.isDir });
    }

    // ALWAYS run check_many: it is the primary escape gate (it walks to the
    // nearest existing ancestor for each target, so a nested upload path whose
    // parent is an escaping symlink is rejected here — even when overwrite is
    // true). With overwrite=false it also surfaces conflicts.
    const { existing, escaping } = await runProbeCheckMany(
      this.dockerService,
      containerId,
      targets.map((t) => t.rel),
    );
    if (escaping.length > 0) {
      const err = new Error(
        "Upload target escapes the workspace root",
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (!overwrite && existing.length > 0) {
      const err = new Error("Upload conflicts with existing paths") as Error & {
        statusCode?: number;
        conflicts?: string[];
      };
      err.statusCode = 409;
      (err as any).conflicts = existing.map((p) =>
        p.replace(/^\/workspace\/?/, ""),
      );
      throw err;
    }

    // Pack a tar whose entry names are the full relative paths under /workspace;
    // putArchive into /workspace lands each entry at the right place. Emit
    // parent directories explicitly: Docker otherwise creates implicit
    // parents as root, leaving an agent-owned file inside a directory that the
    // agent cannot later rename, move, or delete. Directory headers are safe
    // for existing workspace directories and normalize them to the worker uid.
    const pack = tar.pack();
    let count = 0;
    const directoryEntries = new Set<string>();
    for (const target of targets) {
      const segments = target.rel.split("/").filter(Boolean);
      const parentLength = target.isDir ? segments.length : segments.length - 1;
      for (let i = 1; i <= parentLength; i++) {
        directoryEntries.add(segments.slice(0, i).join("/"));
      }
    }
    for (const name of [...directoryEntries].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    )) {
      pack.entry({
        name,
        type: "directory",
        mode: 0o755,
        uid: 1000,
        gid: 1000,
      });
    }
    for (const t of targets) {
      if (t.isDir) {
        count++;
      } else {
        pack.entry(
          {
            name: t.rel,
            size: t.data.length,
            mode: 0o644,
            uid: 1000,
            gid: 1000,
          },
          t.data,
        );
        count++;
      }
    }
    pack.finalize();

    const chunks: Buffer[] = [];
    for await (const chunk of pack) chunks.push(chunk as Buffer);
    const tarBuffer = Buffer.concat(chunks);

    await this.dockerService.putArchive(containerId, tarBuffer, "/workspace");
    return { uploaded: count };
  }

  /** `POST /api/containers/:id/files/mkdir` — create `rel` (and parents)
   *  idempotently; 409 if a non-directory file blocks the path. The nearest
   *  existing ancestor's realpath must be contained in /workspace (so an
   *  escaping symlink on the path is rejected before `mkdir -p`). Implemented
   *  with `mkdir -p` as the `agent` user via positional argv (no shell). */
  async mkdirFiles(id: string, rel: string): Promise<{ ok: true }> {
    const containerId = this.dockerIdForFiles(id);
    const target = normalizeClientPath(rel, { allowRoot: false });
    const full = toContainerPath(target);

    // If the path already exists, honour idempotency (dir) or 409 (file).
    // probeLstat also enforces containment (realpath) for the existing path.
    try {
      const entry = await probeLstat(this.dockerService, containerId, target);
      if (entry.type === "directory") return { ok: true };
      const err = new Error("A file already exists at that path") as Error & {
        statusCode?: number;
      };
      err.statusCode = 409;
      throw err;
    } catch (err: any) {
      // 404 (not found) is expected — proceed to create. Re-throw other errors
      // (incl. 400 escapes from probeLstat).
      if (err?.statusCode !== 404) throw err;
    }

    // Validate the nearest existing ancestor's containment before creating —
    // a `mkdir -p` under an escaping symlink would otherwise create outside
    // /workspace. check_many walks to the nearest existing ancestor for a
    // missing path and reports it as escaping when that ancestor escapes.
    const { escaping } = await runProbeCheckMany(
      this.dockerService,
      containerId,
      [target],
    );
    if (escaping.length > 0) {
      const err = new Error(
        "mkdir target escapes the workspace root",
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const res = await this.dockerService.execCapture(
      containerId,
      ["mkdir", "-p", full],
      { user: "agent" },
    );
    if (res.exitCode !== 0) {
      // mkdir -p fails (e.g. a file blocks an intermediate segment) -> 409.
      const err = new Error(
        `mkdir failed: ${res.stderr.toString("utf8").trim() || "unknown error"}`,
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    return { ok: true };
  }

  /** `POST /api/containers/:id/files/rename` — same-directory rename, no
   *  overwrite. Both source and target are validated; the target must not
   *  exist (409) and must not escape /workspace. Uses GNU `mv --no-target-
   *  directory --no-clobber` (exact target, no-clobber) as the `agent` user via
   *  positional argv, then verifies the source disappeared and the target
   *  exists — GNU `mv -n` can exit 0 on a skip, so success is confirmed by the
   *  post-move filesystem state, not the exit code alone. */
  async renameFile(
    id: string,
    rel: string,
    newName: string,
  ): Promise<{ ok: true }> {
    const containerId = this.dockerIdForFiles(id);
    const src = normalizeClientPath(rel, { allowRoot: false });
    const name = validateName(newName, "newName");
    const parent = parentRelPath(src);
    const targetRel = parent === "" ? name : `${parent}/${name}`;

    // Source must exist and be contained.
    await probeLstat(this.dockerService, containerId, src);

    // Target must not exist (no overwrite) and must not escape /workspace.
    // check_many reports a missing target as escaping when its nearest existing
    // ancestor escapes (e.g. renaming into a path under an escaping symlink).
    const { existing, escaping } = await runProbeCheckMany(
      this.dockerService,
      containerId,
      [targetRel],
    );
    if (escaping.length > 0) {
      const err = new Error(
        "Rename target escapes the workspace root",
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (existing.length > 0) {
      const err = new Error(
        "A file or directory with that name already exists",
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }

    const srcFull = toContainerPath(src);
    const targetFull = toContainerPath(targetRel);
    // --no-target-directory (-T): treat the target as a file, not "move into dir".
    // --no-clobber (-n): never overwrite an existing target. Both via argv.
    const res = await this.dockerService.execCapture(
      containerId,
      ["mv", "--no-target-directory", "--no-clobber", srcFull, targetFull],
      { user: "agent" },
    );
    // GNU `mv -n` exits 0 even when it skipped because the target existed. We
    // already ruled out an existing target above, but a race could still cause a
    // skip — confirm the move actually happened by the post-move state.
    const postSrc = await this.dockerService.execCapture(
      containerId,
      ["test", "-e", srcFull],
      { user: "agent" },
    );
    const postTarget = await this.dockerService.execCapture(
      containerId,
      ["test", "-e", targetFull],
      { user: "agent" },
    );
    if (postSrc.exitCode === 0 || postTarget.exitCode !== 0) {
      // Source still present or target missing — the move did not happen.
      const err = new Error(
        `rename failed: ${res.stderr.toString("utf8").trim() || "source was not moved"}`,
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    return { ok: true };
  }

  /**
   * `POST /api/containers/:id/files/move` — move every `srcRels` entry into the
   *  existing destination directory `destRel` (`` for the workspace root). When
   *  `overwrite` is false, the full conflict list is returned via a 409 BEFORE
   *  any move. Escaping symlinks/parents and escaping targets are rejected up
   *  front. Uses GNU `mv --no-target-directory` (exact target semantics) with
   *  `--no-clobber` (overwrite=false) or `--force` (overwrite=true) as the
   *  `agent` user via positional argv, then verifies each move by the post-move
   *  filesystem state (GNU `mv -n` can exit 0 on a skip).
   */
  async moveFiles(
    id: string,
    srcRels: string[],
    destRel: string,
    overwrite: boolean,
  ): Promise<{ moved: number; conflicts?: MoveConflict[] }> {
    const containerId = this.dockerIdForFiles(id);
    const srcs = normalizeClientPathList(srcRels, { allowRoot: false });
    // The destination may be the workspace root itself.
    const dest = normalizeClientPath(destRel, { allowRoot: true });

    // Destination must exist and be a directory.
    const destEntry = await probeLstat(this.dockerService, containerId, dest);
    if (destEntry.type !== "directory") {
      const err = new Error("Move destination is not a directory") as Error & {
        statusCode?: number;
      };
      err.statusCode = 409;
      throw err;
    }

    // Each source must exist and be contained; compute its target inside dest.
    const moves: { src: string; targetRel: string }[] = [];
    for (const src of srcs) {
      await probeLstat(this.dockerService, containerId, src);
      const base = baseName(src);
      const targetRel = dest === "" ? base : `${dest}/${base}`;
      if (targetRel === src) continue; // already in the requested destination
      if (targetRel.startsWith(`${src}/`)) {
        const err = new Error(
          "Cannot move a directory into itself or its descendant",
        ) as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      moves.push({ src, targetRel });
    }
    if (moves.length === 0) return { moved: 0 };

    // Always check_many on the targets: it is the escape gate (walks to the
    // nearest existing ancestor for a missing target, so a move into a path
    // under an escaping symlink is rejected) and, with overwrite=false, also
    // surfaces the conflict list.
    const { existing, escaping } = await runProbeCheckMany(
      this.dockerService,
      containerId,
      moves.map((m) => m.targetRel),
    );
    if (escaping.length > 0) {
      const err = new Error(
        "Move target escapes the workspace root",
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (!overwrite && existing.length > 0) {
      const existingSet = new Set(existing);
      const conflicts: MoveConflict[] = [];
      for (const m of moves) {
        if (existingSet.has(toContainerPath(m.targetRel))) {
          conflicts.push({ source: m.src, target: m.targetRel });
        }
      }
      const err = new Error("Move conflicts with existing paths") as Error & {
        statusCode?: number;
        conflicts?: MoveConflict[];
      };
      err.statusCode = 409;
      (err as any).conflicts = conflicts;
      throw err;
    }

    if (overwrite) {
      const existingSet = new Set(existing);
      for (const m of moves) {
        if (
          existingSet.has(toContainerPath(m.targetRel)) &&
          m.src.startsWith(`${m.targetRel}/`)
        ) {
          const err = new Error(
            "Cannot replace a destination that contains the move source",
          ) as Error & { statusCode?: number };
          err.statusCode = 409;
          throw err;
        }
      }
    }

    // Move each entry with exact-target semantics. --no-target-directory (-T)
    // treats the target as the exact destination (never "move into a same-named
    // dir"). --no-clobber (-n) for overwrite=false; --force (-f) for
    // overwrite=true. Then verify by post-move state because GNU `mv -n` can
    // exit 0 on a skip.
    let moved = 0;
    for (const m of moves) {
      const srcFull = toContainerPath(m.src);
      const targetFull = toContainerPath(m.targetRel);
      if (overwrite && existing.includes(targetFull)) {
        const removeTarget = await this.dockerService.execCapture(
          containerId,
          ["rm", "-rf", "--", targetFull],
          { user: "agent" },
        );
        if (removeTarget.exitCode !== 0) {
          const err = new Error(
            `move failed for '${m.src}': could not replace destination`,
          ) as Error & { statusCode?: number };
          err.statusCode = 409;
          throw err;
        }
      }
      const mvArgs = [
        "mv",
        "--no-target-directory",
        ...(overwrite ? ["--force"] : ["--no-clobber"]),
        srcFull,
        targetFull,
      ];
      const res = await this.dockerService.execCapture(containerId, mvArgs, {
        user: "agent",
      });
      // Verify the move actually happened (defeats the mv -n exit-0-on-skip race).
      const postSrc = await this.dockerService.execCapture(
        containerId,
        ["test", "-e", srcFull],
        { user: "agent" },
      );
      const postTarget = await this.dockerService.execCapture(
        containerId,
        ["test", "-e", targetFull],
        { user: "agent" },
      );
      if (postTarget.exitCode === 0 && postSrc.exitCode !== 0) {
        moved++;
        continue;
      }
      const msg = res.stderr.toString("utf8").trim();
      // Source vanished (race) and target absent — treat as skipped, not failed.
      if (postSrc.exitCode !== 0 && postTarget.exitCode !== 0) continue;
      const err = new Error(
        `move failed for '${m.src}': ${msg || "source was not moved"}`,
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    return { moved };
  }

  /** `DELETE /api/containers/:id/files` — delete every `rels` entry (files,
   *  directories, symlinks). The workspace root is never deletable. Missing
   *  paths are ignored (idempotent). Escaping symlinks/parents are rejected up
   *  front. Uses `rm -rf` on each entry as the `agent` user via positional
   *  argv. */
  async deleteFiles(id: string, rels: string[]): Promise<{ deleted: number }> {
    const containerId = this.dockerIdForFiles(id);
    const targets = normalizeClientPathList(rels, { allowRoot: false });

    // Probe existence (and containment) in one call so escaping symlinks are
    // rejected before any deletion, and missing paths are skipped idempotently.
    const { existing, escaping } = await runProbeCheckMany(
      this.dockerService,
      containerId,
      targets,
    );
    if (escaping.length > 0) {
      const err = new Error(
        "Refusing to delete through a symlink that escapes the workspace",
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    const existingSet = new Set(existing);

    let deleted = 0;
    for (const rel of targets) {
      if (!existingSet.has(toContainerPath(rel))) continue;
      const res = await this.dockerService.execCapture(
        containerId,
        ["rm", "-rf", "--", toContainerPath(rel)],
        { user: "agent" },
      );
      if (res.exitCode === 0) {
        deleted++;
      } else {
        const msg = res.stderr.toString("utf8").trim();
        if (/No such file or directory/.test(msg)) continue;
        const err = new Error(
          `delete failed for '${rel}': ${msg || "unknown error"}`,
        ) as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
    }
    return { deleted };
  }

  /**
   * `POST /api/containers/:id/files/download` — when `rels` is exactly one
   *  regular file, return `{ kind: 'file', stream, entry }` so the route can
   *  stream raw bytes with a safe Content-Disposition. Otherwise return
   *  `{ kind: 'zip', stream }` for a true ZIP archive (relative names
   *  preserved, hidden files included, symlinks stored without following
   *  external targets), streamed with backpressure. Escaping symlinks are
   *  rejected. The returned stream is a Node Readable; the route wires
   *  client-close cleanup.
   */
  async downloadFiles(
    id: string,
    rels: string[],
  ): Promise<
    | { kind: "file"; stream: Readable; entry: FileEntry }
    | { kind: "zip"; stream: Readable }
  > {
    const containerId = this.dockerIdForFiles(id);
    const targets = normalizeClientPathList(rels, { allowRoot: false });

    // Resolve every target's metadata (existence + containment). Escaping
    // symlinks are rejected outright (probeLstat enforces realpath containment
    // for all types, so a regular file reached through an escaping symlink is
    // rejected here too).
    const entries: FileEntry[] = [];
    for (const rel of targets) {
      const entry = await probeLstat(this.dockerService, containerId, rel);
      entries.push(entry);
    }

    // Single regular file -> raw byte stream via Docker getArchive, demuxed
    // from the tar envelope into a plain file stream.
    if (entries.length === 1 && entries[0]!.type === "file") {
      const entry = entries[0]!;
      const tarStream = await this.dockerService.getArchive(
        containerId,
        toContainerPath(entry.path),
      );
      const fileStream = demuxSingleFileFromTar(tarStream, entry.size);
      return { kind: "file", stream: fileStream, entry };
    }

    // Otherwise build a true ZIP from the Docker tar archives of each target.
    // buildWorkspaceZip returns its output stream immediately and runs the
    // sequential append/finalize detached so output backpressure cannot
    // deadlock; redundant descendant selections are filtered inside it.
    const zipStream = buildWorkspaceZip(
      this.dockerService,
      containerId,
      entries,
    );
    return { kind: "zip", stream: zipStream };
  }

  /**
   * `POST /api/containers/:id/clipboard` — set the worker's X11 CLIPBOARD
   *  selection from a raw `image/png` or UTF-8 `text/plain` payload. The route
   *  has already validated the MIME, size caps, PNG signature/IHDR/dimensions,
   *  and UTF-8 well-formedness; this method streams the (already-validated)
   *  bytes to the audited `/home/agent/clipboard/set.sh` helper inside the
   *  worker as the `agent` user via Docker exec (non-TTY, stdin wired through
   *  `execCapture`). The helper owns the X CLIPBOARD selection via xclip and
   *  returns only after the owner is serving, so no arbitrary delay is needed.
   *
   *  Helper failure is mapped precisely by exit code to an HTTP status — the
   *  helper's stderr is NEVER returned to the client (it is internal only and
   *  never contains clipboard contents), so a failure never echoes clipboard
   *  data. `mime` is passed as a positional argv element (never interpolated
   *  into a shell), and `bytes` flows over stdin (never argv), so the payload
   *  cannot inject commands.
   *
   *  Returns `{ ok: true }` on success. Throws an Error carrying `statusCode`
   *  on failure (400/409/422/500) so `rethrowAsHttpError` preserves it.
   */
  async setClipboard(
    id: string,
    mime: "image/png" | "text/plain",
    bytes: Buffer,
  ): Promise<{ ok: true }> {
    const containerId = this.dockerIdForFiles(id);
    const res = await this.dockerService.execCapture(
      containerId,
      [
        "sh",
        "-c",
        'head -c "$1" | /home/agent/clipboard/set.sh "$2"',
        "agentor-clipboard",
        String(bytes.length),
        mime,
      ],
      { stdin: bytes, user: "agent" },
    );
    if (res.exitCode === 0) return { ok: true };

    // Map the helper's documented exit codes to HTTP statuses. Messages are
    // fixed strings here (not the helper's stderr) so the response can never
    // leak clipboard data or internal diagnostics.
    const map: Record<number, { statusCode: number; statusMessage: string }> = {
      2: { statusCode: 415, statusMessage: "Unsupported clipboard type" },
      3: { statusCode: 400, statusMessage: "Empty clipboard payload" },
      4: {
        statusCode: 413,
        statusMessage: "Clipboard payload exceeds the size limit",
      },
      5: { statusCode: 415, statusMessage: "Invalid PNG payload" },
      6: { statusCode: 500, statusMessage: "Clipboard helper unavailable" },
      7: {
        statusCode: 422,
        statusMessage: "Failed to set clipboard selection",
      },
    };
    const mapped = map[res.exitCode] ?? {
      statusCode: 500,
      statusMessage: "Clipboard helper failed",
    };
    const err = new Error(mapped.statusMessage) as Error & {
      statusCode?: number;
    };
    err.statusCode = mapped.statusCode;
    throw err;
  }

  async stop(id: string): Promise<void> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    useLogCollector().detach(info.containerId);
    await this.dockerService.stopContainer(info.containerId);
    info.status = "stopped";
    info.updatedAt = new Date().toISOString();
    useLogger().info(`[container] stopped ${info.containerName}`);
  }

  async restart(id: string): Promise<void> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    useLogCollector().detach(info.containerId);
    await this.dockerService.restartContainer(info.containerId);
    await this.dockerService.materializeWorkerSecretFiles(
      info.containerId,
      await useWorkerConfigStore().resolveAppliedValues(info.userId, id),
    );
    info.status = "running";
    info.updatedAt = new Date().toISOString();
    useLogCollector()
      .attach(info.containerName, info.containerId, "worker", info.displayName)
      .catch(() => {});
    useLogger().info(`[container] restarted ${info.containerName}`);
  }

  private static normRepos(repos: RepoConfig[] | undefined): string {
    return JSON.stringify(
      (repos ?? []).map((r) => ({
        provider: r.provider,
        url: r.url,
        branch: r.branch || "",
      })),
    );
  }

  private static normMounts(mounts: MountConfig[] | undefined): string {
    return JSON.stringify(
      (mounts ?? []).map((m) => ({
        source: m.source,
        target: m.target,
        readOnly: !!m.readOnly,
      })),
    );
  }

  /** Update a worker's editable settings without forcing a recreation.
   *
   * The internal identity (`id`, `containerName`, volumes, routing) is always
   * immutable. Two tiers of settings exist:
   *
   * - **Applied immediately (no rebuild)** — `displayName`. Applied to the
   *   in-memory ContainerInfo and the WorkerStore immediately; the running
   *   worker keeps serving.
   * - **Rebuild-requiring** — `environmentId`, `initScript`, `repos`, `mounts`.
   *   These are baked into the container at create time (the `WORKER`/`ENVIRONMENT`
   *   env JSON and Docker `Binds`), so editing them only updates the stored
   *   desired config and flags the worker `pendingRebuild`. The next `rebuild()`
   *   re-resolves from this stored config and clears the flag.
   *
   * Only the keys present in `patch` are touched. Returns the updated
   * ContainerInfo. */
  async updateSettings(
    id: string,
    patch: UpdateContainerSettingsRequest,
  ): Promise<ContainerInfo> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);

    let liveChanged = false;
    let rebuildChanged = false;

    // Validate the new environment UP FRONT — `resolveEnvironmentConfig` is the
    // only operation that can throw (a since-deleted / non-existent environment),
    // and validating before mutating any field keeps `info` untouched on failure.
    // The worker only stores the `environmentId` FK; the config is resolved live
    // at build time, so nothing is snapshotted here. An absent `environmentId`
    // resolves to the built-in `default` environment, so treat `undefined` and the
    // default-env id as the same assignment — otherwise a pure display-name save
    // (which round-trips the form's default-env id) would spuriously flag a rebuild.
    const envChanged =
      patch.environmentId !== undefined &&
      patch.environmentId !== (info.environmentId || DEFAULT_ENVIRONMENT_ID);
    if (envChanged) this.resolveEnvironmentConfig(patch.environmentId!); // throws → 400 on a bad id
    const accountEnv = this.userEnvStore?.getOrDefault(info.userId) ?? zeroUserEnvVars(info.userId);
    const nextExcluded = patch.excludedGlobalEnvVarKeys === undefined
      ? info.excludedGlobalEnvVarKeys ?? []
      : normalizeExcludedGlobalEnvVarKeys(accountEnv, patch.excludedGlobalEnvVarKeys);
    const excludedChanged = JSON.stringify(nextExcluded) !== JSON.stringify(info.excludedGlobalEnvVarKeys ?? []);
    const nextGroupExcluded = patch.excludedGroupEnvVarKeys === undefined ? info.excludedGroupEnvVarKeys ?? [] : [...new Set(patch.excludedGroupEnvVarKeys)].sort();
    const groupExcludedChanged = JSON.stringify(nextGroupExcluded) !== JSON.stringify(info.excludedGroupEnvVarKeys ?? []);
    if (groupExcludedChanged) {
      const [{useWorkerGroupStore},{publicGroupEnvKeys}]=await Promise.all([import("./services"),import("./worker-group-env")]);
      const memberships=useWorkerGroupStore().listForUser(info.userId).filter(group=>group.workerIds.includes(info.id));
      if(memberships.length!==1&&nextGroupExcluded.length)throw Object.assign(new Error("Worker has no unambiguous worker group"),{statusCode:400});
      if(memberships[0]){const allowed=new Set((await publicGroupEnvKeys(info.userId,memberships[0].id)).effectiveKeys);if(nextGroupExcluded.some(key=>!allowed.has(key)))throw Object.assign(new Error("Unknown group environment variable key"),{statusCode:400});}
    }

    // Display name — applied immediately (no rebuild).
    if (patch.displayName !== undefined) {
      const next = patch.displayName.trim();
      if (next && next !== info.displayName) {
        info.displayName = next;
        liveChanged = true;
      }
    }

    // Environment assignment — rebuild. Only the FK is stored; the new env's
    // config is applied when the container is next (re)built.
    if (envChanged) {
      info.environmentId = patch.environmentId;
      rebuildChanged = true;
    }
    if (excludedChanged) {
      info.excludedGlobalEnvVarKeys = nextExcluded;
      rebuildChanged = true;
    }
    if (groupExcludedChanged) { info.excludedGroupEnvVarKeys=nextGroupExcluded;rebuildChanged=true; }

    // Init script — rebuild.
    if (patch.initScript !== undefined) {
      const next = patch.initScript.trim() || undefined;
      if (next !== info.initScript) {
        info.initScript = next;
        rebuildChanged = true;
      }
    }

    // Repositories — rebuild.
    if (patch.repos !== undefined) {
      const cleaned = patch.repos
        .filter((r) => r && r.url)
        .map((r) => ({
          provider: r.provider,
          url: r.url,
          ...(r.branch ? { branch: r.branch } : {}),
        }));
      const next = cleaned.length > 0 ? cleaned : undefined;
      if (
        ContainerManager.normRepos(next) !==
        ContainerManager.normRepos(info.repos)
      ) {
        info.repos = next;
        rebuildChanged = true;
      }
    }

    // Volume mounts — rebuild.
    if (patch.mounts !== undefined) {
      const cleaned = patch.mounts
        .filter((m) => m && m.source && m.target)
        .map((m) => ({
          source: m.source,
          target: m.target,
          ...(m.readOnly ? { readOnly: true } : {}),
        }));
      const next = cleaned.length > 0 ? cleaned : undefined;
      if (
        ContainerManager.normMounts(next) !==
        ContainerManager.normMounts(info.mounts)
      ) {
        info.mounts = next;
        rebuildChanged = true;
      }
    }

    if (rebuildChanged) info.pendingRebuild = true;

    if (liveChanged || rebuildChanged) {
      info.updatedAt = new Date().toISOString();
      if (this.workerStore) {
        await this.workerStore.upsert(this.containerInfoToWorkerRecord(info));
      }
      useLogger().info(
        `[container] updated settings for ${info.containerName}${rebuildChanged ? " (pending rebuild)" : ""}`,
      );
    }

    return info;
  }

  async remove(id: string): Promise<void> {
    const info = this.containers.get(id);
    if (info) this.assertOrdinaryMutation(info);
    if (info) useLogCollector().detach(info.containerId);
    try {
      await this.dockerService.removeContainer(info?.containerId ?? id);
      if (info) {
        // Each cleanup is best-effort: one failure (e.g. EACCES on a directory-mode
        // rm -rf, an in-use image) must not abort the rest or leave a half-removed
        // worker in memory. Log and continue.
        const warn = (what: string) => (err: unknown) =>
          useLogger().warn(
            `[container] remove ${info.containerName}: ${what} failed: ${err instanceof Error ? err.message : err}`,
          );
        await recordWorkspaceTombstone({
          workerId: info.id,
          userId: info.userId,
          displayName: info.displayName || info.id,
          backend: this.storageManager?.mode ?? "volume",
          createdAt: info.createdAt,
        }).catch(warn("workspace tombstone"));
        await cleanupWorkerMappings(info.containerName).catch(
          warn("mapping cleanup"),
        );
        if (this.storageManager) {
          await this.storageManager
            .removeWorkerDocker(info.containerName)
            .catch(warn("docker volume"));
          await this.storageManager
            .removeWorkerWorkspace(info.userId, info.id, info.containerName)
            .catch(warn("workspace"));
          await this.storageManager
            .removeWorkerAgents(info.userId, info.id, info.containerName)
            .catch(warn("agents"));
        }
        // Per-worker imported image (from restore) is owned by this worker — drop it.
        if (info.importedImage?.startsWith(IMPORT_IMAGE_PREFIX)) {
          await this.dockerService
            .removeImage(info.importedImage)
            .catch(warn("imported image"));
        }
        if (this.workerStore) {
          await this.workerStore
            .delete(info.userId, info.id)
            .catch(warn("worker record"));
        }
        await useWorkerConfigStore()
          .remove(info.userId, info.id)
          .catch(warn("worker-local configuration"));
        useLogger().info(`[container] removed ${info.containerName}`);
      }
    } finally {
      // Always drop the in-memory entry so the UI never shows a removed worker.
      this.containers.delete(id);
    }
  }

  async archive(id: string): Promise<void> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);

    useLogCollector().detach(info.containerId);

    if (info.status === "running") {
      await this.dockerService.stopContainer(info.containerId);
    }

    await this.dockerService.removeContainer(info.containerId);

    if (this.workerStore) {
      await this.workerStore.upsert(this.containerInfoToWorkerRecord(info));
      await this.workerStore.archive(info.userId, info.id);
    }

    useLogger().info(`[container] archived ${info.containerName}`);
    this.containers.delete(id);
  }

  async rebuild(id: string): Promise<ContainerInfo> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);

    useLogCollector().detach(info.containerId);

    // Stop and remove the old container — workspace, agents, and DinD volumes
    // are preserved (rebuild behaves identically to archive + unarchive).
    if (info.status === "running") {
      await this.dockerService.stopContainer(info.containerId);
    }
    await this.dockerService.removeContainer(info.containerId);

    this.containers.delete(id);

    // Re-resolve the environment config LIVE from the FK. If the referenced
    // environment was deleted, fall back to the built-in default (the worker no
    // longer carries a config snapshot to fall back to).
    let envConfig: ResolvedEnvConfig;
    try {
      envConfig = this.resolveEnvironmentConfig(info.environmentId);
    } catch {
      envConfig = this.resolveEnvironmentConfig(undefined); // deleted env → default
    }

    const { cpuLimit, memoryLimit, dockerEnabled } =
      this.deriveLimits(envConfig);

    const { gitName, gitEmail } = this.resolveGitIdentity(info.userId);

    const workerJson: WorkerJsonPayload = {
      id: info.id,
      displayName: info.displayName || "",
      repos: info.repos || [],
      initScript: info.initScript || "",
      gitName,
      gitEmail,
    };

    const { userEnv, credentialBinds, groupSecrets } = await this.resolveUserEnvAndBinds(
      info.userId,
      info.excludedGlobalEnvVarKeys ?? [],
      info.id,
      info.excludedGroupEnvVarKeys ?? [],
    );
    const workerConfig = await useWorkerConfigStore().resolveValues(
      info.userId,
      info.id,
    );

    // Imported workers reuse their per-worker image (captured rootfs) across
    // rebuilds; falls back to the standard image if that image is gone.
    const imageOpts = info.importedImage
      ? await this.resolveImageOpts(info.importedImage)
      : { image: info.imageRuntimeReference, imageConfig: undefined };

    const container = await this.dockerService.createWorkerContainer({
      userId: info.userId,
      id: info.id,
      containerName: info.containerName,
      cpuLimit,
      memoryLimit,
      mounts: info.mounts,
      dockerEnabled,
      credentialBinds,
      environmentJson: envConfig.environmentJson,
      capabilitiesJson: envConfig.capabilitiesJson,
      instructionsJson: envConfig.instructionsJson,
      workerJson,
      storageManager: this.storageManager,
      userEnv,
      workerConfig: [...groupSecrets, ...workerConfig],
      image: imageOpts.image,
      imageConfig: imageOpts.imageConfig,
    });

    const imageName =
      imageOpts.image ||
      this.config.workerImagePrefix + this.config.workerImage;
    const containerInfo: ContainerInfo = {
      id: info.id,
      userId: info.userId,
      createdAt: info.createdAt,
      updatedAt: new Date().toISOString(),
      containerId: container.id,
      containerName: info.containerName,
      displayName: info.displayName,
      imageName,
      imageId: info.imageDigest || "",
      status: "running",
      repos: info.repos,
      mounts: info.mounts,
      initScript: info.initScript,
      environmentId: info.environmentId,
      excludedGlobalEnvVarKeys: info.excludedGlobalEnvVarKeys ?? [],
      excludedGroupEnvVarKeys: info.excludedGroupEnvVarKeys ?? [],
      // Rebuild applies any pending settings edits, so the flag is cleared.
      pendingRebuild: false,
      // Keep the imported-image link only while that image still exists.
      importedImage: imageOpts.image ? info.importedImage : undefined,
      imageDefinitionId: info.imageDefinitionId,
      imageVersion: info.imageVersion,
      imageDigest: info.imageDigest,
      imageRuntimeReference: info.imageRuntimeReference,
    };

    this.containers.set(info.id, containerInfo);

    if (this.workerStore) {
      await this.workerStore.upsert(
        this.containerInfoToWorkerRecord(containerInfo),
      );
    }
    await useWorkerConfigStore().markApplied(info.userId, info.id);

    // Refresh Traefik config so the new container is picked up by DNS (no
    // restart needed — hot-reloaded via the file provider when mappings exist).
    // Best-effort: the rebuild already succeeded, so a transient Traefik error
    // must not turn it into a 500 (routing self-heals on the next reconcile).
    await reassignWorkerMappings(info.containerName).catch((err) => {
      useLogger().error(
        `[container] rebuild ${info.containerName}: traefik reconcile failed: ${err instanceof Error ? err.message : err}`,
      );
    });

    useLogCollector()
      .attach(info.containerName, container.id, "worker", info.displayName)
      .catch(() => {});

    useLogger().info(
      `[container] rebuilt ${info.containerName} (${container.id.slice(0, 12)})`,
    );
    await this.reconcileManagedNetworksForWorker(info.userId);

    return containerInfo;
  }

  async unarchive(userId: string, id: string): Promise<ContainerInfo> {
    if (!this.workerStore) throw new Error("WorkerStore not available");

    const worker = this.workerStore.get(userId, id);
    if (!worker || worker.status !== "archived") {
      throw new Error("Archived worker not found");
    }

    // containerName is derived from the stable UUID `id`, not stored on the record.
    const containerName = this.buildContainerName(worker.id);

    // Re-resolve the environment config LIVE from the FK. If the referenced
    // environment was deleted, fall back to the built-in default.
    let envConfig: ResolvedEnvConfig;
    try {
      envConfig = this.resolveEnvironmentConfig(worker.environmentId);
    } catch {
      envConfig = this.resolveEnvironmentConfig(undefined); // deleted env → default
    }

    const { cpuLimit, memoryLimit, dockerEnabled } =
      this.deriveLimits(envConfig);

    const { gitName, gitEmail } = this.resolveGitIdentity(worker.userId);

    const workerJson: WorkerJsonPayload = {
      id: worker.id,
      displayName: worker.displayName || "",
      repos: worker.repos || [],
      initScript: worker.initScript || "",
      gitName,
      gitEmail,
    };

    const { userEnv, credentialBinds, groupSecrets } = await this.resolveUserEnvAndBinds(
      worker.userId,
      worker.excludedGlobalEnvVarKeys ?? [],
      worker.id,
      worker.excludedGroupEnvVarKeys ?? [],
    );
    const workerConfig = await useWorkerConfigStore().resolveValues(
      worker.userId,
      worker.id,
    );

    const imageOpts = worker.importedImage
      ? await this.resolveImageOpts(worker.importedImage)
      : { image: worker.imageRuntimeReference, imageConfig: undefined };

    const container = await this.dockerService.createWorkerContainer({
      userId: worker.userId,
      id: worker.id,
      containerName,
      cpuLimit,
      memoryLimit,
      mounts: worker.mounts,
      dockerEnabled,
      credentialBinds,
      environmentJson: envConfig.environmentJson,
      capabilitiesJson: envConfig.capabilitiesJson,
      instructionsJson: envConfig.instructionsJson,
      workerJson,
      storageManager: this.storageManager,
      userEnv,
      workerConfig: [...groupSecrets, ...workerConfig],
      image: imageOpts.image,
      imageConfig: imageOpts.imageConfig,
    });

    await this.workerStore.unarchive(worker.userId, worker.id);
    await useWorkerConfigStore().markApplied(worker.userId, worker.id);

    const imageName =
      imageOpts.image ||
      this.config.workerImagePrefix + this.config.workerImage;
    const containerInfo: ContainerInfo = {
      id: worker.id,
      userId: worker.userId,
      createdAt: worker.createdAt,
      updatedAt: new Date().toISOString(),
      containerId: container.id,
      containerName,
      displayName: worker.displayName,
      imageName,
      imageId: worker.imageDigest || "",
      status: "running",
      repos: worker.repos,
      mounts: worker.mounts,
      initScript: worker.initScript,
      environmentId: worker.environmentId,
      excludedGlobalEnvVarKeys: worker.excludedGlobalEnvVarKeys ?? [],
      excludedGroupEnvVarKeys: worker.excludedGroupEnvVarKeys ?? [],
      // Unarchive recreates the container from the stored config, applying any
      // pending settings edits, so the flag is cleared.
      pendingRebuild: false,
      importedImage: imageOpts.image ? worker.importedImage : undefined,
      imageDefinitionId: worker.imageDefinitionId,
      imageVersion: worker.imageVersion,
      imageDigest: worker.imageDigest,
      imageRuntimeReference: worker.imageRuntimeReference,
    };

    this.containers.set(worker.id, containerInfo);

    // Best-effort Traefik refresh — unarchive already succeeded; a reconcile
    // blip must not fail it (routing self-heals on the next reconcile).
    await reassignWorkerMappings(containerName).catch((err) => {
      useLogger().error(
        `[container] unarchive ${containerName}: traefik reconcile failed: ${err instanceof Error ? err.message : err}`,
      );
    });

    useLogCollector()
      .attach(containerName, container.id, "worker", worker.displayName)
      .catch(() => {});

    useLogger().info(
      `[container] unarchived ${containerName} (${container.id.slice(0, 12)})`,
    );
    await this.reconcileManagedNetworksForWorker(worker.userId);

    return containerInfo;
  }

  async deleteArchived(userId: string, id: string): Promise<void> {
    if (!this.workerStore) throw new Error("WorkerStore not available");

    const worker = this.workerStore.get(userId, id);
    if (!worker || worker.status !== "archived") {
      throw new Error("Archived worker not found");
    }

    // containerName is derived from the stable UUID `id`, not stored on the record.
    const containerName = this.buildContainerName(worker.id);

    // Best-effort cleanups — one failure must not block the others or the final
    // store delete (which is the source of truth for "this worker is gone").
    const warn = (what: string) => (err: unknown) =>
      useLogger().warn(
        `[container] deleteArchived ${containerName}: ${what} failed: ${err instanceof Error ? err.message : err}`,
      );
    await recordWorkspaceTombstone({
      workerId: worker.id,
      userId: worker.userId,
      displayName: worker.displayName || worker.id,
      backend: this.storageManager?.mode ?? "volume",
      createdAt: worker.createdAt,
    }).catch(warn("workspace tombstone"));
    await cleanupWorkerMappings(containerName).catch(warn("mapping cleanup"));
    if (this.storageManager) {
      await this.storageManager
        .removeWorkerWorkspace(worker.userId, worker.id, containerName)
        .catch(warn("workspace"));
      await this.storageManager
        .removeWorkerDocker(containerName)
        .catch(warn("docker volume"));
      await this.storageManager
        .removeWorkerAgents(worker.userId, worker.id, containerName)
        .catch(warn("agents"));
    }
    if (worker.importedImage?.startsWith(IMPORT_IMAGE_PREFIX)) {
      await this.dockerService
        .removeImage(worker.importedImage)
        .catch(warn("imported image"));
    }
    await this.workerStore.delete(worker.userId, worker.id);
    await useWorkerConfigStore()
      .remove(worker.userId, worker.id)
      .catch(warn("worker-local configuration"));
  }

  // --- Worker export / import ---

  /** Resolve the image + replicated config a worker should run. For normal
   * workers (`importedImage` unset) returns `{}` so the standard image is used.
   * For imported workers, returns the per-worker image plus the standard image's
   * runtime config (entrypoint/env), falling back to the standard image if the
   * imported image no longer exists. */
  private async resolveImageOpts(
    importedImage?: string,
  ): Promise<{ image?: string; imageConfig?: ImageConfigOverride }> {
    if (!importedImage) return {};
    if (!(await this.dockerService.imageExists(importedImage))) {
      useLogger().warn(
        `[container] imported image ${importedImage} missing — using standard worker image`,
      );
      return {};
    }
    const standard = this.config.workerImagePrefix + this.config.workerImage;
    try {
      await this.dockerService.ensureImage(standard);
      const imageConfig = await this.dockerService.inspectImageConfig(standard);
      return { image: importedImage, imageConfig };
    } catch (err) {
      // A `docker import`ed image has no entrypoint/env of its own, so running
      // it without the replicated standard-image config produces an unbootable
      // worker. If we can't read that config, fall back to the standard image
      // (loses the captured rootfs but boots) — mirroring the import path.
      useLogger().warn(
        `[container] could not read standard image config for imported worker — using standard image: ${err instanceof Error ? err.message : err}`,
      );
      return {};
    }
  }

  /** Stream a complete worker export bundle (manifest + workspace + agents, and
   * optionally a `docker export` of the container filesystem). The worker must
   * have a container (running or stopped). Returns a tar stream + filename. */
  async exportWorker(
    id: string,
    opts: {
      includeRootfs: boolean;
      signal?: AbortSignal;
      onProgress?: (update: {
        phase: string;
        progress: number;
        bytesProcessed: number;
      }) => void | Promise<void>;
    },
  ): Promise<{ stream: Readable; filename: string }> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    if (info.status !== "running" && info.status !== "stopped") {
      // A worker that is creating/removing/error has no exportable container —
      // surface this as a client error (409), not a 500.
      const err = new Error(
        "Worker must be running or stopped to export",
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }

    const env =
      this.environmentStore?.getById(
        info.environmentId || DEFAULT_ENVIRONMENT_ID,
      ) || this.environmentStore?.getById(DEFAULT_ENVIRONMENT_ID);
    if (!env) throw new Error("Environment not found for export");

    const portMappings = usePortMappingStore()
      .list()
      .filter((m) => m.containerName === info.containerName)
      .map((m) => ({
        externalPort: m.externalPort,
        type: m.type,
        internalPort: m.internalPort,
        ...(m.appType ? { appType: m.appType } : {}),
        ...(m.instanceId ? { instanceId: m.instanceId } : {}),
      }));
    const domainMappings = useDomainMappingStore()
      .list()
      .filter((m) => m.containerName === info.containerName)
      .map((m) => ({
        subdomain: m.subdomain,
        baseDomain: m.baseDomain,
        path: m.path,
        protocol: m.protocol,
        wildcard: m.wildcard,
        internalPort: m.internalPort,
        ...(m.basicAuth ? { basicAuth: m.basicAuth } : {}),
      }));

    const tmpDir = join(this.config.dataDir, "tmp", `export-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });

    // Single-shot temp-dir cleanup — fires on stream end/close/error, and runs
    // immediately if materialising the bundle throws before streaming starts
    // (otherwise a multi-GB rootfs payload would leak in `<dataDir>/tmp`).
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      opts.signal?.throwIfAborted();
      let bytesProcessed = 0;
      const report = async (phase: string, progress: number) => {
        await opts.onProgress?.({ phase, progress, bytesProcessed });
      };
      const manifest: WorkerExportManifest = {
        version: WORKER_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        source: {
          id: info.id,
          displayName: info.displayName,
          containerName: info.containerName,
          imageName: info.imageName,
        },
        worker: {
          displayName: info.displayName,
          repos: info.repos ?? [],
          mounts: info.mounts ?? [],
          initScript: info.initScript ?? "",
        },
        // Environment values can contain API keys and other credentials. The
        // portable definition retains non-secret behavior but never exports
        // those values; the importer recreates the environment with an empty
        // value set and the owner must re-enter any required configuration.
        environment: { ...env, envVars: "" },
        portMappings,
        domainMappings,
        contents: { rootfs: opts.includeRootfs, workspace: true, agents: true },
        missingSecrets: (
          await useWorkerConfigStore().resolveValues(info.userId, info.id)
        )
          .filter((entry) => entry.kind !== "variable")
          .map((entry) => entry.key),
      };
      await writeManifest(manifest, join(tmpDir, BUNDLE_FILES.manifest));
      await report("manifest", 5);

      const files: { name: string; path: string }[] = [
        {
          name: BUNDLE_FILES.manifest,
          path: join(tmpDir, BUNDLE_FILES.manifest),
        },
      ];

      const wsSrc = await this.dockerService.getArchive(
        info.containerId,
        EXPORT_WORKSPACE_PATH,
      );
      bytesProcessed += await writeGzipFile(
        wsSrc,
        join(tmpDir, BUNDLE_FILES.workspace),
        opts.signal,
      );
      files.push({
        name: BUNDLE_FILES.workspace,
        path: join(tmpDir, BUNDLE_FILES.workspace),
      });
      await report("workspace", opts.includeRootfs ? 30 : 45);

      const agSrc = await this.dockerService.getArchive(
        info.containerId,
        EXPORT_AGENTS_PATH,
      );
      bytesProcessed += await writeFilteredAgentsGz(
        agSrc,
        join(tmpDir, BUNDLE_FILES.agents),
        CREDENTIAL_EXCLUDE_SUFFIXES,
        SHARED_DATA_EXCLUDE_PREFIXES,
        opts.signal,
      );
      files.push({
        name: BUNDLE_FILES.agents,
        path: join(tmpDir, BUNDLE_FILES.agents),
      });
      await report("agent-data", opts.includeRootfs ? 55 : 85);

      if (opts.includeRootfs) {
        opts.signal?.throwIfAborted();
        const rootfsSrc = await this.dockerService.exportContainer(
          info.containerId,
        );
        // Parallel level-1 gzip avoids the historical single-core compression
        // bottleneck while keeping artifacts and import staging bounded.
        bytesProcessed += await writeGzipFile(
          rootfsSrc,
          join(tmpDir, BUNDLE_FILES.rootfs),
          opts.signal,
        );
        files.push({
          name: BUNDLE_FILES.rootfs,
          path: join(tmpDir, BUNDLE_FILES.rootfs),
        });
        await report("root-filesystem", 85);
      }

      opts.signal?.throwIfAborted();
      const stream = packBundle(files);
      stream.on("end", cleanup);
      stream.on("close", cleanup);
      stream.on("error", cleanup);

      const safe = (info.displayName || info.id.slice(0, 12)).replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );
      useLogger().info(
        `[container] exporting worker ${info.containerName}${opts.includeRootfs ? " (with rootfs)" : ""}`,
      );
      return { stream, filename: `${safe}-worker-export.tar` };
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  /** Restore a worker from an export bundle as a brand-new worker (fresh UUID).
   * Recreates the environment, restores the workspace + agent-data volumes, and
   * recreates port/domain mappings. When the bundle carries a captured rootfs it
   * is imported into a per-worker image; on any failure there it falls back to
   * the standard worker image (config + volumes are still restored). */
  async importWorker(
    userId: string,
    bundlePath: string,
    opts: { displayName?: string },
  ): Promise<ContainerInfo & { missingSecrets?: string[] }> {
    if (!userId) throw new Error("import: userId is required");

    const workDir = join(this.config.dataDir, "tmp", `import-${randomUUID()}`);
    try {
      const {
        manifest,
        rootfsPath,
        rootfsCompressed,
        workspacePath,
        agentsPath,
      } = await extractBundle(bundlePath, workDir);
      if (!manifest || typeof manifest.version !== "number") {
        throw new Error("Invalid worker export bundle");
      }

      // Validate every compressed inner tar before any Docker image/container
      // mutation. This catches gzip bombs, unsafe paths, and excessive entry
      // counts while cleanup can still discard the entire import scratch dir.
      for (const payload of [workspacePath, agentsPath]) {
        if (payload) await validateGzipTarPayload(payload);
      }
      if (rootfsPath)
        await (rootfsCompressed
          ? validateGzipTarPayload(rootfsPath)
          : validateTarPayload(rootfsPath));

      const environmentId = await this.resolveImportEnvironment(
        userId,
        manifest.environment,
      );

      const id = randomUUID();
      const displayName = (
        opts.displayName?.trim() ||
        manifest.worker?.displayName ||
        "imported worker"
      ).slice(0, 100);
      const containerName = this.buildContainerName(id);
      const repos = (manifest.worker?.repos ?? []).filter((r) => r.url);
      const mounts = manifest.worker?.mounts ?? [];
      const initScript = manifest.worker?.initScript || "";

      const envConfig = this.resolveEnvironmentConfig(environmentId);
      const { cpuLimit, memoryLimit, dockerEnabled } =
        this.deriveLimits(envConfig);
      const { gitName, gitEmail } = this.resolveGitIdentity(userId);
      const workerJson: WorkerJsonPayload = {
        id,
        displayName,
        repos,
        initScript,
        gitName,
        gitEmail,
      };
      const { userEnv, credentialBinds } =
        await this.resolveUserEnvAndBinds(userId);
      const workerConfig = await useWorkerConfigStore().resolveValues(
        userId,
        id,
      );

      // Import the captured rootfs into a per-worker image (best-effort).
      let importedImage: string | undefined;
      let imageConfig: ImageConfigOverride | undefined;
      if (rootfsPath && manifest.contents?.rootfs) {
        try {
          const repo = `${IMPORT_IMAGE_PREFIX}${id}`;
          importedImage = await this.dockerService.importImage(
            createReadStream(rootfsPath),
            repo,
            "latest",
          );
          const standard =
            this.config.workerImagePrefix + this.config.workerImage;
          await this.dockerService.ensureImage(standard);
          imageConfig = await this.dockerService.inspectImageConfig(standard);
        } catch (err) {
          useLogger().warn(
            `[container] import: rootfs import failed, using standard image: ${err instanceof Error ? err.message : err}`,
          );
          importedImage = undefined;
          imageConfig = undefined;
        }
      }

      // Create the container stopped so volumes can be populated before the
      // entrypoint runs, then restore the volume tars, then start.
      const container = await this.dockerService.createWorkerContainer({
        userId,
        id,
        containerName,
        cpuLimit,
        memoryLimit,
        mounts,
        dockerEnabled,
        credentialBinds,
        environmentJson: envConfig.environmentJson,
        capabilitiesJson: envConfig.capabilitiesJson,
        instructionsJson: envConfig.instructionsJson,
        workerJson,
        storageManager: this.storageManager,
        userEnv,
        workerConfig,
        image: importedImage,
        imageConfig,
        start: false,
      });

      // Restore the volumes and start. If anything here fails, the container was
      // created but never registered — roll it back (and the per-worker image)
      // so a failed import doesn't leak an orphan container/image/volumes.
      try {
        if (workspacePath) {
          await this.dockerService.putArchive(
            container.id,
            createReadStream(workspacePath),
            RESTORE_WORKSPACE_PARENT,
          );
        }
        if (agentsPath) {
          await this.dockerService.putArchive(
            container.id,
            createReadStream(agentsPath),
            RESTORE_AGENTS_PARENT,
          );
        }
        await container.start();
        await this.dockerService.materializeWorkerSecretFiles(
          container.id,
          workerConfig,
        );
      } catch (err) {
        await this.dockerService.removeContainer(container.id).catch(() => {});
        if (this.storageManager) {
          await this.storageManager
            .removeWorkerWorkspace(userId, id, containerName)
            .catch(() => {});
          await this.storageManager
            .removeWorkerAgents(userId, id, containerName)
            .catch(() => {});
          if (dockerEnabled)
            await this.storageManager
              .removeWorkerDocker(containerName)
              .catch(() => {});
        }
        if (importedImage)
          await this.dockerService.removeImage(importedImage).catch(() => {});
        throw err;
      }

      const imageName =
        importedImage ||
        this.config.workerImagePrefix + this.config.workerImage;
      const now = new Date().toISOString();
      const containerInfo: ContainerInfo = {
        id,
        userId,
        createdAt: now,
        updatedAt: now,
        containerId: container.id,
        containerName,
        displayName,
        imageName,
        imageId: "",
        status: "running",
        repos: repos.length > 0 ? repos : undefined,
        mounts: mounts.length > 0 ? mounts : undefined,
        initScript: initScript || undefined,
        environmentId,
        pendingRebuild: false,
        ...(importedImage ? { importedImage } : {}),
      };
      this.containers.set(id, containerInfo);
      await useWorkerConfigStore().markApplied(userId, id);

      if (this.workerStore) {
        await this.workerStore.upsert(
          this.containerInfoToWorkerRecord(containerInfo),
        );
      }

      await this.recreateImportedMappings(userId, id, containerName, manifest);

      useLogCollector()
        .attach(containerName, container.id, "worker", displayName)
        .catch(() => {});
      useLogger().info(
        `[container] imported worker ${containerName} (${container.id.slice(0, 12)})${importedImage ? " with captured rootfs" : ""}`,
      );

      return {
        ...containerInfo,
        ...(manifest.missingSecrets?.length
          ? { missingSecrets: manifest.missingSecrets }
          : {}),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Resolve the environment to assign an imported worker. Built-in envs are
   * reused by id; a user's own env with a matching name is reused; otherwise the
   * embedded definition is recreated as a new custom env for the importer. */
  private async resolveImportEnvironment(
    userId: string,
    env: Environment | undefined,
  ): Promise<string> {
    if (!this.environmentStore || !env) return DEFAULT_ENVIRONMENT_ID;
    if (env.builtIn) {
      return this.environmentStore.getById(env.id)
        ? env.id
        : DEFAULT_ENVIRONMENT_ID;
    }
    const existing = this.environmentStore
      .list()
      .find((e) => e.userId === userId && e.name === env.name);
    if (existing) return existing.id;
    try {
      const created = await this.environmentStore.create({
        name: env.name,
        cpuLimit: env.cpuLimit,
        memoryLimit: env.memoryLimit,
        networkMode: env.networkMode,
        allowedDomains: env.allowedDomains,
        includePackageManagerDomains: env.includePackageManagerDomains,
        dockerEnabled: env.dockerEnabled,
        envVars: env.envVars,
        setupScript: env.setupScript,
        exposeApis: env.exposeApis,
        enabledCapabilityIds: env.enabledCapabilityIds,
        enabledInstructionIds: env.enabledInstructionIds,
        userId,
      });
      return created.id;
    } catch (err) {
      useLogger().warn(
        `[container] import: could not recreate environment '${env.name}', using default: ${err instanceof Error ? err.message : err}`,
      );
      return DEFAULT_ENVIRONMENT_ID;
    }
  }

  /** Recreate the bundle's port + domain mappings for the new worker, rewriting
   * identity (new owner, container name, worker id). Conflicting or
   * non-applicable mappings are skipped, not fatal. */
  private async recreateImportedMappings(
    userId: string,
    workerId: string,
    containerName: string,
    manifest: WorkerExportManifest,
  ): Promise<void> {
    let changed = false;
    for (const m of manifest.portMappings ?? []) {
      try {
        await usePortMappingStore().add({
          externalPort: m.externalPort,
          type: m.type,
          internalPort: m.internalPort,
          workerId,
          containerName,
          userId,
          ...(m.appType ? { appType: m.appType } : {}),
          ...(m.instanceId ? { instanceId: m.instanceId } : {}),
        });
        changed = true;
      } catch (err) {
        useLogger().warn(
          `[container] import: skipped port mapping :${m.externalPort} (${err instanceof Error ? err.message : err})`,
        );
      }
    }
    const baseDomains = new Set(this.config.baseDomains);
    for (const m of manifest.domainMappings ?? []) {
      if (!baseDomains.has(m.baseDomain)) {
        useLogger().warn(
          `[container] import: skipped domain mapping ${m.subdomain ? `${m.subdomain}.` : ""}${m.baseDomain} (base domain not configured here)`,
        );
        continue;
      }
      try {
        await useDomainMappingStore().add({
          subdomain: m.subdomain,
          baseDomain: m.baseDomain,
          path: m.path,
          protocol: m.protocol,
          wildcard: m.wildcard,
          internalPort: m.internalPort,
          workerId,
          containerName,
          userId,
        });
        changed = true;
      } catch (err) {
        useLogger().warn(
          `[container] import: skipped domain mapping ${m.baseDomain} (${err instanceof Error ? err.message : err})`,
        );
      }
    }
    if (changed) {
      try {
        await useTraefikManager().reconcile();
      } catch (err) {
        useLogger().error(
          `[container] import: traefik reconcile failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  listArchived(): WorkerRecord[] {
    return this.workerStore?.listArchived() ?? [];
  }

  async reconcileWorkers(): Promise<void> {
    if (!this.workerStore) return;

    const activeContainerNames = new Set<string>();
    for (const [, info] of this.containers) {
      activeContainerNames.add(info.containerName);
      const existing = this.workerStore.get(info.userId, info.id);
      if (!existing || existing.status === "active") {
        await this.workerStore.upsert(this.containerInfoToWorkerRecord(info));
      }
    }

    for (const worker of this.workerStore.listActive()) {
      if (!activeContainerNames.has(this.buildContainerName(worker.id))) {
        await this.workerStore.archive(worker.userId, worker.id);
      }
    }
  }

  /** Project the runtime ContainerInfo down to the minimal persisted record —
   * dropping everything Docker can re-discover (containerId, containerName,
   * imageName, imageId) and keeping only the worker's identity + config. */
  private containerInfoToWorkerRecord(info: ContainerInfo): WorkerRecord {
    return {
      id: info.id,
      userId: info.userId,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      displayName: info.displayName,
      status: "active",
      environmentId: info.environmentId,
      excludedGlobalEnvVarKeys: info.excludedGlobalEnvVarKeys ?? [],
      excludedGroupEnvVarKeys: info.excludedGroupEnvVarKeys ?? [],
      repos: info.repos,
      mounts: info.mounts,
      initScript: info.initScript,
      pendingRebuild: info.pendingRebuild,
      importedImage: info.importedImage,
      imageDefinitionId: info.imageDefinitionId,
      imageVersion: info.imageVersion,
      imageDigest: info.imageDigest,
      imageRuntimeReference: info.imageRuntimeReference,
    };
  }

  async logs(id: string, tail?: number): Promise<string> {
    return this.dockerService.getLogs(this.dockerIdFor(id), tail);
  }

  async listTmuxWindows(id: string): Promise<TmuxWindow[]> {
    return this.dockerService.execListTmuxWindows(this.dockerIdFor(id));
  }

  async createTmuxWindow(id: string, name?: string): Promise<TmuxWindow> {
    const containerId = this.dockerIdFor(id);
    const windowName = name || `shell-${nanoid(4)}`;
    await this.dockerService.execTmux(containerId, [
      "new-window",
      "-t",
      "main:",
      "-n",
      windowName,
    ]);
    const windows = await this.dockerService.execListTmuxWindows(containerId);
    const created = windows.findLast((w) => w.name === windowName);
    if (!created) {
      throw new Error("Failed to find newly created tmux window");
    }
    return created;
  }

  async renameTmuxWindow(
    id: string,
    windowIndex: number,
    newName: string,
  ): Promise<void> {
    await this.dockerService.execTmux(this.dockerIdFor(id), [
      "rename-window",
      "-t",
      `main:${windowIndex}`,
      newName,
    ]);
  }

  async killTmuxWindow(id: string, windowIndex: number): Promise<void> {
    if (windowIndex === 0) {
      throw new Error("Cannot kill the main tmux window");
    }
    await this.dockerService.execTmux(this.dockerIdFor(id), [
      "kill-window",
      "-t",
      `main:${windowIndex}`,
    ]);
  }

  getServiceStatus(id: string): ServiceStatus {
    const info = this.containers.get(id);
    return {
      running: info?.status === "running",
      containerId: info?.containerId,
    };
  }

  // --- Generic app instance methods ---

  async listAppInstances(
    id: string,
    appTypeId: string,
  ): Promise<AppInstanceInfo[]> {
    const info = this.containers.get(id);
    if (!info || info.status !== "running") return [];
    const instances = await this.dockerService.listAppInstances(
      info.containerId,
      appTypeId,
    );

    // Enrich instances with their externally mapped port (if any) so the UI
    // can render SSH connection strings etc. without a second round-trip.
    const appType = getAppType(appTypeId);
    if (appType?.autoPortMapping) {
      for (const inst of instances) {
        const mapping = usePortMappingStore().findByWorkerAndAppType(
          info.containerName,
          appTypeId,
          inst.id,
        );
        if (mapping) inst.externalPort = mapping.externalPort;
      }
    }
    return instances;
  }

  /** AppCreateResult — returned by createAppInstance. `externalPort` is set for
   * apps with `autoPortMapping` (e.g. ssh) so the UI can render the connect
   * string immediately. */
  async createAppInstance(
    id: string,
    appTypeId: string,
  ): Promise<{ id: string; port: number; externalPort?: number }> {
    const info = this.assertRunning(id);

    const appType = getAppType(appTypeId);
    if (!appType) {
      throw new Error(`Unknown app type: ${appTypeId}`);
    }

    const existing = await this.dockerService.listAppInstances(
      info.containerId,
      appTypeId,
    );

    if (appType.singleton) {
      const alreadyRunning = existing.find(
        (i) => i.status === "running" || i.status === "auth_required",
      );
      if (alreadyRunning) {
        const err = new Error(
          `${appType.displayName} is already running`,
        ) as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
    } else if (existing.length >= appType.maxInstances) {
      throw new Error(
        `Maximum ${appType.displayName} instances reached (${appType.maxInstances})`,
      );
    }

    // Allocate an internal port. Apps without a port range (`ports: []`) use
    // port 0 as a sentinel — this fits the VS Code tunnel app, which talks to
    // Microsoft's relay and does not expose a local listening port.
    let port: number;
    if (appType.fixedInternalPort !== undefined) {
      port = appType.fixedInternalPort;
    } else if (appType.ports.length === 0) {
      port = 0;
    } else {
      const portDef = appType.ports[0]!;
      const usedPorts = new Set(existing.map((i) => i.port));
      let found: number | null = null;
      for (
        let p = portDef.internalPortStart;
        p <= portDef.internalPortEnd;
        p++
      ) {
        if (!usedPorts.has(p)) {
          found = p;
          break;
        }
      }
      if (found === null)
        throw new Error(`No available ports for ${appType.displayName}`);
      port = found;
    }

    // Allocate an instance id. For singletons the id is fixed to the app type id
    // so restarts reuse the same identifier (and the same port mapping).
    const instanceId = appType.singleton
      ? appTypeId
      : `${appTypeId}-${Date.now().toString(36)}`;

    // Compose any app-type-specific extra args for `manage.sh start`.
    const extraArgs: string[] = [];
    if (appTypeId === "vscode") {
      extraArgs.push(this.buildTunnelName(info.userId, info.id));
    }

    // Auto port mapping — allocate or reuse BEFORE calling manage.sh, so the
    // user sees a consistent mapping even if manage.sh later fails (they can
    // remove it manually if needed).
    let externalPort: number | undefined;
    if (appType.autoPortMapping) {
      externalPort = await this.ensureAutoPortMapping(
        info,
        appType,
        instanceId,
        port,
      );
    }

    await this.dockerService.startAppInstance(
      info.containerId,
      appTypeId,
      instanceId,
      port,
      extraArgs,
    );

    return {
      id: instanceId,
      port,
      ...(externalPort !== undefined ? { externalPort } : {}),
    };
  }

  private async ensureAutoPortMapping(
    info: ContainerInfo,
    appType: NonNullable<ReturnType<typeof getAppType>>,
    instanceId: string,
    internalPort: number,
  ): Promise<number> {
    const cfg = appType.autoPortMapping!;
    const store = usePortMappingStore();
    const traefik = useTraefikManager();
    const existing = store.findByWorkerAndAppType(
      info.containerName,
      appType.id,
      instanceId,
    );
    if (existing) {
      return existing.externalPort;
    }

    // Allocate a port and apply it transactionally. If the chosen external port
    // turns out to be occupied on the host, the strict reconcile rolls Traefik
    // back and rejects; we drop that candidate and try the next free port rather
    // than leaving a mapping that Traefik can't bind. Bounded so a fully blocked
    // range fails fast instead of scanning thousands of ports.
    const tried = new Set<number>();
    const MAX_ATTEMPTS = 20;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const externalPort = store.findFreeExternalPort(
        cfg.externalPortStart,
        cfg.externalPortEnd,
        tried,
      );
      if (externalPort === null) {
        throw new Error(
          `No available external ports for ${appType.displayName} in ${cfg.externalPortStart}-${cfg.externalPortEnd}`,
        );
      }
      tried.add(externalPort);
      await store.add({
        externalPort,
        type: cfg.type,
        workerId: info.id,
        containerName: info.containerName,
        internalPort,
        appType: appType.id,
        instanceId,
        userId: info.userId,
      });
      try {
        await traefik.reconcileStrict();
        return externalPort;
      } catch (err) {
        await store.remove(externalPort).catch(() => {});
        useLogger().warn(
          `[container] auto port mapping :${externalPort} for ${appType.displayName} could not be bound (${err instanceof Error ? err.message : err}) — trying next port`,
        );
      }
    }
    throw new Error(
      `Could not allocate a bindable external port for ${appType.displayName} after ${MAX_ATTEMPTS} attempts`,
    );
  }

  async stopAppInstance(
    id: string,
    appTypeId: string,
    instanceId: string,
  ): Promise<void> {
    const info = this.assertRunning(id);
    await this.dockerService.stopAppInstance(
      info.containerId,
      appTypeId,
      instanceId,
    );
  }
}
