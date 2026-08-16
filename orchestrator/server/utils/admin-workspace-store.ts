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
  private runtimeTail: Promise<void> = Promise.resolve();
  constructor(dataDir = process.env.DATA_DIR || "/data") {
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
  private async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.record, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, this.path);
  }
  private runRuntime<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.runtimeTail.then(operation, operation);
    this.runtimeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async ensure() {
    await this.init();
    if (!this.record) {
      const now = new Date().toISOString();
      this.record = {
        schemaVersion: 1,
        id: randomUUID(),
        kind: "administrative",
        trusted: true,
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
      await this.save();
    }
    if (this.runtime)
      await this.runRuntime(async () =>
        this.applyRuntimeImage(await this.runtime!.ensure(this.record!)),
      );
    return this.publicRecord();
  }
  async setStatus(status: "running" | "stopped") {
    await this.init();
    // Lifecycle calls on an existing workspace must reach the runtime
    // operation directly. Calling ensure() here could auto-start a crashed
    // container from the persisted `running` state before start() has a chance
    // to replace a pending startup-script revision (or before stop()).
    if (!this.record) await this.ensure();
    if (this.runtime)
      await this.runRuntime(async () => {
        if (status === "running")
          await this.applyRuntimeImage(await this.runtime!.start(this.record!));
        else await this.runtime!.stop(this.record!);
      });
    this.record!.status = status;
    this.record!.updatedAt = new Date().toISOString();
    await this.save();
    return this.publicRecord();
  }
  async rebuild(ownerId?: string) {
    await this.init();
    // Rebuild itself is the application boundary; do not auto-start stale
    // disposable compute first merely to ensure the durable record exists.
    if (!this.record) await this.ensure();
    if (ownerId && this.record!.ownerId !== ownerId) {
      this.record!.ownerId = ownerId;
      await this.save();
    }
    if (!this.runtime)
      throw Object.assign(
        new Error("Administrative workspace runtime is unavailable"),
        { statusCode: 503 },
      );
    await this.runRuntime(async () =>
      this.applyRuntimeImage(await this.runtime!.rebuild(this.record!)),
    );
    this.record!.status = "running";
    this.record!.updatedAt = new Date().toISOString();
    await this.save();
    return this.publicRecord();
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
    await this.ensure();
    this.record!.marker = marker;
    this.record!.updatedAt = new Date().toISOString();
    await this.save();
    return { marker };
  }
  async readMarker() {
    await this.ensure();
    return { marker: this.record!.marker ?? null };
  }
  async getStartupScript() {
    await this.init();
    if (!this.record)
      throw Object.assign(new Error("Administrative workspace not provisioned"), {
        statusCode: 404,
      });
    return this.startupScriptRecord(this.record);
  }
  async setStartupScript(value: unknown) {
    await this.init();
    if (!this.record)
      throw Object.assign(new Error("Administrative workspace not provisioned"), {
        statusCode: 404,
      });
    const script = validateAdminWorkspaceStartupScript(value);
    if ((this.record.startupScript || "") !== script) {
      this.record.startupScript = script;
      this.record.startupScriptRevision =
        normalizedRevision(this.record.startupScriptRevision) + 1;
      this.record.updatedAt = new Date().toISOString();
      await this.save();
    }
    return this.startupScriptRecord(this.record);
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
  publicRecord() {
    if (!this.record)
      throw new Error("Administrative workspace not initialized");
    return {
      ...this.record,
      ownerId: undefined,
      marker: undefined,
      startupScript: undefined,
      startupScriptRevision: undefined,
      appliedStartupScriptRevision: undefined,
      startupScriptLastAppliedAt: undefined,
      startupScriptStatus: publicStartupScriptStatus(this.record),
      image: {
        name: this.record.imageName || ADMIN_IMAGE,
        digest: this.record.imageDigest || ADMIN_DIGEST,
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
  private async applyRuntimeImage(image: AdminWorkspaceRuntimeImage | void) {
    if (!image || !this.record) return;
    let changed = false;
    if (
      this.record.imageName !== image.name ||
      this.record.imageDigest !== image.digest
    ) {
      this.record.imageName = image.name;
      this.record.imageDigest = image.digest;
      changed = true;
    }
    if (
      image.appliedStartupScriptRevision !== undefined &&
      normalizedRevision(this.record.appliedStartupScriptRevision) !==
        image.appliedStartupScriptRevision
    ) {
      this.record.appliedStartupScriptRevision =
        image.appliedStartupScriptRevision;
      this.record.startupScriptLastAppliedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) {
      this.record.updatedAt = new Date().toISOString();
      await this.save();
    }
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
