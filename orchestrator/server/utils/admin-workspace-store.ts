import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useContainerManager } from "./services";

export interface AdministrativeWorkspaceRecord {
  schemaVersion: 1;
  id: string;
  kind: "administrative" | "group-administrative";
  trusted: true;
  status: "running" | "stopped";
  marker?: string;
  createdAt: string;
  updatedAt: string;
  imageName?: string;
  imageDigest?: string;
  /** Account whose worker environment variables are injected on recreation. */
  ownerId?: string;
  /** User-authored, non-secret shell launched in the admin tmux pane. */
  startupScript?: string;
  /** Monotonic desired/applied revisions keep Docker's immutable Env explicit. */
  startupScriptRevision?: number;
  appliedStartupScriptRevision?: number;
  startupScriptLastAppliedAt?: string;
}

export interface AdminWorkspaceRuntimeImage {
  name: string;
  digest: string;
  appliedStartupScriptRevision?: number;
}

export interface AdminWorkspaceStartupScriptRuntimeStatus {
  state:
    | "not-configured"
    | "pending-rebuild"
    | "starting"
    | "running"
    | "succeeded"
    | "failed"
    | "unavailable";
  revision?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
}

/**
 * Narrow integration boundary for the real container implementation. The
 * durable control-plane record remains authoritative; an adapter must only
 * provision the pinned image and fixed network attachments described by the
 * supplied record. It must never accept an image, mount, or network from a
 * request.
 */
export interface AdminWorkspaceRuntimeAdapter {
  ensure(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceRuntimeImage | void>;
  start(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceRuntimeImage | void>;
  stop(record: Readonly<AdministrativeWorkspaceRecord>): Promise<void>;
  rebuild(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceRuntimeImage | void>;
  remove?(record: Readonly<AdministrativeWorkspaceRecord>): Promise<void>;
  startupScriptStatus?(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceStartupScriptRuntimeStatus>;
  security?(workerId?: string): Promise<Record<string, unknown> | undefined>;
  managementNetworkSecurity?(): Promise<Record<string, unknown>>;
  setClipboard?(
    mime: "image/png" | "text/plain",
    bytes: Buffer,
    record?: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<void>;
}

const ADMIN_IMAGE =
  process.env.AGENTOR_ADMIN_WORKER_IMAGE || "agentor-admin-worker:latest";
const ADMIN_DIGEST = process.env.AGENTOR_ADMIN_WORKER_DIGEST?.match(
  /^sha256:[0-9a-f]{64}$/,
)
  ? process.env.AGENTOR_ADMIN_WORKER_DIGEST
  : `sha256:${createHash("sha256").update(ADMIN_IMAGE).digest("hex")}`;

export class AdminWorkspaceStore {
  private record?: AdministrativeWorkspaceRecord;
  private readonly path: string;
  private loading?: Promise<void>;
  private runtime?: AdminWorkspaceRuntimeAdapter;
  private operationTail: Promise<void> = Promise.resolve();
  private pendingCommit?: {
    operation: string;
    record: AdministrativeWorkspaceRecord;
  };
  constructor(
    dataDir = process.env.DATA_DIR || "/data",
    private readonly recordWriter?: (
      record: Readonly<AdministrativeWorkspaceRecord>,
    ) => Promise<void>,
  ) {
    this.path = join(dataDir, "admin", "workspace.v1.json");
  }
  setRuntimeAdapter(runtime: AdminWorkspaceRuntimeAdapter) {
    this.runtime = runtime;
  }
  async setClipboard(mime: "image/png" | "text/plain", bytes: Buffer) {
    if (!this.runtime?.setClipboard)
      throw Object.assign(new Error("Administrative clipboard unavailable"), {
        statusCode: 503,
      });
    await this.runtime.setClipboard(mime, bytes);
  }
  async init() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.path, "utf8"));
        if (
          parsed?.schemaVersion === 1 &&
          typeof parsed.id === "string" &&
          parsed.kind === "administrative"
        )
          this.record = parsed;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    })();
    return this.loading;
  }
  private async save(record: Readonly<AdministrativeWorkspaceRecord>) {
    if (this.recordWriter) {
      await this.recordWriter(structuredClone(record));
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, this.path);
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async flushPendingCommit(operation: string) {
    if (!this.pendingCommit) return false;
    const pending = this.pendingCommit;
    await this.save(pending.record);
    this.record = structuredClone(pending.record);
    this.pendingCommit = undefined;
    return pending.operation === operation;
  }
  private async commit(record: AdministrativeWorkspaceRecord) {
    await this.save(record);
    this.record = structuredClone(record);
  }
  private async commitExternal(
    operation: string,
    record: AdministrativeWorkspaceRecord,
  ) {
    try {
      await this.commit(record);
    } catch (error) {
      // Docker already accepted the operation. Retain the exact resulting
      // record so a retry first persists it instead of repeating a rebuild,
      // start, or stop whose caller merely lost the durable acknowledgement.
      this.record = structuredClone(record);
      this.pendingCommit = {
        operation,
        record: structuredClone(record),
      };
      throw error;
    }
  }
  async ensure() {
    return this.exclusive(() => this.ensureLocked());
  }
  private async ensureLocked() {
    await this.init();
    if (await this.flushPendingCommit("ensure")) return this.publicRecord();
    let candidate = this.record ? structuredClone(this.record) : undefined;
    if (!candidate) {
      const now = new Date().toISOString();
      candidate = {
        schemaVersion: 1,
        id: randomUUID(),
        kind: "administrative",
        trusted: true,
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
      // Persist the stable workspace identity before provisioning compute.
      await this.commit(candidate);
    }
    if (this.runtime) {
      const image = await this.runtime.ensure(structuredClone(candidate));
      if (this.applyRuntimeImage(candidate, image))
        await this.commitExternal("ensure", candidate);
    }
    return this.publicRecord(candidate);
  }
  async setStatus(status: "running" | "stopped") {
    return this.exclusive(async () => {
      await this.init();
      const operation = `status:${status}`;
      if (await this.flushPendingCommit(operation)) return this.publicRecord();
      // Lifecycle calls on an existing workspace must reach the runtime
      // operation directly. Provision only when no durable identity exists.
      if (!this.record) await this.ensureLocked();
      const candidate = structuredClone(this.record!);
      if (this.runtime) {
        if (status === "running")
          this.applyRuntimeImage(
            candidate,
            await this.runtime.start(structuredClone(candidate)),
          );
        else await this.runtime.stop(structuredClone(candidate));
      }
      candidate.status = status;
      candidate.updatedAt = new Date().toISOString();
      if (this.runtime) await this.commitExternal(operation, candidate);
      else await this.commit(candidate);
      return this.publicRecord(candidate);
    });
  }
  async rebuild(ownerId?: string) {
    return this.exclusive(async () => {
      await this.init();
      if (await this.flushPendingCommit("rebuild")) return this.publicRecord();
      // Rebuild itself is the application boundary; do not auto-start stale
      // disposable compute first merely to ensure the durable record exists.
      if (!this.record) await this.ensureLocked();
      const candidate = structuredClone(this.record!);
      if (ownerId) candidate.ownerId = ownerId;
      if (!this.runtime)
        throw Object.assign(
          new Error("Administrative workspace runtime is unavailable"),
          { statusCode: 503 },
        );
      this.applyRuntimeImage(
        candidate,
        await this.runtime.rebuild(structuredClone(candidate)),
      );
      candidate.status = "running";
      candidate.updatedAt = new Date().toISOString();
      await this.commitExternal("rebuild", candidate);
      return this.publicRecord(candidate);
    });
  }
  async writeMarker(marker: unknown) {
    if (
      typeof marker !== "string" ||
      marker.length < 1 ||
      marker.length > 512 ||
      /[\u0000-\u001f]/.test(marker)
    )
      throw new Error(
        "Marker must be a printable string of at most 512 characters",
      );
    return this.exclusive(async () => {
      await this.init();
      await this.flushPendingCommit("marker");
      if (!this.record) await this.ensureLocked();
      const candidate = structuredClone(this.record!);
      candidate.marker = marker;
      candidate.updatedAt = new Date().toISOString();
      await this.commit(candidate);
      return { marker };
    });
  }
  async readMarker() {
    await this.ensure();
    return { marker: this.record!.marker ?? null };
  }
  async getStartupScript() {
    return this.exclusive(async () => {
      await this.init();
      await this.flushPendingCommit("startup-script:get");
      if (!this.record)
        throw Object.assign(new Error("Administrative workspace not provisioned"), {
          statusCode: 404,
        });
      return this.startupScriptRecord(structuredClone(this.record));
    });
  }
  async setStartupScript(value: unknown) {
    return this.exclusive(async () => {
      await this.init();
      await this.flushPendingCommit("startup-script:set");
      if (!this.record)
        throw Object.assign(new Error("Administrative workspace not provisioned"), {
          statusCode: 404,
        });
      const script = validateAdminWorkspaceStartupScript(value);
      let candidate = structuredClone(this.record);
      if ((candidate.startupScript || "") !== script) {
        candidate.startupScript = script;
        candidate.startupScriptRevision =
          normalizedRevision(candidate.startupScriptRevision) + 1;
        candidate.updatedAt = new Date().toISOString();
        await this.commit(candidate);
      }
      return this.startupScriptRecord(candidate);
    });
  }
  private async startupScriptRecord(record: AdministrativeWorkspaceRecord) {
    const revision = normalizedRevision(record.startupScriptRevision);
    const appliedRevision = normalizedRevision(
      record.appliedStartupScriptRevision,
    );
    let runtime: AdminWorkspaceStartupScriptRuntimeStatus = {
      state: record.startupScript
        ? revision === appliedRevision
          ? "unavailable"
          : "pending-rebuild"
        : "not-configured",
    };
    if (revision === appliedRevision && record.startupScript && this.runtime?.startupScriptStatus)
      runtime = await this.runtime.startupScriptStatus(record).catch(() => ({
        state: "unavailable" as const,
        revision,
      }));
    return {
      script: record.startupScript || "",
      configured: Boolean(record.startupScript),
      revision,
      appliedRevision,
      pendingRebuild: revision !== appliedRevision,
      lastAppliedAt: record.startupScriptLastAppliedAt,
      runtime,
    };
  }
  publicRecord(record = this.record) {
    if (!record)
      throw new Error("Administrative workspace not initialized");
    return {
      ...structuredClone(record),
      ownerId: undefined,
      marker: undefined,
      startupScript: undefined,
      startupScriptRevision: undefined,
      appliedStartupScriptRevision: undefined,
      startupScriptLastAppliedAt: undefined,
      startupScriptStatus: publicStartupScriptStatus(record),
      image: {
        name: record.imageName || ADMIN_IMAGE,
        digest: record.imageDigest || ADMIN_DIGEST,
        promoted: true,
      },
      presentation: {
        terminalTheme: "administrative-red",
        banner: "ADMIN / ORCHESTRATOR",
        promptMarker: "[ADMIN ORCHESTRATOR]",
        browserTitle: "ADMIN ORCHESTRATOR",
        environmentMarker: "AGENTOR_ADMIN_WORKSPACE",
        warningBeforePrivilegedActions: true,
      },
      services: ["terminal", "editor", "desktop"],
    };
  }
  async security(workerId?: string) {
    if (this.runtime?.security) {
      const runtime = await this.runtime.security(workerId);
      if (runtime) return runtime;
    }
    const admin = await this.ensure();
    if (workerId && workerId !== admin.id) {
      const worker = useContainerManager().get(workerId);
      return {
        managedWorker: Boolean(worker),
        administrative: false,
        managementNetworkAttached: false,
        networks: worker ? [process.env.DOCKER_NETWORK || "agentor-net"] : [],
        publishedPorts: [],
        rawDockerSocket: false,
        hostExecution: false,
        hostFilesystemMounts: [],
        mounts: [],
      };
    }
    return {
      managedWorker: true,
      administrative: true,
      managementNetworkAttached: true,
      networks: ["agentor-management", "agentor-admin-egress-v1"],
      publishedPorts: [],
      rawDockerSocket: false,
      hostExecution: false,
      hostFilesystemMounts: [],
      mounts: [],
    };
  }
  async managementNetworkSecurity() {
    await this.ensure();
    if (!this.runtime?.managementNetworkSecurity)
      throw new Error(
        "Administrative runtime network diagnostics are unavailable",
      );
    return this.runtime.managementNetworkSecurity();
  }
  private applyRuntimeImage(
    record: AdministrativeWorkspaceRecord,
    image: AdminWorkspaceRuntimeImage | void,
  ) {
    if (!image) return false;
    let changed = false;
    if (
      record.imageName !== image.name ||
      record.imageDigest !== image.digest
    ) {
      record.imageName = image.name;
      record.imageDigest = image.digest;
      changed = true;
    }
    if (
      image.appliedStartupScriptRevision !== undefined &&
      normalizedRevision(record.appliedStartupScriptRevision) !==
        image.appliedStartupScriptRevision
    ) {
      record.appliedStartupScriptRevision =
        image.appliedStartupScriptRevision;
      record.startupScriptLastAppliedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) record.updatedAt = new Date().toISOString();
    return changed;
  }
}

export function validateAdminWorkspaceStartupScript(value: unknown) {
  if (typeof value !== "string")
    throw Object.assign(new Error("startupScript must be a string"), {
      statusCode: 400,
    });
  if (value.includes("\0"))
    throw Object.assign(new Error("startupScript must not contain NUL bytes"), {
      statusCode: 400,
    });
  if (Buffer.byteLength(value, "utf8") > 65_536)
    throw Object.assign(
      new Error("startupScript must not exceed 65536 UTF-8 bytes"),
      { statusCode: 400 },
    );
  return value;
}

export function normalizedRevision(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

export function publicStartupScriptStatus(
  record: Readonly<AdministrativeWorkspaceRecord>,
) {
  const revision = normalizedRevision(record.startupScriptRevision);
  const appliedRevision = normalizedRevision(
    record.appliedStartupScriptRevision,
  );
  return {
    configured: Boolean(record.startupScript),
    revision,
    appliedRevision,
    pendingRebuild: revision !== appliedRevision,
    lastAppliedAt: record.startupScriptLastAppliedAt,
  };
}

let singleton: AdminWorkspaceStore | undefined;
export function useAdminWorkspaceStore() {
  return (singleton ??= new AdminWorkspaceStore());
}
