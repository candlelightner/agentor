import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { ExportJobRecord } from "./export-job-store";
import { useExportJobManager } from "./services";
import {
  listWorkspaceInventory,
  type WorkspaceInventoryItem,
} from "./workspace-inventory";
import { OfflineWorkspaceAccess } from "./workspace-access";
import { normalizeClientPathList } from "./workspace-path";

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_PREPARED = 1024;
const MAX_WORKSPACE_PATHS = 100;

export type ManagementDownloadCapability = "storage" | "exports";

interface PreparedBase {
  workspaceIdentity: string;
  ownerId: string;
  expiresAt: number;
}

interface PreparedWorkspaceDownload extends PreparedBase {
  kind: "workspace";
  capability: "storage";
  workspaceId: string;
  paths: string[];
}

interface PreparedExportDownload extends PreparedBase {
  kind: "export";
  capability: "exports";
  jobId: string;
}

type PreparedDownload = PreparedWorkspaceDownload | PreparedExportDownload;

export interface OpenedManagementDownload {
  stream: Readable;
  contentType:
    | "application/octet-stream"
    | "application/zip"
    | "application/x-tar";
  filename: string;
  size?: number;
  audit: {
    workspaceId: string;
    kind: PreparedDownload["kind"];
    resourceId: string;
    ownerId: string;
  };
}

interface DownloadDependencies {
  now: () => number;
  listWorkspaces: () => Promise<WorkspaceInventoryItem[]>;
  downloadWorkspace: (
    item: WorkspaceInventoryItem,
    paths: string[],
  ) => Promise<Awaited<ReturnType<OfflineWorkspaceAccess["download"]>>>;
  getExportJob: (jobId: string) => Promise<ExportJobRecord | undefined>;
  openExportArtifact: (
    job: ExportJobRecord,
  ) => Promise<{ stream: Readable; size: number; filename: string }>;
}

const defaultDependencies: DownloadDependencies = {
  now: () => Date.now(),
  listWorkspaces: () => listWorkspaceInventory(true),
  downloadWorkspace: (item, paths) =>
    new OfflineWorkspaceAccess(item).download(paths),
  getExportJob: (jobId) => useExportJobManager().get(jobId),
  openExportArtifact: (job) => useExportJobManager().openArtifact(job),
};

/** Private, streaming download handoff for management MCP callers.
 *
 * JSON-RPC only mints an opaque one-use path. The resource is opened later on
 * the management-network listener after the current workload identity and
 * current capability policy have both been checked again. A prepared token is
 * bound to one administrative workspace, one immutable resource owner, and
 * either one exact export job or one normalized workspace path selection.
 */
export class ManagementDownloadDomain {
  private readonly prepared = new Map<string, PreparedDownload>();

  constructor(
    private readonly deps: DownloadDependencies = defaultDependencies,
  ) {}

  async execute(
    name: string,
    args: Record<string, unknown>,
    workspaceIdentity: string,
  ): Promise<{ handled: boolean; result?: unknown }> {
    if (name === "workspaces.download") {
      const workspaceId = required(args.workspaceId, "workspaceId");
      const paths = normalizeClientPathList(
        args.paths ?? (args.path === undefined ? undefined : [args.path]),
      );
      if (paths.length > MAX_WORKSPACE_PATHS)
        throw fail(413, "Too many download paths");

      const item = (await this.deps.listWorkspaces()).find(
        (candidate) => candidate.id === workspaceId,
      );
      if (
        !item?.userId ||
        item.state === "orphaned" ||
        item.state === "deleted"
      )
        throw fail(404, "Workspace unavailable");

      return {
        handled: true,
        result: this.prepare({
          kind: "workspace",
          capability: "storage",
          workspaceIdentity,
          workspaceId: item.id,
          ownerId: item.userId,
          paths,
        }),
      };
    }

    if (name === "exports.download") {
      const jobId = required(args.jobId, "jobId");
      const job = await this.deps.getExportJob(jobId);
      if (!job) throw fail(404, "Export job not found");
      if (job.status !== "succeeded")
        return {
          handled: true,
          result: {
            ready: false,
            status: job.status,
            reason: "Export artifact is not ready",
          },
        };

      return {
        handled: true,
        result: {
          ready: true,
          ...this.prepare({
            kind: "export",
            capability: "exports",
            workspaceIdentity,
            jobId: job.id,
            ownerId: job.userId,
          }),
          filename: safeFilename(job.filename || "worker-export.tar"),
        },
      };
    }

    return { handled: false };
  }

  /** Consume a prepared download and open its source stream. `authorize` is
   * deliberately invoked after resolving the token but immediately before it
   * is consumed, allowing the store to recheck the live capability policy. */
  async open(
    workspaceIdentity: string,
    token: string,
    authorize: (prepared: Readonly<PreparedDownload>) => void | Promise<void>,
  ): Promise<OpenedManagementDownload> {
    this.expire();
    const prepared = this.prepared.get(token);
    if (!prepared || prepared.workspaceIdentity !== workspaceIdentity)
      throw fail(404, "Download not found or expired");

    await authorize(prepared);
    // Consume before opening a Docker helper or artifact file. Concurrent and
    // replay requests therefore fail closed even while the first stream runs.
    this.prepared.delete(token);

    if (prepared.kind === "workspace") {
      const item = (await this.deps.listWorkspaces()).find(
        (candidate) => candidate.id === prepared.workspaceId,
      );
      // Ownership is captured when prepared and checked again when redeemed.
      // A deleted/reassigned workspace never turns a stale token into access
      // to a different owner's storage.
      if (
        !item ||
        item.userId !== prepared.ownerId ||
        item.state === "orphaned" ||
        item.state === "deleted"
      )
        throw fail(404, "Workspace unavailable");

      let opened: Awaited<
        ReturnType<DownloadDependencies["downloadWorkspace"]>
      >;
      try {
        opened = await this.deps.downloadWorkspace(item, prepared.paths);
      } catch (error: any) {
        // Preserve deliberate, safe validation/status failures from the
        // hardened workspace accessor. Docker/helper/archive errors are not
        // suitable management API responses and may contain host details.
        if (Number.isInteger(error?.statusCode)) throw error;
        throw fail(500, "Workspace download failed");
      }
      if (opened.kind === "file") {
        return {
          stream: opened.stream,
          contentType: "application/octet-stream",
          filename: safeFilename(opened.entry?.name || "download"),
          size: opened.entry?.size,
          audit: {
            workspaceId: prepared.workspaceIdentity,
            kind: "workspace",
            resourceId: prepared.workspaceId,
            ownerId: prepared.ownerId,
          },
        };
      }
      return {
        stream: opened.stream,
        contentType: "application/zip",
        filename: "workspace-download.zip",
        audit: {
          workspaceId: prepared.workspaceIdentity,
          kind: "workspace",
          resourceId: prepared.workspaceId,
          ownerId: prepared.ownerId,
        },
      };
    }

    const job = await this.deps.getExportJob(prepared.jobId);
    if (!job || job.userId !== prepared.ownerId)
      throw fail(404, "Export job not found");
    if (job.status !== "succeeded")
      throw fail(409, "Export artifact is not ready");
    let artifact: Awaited<
      ReturnType<DownloadDependencies["openExportArtifact"]>
    >;
    try {
      artifact = await this.deps.openExportArtifact(job);
    } catch {
      throw fail(404, "Export artifact not found");
    }
    return {
      stream: artifact.stream,
      contentType: "application/x-tar",
      filename: safeFilename(artifact.filename || "worker-export.tar"),
      size: artifact.size,
      audit: {
        workspaceId: prepared.workspaceIdentity,
        kind: "export",
        resourceId: prepared.jobId,
        ownerId: prepared.ownerId,
      },
    };
  }

  private prepare(
    input:
      | Omit<PreparedWorkspaceDownload, "expiresAt">
      | Omit<PreparedExportDownload, "expiresAt">,
  ) {
    this.expire();
    if (this.prepared.size >= MAX_PREPARED)
      throw fail(429, "Too many pending downloads");
    const token = randomUUID();
    const expiresAt = this.deps.now() + TOKEN_TTL_MS;
    this.prepared.set(token, { ...input, expiresAt } as PreparedDownload);
    return {
      method: "GET",
      downloadPath: `/downloads/${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
      authentication:
        "Use the current workspace-bound management bearer credential",
    };
  }

  private expire() {
    const now = this.deps.now();
    for (const [token, prepared] of this.prepared) {
      if (prepared.expiresAt <= now) this.prepared.delete(token);
    }
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw fail(400, `${name} is required`);
  return value.trim();
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "download";
}

function fail(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
