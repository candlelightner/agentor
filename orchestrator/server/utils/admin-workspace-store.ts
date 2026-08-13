import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useContainerManager } from "./services";

export interface AdministrativeWorkspaceRecord {
  schemaVersion: 1;
  id: string;
  kind: "administrative";
  trusted: true;
  status: "running" | "stopped";
  marker?: string;
  createdAt: string;
  updatedAt: string;
  imageName?: string;
  imageDigest?: string;
  /** Account whose worker environment variables are injected on recreation. */
  ownerId?: string;
}

export interface AdminWorkspaceRuntimeImage {
  name: string;
  digest: string;
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
  start(record: Readonly<AdministrativeWorkspaceRecord>): Promise<void>;
  stop(record: Readonly<AdministrativeWorkspaceRecord>): Promise<void>;
  rebuild(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceRuntimeImage | void>;
  security?(workerId?: string): Promise<Record<string, unknown> | undefined>;
  managementNetworkSecurity?(): Promise<Record<string, unknown>>;
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
    await this.ensure();
    if (this.runtime)
      await this.runRuntime(() =>
        status === "running"
          ? this.runtime!.start(this.record!)
          : this.runtime!.stop(this.record!),
      );
    this.record!.status = status;
    this.record!.updatedAt = new Date().toISOString();
    await this.save();
    return this.publicRecord();
  }
  async rebuild(ownerId?: string) {
    await this.ensure();
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
  publicRecord() {
    if (!this.record)
      throw new Error("Administrative workspace not initialized");
    return {
      ...this.record,
      ownerId: undefined,
      marker: undefined,
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
    if (
      !image ||
      !this.record ||
      (this.record.imageName === image.name &&
        this.record.imageDigest === image.digest)
    )
      return;
    this.record.imageName = image.name;
    this.record.imageDigest = image.digest;
    this.record.updatedAt = new Date().toISOString();
    await this.save();
  }
}

let singleton: AdminWorkspaceStore | undefined;
export function useAdminWorkspaceStore() {
  return (singleton ??= new AdminWorkspaceStore());
}
