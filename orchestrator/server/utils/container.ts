import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from 'node:util';
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
import type { Readable, Duplex } from "node:stream";
import * as tar from "tar-stream";
import { DockerService } from "./docker";
import { IncusWorkerCommands } from "./incus-worker-commands";
import type { ManagedNetworkManager } from './managed-network-manager';
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
  PORTABLE_MANAGED_VOLUME_EXPORT_VERSION,
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
  extractBackupPathArchives,
  sanitizeBackupPathTarPayload,
  validateGzipTarPayload,
  validateTarPayload,
  readWorkerReconstruction,
  writeWorkerReconstruction,
} from "./worker-export";
import { resolveWorkerReconstruction, snapshotWorkerReconstruction, type ReconstructionResolution } from "./worker-reconstruction";
import { useImageCatalogManager } from "./image-catalog";
import { recordWorkspaceTombstone } from "./workspace-tombstones";
import type { WorkerExportManifest } from "./worker-export";
import type { PreparedPortableManagedVolumeImport } from "./portable-managed-volume-runtime";
import type { PortableManagedVolumeImportJournal } from "./portable-managed-volume-journal";
import type { PortableManagedVolumeEntry } from './portable-managed-volume-format';
import { pathsOverlap, type ManagedVolumeStore, type StoredManagedVolume } from './managed-volume-store';
import {
  readPortablePluginConfiguration,
  rollbackRestoredWorkerPlugins,
  restoreWorkerPlugins,
  snapshotWorkerPlugins,
  writePortablePluginConfiguration,
} from "./plugin-portability";
import type {
  AppInstanceInfo,
  TmuxWindow,
  FileEntry,
  FileListing,
  MoveConflict,
  WorkerRuntimeKind,
} from "../../shared/types";
import { normalizeWorkerRuntimeKind } from "../../shared/types";
import { IncusWorkerRuntime, incusWorkerStatus, type IncusWorkerOptions } from "./incus-worker-runtime";
import { prepareIncusCanonicalRestorePayload } from './incus-canonical-restore';
import { selectWorkerImportRuntime, type WorkerImportOrigin } from './worker-import-runtime-policy';
import { assertBackupRestoreRuntimePrincipal, validBackupRestoreRuntimePrincipal,
  type BackupRestoreRuntimePrincipal } from './backup-restore-runtime-authority';

export interface WorkerImportOptions {
  displayName?: string;
  imageResolution?:
    | { mode: 'replacement'; imageDefinitionId: string; imageVersion: string; imageDigest?: string; imageRuntimeReference?: string }
    | { mode: 'workspace-only' };
}

async function resolveImportedImage(
  userId: string,
  resolution: ReconstructionResolution,
  override?: { mode: "replacement"; imageDefinitionId: string; imageVersion: string; imageDigest?: string; imageRuntimeReference?: string } | { mode: "workspace-only" },
): Promise<{ imageDefinitionId?: string; imageVersion?: string; imageDigest?: string; imageRuntimeReference?: string }> {
  if (override?.mode === "workspace-only") return {};
  if (override?.mode === "replacement") {
    const catalog = useImageCatalogManager();
    await catalog.init();
    const selected = catalog.resolveSelection(
      userId,
      override.imageDefinitionId,
      override.imageVersion,
    );
    if (!selected || (override.imageDigest && selected.digest !== override.imageDigest))
      throw Object.assign(new Error("The selected replacement image is unavailable or does not match its requested digest."), {
        statusCode: 409,
        code: "IMAGE_REPLACEMENT_UNAVAILABLE",
      });
    return {
      imageDefinitionId: selected.definitionId,
      imageVersion: selected.version,
      imageDigest: selected.digest,
      ...(selected.runtimeImage
        ? { imageRuntimeReference: selected.runtimeImage }
        : {}),
    };
  }
  if (resolution.state === "resolved") return resolution.image ?? {};
  if (resolution.state === "unresolved") {
    const error = Object.assign(new Error("The backup requires a custom image that is unavailable. Recover the image definition, rebuild it, pull its immutable reference, select a replacement image, or restore workspace-only."), {
      statusCode: 409, code: resolution.code, reconstruction: resolution.required,
    });
    throw error;
  }
  return {};
}
import {
  isWorkerLifecycleMutationActive,
  isWorkerLifecycleMutationPending,
  withOwnerLifecycleMutation,
  withOwnerWorkerLifecycleMutation,
  withOwnerWorkerRuntimeSetup,
  withWorkerLifecycleMutation,
  workerLifecycleGeneration,
  workerLifecycleSequence,
} from "./worker-lifecycle-coordinator";
import { instanceSnapshotActive } from "./instance-snapshot-gate";
import {
  operationSettlement,
  type OperationFailureWithSettlement,
} from "./operation-deadline";
import { getAllGitCloneDomains } from "./git-providers";
import { getAllAgentApiDomains } from "./agent-config";
import {
  getPackageManagerDomains,
  DEFAULT_ENVIRONMENT_ID,
} from "./environments";
import type { EnvironmentStore, Environment } from "./environments";
import type { WorkerStore, WorkerRecord } from "./worker-store";
import { isWorkerSelfApiAccess } from "./worker-self-access";
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
  WorkerGroupLifecycleAction,
  WorkerGroupLifecycleResult,
  ResolvedHardwareDevice,
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
  type WorkerAppliedBootstrap,
  type WorkerConfigRevision,
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

export interface FailedImportRollbackActions {
  removeFromMemory: () => void;
  removeMappings: () => Promise<void>;
  removeWorkerRecord: () => Promise<void>;
  removeWorkerConfiguration: () => Promise<void>;
  removeContainer: () => Promise<void>;
  removeWorkspace: () => Promise<void>;
  removeAgents: () => Promise<void>;
  removeDocker?: () => Promise<void>;
  removeImportedImage?: () => Promise<void>;
}

/** Docker delete is idempotent at the control-plane boundary. A missing
 * container is already in the requested state, including after an ambiguous
 * network failure where Docker completed the first delete but its response was
 * lost. Other daemon failures remain retryable errors. */
export async function removeDockerContainerIdempotently(
  remove: () => Promise<void>,
): Promise<void> {
  try {
    await remove();
  } catch (error) {
    const status = (error as { statusCode?: number; status?: number })
      ?.statusCode ?? (error as { status?: number })?.status;
    if (status !== 404) throw error;
  }
}

/** Gracefully stop a running worker while making ambiguous retries safe.
 * Docker reports an already-stopped container as 304; some compatible daemons
 * expose only the equivalent message. Both mean the requested state has
 * already been reached. Update the in-memory state immediately after the stop
 * settles so a later remove/persistence failure cannot make the next lifecycle
 * retry stop the same container again. */
export async function stopWorkerContainerIdempotently(
  info: ContainerInfo,
  stop: () => Promise<void>,
  attemptUncertain = false,
  verifyStopped = false,
): Promise<void> {
  // Lifecycle retries may be in an error/removing/archive transition after a
  // successful stop. Archive/rebuild therefore stop only a known-running
  // container, while an explicit Stop request may make one bounded attempt
  // against an unknown/starting/recovering runtime.
  if (info.status !== "running" && !attemptUncertain) return;
  if (info.status === "stopped" && !verifyStopped) return;
  try {
    await stop();
  } catch (error) {
    const status = (error as { statusCode?: number; status?: number })
      ?.statusCode ?? (error as { status?: number })?.status;
    const message = error instanceof Error ? error.message : String(error);
    if (
      status !== 304 &&
      status !== 404 &&
      !/already (?:is )?stopped|container .* is not running/i.test(message)
    ) {
      throw error;
    }
  }
  info.status = "stopped";
  info.updatedAt = new Date().toISOString();
}

/** Remove a custom environment created exclusively for an import that failed.
 * Keep it while a failed Docker rollback leaves the provisional worker alive,
 * because that retryable worker still references the environment. */
export async function rollbackCreatedImportEnvironment(
  createdEnvironmentId: string | undefined,
  retainedContainer: boolean,
  removeEnvironment: (id: string) => Promise<void>,
): Promise<void> {
  if (!createdEnvironmentId || retainedContainer) return;
  await removeEnvironment(createdEnvironmentId);
}

export async function removeImportEnvironmentIdempotently(
  environmentId: string,
  exists: (id: string) => boolean,
  remove: (id: string) => Promise<void>,
): Promise<void> {
  if (exists(environmentId)) await remove(environmentId);
}

/** A failed rollback must retain the import-created environment while either
 * the container or its durable WorkerStore reference survives. */
export function importRollbackRetainsEnvironment(error: unknown): boolean {
  const rollback = error as { code?: string; failures?: unknown };
  return (
    rollback?.code === "IMPORT_ROLLBACK_CONTAINER_RETAINED" ||
    rollback?.code === "IMPORT_ROLLBACK_INCOMPLETE"
  );
}

export function importEnvironmentReferenced(
  userId: string,
  environmentId: string,
  liveWorkers: Iterable<Pick<ContainerInfo, "userId" | "environmentId">>,
  durableWorkers: Iterable<Pick<WorkerRecord, "userId" | "environmentId">>,
  exceptWorkerId?: string,
): boolean {
  for (const worker of liveWorkers)
    if (
      (exceptWorkerId === undefined ||
        (worker as { id?: string }).id !== exceptWorkerId) &&
      worker.userId === userId &&
      worker.environmentId === environmentId
    )
      return true;
  for (const worker of durableWorkers)
    if (
      (exceptWorkerId === undefined ||
        (worker as { id?: string }).id !== exceptWorkerId) &&
      worker.userId === userId &&
      worker.environmentId === environmentId
    )
      return true;
  return false;
}

/** Complete every compensating action after a post-create import failure.
 * Container removal is the first gate. After it succeeds, run every external
 * resource cleanup while retaining both in-memory and durable identities. Only
 * after those succeed may the durable record and then the in-memory handle be
 * dropped, so every partial failure remains retryable immediately and after an
 * orchestrator restart. */
export async function rollbackFailedWorkerImport(
  actions: FailedImportRollbackActions,
): Promise<void> {
  try {
    await actions.removeContainer();
  } catch (cause) {
    throw Object.assign(
      new Error("Worker import rollback could not remove the container"),
      { code: "IMPORT_ROLLBACK_CONTAINER_RETAINED", cause },
    );
  }
  const failures: string[] = [];
  const attempt = async (name: string, action?: () => Promise<void>) => {
    if (!action) return;
    try {
      await action();
    } catch {
      failures.push(name);
    }
  };
  await attempt("mappings", actions.removeMappings);
  await attempt("worker configuration", actions.removeWorkerConfiguration);
  await attempt("workspace", actions.removeWorkspace);
  await attempt("agent data", actions.removeAgents);
  await attempt("Docker data", actions.removeDocker);
  await attempt("imported image", actions.removeImportedImage);
  if (failures.length) {
    throw Object.assign(
      new Error(`Worker import rollback incomplete: ${failures.join(", ")}`),
      { code: "IMPORT_ROLLBACK_INCOMPLETE", failures: [...failures] },
    );
  }
  try {
    await actions.removeWorkerRecord();
  } catch {
    throw Object.assign(
      new Error("Worker import rollback incomplete: worker record"),
      {
        code: "IMPORT_ROLLBACK_INCOMPLETE",
        failures: ["worker record"],
      },
    );
  }
  actions.removeFromMemory();
}

/** Run every independent deletion action and return stable operator-facing
 * labels for the ones that failed. Callers retain the durable worker handle
 * until this returns an empty list, making partial cleanup retryable. */
export async function collectWorkerCleanupFailures(
  actions: Array<readonly [name: string, action: () => Promise<void>]>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const [name, action] of actions) {
    try {
      await action();
    } catch {
      failures.push(name);
    }
  }
  return failures;
}

/** A failed Docker import may still have installed its deterministic tag. Never
 * hide a daemon failure while removing it: the tag in this structured error is
 * the operator's recovery handle. */
export async function removeFailedImportedImage(
  candidateImage: string,
  remove: () => Promise<void>,
): Promise<void> {
  try {
    await remove();
  } catch (cause) {
    throw Object.assign(
      new Error(`Failed rootfs image cleanup: ${candidateImage}`),
      { code: "ROOTFS_IMPORT_CLEANUP_FAILED", candidateImage, cause },
    );
  }
}

export class ContainerManager {
  private managedNetworks?: ManagedNetworkManager;
  /** Restart-persistent ownership handles for custom environments created
   * implicitly by imports. */
  private importCreatedEnvironments = new Map<string, string>();
  /** A caller timeout must not allow a retry to enqueue the same destructive
   * owner-wide batch while the first operation is still running. */
  private activeWorkerGroupLifecycleOwners = new Set<string>();
  private syncPromise?: Promise<void>;
  private runtimeObservations = new Map<
    string,
    {
      at: number;
      status: ContainerStatus;
      diagnostic?: ContainerInfo["runtimeDiagnostic"];
      secretHandshakeRequired?: boolean;
      restartPolicy?: string;
    }
  >();
  /** Reattach a freshly created/rebuilt worker to owner-managed networks. Failure
   * is logged only: the worker lifecycle succeeded and the network remains
   * inspectable/reconcilable rather than leaving a half-created worker. */
  private async managedNetworkContext(info: ContainerInfo, includeEmpty = false) {
    if (!this.workerStore || info.administrativeKind) return;
    const { ManagedNetworkStore } = await import('./managed-network-store');
    const networks = new ManagedNetworkStore(this.config.dataDir); await networks.loadUser(info.userId);
    const records = networks.listForUser(info.userId);
    if (!records.length && !includeEmpty) return;
    const { ManagedNetworkManager } = await import('./managed-network-manager');
    const manager = this.managedNetworks ??= new ManagedNetworkManager({ manager: () => this,
      workers: () => this.workerStore!, config: () => this.config });
    return { manager, networks: records };
  }

  private async managedNetworksNeedReconciliation(info: ContainerInfo) {
    const context = await this.managedNetworkContext(info, true); if (!context) return false;
    const incarnation = this.capturedIncusIncarnation(info);
    for (const network of context.networks) {
      const expected = (await context.manager.members(network)).includes(info.id);
      const actual = await this.incusRuntime.inspectManagedNetwork(info, incarnation, network.id);
      if (actual.attached !== expected) return true;
    }
    return false;
  }

  private async reconcileManagedNetworksForWorker(info: ContainerInfo) {
    const context = await this.managedNetworkContext(info, true); if (!context) return;
    const containerId = info.containerId;
    for (const network of context.networks)
      await context.manager.reconcileWorker(network, info.id, containerId, {
        inspect: () => this.incusRuntime.inspectManagedNetwork(info, this.capturedIncusIncarnation(info), network.id),
        set: attach => this.setIncusManagedNetworkFenced(info.id, network.id, attach),
      }).catch((error) => {
        if (error?.[operationSettlement]) throw error;
          useLogger().warn(
            `[container] managed network reconcile failed: ${error instanceof Error ? error.message : error}`,
          );
      });
    await this.refreshManagedNetworkHostsFenced(info, true).catch(error => {
      // Topology/service lifecycle succeeded. Ordinary optional hint failures
      // must not turn that into a failed create/rebuild or unhealthy recipient.
      // Unsettled operations still propagate through lifecycle admission.
      if (error?.[operationSettlement]) throw error;
      useLogger().warn(`[container] managed hostname refresh deferred for ${info.id}: ${(error as { code?: string })?.code ?? 'peer configuration unavailable'}`);
    });
  }

  /** Control-plane-derived guest configuration only. The runtime setup queue
   * serializes this with stop/rebuild; it neither admits a new topology change
   * nor supplies protection-unlock authority for another worker. */
  async refreshManagedNetworkHosts(id: string, containerId: string): Promise<void> {
    const snapshot = this.get(id);
    if (!snapshot || snapshot.containerId !== containerId) throw new Error('Managed hostname recipient changed');
    return withOwnerWorkerRuntimeSetup(snapshot.userId, id, async () => {
      const current = this.get(id);
      if (!current || current.userId !== snapshot.userId || current.containerId !== containerId)
        throw new Error('Managed hostname recipient changed before admission');
      await this.refreshManagedNetworkHostsFenced(current, true);
    });
  }

  private async refreshManagedNetworkHostsFenced(info: ContainerInfo, includeEmpty = false): Promise<void> {
    if (!this.workerStore || info.administrativeKind) return;
    const check = () => {
      const current = this.get(info.id), record = this.workerStore!.get(info.userId, info.id);
      if (current?.containerId !== info.containerId || current.userId !== info.userId ||
          !record || record.status !== 'active' || record.deletionPending || record.incusRecreation ||
          normalizeWorkerRuntimeKind(record.runtimeKind) !== normalizeWorkerRuntimeKind(info.runtimeKind))
        throw new Error('Managed hostname runtime authority changed');
    };
    check();
    const { ManagedVolumeStore, assertIncusLiveResolved } = await import('./managed-volume-store');
    const volumes = new ManagedVolumeStore(this.config.dataDir); await volumes.loadUser(info.userId);
    for (const volume of volumes.forWorker(info.userId, info.id)) assertIncusLiveResolved(volume);
    const context = await this.managedNetworkContext(info, includeEmpty); if (!context) return;
    const entries = await context.manager.workerHostEntries(info.id, info.containerId,
      info.runtimeKind === 'incus-vm' ? { inspect: networkId => this.incusRuntime.inspectManagedNetwork(
        info, this.capturedIncusIncarnation(info), networkId) } : undefined);
    check();
    if (info.runtimeKind === 'incus-vm') {
      await this.incusRuntime.applyManagedHosts(info, this.capturedIncusIncarnation(info), entries);
    } else {
      await this.dockerService.applyManagedHosts(info.containerId, info.containerName, entries);
    }
    check();
  }
  private async reconcileWorkerPlugins(info: ContainerInfo) {
    if (info.status !== "running" || info.administrativeKind) return;
    const { usePluginRuntimeManager } = await import("./services");
    await usePluginRuntimeManager()
      .reconcileWorker(info.userId, info.id, info.containerId)
      .catch((error) =>
        useLogger().warn(
          `[container] plugin reconcile failed for ${info.id}: ${error instanceof Error ? error.message : error}`,
        ),
      );
  }
  private async persistDesiredRuntimeStatus(
    info: ContainerInfo,
    desired: "running" | "stopped",
  ): Promise<void> {
    info.desiredRuntimeStatus = desired;
    info.updatedAt = new Date().toISOString();
    const record = this.workerStore?.get(info.userId, info.id);
    if (record)
      await this.workerStore!.setDesiredRuntimeStatus(
        info.userId,
        info.id,
        desired,
      );
  }

  private markRuntimeUnknown(
    info: ContainerInfo,
    operation: string,
    error: unknown,
  ): void {
    info.status = "unknown";
    info.updatedAt = new Date().toISOString();
    info.runtimeDiagnostic = {
      code: (error as { code?: string })?.code || "WORKER_RUNTIME_UNRESPONSIVE",
      operation,
      message:
        "Agentor could not verify the worker runtime. Retry the operation or use managed recovery; persistent volumes were not changed.",
      retryable: true,
      observedAt: info.updatedAt,
    };
    this.runtimeObservations.delete(info.containerId);
  }

  /** Log/terminal paths use this to invalidate optimistic Docker list
   * state. The next inventory refresh performs an independent task probe. */
  reportRuntimeFailure(id: string, operation: string, error: unknown, observedContainerId?: string): void {
    const info = this.containers.get(id);
    if (isWorkerLifecycleMutationActive(id) || observedContainerId && info?.containerId !== observedContainerId) return;
    if (info) this.markRuntimeUnknown(info, operation, error);
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
  private incusRuntime: IncusWorkerRuntime;
  constructor(dockerService: DockerService, config: Config) {
    this.dockerService = dockerService;
    this.config = config;
    this.incusRuntime = new IncusWorkerRuntime(config);
  }

  setIncusRuntime(runtime: IncusWorkerRuntime): void {
    this.incusRuntime = runtime;
  }

  async refreshIncusSshKeys(userId: string): Promise<void> {
    if (!this.storageManager || !this.workerStore) return;
    const keys = await this.storageManager.readSshAuthorizedKeys(userId);
    for (const worker of this.workerStore.list().filter((record) =>
      record.userId === userId && record.runtimeKind === "incus-vm" && record.status !== "archived")) {
      try {
        await this.incusRuntime.refreshSshKeys({ id: worker.id, userId,
          containerName: this.buildContainerName(worker.id) }, keys);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        // No guest exists; its next create/start uses current canonical keys.
      }
    }
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
    appliedUserEnv?: UserEnvVars,
  ): Promise<{ userEnv: UserEnvVars; credentialBinds: string[]; groupSecrets: Array<{kind:"secret";key:string;value:string}> }> {
    const source =
      appliedUserEnv ?? this.userEnvStore?.getOrDefault(userId) ?? zeroUserEnvVars(userId);
    // Applied account values are already filtered. Removed account keys must
    // not invalidate an older, successfully applied exclusion selection.
    const excluded = new Set(appliedUserEnv ? [] : normalizeExcludedGlobalEnvVarKeys(source, excludedKeys));
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

  private async incusOptionsForWorker(info: ContainerInfo, applied: boolean, currentLayout?: string): Promise<IncusWorkerOptions> {
    const store = useWorkerConfigStore();
    const bootstrap = applied ? await store.resolveAppliedBootstrap(info.userId, info.id) : undefined;
    if (applied && !bootstrap)
      throw new Error('Applied Incus bootstrap is missing; explicit rebuild is required before restart');
    const environment = bootstrap ?? this.resolveEnvironmentConfig(info.environmentId);
    const { userEnv, credentialBinds, groupSecrets } = await this.resolveUserEnvAndBinds(
      info.userId, bootstrap?.excludedGlobalEnvVarKeys ?? info.excludedGlobalEnvVarKeys ?? [], info.id,
      bootstrap?.excludedGroupEnvVarKeys ?? info.excludedGroupEnvVarKeys ?? [],
      undefined, bootstrap?.userEnv,
    );
    const desired = applied ? undefined : await store.resolveDesiredRevision(info.userId, info.id);
    const workerConfig = applied ? await store.resolveAppliedValues(info.userId, info.id) : desired!.values;
    const { gitName, gitEmail } = bootstrap?.workerJson ?? await this.resolveGitIdentity(info.userId);
    const { useManagedVolumeManager } = await import('./managed-volume-manager');
    const volumes = useManagedVolumeManager();
    if (!currentLayout) await volumes.mounts(info.userId, info.id);
    const managedVolumes = currentLayout
      ? await volumes.currentIncusVolumes(info.userId, info.id, currentLayout)
      : volumes.store.forWorker(info.userId, info.id).filter(v => v.attached);
    return {
      userId: info.userId, id: info.id, containerName: info.containerName,
      ...(bootstrap ? { cpuLimit: bootstrap.cpuLimit, memoryLimit: bootstrap.memoryLimit, dockerEnabled: bootstrap.dockerEnabled }
        : this.deriveLimits(environment)),
      environmentJson: environment.environmentJson,
      capabilitiesJson: environment.capabilitiesJson, instructionsJson: environment.instructionsJson,
      workerJson: bootstrap?.workerJson ?? { id: info.id, displayName: info.displayName,
        repos: info.repos ?? [], initScript: info.initScript ?? "", gitName, gitEmail },
      userEnv: bootstrap?.userEnv ?? userEnv, credentialBinds, workerConfig: [...groupSecrets, ...workerConfig], mounts: info.mounts,
      storageManager: this.storageManager,
      image: info.imageRuntimeReference,
      configurationRevision: desired?.revision,
      sshAuthorizedKeys: await this.storageManager?.readSshAuthorizedKeys(info.userId),
      managedVolumes,
    };
  }

  private appliedIncusBootstrap(opts: IncusWorkerOptions, info: ContainerInfo): WorkerAppliedBootstrap {
    return { version: 1, cpuLimit: opts.cpuLimit, memoryLimit: opts.memoryLimit, dockerEnabled: opts.dockerEnabled,
      userEnv: opts.userEnv, environmentJson: opts.environmentJson, capabilitiesJson: opts.capabilitiesJson,
      instructionsJson: opts.instructionsJson, workerJson: opts.workerJson,
      excludedGlobalEnvVarKeys: info.excludedGlobalEnvVarKeys ?? [], excludedGroupEnvVarKeys: info.excludedGroupEnvVarKeys ?? [] };
  }

  private static readonly STATE_MAP: Record<string, ContainerStatus> = {
    running: "running",
    exited: "stopped",
    created: "creating",
    restarting: "starting",
    paused: "unknown",
    dead: "error",
    removing: "removing",
  };

  async sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    // Docker's list response is only a point-in-time observation. Capture the
    // lifecycle admission marker before starting it so a stop/archive/rebuild
    // which overlaps its task probes cannot publish that old response later.
    const lifecycleSequenceAtStart = workerLifecycleSequence();
    const busyAtStart = new Set([...this.containers.keys()].filter(isWorkerLifecycleMutationActive));
    this.syncPromise = this.syncUnlocked(lifecycleSequenceAtStart, busyAtStart).finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  private async observeRuntime(
    containerId: string,
    workerId?: string,
  ): Promise<{
    status: ContainerStatus;
    diagnostic?: ContainerInfo["runtimeDiagnostic"];
    secretHandshakeRequired?: boolean;
    restartPolicy?: string;
    lifecycleStale?: boolean;
  }> {
    const generation = workerId ? workerLifecycleGeneration(workerId) : 0;
    const startedDuringMutation = !!workerId && isWorkerLifecycleMutationActive(workerId);
    const cacheable = () => !workerId || (!startedDuringMutation &&
      !isWorkerLifecycleMutationActive(workerId) && workerLifecycleGeneration(workerId) === generation);
    const cached = this.runtimeObservations.get(containerId);
    if (cached && Date.now() - cached.at < 5_000) return { ...cached, lifecycleStale: !cacheable() };
    try {
      const runtime = await this.dockerService.inspectContainerRuntime(containerId);
      const status = ContainerManager.STATE_MAP[runtime.status] ?? "unknown";
      if (runtime.running)
        await this.dockerService.probeContainerTask(
          containerId,
          runtime.secretHandshakeRequired,
        );
      const observed = {
        at: Date.now(),
        status,
        secretHandshakeRequired: runtime.secretHandshakeRequired,
        restartPolicy: runtime.restartPolicy,
      };
      if (cacheable()) this.runtimeObservations.set(containerId, observed);
      return { ...observed, lifecycleStale: !cacheable() };
    } catch (error) {
      const data = (error as { data?: { operation?: string }; code?: string })?.data;
      const diagnostic = {
        code: (error as { code?: string })?.code || "WORKER_RUNTIME_UNRESPONSIVE",
        operation: data?.operation || "Docker worker task probe",
        message:
          "Agentor could not verify the Docker task. Lifecycle operations remain bounded; retry or use managed recovery.",
        retryable: true,
        observedAt: new Date().toISOString(),
      };
      const observed = { at: Date.now(), status: "unknown" as const, diagnostic };
      if (cacheable()) this.runtimeObservations.set(containerId, observed);
      return { ...observed, lifecycleStale: !cacheable() };
    }
  }

  private async syncUnlocked(lifecycleSequenceAtStart: number, busyAtStart = new Set<string>()): Promise<void> {
    const dockerContainers = await this.dockerService.listContainers();
    const incusInstances = this.config.incusEndpoint
      ? await this.incusRuntime.client.listInstances()
      : [];
    const observations = new Map(
      await Promise.all(
        dockerContainers.map(async (container) => [
          container.Id,
          await this.observeRuntime(container.Id, container.Labels?.[WORKER_ID_LABEL]),
        ] as const),
      ),
    );

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
    const concurrent = new Map(this.containers);
    const external = Array.from(concurrent.values()).filter(
      (info) => Boolean(info.administrativeKind),
    );

    const nextContainers = new Map<string, ContainerInfo>();
    const desiredMigrations: Array<{
      userId: string;
      workerId: string;
      desired: "running" | "stopped";
    }> = [];
    this.importCreatedEnvironments.clear();
    for (const worker of this.workerStore?.list() ?? []) {
      if (worker.importCreatedEnvironmentId) {
        this.importCreatedEnvironments.set(
          worker.id,
          worker.importCreatedEnvironmentId,
        );
      }
    }

    for (const dc of dockerContainers) {
      const containerName =
        dc.Names[0]?.replace(/^\//, "") || dc.Id.slice(0, 12);
      const labels = dc.Labels ?? {};
      // The worker UUID `id` is the only identifying label; resolve the
      // authoritative record (with userId + config) from the WorkerStore.
      const labelId = labels[WORKER_ID_LABEL] ?? "";
      // Retained storage-rollback containers are evidence for recovery, never
      // a second live identity. Their exact IDs are tracked by a durable journal.
      if (labelId && containerName.startsWith(`${this.buildContainerName(labelId)}-storage-rollback-`)) continue;
      // DockerService also discovers Agentor-owned auxiliary containers (for
      // example the persistent administrative workspace).  They deliberately
      // have no ordinary-worker identity and must never be projected into the
      // user-scoped WorkerStore.  Besides corrupting the inventory, doing so
      // supplies an empty owner id and can abort the services plugin during an
      // orchestrator restart before the administrative runtime is registered.
      if (!labelId) continue;
      const worker = labelId ? this.workerStore?.findById(labelId) : undefined;

      // The label is only an identifier; ownership and configuration must
      // come from the durable WorkerStore. If that owner partition is corrupt
      // or unavailable, never invent an empty owner and later persist it as a
      // new record. Leave the runtime untouched and inaccessible until its
      // authoritative metadata can be recovered.
      if (!worker) {
        useLogger().error(
          `[container] quarantined managed container ${containerName}: authoritative worker record ${labelId} is unavailable`,
        );
        continue;
      }
      if (normalizeWorkerRuntimeKind(worker.runtimeKind) !== "legacy-docker") {
        useLogger().error(`[container] quarantined Docker runtime with Incus worker identity ${labelId}`);
        continue;
      }

      // A Docker list/inspect result obtained before a lifecycle mutation is
      // not authoritative once that mutation has begun. Preserve the live
      // in-memory handle while it is still present (so a stop/restart can
      // publish its own accurate state), or omit it when the mutation removed
      // the handle. In particular, never revive an archived/deletion-pending
      // record from an old list response.
      const lifecycleChangedSinceSnapshot =
        workerLifecycleGeneration(worker.id) > lifecycleSequenceAtStart;
      if (
        worker.status !== "active" ||
        worker.deletionPending ||
        busyAtStart.has(worker.id) ||
        observations.get(dc.Id)?.lifecycleStale ||
        lifecycleChangedSinceSnapshot ||
        isWorkerLifecycleMutationActive(worker.id)
      ) {
        const current = concurrent.get(worker.id);
        if (
          current &&
          !current.administrativeKind &&
          current.userId === worker.userId &&
          worker.status === "active" &&
          !worker.deletionPending
        )
          nextContainers.set(worker.id, current);
        continue;
      }

      const id = worker.id;
      const now = new Date().toISOString();
      const observation = observations.get(dc.Id);
      const observedStatus =
        observation?.status ?? ContainerManager.STATE_MAP[dc.State] ?? "unknown";
      const inferredDesiredRuntimeStatus =
        // A legacy `unless-stopped` worker that is crash-looping is observed
        // as Docker's `restarting` state (projected to `starting`). Treat that
        // as durable running intent so startup reconciliation can disable the
        // daemon restart policy and retry secret bootstrap through Agentor.
        // A deliberately stopped legacy worker is `exited`/`stopped` and
        // remains stopped.
        observedStatus === "running" || observedStatus === "starting"
          ? "running"
          : observedStatus === "stopped"
            ? "stopped"
            : undefined;
      const desiredRuntimeStatus =
        worker.desiredRuntimeStatus ?? inferredDesiredRuntimeStatus;

      nextContainers.set(id, {
        id,
        runtimeKind: normalizeWorkerRuntimeKind(worker.runtimeKind),
        userId: worker.userId,
        createdAt: worker.createdAt ?? now,
        updatedAt: worker.updatedAt ?? now,
        containerId: dc.Id,
        containerName,
        displayName: worker.displayName ?? containerName,
        imageName: dc.Image,
        imageId: dc.ImageID,
        status: observedStatus,
        ...(desiredRuntimeStatus ? { desiredRuntimeStatus } : {}),
        ...(observation?.diagnostic
          ? { runtimeDiagnostic: observation.diagnostic }
          : {}),
        repos: worker.repos,
        mounts: worker.mounts,
        hardwareDeviceIds: worker.hardwareDeviceIds,
        initScript: worker.initScript,
        environmentId: worker.environmentId,
        excludedGlobalEnvVarKeys: worker.excludedGlobalEnvVarKeys ?? [],
        excludedGroupEnvVarKeys: worker.excludedGroupEnvVarKeys ?? [],
        workerSelfApiAccess: worker.workerSelfApiAccess,
        pendingRebuild: worker.pendingRebuild,
        hostMountsRevoked: worker.hostMountsRevoked,
        hardwareDevicesRevoked: worker.hardwareDevicesRevoked,
        importedImage: worker.importedImage,
        imageDefinitionId: worker.imageDefinitionId,
        imageVersion: worker.imageVersion,
        imageDigest: worker.imageDigest,
        imageRuntimeReference: worker.imageRuntimeReference,
      });
      if (!worker.desiredRuntimeStatus && desiredRuntimeStatus)
        desiredMigrations.push({
          userId: worker.userId,
          workerId: worker.id,
          desired: desiredRuntimeStatus,
        });
    }

    for (const instance of incusInstances) {
      const id = instance.config["user.agentor.id"];
      if (!id) continue;
      const worker = id ? this.workerStore?.findById(id) : undefined;
      if (!worker) {
        if (await this.incusRuntime.matchesWorkerIdentity(instance, id))
          useLogger().warn(`[container] quarantined Agentor-owned Incus orphan ${id}; no WorkerRecord authority`);
        continue;
      }
      if (!worker || worker.runtimeKind !== "incus-vm" ||
          !await this.incusRuntime.matchesWorkerIdentity(instance, worker.id, worker.userId)) continue;
      if (!instance.config['volatile.uuid']) continue;
      if (worker.status !== "active" || worker.deletionPending) {
        useLogger().warn(`[container] quarantined Incus compute for inactive worker ${worker.id}; persistence retained`);
        continue;
      }
      if (busyAtStart.has(id) || workerLifecycleGeneration(id) > lifecycleSequenceAtStart || isWorkerLifecycleMutationActive(id)) {
        const current = concurrent.get(id);
        if (current?.userId === worker.userId) nextContainers.set(id, current);
        continue;
      }
      nextContainers.set(id, {
        ...worker, runtimeKind: "incus-vm", containerId: `incus:${instance.config["volatile.uuid"]}`,
        containerName: instance.name, displayName: worker.displayName || instance.name,
        imageName: instance.config["image.source_image"] || this.config.incusWorkerImage,
        imageId: instance.config["volatile.base_image"] || "",
        status: worker.incusRecreation ? 'error' : incusWorkerStatus(instance),
        ...(worker.incusRecreation ? { runtimeDiagnostic: {
          code: 'INCUS_RECREATION_RECOVERY_REQUIRED', operation: 'Incus inventory',
          message: 'Interrupted VM recreation is quarantined until ownership-safe rollback succeeds.',
          retryable: true, observedAt: new Date().toISOString(),
        } } : {}),
      });
    }
    // Keep missing active records visible/recoverable, without inventing a
    // captured UUID or treating inventory absence as deletion authority. The
    // recovery pass separately confirms lookup404 and canonical storage.
    for (const worker of this.workerStore?.list() ?? []) {
      if (worker.status !== 'active' || worker.runtimeKind !== 'incus-vm' || worker.deletionPending || nextContainers.has(worker.id)) continue;
      if (busyAtStart.has(worker.id) || workerLifecycleGeneration(worker.id) > lifecycleSequenceAtStart ||
          isWorkerLifecycleMutationActive(worker.id)) continue;
      const name = this.buildContainerName(worker.id);
      nextContainers.set(worker.id, { ...worker, runtimeKind: 'incus-vm', containerName: name, containerId: name,
        imageName: this.config.incusWorkerImage, imageId: worker.imageDigest ?? '', status: 'unknown',
        runtimeDiagnostic: { code: worker.incusRecreation ? 'INCUS_RECREATION_RECOVERY_REQUIRED' : 'INCUS_COMPUTE_UNVERIFIED',
          operation: 'Incus inventory', message: 'VM identity is unavailable. Persistent data is retained; recovery requires authoritative runtime and storage checks.',
          retryable: true, observedAt: new Date().toISOString() } });
    }
    for (const info of external) nextContainers.set(info.id, info);
    // During the rename/create window Docker may list only the retained
    // rollback source (excluded above), or neither runtime. Preserve the
    // lifecycle's authoritative handle even without a corresponding list row.
    for (const [id, current] of concurrent) {
      if (current.administrativeKind || nextContainers.has(id)) continue;
      if (!busyAtStart.has(id) && workerLifecycleGeneration(id) <= lifecycleSequenceAtStart && !isWorkerLifecycleMutationActive(id)) continue;
      const record = this.workerStore?.findById(id);
      if (record?.status === "active" && !record.deletionPending && record.userId === current.userId)
        nextContainers.set(id, current);
    }
    // Commit synchronously: no lifecycle mutation can interleave between the
    // final generation check above and this map replacement.
    this.containers = nextContainers;

    // Legacy desired-state migration is deliberately best effort and happens
    // only for the just-published, still-stable observations. A concurrent
    // lifecycle mutation owns the durable desired state instead.
    for (const migration of desiredMigrations) {
      if (
        !isWorkerLifecycleMutationActive(migration.workerId) &&
        workerLifecycleGeneration(migration.workerId) <= lifecycleSequenceAtStart
      )
        await this.workerStore?.setDesiredRuntimeStatus(
          migration.userId,
          migration.workerId,
          migration.desired,
        );
    }

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
    if (info.runtimeKind === 'incus-vm' && this.workerStore?.get(info.userId, info.id)?.incusRecreation)
      throw new Error('Interrupted Incus recreation requires explicit recovery before lifecycle mutation');
    if (info.administrativeKind || info.userId === "__agentor_admin__") {
      const error = new Error(
        "Administrative workspace lifecycle requires the dedicated confirmed admin API",
      ) as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
  }

  private capturedIncusIncarnation(info: ContainerInfo): string {
    const uuid = info.containerId.startsWith('incus:') ? info.containerId.slice(6) : '';
    if (!uuid) throw new Error('Incus runtime incarnation is unavailable; use ownership-safe recovery before lifecycle mutation');
    return uuid;
  }

  private async assertOwnerExists(userId: string): Promise<void> {
    // Container lifecycle tests import this module directly with mocked
    // collaborators. Do not load the SQLite native addon unless an
    // owner-validated production path actually needs it.
    const { getUserById } = await import("./auth");
    if (!getUserById(userId)) {
      throw Object.assign(new Error("Worker owner not found"), {
        statusCode: 404,
      });
    }
  }

  /** Resolve the worker's git identity live from its owner without eagerly
   * loading the SQLite-backed auth module in Docker-only recovery paths. */
  private async resolveGitIdentity(userId: string): Promise<{
    gitName: string;
    gitEmail: string;
  }> {
    const { getUserById } = await import("./auth");
    const user = getUserById(userId);
    return { gitName: user?.name ?? "", gitEmail: user?.email ?? "" };
  }

  /** Serialize every ordinary lifecycle mutation owner-first, then worker.
   * Re-read both owner and worker after acquiring the fences so a request that
   * was authorized before account deletion cannot recreate removed state. */
  private withExistingWorkerLifecycleMutation<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const snapshot = this.containers.get(id);
    if (!snapshot) return Promise.reject(new Error("Container not found"));
    this.assertOrdinaryMutation(snapshot);
    return withOwnerWorkerLifecycleMutation(snapshot.userId, id, async () => {
      await this.assertOwnerExists(snapshot.userId);
      const current = this.containers.get(id);
      if (!current || current.userId !== snapshot.userId) {
        throw new Error("Container not found");
      }
      return operation();
    });
  }

  /** Look up a worker by its UUID `id`. */
  get(id: string): ContainerInfo | undefined {
    return this.containers.get(id);
  }

  /** Managed-network requests share the ordinary lifecycle fence. Startup
   * hooks already inside that fence call the runtime leaf directly instead. */
  async setIncusManagedNetwork(id: string, networkId: string, attach: boolean): Promise<void> {
    return this.withExistingWorkerLifecycleMutation(id, () => this.setIncusManagedNetworkFenced(id, networkId, attach));
  }

  private async setIncusManagedNetworkFenced(id: string, networkId: string, attach: boolean): Promise<void> {
      const info = this.get(id)!, record = this.workerStore?.get(info.userId, id);
      if (!record || record.status !== 'active' || record.runtimeKind !== 'incus-vm' || record.deletionPending ||
          record.incusRecreation || info.runtimeKind !== 'incus-vm')
        throw new Error('Incus worker is not authoritative for managed network mutation');
      // A network PUT includes the whole device map: do not touch it while
      // existing managed-storage authority is unsettled. Read/fence only; no
      // recovery, freezer or transaction machinery is reused here.
      const { ManagedVolumeStore, assertIncusLiveResolved } = await import('./managed-volume-store');
      const volumes = new ManagedVolumeStore(this.config.dataDir);
      await volumes.loadUser(info.userId);
      for (const volume of volumes.forWorker(info.userId, id)) assertIncusLiveResolved(volume);
      await this.incusRuntime.setManagedNetwork({ id, userId: info.userId, containerName: info.containerName },
        this.capturedIncusIncarnation(info), networkId, attach);
  }

  /** Read-only secondary topology; never supplies routing/worker identity. */
  async inspectIncusManagedNetwork(id: string, networkId: string) {
    const info = this.get(id), generation = workerLifecycleGeneration(id);
    const userId = info?.userId, containerId = info?.containerId;
    const check = () => {
      const current = this.get(id), record = userId && this.workerStore?.get(userId, id);
      if (!info || !current || current.userId !== userId || current.containerId !== containerId ||
          current.runtimeKind !== 'incus-vm' || !record || record.runtimeKind !== 'incus-vm' ||
          record.status !== 'active' || record.deletionPending || record.incusRecreation ||
          isWorkerLifecycleMutationPending(id) || workerLifecycleGeneration(id) !== generation)
        throw new Error('Incus worker changed or is unavailable during managed network observation');
    };
    check();
    const result = await this.incusRuntime.inspectManagedNetwork(info!, this.capturedIncusIncarnation(info!), networkId);
    check(); return result;
  }

  /** Dispatch only command/file operations. Captured record and UUID fence a
   * delayed exec or disconnect cleanup away from a replacement VM. */
  workerCommands(id: string): DockerService | IncusWorkerCommands {
    const info = this.assertRunning(id);
    if (info.runtimeKind !== 'incus-vm') return this.dockerService;
    const incarnation = info.containerId.slice('incus:'.length);
    const generation = workerLifecycleGeneration(id);
    return this.incusRuntime.commands({ id, userId: info.userId, containerName: info.containerName }, incarnation, async () => {
      // Validate inside command admission, including command objects captured
      // before the intent was persisted. The exempt guest agent must not spawn
      // new ordinary writers while a canonical mount has uncertain authority.
      const { useManagedVolumeManager } = await import('./managed-volume-manager');
      const volumes = useManagedVolumeManager(); await volumes.init();
      volumes.assertLiveRecoveryResolved(info.userId, id);
      const current = this.get(id), record = this.workerStore?.findById(id);
      if (!record || record.runtimeKind !== 'incus-vm' || record.status !== 'active' || record.deletionPending ||
          record.userId !== info.userId || current?.runtimeKind !== 'incus-vm' || current.userId !== info.userId ||
          current.containerId !== info.containerId || current.status !== 'running' ||
          workerLifecycleGeneration(id) !== generation)
        throw new Error('Incus worker command authority changed; retry');
    }, (operation) => withOwnerWorkerRuntimeSetup(info.userId, id, operation));
  }

  async attachTerminal(id: string, windowIndex: number): Promise<{ stream: Duplex; resize: (cols: number, rows: number) => void; close: () => void }> {
    const info = this.assertRunning(id);
    const commands = this.workerCommands(id);
    if (commands instanceof IncusWorkerCommands) return commands.attachTerminal(windowIndex);
    const session = await commands.execAttachTmuxWindow(info.containerId, windowIndex);
    let closed = false;
    return { stream: session.stream,
      resize: (cols, rows) => { void commands.resizeExec(session.exec.id, cols, rows).catch(() => {}); },
      close: () => {
        if (closed) return;
        closed = true;
        session.stream.end();
        void commands.killTmuxSession(info.containerId, session.tmuxSession).catch(() => {});
      },
    };
  }

  /** Preserve legacy Docker DNS; VM destinations come from filtered host
   * leases and the current daemon incarnation, never guest-reported IPs. */
  async resolveWorkerHost(id: string): Promise<string> {
    const info = this.get(id);
    if (!info || info.status !== "running") throw new Error("Worker backend is not running");
    if (info.runtimeKind !== "incus-vm") return info.containerName;
    const record = this.workerStore?.findById(id);
    if (!record || record.runtimeKind !== "incus-vm" || record.status !== "active" || record.deletionPending ||
        record.userId !== info.userId || isWorkerLifecycleMutationPending(id)) throw new Error("Incus worker is not authoritative");
    const generation = workerLifecycleGeneration(id);
    const primary = await this.incusRuntime.resolvePrimaryAddress({ id, userId: info.userId, containerName: info.containerName });
    const current = this.get(id), stored = this.workerStore?.findById(id);
    if (info.containerId !== `incus:${primary.incarnation}` || current?.containerId !== info.containerId ||
        current.status !== "running" || current.userId !== info.userId || stored?.runtimeKind !== "incus-vm" ||
        stored.status !== "active" || stored.deletionPending || stored.userId !== info.userId ||
        workerLifecycleGeneration(id) !== generation || isWorkerLifecycleMutationPending(id))
      throw new Error("Incus worker changed during backend resolution; retry");
    return primary.address;
  }

  /** IPv4 is the configured internal transport. Do not cache Incus caller
   * authority: address reassignment and recreation must take effect now. */
  async resolveIncusCaller(address: string): Promise<ContainerInfo | null> {
    if (isIP(address) !== 4) return null;
    const records = this.workerStore?.list().filter((record) => record.runtimeKind === "incus-vm" &&
      record.status === "active" && !record.deletionPending) ?? [];
    if (!records.length) return null;
    try {
      const [leases, instances] = await Promise.all([
        this.incusRuntime.client.getNetworkLeases(this.config.incusNetwork), this.incusRuntime.client.listInstances(),
      ]);
      const macs = new Set(leases.filter((lease) => lease.address === address).map((lease) => lease.hwaddr.toLowerCase()));
      if (macs.size !== 1) return null;
      const candidates = instances.filter((instance) => {
        const nic = (instance.expanded_devices ?? instance.devices).eth0;
        const config = instance.expanded_config ?? instance.config;
        return nic?.network === this.config.incusNetwork && macs.has((nic.hwaddr || config["volatile.eth0.hwaddr"] || "").toLowerCase());
      });
      if (candidates.length !== 1) return null;
      const instance = candidates[0]!;
      const record = records.find((worker) => worker.id === instance.config["user.agentor.id"]);
      if (!record || !await this.incusRuntime.matchesWorkerIdentity(instance, record.id, record.userId) ||
          instance.config["user.agentor.owner"] !== record.userId) return null;
      if (await this.resolveWorkerHost(record.id) !== address) return null;
      return this.get(record.id) ?? null;
    } catch { return null; /* Observation failure denies access, never restarts compute. */ }
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

  private async resolveAuthorizedHostMounts(
    userId: string,
    workerId: string,
    mounts: MountConfig[] | undefined,
    targetGroupId?: string,
  ): Promise<MountConfig[] | undefined> {
    const { useHostMountStore, useWorkerGroupStore } = await import("./services");
    let directGroupId = targetGroupId;
    if (directGroupId && !useWorkerGroupStore().get(userId, directGroupId))
      throw Object.assign(new Error("Worker group not found"), {
        statusCode: 404,
      });
    if (!directGroupId) {
      const memberships = useWorkerGroupStore()
        .listForUser(userId)
        .filter((group) => group.workerIds.includes(workerId));
      if (memberships.length > 1)
        throw Object.assign(
          new Error("Worker has conflicting direct group memberships; host mount authorization is ambiguous"),
          { statusCode: 409 },
        );
      directGroupId = memberships[0]?.id;
    }
    return useHostMountStore().resolveMounts(
      userId,
      workerId,
      mounts,
      directGroupId,
    );
  }

  private async resolveHardwareDeviceAccess(
    userId: string,
    workerId: string,
    deviceIds: string[] | undefined,
    targetGroupId: string | undefined,
    live: true,
  ): Promise<ResolvedHardwareDevice[] | undefined>;
  private async resolveHardwareDeviceAccess(
    userId: string,
    workerId: string,
    deviceIds: string[] | undefined,
    targetGroupId?: string,
    live?: false,
  ): Promise<string[] | undefined>;
  private async resolveHardwareDeviceAccess(
    userId: string,
    workerId: string,
    deviceIds: string[] | undefined,
    targetGroupId?: string,
    live = false,
  ): Promise<string[] | ResolvedHardwareDevice[] | undefined> {
    const { useHardwareDeviceStore, useWorkerGroupStore } = await import("./services");
    let directGroupId = targetGroupId;
    if (directGroupId && !useWorkerGroupStore().get(userId, directGroupId))
      throw Object.assign(new Error("Worker group not found"), { statusCode: 404 });
    if (!directGroupId) {
      const memberships = useWorkerGroupStore().listForUser(userId)
        .filter((group) => group.workerIds.includes(workerId));
      if (memberships.length > 1)
        throw Object.assign(new Error("Worker has conflicting direct group memberships; hardware authorization is ambiguous"), { statusCode: 409 });
      directGroupId = memberships[0]?.id;
    }
    const store = useHardwareDeviceStore();
    return live
      ? store.resolveAuthorizedDevices(userId, workerId, deviceIds, directGroupId)
      : store.authorizeDeviceIds(userId, workerId, deviceIds, directGroupId);
  }

  async create(request: CreateContainerRequest): Promise<ContainerInfo> {
    const userId = request.userId ?? "";
    if (!userId) throw new Error("create: userId is required");
    return withOwnerLifecycleMutation(userId, async () => {
      await this.assertOwnerExists(userId);
      return this.createForOwner(request);
    });
  }

  private async createForOwner(
    request: CreateContainerRequest,
  ): Promise<ContainerInfo> {
    const userId = request.userId ?? "";
    if (!userId) throw new Error("create: userId is required");
    const id = randomUUID();
    // The owner fence alone is invisible to inventory's per-worker generation
    // checks. Fence the new UUID before publishing provisional state so a slow
    // boot cannot leave a detached/stale map projection after creation returns.
    return withWorkerLifecycleMutation(id, () => this.createFenced(request, id));
  }

  private async createFenced(request: CreateContainerRequest, id: string): Promise<ContainerInfo> {
    const userId = request.userId!;

    const envConfig = this.resolveEnvironmentConfig(request.environmentId);

    // The worker's identity is an immutable UUID `id`. The user-facing label is
    // the free-form, editable `displayName` (defaulted to a friendly slug when
    // the user provides none). The Docker container is described by the separate
    // `containerId` (assigned by Docker) and `containerName` (`<prefix>-<id>`).
    const displayName =
      request.displayName?.trim() || this.suggestDisplayName(userId);
    const containerName = this.buildContainerName(id);
    const workerConfigStore = useWorkerConfigStore();

    const repos = request.repos?.filter((r) => r.url) || [];

    // Resource limits are an environment property (no per-worker override).
    const { cpuLimit, memoryLimit, dockerEnabled } =
      this.deriveLimits(envConfig);

    // Git identity resolved live from the owner — never stored on the worker.
    const { gitName, gitEmail } = await this.resolveGitIdentity(userId);

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
    if (
      request.workerSelfApiAccess !== undefined &&
      !isWorkerSelfApiAccess(request.workerSelfApiAccess)
    )
      throw Object.assign(new Error("Invalid workerSelfApiAccess"), {
        statusCode: 400,
      });
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
    // Validate request-controlled worker configuration before publishing any
    // identity, but persist it only after the provisional WorkerStore handle is
    // durable so a crypto/read/persistence failure has a restart-safe rollback
    // target.
    const requestedWorkerConfiguration = request.workerConfiguration
      ? normalizeWorkerConfiguration(request.workerConfiguration)
      : undefined;

    const imageName =
      request.imageRuntimeReference ||
      this.config.workerImagePrefix + this.config.workerImage;
    const now = new Date().toISOString();

    let mounts = await this.resolveAuthorizedHostMounts(
      userId,
      id,
      request.mounts,
      request.targetWorkerGroupId,
    );
    let hardwareDeviceIds = await this.resolveHardwareDeviceAccess(
      userId,
      id,
      request.hardwareDeviceIds,
      request.targetWorkerGroupId,
    );
    const initScript = request.initScript?.trim() || undefined;
    const runtimeKind: WorkerRuntimeKind = this.config.incusEnabled
      ? "incus-vm"
      : "legacy-docker";
    const incusCreation = runtimeKind === 'incus-vm'
      ? { attempted: false, nonce: undefined as string | undefined, incarnation: undefined as string | undefined }
      : undefined;

    const containerInfo: ContainerInfo = {
      id,
      runtimeKind,
      userId,
      createdAt: now,
      updatedAt: now,
      // The deterministic name is a valid Docker removal target if creation
      // fails after Docker accepted the request but before returning its id.
      containerId: containerName,
      containerName,
      displayName,
      imageName,
      imageId: request.imageDigest || "",
      status: "creating",
      desiredRuntimeStatus: "running",
      repos: repos.length > 0 ? repos : undefined,
      mounts,
      hardwareDeviceIds,
      initScript,
      environmentId: request.environmentId,
      excludedGlobalEnvVarKeys,
      excludedGroupEnvVarKeys,
      workerSelfApiAccess: request.workerSelfApiAccess,
      pendingRebuild: false,
      imageDefinitionId: request.imageDefinitionId,
      imageVersion: request.imageVersion,
      imageDigest: request.imageDigest,
      imageRuntimeReference: request.imageRuntimeReference,
    };

    // Publish and persist the provisional UUID before the first Docker
    // mutation. Any ambiguous create/rollback failure therefore remains
    // retryable by stable worker id, including after an orchestrator restart.
    this.containers.set(id, containerInfo);
    try {
      if (this.workerStore) {
        await this.workerStore.upsert(
          this.containerInfoToWorkerRecord(containerInfo),
        );
      }
    } catch (err) {
      // setItem is transactional: a rejected first upsert has restored the
      // previous WorkerStore state, and worker-local config has not been
      // persisted yet.
      this.containers.delete(id);
      throw err;
    }

    let configurationRevision: WorkerConfigRevision | undefined;
    const workerConfig = await (async () => {
      try {
        if (requestedWorkerConfiguration) {
          await workerConfigStore.replace(
            userId,
            id,
            requestedWorkerConfiguration,
          );
        }
        if (runtimeKind === 'incus-vm') {
          const desired = await workerConfigStore.resolveDesiredRevision(userId, id);
          configurationRevision = desired.revision;
          return desired.values;
        }
        return await workerConfigStore.resolveValues(userId, id);
      } catch (err) {
        await this.rollbackFailedProvisionedWorker({
          id,
          userId,
          containerId: containerName,
          containerName,
          dockerEnabled,
          incusCreation,
        });
        throw err;
      }
    })();

    let appliedBootstrap: WorkerAppliedBootstrap | undefined;
    try {
      // The first check rejects invalid input before publishing a worker. Check
      // again after the provisional record is durable and immediately before
      // Docker: if a grant is revoked between these checks, either this call
      // fails before Docker or revocation reconciliation is guaranteed to see
      // the persisted worker and stop it after this owner mutation settles.
      mounts = await this.resolveAuthorizedHostMounts(
        userId,
        id,
        mounts,
        request.targetWorkerGroupId,
      );
      containerInfo.mounts = mounts;
      hardwareDeviceIds = await this.resolveHardwareDeviceAccess(
        userId, id, hardwareDeviceIds, request.targetWorkerGroupId,
      );
      containerInfo.hardwareDeviceIds = hardwareDeviceIds;
      const hardwareDevices = await this.resolveHardwareDeviceAccess(
        userId, id, hardwareDeviceIds, request.targetWorkerGroupId, true,
      );
      const options: IncusWorkerOptions = {
        userId,
        id,
        containerName,
        cpuLimit,
        memoryLimit,
        mounts,
        hardwareDevices,
        dockerEnabled,
        credentialBinds,
        hostMountGroupId: request.targetWorkerGroupId,
        environmentJson: envConfig.environmentJson,
        capabilitiesJson: envConfig.capabilitiesJson,
        instructionsJson: envConfig.instructionsJson,
        workerJson,
        storageManager: this.storageManager,
        userEnv,
        workerConfig: [...groupSecrets, ...workerConfig],
        image: request.imageRuntimeReference,
        sshAuthorizedKeys: runtimeKind === "incus-vm" ? await this.storageManager?.readSshAuthorizedKeys(userId) : undefined,
      };
      if (runtimeKind === "incus-vm") {
        if (!this.workerStore) throw new Error('WorkerStore is required for Incus creation');
        const marker = { nonce: randomUUID(), replacementIncarnation: undefined as string | undefined, initialCreate: true as const };
        await this.workerStore.transitionIncusRecreation(userId, id,
          { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker });
        incusCreation!.nonce = marker.nonce; incusCreation!.attempted = true;
        const instance = await this.incusRuntime.create({ ...options, start: false, recreationNonce: marker.nonce });
        const incarnation = instance.config['volatile.uuid'];
        if (!incarnation || instance.config['user.agentor.recreation'] !== marker.nonce ||
            !await this.incusRuntime.matchesWorkerIdentity(instance, id, userId))
          throw new Error('Incus initial creation incarnation or operation identity is unavailable');
        incusCreation!.incarnation = incarnation;
        containerInfo.containerId = `incus:${incarnation}`;
        marker.replacementIncarnation = incarnation;
        await this.workerStore.transitionIncusRecreation(userId, id,
          { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker });
        await this.incusRuntime.start(options, incarnation);
        appliedBootstrap = this.appliedIncusBootstrap(options, containerInfo);
      } else {
        const container = await this.dockerService.createWorkerContainer(options);
        containerInfo.containerId = container.id;
      }
      containerInfo.status = "running";
      containerInfo.updatedAt = new Date().toISOString();
    } catch (err) {
      await this.rollbackFailedProvisionedWorker({
        id,
        userId,
        containerId: containerName,
        containerName,
        dockerEnabled,
        incusCreation,
      });
      throw err;
    }

    // Final persistence/secret-state failure after Docker started uses the same
    // gated rollback. The provisional identity is retained if Docker removal
    // fails, rather than converting a live worker into an untracked orphan.
    try {
      await workerConfigStore.markApplied(userId, id, appliedBootstrap, configurationRevision);
      if (runtimeKind === 'incus-vm') {
        const resolved = await this.workerStore!.transitionIncusRecreation(userId, id,
          { status: 'active', desiredRuntimeStatus: 'running', incusRecreation: undefined }, undefined,
          { nonce: incusCreation!.nonce!, replacementIncarnation: incusCreation!.incarnation, initialCreate: true });
        Object.assign(containerInfo, resolved, { status: 'running' });
      } else if (this.workerStore) {
        await this.workerStore.upsert(
          this.containerInfoToWorkerRecord(containerInfo),
        );
      }
    } catch (err) {
      await this.rollbackFailedProvisionedWorker({
        id,
        userId,
        containerId: containerInfo.containerId,
        containerName,
        dockerEnabled,
        incusCreation,
      });
      throw err;
    }

    // Attach log collector to the new container
    useLogCollector()
      .attach(containerName, containerInfo.containerId, "worker", displayName)
      .catch(() => {});

    useLogger().info(
      `[container] created worker ${containerName} (${containerInfo.containerId.slice(0, 12)})`,
    );
    await this.reconcileManagedNetworksForWorker(containerInfo);
    if (runtimeKind === "legacy-docker") {
      await this.reconcileWorkerPlugins(containerInfo);
    }

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
    await this.workerCommands(id).putWorkspaceArchive(info.containerId, tarBuffer);
  }

  async downloadWorkspace(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeJS.ReadableStream> {
    const info = this.assertRunning(id);
    return this.workerCommands(id).getWorkspaceArchive(info.containerId, signal);
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
    return probeList(this.workerCommands(id), containerId, rel);
  }

  /** A read-only absolute-path listing used solely by the backup selector.
   * Unlike listFiles this is intentionally not rooted at /workspace: choosing
   * a sensitive/authentication path is an explicit operator backup choice.
   * It runs as the worker user and returns metadata only, never content. */
  async listBackupPaths(id: string, absolutePath: string): Promise<{
    path: string; entries: Array<{ name: string; path: string; type: "file" | "directory" | "symlink"; size: number; mtime: string; readable: boolean; linkTarget?: string }>;
  }> {
    const containerId = this.dockerIdForFiles(id);
    const { normalizeBackupPath } = await import("./backup-paths");
    const selected = normalizeBackupPath(absolutePath);
    const script = String.raw`import os,sys,json,datetime
p=sys.argv[1]
try:
 st=os.lstat(p)
 if not os.path.isdir(p) or os.path.islink(p):
  print(json.dumps({'error':'not_directory'}));sys.exit(0)
 out=[]
 for e in os.scandir(p):
  try:
   s=e.stat(follow_symlinks=False); typ='symlink' if e.is_symlink() else ('directory' if e.is_dir(follow_symlinks=False) else 'file')
   item={'name':e.name,'path':os.path.join(p,e.name),'type':typ,'size':s.st_size if typ=='file' else 0,'mtime':datetime.datetime.utcfromtimestamp(s.st_mtime).strftime('%Y-%m-%dT%H:%M:%SZ'),'readable':os.access(e.path,os.R_OK)}
   if typ=='symlink': item['linkTarget']=os.readlink(e.path)
   out.append(item)
  except OSError: pass
 out.sort(key=lambda x:(x['type']!='directory',x['name'].casefold()))
 print(json.dumps({'path':p,'entries':out[:1000]}))
except FileNotFoundError: print(json.dumps({'error':'not_found'}))
except PermissionError: print(json.dumps({'error':'forbidden'}))`;
    const result = await this.workerCommands(id).execCapture(containerId, ["python3", "-c", script, selected], { user: "agent" });
    if (result.exitCode !== 0) throw Object.assign(new Error("Backup path listing failed"), { statusCode: 502 });
    let value: any;
    try { value = JSON.parse(result.stdout.toString("utf8")); } catch { throw Object.assign(new Error("Backup path listing failed"), { statusCode: 502 }); }
    if (value?.error === "not_found") throw Object.assign(new Error("Backup path not found"), { statusCode: 404 });
    if (value?.error === "forbidden") throw Object.assign(new Error("Backup path is not readable"), { statusCode: 403 });
    if (value?.error === "not_directory" || !Array.isArray(value?.entries)) throw Object.assign(new Error("Backup path is not a directory"), { statusCode: 409 });
    return value;
  }

  async assertBackupPathsReadable(id: string, paths: string[]): Promise<void> {
    const containerId = this.dockerIdForFiles(id);
    const { normalizeBackupPaths } = await import("./backup-paths");
    const selected = normalizeBackupPaths(paths);
    const script = String.raw`import os,sys
for p in sys.argv[1:]:
 try:
  os.lstat(p)
  if not os.access(p,os.R_OK): raise PermissionError(p)
 except FileNotFoundError: print('missing',file=sys.stderr);sys.exit(2)
 except PermissionError: print('unreadable',file=sys.stderr);sys.exit(3)`;
    const result = await this.workerCommands(id).execCapture(containerId, ["python3", "-c", script, ...selected], { user: "agent" });
    if (result.exitCode === 2) throw Object.assign(new Error("Selected backup path was not found"), { statusCode: 404 });
    if (result.exitCode === 3) throw Object.assign(new Error("Selected backup path is not readable"), { statusCode: 403 });
    if (result.exitCode !== 0) throw Object.assign(new Error("Selected backup path could not be validated"), { statusCode: 409 });
  }

  /** Internal selected backup seam: the BackupManager retains the owner and
   * worker lifecycle fence across the base bundle and all explicit streams.
   * Never resolve runtime environment or ensure/repair storage during capture. */
  async getSelectedBackupArchiveWithLifecycleFenceHeld(id: string, path: string, signal?: AbortSignal): Promise<Readable> {
    const { nativeExplicitBackupPath } = await import('./incus-selected-archive');
    path = nativeExplicitBackupPath(path);
    const info = this.get(id), record = this.workerStore?.findById(id);
    if (!info || info.runtimeKind !== 'incus-vm' || info.status !== 'running' ||
        !record || record.userId !== info.userId || record.runtimeKind !== 'incus-vm' || record.status !== 'active' ||
        record.deletionPending || record.incusRecreation || record.hostMountsRevoked || !isWorkerLifecycleMutationPending(id))
      throw Object.assign(new Error('Explicit native backup requires settled running worker authority and lifecycle admission'), { statusCode: 409 });
    const incarnation = this.capturedIncusIncarnation(info), generation = workerLifecycleGeneration(id);
    const capturedRecord = structuredClone(record), capturedMounts = structuredClone(info.mounts ?? []), handle = info.containerId;
    const { useManagedVolumeManager } = await import('./managed-volume-manager');
    const volumes = useManagedVolumeManager(); await volumes.init(); volumes.assertLiveRecoveryResolved(info.userId, id);
    const capturedVolumes = structuredClone(volumes.store.forWorker(info.userId, id));
    const validate = () => {
      const current = this.get(id), durable = this.workerStore?.findById(id);
      if (!current || current.userId !== info.userId || current.containerId !== handle || current.runtimeKind !== 'incus-vm' ||
          current.status !== 'running' || !isDeepStrictEqual(durable, capturedRecord) ||
          !isDeepStrictEqual(volumes.store.forWorker(info.userId, id), capturedVolumes) ||
          !isDeepStrictEqual(current.mounts ?? [], capturedMounts) || workerLifecycleGeneration(id) !== generation ||
          !isWorkerLifecycleMutationPending(id)) throw new Error('Selected native backup runtime or storage authority changed');
      volumes.assertLiveRecoveryResolved(info.userId, id);
    };
    validate();
    const owner = { id, userId: info.userId, containerName: info.containerName,
      storageManager: this.storageManager, mounts: capturedMounts,
      managedVolumes: capturedVolumes.filter(volume => volume.attached && volume.seeded) };
    return path === '/var/lib/docker' ? this.incusRuntime.openDockerArchive(owner, incarnation, validate, signal)
      : this.incusRuntime.openSelectedArchive(owner, incarnation, path, validate, signal);
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
    const destEntry = await probeLstat(this.workerCommands(id), containerId, dest);
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
      this.workerCommands(id),
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

    await this.workerCommands(id).putArchive(containerId, tarBuffer, "/workspace");
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
      const entry = await probeLstat(this.workerCommands(id), containerId, target);
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
      this.workerCommands(id),
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

    const res = await this.workerCommands(id).execCapture(
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
    await probeLstat(this.workerCommands(id), containerId, src);

    // Target must not exist (no overwrite) and must not escape /workspace.
    // check_many reports a missing target as escaping when its nearest existing
    // ancestor escapes (e.g. renaming into a path under an escaping symlink).
    const { existing, escaping } = await runProbeCheckMany(
      this.workerCommands(id),
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
    const res = await this.workerCommands(id).execCapture(
      containerId,
      ["mv", "--no-target-directory", "--no-clobber", srcFull, targetFull],
      { user: "agent" },
    );
    // GNU `mv -n` exits 0 even when it skipped because the target existed. We
    // already ruled out an existing target above, but a race could still cause a
    // skip — confirm the move actually happened by the post-move state.
    const postSrc = await this.workerCommands(id).execCapture(
      containerId,
      ["test", "-e", srcFull],
      { user: "agent" },
    );
    const postTarget = await this.workerCommands(id).execCapture(
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
    const destEntry = await probeLstat(this.workerCommands(id), containerId, dest);
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
      await probeLstat(this.workerCommands(id), containerId, src);
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
      this.workerCommands(id),
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
        const removeTarget = await this.workerCommands(id).execCapture(
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
      const res = await this.workerCommands(id).execCapture(containerId, mvArgs, {
        user: "agent",
      });
      // Verify the move actually happened (defeats the mv -n exit-0-on-skip race).
      const postSrc = await this.workerCommands(id).execCapture(
        containerId,
        ["test", "-e", srcFull],
        { user: "agent" },
      );
      const postTarget = await this.workerCommands(id).execCapture(
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
      this.workerCommands(id),
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
      const res = await this.workerCommands(id).execCapture(
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
    signal?: AbortSignal,
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
      signal?.throwIfAborted();
      const entry = await probeLstat(
        this.workerCommands(id),
        containerId,
        rel,
        signal,
      );
      entries.push(entry);
    }

    // Single regular file -> raw byte stream via Docker getArchive, demuxed
    // from the tar envelope into a plain file stream.
    if (entries.length === 1 && entries[0]!.type === "file") {
      const entry = entries[0]!;
      const tarStream = await this.workerCommands(id).getArchive(
        containerId,
        toContainerPath(entry.path),
        signal,
      );
      const fileStream = demuxSingleFileFromTar(
        tarStream,
        entry.size,
        signal,
      );
      return { kind: "file", stream: fileStream, entry };
    }

    // Otherwise build a true ZIP from the Docker tar archives of each target.
    // buildWorkspaceZip returns its output stream immediately and runs the
    // sequential append/finalize detached so output backpressure cannot
    // deadlock; redundant descendant selections are filtered inside it.
    const zipStream = buildWorkspaceZip(
      this.workerCommands(id),
      containerId,
      entries,
      signal,
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
    const res = await this.workerCommands(id).execCapture(
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
    return this.withExistingWorkerLifecycleMutation(id, () =>
      this.stopUnlocked(id),
    );
  }

  /** Apply a lifecycle action to all ordinary workers directly contained in a
   * group and its descendants. Locks are preflighted for the complete live
   * target set before the first mutation. The ordering is owner fence, group
   * hierarchy fence, then one worker fence at a time. */
  async mutateWorkerGroupSubtree(
    userId: string,
    groupId: string,
    action: WorkerGroupLifecycleAction,
    lockPasswords?: unknown,
    authorize?: () => void,
  ): Promise<WorkerGroupLifecycleResult> {
    if (this.activeWorkerGroupLifecycleOwners.has(userId)) {
      throw Object.assign(
        new Error("A worker-group lifecycle operation is already running for this owner"),
        { statusCode: 409 },
      );
    }
    this.activeWorkerGroupLifecycleOwners.add(userId);
    try {
      return await withOwnerLifecycleMutation(userId, async () => {
        await this.assertOwnerExists(userId);
        const [
          { withWorkerNetworkMutation },
          { useWorkerGroupStore },
          { WorkerGroupHierarchy },
          { verifyWorkerMutationUnlocks },
        ] = await Promise.all([
          import("./worker-group-manager"),
          import("./services"),
          import("./worker-group-hierarchy"),
          import("./worker-protection-lock"),
        ]);
        return withWorkerNetworkMutation(userId, async () => {
          authorize?.();
          const groups = useWorkerGroupStore();
          const hierarchy = new WorkerGroupHierarchy(groups);
          const subtree = hierarchy.descendants(userId, groupId, true);
          const targetedWorkerIds = [
            ...new Set(subtree.flatMap((group) => group.workerIds)),
          ];
          const result: WorkerGroupLifecycleResult = {
            action,
            groupId,
            groupIds: subtree.map((group) => group.id),
            targetedWorkerIds,
            succeededWorkerIds: [],
            skippedWorkerIds: [],
            failures: [],
          };
          const liveWorkerIds: string[] = [];
          for (const workerId of targetedWorkerIds) {
            const record = this.workerStore?.get(userId, workerId);
            if (record?.status === "archived" || (!record && !this.containers.has(workerId))) {
              result.skippedWorkerIds.push(workerId);
              continue;
            }
            liveWorkerIds.push(workerId);
          }
          await verifyWorkerMutationUnlocks(liveWorkerIds, lockPasswords);

          for (const workerId of liveWorkerIds) {
            await withWorkerLifecycleMutation(workerId, async () => {
              const worker = this.containers.get(workerId);
              if (!worker || worker.userId !== userId || worker.administrativeKind) {
                result.failures.push({
                  workerId,
                  message: "Worker runtime is unavailable",
                });
                return;
              }
              try {
                if (action === "stop") await this.stopUnlocked(workerId);
                else if (action === "rebuild") await this.rebuildUnlocked(workerId);
                else await this.archiveUnlocked(workerId);
                result.succeededWorkerIds.push(workerId);
              } catch (error) {
                result.failures.push({
                  workerId,
                  message: error instanceof Error ? error.message : "Lifecycle operation failed",
                });
              }
            });
          }
          if (result.failures.length) {
            throw Object.assign(
              new Error(
                `Worker-group ${action} partially failed for ${result.failures.length} worker(s)`,
              ),
              { statusCode: 409, data: result },
            );
          }
          return result;
        });
      });
    } finally {
      this.activeWorkerGroupLifecycleOwners.delete(userId);
    }
  }

  private async stopUnlocked(id: string, verifyRevokedIncus = false): Promise<void> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    if (info.runtimeKind === 'incus-vm') {
      const { useManagedVolumeManager } = await import('./managed-volume-manager');
      const volumes = useManagedVolumeManager(); await volumes.init();
      volumes.assertLiveRecoveryResolved(info.userId, info.id);
    }
    const incarnation = info.runtimeKind === 'incus-vm' ? this.capturedIncusIncarnation(info) : undefined;
    await this.persistDesiredRuntimeStatus(info, "stopped");
    useLogCollector().detach(info.containerId);
    try {
      await stopWorkerContainerIdempotently(
        info,
        () => info.runtimeKind === "incus-vm"
          ? this.incusRuntime.stop(info, incarnation)
          : this.dockerService.stopContainer(info.containerId),
        true,
        verifyRevokedIncus && info.runtimeKind === 'incus-vm',
      );
      // A list refresh may otherwise reuse the pre-stop task observation for
      // up to five seconds and overwrite the accurate in-memory `stopped`
      // state with stale `running` health.
      this.runtimeObservations.delete(info.containerId);
      info.runtimeDiagnostic = undefined;
    } catch (error) {
      this.markRuntimeUnknown(info, "Docker worker stop", error);
      throw error;
    }
    useLogger().info(`[container] stopped ${info.containerName}`);
  }

  async restart(id: string): Promise<void> {
    return this.withExistingWorkerLifecycleMutation(id, () =>
      this.restartUnlocked(id),
    );
  }

  private async restartUnlocked(id: string, storagePrepared = false): Promise<void> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    if (info.runtimeKind === "incus-vm") {
      const incarnation = this.capturedIncusIncarnation(info);
      if (info.hostMountsRevoked || info.hardwareDevicesRevoked)
        throw Object.assign(new Error("Worker access was revoked; rebuild is required"), { statusCode: 409 });
      const { useManagedVolumeManager } = await import('./managed-volume-manager');
      if (!storagePrepared && await useManagedVolumeManager().requiresRecreation(info.userId, id, info.containerId)) {
        await this.applyManagedStorageUnlocked(id);
        return;
      }
      await this.persistDesiredRuntimeStatus(info, "running");
      const options = await this.incusOptionsForWorker(info, true, info.containerId);
      info.status = "starting";
      try {
        await this.incusRuntime.stop(info, incarnation);
        await this.incusRuntime.start(options, incarnation);
        info.status = "running";
        info.updatedAt = new Date().toISOString();
        info.runtimeDiagnostic = undefined;
        useLogCollector().attach(info.containerName, info.containerId, 'worker', info.displayName).catch(() => {});
        await this.reconcileManagedNetworksForWorker(info);
      } catch (error) {
        this.markRuntimeUnknown(info, "Incus worker start", error);
        throw error;
      }
      return;
    }
    const { useManagedVolumeManager } = await import("./managed-volume-manager");
    if (!storagePrepared && await useManagedVolumeManager().requiresRecreation(info.userId, id, info.containerId)) {
      await this.applyManagedStorageUnlocked(id);
      return;
    }
    if (info.hostMountsRevoked)
      throw Object.assign(
        new Error(
          "Host mount access was revoked. Rebuild this worker before starting it again so Docker removes the old bind mount.",
        ),
        {
          statusCode: 409,
          statusMessage:
            "Host mount access was revoked. Rebuild this worker before starting it again so Docker removes the old bind mount.",
        },
      );
    if (info.hardwareDevicesRevoked)
      throw Object.assign(
        new Error("Hardware device access was revoked. Rebuild this worker before starting it again so Docker removes the old device mapping."),
        { statusCode: 409, statusMessage: "Hardware device access was revoked. Rebuild this worker before starting it again so Docker removes the old device mapping." },
      );
    await this.persistDesiredRuntimeStatus(info, "running");
    const { groupSecrets } = await this.resolveUserEnvAndBinds(
      info.userId,
      info.excludedGlobalEnvVarKeys ?? [],
      info.id,
      info.excludedGroupEnvVarKeys ?? [],
    );
    const localConfig = await useWorkerConfigStore().resolveAppliedValues(
      info.userId,
      id,
    );
    const runtimeSecrets = [...groupSecrets, ...localConfig];
    const sensitive = runtimeSecrets.some((entry) => entry.kind !== "variable");
    useLogCollector().detach(info.containerId);
    info.status = info.status === "unknown" ? "recovering" : "starting";
    info.runtimeDiagnostic = undefined;
    try {
      // Migrate legacy containers before starting them. Secret-bearing
      // workers must never be auto-started by dockerd without Agentor's
      // authenticated bootstrap path.
      await this.dockerService.updateContainerRestartPolicy(
        info.containerId,
        sensitive,
      );
      const runtime = await this.dockerService.inspectContainerRuntime(
        info.containerId,
      );
      if (runtime.running)
        await this.dockerService.restartContainer(info.containerId);
      else await this.dockerService.startContainer(info.containerId);

      let bootstrapError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.dockerService.materializeWorkerSecretFiles(
            info.containerId,
            runtimeSecrets,
          );
          bootstrapError = undefined;
          break;
        } catch (error) {
          bootstrapError = error;
          if (attempt < 2)
            await new Promise((resolve) =>
              setTimeout(resolve, attempt === 0 ? 250 : 750),
            );
        }
      }
      if (bootstrapError) {
        await this.dockerService.stopContainer(info.containerId).catch(() => {});
        throw Object.assign(
          new Error(
            "Worker secret bootstrap failed after bounded retries; stop/start can retry without rebuilding",
          ),
          {
            statusCode: 503,
            code: "WORKER_SECRET_BOOTSTRAP_FAILED",
            data: {
              code: "WORKER_SECRET_BOOTSTRAP_FAILED",
              workerId: info.id,
              phase: "secret-bootstrap",
              retryable: true,
              volumesPreserved: true,
              nextAction:
                "Retry stop/start after the secret provider is available; rebuilding is not required.",
            },
          },
        );
      }
      await this.dockerService.probeContainerTask(info.containerId, sensitive);
      info.status = "running";
      info.runtimeDiagnostic = undefined;
      info.updatedAt = new Date().toISOString();
      this.runtimeObservations.delete(info.containerId);
    } catch (error) {
      this.markRuntimeUnknown(info, "Managed worker restart", error);
      throw error;
    }
    useLogCollector()
      .attach(info.containerName, info.containerId, "worker", info.displayName)
      .catch(() => {});
    useLogger().info(`[container] restarted ${info.containerName}`);
    await this.reconcileWorkerPlugins(info);
  }

  /** Explicit recovery for a task/shim that no longer accepts normal stop,
   * restart, console, or stats operations. Only disposable compute is replaced;
   * every persistent mount is verified first and no volume is ever removed. */
  async recover(id: string): Promise<ContainerInfo> {
    return this.withExistingWorkerLifecycleMutation(id, () =>
      this.recoverUnlocked(id),
    );
  }

  private async recoverUnlocked(id: string): Promise<ContainerInfo> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    if (info.runtimeKind === 'incus-vm')
      return this.recreateIncusWorker(info, info.containerId.startsWith('incus:') ? info : undefined, true);
    await this.resolveAuthorizedHostMounts(
      info.userId,
      info.id,
      info.mounts,
    );
    const recoveryImage = info.importedImage
      ? (await this.resolveImageOpts(info.importedImage)).image
      : info.imageRuntimeReference;
    await this.dockerService.ensureImage(
      recoveryImage || this.config.workerImagePrefix + this.config.workerImage,
    );
    const persistentPathMounts = await this.persistentBackupPathMounts(
      info,
      info.status === "running",
    );
    await this.dockerService.assertWorkerPersistenceMounts(
      info.containerId,
      persistentPathMounts.map((mount) => mount.target),
    );
    await this.persistDesiredRuntimeStatus(info, "running");
    info.status = "recovering";
    info.runtimeDiagnostic = undefined;
    useLogCollector().detach(info.containerId);

    // SIGKILL is deliberately scoped to this exact Docker container. A stopped
    // or already-absent task is already past this phase; all other failures are
    // retained as diagnostic evidence while force-remove gets its own bounded
    // attempt.
    try {
      await this.dockerService.killContainer(info.containerId);
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number })
        ?.statusCode ?? (error as { status?: number })?.status;
      if (status !== 404 && status !== 409)
        useLogger().warn(
          `[container] scoped task kill did not settle for ${info.id}; attempting bounded force removal`,
        );
    }

    try {
      await removeDockerContainerIdempotently(() =>
        this.dockerService.removeContainer(info.containerId),
      );
    } catch (cause) {
      this.markRuntimeUnknown(info, "Managed worker recovery", cause);
      const error = Object.assign(
        new Error(
          "Managed recovery could not clear the stale Docker object. Persistent volumes are intact; retry after Docker daemon recovery.",
        ),
        {
          statusCode: 503,
          code: "WORKER_RECOVERY_DAEMON_STALE",
          data: {
            code: "WORKER_RECOVERY_DAEMON_STALE",
            workerId: info.id,
            phase: "remove-stale-runtime",
            volumesPreserved: true,
            retryable: true,
          },
          cause,
        },
      );
      const settlement = (cause as OperationFailureWithSettlement)?.[
        operationSettlement
      ];
      if (settlement)
        Object.defineProperty(error, operationSettlement, {
          value: settlement,
          enumerable: false,
        });
      throw error;
    }

    info.containerId = info.containerName;
    info.status = "error";
    info.updatedAt = new Date().toISOString();
    await this.workerStore?.archive(info.userId, info.id);
    this.containers.delete(info.id);
    return this.unarchiveUnlocked(info.userId, info.id);
  }

  /** Reconcile durable desired mounts after a catalog/grant/hierarchy change.
   * Invalid mounts are removed from desired state. A live Docker container is
   * stopped immediately and guarded against restart because bind mounts cannot
   * be detached in place; the next rebuild clears the guard. */
  async reconcileHostMountAccess(userId?: string): Promise<{
    affectedWorkerIds: string[];
    stoppedWorkerIds: string[];
    failures: Array<{ workerId: string; message: string }>;
  }> {
    if (!this.workerStore) throw new Error("WorkerStore not available");
    const { useHostMountStore } = await import("./services");
    const mountStore = useHostMountStore();
    const records = this.workerStore
      .list()
      .filter(
        (worker) =>
          (!userId || worker.userId === userId) &&
          (!!worker.mounts?.length || worker.hostMountsRevoked === true),
      );
    const result = {
      affectedWorkerIds: [] as string[],
      stoppedWorkerIds: [] as string[],
      failures: [] as Array<{ workerId: string; message: string }>,
    };

    for (const snapshot of records) {
      await withOwnerWorkerLifecycleMutation(snapshot.userId, snapshot.id, async () => {
        const record = this.workerStore!.get(snapshot.userId, snapshot.id);
        if (!record || (!record.mounts?.length && !record.hostMountsRevoked))
          return;
        const retained: MountConfig[] = [];
        // A persisted guard means a previous revoke committed but could have
        // lost the race to stop Docker. Keep retrying the stop even after the
        // revoked mount was already removed from desired state.
        let revoked = record.hostMountsRevoked === true;
        for (const mount of record.mounts ?? []) {
          try {
            const normalized = mountStore.resolveMounts(
              record.userId,
              record.id,
              [mount],
            );
            if (normalized?.[0]) retained.push(normalized[0]);
          } catch {
            revoked = true;
          }
        }
        const next = retained.length ? retained : undefined;
        const normalizedChanged =
          ContainerManager.normMounts(next) !==
          ContainerManager.normMounts(record.mounts);
        if (!revoked && !normalizedChanged) return;

        result.affectedWorkerIds.push(record.id);
        const live = this.containers.get(record.id);
        if (!live) {
          await this.workerStore!.updateHostMountAccess(
            record.userId,
            record.id,
            next,
            revoked,
          );
          if (revoked && record.status === 'active') {
            await this.workerStore!.setDesiredRuntimeStatus(record.userId, record.id, 'stopped');
            result.failures.push({ workerId: record.id,
              message: 'Worker runtime is unavailable; revoked host access is fenced and shutdown remains pending.' });
          }
          return;
        }

        live.mounts = next;
        if (revoked) {
          live.pendingRebuild = true;
          live.hostMountsRevoked = true;
        }
        live.updatedAt = new Date().toISOString();
        await this.workerStore!.updateHostMountAccess(
          record.userId,
          record.id,
          next,
          revoked,
        );
        if (!revoked) return;
        const native = live.runtimeKind === 'incus-vm' && record.status === 'active';
        if (!native && live.status !== 'running') return;
        // A stale cache is not evidence that a guest has lost revoked access.
        // Keep stopped intent even if settled-storage fencing defers shutdown.
        if (native) await this.workerStore!.setDesiredRuntimeStatus(record.userId, record.id, 'stopped');
        try {
          await this.stopUnlocked(live.id, native);
          result.stoppedWorkerIds.push(live.id);
        } catch (error) {
          result.failures.push({
            workerId: live.id,
            message: error instanceof Error ? error.message : "Worker could not be stopped",
          });
        }
      });
    }
    return result;
  }

  /** Revoke device mappings with the same stop-and-rebuild guarantee used for
   * host binds. Docker device cgroup rules cannot be removed from a live worker. */
  async reconcileHardwareDeviceAccess(userId?: string): Promise<{
    affectedWorkerIds: string[];
    stoppedWorkerIds: string[];
    failures: Array<{ workerId: string; message: string }>;
  }> {
    if (!this.workerStore) throw new Error("WorkerStore not available");
    const records = this.workerStore.list().filter((worker) =>
      (!userId || worker.userId === userId) &&
      (!!worker.hardwareDeviceIds?.length || worker.hardwareDevicesRevoked === true),
    );
    const result = {
      affectedWorkerIds: [] as string[], stoppedWorkerIds: [] as string[],
      failures: [] as Array<{ workerId: string; message: string }>,
    };
    for (const snapshot of records) {
      await withOwnerWorkerLifecycleMutation(snapshot.userId, snapshot.id, async () => {
        const record = this.workerStore!.get(snapshot.userId, snapshot.id);
        if (!record || (!record.hardwareDeviceIds?.length && !record.hardwareDevicesRevoked)) return;
        const retained: string[] = [];
        let revoked = record.hardwareDevicesRevoked === true;
        for (const deviceId of record.hardwareDeviceIds ?? []) {
          try {
            const allowed = await this.resolveHardwareDeviceAccess(
              record.userId, record.id, [deviceId], undefined, false,
            );
            if (allowed?.[0]) retained.push(allowed[0]);
          } catch { revoked = true; }
        }
        const next = retained.length ? retained.sort() : undefined;
        if (!revoked && JSON.stringify(next ?? []) === JSON.stringify(record.hardwareDeviceIds ?? [])) return;
        result.affectedWorkerIds.push(record.id);
        const live = this.containers.get(record.id);
        if (!live) {
          await this.workerStore!.updateHardwareDeviceAccess(record.userId, record.id, next, false);
          return;
        }
        live.hardwareDeviceIds = next;
        if (revoked) { live.pendingRebuild = true; live.hardwareDevicesRevoked = true; }
        live.updatedAt = new Date().toISOString();
        await this.workerStore!.updateHardwareDeviceAccess(record.userId, record.id, next, revoked);
        if (!revoked || live.status !== "running") return;
        try {
          await this.stopUnlocked(live.id);
          result.stoppedWorkerIds.push(live.id);
        } catch (error) {
          result.failures.push({ workerId: live.id, message: error instanceof Error ? error.message : "Worker could not be stopped" });
        }
      });
    }
    return result;
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
        pathId: m.pathId || "",
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
   * - **Applied immediately (no rebuild)** — `displayName` and
   *   `workerSelfApiAccess`. Applied to the in-memory ContainerInfo and the
   *   WorkerStore immediately; the running worker keeps serving.
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
    return this.withExistingWorkerLifecycleMutation(id, () =>
      this.updateSettingsForOwner(id, patch),
    );
  }

  private async updateSettingsForOwner(
    id: string,
    patch: UpdateContainerSettingsRequest,
  ): Promise<ContainerInfo> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    // WorkerStore persistence is the commit point. Keep an exact snapshot so
    // a failed write cannot leave uncommitted desired settings active in the
    // live inventory until the next orchestrator restart.
    const previousInfo = structuredClone(info);

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
    if (
      patch.workerSelfApiAccess !== undefined &&
      !isWorkerSelfApiAccess(patch.workerSelfApiAccess)
    )
      throw Object.assign(new Error("Invalid workerSelfApiAccess"), {
        statusCode: 400,
      });
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
    if (
      patch.workerSelfApiAccess !== undefined &&
      patch.workerSelfApiAccess !== (info.workerSelfApiAccess ?? "inherit")
    ) {
      info.workerSelfApiAccess = patch.workerSelfApiAccess;
      liveChanged = true;
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

    // Volume mounts — rebuild. The source is always re-resolved through the
    // central catalog; a client-supplied source path is never authoritative.
    if (patch.mounts !== undefined) {
      const next = await this.resolveAuthorizedHostMounts(
        info.userId,
        info.id,
        patch.mounts,
      );
      if (
        ContainerManager.normMounts(next) !==
        ContainerManager.normMounts(info.mounts)
      ) {
        info.mounts = next;
        rebuildChanged = true;
      }
    }

    if (patch.hardwareDeviceIds !== undefined) {
      const next = await this.resolveHardwareDeviceAccess(
        info.userId, info.id, patch.hardwareDeviceIds,
      );
      if (JSON.stringify(next ?? []) !== JSON.stringify(info.hardwareDeviceIds ?? [])) {
        info.hardwareDeviceIds = next;
        rebuildChanged = true;
      }
    }

    if (rebuildChanged) info.pendingRebuild = true;

    if (liveChanged || rebuildChanged) {
      info.updatedAt = new Date().toISOString();
      try {
        if (this.workerStore) {
          await this.workerStore.upsert(this.containerInfoToWorkerRecord(info));
        }
      } catch (error) {
        // Restore in place so any in-flight holder of this ContainerInfo sees
        // the durable state too. Delete fields introduced by the failed patch
        // before copying the prior snapshot back.
        const current = info as unknown as Record<string, unknown>;
        const previous = previousInfo as unknown as Record<string, unknown>;
        for (const key of Object.keys(current)) {
          if (!(key in previous)) delete current[key];
        }
        Object.assign(current, previous);
        throw error;
      }
      useLogger().info(
        `[container] updated settings for ${info.containerName}${rebuildChanged ? " (pending rebuild)" : ""}`,
      );
    }

    return info;
  }

  async remove(id: string): Promise<void> {
    return this.withExistingWorkerLifecycleMutation(id, () =>
      this.removeUnlocked(id),
    );
  }

  private async removeUnlocked(id: string): Promise<void> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    if (info.runtimeKind === 'incus-vm') {
      const { useManagedVolumeManager } = await import('./managed-volume-manager');
      const volumes = useManagedVolumeManager(); await volumes.init();
      volumes.assertLiveRecoveryResolved(info.userId, info.id);
    }
    const incarnation = info.runtimeKind === 'incus-vm' ? this.capturedIncusIncarnation(info) : undefined;
    // A graceful VM shutdown can finish after its bounded API response fails.
    // Withdraw running intent first so reconciliation cannot resurrect a VM
    // that the operator explicitly asked to delete. Retain data on failure.
    if (info.runtimeKind === 'incus-vm') await this.persistDesiredRuntimeStatus(info, 'stopped');
    // Keep the authoritative entry when Docker removal fails. Dropping it in a
    // finally block made a retry resolve the stable worker UUID as though it
    // were a Docker container id, leaving the real container untracked and
    // preventing restore/account-cleanup rollback from retrying it.
    await removeDockerContainerIdempotently(() =>
      info.runtimeKind === "incus-vm" ? this.incusRuntime.remove(info, incarnation)
        : this.dockerService.removeContainer(info.containerId),
    );
    useLogCollector().detach(info.containerId);
    info.status = "removing";
    info.updatedAt = new Date().toISOString();
    let deletionStateError: unknown;
    if (this.workerStore) {
      try {
        const existing = this.workerStore.get(info.userId, info.id);
        if (existing) {
          await this.workerStore.markDeletionPending(info.userId, info.id);
        } else {
          // Initial provisioning can fail before its first WorkerStore write.
          // Create the retry handle when possible, but never let a second
          // persistence failure prevent best-effort cleanup of the published
          // in-memory provisional worker.
          await this.workerStore.upsert({
            ...this.containerInfoToWorkerRecord(info),
            status: "archived",
            deletionPending: true,
            archivedAt: new Date().toISOString(),
          });
        }
        // The archived deletion-pending record is now the single authoritative
        // retry handle. Avoid rendering a duplicate live card while cleanup is
        // retried.
        this.containers.delete(id);
      } catch (error) {
        deletionStateError = error;
      }
    }

    const actions: Array<readonly [string, () => Promise<void>]> = [
      [
        "workspace tombstone",
        () =>
          recordWorkspaceTombstone({
            workerId: info.id,
            userId: info.userId,
            displayName: info.displayName || info.id,
            backend: this.storageManager?.mode ?? "volume",
            createdAt: info.createdAt,
          }),
      ],
      ["mapping cleanup", () => cleanupWorkerMappings(info.containerName)],
      ...(info.runtimeKind === "incus-vm" ? [["Incus core storage", () => this.incusRuntime.removeStorage({
        id: info.id, userId: info.userId, containerName: info.containerName,
      })] as const] : []),
      [
        "worker group memberships",
        async () => {
          const { removeDeletedWorkerFromGroups } = await import(
            "./worker-group-manager"
          );
          await removeDeletedWorkerFromGroups(info.userId, info.id);
        },
      ],
    ];
    if (this.storageManager && info.runtimeKind !== "incus-vm") {
      actions.push(
        [
          "Docker data",
          () => this.storageManager!.removeWorkerDocker(info.containerName),
        ],
        [
          "workspace",
          () =>
            this.storageManager!.removeWorkerWorkspace(
              info.userId,
              info.id,
              info.containerName,
            ),
        ],
        [
          "agent data",
          () =>
            this.storageManager!.removeWorkerAgents(
              info.userId,
              info.id,
              info.containerName,
            ),
        ],
      );
    }
    if (info.importedImage?.startsWith(IMPORT_IMAGE_PREFIX)) {
      actions.push([
        "imported image",
        () => this.dockerService.removeImage(info.importedImage!),
      ]);
    }
    actions.push(
      [
        "persistent backup paths",
        async () => {
          const { usePersistentBackupPathManager } = await import("./services");
          const { useManagedVolumeManager } = await import("./managed-volume-manager");
          const volumes = useManagedVolumeManager();
          await volumes.workerDeleted(info.userId, info.id);
          if (info.runtimeKind !== 'incus-vm')
            await usePersistentBackupPathManager().removeWorkerVolumes(info.id, volumes.store.forWorker(info.userId, info.id).map((v) => v.dockerName));
        },
      ],
      [
        "import-created environment",
        () => this.cleanupImportCreatedEnvironment(info.userId, info.id),
      ],
      [
        "worker-local configuration",
        () => useWorkerConfigStore().remove(info.userId, info.id),
      ],
      [
        "plugin installations",
        async () => {
          const { usePluginInstallationStore } = await import("./services");
          await usePluginInstallationStore().removeForWorker(info.userId, info.id);
        },
      ],
      [
        "worker plugin definitions",
        async () => {
          const { usePluginDefinitionStore } = await import("./services");
          await usePluginDefinitionStore().removeForWorker(info.userId, info.id);
        },
      ],
    );
    const failures = await collectWorkerCleanupFailures(actions);
    if (failures.length && deletionStateError) {
      failures.unshift("worker deletion state");
    }
    if (failures.length) {
      throw Object.assign(
        new Error(`Worker deletion cleanup incomplete: ${failures.join(", ")}`),
        { code: "WORKER_DELETE_CLEANUP_INCOMPLETE", failures },
      );
    }

    if (this.workerStore?.get(info.userId, info.id)) {
      try {
        await this.workerStore.delete(info.userId, info.id);
      } catch (error) {
        // Keep the in-memory provisional handle when the durable record cannot
        // be removed. If deletionPending was committed, the archived record is
        // already the authoritative retry handle and no duplicate is exposed.
        if (!this.workerStore.get(info.userId, info.id)?.deletionPending) {
          this.containers.set(id, info);
        }
        throw Object.assign(
          new Error("Worker deletion cleanup incomplete: worker record"),
          {
            code: "WORKER_DELETE_CLEANUP_INCOMPLETE",
            failures: ["worker record"],
            cause: error,
          },
        );
      }
    }
    this.containers.delete(id);
    this.importCreatedEnvironments.delete(id);
    useLogger().info(`[container] removed ${info.containerName}`);
  }

  async archive(id: string): Promise<void> {
    return this.withExistingWorkerLifecycleMutation(id, () =>
      this.archiveUnlocked(id),
    );
  }

  private async archiveUnlocked(id: string): Promise<void> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    if (info.runtimeKind === 'incus-vm') {
      if (!this.workerStore) throw new Error('WorkerStore is required before archiving Incus compute');
      const record = this.workerStore.get(info.userId, info.id);
      if (!record || record.status !== 'active' || record.runtimeKind !== 'incus-vm' || record.deletionPending)
        throw new Error('Incus archive requires a matching active durable worker record');
      await this.assertIncusPersistenceReady(info, true);
      const incarnation = info.containerId.startsWith('incus:') ? info.containerId.slice(6) : '';
      await this.incusRuntime.prepareArchive(info, incarnation);
      await this.persistDesiredRuntimeStatus(info, 'stopped');
      useLogCollector().detach(info.containerId);
      await this.incusRuntime.remove(info, incarnation);
      this.runtimeObservations.delete(info.containerId);
      // Retain the proven UUID on persistence failure. A retry may observe no
      // compute; it must not become authority over a new same-name instance.
      info.status = 'error';
      info.updatedAt = new Date().toISOString();
      await this.workerStore.archive(info.userId, info.id);
      this.containers.delete(id);
      useLogger().info(`[container] archived ${info.containerName}`);
      return;
    }
    // A deferred persistence request must capture data before archive discards
    // the rootfs, just as an explicit rebuild does.
    await this.persistentBackupPathMounts(info, true);
    await this.persistDesiredRuntimeStatus(info, "stopped");

    useLogCollector().detach(info.containerId);

    await stopWorkerContainerIdempotently(info, () =>
      this.dockerService.stopContainer(info.containerId),
    );

    await removeDockerContainerIdempotently(() =>
      this.dockerService.removeContainer(info.containerId),
    );

    // Docker is gone. Keep a deterministic removal target and a retry-safe
    // runtime state before persisting the archive transition. If persistence
    // fails, the next archive attempt skips stop and treats Docker 404 as the
    // already-achieved removal state.
    info.containerId = info.containerName;
    info.status = "error";
    info.updatedAt = new Date().toISOString();

    if (this.workerStore) {
      // Preserve an existing durable transition (especially
      // deletionPending). Only legacy/unregistered live workers need an
      // initial record before they can be archived.
      if (!this.workerStore.get(info.userId, info.id)) {
        await this.workerStore.upsert(this.containerInfoToWorkerRecord(info));
      }
      await this.workerStore.archive(info.userId, info.id);
    }

    useLogger().info(`[container] archived ${info.containerName}`);
    this.containers.delete(id);
  }

  private async assertIncusPersistenceReady(info: Pick<ContainerInfo, 'id' | 'userId'> & Partial<Pick<ContainerInfo, 'containerId'>>, prepare = false): Promise<void> {
    const [{ useBackupManager }, { useManagedVolumeManager }] = await Promise.all([
      import('./backup-manager'), import('./managed-volume-manager'),
    ]);
    const volumes = useManagedVolumeManager();
    await volumes.init();
    if (volumes.isRecoveryBlocked(info.id)) await volumes.recoverWorker(info.userId, info.id);
    if (volumes.recreations.get(info.userId, info.id) ||
        volumes.store.forWorker(info.userId, info.id).some(volume => volume.liveContainerId))
      throw new Error('Incus storage has incompatible legacy recovery state; data was retained');
    const backup = await useBackupManager().getConfig(info.userId);
    const { normalizeBackupPaths } = await import('./backup-paths');
    const selected = normalizeBackupPaths(backup?.persistSelectedDirectories === false ? [] : backup?.selectedPathsByWorkspace?.[info.id] ?? []);
    if (prepare) {
      if (!info.containerId?.startsWith('incus:')) throw new Error('Incus storage preparation requires a captured source incarnation');
      await volumes.adoptIncusSelections({ id: info.id, userId: info.userId, containerId: info.containerId }, selected);
      await volumes.prepare({ id: info.id, userId: info.userId, containerId: info.containerId });
    } else {
      // Archive/recreation preflight already classified selections. With
      // unexpectedly missing active compute there is no source left to prove
      // whether an unrecorded application path was a file or lost directory.
      const record = this.workerStore?.get(info.userId, info.id);
      if (record?.status === 'active' && !record.incusRecreation) {
        const { validatePersistenceTarget } = await import('./managed-volume-store');
        const known = new Set(volumes.store.forWorker(info.userId, info.id).map(v => v.target));
        for (const path of selected) {
          if (known.has(path) || path === '/' || path === '/workspace') continue;
          try { validatePersistenceTarget(path); }
          catch (error) { if ((error as { statusCode?: number }).statusCode === 400) continue; throw error; }
          throw new Error('Missing Incus compute has an unrecorded selected path. Restore or resolve its persistence before replacement.');
        }
      }
      await volumes.mounts(info.userId, info.id);
    }
  }

  async rebuild(id: string): Promise<ContainerInfo> {
    return this.withExistingWorkerLifecycleMutation(id, () =>
      this.rebuildUnlocked(id),
    );
  }

  private async persistentBackupPathMounts(
    worker: Pick<ContainerInfo, "id" | "userId" | "containerId" | "status">,
    prepare: boolean,
  ) {
    const [{ useBackupManager }, { usePersistentBackupPathManager }] =
      await Promise.all([import("./backup-manager"), import("./services")]);
    const config = await useBackupManager().getConfig(worker.userId);
    const { useManagedVolumeManager } = await import("./managed-volume-manager");
    const volumes = useManagedVolumeManager();
    await volumes.init();
    if (volumes.isRecoveryBlocked(worker.id)) await volumes.recoverWorker(worker.userId, worker.id);
    // Once adopted, backup selection no longer controls or reseeds a volume.
    // In particular, removing an attachment must not be undone by an old
    // backup selection that still references the same path.
    const knownTargets = new Set(volumes.store.forWorker(worker.userId, worker.id).map((v) => v.target));
    const paths = config?.persistSelectedDirectories === false ? [] : config?.selectedPathsByWorkspace?.[worker.id]?.filter((path) => !knownTargets.has(path));
    const manager = usePersistentBackupPathManager();
    const legacy = prepare
      ? manager.prepareWorker(worker, paths)
      : manager.mountsForSelections(worker.id, paths);
    const mounts = await legacy;
    await volumes.adoptLegacy(worker.userId, worker.id, mounts.map((m) => m.target));
    return prepare ? volumes.prepare(worker) : volumes.mounts(worker.userId, worker.id);
  }

  /** Storage-only recreation. Caller MUST hold owner then worker lifecycle
   * fences. Clone the actual immutable image and runtime configuration rather
   * than applying pending environment/image/settings changes as rebuild does. */
  async applyManagedStorageUnlocked(id: string): Promise<void> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    if (info.hostMountsRevoked || info.hardwareDevicesRevoked)
      throw Object.assign(new Error("Rebuild the worker to apply revoked hardware or host-mount permissions first."), { statusCode: 409 });
    const { useManagedVolumeManager } = await import("./managed-volume-manager");
    const volumes = useManagedVolumeManager();
    await volumes.init();
    if (volumes.isRecoveryBlocked(id)) await volumes.recoverWorker(info.userId, id);
    if (info.runtimeKind === 'incus-vm') {
      // Use the existing bounded Incus recreation marker and applied bootstrap;
      // storage application is not authority to promote pending settings.
      await this.recreateIncusWorker(info, info, true);
      return;
    }
    const docker = volumes.runtime.docker;
    const interrupted = volumes.recreations.get(info.userId, id);
    if (interrupted) {
      // Retry the retained replacement before creating another journal. The
      // old rootfs remains recoverable until bootstrap succeeds.
      if (interrupted.replacementId) {
        const replacement = await docker.getContainer(interrupted.replacementId).inspect();
        if (replacement.Config.Labels?.[WORKER_ID_LABEL] !== id)
          throw new Error("Storage replacement identity mismatch");
        info.containerId = replacement.Id;
        await volumes.markDeclared(info.userId, id, replacement.Id);
        await this.restartUnlocked(id, true);
        await docker.getContainer(interrupted.originalId).remove();
        await volumes.recreations.clear(info.userId, id);
        if (!await volumes.requiresRecreation(info.userId, id, replacement.Id) &&
            volumes.store.forWorker(info.userId, id).every((v) => !v.attached || v.seeded)) return;
      } else {
        const source = await docker.getContainer(interrupted.originalId).inspect();
        if (source.Config.Labels?.[WORKER_ID_LABEL] !== id) throw new Error("Storage source identity mismatch");
        if (source.Name !== `/${info.containerName}`)
          await docker.getContainer(source.Id).rename({ name: info.containerName });
        info.containerId = source.Id;
        await volumes.recreations.clear(info.userId, id);
      }
    }
    const beforePrepare = await docker.getContainer(info.containerId).inspect();
    const endpoints = Object.entries(beforePrepare.NetworkSettings.Networks ?? {});
    // Fixed IP reservations cannot belong to both a retained rollback source
    // and its replacement. Refuse before stopping rather than silently drop
    // the reservation or alter unrelated networking settings.
    if (endpoints.some(([, endpoint]) => endpoint.IPAMConfig?.IPv4Address || endpoint.IPAMConfig?.IPv6Address)) {
      const { volumeError } = await import("./managed-volume-store");
      throw volumeError(409, "Storage-only recreation cannot preserve an explicit network IP reservation. Use live mounting or remove the reservation first.");
    }
    const mounts = await volumes.prepare(info);
    const old = docker.getContainer(info.containerId);
    const original = await old.inspect();
    const oldId = original.Id;
    const targets = new Set(volumes.store.forWorker(info.userId, info.id).map((v) => v.target));
    if (original.State.Paused)
      throw Object.assign(new Error("Resolve the interrupted live-mount operation before recreating this worker."), { statusCode: 409 });
    await this.persistDesiredRuntimeStatus(info, "running");
    if (original.State.Running) await old.stop({ t: 15 });
    useLogCollector().detach(oldId);
    const rollbackName = `${info.containerName}-storage-rollback-${randomUUID()}`;
    const journal = { userId: info.userId, workerId: id, originalId: oldId,
      containerName: info.containerName, rollbackName, createdAt: new Date().toISOString(), replacementId: undefined as string | undefined };
    await volumes.recreations.save(journal);
    await old.update({ RestartPolicy: { Name: "no" } });
    await old.rename({ name: rollbackName });
    let replacement: Awaited<ReturnType<typeof docker.createContainer>> | undefined;
    try {
      const hostConfig = { ...original.HostConfig,
        RestartPolicy: { Name: "no" },
        Mounts: [
          ...(original.HostConfig.Mounts ?? []).filter((m) => !targets.has(m.Target)),
          // Dockerfile VOLUME declarations can produce anonymous mounts not
          // present in HostConfig.Mounts/Binds. Retain those exact volumes.
          ...original.Mounts.filter((m) => m.Type === "volume" && m.Name && !targets.has(m.Destination) &&
            !(original.HostConfig.Mounts ?? []).some((declared) => declared.Target === m.Destination) &&
            !(original.HostConfig.Binds ?? []).some((bind) => bind.split(":")[1] === m.Destination))
            .map((m) => ({ Type: "volume" as const, Source: m.Name!, Target: m.Destination, ReadOnly: !m.RW, VolumeOptions: { NoCopy: true } })),
          ...mounts.map((m) => ({ Type: "volume" as const, Source: m.source, Target: m.target, VolumeOptions: { NoCopy: true } })),
        ] as any,
      };
      replacement = await docker.createContainer({
        ...original.Config, Image: original.Image,
        Hostname: original.Config.Hostname === oldId.slice(0, 12) ? undefined : original.Config.Hostname,
        name: info.containerName, HostConfig: hostConfig,
        NetworkingConfig: { EndpointsConfig: Object.fromEntries(endpoints.map(([network, endpoint]) => [network, {
          Aliases: endpoint.Aliases?.filter((alias: string) => alias !== oldId && alias !== oldId.slice(0, 12)),
          Links: endpoint.Links,
          DriverOpts: (endpoint as { DriverOpts?: Record<string, string> }).DriverOpts,
        }])) },
      });
      info.containerId = replacement.id;
      journal.replacementId = replacement.id;
      await volumes.recreations.save(journal);
      info.status = "stopped";
      // Docker now declares every volume. Clear transient markers before
      // restartUnlocked so it performs bootstrap rather than recreating again.
      await volumes.markDeclared(info.userId, info.id, replacement.id);
      await this.restartUnlocked(id, true);
      await old.remove();
      if (this.workerStore) await this.workerStore.upsert(this.containerInfoToWorkerRecord(info));
      await volumes.recreations.clear(info.userId, id);
    } catch (error) {
      // Never delete persistent volumes or the retained source rootfs. A
      // partially started replacement is stopped, not silently substituted.
      if (replacement) await replacement.stop({ t: 5 }).catch(() => {});
      info.status = "error";
      if (!replacement) {
        await old.rename({ name: info.containerName });
        info.containerId = oldId;
      }
      throw error;
    }
  }

  private async rebuildUnlocked(id: string): Promise<ContainerInfo> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    this.assertOrdinaryMutation(info);
    if (info.runtimeKind === 'incus-vm') return this.recreateIncusWorker(info, info);

    // Fail before touching the existing container when a grant was revoked or
    // a legacy source-only mount has not yet been approved.
    const authorizedMounts = await this.resolveAuthorizedHostMounts(
      info.userId,
      info.id,
      info.mounts,
    );
    const authorizedHardwareDeviceIds = await this.resolveHardwareDeviceAccess(
      info.userId, info.id, info.hardwareDeviceIds,
    );
    const hardwareDevices = await this.resolveHardwareDeviceAccess(
      info.userId, info.id, authorizedHardwareDeviceIds, undefined, true,
    );

    // Materialize newly selected directories before touching disposable
    // compute. If capture fails, the original container is still running and
    // the rebuild aborts without exposing an empty volume at that path.
    const persistentPathMounts = await this.persistentBackupPathMounts(
      info,
      true,
    );
    // Resolve every immutable image dependency while the current runtime is
    // still intact. A missing captured/custom image must never turn rebuild or
    // managed recovery into an unintended standard-image substitution.
    const imageOpts = info.importedImage
      ? await this.resolveImageOpts(info.importedImage)
      : { image: info.imageRuntimeReference, imageConfig: undefined };
    await this.dockerService.ensureImage(
      imageOpts.image || this.config.workerImagePrefix + this.config.workerImage,
    );
    await this.persistDesiredRuntimeStatus(info, "running");

    useLogCollector().detach(info.containerId);

    // Stop and remove the old container — workspace, agents, and DinD volumes
    // are preserved (rebuild behaves identically to archive + unarchive).
    await stopWorkerContainerIdempotently(info, () =>
      this.dockerService.stopContainer(info.containerId),
    );
    await removeDockerContainerIdempotently(() =>
      this.dockerService.removeContainer(info.containerId),
    );

    // A failed archive transition must not leave a stale "running" handle
    // that retries stop against a container Docker has already removed.
    info.containerId = info.containerName;
    info.status = "error";
    info.updatedAt = new Date().toISOString();

    // Docker is gone. Persist the safe archive state before doing any work
    // that can fail so restart/account cleanup always retains the worker.
    if (this.workerStore) {
      if (!this.workerStore.get(info.userId, info.id)) {
        await this.workerStore.upsert(this.containerInfoToWorkerRecord(info));
      }
      await this.workerStore.archive(info.userId, info.id);
    }
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

    const { gitName, gitEmail } = await this.resolveGitIdentity(info.userId);

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

    const imageName =
      imageOpts.image ||
      this.config.workerImagePrefix + this.config.workerImage;
    const containerInfo: ContainerInfo = {
      id: info.id,
      runtimeKind: normalizeWorkerRuntimeKind(info.runtimeKind),
      userId: info.userId,
      createdAt: info.createdAt,
      updatedAt: new Date().toISOString(),
      containerId: info.containerName,
      containerName: info.containerName,
      displayName: info.displayName,
      imageName,
      imageId: info.imageDigest || "",
      status: "creating",
      desiredRuntimeStatus: "running",
      repos: info.repos,
      mounts: authorizedMounts,
      hardwareDeviceIds: authorizedHardwareDeviceIds,
      initScript: info.initScript,
      environmentId: info.environmentId,
      excludedGlobalEnvVarKeys: info.excludedGlobalEnvVarKeys ?? [],
      excludedGroupEnvVarKeys: info.excludedGroupEnvVarKeys ?? [],
      workerSelfApiAccess: info.workerSelfApiAccess,
      // Rebuild applies any pending settings edits, so the flag is cleared.
      pendingRebuild: false,
      hostMountsRevoked: false,
      hardwareDevicesRevoked: false,
      // Keep the imported-image link only while that image still exists.
      importedImage: imageOpts.image ? info.importedImage : undefined,
      imageDefinitionId: info.imageDefinitionId,
      imageVersion: info.imageVersion,
      imageDigest: info.imageDigest,
      imageRuntimeReference: info.imageRuntimeReference,
    };

    // Publish a single active provisional identity before Docker mutation.
    // Failed recreation rolls this back to the already-persisted archive.
    if (this.workerStore) await this.workerStore.unarchive(info.userId, info.id);
    this.containers.set(info.id, containerInfo);

    try {
      const container = await this.dockerService.createWorkerContainer({
        userId: info.userId,
        id: info.id,
        containerName: info.containerName,
        cpuLimit,
        memoryLimit,
        mounts: authorizedMounts,
        hardwareDevices,
        dockerEnabled,
        credentialBinds,
        persistentPathMounts,
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
      containerInfo.containerId = container.id;
      containerInfo.status = "running";
      containerInfo.updatedAt = new Date().toISOString();
    } catch (error) {
      await this.rollbackFailedRecreation(containerInfo, info.containerName, error);
    }

    await (await import("./managed-volume-manager")).useManagedVolumeManager().markDeclared(info.userId, info.id, containerInfo.containerId);

    try {
      if (this.workerStore) {
        await this.workerStore.upsert(
          this.containerInfoToWorkerRecord(containerInfo),
        );
      }
      await useWorkerConfigStore().markApplied(info.userId, info.id);
    } catch (error) {
      await this.rollbackFailedRecreation(
        containerInfo,
        containerInfo.containerId,
        error,
      );
    }

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
      .attach(info.containerName, containerInfo.containerId, "worker", info.displayName)
      .catch(() => {});

    useLogger().info(
      `[container] rebuilt ${info.containerName} (${containerInfo.containerId.slice(0, 12)})`,
    );
    await this.reconcileManagedNetworksForWorker(containerInfo);
    await this.reconcileWorkerPlugins(containerInfo);

    return containerInfo;
  }

  async unarchive(userId: string, id: string): Promise<ContainerInfo> {
    return withOwnerWorkerLifecycleMutation(userId, id, async () => {
      await this.assertOwnerExists(userId);
      return this.unarchiveUnlocked(userId, id);
    });
  }

  private async unarchiveUnlocked(
    userId: string,
    id: string,
  ): Promise<ContainerInfo> {
    if (!this.workerStore) throw new Error("WorkerStore not available");

    const worker = this.workerStore.get(userId, id);
    if (!worker || worker.status !== "archived") {
      throw new Error("Archived worker not found");
    }
    if (worker.deletionPending) {
      throw Object.assign(
        new Error("Worker deletion cleanup is still pending"),
        { statusCode: 409 },
      );
    }
    if (worker.runtimeKind === 'incus-vm') {
      const containerName = this.buildContainerName(worker.id);
      return this.recreateIncusWorker({ ...worker, runtimeKind: 'incus-vm',
        containerName, containerId: containerName, imageName: this.config.incusWorkerImage,
        imageId: worker.imageDigest ?? '', status: 'creating' });
    }
    const authorizedMounts = await this.resolveAuthorizedHostMounts(
      worker.userId,
      worker.id,
      worker.mounts,
    );
    const authorizedHardwareDeviceIds = await this.resolveHardwareDeviceAccess(
      worker.userId, worker.id, worker.hardwareDeviceIds,
    );
    const hardwareDevices = await this.resolveHardwareDeviceAccess(
      worker.userId, worker.id, authorizedHardwareDeviceIds, undefined, true,
    );

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

    const { gitName, gitEmail } = await this.resolveGitIdentity(worker.userId);

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

    const imageName =
      imageOpts.image ||
      this.config.workerImagePrefix + this.config.workerImage;
    const containerInfo: ContainerInfo = {
      id: worker.id,
      runtimeKind: normalizeWorkerRuntimeKind(worker.runtimeKind),
      userId: worker.userId,
      createdAt: worker.createdAt,
      updatedAt: new Date().toISOString(),
      containerId: containerName,
      containerName,
      displayName: worker.displayName,
      imageName,
      imageId: worker.imageDigest || "",
      status: "creating",
      desiredRuntimeStatus: "running",
      repos: worker.repos,
      mounts: authorizedMounts,
      hardwareDeviceIds: authorizedHardwareDeviceIds,
      initScript: worker.initScript,
      environmentId: worker.environmentId,
      excludedGlobalEnvVarKeys: worker.excludedGlobalEnvVarKeys ?? [],
      excludedGroupEnvVarKeys: worker.excludedGroupEnvVarKeys ?? [],
      workerSelfApiAccess: worker.workerSelfApiAccess,
      // Unarchive recreates the container from the stored config, applying any
      // pending settings edits, so the flag is cleared.
      pendingRebuild: false,
      hostMountsRevoked: false,
      hardwareDevicesRevoked: false,
      importedImage: imageOpts.image ? worker.importedImage : undefined,
      imageDefinitionId: worker.imageDefinitionId,
      imageVersion: worker.imageVersion,
      imageDigest: worker.imageDigest,
      imageRuntimeReference: worker.imageRuntimeReference,
    };
    const persistentPathMounts = await this.persistentBackupPathMounts(
      containerInfo,
      false,
    );

    // Make the active provisional identity authoritative before asking Docker
    // to create anything. This closes the post-create/pre-persistence leak.
    await this.workerStore.unarchive(worker.userId, worker.id);
    this.containers.set(worker.id, containerInfo);

    try {
      const container = await this.dockerService.createWorkerContainer({
        userId: worker.userId,
        id: worker.id,
        containerName,
        cpuLimit,
        memoryLimit,
        mounts: authorizedMounts,
        hardwareDevices,
        dockerEnabled,
        credentialBinds,
        persistentPathMounts,
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
      containerInfo.containerId = container.id;
      containerInfo.status = "running";
      containerInfo.updatedAt = new Date().toISOString();
      await this.workerStore.upsert(this.containerInfoToWorkerRecord(containerInfo));
      await useWorkerConfigStore().markApplied(worker.userId, worker.id);
      await (await import("./managed-volume-manager")).useManagedVolumeManager().markDeclared(worker.userId, worker.id, containerInfo.containerId);
    } catch (error) {
      await this.rollbackFailedRecreation(
        containerInfo,
        containerInfo.containerId,
        error,
      );
    }

    // Best-effort Traefik refresh — unarchive already succeeded; a reconcile
    // blip must not fail it (routing self-heals on the next reconcile).
    await reassignWorkerMappings(containerName).catch((err) => {
      useLogger().error(
        `[container] unarchive ${containerName}: traefik reconcile failed: ${err instanceof Error ? err.message : err}`,
      );
    });

    useLogCollector()
      .attach(containerName, containerInfo.containerId, "worker", worker.displayName)
      .catch(() => {});

    useLogger().info(
      `[container] unarchived ${containerName} (${containerInfo.containerId.slice(0, 12)})`,
    );
    await this.reconcileManagedNetworksForWorker(containerInfo);
    await this.reconcileWorkerPlugins(containerInfo);

    return containerInfo;
  }

  /** Replace disposable Incus compute. All desired inputs and canonical data
   * are checked before removing a running original; no Docker helper is used. */
  private async recreateIncusWorker(snapshot: ContainerInfo, original?: ContainerInfo, applied = false): Promise<ContainerInfo> {
    if (!this.workerStore) throw new Error('WorkerStore is required for Incus recreation');
    const record = this.workerStore.get(snapshot.userId, snapshot.id);
    if (!record || record.runtimeKind !== 'incus-vm' || record.deletionPending || record.incusRecreation ||
        record.status !== (original || applied ? 'active' : 'archived'))
      throw new Error('Incus recreation requires matching durable authority and no unresolved replacement');
    if (applied && (record.hostMountsRevoked || record.hardwareDevicesRevoked))
      throw new Error('Incus worker access was revoked; explicit rebuild is required');
    const assertMissing = async () => {
      try { await this.incusRuntime.client.getInstance(snapshot.containerName); }
      catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return; throw error; }
      throw new Error('Incus recovery cannot replace uncaptured or foreign compute');
    };
    if (applied && !original) await assertMissing();
    const info: ContainerInfo = structuredClone(snapshot);
    info.mounts = await this.resolveAuthorizedHostMounts(info.userId, info.id, info.mounts);
    info.hardwareDeviceIds = await this.resolveHardwareDeviceAccess(info.userId, info.id, info.hardwareDeviceIds);
    if (info.importedImage || info.hardwareDeviceIds?.length)
      throw new Error('Incus captured OCI images and hardware require their feature integration');
    await this.assertIncusPersistenceReady(info, !!original);
    const options = await this.incusOptionsForWorker(info, applied);
    const originalIncarnation = original?.containerId.startsWith('incus:') ? original.containerId.slice(6) : undefined;
    if (original) {
      if (!originalIncarnation) throw new Error('Incus rebuild requires a captured original incarnation');
      await this.incusRuntime.prepareArchive(info, originalIncarnation);
    }
    const existing = await this.incusRuntime.preflightRecreation(options, applied && options.dockerEnabled);
    if (applied && !original) await assertMissing();
    const marker = { nonce: randomUUID(), originalIncarnation,
      replacementIncarnation: undefined as string | undefined };
    // Persist stopped intent before any destructive operation. The bounded
    // marker also quarantines a lost create response across process restart.
    await this.workerStore.transitionIncusRecreation(info.userId, info.id,
      { status: record.status, desiredRuntimeStatus: 'stopped', incusRecreation: marker });
    try {
      if (original) {
        original.desiredRuntimeStatus = 'stopped';
        useLogCollector().detach(original.containerId);
        await this.incusRuntime.remove(info, originalIncarnation);
        original.status = 'error';
        await this.workerStore.archive(info.userId, info.id);
        this.containers.delete(info.id);
      }
    } catch (cause) {
      // Retain the original UUID/recovery marker. Do not clear a destructive
      // ambiguity merely because a response could not be persisted.
      if (original) original.status = 'error';
      throw cause;
    }
    info.containerId = info.containerName;
    info.status = 'creating';
    info.desiredRuntimeStatus = 'stopped';
    info.updatedAt = new Date().toISOString();
    try {
      await this.workerStore.unarchive(info.userId, info.id);
      this.containers.set(info.id, info);
      const instance = await this.incusRuntime.create({ ...options, start: false, recreationNonce: marker.nonce }, existing);
      const incarnation = instance.config['volatile.uuid'];
      if (!incarnation || instance.config['user.agentor.recreation'] !== marker.nonce ||
          !await this.incusRuntime.matchesWorkerIdentity(instance, info.id, info.userId))
        throw new Error('Incus replacement incarnation or operation identity is unavailable');
      info.containerId = `incus:${incarnation}`;
      marker.replacementIncarnation = incarnation;
      await this.workerStore.transitionIncusRecreation(info.userId, info.id,
        { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker });
      await this.incusRuntime.start({ ...options, recreationNonce: marker.nonce }, incarnation);
      await (await import('./managed-volume-manager')).useManagedVolumeManager().markDeclared(info.userId, info.id, info.containerId);
      if (!applied) await useWorkerConfigStore().markApplied(info.userId, info.id,
        this.appliedIncusBootstrap(options, info), options.configurationRevision);
      info.status = 'running';
      info.desiredRuntimeStatus = 'running';
      if (!applied) info.hostMountsRevoked = info.hardwareDevicesRevoked = false;
      info.runtimeDiagnostic = undefined;
      info.updatedAt = new Date().toISOString();
      const completed = await this.workerStore.transitionIncusRecreation(info.userId, info.id,
        { status: 'active', desiredRuntimeStatus: 'running', incusRecreation: undefined }, applied ? undefined : async () => {
          const desired = await useWorkerConfigStore().resolveDesiredRevision(info.userId, info.id);
          if (options.configurationRevision && JSON.stringify(desired.revision) !== JSON.stringify(options.configurationRevision)) return true;
          // Account/environment/group edits can also arrive during boot. Keys
          // and credentials intentionally delivered live are not this snapshot.
          try {
            const current = await this.incusOptionsForWorker(info, false);
            const signature = (value: IncusWorkerOptions) => JSON.stringify({
              bootstrap: this.appliedIncusBootstrap(value, info), workerConfig: value.workerConfig,
            });
            return signature(current) !== signature(options);
          } catch { return true; /* inability to read desired state must not claim it was applied */ }
        });
      // Applied recovery has no configuration authority. Include concurrent
      // desired metadata edits in memory without promoting them in the guest.
      Object.assign(info, completed, { status: 'running' });
    } catch (cause) {
      // Without a returned, verified incarnation, a 409 or lost response may
      // refer to preexisting compute. Never remove whatever owns the name.
      if (!marker.replacementIncarnation) {
        info.status = 'error'; this.containers.set(info.id, info);
        throw Object.assign(new Error('Incus recreation retained ambiguous compute; explicit recovery is required'),
          { code: 'WORKER_RECREATE_CONTAINER_RETAINED', cause });
      }
      try {
        await this.incusRuntime.remove(info, marker.replacementIncarnation);
        await this.workerStore.transitionIncusRecreation(info.userId, info.id,
          { status: 'archived', desiredRuntimeStatus: 'stopped', incusRecreation: undefined });
        this.containers.delete(info.id);
      } catch (removalError) {
        info.status = 'error'; this.containers.set(info.id, info);
        throw Object.assign(new Error('Incus recreation rollback retained recovery state and all volumes'),
          { code: 'WORKER_RECREATE_ROLLBACK_INCOMPLETE', cause, removalError });
      }
      throw cause;
    }
    useLogCollector().attach(info.containerName, info.containerId, 'worker', info.displayName).catch(() => {});
    await reassignWorkerMappings(info.containerName).catch((error) => useLogger().warn(`[container] Incus route refresh failed: ${error}`));
    await this.reconcileManagedNetworksForWorker(info);
    await this.reconcileWorkerPlugins(info);
    return info;
  }

  async deleteArchived(userId: string, id: string): Promise<void> {
    return withOwnerWorkerLifecycleMutation(userId, id, async () => {
      await this.assertOwnerExists(userId);
      return this.deleteArchivedUnlocked(userId, id);
    });
  }

  private async deleteArchivedUnlocked(
    userId: string,
    id: string,
  ): Promise<void> {
    if (!this.workerStore) throw new Error("WorkerStore not available");

    let worker = this.workerStore.get(userId, id);
    if (!worker || worker.status !== "archived") {
      throw new Error("Archived worker not found");
    }

    if (worker.incusRecreation) throw new Error('Interrupted Incus recreation must be resolved before deleting canonical data');
    if (worker.runtimeKind === 'incus-vm') {
      const { useManagedVolumeManager } = await import('./managed-volume-manager');
      const volumes = useManagedVolumeManager(); await volumes.init();
      volumes.assertLiveRecoveryResolved(userId, id);
    }

    // This is the commit point before the first destructive operation. A
    // partial failure must never leave an apparently safe, unarchivable record.
    await this.workerStore.markDeletionPending(userId, id);
    worker = this.workerStore.get(userId, id)!;

    // containerName is derived from the stable UUID `id`, not stored on the record.
    const containerName = this.buildContainerName(worker.id);

    const actions: Array<readonly [string, () => Promise<void>]> = [
      [
        "workspace tombstone",
        () =>
          recordWorkspaceTombstone({
            workerId: worker.id,
            userId: worker.userId,
            displayName: worker.displayName || worker.id,
            backend: this.storageManager?.mode ?? "volume",
            createdAt: worker.createdAt,
          }),
      ],
      ["mapping cleanup", () => cleanupWorkerMappings(containerName)],
      ...(worker.runtimeKind === "incus-vm" ? [["Incus core storage", () => this.incusRuntime.removeStorage({
        id: worker.id, userId: worker.userId, containerName,
      })] as const] : []),
      [
        "worker group memberships",
        async () => {
          const { removeDeletedWorkerFromGroups } = await import(
            "./worker-group-manager"
          );
          await removeDeletedWorkerFromGroups(worker.userId, worker.id);
        },
      ],
    ];
    if (this.storageManager && worker.runtimeKind !== "incus-vm") {
      actions.push(
        [
          "workspace",
          () =>
            this.storageManager!.removeWorkerWorkspace(
              worker.userId,
              worker.id,
              containerName,
            ),
        ],
        [
          "Docker data",
          () => this.storageManager!.removeWorkerDocker(containerName),
        ],
        [
          "agent data",
          () =>
            this.storageManager!.removeWorkerAgents(
              worker.userId,
              worker.id,
              containerName,
            ),
        ],
      );
    }
    if (worker.importedImage?.startsWith(IMPORT_IMAGE_PREFIX)) {
      actions.push([
        "imported image",
        () => this.dockerService.removeImage(worker.importedImage!),
      ]);
    }
    actions.push(
      [
        "persistent backup paths",
        async () => {
          const { usePersistentBackupPathManager } = await import("./services");
          const { useManagedVolumeManager } = await import("./managed-volume-manager");
          const volumes = useManagedVolumeManager();
          await volumes.workerDeleted(worker.userId, worker.id);
          if (worker.runtimeKind !== 'incus-vm')
            await usePersistentBackupPathManager().removeWorkerVolumes(worker.id, volumes.store.forWorker(worker.userId, worker.id).map((v) => v.dockerName));
        },
      ],
      [
        "import-created environment",
        () => this.cleanupImportCreatedEnvironment(worker.userId, worker.id),
      ],
      [
        "worker-local configuration",
        () => useWorkerConfigStore().remove(worker.userId, worker.id),
      ],
    );
    const failures = await collectWorkerCleanupFailures(actions);
    if (failures.length) {
      throw Object.assign(
        new Error(`Archived worker cleanup incomplete: ${failures.join(", ")}`),
        { code: "WORKER_DELETE_CLEANUP_INCOMPLETE", failures },
      );
    }
    await this.workerStore.delete(worker.userId, worker.id);
    this.importCreatedEnvironments.delete(worker.id);
  }

  /** Remove every ordinary runtime and archived worker for an auth user that no
   * longer exists. OrphanSweeper calls this while holding the owner lifecycle
   * fence; each worker fence is then acquired in the canonical owner→worker
   * order. Any cleanup failure aborts durable owner-store deletion so the next
   * sweep retains enough identity to retry. */
  async removeWorkersForDeletedOwner(userId: string): Promise<void> {
    const liveIds = this.list()
      .filter(
        (worker) =>
          worker.userId === userId && !worker.administrativeKind,
      )
      .map((worker) => worker.id);
    for (const id of liveIds) {
      await withWorkerLifecycleMutation(id, () => this.removeUnlocked(id));
    }

    for (const worker of this.workerStore?.listForUser(userId) ?? []) {
      if (liveIds.includes(worker.id)) continue;
      await withWorkerLifecycleMutation(worker.id, async () => {
        if (worker.status === "archived") {
          await this.deleteArchivedUnlocked(userId, worker.id);
          return;
        }
        // A crash or failed recreation can leave a durable active record whose
        // deterministic Docker container was not loaded into the live map.
        // Rehydrate a recovery handle so ordinary idempotent deletion removes
        // the container (if present), volumes, images and configuration.
        const containerName = this.buildContainerName(worker.id);
        this.containers.set(worker.id, {
          id: worker.id,
          runtimeKind: normalizeWorkerRuntimeKind(worker.runtimeKind),
          userId: worker.userId,
          createdAt: worker.createdAt,
          updatedAt: worker.updatedAt,
          containerId: containerName,
          containerName,
          displayName: worker.displayName,
          imageName: worker.imageRuntimeReference ||
            this.config.workerImagePrefix + this.config.workerImage,
          imageId: worker.imageDigest || "",
          status: "error",
          repos: worker.repos,
          mounts: worker.mounts,
          hardwareDeviceIds: worker.hardwareDeviceIds,
          initScript: worker.initScript,
          environmentId: worker.environmentId,
          excludedGlobalEnvVarKeys: worker.excludedGlobalEnvVarKeys ?? [],
          excludedGroupEnvVarKeys: worker.excludedGroupEnvVarKeys ?? [],
          workerSelfApiAccess: worker.workerSelfApiAccess,
          pendingRebuild: worker.pendingRebuild,
          hostMountsRevoked: worker.hostMountsRevoked,
          hardwareDevicesRevoked: worker.hardwareDevicesRevoked,
          importedImage: worker.importedImage,
          imageDefinitionId: worker.imageDefinitionId,
          imageVersion: worker.imageVersion,
          imageDigest: worker.imageDigest,
          imageRuntimeReference: worker.imageRuntimeReference,
        });
        await this.removeUnlocked(worker.id);
      });
    }
  }

  /** Roll a failed rebuild/unarchive back to a durable archived worker without
   * deleting persistent workspace, agent, DinD, image or configuration data.
   * If Docker cannot remove the replacement, retain both an in-memory and
   * durable active error handle for an explicit lifecycle retry. */
  private async rollbackFailedRecreation(
    info: ContainerInfo,
    containerId: string,
    cause: unknown,
  ): Promise<never> {
    try {
      await removeDockerContainerIdempotently(() =>
        this.dockerService.removeContainer(containerId),
      );
      useLogCollector().detach(containerId);
    } catch (removalError) {
      info.status = "error";
      info.updatedAt = new Date().toISOString();
      this.containers.set(info.id, info);
      let persistenceError: unknown;
      try {
        await this.workerStore?.upsert(this.containerInfoToWorkerRecord(info));
      } catch (error) {
        persistenceError = error;
      }
      throw Object.assign(
        new Error(`Worker recreation rollback retained container ${info.containerName}`),
        {
          code: "WORKER_RECREATE_CONTAINER_RETAINED",
          cause,
          removalError,
          ...(persistenceError ? { persistenceError } : {}),
        },
      );
    }

    try {
      const record = this.workerStore?.get(info.userId, info.id);
      if (record && record.status !== "archived") {
        await this.workerStore!.archive(info.userId, info.id);
      }
      this.containers.delete(info.id);
    } catch (persistenceError) {
      info.containerId = info.containerName;
      info.status = "error";
      info.updatedAt = new Date().toISOString();
      this.containers.set(info.id, info);
      throw Object.assign(
        new Error(`Worker recreation rollback could not persist archive ${info.containerName}`),
        {
          code: "WORKER_RECREATE_ROLLBACK_INCOMPLETE",
          cause,
          persistenceError,
        },
      );
    }
    throw cause;
  }

  // --- Worker export / import ---

  /** Resolve the image + replicated config a worker should run. For normal
   * workers (`importedImage` unset) returns `{}` so the standard image is used.
   * Imported workers fail closed if either their captured image or the approved
   * runtime contract cannot be resolved; silently booting an unrelated default
   * image would lose rootfs state while pretending recovery was faithful. */
  private async resolveImageOpts(
    importedImage?: string,
  ): Promise<{ image?: string; imageConfig?: ImageConfigOverride }> {
    if (!importedImage) return {};
    if (!(await this.dockerService.imageExists(importedImage))) {
      throw Object.assign(
        new Error(
          "The captured worker image is unavailable. Restore that image or explicitly choose a replacement before rebuilding or recovering this worker.",
        ),
        { statusCode: 409, code: "IMPORTED_WORKER_IMAGE_MISSING" },
      );
    }
    const standard = this.config.workerImagePrefix + this.config.workerImage;
    try {
      await this.dockerService.ensureImage(standard);
      const imageConfig = await this.dockerService.inspectImageConfig(standard);
      return { image: importedImage, imageConfig };
    } catch (err) {
      throw Object.assign(
        new Error(
          "The approved worker runtime contract could not be resolved for the captured image. Retry after image access is restored.",
        ),
        {
          statusCode: 503,
          code: "IMPORTED_WORKER_RUNTIME_CONFIG_UNAVAILABLE",
          cause: err,
        },
      );
    }
  }

  /** Stream a complete worker export bundle (manifest + workspace + agents, and
   * optionally a `docker export` of the container filesystem). The worker must
   * have a container (running or stopped). Returns a tar stream + filename. */
  async exportWorker(
    id: string,
    opts: {
      includeRootfs: boolean;
      includeManagedVolumes?: boolean;
      /** Backup-only selection controls. Omitted values preserve the legacy
       * complete portable export contract. */
      includeWorkspace?: boolean;
      includeAgents?: boolean;
      signal?: AbortSignal;
      onProgress?: (update: {
        phase: string;
        progress: number;
        bytesProcessed: number;
      }) => void | Promise<void>;
    },
  ): Promise<{ stream: Readable; filename: string }> {
    const archived = this.workerStore?.findById(id);
    const snapshot = this.containers.get(id) ?? (archived?.runtimeKind === 'incus-vm' && archived.status === 'archived' ? archived : undefined);
    if (!snapshot) throw new Error("Container not found");
    return withOwnerWorkerLifecycleMutation(snapshot.userId, id, async () => {
      if ((this.containers.get(id)?.userId ?? this.workerStore?.findById(id)?.userId) !== snapshot.userId)
        throw new Error('Worker export owner changed during admission');
      if (instanceSnapshotActive())
        throw Object.assign(
          new Error("Worker export is unavailable during instance backup or restore. Retry afterwards."),
          { statusCode: 409, code: "INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE" },
        );
      return this.exportWorkerWithLifecycleFenceHeld(id, opts);
    });
  }

  /** Internal integration seam for backup capture, whose caller holds the
   * owner -> worker lifecycle fence across base capture and any repacking. */
  async exportWorkerWithLifecycleFenceHeld(
    id: string,
    opts: {
      includeRootfs: boolean;
      includeManagedVolumes?: boolean;
      includeWorkspace?: boolean;
      includeAgents?: boolean;
      signal?: AbortSignal;
      onProgress?: (update: {
        phase: string;
        progress: number;
        bytesProcessed: number;
      }) => void | Promise<void>;
    },
  ): Promise<{ stream: Readable; filename: string }> {
    const archivedRecord = this.workerStore?.findById(id);
    const cached = this.containers.get(id);
    if (cached && archivedRecord && (cached.userId !== archivedRecord.userId || archivedRecord.status !== 'active' ||
        normalizeWorkerRuntimeKind(cached.runtimeKind) !== normalizeWorkerRuntimeKind(archivedRecord.runtimeKind)))
      throw Object.assign(new Error('Worker export cached and durable runtime authority disagree'), { statusCode: 409 });
    const archivedNative = !cached && archivedRecord?.runtimeKind === 'incus-vm' && archivedRecord.status === 'archived';
    const info = cached ?? (archivedNative ? {
      ...archivedRecord, containerName: this.buildContainerName(id), containerId: '', status: 'stopped',
      imageName: this.config.incusWorkerImage, imageId: archivedRecord.imageDigest ?? '',
    } as ContainerInfo : undefined);
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

    const native = info.runtimeKind === 'incus-vm';
    const captureStatus = info.status;
    const offlineNative = native && captureStatus === 'stopped';
    const nativeIncarnation = native && !archivedNative ? this.capturedIncusIncarnation(info) : undefined;
    const capturedHandle = info.containerId, capturedGeneration = workerLifecycleGeneration(id);
    const validateNativeCapture = async () => {
      const check = () => {
        const current = this.get(id), record = this.workerStore?.get(info.userId, id);
        if ((!archivedNative && (!current || current.containerId !== capturedHandle || current.userId !== info.userId ||
            current.status !== captureStatus)) || (archivedNative && current) ||
            !record || record.status !== (archivedNative ? 'archived' : 'active') ||
            record.runtimeKind !== 'incus-vm' || record.deletionPending || record.incusRecreation ||
            workerLifecycleGeneration(id) !== capturedGeneration || !isWorkerLifecycleMutationPending(id))
          throw new Error('Incus export canonical runtime authority changed');
      };
      check();
      const { useManagedVolumeManager } = await import('./managed-volume-manager');
      const managed = useManagedVolumeManager(); await managed.init();
      managed.assertLiveRecoveryResolved(info.userId, id);
      check();
    };
    if (native) {
      if (opts.includeRootfs) throw Object.assign(new Error('Incus root filesystem is disposable, not backup data'),
        { statusCode: 409, code: 'INCUS_DISPOSABLE_ROOTFS' });
      // Fence unresolved authority before creating staging files or opening
      // archive exec, not after canonical bytes were already captured.
      await validateNativeCapture();
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
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });

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
      const includeWorkspace = opts.includeWorkspace !== false;
      const includeAgents = opts.includeAgents !== false;
      let bytesProcessed = 0;
      const report = async (phase: string, progress: number) => {
        await opts.onProgress?.({ phase, progress, bytesProcessed });
      };
      // `services` imports ContainerManager, so load the plugin stores only
      // when an export needs its portable plugin snapshot. This avoids a
      // module-cycle binding while keeping the snapshot in the export path.
      const { usePluginDefinitionStore, usePluginInstallationStore } =
        await import("./services");
      const pluginConfiguration = snapshotWorkerPlugins(
        info.userId,
        info.id,
        usePluginDefinitionStore(),
        usePluginInstallationStore(),
      );
      const hasPlugins =
        pluginConfiguration.definitions.length > 0 ||
        pluginConfiguration.installations.length > 0;
      const { useManagedVolumeManager } = await import("./managed-volume-manager");
      const persistence = useManagedVolumeManager(); await persistence.init();
      const nativeExclusions = [...(info.mounts ?? []).map(mount => mount.target),
        ...persistence.store.forWorker(info.userId, id).filter(volume => volume.attached).map(volume => volume.target)];
      const offlineCapture = offlineNative ? await this.incusRuntime.captureOfflineCanonical(info, nativeIncarnation,
        validateNativeCapture, { exclusions: nativeExclusions, signal: opts.signal,
          ...(includeWorkspace ? { workspace: join(tmpDir, BUNDLE_FILES.workspace) } : {}),
          ...(includeAgents ? { agents: join(tmpDir, BUNDLE_FILES.agents) } : {}) }) : undefined;
      const portableCapture = opts.includeManagedVolumes === true
        ? await (await import("./portable-managed-volume-runtime"))
            .usePortableManagedVolumeRuntime()
            .captureWithLifecycleFenceHeld({
              userId: info.userId,
              workerId: info.id,
              state: archivedNative ? 'archived' : info.status,
              containerId: archivedNative ? undefined : info.containerId,
              outputPath: join(tmpDir, BUNDLE_FILES.managedVolumes),
              signal: opts.signal,
            })
        : undefined;
      if (portableCapture) bytesProcessed += portableCapture.bytes;
      const manifest: WorkerExportManifest = {
        version: portableCapture
          ? PORTABLE_MANAGED_VOLUME_EXPORT_VERSION
          : WORKER_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        runtime: native ? offlineCapture?.runtime ?? await this.incusRuntime.backupRuntime(info, nativeIncarnation)
          : { version: 1, kind: 'legacy-docker' },
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
          workerSelfApiAccess: info.workerSelfApiAccess ?? "inherit",
        },
        // Environment values can contain API keys and other credentials. The
        // portable definition retains non-secret behavior but never exports
        // those values; the importer recreates the environment with an empty
        // value set and the owner must re-enter any required configuration.
        environment: { ...env, envVars: "" },
        portMappings,
        domainMappings,
        contents: {
          rootfs: opts.includeRootfs,
          workspace: includeWorkspace,
          agents: includeAgents,
          ...(hasPlugins ? { plugins: true } : {}),
          reconstruction: true,
          ...(portableCapture ? { managedVolumes: true } : {}),
        },
        localPersistence: portableCapture?.localPersistence ??
          persistence.store.forWorker(info.userId, info.id).filter((v) => v.attached)
            .map((v) => ({ path: v.target, included: false })),
        ...(portableCapture ? { managedVolumes: portableCapture.entries } : {}),
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
      if (portableCapture)
        files.push({
          name: BUNDLE_FILES.managedVolumes,
          path: join(tmpDir, BUNDLE_FILES.managedVolumes),
        });
      if (hasPlugins) {
        const pluginPath = join(tmpDir, BUNDLE_FILES.plugins);
        bytesProcessed += await writePortablePluginConfiguration(
          pluginPath,
          pluginConfiguration,
        );
        files.push({ name: BUNDLE_FILES.plugins, path: pluginPath });
      }
      const catalog = useImageCatalogManager();
      await catalog.init();
      const definition = info.imageDefinitionId
        ? catalog.list(info.userId, false).find((item) => item.id === info.imageDefinitionId)
        : undefined;
      const reconstruction = snapshotWorkerReconstruction(info, definition);
      reconstruction.requiredSecretNames = manifest.missingSecrets ?? [];
      const reconstructionPath = join(tmpDir, BUNDLE_FILES.reconstruction);
      bytesProcessed += await writeWorkerReconstruction(reconstructionPath, reconstruction);
      files.push({ name: BUNDLE_FILES.reconstruction, path: reconstructionPath });

      if (includeWorkspace) {
        if (offlineCapture) bytesProcessed += offlineCapture.bytes.workspace;
        else {
          const wsSrc = native ? await this.incusRuntime.openCanonicalArchive(info, nativeIncarnation!,
            'workspace', validateNativeCapture, { exclusions: nativeExclusions, signal: opts.signal })
            : await this.dockerService.getArchive(info.containerId, EXPORT_WORKSPACE_PATH, opts.signal);
          bytesProcessed += await writeGzipFile(
            wsSrc,
            join(tmpDir, BUNDLE_FILES.workspace),
            opts.signal,
          );
        }
        files.push({
          name: BUNDLE_FILES.workspace,
          path: join(tmpDir, BUNDLE_FILES.workspace),
        });
      }
      await report("workspace", opts.includeRootfs ? 30 : 45);

      if (includeAgents) {
        if (offlineCapture) bytesProcessed += offlineCapture.bytes.agents;
        else {
          const agSrc = native ? await this.incusRuntime.openCanonicalArchive(info, nativeIncarnation!,
            'agents', validateNativeCapture, { exclusions: nativeExclusions, signal: opts.signal })
            : await this.dockerService.getArchive(info.containerId, EXPORT_AGENTS_PATH, opts.signal);
          bytesProcessed += native ? await writeGzipFile(agSrc, join(tmpDir, BUNDLE_FILES.agents), opts.signal)
            : await writeFilteredAgentsGz(
              agSrc,
              join(tmpDir, BUNDLE_FILES.agents),
              CREDENTIAL_EXCLUDE_SUFFIXES,
              SHARED_DATA_EXCLUDE_PREFIXES,
              opts.signal,
            );
        }
        files.push({
          name: BUNDLE_FILES.agents,
          path: join(tmpDir, BUNDLE_FILES.agents),
        });
      }
      await report("agent-data", opts.includeRootfs ? 55 : 85);

      if (opts.includeRootfs) {
        opts.signal?.throwIfAborted();
        const rootfsSrc = await this.dockerService.exportContainer(
          info.containerId,
          opts.signal,
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
      if (native) await validateNativeCapture();
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
   * recreates port/domain mappings. A captured rootfs is imported into a
   * per-worker image and fails closed if that cannot be done; callers may retry
   * or explicitly request replacement/workspace-only restore. */
  async importWorker(
    userId: string,
    bundlePath: string,
    opts: WorkerImportOptions = {},
  ): Promise<ContainerInfo & { missingSecrets?: string[] }> {
    // Portable bytes and request options can never establish runtime authority.
    return this.importWorkerWithOrigin(userId, bundlePath, opts, { kind: 'portable' });
  }

  /** Internal backup entry: only the BackupManager supplies persisted artifact
   * provenance after checking its exact ciphertext digest and decrypting it.
   * Recovery-key ownership alone does not authorize remote legacy compute. */
  async importWorkerFromBackup(
    userId: string,
    bundlePath: string,
    backup: { provenance?: 'local' | 'remote-adopted'; runtimePrincipal?: BackupRestoreRuntimePrincipal },
    opts: WorkerImportOptions = {},
  ): Promise<ContainerInfo & { missingSecrets?: string[] }> {
    if (!validBackupRestoreRuntimePrincipal(backup.runtimePrincipal))
      throw Object.assign(new Error('Invalid internal restore runtime principal'), { statusCode: 400 });
    return this.importWorkerWithOrigin(userId, bundlePath, opts,
      { kind: 'backup', provenance: backup.provenance },
      backup.runtimePrincipal ? structuredClone(backup.runtimePrincipal) : undefined);
  }

  private async importWorkerWithOrigin(
    userId: string,
    bundlePath: string,
    opts: WorkerImportOptions,
    origin: WorkerImportOrigin,
    runtimePrincipal?: BackupRestoreRuntimePrincipal,
  ): Promise<ContainerInfo & { missingSecrets?: string[] }> {
    if (!userId) throw new Error("import: userId is required");
    // Environment recreation is visible owner-wide. Share the owner mutation
    // fence with ordinary worker creation/settings and orphan cleanup so the
    // reference check plus any rollback deletion is atomic for that owner.
    return withOwnerLifecycleMutation(userId, async () => {
      await this.assertOwnerExists(userId);
      return (await import("./portable-managed-volume-runtime"))
        .usePortableManagedVolumeRuntime()
        .withInstanceSnapshotAccounting(() =>
          this.importWorkerForOwner(userId, bundlePath, opts, origin, runtimePrincipal),
        );
    });
  }

  private async importWorkerForOwner(
    userId: string,
    bundlePath: string,
    opts: WorkerImportOptions,
    origin: WorkerImportOrigin,
    runtimePrincipal?: BackupRestoreRuntimePrincipal,
  ): Promise<ContainerInfo & { missingSecrets?: string[] }> {
    const workDir = join(this.config.dataDir, "tmp", `import-${randomUUID()}`);
    let createdImportEnvironmentId: string | undefined;
    let provisionalWorkerId: string | undefined;
    try {
      const {
        manifest,
        rootfsPath,
        rootfsCompressed,
        workspacePath,
        agentsPath,
        backupPathsPath,
        pluginConfigurationPath,
        reconstructionPath,
        managedVolumesPath,
      } = await extractBundle(bundlePath, workDir);
      if (!manifest || typeof manifest.version !== "number") {
        throw new Error("Invalid worker export bundle");
      }
      const assertRuntimePrincipal = () => assertBackupRestoreRuntimePrincipal(runtimePrincipal);
      // Resolve after the owner fence, not from a boolean captured before it.
      await assertRuntimePrincipal();
      const runtimeKind = selectWorkerImportRuntime({
        runtime: manifest.runtime, incusEnabled: this.config.incusEnabled === true,
        origin: origin.kind === 'backup' && runtimePrincipal ? { ...origin, adminLegacyAuthorized: true } : origin,
        capturedRootfs: Boolean(rootfsPath && manifest.contents?.rootfs),
        ignoreCapturedRootfs: opts.imageResolution?.mode === 'replacement' ? 'replacement-image'
          : opts.imageResolution?.mode === 'workspace-only' ? 'workspace-only' : undefined,
      });

      // Native GNU/PAX bytes are validated without tar-stream repacking: binary
      // xattrs and ACLs must survive the inverse canonical extraction unchanged.
      const canonicalPayloads: { workspace?: string; agents?: string } = {};
      const nativePayloadDir = join(workDir, 'native-canonical');
      if (runtimeKind === 'incus-vm') await mkdir(nativePayloadDir, { mode: 0o700 });
      for (const [role, payload] of [['workspace', workspacePath], ['agents', agentsPath]] as const) {
        if (!payload) continue;
        if (runtimeKind === 'incus-vm') canonicalPayloads[role] = (await prepareIncusCanonicalRestorePayload(
          payload, role, nativePayloadDir)).archivePath;
        else await validateGzipTarPayload(payload);
      }
      const extractedAdditionalPaths = backupPathsPath && manifest.backupPaths
        ? runtimeKind === 'incus-vm'
          ? await (await import('./portable-managed-volume-archive')).extractIncusSelectedRestorePayload(
            backupPathsPath, manifest.backupPaths, join(workDir, 'backup-paths'))
          : await extractBackupPathArchives(backupPathsPath, join(workDir, "backup-paths"), manifest.backupPaths)
        : [];
      // Backup artifacts may predate capture-side sanitization or originate
      // outside this orchestrator. Repack again before Docker extracts them.
      const additionalPaths = [] as typeof extractedAdditionalPaths;
      for (const [index, item] of extractedAdditionalPaths.entries()) {
        if (runtimeKind === 'incus-vm') { additionalPaths.push(item); continue; }
        const sanitized = join(workDir, "backup-paths", `${index}.safe.tar`);
        await sanitizeBackupPathTarPayload(item.archivePath, sanitized, item.path);
        additionalPaths.push({ ...item, archivePath: sanitized });
      }
      const pluginConfiguration = pluginConfigurationPath
        ? await readPortablePluginConfiguration(pluginConfigurationPath)
        : undefined;
      const reconstruction = reconstructionPath
        ? await readWorkerReconstruction(reconstructionPath)
        : undefined;
      if (rootfsPath)
        await (rootfsCompressed
          ? validateGzipTarPayload(rootfsPath)
          : validateTarPayload(rootfsPath));

      const id = randomUUID();
      provisionalWorkerId = id;
      let mounts =
        (await this.resolveAuthorizedHostMounts(
          userId,
          id,
          manifest.worker?.mounts,
        )) ?? [];
      let nativeManagedPayloads: Array<{ entry: PortableManagedVolumeEntry; archivePath: string }> = [];
      if (managedVolumesPath && manifest.managedVolumes) {
        const [{ validateAndExtractPortableManagedVolumePayload }, {
          planPortableManagedVolumeImport,
        }, {
          portableManagedVolumeImportConflicts,
        }] = await Promise.all([
          import("./portable-managed-volume-archive"),
          import("./portable-managed-volume-plan"),
          import("./portable-managed-volume-runtime"),
        ]);
        // Nested tar validation and every static overlap check happen before
        // importing an image, creating an environment, or journaling resources.
        const managedVolumePreflightDir = join(workDir, "managed-volumes-preflight");
        try {
          const extracted = await validateAndExtractPortableManagedVolumePayload(
            managedVolumesPath,
            manifest.managedVolumes,
            managedVolumePreflightDir,
            runtimeKind === 'incus-vm' ? { requirePosixUstar: true } : {},
          );
          if (runtimeKind === 'incus-vm') nativeManagedPayloads = extracted;
        } finally {
          // Legacy journals perform their own extraction. Native restore uses
          // these unchanged strict bytes directly; never stage a second copy.
          if (runtimeKind !== 'incus-vm')
            await rm(managedVolumePreflightDir, { recursive: true, force: true }).catch(() => {});
        }
        planPortableManagedVolumeImport({
          operationId: randomUUID(),
          userId,
          workerId: id,
          entries: manifest.managedVolumes,
          conflicts: portableManagedVolumeImportConflicts({
            hostGrantPaths: mounts.map((mount) => mount.target),
            destinationMountPaths: mounts.map((mount) => mount.target),
            selectedBackupPaths: manifest.backupPaths?.map(({ path }) => path),
          }),
        });
        if (runtimeKind === 'incus-vm' && manifest.managedVolumes.some(entry => pathsOverlap(entry.target, '/restore')))
          throw new Error('Managed restore targets overlap the isolated restore layout');
      }

      if (runtimeKind === 'incus-vm') (await import('./incus-selected-restore')).planIncusSelectedRestore(
        additionalPaths.map(item => item.path), { accountShares: !!this.storageManager,
          hostTargets: mounts.map(item => item.target), managedTargets: nativeManagedPayloads.map(item => item.entry.target) });

      const reconstructionResolution = await resolveWorkerReconstruction(userId, reconstruction);
      // An explicitly captured rootfs is itself the image dependency. Keep
      // existing full-export portability without requiring a matching catalog,
      // while replacement/workspace-only modes deliberately ignore it.
      const useCapturedRootfs = Boolean(
        rootfsPath && manifest.contents?.rootfs && !opts.imageResolution,
      );
      const resolvedImage = useCapturedRootfs
        ? {}
        : await resolveImportedImage(
            userId,
            reconstructionResolution,
            opts.imageResolution,
          );
      if (runtimeKind === 'legacy-docker' && resolvedImage.imageRuntimeReference)
        await this.dockerService.ensureImage(
          resolvedImage.imageRuntimeReference,
        );

      const environment = await this.resolveImportEnvironment(
        userId,
        manifest.environment,
        runtimeKind === 'incus-vm',
      );
      const environmentId = environment.id;
      if (environment.created) createdImportEnvironmentId = environment.id;

      if (createdImportEnvironmentId) {
        this.importCreatedEnvironments.set(id, createdImportEnvironmentId);
      }
      // Once the provisional identity becomes externally visible, use the
      // same per-worker lifecycle queue as DELETE/archive/rebuild. A deletion
      // that arrives during import must run after import settles and must never
      // be followed by the import resurrecting the worker.
      return await withWorkerLifecycleMutation(id, async () => {
      const displayName = (
        opts.displayName?.trim() ||
        manifest.worker?.displayName ||
        "imported worker"
      ).slice(0, 100);
      const containerName = this.buildContainerName(id);
      const repos = (manifest.worker?.repos ?? []).filter((r) => r.url);
      const initScript = manifest.worker?.initScript || "";
      const workerSelfApiAccess = manifest.worker?.workerSelfApiAccess;

      const envConfig = this.resolveEnvironmentConfig(environmentId);
      const { cpuLimit, memoryLimit, dockerEnabled } =
        this.deriveLimits(envConfig);
      const { gitName, gitEmail } = await this.resolveGitIdentity(userId);
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

      if (runtimeKind === 'incus-vm') {
        const now = new Date().toISOString();
        return this.importNativeCanonicalWorker({
          id, userId, runtimeKind, createdAt: now, updatedAt: now,
          containerId: containerName, containerName, displayName,
          imageName: resolvedImage.imageRuntimeReference || this.config.incusWorkerImage,
          imageId: '', status: 'creating', desiredRuntimeStatus: 'stopped', environmentId,
          repos: repos.length ? repos : undefined, mounts: mounts.length ? mounts : undefined,
          initScript: initScript || undefined, workerSelfApiAccess, pendingRebuild: false, ...resolvedImage,
        }, canonicalPayloads, manifest, pluginConfiguration, opts.imageResolution, assertRuntimePrincipal, nativeManagedPayloads, additionalPaths);
      }

      // Import the captured rootfs into a per-worker image. This is the exact
      // state the caller explicitly requested, so import failure is surfaced
      // instead of silently creating a different standard-image worker.
      let importedImage: string | undefined;
      let imageConfig: ImageConfigOverride | undefined;
      if (useCapturedRootfs && rootfsPath) {
        await assertRuntimePrincipal();
        const repo = `${IMPORT_IMAGE_PREFIX}${id}`;
        const candidateImage = `${repo}:latest`;
        try {
          importedImage = await this.dockerService.importImage(
            createReadStream(rootfsPath),
            repo,
            "latest",
          );
        } catch (err) {
          // Docker can create the tagged image before its progress stream
          // reports a later error. Remove the deterministic candidate even
          // when importImage rejected before returning its reference.
          await removeFailedImportedImage(candidateImage, () =>
            this.dockerService.removeImage(candidateImage),
          );
          throw Object.assign(
            new Error(
              "The captured worker root filesystem could not be imported. Retry, recover the referenced image, select a replacement image, or explicitly restore workspace-only.",
            ),
            {
              statusCode: 409,
              code: "CAPTURED_IMAGE_IMPORT_FAILED",
              cause: err,
            },
          );
        }
        try {
          const standard =
            this.config.workerImagePrefix + this.config.workerImage;
          await this.dockerService.ensureImage(standard);
          imageConfig = await this.dockerService.inspectImageConfig(standard);
        } catch (err) {
          // Import succeeded, but docker-imported filesystems do not carry an
          // entrypoint/user/environment. Do not misreport a runtime-contract
          // lookup failure as a corrupt rootfs, and do not retain an orphaned
          // image for a worker identity that was never made durable.
          await removeFailedImportedImage(candidateImage, () =>
            this.dockerService.removeImage(candidateImage),
          );
          throw Object.assign(
            new Error(
              "The captured filesystem was imported, but the approved Agentor worker runtime contract could not be resolved. Retry after image access is restored.",
            ),
            {
              statusCode: 503,
              code: "CAPTURED_IMAGE_RUNTIME_CONFIG_UNAVAILABLE",
              cause: err,
            },
          );
        }
      }

      // Register the deterministic identity before asking Docker to create the
      // container. If creation/start/restore fails and Docker cannot confirm
      // removal, this provisional entry is the authoritative handle that lets
      // the owner retry deletion by stable worker UUID instead of leaving only
      // an operator-facing Docker name behind.
      const imageName = importedImage || resolvedImage.imageRuntimeReference || this.config.workerImagePrefix + this.config.workerImage;
      let portableImport: PreparedPortableManagedVolumeImport | undefined;
      if (managedVolumesPath && manifest.managedVolumes) {
        try {
          const portableRuntime = (await import("./portable-managed-volume-runtime"))
            .usePortableManagedVolumeRuntime();
          portableImport = await portableRuntime.prepareImportWithLifecycleFenceHeld({
            userId,
            workerId: id,
            entries: manifest.managedVolumes,
            payloadPath: managedVolumesPath,
            stagingDir: join(workDir, "managed-volumes-restore"),
            conflicts: (await import("./portable-managed-volume-runtime"))
              .portableManagedVolumeImportConflicts({
                hostGrantPaths: mounts.map((mount) => mount.target),
                destinationMountPaths: mounts.map((mount) => mount.target),
                selectedBackupPaths: manifest.backupPaths?.map(({ path }) => path),
              }),
            image: imageName,
          });
        } catch (error) {
          if (importedImage)
            await removeFailedImportedImage(importedImage, () =>
              this.dockerService.removeImage(importedImage!),
            );
          throw error;
        }
      }
      const rollbackProvisionedImport = async (
        input: Parameters<ContainerManager["rollbackFailedProvisionedWorker"]>[0],
        workerCreateWasJournaled: boolean,
      ) => {
        if (portableImport) {
          if (workerCreateWasJournaled)
            return portableImport.rollback(() => this.rollbackFailedProvisionedWorker(input));
          await portableImport.rollback(async () => {});
        }
        await this.rollbackFailedProvisionedWorker(input);
      };
      const now = new Date().toISOString();
      const containerInfo: ContainerInfo = {
        id,
        runtimeKind,
        userId,
        createdAt: now,
        updatedAt: now,
        containerId: containerName,
        containerName,
        displayName,
        imageName,
        imageId: "",
        status: "creating",
        desiredRuntimeStatus: "running",
        repos: repos.length > 0 ? repos : undefined,
        mounts: mounts.length > 0 ? mounts : undefined,
        initScript: initScript || undefined,
        workerSelfApiAccess,
        environmentId,
        pendingRebuild: false,
        ...(importedImage ? { importedImage } : {}),
        ...(!importedImage ? resolvedImage : {}),
      };
      this.containers.set(id, containerInfo);

      // Persist the provisional identity before the first container mutation.
      // If the orchestrator restarts after an ambiguous Docker failure, sync()
      // can still resolve the container label to its owner; if Docker never
      // created it, startup reconciliation archives the record for retryable
      // cleanup through the normal archived-worker path.
      try {
        if (this.workerStore) {
          await this.workerStore.upsert(
            this.containerInfoToWorkerRecord(containerInfo),
          );
        }
      } catch (err) {
        await rollbackProvisionedImport({
          id,
          userId,
          containerId: containerName,
          containerName,
          dockerEnabled,
          importedImage,
        }, false);
        throw err;
      }

      // Create the container stopped so volumes can be populated before the
      // entrypoint runs, then restore the volume tars, then start.
      let container: Awaited<ReturnType<DockerService["createWorkerContainer"]>>;
      let restoredPlugins:
        | Awaited<ReturnType<typeof restoreWorkerPlugins>>
        | undefined;
      try {
        // Import may spend substantial time validating and recovering an
        // image before Docker creates the worker. Recheck the live grant only
        // after the provisional identity is durable, closing that revocation
        // window without ever trusting the source stored in the archive.
        mounts =
          (await this.resolveAuthorizedHostMounts(userId, id, mounts)) ?? [];
        containerInfo.mounts = mounts.length > 0 ? mounts : undefined;
        // Image/environment preparation can take minutes; an admitted grant
        // must still be current at the actual legacy compute boundary.
        await assertRuntimePrincipal();
        await portableImport?.markWorkerCreatePending();
        container = await this.dockerService.createWorkerContainer({
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
          persistentPathMounts: portableImport?.mounts,
          ...(portableImport?.mounts.length
            ? {
                portableImportIdentity: {
                  ownerId: userId,
                  workerId: id,
                  operationId: portableImport.operationId,
                },
              }
            : {}),
          image: importedImage || resolvedImage.imageRuntimeReference,
          imageConfig,
          restoreRuntimePrincipal: runtimePrincipal,
          start: false,
        });
        await portableImport?.confirmWorkerCreated(container.id);
        containerInfo.containerId = container.id;
        containerInfo.imageId = await this.dockerService.inspectContainerImage(
          container.id,
        );
      } catch (err) {
        const settlement = (err as OperationFailureWithSettlement)[operationSettlement];
        if (settlement) await settlement;
        // createWorkerContainer may already have created persistent storage
        // before image/container creation fails. The deterministic container
        // name is also a valid Docker removal target if creation got that far.
        await rollbackProvisionedImport({
          id,
          userId,
          containerId: containerName,
          containerName,
          dockerEnabled,
          importedImage,
        }, Boolean(portableImport));
        throw err;
      }

      if (portableImport) {
        try {
          await (await import("./managed-volume-manager"))
            .useManagedVolumeManager()
            .markDeclared(userId, id, container.id);
        } catch (err) {
          await rollbackProvisionedImport({
            id, userId, containerId: container.id, containerName,
            dockerEnabled, importedImage,
          }, true);
          throw err;
        }
      }

      // Restore the volumes and start. If anything here fails, roll back the
      // container and every resource it created.
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
        // The payload is created only from explicit operator selections. Each
        // member is a Docker archive of one absolute path, restored under its
        // recorded parent after schema + tar validation. This is deliberately
        // additive: legacy bundles have no additionalPaths at all.
        for (const item of additionalPaths) {
          const parent = item.path === "/" ? "/" : item.path.slice(0, item.path.lastIndexOf("/")) || "/";
          await this.dockerService.putArchive(container.id, createReadStream(item.archivePath), parent);
        }
        await assertRuntimePrincipal();
        await this.dockerService.startContainer(container.id);
        await this.dockerService.materializeWorkerSecretFiles(
          container.id,
          workerConfig,
        );
        containerInfo.status = "running";
        containerInfo.updatedAt = new Date().toISOString();
      } catch (err) {
        await rollbackProvisionedImport({
          id,
          userId,
          containerId: container.id,
          containerName,
          dockerEnabled,
          importedImage,
        }, Boolean(portableImport));
        throw err;
      }

      // A record write can fail after the container has started and entered the
      // in-memory map. Roll it back just like a volume-restore failure so the
      // caller never loses the only handle to a live imported worker.
      try {
        await useWorkerConfigStore().markApplied(userId, id);
        if (this.workerStore) {
          await this.workerStore.upsert(
            this.containerInfoToWorkerRecord(containerInfo),
          );
        }
        await this.recreateImportedMappings(userId, id, containerName, manifest);
        if (pluginConfiguration) {
          const {
            usePluginDefinitionStore,
            usePluginInstallationStore,
            usePluginRuntimeManager,
          } = await import("./services");
          restoredPlugins = await restoreWorkerPlugins(
            pluginConfiguration,
            userId,
            id,
            usePluginDefinitionStore(),
            usePluginInstallationStore(),
          );
          // Reconciliation records individual lifecycle failures as observed
          // plugin state. Missing restored secret values therefore never make
          // an otherwise valid worker import fail or leak a value.
          await usePluginRuntimeManager().reconcileWorker(
            userId,
            id,
            container.id,
          );
        }
        await portableImport?.commit();
      } catch (err) {
        let pluginCleanupError: unknown;
        if (restoredPlugins) {
          const { usePluginDefinitionStore, usePluginInstallationStore } =
            await import("./services");
          try {
            await rollbackRestoredWorkerPlugins(
              userId,
              id,
              restoredPlugins,
              usePluginDefinitionStore(),
              usePluginInstallationStore(),
            );
          } catch (cleanupError) {
            pluginCleanupError = cleanupError;
          }
        }
        try {
          await rollbackProvisionedImport({
            id,
            userId,
            containerId: container.id,
            containerName,
            dockerEnabled,
            importedImage,
          }, Boolean(portableImport));
        } finally {
          if (pluginCleanupError)
            throw new Error("Imported plugin cleanup requires operator attention", {
              cause: pluginCleanupError,
            });
        }
        throw err;
      }

      useLogCollector()
        .attach(containerName, container.id, "worker", displayName)
        .catch(() => {});
      useLogger().info(
        `[container] imported worker ${containerName} (${container.id.slice(0, 12)})${importedImage ? " with captured rootfs" : ""}`,
      );

      return {
        ...containerInfo,
        ...((manifest.missingSecrets?.length || pluginConfiguration?.installations.some((item) => item.secretKeys.length))
          ? { missingSecrets: [...new Set([
              ...(manifest.missingSecrets ?? []),
              ...(pluginConfiguration?.installations.flatMap((item) => item.secretKeys) ?? []),
            ])].sort() }
          : {}),
      };
      });
    } catch (error) {
      const rollbackDebtRetainsEnvironment =
        importRollbackRetainsEnvironment(error);
      const rollbackRetainsEnvironment =
        rollbackDebtRetainsEnvironment ||
        (!!createdImportEnvironmentId &&
          this.importEnvironmentIsReferenced(
            userId,
            createdImportEnvironmentId,
          ));
      const environmentStore = this.environmentStore;
      if (createdImportEnvironmentId && environmentStore) {
        try {
          await rollbackCreatedImportEnvironment(
            createdImportEnvironmentId,
            rollbackRetainsEnvironment,
            (environmentId) => environmentStore.delete(environmentId),
          );
          if (!rollbackDebtRetainsEnvironment && provisionalWorkerId) {
            this.importCreatedEnvironments.delete(provisionalWorkerId);
          }
        } catch (cleanupError) {
          useLogger().error(
            `[container] import environment rollback incomplete for ${createdImportEnvironmentId}: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
          );
          throw Object.assign(
            new Error(
              `Imported environment cleanup requires operator attention: ${createdImportEnvironmentId}`,
            ),
            { cause: cleanupError },
          );
        }
      }
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Fresh canonical imports share ordinary owner/worker lifecycle admission.
   * No archived instance identity or runtime authority comes from the bundle.
   * The existing initial-create marker fences partial bytes through health. */
  private async importNativeCanonicalWorker(
    info: ContainerInfo,
    payloads: { workspace?: string; agents?: string },
    manifest: WorkerExportManifest,
    plugins: Awaited<ReturnType<typeof readPortablePluginConfiguration>> | undefined,
    imageResolution: WorkerImportOptions['imageResolution'],
    assertPrincipal: () => Promise<void>,
    managedPayloads: Array<{ entry: PortableManagedVolumeEntry; archivePath: string }> = [],
    selectedPayloads: Array<{ path: string; archivePath: string }> = [],
  ): Promise<ContainerInfo & { missingSecrets?: string[] }> {
    if (!this.workerStore) throw new Error('WorkerStore is required for native worker import');
    const { id, userId, containerName } = info;
    const marker: NonNullable<WorkerRecord['incusRecreation']> = {
      nonce: randomUUID(), initialCreate: true, importIncomplete: true,
    };
    const proof = { attempted: false, nonce: marker.nonce, incarnation: undefined as string | undefined };
    let restoredPlugins: Awaited<ReturnType<typeof restoreWorkerPlugins>> | undefined;
    let managedStore: ManagedVolumeStore | undefined;
    let managedRecords: StoredManagedVolume[] = [];
    this.containers.set(id, info);
    const validate = async () => {
      await assertPrincipal();
      const current = this.workerStore!.get(userId, id), recovery = current?.incusRecreation;
      if (!current || current.runtimeKind !== 'incus-vm' || current.status !== 'active' ||
          current.deletionPending || current.hostMountsRevoked || current.hardwareDevicesRevoked ||
          recovery?.nonce !== marker.nonce || recovery.initialCreate !== true || recovery.importIncomplete !== true ||
          recovery.originalIncarnation !== undefined || recovery.replacementIncarnation !== proof.incarnation ||
          this.containers.get(id) !== info)
        throw new Error('Native import identity or initial recovery authority changed');
      if (managedStore && !isDeepStrictEqual(
        managedStore.forWorker(userId, id).sort((a, b) => a.id.localeCompare(b.id)),
        [...managedRecords].sort((a, b) => a.id.localeCompare(b.id))))
        throw new Error('Native import managed storage records changed; all destination data was retained');
    };
    try {
      // This durable marker predates image resolution/storage allocation/native
      // create. Restart recovery must never boot a partially extracted import.
      await this.workerStore.upsert({ ...this.containerInfoToWorkerRecord(info), incusRecreation: marker });
      await validate();
      info.mounts = await this.resolveAuthorizedHostMounts(userId, id, info.mounts);
      const options: IncusWorkerOptions = {
        ...await this.incusOptionsForWorker(info, false), start: false, recreationNonce: marker.nonce,
      };
      await validate();
      if (managedPayloads.length) {
        // Resolve normal options before publishing pending records: ordinary
        // mounts reject unseeded data, rather than silently seeding an import.
        const volumes = (await import('./managed-volume-manager')).useManagedVolumeManager();
        await volumes.init(); managedStore = volumes.store;
        await validate();
        for (const { entry } of managedPayloads) {
          await validate();
          const record = await managedStore.create(userId, id, entry.target, entry.name, 'incus-vm');
          managedRecords.push(structuredClone(managedStore.get(userId, record.id)!));
          await validate();
        }
        options.managedVolumes = structuredClone(managedRecords);
      }
      proof.attempted = true;
      const instance = await this.incusRuntime.createCanonicalRestore(options,
        !imageResolution && manifest.runtime?.kind === 'incus-vm' ? manifest.runtime.source : undefined);
      const incarnation = instance.config['volatile.uuid'];
      if (!incarnation || instance.config['user.agentor.recreation'] !== marker.nonce ||
          !await this.incusRuntime.matchesWorkerIdentity(instance, id, userId))
        throw new Error('Native import incarnation or operation identity is unavailable');
      // Capture before the next fallible record write so exact rollback remains
      // possible even when durable UUID publication itself fails.
      proof.incarnation = incarnation;
      info.containerId = `incus:${incarnation}`;
      info.imageId = instance.config['volatile.base_image'] ?? '';
      marker.replacementIncarnation = incarnation;
      await this.workerStore.transitionIncusRecreation(userId, id,
        { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker }, undefined,
        { nonce: marker.nonce, initialCreate: true, importIncomplete: true });
      await validate();
      await this.incusRuntime.restoreCanonicalArchives(options, incarnation, payloads, validate, undefined,
        managedPayloads.map((item, index) => ({ volume: options.managedVolumes![index]!, archivePath: item.archivePath })), selectedPayloads);
      await validate();
      // Publish only after ALL byte streams and final native proofs succeeded.
      // Partial publication remains behind the worker's durable import fence.
      for (let index = 0; index < managedRecords.length; index++) {
        await validate();
        const record = managedRecords[index]!;
        await managedStore!.save({ ...record, seeded: true, state: 'ready' });
        managedRecords[index] = structuredClone(managedStore!.get(userId, record.id)!);
        await validate();
      }
      if (managedRecords.length) options.managedVolumes = structuredClone(managedRecords);
      await this.incusRuntime.finishCanonicalRestore(options, incarnation, validate);
      await validate();
      await useWorkerConfigStore().markApplied(userId, id, this.appliedIncusBootstrap(options, info), options.configurationRevision);
      await this.recreateImportedMappings(userId, id, containerName, manifest);
      if (plugins) {
        const { usePluginDefinitionStore, usePluginInstallationStore } = await import('./services');
        restoredPlugins = await restoreWorkerPlugins(plugins, userId, id,
          usePluginDefinitionStore(), usePluginInstallationStore());
      }
      await validate();
      const resolved = await this.workerStore.transitionIncusRecreation(userId, id,
        { status: 'active', desiredRuntimeStatus: 'running', incusRecreation: undefined }, undefined, marker);
      Object.assign(info, resolved, { status: 'running', updatedAt: new Date().toISOString() });
    } catch (error) {
      let pluginCleanupError: unknown;
      if (restoredPlugins) {
        const { usePluginDefinitionStore, usePluginInstallationStore } = await import('./services');
        try { await rollbackRestoredWorkerPlugins(userId, id, restoredPlugins,
          usePluginDefinitionStore(), usePluginInstallationStore()); }
        catch (cleanupError) { pluginCleanupError = cleanupError; }
      }
      await this.rollbackFailedProvisionedWorker({ id, userId, containerId: info.containerId,
        containerName, dockerEnabled: this.resolveEnvironmentConfig(info.environmentId).dockerEnabled ?? true,
        incusCreation: proof });
      if (pluginCleanupError) throw new Error('Imported plugin cleanup requires operator attention', { cause: pluginCleanupError });
      throw error;
    }
    // Runtime authority is settled before plugin execution/normal routing.
    // Deferred plugin lifecycle failures are recorded by its existing manager,
    // not interpreted as permission to roll back completed canonical data.
    await this.reconcileManagedNetworksForWorker(info);
    if (plugins) {
      const { usePluginRuntimeManager } = await import('./services');
      await usePluginRuntimeManager().reconcileWorker(userId, id, info.containerId).catch(error => {
        useLogger().warn(`[container] imported native plugin reconciliation deferred: ${(error as Error).message}`);
      });
    }
    useLogCollector().attach(containerName, info.containerId, 'worker', info.displayName).catch(() => {});
    const missingSecrets = [...new Set([...(manifest.missingSecrets ?? []),
      ...(plugins?.installations.flatMap(item => item.secretKeys) ?? [])])].sort();
    return { ...info, ...(missingSecrets.length ? { missingSecrets } : {}) };
  }

  /** A recreated import environment stops being exclusively owned by the
   * failing import as soon as any durable or live worker references it. Keep it
   * in that case: deleting it would make a later rebuild silently fall back to
   * the default (potentially less restrictive) network policy. */
  private importEnvironmentIsReferenced(
    userId: string,
    environmentId: string,
    exceptWorkerId?: string,
  ): boolean {
    return importEnvironmentReferenced(
      userId,
      environmentId,
      this.containers.values(),
      this.workerStore?.listForUser(userId) ?? [],
      exceptWorkerId,
    );
  }

  /** Delete an import-created environment only when the provisional worker is
   * its final reference. The caller holds the owner lifecycle fence, so no
   * create/settings request can adopt it between this check and deletion. */
  private async cleanupImportCreatedEnvironment(
    userId: string,
    workerId: string,
  ): Promise<void> {
    const environmentId =
      this.importCreatedEnvironments.get(workerId) ??
      this.workerStore?.get(userId, workerId)?.importCreatedEnvironmentId;
    if (!environmentId) return;
    if (
      !this.importEnvironmentIsReferenced(userId, environmentId, workerId) &&
      this.environmentStore
    ) {
      // A previous cleanup attempt may already have removed it before a later
      // independent action failed. Absence is the desired state, so retries
      // must not wedge a deletion-pending worker forever.
      await removeImportEnvironmentIdempotently(
        environmentId,
        (id) => Boolean(this.environmentStore?.getById(id)),
        (id) => this.environmentStore!.delete(id),
      );
    }
    this.importCreatedEnvironments.delete(workerId);
  }

  /** Best-effort rollback for every mutation made after import container
   * creation. Keep this separate from the public remove() path: the worker may
   * not have persisted successfully, yet its container and volumes already
   * exist and must not survive as an untracked orphan. */
  private async rollbackFailedProvisionedWorker(input: {
    id: string;
    userId: string;
    containerId: string;
    containerName: string;
    dockerEnabled: boolean;
    importedImage?: string;
    incusCreation?: { attempted: boolean; nonce?: string; incarnation?: string };
  }): Promise<void> {
    const { id, userId, containerId, containerName, dockerEnabled, importedImage } =
      input;
    const incus = this.containers.get(id)?.runtimeKind === "incus-vm" ||
      this.workerStore?.get(userId, id)?.runtimeKind === "incus-vm";
    if (incus) {
      const proof = input.incusCreation;
      const marker = this.workerStore?.get(userId, id)?.incusRecreation;
      if (proof?.attempted === false) {
        if (marker?.importIncomplete) {
          if (!proof.nonce || proof.nonce !== marker.nonce || marker.replacementIncarnation)
            throw Object.assign(new Error('Incomplete import no-create proof does not match retained recovery authority'),
              { code: 'WORKER_CREATE_CONTAINER_RETAINED' });
          // Partial restore data is not a bootable archived worker. Keep all
          // canonical state/config for the existing explicit deletion path.
          await this.workerStore!.transitionIncusRecreation(userId, id,
            { status: 'archived', desiredRuntimeStatus: 'stopped', incusRecreation: undefined }, undefined, marker);
          this.containers.delete(id);
          return;
        }
        // No Incus request was attempted: clean only provisional app metadata.
        // Never inspect/delete compute or storage by the freshly-minted name.
        await cleanupWorkerMappings(containerName);
        await useWorkerConfigStore().remove(userId, id);
        await this.workerStore?.delete(userId, id);
        this.containers.delete(id);
        return;
      }
      if (!proof?.incarnation || !proof.nonce || !marker || marker.nonce !== proof.nonce ||
          marker.originalIncarnation || (marker.replacementIncarnation && marker.replacementIncarnation !== proof.incarnation)) {
        const current = this.containers.get(id); if (current) current.status = 'error';
        throw Object.assign(new Error('Incus creation retained ambiguous compute and all persistence for recovery'),
          { code: 'WORKER_CREATE_CONTAINER_RETAINED' });
      }
      try {
        await this.incusRuntime.rollbackRecreation({ id, userId, containerName },
          { nonce: proof.nonce, replacementIncarnation: proof.incarnation, initialCreate: marker.initialCreate,
            ...(marker.importIncomplete ? { importIncomplete: true as const } : {}) });
        await this.workerStore!.transitionIncusRecreation(userId, id,
          { status: 'archived', desiredRuntimeStatus: 'stopped', incusRecreation: undefined }, undefined, marker);
        this.containers.delete(id);
      } catch (cause) {
        const current = this.containers.get(id); if (current) current.status = 'error';
        throw Object.assign(new Error('Incus creation rollback retained recovery metadata and all persistence'),
          { code: 'WORKER_CREATE_ROLLBACK_INCOMPLETE', cause });
      }
      // Ordinary fresh worker data remains available for explicit unarchive;
      // incomplete imports instead retain deletion-pending private state.
      // Failure cleanup never destroys canonical data or silently retries boot.
      return;
    }
    try {
      await rollbackFailedWorkerImport({
        removeFromMemory: () => this.containers.delete(id),
        removeMappings: () => cleanupWorkerMappings(containerName),
        removeWorkerRecord: async () => {
          const store = this.workerStore;
          if (!store?.get(userId, id)) return;
          await store.delete(userId, id);
        },
        removeWorkerConfiguration: () =>
          useWorkerConfigStore().remove(userId, id),
        // A create failure may occur before Docker materializes the named
        // container. Absence is the desired rollback state.
        removeContainer: () =>
          removeDockerContainerIdempotently(() =>
            this.dockerService.removeContainer(containerId),
          ),
        removeWorkspace: () =>
          this.storageManager?.removeWorkerWorkspace(
            userId,
            id,
            containerName,
          ) ?? Promise.resolve(),
        removeAgents: () =>
          this.storageManager?.removeWorkerAgents(userId, id, containerName) ??
          Promise.resolve(),
        ...(dockerEnabled && this.storageManager
          ? {
              removeDocker: () =>
                this.storageManager!.removeWorkerDocker(containerName),
            }
          : {}),
        ...(importedImage
          ? {
              removeImportedImage: () =>
                this.dockerService.removeImage(importedImage),
            }
          : {}),
      });
    } catch (error) {
      useLogger().error(
        `[container] worker provisioning rollback incomplete for ${containerName}: ${error instanceof Error ? error.message : error}`,
      );
      throw Object.assign(
        new Error(
          `Imported worker cleanup requires operator attention: ${containerName}`,
        ),
        {
          cause: error,
          ...((error as { code?: string })?.code
            ? { code: (error as { code: string }).code }
            : {}),
          ...(Array.isArray((error as { failures?: unknown })?.failures)
            ? {
                failures: [
                  ...((error as { failures: string[] }).failures),
                ],
              }
            : {}),
        },
      );
    }
  }

  /** Startup-only cleanup seam for the portable import journal. Recovery runs
   * before sync(), so derive everything from durable worker metadata and the
   * journal's fresh identity rather than trusting Docker discovery state. */
  async recoverPortableManagedVolumeProvisionalWorker(
    journal: PortableManagedVolumeImportJournal,
  ): Promise<void> {
    const worker = this.workerStore?.get(journal.userId, journal.workerId);
    const containerName = this.buildContainerName(journal.workerId);
    let dockerEnabled = true;
    if (worker) {
      try {
        dockerEnabled = this.deriveLimits(
          this.resolveEnvironmentConfig(worker.environmentId),
        ).dockerEnabled;
      } catch {
        // Cleanup must remain conservative when a referenced environment was
        // removed or corrupted: attempting the idempotent Docker-data cleanup
        // is safer than retaining an untracked privileged data directory.
      }
    }
    const importEnvironmentId = worker?.importCreatedEnvironmentId;
    await this.rollbackFailedProvisionedWorker({
      id: journal.workerId,
      userId: journal.userId,
      containerId: containerName,
      containerName,
      dockerEnabled,
      importedImage: worker?.importedImage,
    });
    if (
      importEnvironmentId &&
      this.environmentStore &&
      !this.importEnvironmentIsReferenced(journal.userId, importEnvironmentId)
    ) {
      await removeImportEnvironmentIdempotently(
        importEnvironmentId,
        (id) => Boolean(this.environmentStore?.getById(id)),
        (id) => this.environmentStore!.delete(id),
      );
    }
  }

  /** Resolve the environment to assign an imported worker. Built-in envs are
   * reused by id; a user's own env with a matching name is reused; otherwise the
   * embedded definition is recreated as a new custom env for the importer. */
  private async resolveImportEnvironment(
    userId: string,
    env: Environment | undefined,
    requireExactEnvironment = false,
  ): Promise<{ id: string; created: boolean }> {
    if (requireExactEnvironment && (!this.environmentStore || !env))
      throw Object.assign(new Error('The native import environment authority is unavailable'),
        { statusCode: 409, code: 'INCUS_IMPORT_ENVIRONMENT_UNAVAILABLE' });
    if (!this.environmentStore || !env)
      return { id: DEFAULT_ENVIRONMENT_ID, created: false };
    if (env.builtIn) {
      const existing = this.environmentStore.getById(env.id);
      // The bundle's builtIn flag is descriptive. getById searches all owners,
      // so existence alone must not expose a foreign custom environment.
      if (existing && (existing.builtIn !== true || existing.userId !== null))
        throw Object.assign(new Error('The described built-in environment is not a platform-owned built-in'),
          { statusCode: 409, code: 'IMPORT_ENVIRONMENT_NOT_AUTHORIZED' });
      if (requireExactEnvironment && !existing)
        throw Object.assign(new Error('The native import environment is unavailable; refusing a default-policy substitution'),
          { statusCode: 409, code: 'INCUS_IMPORT_ENVIRONMENT_UNAVAILABLE' });
      return {
        id: existing
          ? env.id
          : DEFAULT_ENVIRONMENT_ID,
        created: false,
      };
    }
    const existing = this.environmentStore
      .list()
      .find((e) => e.userId === userId && e.name === env.name);
    if (existing) return { id: existing.id, created: false };
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
      return { id: created.id, created: true };
    } catch (err) {
      if (requireExactEnvironment) throw Object.assign(
        new Error('The native import environment could not be recreated; refusing a default-policy substitution'),
        { statusCode: 409, code: 'INCUS_IMPORT_ENVIRONMENT_UNAVAILABLE', cause: err });
      useLogger().warn(
        `[container] import: could not recreate environment '${env.name}', using default: ${err instanceof Error ? err.message : err}`,
      );
      return { id: DEFAULT_ENVIRONMENT_ID, created: false };
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
    return (this.workerStore?.listArchived() ?? []).map((record) => {
      const { importCreatedEnvironmentId: _internal, incusRecreation: _recovery, ...publicRecord } = record;
      return publicRecord;
    });
  }

  async reconcileWorkers(): Promise<void> {
    if (!this.workerStore) return;
    await this.reconcileIncusWorkers();

    const activeContainerNames = new Set<string>();
    for (const [, info] of this.containers) {
      activeContainerNames.add(info.containerName);
      // Incus runtime inventory has no config authority. It must not overwrite
      // pending local edits or bounded recreation recovery metadata.
      if (info.runtimeKind === 'incus-vm') continue;
      const existing = this.workerStore.get(info.userId, info.id);
      if (!existing || existing.status === "active") {
        await this.workerStore.upsert(this.containerInfoToWorkerRecord(info));
      }
    }

    const missingDesiredWorkers: WorkerRecord[] = [];
    const { useManagedVolumeManager: storageManager } = await import("./managed-volume-manager");
    for (const worker of this.workerStore.listActive()) {
      // Never feed missing Incus compute through Docker recovery.
      if (worker.runtimeKind === "incus-vm") continue;
      if (storageManager().isRecoveryBlocked(worker.id)) continue;
      if (!activeContainerNames.has(this.buildContainerName(worker.id))) {
        // Acquire the same owner→worker fences as create/rebuild/recovery, then
        // recheck live state inside them. A separate isBusy snapshot leaves a
        // race in which reconciliation can archive a provisional worker just
        // as its lifecycle mutation begins.
        const missing = await withOwnerWorkerLifecycleMutation(
          worker.userId,
          worker.id,
          async () => {
            if (this.containers.has(worker.id)) return undefined;
            const current = this.workerStore?.get(worker.userId, worker.id);
            if (!current || current.status !== "active") return undefined;
            await this.workerStore!.archive(worker.userId, worker.id);
            return current;
          },
        );
        if (missing?.desiredRuntimeStatus === "running")
          missingDesiredWorkers.push(missing);
      }
    }

    // Rebuild/recovery first persists running intent, then may retain an
    // archived record if disposable compute cannot be recreated. Retry those
    // system transitions on later passes; a user archive persists stopped
    // intent and is therefore never auto-unarchived.
    for (const worker of this.workerStore.listArchived())
      if (
        worker.runtimeKind !== "incus-vm" &&
        !storageManager().isRecoveryBlocked(worker.id) &&
        worker.desiredRuntimeStatus === "running" &&
        !missingDesiredWorkers.some((candidate) => candidate.id === worker.id)
      )
        missingDesiredWorkers.push(worker);

    // Migrate immutable restart policy and converge the persisted lifecycle
    // intent only after stores (including encrypted group configuration) are
    // available. Each worker is isolated so one damaged task cannot prevent
    // every other worker from recovering.
    for (const info of [...this.containers.values()]) {
      if (info.administrativeKind) continue;
      if (info.runtimeKind === "incus-vm") continue;
      if (storageManager().isRecoveryBlocked(info.id)) {
        info.status = "error";
        info.runtimeDiagnostic = { code: "WORKER_STORAGE_RECOVERY_REQUIRED", operation: "Storage recovery",
          message: "Persistent storage recovery needs attention. Restore missing storage, then retry application or restart.",
          retryable: true, observedAt: new Date().toISOString() };
        continue;
      }
      try {
        const { groupSecrets } = await this.resolveUserEnvAndBinds(
          info.userId,
          info.excludedGlobalEnvVarKeys ?? [],
          info.id,
          info.excludedGroupEnvVarKeys ?? [],
        );
        const local = await useWorkerConfigStore().resolveAppliedValues(
          info.userId,
          info.id,
        );
        const { useManagedVolumeManager } = await import("./managed-volume-manager");
        const transientStorage = await useManagedVolumeManager().requiresRecreation(info.userId, info.id, info.containerId);
        const sensitive = transientStorage || [...groupSecrets, ...local].some(
          (entry) => entry.kind !== "variable",
        );
        const runtime = await this.dockerService.inspectContainerRuntime(
          info.containerId,
        );
        const expectedPolicy = sensitive ? "no" : "unless-stopped";
        if (runtime.restartPolicy !== expectedPolicy)
          await this.dockerService.updateContainerRestartPolicy(
            info.containerId,
            sensitive,
          );
        if (info.desiredRuntimeStatus === "stopped" && runtime.running)
          await this.stop(info.id);
        else if (
          info.desiredRuntimeStatus === "running" &&
          !runtime.running
        )
          // Failed observability probes must not restart a running worker.
          await this.restart(info.id);
        if (info.status === 'running')
          await this.refreshManagedNetworkHosts(info.id, info.containerId).catch(error => {
            // Optional peer-name configuration is not evidence that this
            // positively observed container became unhealthy. Catch only
            // after setup admission rejects, preserving late-writer fencing.
            useLogger().warn(`[container] managed hostname refresh deferred for ${info.id}: ${(error as { code?: string })?.code ?? 'peer configuration unavailable'}`);
          });
      } catch (error) {
        this.markRuntimeUnknown(info, "Worker startup reconciliation", error);
        useLogger().warn(
          `[container] startup reconciliation deferred for ${info.id}: ${(error as { code?: string })?.code || "runtime unavailable"}`,
        );
      }
    }

    // A desired-running worker whose disposable container disappeared is
    // recreated through the normal unarchive path. Workspace, agent-data,
    // selected-path volumes, group identity, and plugin desired state remain
    // authoritative and are reattached/reconciled there.
    for (const worker of missingDesiredWorkers) {
      await this.unarchive(worker.userId, worker.id).catch((error) =>
        useLogger().warn(
          `[container] missing worker recreation deferred for ${worker.id}: ${(error as { code?: string })?.code || "runtime unavailable"}`,
        ),
      );
    }
  }

  /** Read healthy guests without advancing their lifecycle generation. Only a
   * positive stopped/missing-provisioning/service observation admits repair. */
  async reconcileIncusWorkers(): Promise<void> {
    // Both archived and active records can retain a marker after a lost create
    // or metadata response. Roll back before ordinary desired-state recovery.
    for (const snapshot of [...(this.workerStore?.listActive() ?? []), ...(this.workerStore?.listArchived() ?? [])]) {
      if (snapshot.runtimeKind !== 'incus-vm' || snapshot.deletionPending || !snapshot.incusRecreation) continue;
      try {
        await withOwnerWorkerLifecycleMutation(snapshot.userId, snapshot.id, async () => {
          const record = this.workerStore?.get(snapshot.userId, snapshot.id);
          if (!record || record.runtimeKind !== 'incus-vm' || record.deletionPending || !record.incusRecreation) return;
          await this.assertOwnerExists(record.userId);
          const marker = structuredClone(record.incusRecreation);
          await this.assertIncusPersistenceReady(record);
          const result = await this.incusRuntime.rollbackRecreation({ id: record.id, userId: record.userId,
            containerName: this.buildContainerName(record.id) }, marker);
          if (marker.importIncomplete && result.status !== 'archived')
            throw new Error('Incomplete initial import rollback cannot recover active compute');
          const resolved = await this.workerStore!.transitionIncusRecreation(record.userId, record.id,
            { status: result.status, desiredRuntimeStatus: 'stopped', incusRecreation: undefined }, undefined, marker);
          const current = this.get(record.id);
          if (current) useLogCollector().detach(current.containerId);
          if (result.status === 'archived') this.containers.delete(record.id);
          else this.containers.set(record.id, { ...current, ...resolved, runtimeKind: 'incus-vm',
            containerName: this.buildContainerName(record.id), containerId: `incus:${result.incarnation}`,
            imageName: current?.imageName ?? '', imageId: current?.imageId ?? '',
            status: 'stopped', runtimeDiagnostic: undefined });
        });
      } catch (error) {
        useLogger().warn(`[container] Incus recreation recovery quarantined ${snapshot.id}: ${(error as { code?: string })?.code ?? 'runtime unavailable'}`);
      }
    }
    for (const snapshot of this.workerStore?.listActive() ?? []) {
      if (snapshot.runtimeKind !== 'incus-vm' || snapshot.deletionPending || snapshot.incusRecreation) continue;
      let observedHandle: string | undefined, observedGeneration: number | undefined;
      if (!this.get(snapshot.id)?.containerId.startsWith('incus:')) {
        try {
          await withOwnerWorkerLifecycleMutation(snapshot.userId, snapshot.id, async () => {
            const record = this.workerStore?.get(snapshot.userId, snapshot.id);
            if (!record || record.status !== 'active' || record.runtimeKind !== 'incus-vm' || record.deletionPending ||
                record.incusRecreation || record.desiredRuntimeStatus !== 'running' ||
                this.get(record.id)?.containerId.startsWith('incus:')) return;
            await this.assertOwnerExists(record.userId);
            const name = this.buildContainerName(record.id);
            await this.recreateIncusWorker({ ...record, runtimeKind: 'incus-vm', containerName: name,
              containerId: name, imageName: this.config.incusWorkerImage, imageId: record.imageDigest ?? '', status: 'unknown' }, undefined, true);
          });
        } catch (error) {
          const current = this.get(snapshot.id), record = this.workerStore?.get(snapshot.userId, snapshot.id);
          if (current?.userId === snapshot.userId && !current.containerId.startsWith('incus:') && !record?.incusRecreation)
            this.markRuntimeUnknown(current, 'Incus missing compute recovery', error);
          useLogger().warn(`[container] Incus missing compute recovery deferred for ${snapshot.id}: ${(error as { code?: string })?.code ?? 'runtime unavailable'}`);
        }
        continue;
      }
      const inspect = async () => {
        const record = this.workerStore?.get(snapshot.userId, snapshot.id), info = this.get(snapshot.id);
        if (!record || record.status !== 'active' || record.runtimeKind !== 'incus-vm' || record.deletionPending ||
            record.incusRecreation || !info || info.userId !== record.userId || info.runtimeKind !== 'incus-vm') return;
        const { useManagedVolumeManager } = await import('./managed-volume-manager');
        const volumes = useManagedVolumeManager(); await volumes.init();
        volumes.assertLiveRecoveryResolved(record.userId, record.id);
        const incarnation = info.containerId.startsWith('incus:') ? info.containerId.slice(6) : '';
        if (!incarnation) throw new Error('Incus reconciliation incarnation is unavailable');
        observedHandle = info.containerId; observedGeneration = workerLifecycleGeneration(info.id);
        const instance = await this.incusRuntime.client.getInstance(info.containerName);
        if (!await this.incusRuntime.matchesWorkerIdentity(instance, info.id, info.userId) ||
            instance.config['volatile.uuid'] !== incarnation)
          throw new Error('Incus reconciliation owner or incarnation changed');
        return { record, info, instance, incarnation };
      };
      try {
        const repair = await withOwnerWorkerRuntimeSetup(snapshot.userId, snapshot.id, async () => {
          const target = await inspect(); if (!target) return false;
          const { record, info, instance, incarnation } = target;
          if (record.desiredRuntimeStatus === 'stopped') {
            if (instance.status === 'Stopped') { info.status = 'stopped'; info.runtimeDiagnostic = undefined; }
            return instance.status === 'Running';
          }
          if (record.desiredRuntimeStatus !== 'running') return false;
          if (record.hostMountsRevoked || record.hardwareDevicesRevoked)
            throw new Error('Incus worker access was revoked; rebuild is required');
          if (instance.status === 'Stopped') return true;
          if (instance.status !== 'Running') throw new Error('Incus guest is not ready for observation');
          const guest = await this.incusRuntime.inspectGuestReadiness(info, incarnation);
          if (!guest.provisioned || !guest.serviceReady) return true;
          info.status = 'running'; info.runtimeDiagnostic = undefined;
          return this.managedNetworksNeedReconciliation(info);
        });
        if (!repair) {
          const healthy = this.get(snapshot.id);
          if (healthy?.status === 'running' && healthy.containerId === observedHandle &&
              this.workerStore?.get(snapshot.userId, snapshot.id)?.desiredRuntimeStatus === 'running') {
            // A healthy boot can outlive a peer's DHCP lease/incarnation.
            // Refresh hints independently of guest-health classification.
            // The setup operation must reject before diagnostics catch it so
            // an unsettled guest writer retains its existing queue fence.
            await this.refreshManagedNetworkHosts(healthy.id, healthy.containerId).catch(error => {
              useLogger().warn(`[container] managed hostname refresh deferred for ${healthy.id}: ${(error as { code?: string })?.code ?? 'peer configuration unavailable'}`);
            });
          }
          continue;
        }
        await withOwnerWorkerLifecycleMutation(snapshot.userId, snapshot.id, async () => {
          const target = await inspect(); if (!target) return;
          const { record, info, instance, incarnation } = target;
          await this.assertOwnerExists(info.userId);
          if (record.desiredRuntimeStatus === 'stopped') {
            await this.incusRuntime.stop(info, incarnation); info.status = 'stopped'; return;
          }
          if (record.desiredRuntimeStatus !== 'running') return;
          if (record.hostMountsRevoked || record.hardwareDevicesRevoked)
            throw new Error('Incus worker access was revoked; rebuild is required');
          let bootId: string | undefined;
          if (instance.status === 'Running') {
            const guest = await this.incusRuntime.inspectGuestReadiness(info, incarnation);
            if (guest.provisioned && guest.serviceReady) {
              info.status = 'running'; await this.reconcileManagedNetworksForWorker(info); return;
            }
            bootId = guest.bootId;
          } else if (instance.status !== 'Stopped') throw new Error('Incus guest is not ready for recovery');
          const options = await this.incusOptionsForWorker(info, true, info.containerId);
          info.status = 'starting';
          await this.incusRuntime.start(options, incarnation, { leaveRunningOnFailure: true });
          const guest = await this.incusRuntime.inspectGuestReadiness(info, incarnation);
          if (!guest.provisioned || !guest.serviceReady || (bootId && guest.bootId !== bootId))
            throw new Error('Incus guest rebooted or remained unready during recovery; retry later');
          info.status = 'running'; info.runtimeDiagnostic = undefined; info.updatedAt = new Date().toISOString();
          useLogCollector().attach(info.containerName, info.containerId, 'worker', info.displayName).catch(() => {});
          await this.reconcileManagedNetworksForWorker(info);
          await this.reconcileWorkerPlugins(info);
        });
      } catch (error) {
        const current = this.get(snapshot.id);
        if (current?.userId === snapshot.userId && current.containerId === observedHandle &&
            workerLifecycleGeneration(snapshot.id) === observedGeneration)
          this.markRuntimeUnknown(current, 'Incus guest reconciliation', error);
        useLogger().warn(`[container] Incus recovery deferred for ${snapshot.id}: ${(error as { code?: string })?.code ?? 'runtime unavailable'}`);
      }
    }
  }

  /** Project the runtime ContainerInfo down to the minimal persisted record —
   * dropping everything Docker can re-discover (containerId, containerName,
   * imageName, imageId) and keeping only the worker's identity + config. */
  private containerInfoToWorkerRecord(info: ContainerInfo): WorkerRecord {
    return {
      id: info.id,
      runtimeKind: normalizeWorkerRuntimeKind(info.runtimeKind),
      userId: info.userId,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      displayName: info.displayName,
      status: "active",
      ...(info.desiredRuntimeStatus
        ? { desiredRuntimeStatus: info.desiredRuntimeStatus }
        : {}),
      environmentId: info.environmentId,
      excludedGlobalEnvVarKeys: info.excludedGlobalEnvVarKeys ?? [],
      excludedGroupEnvVarKeys: info.excludedGroupEnvVarKeys ?? [],
      workerSelfApiAccess: info.workerSelfApiAccess,
      repos: info.repos,
      mounts: info.mounts,
      hardwareDeviceIds: info.hardwareDeviceIds,
      initScript: info.initScript,
      pendingRebuild: info.pendingRebuild,
      hostMountsRevoked: info.hostMountsRevoked,
      hardwareDevicesRevoked: info.hardwareDevicesRevoked,
      importedImage: info.importedImage,
      importCreatedEnvironmentId: this.importCreatedEnvironments.get(info.id),
      imageDefinitionId: info.imageDefinitionId,
      imageVersion: info.imageVersion,
      imageDigest: info.imageDigest,
      imageRuntimeReference: info.imageRuntimeReference,
      incusRecreation: this.workerStore?.get(info.userId, info.id)?.incusRecreation,
    };
  }

  async logs(id: string, tail?: number): Promise<string> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    if (info.runtimeKind === 'incus-vm') {
      const session = await this.openWorkerJournal(id, { tail });
      session.stderr.resume();
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of session.stdout) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) throw new Error('Worker journal output exceeded its limit');
          chunks.push(Buffer.from(chunk));
        }
        if (await session.result !== 0) throw new Error('Worker journal read failed');
        if (!session.isCurrent()) throw new Error('Worker journal authority changed; retry');
        return Buffer.concat(chunks).toString('utf8');
      } finally { session.close(); }
    }
    try {
      return await this.dockerService.getLogs(info.containerId, tail);
    } catch (error) {
      this.markRuntimeUnknown(info, "Docker worker log read", error);
      throw error;
    }
  }

  private incusObservationTarget(id: string) {
    const info = this.containers.get(id);
    if (!info || info.runtimeKind !== 'incus-vm') throw new Error('Incus worker not found');
    const handle = info.containerId, userId = info.userId, generation = workerLifecycleGeneration(id);
    const validate = () => {
      const current = this.containers.get(id), record = this.workerStore?.findById(id);
      if (!record || record.status !== 'active' || record.deletionPending || record.runtimeKind !== 'incus-vm' ||
          record.userId !== userId || current?.runtimeKind !== 'incus-vm' || current.userId !== userId ||
          current.containerId !== handle || workerLifecycleGeneration(id) !== generation)
        throw new Error('Incus observation authority changed; retry');
    };
    validate();
    return { info, validate, incarnation: handle.slice('incus:'.length),
      owner: { id, userId, containerName: info.containerName } };
  }

  async incusWorkerMetrics(id: string) {
    const target = this.incusObservationTarget(id);
    const result = await this.incusRuntime.inspectState(target.owner, target.incarnation);
    target.validate();
    return result;
  }

  async incusWorkerDiskUsageBytes(id: string): Promise<number> {
    const info = this.assertRunning(id);
    if (info.runtimeKind !== 'incus-vm') throw new Error('Incus worker not found');
    const result = await this.workerCommands(id).execCapture(info.containerId,
      ['du', '-skc', '/workspace', '/home/agent/.agent-data'], { timeoutMs: 20_000 });
    if (result.exitCode !== 0) throw new Error('Worker disk sample failed');
    const total = result.stdout.toString('utf8').trim().split(/\r?\n/).at(-1) ?? '';
    if (!/^\d+\s+total$/.test(total)) throw new Error('Worker disk sample was invalid');
    return Number(total.split(/\s+/)[0]) * 1024;
  }

  openWorkerJournal(id: string, options: Parameters<IncusWorkerRuntime['openJournal']>[3] = {}) {
    const target = this.incusObservationTarget(id);
    return this.incusRuntime.openJournal(target.owner, target.incarnation, target.validate, options);
  }

  async listTmuxWindows(id: string): Promise<TmuxWindow[]> {
    const info = this.containers.get(id);
    if (!info) throw new Error("Container not found");
    try {
      return await this.workerCommands(id).execListTmuxWindows(info.containerId);
    } catch (error) {
      this.markRuntimeUnknown(info, "Docker terminal inspection", error);
      throw error;
    }
  }

  async createTmuxWindow(id: string, name?: string): Promise<TmuxWindow> {
    const containerId = this.dockerIdFor(id);
    const windowName = name || `shell-${nanoid(4)}`;
    const info = this.containers.get(id)!;
    let windows: TmuxWindow[];
    try {
      await this.workerCommands(id).execTmux(containerId, [
        "new-window",
        "-t",
        "main:",
        "-n",
        windowName,
      ]);
      windows = await this.workerCommands(id).execListTmuxWindows(containerId);
    } catch (error) {
      this.markRuntimeUnknown(info, "Docker terminal creation", error);
      throw error;
    }
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
    await this.workerCommands(id).execTmux(this.dockerIdFor(id), [
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
    await this.workerCommands(id).execTmux(this.dockerIdFor(id), [
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
    const instances = await this.workerCommands(id).listAppInstances(
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

    const existing = await this.workerCommands(id).listAppInstances(
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

    await this.workerCommands(id).startAppInstance(
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
    await this.workerCommands(id).stopAppInstance(
      info.containerId,
      appTypeId,
      instanceId,
    );
  }
}
