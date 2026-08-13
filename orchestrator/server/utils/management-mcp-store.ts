import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useAdminWorkspaceStore } from "./admin-workspace-store";
import {
  useConfig,
  useContainerManager,
  useExportJobManager,
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
import { ManagementWorkerDomain } from "./management-worker-domain";
import { workspaceMcpTools, executeWorkspaceMcpTool } from "./management-mcp-workspace-adapter";
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
}
interface IdentityMetadata {
  workspaceId: string;
  audience: "agentor-management-mcp";
  expiresAt: string;
  persistedInWorkspace: false;
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
  "images.build": "image-builds",
  "images.build-status": "image-builds",
  "configuration.propose": "configuration-proposals",
  "configuration.apply": "configuration-application",
};
for (const tool of workerDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of workspaceMcpTools) TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of imageBackupDomain.tools()) TOOL_GROUP[tool.name] ??= tool.group;
for (const tool of platformDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of catalogDomain.tools()) TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of exposureDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of runningFilesDomain.tools()) TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of logsDomain.tools()) TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of statusDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
for (const tool of globalConfigurationDomain.tools()) TOOL_GROUP[tool.name] = tool.group as Group;
for (const tool of importDomain.tools()) TOOL_GROUP[tool.name] = tool.group;
const sensitive =
  /secret|token|credential|password|authorization|cookie|cipher|key/i;
function clean(value: unknown, depth = 0): any {
  if (depth > 5) return "[REDACTED]";
  if (typeof value === "string")
    return value.length > 128 ? "[REDACTED]" : value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => clean(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as any).map(([k, v]) => [
        k,
        sensitive.test(k) ? "[REDACTED]" : clean(v, depth + 1),
      ]),
    );
  return value;
}
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
  constructor(dataDir = process.env.DATA_DIR || "/data") {
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
  private persist() {
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tmp, this.path);
    });
    return this.writes;
  }
  async getPolicy() {
    await this.init();
    return structuredClone(this.state.policy);
  }
  async listTools() {
    await this.init();
    return Object.keys(TOOL_GROUP)
      .filter((name) => this.state.policy.groups[TOOL_GROUP[name]!]!.enabled)
      .map((name) => {
      const domain = workerDomain.tools().find((tool) => tool.name === name);
      const workspace = workspaceMcpTools.find((tool) => tool.name === name);
      const imageBackup = imageBackupDomain.tools().find((tool) => tool.name === name);
      const platform = platformDomain.tools().find((tool) => tool.name === name);
      const catalog = catalogDomain.tools().find((tool) => tool.name === name);
      const exposure = exposureDomain.tools().find((tool) => tool.name === name);
      const runningFiles = runningFilesDomain.tools().find((tool) => tool.name === name);
      const logs = logsDomain.tools().find((tool) => tool.name === name);
      const status = statusDomain.tools().find((tool) => tool.name === name);
      const globalConfiguration = globalConfigurationDomain.tools().find((tool) => tool.name === name);
      const imports = importDomain.tools().find((tool) => tool.name === name);
      return {
      name,
      description: domain?.description || workspace?.description || imageBackup?.description || platform?.description || catalog?.description || exposure?.description || runningFiles?.description || logs?.description || status?.description || globalConfiguration?.description || imports?.description || `Agentor management tool (${TOOL_GROUP[name]})`,
      inputSchema: domain?.inputSchema || workspace?.inputSchema || imageBackup?.inputSchema || platform?.inputSchema || catalog?.inputSchema || exposure?.inputSchema || runningFiles?.inputSchema || logs?.inputSchema || status?.inputSchema || globalConfiguration?.inputSchema || imports?.inputSchema || toolInputSchema(name),
      annotations: domain?.annotations || workspace?.annotations || imageBackup?.annotations || platform?.annotations || catalog?.annotations || exposure?.annotations || runningFiles?.annotations || logs?.annotations || status?.annotations || globalConfiguration?.annotations || imports?.annotations || toolAnnotations(name),
    }});
  }
  async updatePolicy(groups: Record<string, unknown>, actor: string) {
    await this.init();
    for (const [name, value] of Object.entries(groups || {})) {
      if (!GROUPS.includes(name as Group) || typeof value !== "boolean")
        throw new Error(`Unknown or invalid policy group: ${name}`);
      this.state.policy.groups[name as Group].enabled = value;
    }
    this.state.policy.revision++;
    this.state.policy.updatedAt = new Date().toISOString();
    await this.audit("policy.changed", "success", { actor, groups });
    return this.getPolicy();
  }
  async issue(workspaceId: string, ttlSeconds = 60) {
    this.pruneExpiredIdentities();
    const workspace = await useAdminWorkspaceStore().ensure();
    if (workspace.id !== workspaceId)
      throw Object.assign(
        new Error("Identity is restricted to the administrative workspace"),
        { statusCode: 403 },
      );
    const raw = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(raw).digest("hex");
    const expiresAt =
      Date.now() +
      Math.min(60, Number.isFinite(ttlSeconds) ? ttlSeconds : 60) * 1000;
    this.identities.set(hash, { hash, workspaceId, expiresAt });
    return {
      credential: `mcp1.${raw}`,
      workspaceId,
      audience: "agentor-management-mcp",
      expiresAt: new Date(expiresAt).toISOString(),
      persistedInWorkspace: false,
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
    return {
      workspaceId: id.workspaceId,
      audience: "agentor-management-mcp",
      expiresAt: new Date(id.expiresAt).toISOString(),
      persistedInWorkspace: false,
    };
  }
  async auditAuthorizationFailure(operation: string) {
    await this.audit("authorization.denied", "failure", {
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
      await this.audit("authorization.denied", "failure", {
        reason: "identity",
      });
      await this.audit("tool.invoked", "failure", {
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
        await this.audit("authorization.denied", "failure", {
          workspaceId: identity.workspaceId,
          tool: name,
        });
        throw Object.assign(new Error("Tool denied by policy"), {
          statusCode: 403,
        });
      }
      await validateManagementOwnerArguments(args);
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
        this.state.proposals.push(proposal);
        await this.persist();
        result = proposal;
      } else if (name === "configuration.apply") {
        const p = this.state.proposals.find((x) => x.id === args.proposalId);
        if (!p)
          throw Object.assign(new Error("Proposal not found"), {
            statusCode: 404,
          });
        if (p.status === "applied")
          throw Object.assign(new Error("Proposal already applied"), {
            statusCode: 409,
          });
        // Dashboard review remains available as a useful optional workflow,
        // but an authorized harness may apply its own immutable proposal
        // directly. Confirmation belongs to the harness; Agentor's actual
        // boundaries are workload identity and the live capability policy.
        const patch = p.diff as any;
        let appliedTarget: Record<string, unknown>;
        if (typeof patch.logLevel === "string") {
          useConfig().logLevel = patch.logLevel;
          this.state.appliedConfiguration = {
            ...this.state.appliedConfiguration,
            logLevel: patch.logLevel,
          };
          appliedTarget = { setting: "logLevel" };
        } else {
          const worker =
            useContainerManager().get(patch.workerId) ??
            useWorkerStore().findById(patch.workerId);
          if (!worker)
            throw Object.assign(new Error("Worker not found"), {
              statusCode: 404,
            });
          await useWorkerProtectionLockStore().verify(
            worker.id,
            args.lockPassword,
          );
          await useWorkerConfigStore().patch(worker.userId, worker.id, {
            variables: patch.variables,
          });
          worker.pendingRebuild = true;
          const stored = useWorkerStore().findById(worker.id);
          if (stored) {
            stored.pendingRebuild = true;
            stored.updatedAt = new Date().toISOString();
            await useWorkerStore().upsert(stored);
          }
          appliedTarget = { workerId: worker.id };
        }
        p.status = "applied";
        if (!p.approvedAt) p.approvedAt = new Date().toISOString();
        p.appliedAt = new Date().toISOString();
        await this.audit("proposal.applied", "success", {
          proposalId: p.id,
          ...appliedTarget,
        });
        result = {
          id: p.id,
          status: p.status,
          applied: true,
          pendingRebuild: true,
        };
      } else {
        result = await this.executeTool(name, args, identity.workspaceId);
      }
      await this.audit("tool.invoked", "success", {
        workspaceId: identity.workspaceId,
        tool: name,
        group,
        policyRevision: this.state.policy.revision,
      });
      return result;
    } catch (error: any) {
      await this.audit("tool.invoked", "failure", {
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
  async uploadImport(credential: unknown, token: string, source: Readable, declaredLength?: number) {
    let identity;
    try {
      identity = await this.introspect(credential);
    } catch (error) {
      await this.auditAuthorizationFailure("import.upload");
      throw error;
    }
    try {
      await this.init();
      if (!this.state.policy.groups.exports.enabled) throw Object.assign(new Error("Tool denied by policy"), { statusCode: 403 });
      const result = await importDomain.upload(identity.workspaceId, token, source, declaredLength);
      await this.audit("import.uploaded", "success", { workspaceId: identity.workspaceId });
      return result;
    } catch (error: any) {
      await this.audit("import.uploaded", "failure", { workspaceId: identity.workspaceId, statusCode: error?.statusCode || 500 });
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
        (group) => {
          // Handoffs can outlive the MCP call that prepared them, so consult
          // the authoritative policy again at redemption time.
          if (!this.state.policy.groups[group]?.enabled)
            throw Object.assign(new Error("Tool denied by policy"), {
              statusCode: 403,
            });
        },
      );
      await this.audit("download.opened", "success", {
        ...opened.audit,
      });
      return opened;
    } catch (error: any) {
      await this.audit("download.opened", "failure", {
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
    await this.audit("download.transferred", outcome, audit);
  }
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    workspaceId: string,
  ): Promise<any> {
    // Validate the MCP envelope before entering any domain manager. In
    // particular, missing ownerId must not trigger backup/image store
    // initialization or compatibility lookups that can take minutes.
    validateToolArguments(name, args);
    const domain = await workerDomain.execute(name, args);
    if (domain.handled) return domain.result;
    const imageBackup = await imageBackupDomain.execute(name, await compatibleDomainArguments(name, args));
    if (imageBackup.handled) return imageBackup.result;
    const platform = await platformDomain.execute(name, args);
    if (platform.handled) return platform.result;
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
    const globalConfiguration = await globalConfigurationDomain.execute(name, args);
    if (globalConfiguration.handled) return globalConfiguration.result;
    const imported = await importDomain.execute(name, args, workspaceId);
    if (imported.handled) return imported.result;
    const download = await downloadDomain.execute(name, args, workspaceId);
    if (download.handled) return download.result;
    if (workspaceMcpTools.some((tool) => tool.name === name))
      return executeWorkspaceMcpTool(name, args);
    const workerId = typeof args.workerId === "string" ? args.workerId : "";
    const worker = workerId
      ? (useContainerManager().get(workerId) ??
        useWorkerStore().findById(workerId))
      : undefined;
    if (name === "status.system")
      return {
        status: "ok",
        workers: useContainerManager().list().length,
        archived: useWorkerStore().listArchived().length,
      };
    if (name === "workers.list")
      return {
        workers: [
          ...useContainerManager().list(),
          ...useWorkerStore().listArchived(),
        ].map(publicWorker),
      };
    if (name === "workers.inspect") {
      if (!worker) throw statusError(404, "Worker not found");
      return publicWorker(worker);
    }
    if (name === "volumes.list")
      return {
        workspaces: (await listWorkspaceInventory(true)).map(
          publicWorkspaceInventoryItem,
        ),
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
        return consoles.open(workspaceId, worker.id, Number(args.windowIndex ?? 0));
      }
      const sessionId = String(args.sessionId || "");
      if (!sessionId) throw statusError(400, "sessionId required");
      if (name === "console.read")
        return consoles.read(workspaceId, sessionId, Number.isInteger(args.from) ? Number(args.from) : undefined);
      if (name === "console.write")
        return consoles.write(workspaceId, sessionId, typeof args.input === "string" ? args.input : "");
      if (name === "console.interrupt") return consoles.interrupt(workspaceId, sessionId);
      if (name === "console.close") return consoles.close(workspaceId, sessionId);
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
  async approve(id: string, actor: string) {
    await this.init();
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p)
      throw Object.assign(new Error("Proposal not found"), { statusCode: 404 });
    if (p.status !== "pending-dashboard-approval")
      throw Object.assign(new Error("Proposal is not pending"), {
        statusCode: 409,
      });
    p.status = "approved";
    p.approvedAt = new Date().toISOString();
    await this.audit("proposal.approved", "success", { proposalId: id, actor });
    return structuredClone(p);
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
    this.state.audit.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      action,
      outcome,
      details: clean(details),
    });
    if (this.state.audit.length > 5000)
      this.state.audit.splice(0, this.state.audit.length - 5000);
    await this.persist();
  }
  async listAudit(limit = 100) {
    await this.init();
    return this.state.audit.slice(-Math.max(1, Math.min(500, limit))).reverse();
  }
}
let singleton: ManagementMcpStore | undefined;
export function useManagementMcpStore() {
  return (singleton ??= new ManagementMcpStore());
}

function statusError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
function validateToolArguments(name: string, args: Record<string, unknown>) {
  const definitions = [
    ...workerDomain.tools(), ...workspaceMcpTools, ...imageBackupDomain.tools(),
    ...platformDomain.tools(), ...catalogDomain.tools(), ...exposureDomain.tools(),
    ...runningFilesDomain.tools(), ...logsDomain.tools(), ...statusDomain.tools(),
    ...globalConfigurationDomain.tools(), ...importDomain.tools(),
  ];
  const schema = definitions.find((tool) => tool.name === name)?.inputSchema || toolInputSchema(name);
  const required = Array.isArray((schema as any)?.required) ? (schema as any).required : [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === "")
      throw statusError(400, `${name}: ${key} is required`);
  }
}
async function compatibleDomainArguments(name: string, args: Record<string, unknown>) {
  if (args.ownerId || (!name.startsWith("images.") && !name.startsWith("backups."))) return args;
  if (name.startsWith("images.") && typeof args.definitionId === "string") {
    const catalog = useImageCatalogManager();
    await catalog.init();
    const definition = catalog.list("", true).find((item) => item.id === args.definitionId);
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
  const readOnly = /(?:\.list|\.inspect|\.status|\.read|list-files|validate|build-status)$/.test(name) || name === "status.system";
  const destructive = /(?:\.delete|\.cancel|\.remove|\.rollback|console\.close)$/.test(name);
  return {
    title: name,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}
function toolInputSchema(name: string) {
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
      properties: { sessionId: { type: "string" }, input: { type: "string", maxLength: 65536 } },
    };
  if (["console.read", "console.interrupt", "console.close"].includes(name))
    return {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        ...(name === "console.read" ? { from: { type: "integer", minimum: 0 } } : {}),
      },
    };
  return { type: "object", additionalProperties: true };
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
