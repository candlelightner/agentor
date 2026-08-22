import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useAdminWorkspaceStore } from "./admin-workspace-store";
import { useGroupAdminWorkspaceStore } from "./group-admin-workspace-store";
import {
  useConfig,
  useContainerManager,
  useExportJobManager,
  useLogger,
  useManagedNetworkStore,
  useWorkerGroupStore,
  useWorkerStore,
} from "./services";
import { useBackupManager } from "./backup-manager";
import { useImageCatalogManager } from "./image-catalog";
import {
  listWorkspaceInventory,
  publicWorkspaceInventoryItem,
} from "./workspace-inventory";
import { OfflineWorkspaceAccess } from "./workspace-access";
import { workerConfigurationResponse } from "./worker-config-response";
import { useWorkerConfigStore } from "./worker-config-store";
import { useManagementConsoleStore } from "./management-console-store";
import {
  ManagementWorkerDomain,
  managementFailFastTimeoutSeconds,
  withinManagementFailFastDeadline,
} from "./management-worker-domain";
import {
  addWorkerToGroupWithNetworks,
  assignWorkerToGroupWithNetworks,
  withWorkerNetworkMutation,
} from "./worker-group-manager";
import {
  workspaceMcpTools,
  executeWorkspaceMcpTool,
} from "./management-mcp-workspace-adapter";
import { ManagementImageBackupDomain } from "./management-image-backup-domain";
import { ManagementPlatformDomain } from "./management-platform-domain";
import { ManagementConfigurationCatalogDomain } from "./management-configuration-catalog-domain";
import { ManagementExposureDomain } from "./management-exposure-domain";
import { ManagementRunningFilesDomain } from "./management-running-files-domain";
import { ManagementLogsDomain } from "./management-logs-domain";
import { ManagementStatusDomain } from "./management-status-domain";
import { ManagementGlobalConfigurationDomain } from "./management-global-configuration-domain";
import { ManagementImportDomain } from "./management-import-domain";
import {
  ManagementDownloadDomain,
  type OpenedManagementDownload,
} from "./management-download-domain";
import { useWorkerProtectionLockStore } from "./worker-protection-lock";
import { validateManagementOwnerArguments } from "./management-owner";
import type { Readable } from "node:stream";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import { withOwnerWorkerLifecycleMutation } from "./worker-lifecycle-coordinator";
import { ManagementPluginDomain } from "./management-plugin-domain";

const GROUPS = [
  "read-only-status",
  "logs",
  "volume-browsing",
  "configuration-inspection",
  "worker-lifecycle",
  "console",
  "storage",
  "configuration",
  "groups",
  "locks",
  "images",
  "networking",
  "apps",
  "storage-maintenance",
  "running-files",
  "catalogs",
  "exports",
  "backups",
  "image-builds",
  "configuration-proposals",
  "configuration-application",
] as const;
/** Group principals expose only operations whose targets can be proven to be
 * current group members. Platform/global catalog, policy, group mutation and
 * import operations are intentionally absent. */
const GROUP_ADMIN_TOOLS = new Set([
  "status.system",
  "workers.list",
  "workers.inspect",
  "workers.env-keys",
  "workers.create",
  "workers.metrics.get",
  "logs.read",
  "volumes.list",
  "volumes.list-files",
  "configuration.inspect",
  "worker.stop",
  "worker.start",
  "workers.update",
  "workers.restart",
  "workers.rebuild",
  "workers.archive",
  "workers.unarchive",
  "workers.delete",
  "configuration.get",
  "configuration.set",
  "console.open",
  "console.read",
  "console.write",
  "console.interrupt",
  "console.close",
  "exports.create",
  "exports.status",
  "exports.cancel",
  "exports.download",
  "backups.create",
  "backups.paths.list",
  "backups.status",
  "backups.cancel",
  "locks.get",
  "locks.set",
  "locks.remove",
  "apps.types",
  "apps.list",
  "apps.start",
  "apps.stop",
  "plugins.list",
  "plugins.definitions.create",
  "plugins.definitions.update",
  "plugins.definitions.duplicate",
  "plugins.definitions.delete",
  "plugins.install",
  "plugins.set-enabled",
  "plugins.uninstall",
  "files.list",
  "files.upload",
  "files.mkdir",
  "files.rename",
  "files.move",
  "files.delete",
  "port-mappings.create",
  "domain-mappings.create",
  "workspaces.list",
  "workspaces.files",
  "workspaces.preview",
  "workspaces.download",
  "images.list",
  "images.get",
  "images.create",
  "images.update",
  "images.validate",
  "images.delete",
  "images.delete-version",
  "images.build",
  "images.build-status",
  "images.build-logs",
  "images.build-cancel",
  "images.promote",
  "images.rollback",
  "networks.list",
  "networks.inspect",
  "networks.create",
  "networks.update",
  "networks.reconcile",
  "networks.delete",
  "groups.list",
  "groups.create",
  "groups.update",
  "groups.delete",
  "groups.assign-worker",
  "groups.env.list",
  "groups.env.update",
  "groups.admin-workspace.get",
  "groups.admin-workspace.provision",
  "groups.admin-workspace.start",
  "groups.admin-workspace.stop",
  "groups.admin-workspace.rebuild",
  "groups.admin-workspace.startup-script.get",
  "groups.admin-workspace.startup-script.set",
  "admin-workspace.startup-script.get",
  "admin-workspace.startup-script.set",
  "plugins.list",
  "plugins.definitions.create",
  "plugins.definitions.update",
  "plugins.definitions.duplicate",
  "plugins.definitions.delete",
  "plugins.install",
  "plugins.set-enabled",
  "plugins.uninstall",
]);
const GROUP_ADMIN_IMAGE_TOOLS = new Set(
  [...GROUP_ADMIN_TOOLS].filter((name) => name.startsWith("images.")),
);
const GROUP_ADMIN_TARGET_FREE_TOOLS = new Set([
  "status.system",
  "workers.list",
  "volumes.list",
  "apps.types",
  "workspaces.list",
  ...GROUP_ADMIN_IMAGE_TOOLS,
  "networks.list",
  "networks.create",
  "groups.list",
  "groups.create",
  "admin-workspace.startup-script.get",
  "admin-workspace.startup-script.set",
]);
const GROUP_ADMIN_NETWORK_TOOLS = new Set([
  "networks.inspect",
  "networks.update",
  "networks.reconcile",
  "networks.delete",
]);
const GROUP_ADMIN_GROUP_TOOLS = new Set([
  "groups.update",
  "groups.delete",
  "groups.env.list",
  "groups.env.update",
  "groups.admin-workspace.get",
  "groups.admin-workspace.provision",
  "groups.admin-workspace.start",
  "groups.admin-workspace.stop",
  "groups.admin-workspace.rebuild",
  "groups.admin-workspace.startup-script.get",
  "groups.admin-workspace.startup-script.set",
]);
const GROUP_ADMIN_ASSIGN_TOOLS = new Set(["groups.assign-worker"]);
const GROUP_ADMIN_PLUGIN_TOOLS = new Set(
  [...GROUP_ADMIN_TOOLS].filter((name) => name.startsWith("plugins.")),
);
const GROUP_ADMIN_DIRECT_TARGET_TOOLS = new Set([
  "workers.inspect",
  "workers.env-keys",
  "workers.metrics.get",
  "logs.read",
  "volumes.list-files",
  "configuration.inspect",
  "worker.stop",
  "worker.start",
  "workers.update",
  "workers.restart",
  "workers.rebuild",
  "workers.archive",
  "workers.unarchive",
  "workers.delete",
  "configuration.get",
  "configuration.set",
  "console.open",
  "exports.create",
  "backups.create",
  "backups.paths.list",
  "locks.get",
  "locks.set",
  "locks.remove",
  "apps.list",
  "apps.start",
  "apps.stop",
  "files.list",
  "files.upload",
  "files.mkdir",
  "files.rename",
  "files.move",
  "files.delete",
  "port-mappings.create",
  "domain-mappings.create",
  "workspaces.files",
  "workspaces.preview",
  "workspaces.download",
  ...GROUP_ADMIN_PLUGIN_TOOLS,
]);
const GROUP_ADMIN_EXPORT_JOB_TOOLS = new Set([
  "exports.status",
  "exports.cancel",
  "exports.download",
]);
const GROUP_ADMIN_BACKUP_JOB_TOOLS = new Set([
  "backups.status",
  "backups.cancel",
]);
// Group principals may create and inspect path selections for workers in their
// subtree (and for their own administrative workspace).  The owner is always
// derived from the authenticated workspace identity; it is never supplied by
// the caller.
const GROUP_ADMIN_BACKUP_TOOLS = new Set([
  "backups.create",
  "backups.paths.list",
  ...GROUP_ADMIN_BACKUP_JOB_TOOLS,
]);
const GROUP_ADMIN_CONSOLE_SESSION_TOOLS = new Set([
  "console.read",
  "console.write",
  "console.interrupt",
  "console.close",
]);
const GROUP_ADMIN_DIRECT_SCOPE_BOUNDARY_TOOLS = new Set([
  ...GROUP_ADMIN_DIRECT_TARGET_TOOLS,
  ...GROUP_ADMIN_EXPORT_JOB_TOOLS,
  ...GROUP_ADMIN_BACKUP_JOB_TOOLS,
  ...GROUP_ADMIN_CONSOLE_SESSION_TOOLS,
  // Network mutations already own the queue. Inspection does not, so it uses
  // the same direct-resource boundary without introducing reentrancy.
  "networks.inspect",
]);

// Tool discovery is an allowlist, and target resolution is a second,
// exhaustive allowlist. A newly delegated tool cannot silently become
// owner-wide merely because its identifier uses a field we do not recognize.
for (const name of GROUP_ADMIN_TOOLS) {
  if (
    name !== "workers.create" &&
    !GROUP_ADMIN_TARGET_FREE_TOOLS.has(name) &&
    !GROUP_ADMIN_DIRECT_TARGET_TOOLS.has(name) &&
    !GROUP_ADMIN_EXPORT_JOB_TOOLS.has(name) &&
    !GROUP_ADMIN_BACKUP_JOB_TOOLS.has(name) &&
    !GROUP_ADMIN_CONSOLE_SESSION_TOOLS.has(name) &&
    !GROUP_ADMIN_NETWORK_TOOLS.has(name) &&
    !GROUP_ADMIN_GROUP_TOOLS.has(name) &&
    !GROUP_ADMIN_ASSIGN_TOOLS.has(name)
  )
    throw new Error(`Group administrative tool has no target policy: ${name}`);
}
type Group = (typeof GROUPS)[number];
const workerDomain = new ManagementWorkerDomain();
const imageBackupDomain = new ManagementImageBackupDomain();
const platformDomain = new ManagementPlatformDomain();
const catalogDomain = new ManagementConfigurationCatalogDomain();
const exposureDomain = new ManagementExposureDomain();
const runningFilesDomain = new ManagementRunningFilesDomain();
const logsDomain = new ManagementLogsDomain();
const statusDomain = new ManagementStatusDomain();
const globalConfigurationDomain = new ManagementGlobalConfigurationDomain();
const importDomain = new ManagementImportDomain();
const downloadDomain = new ManagementDownloadDomain();
const pluginDomain = new ManagementPluginDomain();
interface Policy {
  schemaVersion: 1;
  default: "deny";
  groups: Record<Group, { enabled: boolean }>;
  revision: number;
  updatedAt: string;
}
interface Proposal {
  id: string;
  immutable: true;
  status: "pending-dashboard-approval" | "approved" | "applied";
  diff: Record<string, unknown>;
  createdAt: string;
  approvedAt?: string;
  appliedAt?: string;
}
interface Audit {
  id: string;
  at: string;
  action: string;
  outcome: string;
  details?: Record<string, unknown>;
}
interface State {
  schemaVersion: 1;
  policy: Policy;
  proposals: Proposal[];
  audit: Audit[];
  appliedConfiguration?: { logLevel?: "debug" | "info" | "warn" | "error" };
}
interface Identity {
  hash: string;
  workspaceId: string;
  expiresAt: number;
  groupId?: string;
  ownerId?: string;
}
interface IdentityMetadata {
  workspaceId: string;
  audience: "agentor-management-mcp";
  expiresAt: string;
  persistedInWorkspace: false;
  scope: "platform" | "group";
  groupId?: string;
  ownerId?: string;
}

const TOOL_GROUP: Record<string, Group> = {
  "status.system": "read-only-status",
  "workers.list": "read-only-status",
  "workers.inspect": "read-only-status",
  "logs.read": "logs",
  "volumes.list": "volume-browsing",
  "volumes.list-files": "volume-browsing",
  "configuration.inspect": "configuration-inspection",
  "worker.stop": "worker-lifecycle",
  "worker.start": "worker-lifecycle",
  "console.open": "console",
  "console.read": "console",
  "console.write": "console",
  "console.interrupt": "console",
  "console.close": "console",
  "exports.create": "exports",
  "exports.status": "exports",
  "exports.cancel": "exports",
  "backups.create": "backups",
  "backups.status": "backups",
  "backups.cancel": "backups",
  "images.validate": "image-builds",
  "images.update": "image-builds",
  "images.build": "image-builds",
  "images.build-status": "image-builds",
  "configuration.propose": "configuration-proposals",
  "configuration.apply": "configuration-application",
  "admin-workspace.startup-script.get": "groups",
  "admin-workspace.startup-script.set": "groups",
};
for (const tool of workerDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of workspaceMcpTools)
  TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of imageBackupDomain.tools())
  TOOL_GROUP[tool.name] ??= tool.group;
for (const tool of platformDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of catalogDomain.tools())
  TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of exposureDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of runningFilesDomain.tools())
  TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of logsDomain.tools())
  TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of statusDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of globalConfigurationDomain.tools())
  TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of importDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of pluginDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
const sensitive =
  /secret|token|credential|password|authorization|cookie|cipher|key|providerUploadId|pendingProvider(?:Object|Artifact|Upload)Id/i;
export function cleanManagementAuditDetails(value: unknown, depth = 0): any {
  if (depth > 5) return "[REDACTED]";
  if (typeof value === "string")
    return value.length > 128 ? "[REDACTED]" : value;
  if (Array.isArray(value))
    return value
      .slice(0, 50)
      .map((v) => cleanManagementAuditDetails(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as any).map(([k, v]) => [
        k,
        sensitive.test(k)
          ? "[REDACTED]"
          : cleanManagementAuditDetails(v, depth + 1),
      ]),
    );
  return value;
}
const clean = cleanManagementAuditDetails;
function initialPolicy(): Policy {
  return {
    schemaVersion: 1,
    default: "deny",
    groups: Object.fromEntries(
      GROUPS.map((g) => [
        g,
        {
          enabled: [
            "read-only-status",
            "logs",
            "volume-browsing",
            "configuration-inspection",
          ].includes(g),
        },
      ]),
    ) as Policy["groups"],
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
}

function appendAudit(
  state: State,
  action: string,
  outcome: string,
  details?: Record<string, unknown>,
) {
  state.audit.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    action,
    outcome,
    details: clean(details),
  });
  if (state.audit.length > 5000)
    state.audit.splice(0, state.audit.length - 5000);
}

export interface ManagementConfigurationApplyDependencies {
  getLogLevel(): ReturnType<typeof useConfig>["logLevel"];
  setLogLevel(value: ReturnType<typeof useConfig>["logLevel"]): void;
  verifyWorkerVariables(workerId: string, lockPassword: unknown): Promise<void>;
  applyWorkerVariables(
    workerId: string,
    variables: Array<{ key: string; value: string }>,
    lockPassword: unknown,
  ): Promise<{ workerId: string }>;
}

function productionConfigurationApplyDependencies(): ManagementConfigurationApplyDependencies {
  return {
    getLogLevel: () => useConfig().logLevel,
    setLogLevel: (value) => {
      useConfig().logLevel = value;
    },
    verifyWorkerVariables: async (workerId, lockPassword) => {
      const containers = useContainerManager();
      const workers = useWorkerStore();
      const snapshot = containers.get(workerId) ?? workers.findById(workerId);
      if (!snapshot)
        throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
      await withOwnerWorkerLifecycleMutation(
        snapshot.userId,
        workerId,
        async () => {
          const live = containers.get(workerId);
          const stored = workers.get(snapshot.userId, workerId);
          if ((!live && !stored) || (live && live.userId !== snapshot.userId))
            throw Object.assign(new Error("Worker not found"), {
              statusCode: 404,
            });
          await useWorkerProtectionLockStore().verify(workerId, lockPassword);
        },
      );
    },
    applyWorkerVariables: async (workerId, variables, lockPassword) => {
      const containers = useContainerManager();
      const workers = useWorkerStore();
      const snapshot = containers.get(workerId) ?? workers.findById(workerId);
      if (!snapshot)
        throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
      return withOwnerWorkerLifecycleMutation(
        snapshot.userId,
        workerId,
        async () => {
          const live = containers.get(workerId);
          const stored = workers.get(snapshot.userId, workerId);
          if ((!live && !stored) || (live && live.userId !== snapshot.userId))
            throw Object.assign(new Error("Worker not found"), {
              statusCode: 404,
            });
          if (!stored)
            throw Object.assign(new Error("Worker metadata is unavailable"), {
              statusCode: 409,
            });
          await useWorkerProtectionLockStore().verify(workerId, lockPassword);
          // The desired variables assignment and rebuild marker are idempotent.
          // A durable approved proposal therefore remains safely retryable if a
          // crash or a later store write interrupts this cross-store sequence.
          await useWorkerConfigStore().patch(snapshot.userId, workerId, {
            variables,
          });
          let persisted;
          try {
            persisted = await workers.markPendingRebuild(
              snapshot.userId,
              workerId,
            );
            if (!persisted) throw new Error("Worker not found");
          } catch (error) {
            throw Object.assign(
              new Error("Worker rebuild state could not be committed"),
              { configurationEffectMayHaveApplied: true, cause: error },
            );
          }
          if (live) {
            live.pendingRebuild = true;
            live.updatedAt = persisted.updatedAt;
          }
          return { workerId };
        },
      );
    },
  };
}

export class ManagementMcpStore {
  private state: State = {
    schemaVersion: 1,
    policy: initialPolicy(),
    proposals: [],
    audit: [],
  };
  private identities = new Map<string, Identity>();
  private path: string;
  private loading?: Promise<void>;
  private writes = Promise.resolve();
  private mutations = Promise.resolve();
  constructor(
    dataDir = process.env.DATA_DIR || "/data",
    private readonly stateWriter?: (state: unknown) => Promise<void>,
    private readonly configurationApply = productionConfigurationApplyDependencies(),
  ) {
    this.path = join(dataDir, "admin", "management-mcp.v1.json");
  }
  async init() {
    if (!this.loading)
      this.loading = (async () => {
        try {
          const p = JSON.parse(await readFile(this.path, "utf8"));
          const normalized = normalizeManagementMcpState(p);
          if (normalized) {
            this.state = normalized.state;
            if (normalized.changed) await this.persist();
          }
        } catch (e: any) {
          if (e?.code !== "ENOENT") throw e;
        }
      })();
    return this.loading;
  }
  private persistState(state: State) {
    const next = this.writes.then(async () => {
      if (this.stateWriter) {
        await this.stateWriter(structuredClone(state));
        return;
      }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tmp, this.path);
    });
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private persist() {
    return this.persistState(structuredClone(this.state));
  }
  private mutate<T>(operation: (draft: State) => T): Promise<T> {
    const result = this.mutations.then(async () => {
      const draft = structuredClone(this.state);
      const value = operation(draft);
      await this.persistState(draft);
      this.state = draft;
      return value;
    });
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async getPolicy() {
    await this.init();
    return structuredClone(this.state.policy);
  }
  async listTools(identity?: IdentityMetadata) {
    await this.init();
    return Object.keys(TOOL_GROUP)
      .filter((name) => this.state.policy.groups[TOOL_GROUP[name]!]!.enabled)
      .filter(
        (name) => identity?.scope !== "group" || GROUP_ADMIN_TOOLS.has(name),
      )
      .map((name) => {
        const domain = workerDomain.tools().find((tool) => tool.name === name);
        const workspace = workspaceMcpTools.find((tool) => tool.name === name);
        const imageBackup = imageBackupDomain
          .tools()
          .find((tool) => tool.name === name);
        const platform = platformDomain
          .tools()
          .find((tool) => tool.name === name);
        const catalog = catalogDomain
          .tools()
          .find((tool) => tool.name === name);
        const exposure = exposureDomain
          .tools()
          .find((tool) => tool.name === name);
        const runningFiles = runningFilesDomain
          .tools()
          .find((tool) => tool.name === name);
        const logs = logsDomain.tools().find((tool) => tool.name === name);
        const status = statusDomain.tools().find((tool) => tool.name === name);
        const globalConfiguration = globalConfigurationDomain
          .tools()
          .find((tool) => tool.name === name);
        const imports = importDomain.tools().find((tool) => tool.name === name);
        const plugin = pluginDomain.tools().find((tool) => tool.name === name);
        return {
          name,
          description:
            (identity?.scope === "group" && name === "workers.create"
              ? "Create an evaluation worker owned by and atomically enrolled in this administrative group. The owner and group are derived from the workspace identity; timeoutSeconds bounds the MCP wait while safe enrollment or rollback remains serialized."
              : identity?.scope === "group" && GROUP_ADMIN_IMAGE_TOOLS.has(name)
                ? `${imageBackup?.description || "Manage an image"} in the authorized image hierarchy. Global and ancestor images are read/use-only; this group and descendant images are manageable.`
                : identity?.scope === "group" && GROUP_ADMIN_BACKUP_TOOLS.has(name)
                  ? `${imageBackup?.description || "Manage a backup"} only for workers in the bound group subtree and the calling administrative workspace. Owner identity is derived server-side.`
                : identity?.scope === "group" && name.startsWith("networks.")
                  ? groupNetworkDescription(name)
                  : identity?.scope === "group" && name.startsWith("groups.")
                    ? groupStructuralDescription(name)
                    : undefined) ||
            adminStartupScriptToolDescription(name) ||
            domain?.description ||
            workspace?.description ||
            imageBackup?.description ||
            platform?.description ||
            catalog?.description ||
            exposure?.description ||
            runningFiles?.description ||
            logs?.description ||
            status?.description ||
            globalConfiguration?.description ||
            imports?.description ||
            plugin?.description ||
            `Agentor management tool (${TOOL_GROUP[name]})`,
          inputSchema:
            (identity?.scope === "group" && name === "workers.create"
              ? groupWorkerCreateInputSchema()
              : identity?.scope === "group" && GROUP_ADMIN_IMAGE_TOOLS.has(name)
                ? groupImageInputSchema(name)
                : identity?.scope === "group" && GROUP_ADMIN_BACKUP_TOOLS.has(name)
                  ? groupBackupInputSchema(name)
                : identity?.scope === "group" && name.startsWith("networks.")
                  ? groupNetworkInputSchema(name)
                  : identity?.scope === "group" && name.startsWith("groups.")
                    ? groupStructuralInputSchema(name)
                    : undefined) ||
            domain?.inputSchema ||
            workspace?.inputSchema ||
            imageBackup?.inputSchema ||
            platform?.inputSchema ||
            catalog?.inputSchema ||
            exposure?.inputSchema ||
            runningFiles?.inputSchema ||
            logs?.inputSchema ||
            status?.inputSchema ||
            globalConfiguration?.inputSchema ||
            imports?.inputSchema ||
            plugin?.inputSchema ||
            toolInputSchema(name),
          annotations:
            domain?.annotations ||
            workspace?.annotations ||
            imageBackup?.annotations ||
            platform?.annotations ||
            catalog?.annotations ||
            exposure?.annotations ||
            runningFiles?.annotations ||
            logs?.annotations ||
            status?.annotations ||
            globalConfiguration?.annotations ||
            imports?.annotations ||
            plugin?.annotations ||
            toolAnnotations(name),
        };
      });
  }
  async updatePolicy(groups: Record<string, unknown>, actor: string) {
    await this.init();
    for (const [name, value] of Object.entries(groups || {})) {
      if (!GROUPS.includes(name as Group) || typeof value !== "boolean")
        throw new Error(`Unknown or invalid policy group: ${name}`);
    }
    return this.mutate((state) => {
      for (const [name, value] of Object.entries(groups || {}))
        state.policy.groups[name as Group].enabled = value as boolean;
      state.policy.revision++;
      state.policy.updatedAt = new Date().toISOString();
      appendAudit(state, "policy.changed", "success", { actor, groups });
      return structuredClone(state.policy);
    });
  }
  async issue(workspaceId: string, ttlSeconds = 60) {
    this.pruneExpiredIdentities();
    const workspace = await useAdminWorkspaceStore().ensure();
    const groupWorkspace =
      useGroupAdminWorkspaceStore().findByWorkspaceId(workspaceId);
    if (workspace.id !== workspaceId && !groupWorkspace)
      throw Object.assign(
        new Error("Identity is restricted to the administrative workspace"),
        { statusCode: 403 },
      );
    const raw = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(raw).digest("hex");
    const expiresAt =
      Date.now() +
      Math.min(60, Number.isFinite(ttlSeconds) ? ttlSeconds : 60) * 1000;
    this.identities.set(hash, {
      hash,
      workspaceId,
      expiresAt,
      groupId: groupWorkspace?.groupId,
      ownerId: groupWorkspace?.ownerId,
    });
    return {
      credential: `mcp1.${raw}`,
      workspaceId,
      audience: "agentor-management-mcp",
      expiresAt: new Date(expiresAt).toISOString(),
      persistedInWorkspace: false,
      scope: groupWorkspace ? "group" : "platform",
      ...(groupWorkspace
        ? { groupId: groupWorkspace.groupId, ownerId: groupWorkspace.ownerId }
        : {}),
    };
  }
  private find(credential: unknown) {
    this.pruneExpiredIdentities();
    if (typeof credential !== "string" || !credential.startsWith("mcp1."))
      return;
    const digest = createHash("sha256").update(credential.slice(5)).digest();
    for (const [hash, id] of this.identities) {
      const candidate = Buffer.from(hash, "hex");
      if (
        candidate.length === digest.length &&
        timingSafeEqual(candidate, digest)
      )
        return id;
    }
  }
  private pruneExpiredIdentities(at = Date.now()) {
    for (const [hash, identity] of this.identities) {
      if (identity.expiresAt <= at) this.identities.delete(hash);
    }
  }
  async introspect(
    credential: unknown,
    workspaceId?: string,
  ): Promise<IdentityMetadata> {
    const id = this.find(credential);
    if (!id || id.expiresAt <= Date.now())
      throw Object.assign(new Error("Invalid or expired workload identity"), {
        statusCode: 401,
      });
    if (workspaceId && workspaceId !== id.workspaceId)
      throw Object.assign(new Error("Workload identity binding mismatch"), {
        statusCode: 403,
      });
    if (id.groupId) {
      const live = useGroupAdminWorkspaceStore().findByWorkspaceId(
        id.workspaceId,
      );
      if (!live || live.groupId !== id.groupId)
        throw Object.assign(
          new Error("Group administrative workspace is no longer authorized"),
          { statusCode: 403 },
        );
    }
    return {
      workspaceId: id.workspaceId,
      audience: "agentor-management-mcp",
      expiresAt: new Date(id.expiresAt).toISOString(),
      persistedInWorkspace: false,
      scope: id.groupId ? "group" : "platform",
      ...(id.groupId ? { groupId: id.groupId, ownerId: id.ownerId } : {}),
    };
  }
  async auditAuthorizationFailure(operation: string) {
    await this.auditSafely("authorization.denied", "failure", {
      operation,
      reason: "identity",
    });
  }
  async invoke(
    credential: unknown,
    tool: unknown,
    args: Record<string, unknown> = {},
  ) {
    const name = typeof tool === "string" ? tool : "";
    let identity: IdentityMetadata;
    try {
      identity = await this.introspect(credential);
    } catch (e) {
      await this.auditSafely("authorization.denied", "failure", {
        reason: "identity",
      });
      await this.auditSafely("tool.invoked", "failure", {
        tool: name,
        reason: "identity",
      });
      throw e;
    }
    try {
      await this.init();
      // Read the authoritative policy immediately before dispatch. No policy
      // decision is cached in an identity or MCP session.
      const group = TOOL_GROUP[name];
      if (!group || !this.state.policy.groups[group]?.enabled) {
        await this.auditSafely("authorization.denied", "failure", {
          workspaceId: identity.workspaceId,
          tool: name,
        });
        throw Object.assign(new Error("Tool denied by policy"), {
          statusCode: 403,
        });
      }
      if (identity.scope === "group" && name === "workers.create") {
        // A group principal never selects an owner or group. Both are derived
        // from its live workload identity, closing owner-wide confused-deputy
        // paths even when invoke() is reached outside normal schema validation.
        if (
          args.userId !== undefined ||
          args.ownerId !== undefined ||
          args.groupId !== undefined
        )
          throw groupResourceNotFound();
        args = { ...args, userId: identity.ownerId };
      }
      if (identity.scope === "group" && GROUP_ADMIN_IMAGE_TOOLS.has(name)) {
        if (args.ownerId !== undefined || args.groupId !== undefined)
          throw groupResourceNotFound();
        args = { ...args, ownerId: identity.ownerId };
      }
      if (identity.scope === "group" && GROUP_ADMIN_BACKUP_TOOLS.has(name)) {
        if (args.ownerId !== undefined)
          throw groupResourceNotFound();
        args = { ...args, ownerId: identity.ownerId };
      }
      if (identity.scope === "group" && name.startsWith("networks.")) {
        if (args.ownerId !== undefined) throw groupResourceNotFound();
        args = { ...args, ownerId: identity.ownerId };
      }
      if (identity.scope === "group" && name.startsWith("groups.")) {
        if (args.userId !== undefined || args.ownerId !== undefined)
          throw groupResourceNotFound();
        args = { ...args, userId: identity.ownerId };
        if (name === "groups.create" && args.parentId === undefined)
          args.parentId = identity.groupId;
      }
      await validateManagementOwnerArguments(args);
      if (identity.scope === "group")
        await this.authorizeGroupInvocation(identity, name, args);
      let result: unknown;
      if (name === "configuration.propose") {
        const patch = validateConfigurationProposal(args.patch);
        if (!patch)
          throw Object.assign(
            new Error("A non-secret worker configuration patch is required"),
            {
              statusCode: 400,
            },
          );
        const proposal: Proposal = {
          id: randomUUID(),
          immutable: true,
          status: "pending-dashboard-approval",
          diff: patch,
          createdAt: new Date().toISOString(),
        };
        result = await this.mutate((state) => {
          state.proposals.push(proposal);
          return structuredClone(proposal);
        });
      } else if (name === "configuration.apply") {
        result = await this.applyConfigurationProposal(args);
      } else {
        const execute = () =>
          this.executeTool(name, args, identity.workspaceId, identity);
        result =
          identity.scope === "group" &&
          GROUP_ADMIN_DIRECT_SCOPE_BOUNDARY_TOOLS.has(name)
            ? await withGroupScopeAuthorizationBoundary(
                identity.ownerId!,
                () => this.authorizeGroupInvocation(identity, name, args),
                execute,
              )
            : await execute();
      }
      await this.auditSafely("tool.invoked", "success", {
        workspaceId: identity.workspaceId,
        tool: name,
        group,
        policyRevision: this.state.policy.revision,
      });
      return result;
    } catch (error: any) {
      await this.auditSafely("tool.invoked", "failure", {
        workspaceId: identity.workspaceId,
        tool: name,
        group: TOOL_GROUP[name],
        policyRevision: this.state.policy.revision,
        statusCode: Number.isInteger(error?.statusCode)
          ? error.statusCode
          : 500,
      });
      throw error;
    }
  }
  private async applyConfigurationProposal(args: Record<string, unknown>) {
    const proposalId =
      typeof args.proposalId === "string" ? args.proposalId : "";
    const stored = this.state.proposals.find(
      (candidate) => candidate.id === proposalId,
    );
    if (!stored)
      throw Object.assign(new Error("Proposal not found"), { statusCode: 404 });
    if (stored.status === "applied")
      throw Object.assign(new Error("Proposal already applied"), {
        statusCode: 409,
      });

    const requestedPatch = stored.diff as {
      logLevel?: ReturnType<typeof useConfig>["logLevel"];
      workerId?: string;
      variables?: Array<{ key: string; value: string }>;
    };
    // Protection locks are authorization, not an application side effect. Do
    // this preflight before converting a pending proposal into durable intent;
    // the fenced execution below verifies again immediately before mutation.
    if (!requestedPatch.logLevel)
      await this.configurationApply.verifyWorkerVariables(
        requestedPatch.workerId!,
        args.lockPassword,
      );

    // Direct harness application is still permitted, but approval becomes the
    // durable intent record before another store or live configuration is
    // touched. A rejected intent write has no side effect; once it commits,
    // the exact immutable assignment is safe to retry after any later failure.
    const proposal =
      stored.status === "pending-dashboard-approval"
        ? await this.mutate((state) => {
            const current = state.proposals.find(
              (candidate) => candidate.id === proposalId,
            );
            if (!current)
              throw Object.assign(new Error("Proposal not found"), {
                statusCode: 404,
              });
            if (current.status === "applied")
              throw Object.assign(new Error("Proposal already applied"), {
                statusCode: 409,
              });
            if (current.status === "pending-dashboard-approval") {
              current.status = "approved";
              current.approvedAt = new Date().toISOString();
            }
            return structuredClone(current);
          })
        : structuredClone(stored);

    const patch = proposal.diff as {
      logLevel?: ReturnType<typeof useConfig>["logLevel"];
      workerId?: string;
      variables?: Array<{ key: string; value: string }>;
    };
    let previousLogLevel: ReturnType<typeof useConfig>["logLevel"] | undefined;
    let appliedTarget: Record<string, unknown>;
    let workerEffectCompleted = false;
    try {
      if (patch.logLevel) {
        previousLogLevel = this.configurationApply.getLogLevel();
        this.configurationApply.setLogLevel(patch.logLevel);
        appliedTarget = { setting: "logLevel" };
      } else {
        const applied = await this.configurationApply.applyWorkerVariables(
          patch.workerId!,
          patch.variables!,
          args.lockPassword,
        );
        appliedTarget = applied;
        workerEffectCompleted = true;
      }

      return await this.mutate((state) => {
        const current = state.proposals.find(
          (candidate) => candidate.id === proposal.id,
        );
        if (!current || current.status === "applied")
          throw Object.assign(new Error("Proposal already applied"), {
            statusCode: 409,
          });
        if (patch.logLevel)
          state.appliedConfiguration = {
            ...state.appliedConfiguration,
            logLevel: patch.logLevel,
          };
        current.status = "applied";
        current.approvedAt ??= new Date().toISOString();
        current.appliedAt = new Date().toISOString();
        appendAudit(state, "proposal.applied", "success", {
          proposalId: current.id,
          ...appliedTarget,
        });
        return {
          id: current.id,
          status: current.status,
          applied: true,
          pendingRebuild: patch.logLevel ? false : true,
        };
      });
    } catch (error) {
      if (patch.logLevel && previousLogLevel !== undefined)
        this.configurationApply.setLogLevel(previousLogLevel);
      // The proposal remains durably approved. Worker-variable application is
      // an exact replacement plus an idempotent rebuild marker, so retrying the
      // same immutable proposal completes rather than duplicating a mutation.
      if (
        !patch.logLevel &&
        (workerEffectCompleted ||
          (error as any)?.configurationEffectMayHaveApplied === true) &&
        this.state.proposals.some(
          (candidate) =>
            candidate.id === proposal.id && candidate.status === "approved",
        )
      )
        throw Object.assign(
          new Error(
            "Configuration application is incomplete; retry the same proposal",
          ),
          {
            statusCode: 503,
            code: "CONFIGURATION_APPLICATION_RETRY_REQUIRED",
            cause: error,
          },
        );
      throw error;
    }
  }

  private async auditSafely(
    action: string,
    outcome: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit(action, outcome, details);
    } catch (error) {
      // Audit durability is important operationally, but it is not the commit
      // point of the already completed management operation. Returning an
      // error here would invite a retry of a non-idempotent mutation.
      useLogger().error(
        `[management-mcp] audit persistence failed after ${action}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async uploadImport(
    credential: unknown,
    token: string,
    source: Readable,
    declaredLength?: number,
  ) {
    let identity;
    try {
      identity = await this.introspect(credential);
    } catch (error) {
      await this.auditAuthorizationFailure("import.upload");
      throw error;
    }
    try {
      await this.init();
      if (!this.state.policy.groups.exports.enabled)
        throw Object.assign(new Error("Tool denied by policy"), {
          statusCode: 403,
        });
      const result = await importDomain.upload(
        identity.workspaceId,
        token,
        source,
        declaredLength,
      );
      await this.auditSafely("import.uploaded", "success", {
        workspaceId: identity.workspaceId,
      });
      return result;
    } catch (error: any) {
      await this.auditSafely("import.uploaded", "failure", {
        workspaceId: identity.workspaceId,
        statusCode: error?.statusCode || 500,
      });
      throw error;
    }
  }
  async openDownload(
    credential: unknown,
    token: string,
  ): Promise<OpenedManagementDownload> {
    let identity: IdentityMetadata;
    try {
      identity = await this.introspect(credential);
    } catch (error) {
      await this.auditAuthorizationFailure("download.open");
      throw error;
    }
    try {
      await this.init();
      const opened = await downloadDomain.open(
        identity.workspaceId,
        token,
        async (prepared) => {
          // Handoffs can outlive the MCP call that prepared them, so consult
          // the authoritative policy again at redemption time.
          if (!this.state.policy.groups[prepared.capability]?.enabled)
            throw Object.assign(new Error("Tool denied by policy"), {
              statusCode: 403,
            });
          if (identity.scope === "group") {
            const ids = this.groupWorkerIds(identity);
            if (prepared.kind === "workspace") {
              if (!ids.has(prepared.workspaceId))
                throw Object.assign(
                  new Error(
                    "Download target is outside the administrative group scope",
                  ),
                  { statusCode: 403 },
                );
            } else {
              const job = await useExportJobManager().get(prepared.jobId);
              if (
                !job ||
                !ids.has(job.workerId) ||
                job.userId !== identity.ownerId
              )
                throw Object.assign(
                  new Error(
                    "Download target is outside the administrative group scope",
                  ),
                  { statusCode: 403 },
                );
            }
          }
        },
      );
      await this.auditSafely("download.opened", "success", {
        ...opened.audit,
      });
      return opened;
    } catch (error: any) {
      await this.auditSafely("download.opened", "failure", {
        workspaceId: identity.workspaceId,
        statusCode: Number.isInteger(error?.statusCode)
          ? error.statusCode
          : 500,
      });
      throw error;
    }
  }
  async auditDownloadTransfer(
    audit: OpenedManagementDownload["audit"],
    outcome: "success" | "failure",
  ) {
    await this.auditSafely("download.transferred", outcome, audit);
  }
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    workspaceId: string,
    identity?: IdentityMetadata,
  ): Promise<any> {
    // Validate the MCP envelope before entering any domain manager. In
    // particular, missing ownerId must not trigger backup/image store
    // initialization or compatibility lookups that can take minutes.
    validateToolArguments(name, args);
    if (
      name === "admin-workspace.startup-script.get" ||
      name === "admin-workspace.startup-script.set"
    ) {
      if (!identity) throw statusError(401, "Administrative identity required");
      const operation = async () => {
        if (identity.scope === "group") {
          const store = useGroupAdminWorkspaceStore();
          const groupId = identity.groupId!;
          return name.endsWith(".get")
            ? store.getStartupScript(groupId)
            : store.setStartupScript(groupId, args.startupScript);
        }
        const store = useAdminWorkspaceStore();
        return name.endsWith(".get")
          ? store.getStartupScript()
          : store.setStartupScript(args.startupScript);
      };
      return withinManagementFailFastDeadline(
        operation,
        managementFailFastTimeoutSeconds(args.timeoutSeconds),
        name,
      );
    }
    if (identity?.scope === "group" && name === "workers.create")
      // The caller is released at its explicit deadline, while the serialized
      // create/enrol/rollback workflow continues to completion so a timeout
      // can never strand an owner-wide worker outside the authorized group.
      return withinManagementFailFastDeadline(
        () => this.createGroupWorker(identity, args),
        managementFailFastTimeoutSeconds(args.timeoutSeconds),
        name,
      );
    if (identity?.scope === "group" && name === "groups.assign-worker") {
      const ownerId = identity.ownerId!;
      const authorityGroupId = identity.groupId!;
      return withinManagementFailFastDeadline(
        () =>
          assignWorkerToGroupWithNetworks(
            ownerId,
            String(args.workerId),
            String(args.targetGroupId),
            args.lockPasswords,
            (sourceGroupId, targetGroupId) => {
              const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
              if (
                !sourceGroupId ||
                !targetGroupId ||
                !hierarchy.canAdminister(
                  ownerId,
                  authorityGroupId,
                  sourceGroupId,
                ) ||
                !hierarchy.canAdminister(
                  ownerId,
                  authorityGroupId,
                  targetGroupId,
                )
              )
                throw groupResourceNotFound();
            },
          ),
        managementFailFastTimeoutSeconds(args.timeoutSeconds),
        name,
      );
    }
    if (identity?.scope === "group" && GROUP_ADMIN_IMAGE_TOOLS.has(name))
      return this.executeGroupImageTool(identity, name, args);
    if (identity?.scope === "group" && name.startsWith("plugins.")) {
      const targetWorkerId =
        typeof args.workerId === "string" ? args.workerId : "";
      // Authorize before the plugin domain performs any lookup or returns any
      // metadata. Unknown and out-of-subtree worker IDs are indistinguishable.
      if (!targetWorkerId || !this.groupWorkerIds(identity).has(targetWorkerId))
        throw groupResourceNotFound();
    }
    if (
      identity?.scope === "group" &&
      (name === "groups.create" || GROUP_ADMIN_GROUP_TOOLS.has(name))
    ) {
      const ownerId = identity.ownerId!;
      const authorityGroupId = identity.groupId!;
      const targetGroupId =
        name === "groups.create" ? undefined : String(args.groupId);
      const requestedParent = args.parentId;
      args.__scopeAuthorize = () => {
        const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
        if (
          (targetGroupId &&
            !hierarchy.canAdminister(
              ownerId,
              authorityGroupId,
              targetGroupId,
            )) ||
          (requestedParent !== undefined &&
            (targetGroupId === authorityGroupId ||
              typeof requestedParent !== "string" ||
              !hierarchy.canAdminister(
                ownerId,
                authorityGroupId,
                requestedParent,
              )))
        )
          throw groupResourceNotFound();
      };
    }
    if (
      identity?.scope === "group" &&
      (name === "networks.create" ||
        (GROUP_ADMIN_NETWORK_TOOLS.has(name) && name !== "networks.inspect"))
    ) {
      const ownerId = identity.ownerId!;
      const authorityGroupId = identity.groupId!;
      args.__scopeAuthorize = () => {
        const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
        if (name === "networks.create") {
          if (
            args.scope !== "group" ||
            typeof args.groupId !== "string" ||
            !hierarchy.canAdminister(ownerId, authorityGroupId, args.groupId)
          )
            throw groupResourceNotFound();
          return;
        }
        const network = useManagedNetworkStore().findById(
          String(args.networkId || ""),
        );
        if (
          !network ||
          network.userId !== ownerId ||
          network.scope !== "group" ||
          !network.groupId ||
          !hierarchy.canAdminister(ownerId, authorityGroupId, network.groupId)
        )
          throw groupResourceNotFound();
        const prospectiveGroupId =
          typeof args.groupId === "string" ? args.groupId : network.groupId;
        const prospectiveScope =
          typeof args.scope === "string" ? args.scope : network.scope;
        if (
          prospectiveScope !== "group" ||
          !hierarchy.canAdminister(
            ownerId,
            authorityGroupId,
            prospectiveGroupId,
          )
        )
          throw groupResourceNotFound();
      };
    }
    const domain = await workerDomain.execute(name, args);
    if (domain.handled) {
      if (identity?.scope === "group" && name === "groups.list") {
        const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
        const allowed = new Set(
          hierarchy
            .descendants(identity.ownerId!, identity.groupId!, true)
            .map((group) => group.id),
        );
        return (domain.result as any[]).filter((group) =>
          allowed.has(group.id),
        );
      }
      return domain.result;
    }
    const imageBackup = await imageBackupDomain.execute(
      name,
      await compatibleDomainArguments(name, args),
    );
    if (imageBackup.handled) return imageBackup.result;
    const platform = await platformDomain.execute(name, args);
    if (platform.handled) {
      if (identity?.scope === "group" && name === "networks.list") {
        const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
        const allowed = new Set(
          hierarchy
            .descendants(identity.ownerId!, identity.groupId!, true)
            .map((group) => group.id),
        );
        return (platform.result as any[]).filter(
          (network) =>
            network.scope === "group" && allowed.has(network.groupId),
        );
      }
      return platform.result;
    }
    const catalog = await catalogDomain.execute(name, args);
    if (catalog.handled) return catalog.result;
    const exposure = await exposureDomain.execute(name, args);
    if (exposure.handled) return exposure.result;
    const runningFiles = await runningFilesDomain.execute(name, args);
    if (runningFiles.handled) return runningFiles.result;
    const logs = await logsDomain.execute(name, args);
    if (logs.handled) return logs.result;
    const status = await statusDomain.execute(name, args);
    if (status.handled) return status.result;
    const globalConfiguration = await globalConfigurationDomain.execute(
      name,
      args,
    );
    if (globalConfiguration.handled) return globalConfiguration.result;
    const imported = await importDomain.execute(name, args, workspaceId);
    if (imported.handled) return imported.result;
    const plugin = await withinManagementFailFastDeadline(
      () => pluginDomain.execute(name, args, identity),
      managementFailFastTimeoutSeconds(args.timeoutSeconds),
      name,
    );
    if (plugin.handled) return plugin.result;
    const download = await downloadDomain.execute(name, args, workspaceId);
    if (download.handled) return download.result;
    if (workspaceMcpTools.some((tool) => tool.name === name)) {
      const result = await executeWorkspaceMcpTool(name, args);
      if (name === "workspaces.list" && identity?.scope === "group") {
        const ids = this.groupWorkerIds(identity);
        return {
          workspaces: result.workspaces.filter((item: any) => ids.has(item.id)),
        };
      }
      return result;
    }
    const workerId = typeof args.workerId === "string" ? args.workerId : "";
    const worker = workerId
      ? (useContainerManager().get(workerId) ??
        useWorkerStore().findById(workerId))
      : undefined;
    const visibleWorkers = () =>
      identity?.scope === "group"
        ? this.groupWorkers(identity)
        : [...useContainerManager().list(), ...useWorkerStore().listArchived()];
    if (name === "status.system")
      return {
        status: "ok",
        workers: visibleWorkers().filter(
          (item: any) => item.status !== "archived",
        ).length,
        archived: visibleWorkers().filter(
          (item: any) => item.status === "archived" || item.archivedAt,
        ).length,
      };
    if (name === "workers.list")
      return {
        workers: [...visibleWorkers()].map(publicWorker),
      };
    if (name === "workers.inspect") {
      if (!worker) throw statusError(404, "Worker not found");
      return publicWorker(worker);
    }
    if (name === "volumes.list")
      return {
        workspaces: (await listWorkspaceInventory(true))
          .filter(
            (item) =>
              identity?.scope !== "group" ||
              this.groupWorkerIds(identity).has(item.id),
          )
          .map(publicWorkspaceInventoryItem),
      };
    if (name === "volumes.list-files") {
      const item = (await listWorkspaceInventory(true)).find(
        (candidate) => candidate.id === args.workspaceId,
      );
      if (!item || item.state === "orphaned")
        throw statusError(404, "Workspace not found or not adopted");
      return new OfflineWorkspaceAccess(item).list(args.path ?? "");
    }
    if (name === "configuration.inspect") {
      if (!worker) throw statusError(404, "Worker not found");
      return stripValues(await workerConfigurationResponse(worker));
    }
    if (name === "worker.stop" || name === "worker.start") {
      if (!worker) throw statusError(404, "Worker not found");
      await useWorkerProtectionLockStore().verify(worker.id, args.lockPassword);
      if (name === "worker.stop") await useContainerManager().stop(worker.id);
      else await useContainerManager().restart(worker.id);
      return { workerId: worker.id, requested: name };
    }
    if (name.startsWith("console.")) {
      const consoles = useManagementConsoleStore();
      if (name === "console.open") {
        if (!worker) throw statusError(404, "Worker not found");
        return consoles.open(
          workspaceId,
          worker.id,
          Number(args.windowIndex ?? 0),
        );
      }
      const sessionId = String(args.sessionId || "");
      if (!sessionId) throw statusError(400, "sessionId required");
      if (name === "console.read")
        return consoles.read(
          workspaceId,
          sessionId,
          Number.isInteger(args.from) ? Number(args.from) : undefined,
        );
      if (name === "console.write")
        return consoles.write(
          workspaceId,
          sessionId,
          typeof args.input === "string" ? args.input : "",
        );
      if (name === "console.interrupt")
        return consoles.interrupt(workspaceId, sessionId);
      if (name === "console.close")
        return consoles.close(workspaceId, sessionId);
    }
    if (name === "exports.create") {
      if (!worker) throw statusError(404, "Worker not found");
      return useExportJobManager().create(
        worker.userId,
        worker.id,
        args.includeRootfs === true,
      );
    }
    if (name === "exports.status" || name === "exports.cancel") {
      const job = await useExportJobManager().get(String(args.jobId || ""));
      if (!job) throw statusError(404, "Export job not found");
      return name === "exports.cancel"
        ? useExportJobManager().cancel(job)
        : job;
    }
    if (name === "backups.create") {
      const ids = Array.isArray(args.workspaceIds)
        ? args.workspaceIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      if (!ids.length) throw statusError(400, "workspaceIds required");
      const first = useContainerManager().get(ids[0]!);
      if (!first) throw statusError(404, "Workspace not found");
      return useBackupManager().createMany(first.userId, ids);
    }
    if (name === "backups.status" || name === "backups.cancel") {
      const job = await useBackupManager().getJob(String(args.jobId || ""));
      if (!job) throw statusError(404, "Backup job not found");
      return name === "backups.cancel" ? useBackupManager().cancel(job) : job;
    }
    if (name === "images.validate")
      return useImageCatalogManager().validate(args.definition);
    if (name === "images.build") {
      const catalog = useImageCatalogManager();
      await catalog.init();
      const definition = catalog.definition(
        String(args.definitionId || ""),
        "",
        true,
      );
      return catalog.startBuild(definition.id, definition.ownerId, true, {
        builder: "controlled",
      });
    }
    if (name === "images.build-status") {
      const catalog = useImageCatalogManager();
      await catalog.init();
      return catalog.publicBuild(String(args.buildId || ""), "", true);
    }
    return { result: "redacted", workspaceId };
  }
  private async createGroupWorker(
    identity: IdentityMetadata,
    args: Record<string, unknown>,
  ) {
    if (!identity.groupId || !identity.ownerId) throw groupResourceNotFound();
    // Re-read the live group before creation and again while enrolling it.
    // The normal group/network coordinator serializes membership changes and
    // reconciles dependent networks before this call returns.
    const groups = useWorkerGroupStore();
    const hierarchy = new WorkerGroupHierarchy(groups);
    const targetGroupId =
      typeof args.targetGroupId === "string"
        ? args.targetGroupId
        : identity.groupId;
    if (
      !hierarchy.canAdminister(
        identity.ownerId,
        identity.groupId,
        targetGroupId,
      )
    )
      throw groupResourceNotFound();
    const group = groups.get(identity.ownerId, targetGroupId);
    if (!group) throw groupResourceNotFound();
    if (args.excludedGroupEnvVarKeys !== undefined) {
      const { publicGroupEnvKeys } = await import("./worker-group-env");
      const allowed = new Set(
        (await publicGroupEnvKeys(identity.ownerId, targetGroupId))
          .effectiveKeys,
      );
      if (
        !Array.isArray(args.excludedGroupEnvVarKeys) ||
        args.excludedGroupEnvVarKeys.some(
          (key) => typeof key !== "string" || !allowed.has(key),
        )
      )
        throw statusError(400, "Unknown group environment variable key");
    }
    const usableImageGroups = hierarchy
      .ancestors(identity.ownerId, targetGroupId, true)
      .map((item) => item.id);
    const created = await workerDomain.execute("workers.create", {
      ...args,
      targetGroupId: undefined,
      __targetWorkerGroupId: targetGroupId,
      imageCatalogGroupIds: usableImageGroups,
    });
    const worker = created.result as { id?: string } | undefined;
    if (!created.handled || !worker?.id)
      throw statusError(500, "Group worker creation failed");
    try {
      await addWorkerToGroupWithNetworks(
        identity.ownerId,
        targetGroupId,
        worker.id,
        args.lockPasswords,
        () => {
          const liveHierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
          if (
            !liveHierarchy.canAdminister(
              identity.ownerId!,
              identity.groupId!,
              targetGroupId,
            )
          )
            throw groupResourceNotFound();
        },
      );
      return worker;
    } catch (error) {
      // Never leave a successfully-created owner-wide worker behind when its
      // mandatory group enrollment/reconciliation did not complete.
      let cleanupFailure: unknown;
      try {
        await useContainerManager().remove(worker.id);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      if (cleanupFailure)
        throw statusError(
          500,
          `Group worker enrollment failed and rollback requires operator cleanup: ${worker.id}`,
        );
      throw error;
    }
  }
  private async executeGroupImageTool(
    identity: IdentityMetadata,
    name: string,
    args: Record<string, unknown>,
    serialized = false,
  ): Promise<any> {
    if (!identity.ownerId || !identity.groupId) throw groupResourceNotFound();
    const mutations = new Set([
      "images.create",
      "images.update",
      "images.delete",
      "images.delete-version",
      "images.build",
      "images.build-cancel",
      "images.promote",
      "images.rollback",
    ]);
    if (!serialized && mutations.has(name))
      return withGroupImageMutationBoundary(identity.ownerId, () =>
        this.executeGroupImageTool(identity, name, args, true),
      );
    const groups = useWorkerGroupStore();
    const liveGroup = groups.findById(identity.groupId);
    if (!liveGroup || liveGroup.userId !== identity.ownerId)
      throw groupResourceNotFound();
    const catalog = useImageCatalogManager();
    await catalog.init();
    const ownerId = identity.ownerId;
    const hierarchy = new WorkerGroupHierarchy(groups);
    const manageableIds = new Set(
      hierarchy
        .descendants(ownerId, identity.groupId, true)
        .map((group) => group.id),
    );
    const ancestorIds = hierarchy
      .ancestors(ownerId, identity.groupId)
      .map((group) => group.id);
    const groupId =
      typeof args.targetGroupId === "string"
        ? args.targetGroupId
        : identity.groupId;
    if (!manageableIds.has(groupId)) throw groupResourceNotFound();
    const definitionId = String(args.definitionId || "");
    const buildId = String(args.buildId || "");
    if (name === "images.list")
      return catalog
        .listForGroupHierarchy(
          ownerId,
          [...ancestorIds, ...manageableIds],
          manageableIds,
        )
        .map((definition) => ({
          ...definition,
          access: {
            ...definition.access,
            owningGroupPath: definition.groupId
              ? hierarchy
                  .ancestors(ownerId, definition.groupId, true)
                  .reverse()
                  .map((group) => ({ id: group.id, name: group.name }))
              : [],
          },
        }));
    if (name === "images.validate") return catalog.validate(args.definition);
    if (name === "images.create")
      return catalog.createForGroup(ownerId, groupId, args.definition);
    const visibleIds = new Set([...ancestorIds, ...manageableIds]);
    const readableDefinition = () => {
      const definition = catalog
        .list(ownerId, true)
        .find(
          (item) =>
            item.id === definitionId &&
            item.ownerId === ownerId &&
            (!item.groupId || visibleIds.has(item.groupId)),
        );
      if (!definition) throw groupResourceNotFound();
      return definition;
    };
    const manageableDefinition = () => {
      const definition = readableDefinition();
      if (!definition.groupId || !manageableIds.has(definition.groupId))
        throw groupResourceNotFound();
      return definition;
    };
    if (name === "images.get") {
      const visible = catalog.listForGroupHierarchy(
        ownerId,
        [...ancestorIds, ...manageableIds],
        manageableIds,
      );
      const definition = visible.find((item) => item.id === definitionId);
      if (!definition) throw groupResourceNotFound();
      return {
        ...definition,
        access: {
          ...definition.access,
          owningGroupPath: definition.groupId
            ? hierarchy
                .ancestors(ownerId, definition.groupId, true)
                .reverse()
                .map((group) => ({ id: group.id, name: group.name }))
            : [],
        },
      };
    }
    if (name === "images.update") {
      const definition = manageableDefinition();
      return catalog.updateForGroup(
        definitionId,
        ownerId,
        definition.groupId!,
        args.definition,
      );
    }
    if (
      [
        "images.build-status",
        "images.build-logs",
        "images.build-cancel",
      ].includes(name)
    ) {
      const build = catalog.build(buildId, ownerId, true);
      if (!build.groupId || !manageableIds.has(build.groupId))
        throw groupResourceNotFound();
      if (name === "images.build-status")
        return catalog.publicBuild(buildId, ownerId, true);
      if (name === "images.build-logs")
        return {
          logs: catalog.logs(buildId, ownerId, true, Number(args.after || 0)),
        };
      return catalog.cancelBuild(buildId, ownerId, true);
    }
    manageableDefinition();
    if (name === "images.build")
      return catalog.startBuild(definitionId, ownerId, true, {
        builder: args.builder === "fake" ? "fake" : "controlled",
        baseImage: args.baseImage,
      });
    if (name === "images.delete") {
      await catalog.removeDefinition(definitionId, ownerId, true);
      return { deleted: true };
    }
    const version = String(args.version || "");
    if (name === "images.delete-version") {
      await catalog.deleteVersion(definitionId, version, ownerId, true);
      return { deleted: true };
    }
    if (name === "images.promote")
      return catalog.promote(definitionId, version, ownerId, true);
    if (name === "images.rollback")
      return catalog.rollback(definitionId, version, ownerId, true);
    throw statusError(
      403,
      "Tool is unavailable to group administrative workspaces",
    );
  }
  private groupWorkerIds(identity: IdentityMetadata) {
    const group = identity.groupId
      ? useWorkerGroupStore().findById(identity.groupId)
      : undefined;
    if (!group || group.userId !== identity.ownerId)
      throw Object.assign(new Error("Group scope is no longer valid"), {
        statusCode: 403,
      });
    const owned = new Set(
      [...useContainerManager().list(), ...useWorkerStore().listArchived()]
        .filter((worker) => worker.userId === identity.ownerId)
        .map((worker) => worker.id),
    );
    const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
    return new Set(
      hierarchy
        .subtreeWorkerIds(identity.ownerId!, group.id)
        .filter((id) => owned.has(id)),
    );
  }
  private groupWorkers(identity: IdentityMetadata) {
    const ids = this.groupWorkerIds(identity);
    return [
      ...useContainerManager().list(),
      ...useWorkerStore().listArchived(),
    ].filter(
      (worker) => ids.has(worker.id) && worker.userId === identity.ownerId,
    );
  }
  private async authorizeGroupInvocation(
    identity: IdentityMetadata,
    name: string,
    args: Record<string, unknown>,
  ) {
    if (!GROUP_ADMIN_TOOLS.has(name))
      throw Object.assign(
        new Error("Tool is unavailable to group administrative workspaces"),
        { statusCode: 403 },
      );
    if (
      (args.ownerId !== undefined && args.ownerId !== identity.ownerId) ||
      (args.userId !== undefined && args.userId !== identity.ownerId)
    )
      throw groupResourceNotFound();
    const ids = this.groupWorkerIds(identity);
    // Administrative workspaces are intentionally absent from workers.list,
    // but their own group admin workspace is a valid backup/path-browsing
    // target. Keep that exception narrow so it cannot widen ordinary worker
    // inspection or lifecycle scope.
    const backupIds = new Set(ids);
    if (GROUP_ADMIN_BACKUP_TOOLS.has(name)) {
      const self = useContainerManager().get(identity.workspaceId);
      if (self?.administrativeKind === "group")
        backupIds.add(identity.workspaceId);
    }
    if (name === "groups.create") {
      const parentId = typeof args.parentId === "string" ? args.parentId : "";
      const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
      if (
        !hierarchy.canAdminister(identity.ownerId!, identity.groupId!, parentId)
      )
        throw groupResourceNotFound();
      return;
    }
    if (GROUP_ADMIN_GROUP_TOOLS.has(name)) {
      const targetId = String(args.groupId || "");
      const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
      if (
        !hierarchy.canAdminister(identity.ownerId!, identity.groupId!, targetId)
      )
        throw groupResourceNotFound();
      if (name === "groups.delete" && targetId === identity.groupId)
        throw groupResourceNotFound();
      // Direct membership replacement is an owner-wide primitive: accepting
      // arbitrary same-owner IDs here would let a subtree principal enroll a
      // sibling/ungrouped worker and thereby grant itself access. Group
      // principals must use groups.assign-worker, whose source and target are
      // both scope checked.
      if (name === "groups.update" && args.workerIds !== undefined)
        throw groupResourceNotFound();
      if (
        args.parentId !== undefined &&
        (targetId === identity.groupId ||
          typeof args.parentId !== "string" ||
          !hierarchy.canAdminister(
            identity.ownerId!,
            identity.groupId!,
            args.parentId,
          ))
      )
        throw groupResourceNotFound();
      return;
    }
    if (GROUP_ADMIN_ASSIGN_TOOLS.has(name)) {
      const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
      if (
        !ids.has(String(args.workerId || "")) ||
        typeof args.targetGroupId !== "string" ||
        !hierarchy.canAdminister(
          identity.ownerId!,
          identity.groupId!,
          args.targetGroupId,
        )
      )
        throw groupResourceNotFound();
      return;
    }
    if (name === "networks.create") {
      const targetGroupId =
        typeof args.groupId === "string" ? args.groupId : "";
      const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
      if (
        args.scope !== "group" ||
        !hierarchy.canAdminister(
          identity.ownerId!,
          identity.groupId!,
          targetGroupId,
        )
      )
        throw groupResourceNotFound();
      return;
    }
    if (GROUP_ADMIN_NETWORK_TOOLS.has(name)) {
      const network = useManagedNetworkStore().findById(
        String(args.networkId || ""),
      );
      const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
      if (
        !network ||
        network.userId !== identity.ownerId ||
        network.scope !== "group" ||
        !network.groupId ||
        !hierarchy.canAdminister(
          identity.ownerId!,
          identity.groupId!,
          network.groupId,
        )
      )
        throw groupResourceNotFound();
      if (args.scope !== undefined && args.scope !== "group")
        throw groupResourceNotFound();
      if (
        typeof args.groupId === "string" &&
        !hierarchy.canAdminister(
          identity.ownerId!,
          identity.groupId!,
          args.groupId,
        )
      )
        throw groupResourceNotFound();
      return;
    }
    if (name === "workers.create" || GROUP_ADMIN_TARGET_FREE_TOOLS.has(name))
      return;
    if (GROUP_ADMIN_EXPORT_JOB_TOOLS.has(name)) {
      const job = await useExportJobManager().get(String(args.jobId || ""));
      if (!job || !ids.has(job.workerId)) throw groupResourceNotFound();
      return;
    }
    if (GROUP_ADMIN_BACKUP_JOB_TOOLS.has(name)) {
      const job = await useBackupManager().getJob(String(args.jobId || ""));
      const targets =
        job?.workspaceIds ?? (job?.workspaceId ? [job.workspaceId] : []);
      if (!job || !targets.length || targets.some((id) => !backupIds.has(id)))
        throw groupResourceNotFound();
      return;
    }
    if (GROUP_ADMIN_CONSOLE_SESSION_TOOLS.has(name)) {
      const sessionId =
        typeof args.sessionId === "string" ? args.sessionId : "";
      const target = useManagementConsoleStore().target(
        identity.workspaceId,
        sessionId,
      );
      if (!target || !ids.has(target)) {
        if (target)
          void useManagementConsoleStore()
            .close(identity.workspaceId, sessionId)
            .catch(() => undefined);
        throw groupResourceNotFound();
      }
      return;
    }
    if (!GROUP_ADMIN_DIRECT_TARGET_TOOLS.has(name))
      throw Object.assign(new Error("Tool is unavailable"), {
        statusCode: 403,
      });
    for (const key of ["workerId", "workspaceId"] as const)
      if (typeof args[key] === "string" && !(GROUP_ADMIN_BACKUP_TOOLS.has(name) ? backupIds : ids).has(args[key] as string))
        throw groupResourceNotFound();
    for (const key of ["workerIds", "workspaceIds"] as const)
      if (
        Array.isArray(args[key]) &&
        (args[key] as unknown[]).some(
          (value) => typeof value !== "string" || !(GROUP_ADMIN_BACKUP_TOOLS.has(name) ? backupIds : ids).has(value),
        )
      )
        throw groupResourceNotFound();
    if (name === "backups.create" && args.selectedPathsByWorkspace && typeof args.selectedPathsByWorkspace === "object" && !Array.isArray(args.selectedPathsByWorkspace)) {
      for (const id of Object.keys(args.selectedPathsByWorkspace as Record<string, unknown>))
        if (!backupIds.has(id)) throw groupResourceNotFound();
    }
  }
  async approve(id: string, actor: string) {
    await this.init();
    return this.mutate((state) => {
      const p = state.proposals.find((x) => x.id === id);
      if (!p)
        throw Object.assign(new Error("Proposal not found"), {
          statusCode: 404,
        });
      if (p.status !== "pending-dashboard-approval")
        throw Object.assign(new Error("Proposal is not pending"), {
          statusCode: 409,
        });
      p.status = "approved";
      p.approvedAt = new Date().toISOString();
      appendAudit(state, "proposal.approved", "success", {
        proposalId: id,
        actor,
      });
      return structuredClone(p);
    });
  }
  async immutableUpdate(id: string) {
    await this.init();
    if (!this.state.proposals.some((x) => x.id === id))
      throw Object.assign(new Error("Proposal not found"), { statusCode: 404 });
    throw Object.assign(new Error("Proposals are immutable"), {
      statusCode: 409,
    });
  }
  async listProposals() {
    await this.init();
    return structuredClone(this.state.proposals).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  async audit(
    action: string,
    outcome: string,
    details?: Record<string, unknown>,
  ) {
    await this.init();
    await this.mutate((state) => {
      appendAudit(state, action, outcome, details);
    });
  }
  async listAudit(limit = 100) {
    await this.init();
    return structuredClone(
      this.state.audit.slice(-Math.max(1, Math.min(500, limit))).reverse(),
    );
  }
}
let singleton: ManagementMcpStore | undefined;
export function useManagementMcpStore() {
  return (singleton ??= new ManagementMcpStore());
}

function statusError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
function groupResourceNotFound() {
  return statusError(404, "Resource not found");
}
/** Shares the owner hierarchy-mutation queue so a group image operation can
 * rebuild and authorize its live subtree only after earlier reparenting has
 * settled. Exported for deterministic queue-boundary regression coverage. */
export function withGroupImageMutationBoundary<T>(
  ownerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withWorkerNetworkMutation(ownerId, operation);
}
/** Direct worker/resource operations share the hierarchy mutation queue and
 * re-authorize only after all earlier reparenting or membership changes have
 * settled. Group/image/network mutation paths are deliberately excluded
 * because their domain managers already acquire this non-reentrant queue. */
export function withGroupScopeAuthorizationBoundary<T>(
  ownerId: string,
  authorize: () => void | Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  return withWorkerNetworkMutation(ownerId, async () => {
    await authorize();
    return operation();
  });
}
function groupWorkerCreateInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      displayName: { type: "string" },
      environmentId: { type: "string" },
      imageDefinitionId: { type: "string" },
      imageVersion: { type: "string" },
      targetGroupId: {
        type: "string",
        description:
          "This administrative group or one of its descendants. Defaults to this group.",
      },
      excludedGlobalEnvVarKeys: {
        type: "array",
        items: { type: "string" },
        description: "Names-only account variable exclusions.",
      },
      excludedGroupEnvVarKeys: {
        type: "array",
        items: { type: "string" },
        description: "Names-only effective group variable exclusions.",
      },
      timeoutSeconds: {
        type: "integer",
        minimum: 1,
        maximum: 120,
        description:
          "Server-side fail-fast deadline in seconds (default 30; 1-120). Returns a structured 504 MCP error when exceeded; safe enrollment or rollback continues serialized in the background.",
      },
      lockPasswords: {
        type: "object",
        additionalProperties: { type: "string", writeOnly: true },
        description:
          "Passwords for protected existing group members when a dependent managed network must be reconciled.",
      },
    },
  };
}
function groupImageInputSchema(name: string): Record<string, unknown> {
  const source = imageBackupDomain.tools().find((tool) => tool.name === name)
    ?.inputSchema as any;
  if (name === "images.update") {
    const create = imageBackupDomain
      .tools()
      .find((tool) => tool.name === "images.create")?.inputSchema as any;
    return {
      ...structuredClone(create),
      required: ["definitionId", "definition"],
      properties: {
        ...structuredClone(create?.properties || {}),
        ownerId: undefined,
        definitionId: {
          type: "string",
          minLength: 1,
          description:
            "A definition in this worker group's private image catalog.",
        },
      },
    };
  }
  const schema = structuredClone(source || { type: "object", properties: {} });
  schema.required = (schema.required || []).filter(
    (key: string) => key !== "ownerId",
  );
  if (schema.properties) {
    delete schema.properties.ownerId;
    delete schema.properties.system;
    if (name === "images.create")
      schema.properties.targetGroupId = {
        type: "string",
        description:
          "The group that will own this image: this administrative group or one of its descendants. Defaults to this group.",
      };
  }
  schema.description =
    "This operation is scoped by the calling administrative workspace. Global and ancestor images are readable/use-only; images owned by this group or descendants are manageable. Sibling and unrelated definitions are never addressable.";
  return schema;
}
function groupNetworkInputSchema(name: string): Record<string, unknown> {
  const source = platformDomain.tools().find((tool) => tool.name === name)
    ?.inputSchema as any;
  const schema = structuredClone(source || { type: "object", properties: {} });
  schema.required = (schema.required || []).filter(
    (key: string) => key !== "ownerId",
  );
  if (schema.properties) delete schema.properties.ownerId;
  schema.description = groupNetworkDescription(name);
  return schema;
}
function groupNetworkDescription(name: string): string {
  const action =
    name === "networks.list"
      ? "List"
      : name === "networks.inspect"
        ? "Inspect"
        : name === "networks.create"
          ? "Create"
          : name === "networks.update"
            ? "Update"
            : name === "networks.reconcile"
              ? "Reconcile"
              : name === "networks.delete"
                ? "Delete"
                : "Manage";
  return `${action} only group-scoped managed networks belonging to the bound administrative group or a live descendant.`;
}
function groupBackupInputSchema(name: string): Record<string, unknown> {
  const source = imageBackupDomain.tools().find((tool) => tool.name === name)
    ?.inputSchema as any;
  const schema = structuredClone(source || { type: "object", properties: {} });
  schema.required = (schema.required || []).filter(
    (key: string) => key !== "ownerId",
  );
  if (schema.properties) delete schema.properties.ownerId;
  schema.description =
    "This operation is scoped by the calling administrative workspace. Worker IDs and selected paths must belong to the bound group subtree; the owner is derived from the authenticated identity.";
  return schema;
}
function groupStructuralInputSchema(name: string): Record<string, unknown> {
  const source = workerDomain.tools().find((tool) => tool.name === name)
    ?.inputSchema as any;
  const schema = structuredClone(source || { type: "object", properties: {} });
  schema.required = (schema.required || []).filter(
    (key: string) => key !== "userId",
  );
  if (schema.properties) delete schema.properties.userId;
  if (name === "groups.update" && schema.properties)
    delete schema.properties.workerIds;
  if (name === "groups.assign-worker") {
    schema.required = ["workerId", "targetGroupId"];
    schema.properties.targetGroupId = {
      type: "string",
      description:
        "This administrative group or a descendant; group admins cannot ungroup workers.",
    };
  }
  schema.description = groupStructuralDescription(name);
  return schema;
}
function groupStructuralDescription(name: string): string {
  const descriptions: Record<string, string> = {
    "groups.list":
      "List only the bound administrative group and its live descendants.",
    "groups.create":
      "Create a child group beneath the bound administrative group or one of its live descendants. parentId defaults to the bound group.",
    "groups.update":
      "Rename an authorized group or reparent a descendant within the authorized subtree. Direct membership replacement is intentionally unavailable; use groups.assign-worker. The bound administrative group itself cannot be moved.",
    "groups.delete":
      "Delete an empty descendant group. The bound administrative group itself cannot be deleted.",
    "groups.assign-worker":
      "Move a worker already inside the authorized subtree into the bound administrative group or one of its descendants. Group administrators cannot import outside workers or leave workers ungrouped.",
    "groups.env.list":
      "List names-only own, inherited, excluded, and effective environment keys for the bound administrative group or a descendant. Values are never returned.",
    "groups.env.update":
      "Manage write-only variables and inherited-key exclusions for the bound administrative group or a descendant. Values are never returned or written to audit output.",
    "groups.admin-workspace.get":
      "Get and reconcile an existing administrative workspace for the bound group or a descendant.",
    "groups.admin-workspace.provision":
      "Provision or return the administrative workspace for the bound group or a descendant.",
    "groups.admin-workspace.start":
      "Provision if needed, then start the administrative workspace for the bound group or a descendant.",
    "groups.admin-workspace.stop":
      "Provision if needed, then stop the administrative workspace for the bound group or a descendant without deleting its data.",
    "groups.admin-workspace.rebuild":
      "Provision if needed, then rebuild and start the administrative workspace for the bound group or a descendant while retaining its data and group binding.",
    "groups.admin-workspace.startup-script.get":
      "Read the non-secret startup script and bounded runtime status for an existing administrative workspace in the bound group or a descendant.",
    "groups.admin-workspace.startup-script.set":
      "Set or clear the non-secret startup script for an existing administrative workspace in the bound group or a descendant. A running workspace is not interrupted; the next explicit start or rebuild applies it.",
  };
  return (
    descriptions[name] ||
    "Restricted to the bound administrative group and its live descendant subtree."
  );
}
function validateToolArguments(name: string, args: Record<string, unknown>) {
  const definitions = [
    ...workerDomain.tools(),
    ...workspaceMcpTools,
    ...imageBackupDomain.tools(),
    ...platformDomain.tools(),
    ...catalogDomain.tools(),
    ...exposureDomain.tools(),
    ...runningFilesDomain.tools(),
    ...logsDomain.tools(),
    ...statusDomain.tools(),
    ...globalConfigurationDomain.tools(),
    ...importDomain.tools(),
    ...pluginDomain.tools(),
  ];
  const schema =
    definitions.find((tool) => tool.name === name)?.inputSchema ||
    toolInputSchema(name);
  const required = Array.isArray((schema as any)?.required)
    ? (schema as any).required
    : [];
  for (const key of required) {
    const value = args[key];
    const property = (schema as any)?.properties?.[key] || {};
    const declaredType = property.type;
    const permitsNull =
      declaredType === "null" ||
      (Array.isArray(declaredType) && declaredType.includes("null"));
    const permitsEmpty = property.minLength === 0;
    if (
      value === undefined ||
      (value === null && !permitsNull) ||
      (value === "" && !permitsEmpty)
    )
      throw statusError(400, `${name}: ${key} is required`);
  }
}
async function compatibleDomainArguments(
  name: string,
  args: Record<string, unknown>,
) {
  if (
    args.ownerId ||
    (!name.startsWith("images.") && !name.startsWith("backups."))
  )
    return args;
  if (name.startsWith("images.") && typeof args.definitionId === "string") {
    const catalog = useImageCatalogManager();
    await catalog.init();
    const definition = catalog
      .list("", true)
      .find((item) => item.id === args.definitionId);
    if (definition) return { ...args, ownerId: definition.ownerId };
  }
  if (name === "backups.create" && Array.isArray(args.workspaceIds)) {
    const first = useContainerManager().get(String(args.workspaceIds[0] || ""));
    if (first) return { ...args, ownerId: first.userId };
  }
  if (typeof args.jobId === "string") {
    const job = await useBackupManager().getJob(args.jobId);
    if (job) return { ...args, ownerId: job.userId };
  }
  return args;
}
function toolAnnotations(name: string) {
  const readOnly =
    /(?:\.list|\.inspect|\.status|\.read|list-files|validate|build-status)$/.test(
      name,
    ) ||
    name === "status.system" ||
    name.endsWith(".get");
  const destructive =
    /(?:\.delete|\.cancel|\.remove|\.rollback|console\.close)$/.test(name);
  return {
    title: name,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}
function adminStartupScriptToolDescription(name: string) {
  if (name === "admin-workspace.startup-script.get")
    return "Read the calling administrative workspace's non-secret startup script, desired/applied revisions, pending-rebuild flag, and bounded runtime status. The server derives the target from the authenticated workload identity; no workspace or group identifier is accepted. timeoutSeconds bounds the request.";
  if (name === "admin-workspace.startup-script.set")
    return "Set or clear the calling administrative workspace's non-secret startup script. The server derives the target from the authenticated workload identity; no workspace or group identifier is accepted. Saving never interrupts a running workspace; the next explicit start or rebuild applies it. timeoutSeconds bounds the request.";
  return "";
}
function toolInputSchema(name: string) {
  if (
    name === "admin-workspace.startup-script.get" ||
    name === "admin-workspace.startup-script.set"
  )
    return {
      type: "object",
      additionalProperties: false,
      ...(name.endsWith(".set") ? { required: ["startupScript"] } : {}),
      properties: {
        ...(name.endsWith(".set")
          ? {
              startupScript: {
                type: "string",
                minLength: 0,
                maxLength: 65_536,
                description:
                  "Non-secret shell script launched after each start. Empty disables it; changes apply on the next explicit start or rebuild.",
              },
            }
          : {}),
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 120,
          description:
            "Server-side fail-fast deadline in seconds (default 30; 1-120). Returns a structured 504 error when exceeded.",
        },
      },
    };
  if (name === "configuration.inspect")
    return {
      type: "object",
      additionalProperties: false,
      required: ["workerId"],
      properties: { workerId: { type: "string", minLength: 1 } },
    };
  if (
    name === "status.system" ||
    name === "workers.list" ||
    name === "volumes.list"
  )
    return { type: "object", additionalProperties: false, properties: {} };
  if (name === "workers.inspect")
    return {
      type: "object",
      additionalProperties: false,
      required: ["workerId"],
      properties: { workerId: { type: "string", minLength: 1 } },
    };
  if (name === "volumes.list-files")
    return {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId"],
      properties: {
        workspaceId: { type: "string", minLength: 1 },
        path: { type: "string" },
      },
    };
  if (name === "exports.create")
    return {
      type: "object",
      additionalProperties: false,
      required: ["workerId"],
      properties: {
        workerId: { type: "string", minLength: 1 },
        includeRootfs: { type: "boolean" },
      },
    };
  if (name === "exports.status" || name === "exports.cancel")
    return {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string", minLength: 1 } },
    };
  if (name === "configuration.apply")
    return {
      type: "object",
      additionalProperties: false,
      required: ["proposalId"],
      properties: {
        proposalId: { type: "string" },
        lockPassword: {
          type: "string",
          writeOnly: true,
          description: "Required when a proposal changes a protected worker",
        },
      },
    };
  if (name === "worker.stop" || name === "worker.start")
    return {
      type: "object",
      additionalProperties: false,
      required: ["workerId"],
      properties: {
        workerId: { type: "string" },
        lockPassword: {
          type: "string",
          writeOnly: true,
          description: "Required when the target worker is protected",
        },
      },
    };
  if (name === "console.open")
    return {
      type: "object",
      additionalProperties: false,
      required: ["workerId"],
      properties: {
        workerId: { type: "string", description: "Target Agentor worker UUID" },
        windowIndex: { type: "integer", minimum: 0, default: 0 },
      },
    };
  if (name === "console.write")
    return {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "input"],
      properties: {
        sessionId: { type: "string" },
        input: { type: "string", maxLength: 65536 },
      },
    };
  if (["console.read", "console.interrupt", "console.close"].includes(name))
    return {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        ...(name === "console.read"
          ? { from: { type: "integer", minimum: 0 } }
          : {}),
      },
    };
  // Unknown tools must not advertise an unconstrained payload. Every supported
  // tool should be declared by a domain; this fail-closed fallback prevents
  // clients from inventing arguments for an unimplemented operation.
  return { type: "object", additionalProperties: false, properties: {} };
}
function publicWorker(worker: any) {
  return {
    id: worker.id,
    userId: worker.userId,
    displayName: worker.displayName,
    status: worker.status,
    imageName: worker.imageName,
    environmentId: worker.environmentId,
    pendingRebuild: Boolean(worker.pendingRebuild),
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
  };
}
function stripValues(value: any): any {
  if (Array.isArray(value)) return value.map(stripValues);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "value" || key === "content" ? "[REDACTED]" : stripValues(item),
      ]),
    );
  return value;
}
function validateConfigurationProposal(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as any;
  if (
    Object.keys(input).length === 1 &&
    ["debug", "info", "warn", "error"].includes(input.logLevel)
  )
    return { logLevel: input.logLevel };
  if (
    typeof input.workerId !== "string" ||
    !Array.isArray(input.variables) ||
    input.variables.length > 500 ||
    input.secrets ||
    input.secretFiles
  )
    return;
  const variables: Array<{ key: string; value: string }> = [];
  for (const entry of input.variables) {
    if (
      !entry ||
      typeof entry.key !== "string" ||
      typeof entry.value !== "string" ||
      !/^[A-Z_][A-Z0-9_]*$/.test(entry.key) ||
      sensitive.test(entry.key) ||
      entry.value.length > 64 * 1024
    )
      return;
    variables.push({ key: entry.key, value: entry.value });
  }
  return { workerId: input.workerId, variables };
}

/** Normalize persisted v1 state without ever granting a capability that was
 * absent from the stored policy. The one legacy aggregate read-only group is
 * expanded to the new narrow read-only groups to preserve its prior meaning. */
export function normalizeManagementMcpState(
  value: unknown,
): { state: State; changed: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as any;
  if (input.schemaVersion !== 1 || input.policy?.default !== "deny") return;
  const storedGroups =
    input.policy.groups &&
    typeof input.policy.groups === "object" &&
    !Array.isArray(input.policy.groups)
      ? input.policy.groups
      : {};
  const narrowReadOnlyGroups = [
    "logs",
    "volume-browsing",
    "configuration-inspection",
  ];
  const isLegacyPolicy = narrowReadOnlyGroups.every(
    (name) => !Object.prototype.hasOwnProperty.call(storedGroups, name),
  );
  const legacyReadOnly = storedGroups["read-only-status"]?.enabled === true;
  const groups = Object.fromEntries(
    GROUPS.map((name) => {
      const stored = storedGroups[name]?.enabled;
      const migratedLegacy =
        isLegacyPolicy && narrowReadOnlyGroups.includes(name);
      return [
        name,
        { enabled: stored === true || (migratedLegacy && legacyReadOnly) },
      ];
    }),
  ) as Policy["groups"];
  const proposals = Array.isArray(input.proposals)
    ? input.proposals
        .map(normalizeProposal)
        .filter((proposal: Proposal | null): proposal is Proposal =>
          Boolean(proposal),
        )
        .slice(-5000)
    : [];
  const audit = Array.isArray(input.audit)
    ? input.audit
        .filter(validAudit)
        .slice(-5000)
        .map((entry: Audit) => ({ ...entry, details: clean(entry.details) }))
    : [];
  const revision =
    Number.isSafeInteger(input.policy.revision) && input.policy.revision > 0
      ? input.policy.revision
      : 1;
  const updatedAt =
    typeof input.policy.updatedAt === "string" &&
    !Number.isNaN(Date.parse(input.policy.updatedAt))
      ? input.policy.updatedAt
      : new Date().toISOString();
  const appliedConfiguration = ["debug", "info", "warn", "error"].includes(
    input.appliedConfiguration?.logLevel,
  )
    ? {
        logLevel: input.appliedConfiguration.logLevel as
          "debug" | "info" | "warn" | "error",
      }
    : undefined;
  const state: State = {
    schemaVersion: 1,
    policy: { schemaVersion: 1, default: "deny", groups, revision, updatedAt },
    proposals,
    audit,
    ...(appliedConfiguration ? { appliedConfiguration } : {}),
  };
  return { state, changed: JSON.stringify(input) !== JSON.stringify(state) };
}

function normalizeProposal(value: any): Proposal | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    value.immutable !== true ||
    !["pending-dashboard-approval", "approved", "applied"].includes(
      value.status,
    ) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  )
    return;
  const diff = validateConfigurationProposal(value.diff);
  if (!diff) return;
  if (
    value.status !== "pending-dashboard-approval" &&
    (typeof value.approvedAt !== "string" ||
      Number.isNaN(Date.parse(value.approvedAt)))
  )
    return;
  if (
    value.status === "applied" &&
    (typeof value.appliedAt !== "string" ||
      Number.isNaN(Date.parse(value.appliedAt)))
  )
    return;
  return {
    id: value.id,
    immutable: true,
    status: value.status,
    diff,
    createdAt: value.createdAt,
    ...(typeof value.approvedAt === "string"
      ? { approvedAt: value.approvedAt }
      : {}),
    ...(typeof value.appliedAt === "string"
      ? { appliedAt: value.appliedAt }
      : {}),
  };
}

function validAudit(value: any): value is Audit {
  return (
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    typeof value.action === "string" &&
    typeof value.outcome === "string" &&
    (value.details === undefined ||
      (value.details &&
        typeof value.details === "object" &&
        !Array.isArray(value.details)))
  );
}
