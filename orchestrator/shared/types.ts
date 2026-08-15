export interface RepoConfig {
  provider: string;
  url: string;
  branch?: string;
}

export interface MountConfig {
  source: string;
  target: string;
  readOnly?: boolean;
}

/**
 * Common shape shared by every persisted resource. Resources extend this (and
 * usually `UserOwnedResource`) and add their own fields — keeping the model
 * extensible: new optional fields can be added in a later release without
 * touching the base. `id` is always a UUID v4 minted server-side.
 */
export interface BaseResource {
  /** UUID v4 — the stable, immutable identity of the resource. */
  id: string;
  /** ISO 8601 timestamp of first creation. */
  createdAt: string;
  /** ISO 8601 timestamp of the last mutation. */
  updatedAt: string;
}

/** A resource owned by a user. `userId` is `null` only for platform-seeded
 * built-in entries (see `builtIn`). */
export interface UserOwnedResource extends BaseResource {
  userId: string;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

export interface AppInstanceInfo {
  id: string;
  appType: string;
  /** Internal container port the app is listening on. `0` when the app does not expose a port (e.g. vscode tunnel). */
  port: number;
  status: "running" | "stopped" | "auth_required";
  /** Externally reachable port from the auto-created port mapping, if any (e.g. ssh). */
  externalPort?: number;
  /** VS Code tunnel machine name once the tunnel has connected. */
  machineName?: string;
  /** Device-code auth URL (VS Code tunnel) while the app is in `auth_required`. */
  authUrl?: string;
  /** Device-code auth code (VS Code tunnel) while the app is in `auth_required`. */
  authCode?: string;
}

export type NetworkMode =
  | "block-all"
  | "block"
  | "package-managers"
  | "full"
  | "custom";

export interface ServiceStatus {
  running: boolean;
  containerId?: string;
}

export type ContainerStatus =
  | "creating"
  | "running"
  | "stopped"
  | "removing"
  | "error";

/** A worker. `id` is the worker's stable UUID identity (immutable across
 * rebuild/unarchive); `containerId`/`containerName` describe the current Docker
 * container (the `containerId` changes on every rebuild). Extends
 * `UserOwnedResource` so it carries `id`/`userId`/`createdAt`/`updatedAt`. */
export interface ContainerInfo extends UserOwnedResource {
  /** Trusted orchestrator-managed workspace; never eligible for ordinary worker lifecycle mutations. */
  administrativeKind?: "platform" | "group";
  /** Current Docker container ID (64-hex; the short form is the in-container
   * hostname). Changes on every rebuild/unarchive — never use it as the worker's
   * identity (use `id`). */
  containerId: string;
  /** Globally unique Docker container name — `<containerPrefix>-<id>`. The stable
   * DNS identifier Traefik routes to and the prefix for per-worker volume names. */
  containerName: string;
  /** Editable, user-facing label shown throughout the dashboard. Free-form (may
   * contain spaces/mixed case, need not be unique). Defaults to a friendly
   * generated slug when the user provides none. Renameable without recreating
   * the container — see `PATCH /api/containers/:id`. */
  displayName: string;
  /** Worker image reference (e.g. `agentor-worker:latest`). */
  imageName: string;
  imageId: string;
  status: ContainerStatus;
  repos?: RepoConfig[];
  mounts?: MountConfig[];
  initScript?: string;
  /** Foreign key to the assigned environment. The environment's own config (CPU /
   * memory / network / docker / setup script / env vars / exposed APIs /
   * capabilities / instructions) is NOT copied onto the worker — it is resolved
   * live from the EnvironmentStore by this id when the container is built. The
   * git identity is likewise resolved live from the owning `userId`. */
  environmentId?: string;
  /** Account-level custom variable names intentionally not inherited by this worker. */
  excludedGlobalEnvVarKeys?: string[];
  /** Effective inherited worker-group variable names intentionally omitted. */
  excludedGroupEnvVarKeys?: string[];
  /** True when the worker's stored config carries rebuild-requiring edits
   * (environment, repos, mounts, or init script) that have not yet been applied
   * to the running container. Live edits (display name) never set this. Cleared
   * whenever the container is (re)created — create, rebuild, or unarchive. */
  pendingRebuild?: boolean;
  /** Set on workers restored from an export that captured the source container's
   * filesystem. The per-worker imported image the worker runs (reused across
   * rebuild/unarchive). Unset for normal workers running the standard image. */
  importedImage?: string;
  imageDefinitionId?: string;
  imageVersion?: string;
  imageDigest?: string;
  imageRuntimeReference?: string;
}

export interface CreateContainerRequest {
  /** Editable, user-facing label. Free-form; defaults to a generated friendly
   * slug server-side when omitted. The internal worker identity is a UUID v4
   * minted by the orchestrator and is never client-supplied. */
  displayName?: string;
  repos?: RepoConfig[];
  mounts?: MountConfig[];
  /** Foreign key to the environment whose config (incl. CPU/memory limits) the
   * worker is built with. Resource limits are an environment property — there is
   * no per-worker limit override. */
  environmentId?: string;
  excludedGlobalEnvVarKeys?: string[];
  excludedGroupEnvVarKeys?: string[];
  /** Internal, authorization-checked group used to resolve inherited group
   * environment variables during creation. Never accepted directly from an
   * untrusted client request. */
  targetWorkerGroupId?: string;
  initScript?: string;
  /** Populated server-side from the authenticated session — never sent by clients.
   * The owner; the worker's git identity is resolved live from this user. */
  userId?: string;
  workerConfiguration?: WorkerConfigurationInput;
  /** Catalog fields are resolved and ownership-checked by the server. */
  imageDefinitionId?: string;
  imageVersion?: string;
  imageDigest?: string;
  imageRuntimeReference?: string;
}

export interface WorkerConfigurationInput {
  variables?: Array<{ key: string; value: string }>;
  secrets?: Array<{ key: string; value: string }>;
  secretFiles?: Array<{ name: string; path: string; content: string }>;
  envFile?: string;
  deleteSecrets?: string[];
  deleteSecretFiles?: string[];
}

/** Partial worker-settings update accepted by `PATCH /api/containers/:id`. Every
 * field is optional — only the keys present are changed. `displayName` is a live
 * edit (applied to the running worker immediately); `environmentId`, `initScript`,
 * `repos`, and `mounts` are baked into the container at create time, so changing
 * any of them flags the worker `pendingRebuild` until the next rebuild. */
export interface UpdateContainerSettingsRequest {
  displayName?: string;
  environmentId?: string;
  initScript?: string;
  repos?: RepoConfig[];
  mounts?: MountConfig[];
  excludedGlobalEnvVarKeys?: string[];
  excludedGroupEnvVarKeys?: string[];
}

export interface ImageUpdateInfo {
  name: string;
  localDigest: string;
  remoteDigest: string;
  updateAvailable: boolean;
  lastChecked: string;
  error?: string;
}

export type UpdatableImage = "orchestrator" | "worker" | "traefik";

export interface UpdateStatus {
  orchestrator: ImageUpdateInfo | null;
  worker: ImageUpdateInfo | null;
  traefik: ImageUpdateInfo | null;
  isProductionMode: boolean;
}

export interface ApplyResult {
  orchestratorPulled: boolean;
  workerPulled: boolean;
  traefikPulled: boolean;
  orchestratorRestarting: boolean;
  errors: string[];
}

export interface PruneResult {
  imagesDeleted: number;
  spaceReclaimed: number;
}

export type AgentAuthType = "oauth" | "api-key" | "none";

export interface UsageWindow {
  label: string;
  utilization: number;
  resetsAt: string | null;
}

export interface AgentUsageInfo {
  agentId: string;
  displayName: string;
  authType: AgentAuthType;
  usageAvailable: boolean;
  windows: UsageWindow[];
  planType?: string;
  error?: string;
  lastChecked?: string;
  lastFetchTime?: string;
}

export interface AgentUsageStatus {
  agents: AgentUsageInfo[];
}

export interface ExposeApis {
  portMappings: boolean;
  domainMappings: boolean;
  usage: boolean;
}

/** A reusable capability document. Built-in entries carry `userId: null` and
 * `builtIn: true`; user entries carry their owner's id and `builtIn: false`. */
export interface CapabilityInfo {
  id: string;
  name: string;
  content: string;
  builtIn: boolean;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstructionInfo {
  id: string;
  name: string;
  content: string;
  builtIn: boolean;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialInfo {
  agentId: string;
  fileName: string;
  configured: boolean;
}

/** A single env var the user wants injected into every worker they own, keyed by
 * the actual env var NAME (e.g. `GITHUB_TOKEN`). Predefined and custom env vars
 * are stored uniformly — the predefined/custom split is purely a UI convenience. */
export interface UserEnvVar {
  key: string;
  value: string;
}

export interface UserEnvVars {
  userId: string;
  createdAt: string;
  updatedAt: string;
  /** All env vars (predefined + custom alike), keyed by env var name. */
  envVars: UserEnvVar[];
}

/** Body of `PUT /api/account/env-vars`. A PUT REPLACES the whole list, so a
 * present `envVars` is the complete new set (and `[]` clears it). `envVars` is
 * optional only for backward compatibility — an omitted/`{}` body is treated by
 * the route as "no env vars supplied", not a partial merge. */
export type UserEnvVarsInput = { envVars?: UserEnvVar[] };

/** Well-known env var names the Account UI surfaces with dedicated inputs (in
 * order). Storage treats them identically to any other env var — this list is
 * only a UI affordance and is trivially extensible by adding a key. */
export const PREDEFINED_ENV_VAR_KEYS = [
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

/** The user's SSH public key(s) — NOT an env var. Stored only in
 * `<DATA_DIR>/users/<userId>/ssh/authorized_keys` (1:1 with the Account UI field)
 * and bind-mounted read-only into every worker the user owns. */
export interface UserSshKey {
  sshPublicKey: string;
}

export interface InitScriptInfo {
  id: string;
  name: string;
  content: string;
  builtIn: boolean;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Live resource metrics for a single worker container, sampled via the Docker
 * stats API. CPU is expressed as a percentage of the whole host (0-100 across
 * all cores); network/disk are live byte rates. */
export interface WorkerMetrics {
  /** The worker's UUID `id`. */
  workerId: string;
  /** Stable Docker container name (`<prefix>-<id>`). */
  containerName: string;
  displayName: string;
  status: ContainerStatus;
  /** 0-100 — fraction of total host CPU capacity used by this worker. */
  cpuUtilization: number;
  memoryUsedBytes: number;
  /** The worker's memory limit (cgroup limit; equals host memory when uncapped). */
  memoryLimitBytes: number;
  /** 0-100. */
  memoryUtilization: number;
  /** Disk space used by the worker's `/workspace` + agent-data (sampled on a
   * slower cadence than cpu/mem; 0 until first sampled). */
  diskUsedBytes: number;
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  blkReadBytesPerSec: number;
  blkWriteBytesPerSec: number;
  lastChecked: string;
  error?: string;
}

export interface WorkerMetricsStatus {
  workers: WorkerMetrics[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "orchestrator" | "worker" | "traefik";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  sourceId?: string;
  sourceName?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Workspace file manager — shared typed models.
//
// All client-supplied paths in these models are POSIX paths RELATIVE to the
// worker's `/workspace` root (e.g. `src/index.ts`, `docs/`). The empty string
// denotes the workspace root itself. The server normalises + lexically
// validates every client path (see `server/utils/workspace-path.ts`) and then
// re-checks containment in-container via realpath/lstat so a symlink can never
// redirect an operation outside `/workspace`. Host workspace paths are never
// used — every operation runs through Docker exec/getArchive/putArchive against
// the running worker container as uid 1000 (`agent`).
// ---------------------------------------------------------------------------

/** A single filesystem entry type inside a worker's `/workspace`. */
export type FileEntryType = "file" | "directory" | "symlink";

/** Metadata for one filesystem entry, as returned by the file manager listing
 *  and stat endpoints. `path` is relative to `/workspace` (POSIX, no leading
 *  slash; `` for the root). */
export interface FileEntry {
  /** Basename of the entry (`.` for the workspace root). */
  name: string;
  /** POSIX path relative to `/workspace` (no leading slash; `` for root). */
  path: string;
  type: FileEntryType;
  /** Size in bytes. `0` for directories and symlinks. */
  size: number;
  /** ISO 8601 modification time (UTC). */
  mtime: string;
  /** POSIX permission bits, formatted as a four-digit octal string. */
  mode?: string;
  /** Numeric owning uid/gid as observed in the workspace mount. */
  owner?: string;
  group?: string;
  /** Raw symlink target (the value `readlink` returns), only for symlinks. */
  linkTarget?: string;
  /** True when a symlink's resolved target escapes `/workspace`. Such entries
   *  are reported for visibility but cannot be traversed/operated through. */
  linkEscapes?: boolean;
}

/** Result of a one-level directory listing. Entries are sorted directories
 *  first, then by name (case-insensitive). */
export interface FileListing {
  /** POSIX path relative to `/workspace` that was listed (`` for root). */
  path: string;
  entries: FileEntry[];
}

/** `POST /api/containers/:id/files/mkdir` body. `path` is relative to
 *  `/workspace`. Parents are created as needed; idempotent when the directory
 *  already exists; `409` when a non-directory file blocks the path. */
export interface MkdirRequest {
  path: string;
  lockPassword?: string;
}

/** `POST /api/containers/:id/files/rename` body. Same-directory rename only —
 *  `path` is the existing entry and `newName` its replacement basename within
 *  the same parent. No overwrite: a `409` is returned if the target exists. */
export interface RenameRequest {
  path: string;
  newName: string;
  lockPassword?: string;
}

/** `POST /api/containers/:id/files/move` body. Moves every `paths` entry into
 *  the existing destination directory `destination` (relative to `/workspace`).
 *  When `overwrite` is false (the default) a `409` is returned with the list of
 *  conflicting target names before any move is performed. */
export interface MoveRequest {
  paths: string[];
  destination: string;
  overwrite?: boolean;
  lockPassword?: string;
}

/** A single conflict reported by `move` when `overwrite` is false. `source` is
 *  the relative path being moved; `target` the relative path that already
 *  exists inside the destination. */
export interface MoveConflict {
  source: string;
  target: string;
}

/** `409` body for `move` when conflicts are present and `overwrite` is false. */
export interface MoveConflictResponse {
  conflicts: MoveConflict[];
}

/** Result of a successful `move`. */
export interface MoveResult {
  moved: number;
}

/** `DELETE /api/containers/:id/files` body. Every `paths` entry is deleted
 *  (files, directories, symlinks). The workspace root is never deletable.
 *  Missing paths are ignored (idempotent); escaping symlinks/parents are
 *  rejected up front. */
export interface DeleteFilesRequest {
  paths: string[];
  lockPassword?: string;
}

/** Result of a successful multi-delete. `deleted` counts the paths that
 *  existed and were removed (missing paths are not counted). */
export interface DeleteFilesResult {
  deleted: number;
}

/** `POST /api/containers/:id/files/download` body. When `paths` contains exactly
 *  one regular file the response is the raw file bytes; otherwise a true ZIP
 *  archive is streamed containing every selected file/folder (relative names
 *  preserved, hidden files included, symlinks stored without following
 *  external targets). */
export interface DownloadFilesRequest {
  paths: string[];
}

/** `POST /api/containers/:id/files/upload` result. `uploaded` is the number of
 *  tar entries written into the workspace. */
export interface UploadFilesResult {
  uploaded: number;
}
