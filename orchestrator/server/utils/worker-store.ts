import { UserScopedJsonStore } from "./user-scoped-store";
import type {
  RepoConfig,
  MountConfig,
  UserOwnedResource,
  WorkerSelfApiAccess,
  WorkerRuntimeKind,
} from "../../shared/types";
import { normalizeWorkerRuntimeKind } from "../../shared/types";

/** Persisted worker metadata — intentionally minimal. It stores ONLY what cannot
 * be discovered from Docker at runtime: the worker's identity, owner, editable
 * label, lifecycle marker, and the config used to (re)build its container.
 *
 * `id` (from `UserOwnedResource`) is the worker's stable UUID identity — the store
 * key and the `agentor.id` Docker label. Everything describing the live container
 * (its Docker id, `<prefix>-<id>` name, image name + image id, running/stopped
 * state) is resolved at runtime in `ContainerManager.sync()` by matching the
 * `agentor.id` label, never persisted here. Extends `UserOwnedResource`, so it
 * also carries `userId`/`createdAt`/`updatedAt`. */
export interface WorkerRecord extends UserOwnedResource {
  /** Worker compute runtime technology: legacy Docker container vs Incus VM. */
  runtimeKind?: WorkerRuntimeKind;
  /** Editable, user-facing label. Free-form and not required to be unique. */
  displayName: string;
  /** Lifecycle marker. `active` = a Docker container exists for this worker;
   * `archived` = the container was removed but the worker's volumes + config are
   * kept for unarchiving. (For archived workers the record is the only evidence
   * the worker exists, since no container remains to discover it from.) */
  status: "active" | "archived";
  /** Desired runtime state survives daemon/orchestrator restarts. Legacy
   * records are migrated from the first successfully verified observation. */
  desiredRuntimeStatus?: "running" | "stopped";
  archivedAt?: string;
  /** Internal fail-closed marker: Docker is already gone, but permanent
   * resource cleanup must be retried. Such a record cannot be unarchived. */
  deletionPending?: boolean;
  /** Bounded Incus compute-replacement recovery marker, not portable image or
   * storage authority. Unfinished replacements stay inaccessible until resolved. */
  incusRecreation?: { nonce: string; originalIncarnation?: string; replacementIncarnation?: string };
  /** Foreign key to the assigned environment — the only environment data stored
   * on the worker. The environment's config (CPU/memory/network/docker/setup
   * script/env vars/exposed APIs/capabilities/instructions) lives in the
   * EnvironmentStore and is resolved live at build time. Git identity is resolved
   * live from `userId`. */
  environmentId?: string;
  /** Account env-var names intentionally excluded; absent legacy value means []. */
  excludedGlobalEnvVarKeys?: string[];
  excludedGroupEnvVarKeys?: string[];
  /** Live worker-self API override. Missing legacy values inherit (allow). */
  workerSelfApiAccess?: WorkerSelfApiAccess;
  repos?: RepoConfig[];
  mounts?: MountConfig[];
  hardwareDeviceIds?: string[];
  initScript?: string;
  /** True when rebuild-requiring settings (environment, repos, mounts, init
   * script) were edited after the container was last (re)created and have not
   * yet been applied. Cleared on create/rebuild/unarchive. */
  pendingRebuild?: boolean;
  hostMountsRevoked?: boolean;
  hardwareDevicesRevoked?: boolean;
  /** Set on workers restored via import that captured the source container's
   * filesystem (`docker import`). The per-worker image reference the worker runs
   * — reused across rebuild/unarchive so the captured rootfs survives. Unset for
   * normal workers (which run the shared standard worker image). */
  importedImage?: string;
  /** Internal ownership marker for a custom environment created implicitly by
   * this import. The environment is removed with its final owning worker unless
   * another worker adopted it. Never projected into the public worker response. */
  importCreatedEnvironmentId?: string;
  imageDefinitionId?: string;
  imageVersion?: string;
  imageDigest?: string;
  imageRuntimeReference?: string;
}

export class WorkerStore extends UserScopedJsonStore<string, WorkerRecord> {
  constructor(dataDir: string) {
    super(dataDir, "workers.json", (w) => w.id);
  }

  override get(userId: string, key: string): WorkerRecord | undefined {
    const item = super.get(userId, key);
    if (!item) return undefined;
    return {
      ...item,
      runtimeKind: normalizeWorkerRuntimeKind(item.runtimeKind),
    };
  }

  /** Flat list of every worker across every user, sorted by the immutable UUID
   * `id` for a stable global ordering. */
  override list(): WorkerRecord[] {
    return super
      .list()
      .map((w) => ({
        ...w,
        runtimeKind: normalizeWorkerRuntimeKind(w.runtimeKind),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  override listForUser(userId: string): WorkerRecord[] {
    // Sort by the user-facing label (the UUID `id` is meaningless to sort on).
    return super
      .listForUser(userId)
      .map((w) => ({
        ...w,
        runtimeKind: normalizeWorkerRuntimeKind(w.runtimeKind),
      }))
      .sort((a, b) =>
        (a.displayName || a.id).localeCompare(b.displayName || b.id),
      );
  }

  listArchived(): WorkerRecord[] {
    return this.list().filter((w) => w.status === "archived");
  }

  listActive(): WorkerRecord[] {
    return this.list().filter((w) => w.status === "active");
  }

  /** Find a worker by its UUID `id` across all users. Used to resolve the
   * `agentor.id` Docker label back to its record (and, since `containerName` is
   * just `<prefix>-<id>`, to resolve a container name once the prefix is stripped). */
  findById(id: string): WorkerRecord | undefined {
    const item = this.findWithOwner((w) => w.id === id)?.item;
    if (!item) return undefined;
    return {
      ...item,
      runtimeKind: normalizeWorkerRuntimeKind(item.runtimeKind),
    };
  }

  async upsert(worker: WorkerRecord): Promise<void> {
    const normalized: WorkerRecord = {
      ...worker,
      runtimeKind: normalizeWorkerRuntimeKind(worker.runtimeKind),
    };
    const isNew = !this.has(normalized.userId, normalized.id);
    await this.setItem(normalized.userId, normalized);
    const label = normalized.displayName || normalized.id;
    if (isNew) {
      useLogger().info(
        `[worker-store] registered worker ${label} (status=${normalized.status}, runtime=${normalized.runtimeKind})`,
      );
    } else {
      useLogger().debug(`[worker-store] updated worker ${label} (runtime=${normalized.runtimeKind})`);
    }
  }

  /** Atomically mark an existing worker for rebuild without ever creating it.
   * The lookup happens inside the same per-owner store transaction as the
   * write, so a queued environment/configuration update cannot reinsert a
   * worker that was deleted while the caller held a stale record reference. */
  async markPendingRebuild(
    userId: string,
    id: string,
  ): Promise<WorkerRecord | undefined> {
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId);
      const previous = map?.get(id);
      if (!map || !previous) return undefined;
      const next: WorkerRecord = {
        ...previous,
        pendingRebuild: true,
        updatedAt: new Date().toISOString(),
      };
      map.set(id, next);
      try {
        await this.persistUser(userId);
      } catch (error) {
        map.set(id, previous);
        throw error;
      }
      return structuredClone(next);
    });
  }

  /** Incus replacement transitions merge only runtime fields inside the owner
   * store queue; a slow boot must never overwrite concurrently edited config. */
  async transitionIncusRecreation(userId: string, id: string,
    change: Pick<WorkerRecord, 'status' | 'desiredRuntimeStatus' | 'incusRecreation'>,
    pendingAfterCompletion?: () => Promise<boolean>,
    expectedMarker?: NonNullable<WorkerRecord['incusRecreation']>): Promise<WorkerRecord> {
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), previous = map?.get(id);
      if (!map || !previous || previous.runtimeKind !== 'incus-vm' || previous.deletionPending)
        throw new Error('Incus recreation durable authority is unavailable');
      if (expectedMarker && (previous.incusRecreation?.nonce !== expectedMarker.nonce ||
          previous.incusRecreation.originalIncarnation !== expectedMarker.originalIncarnation ||
          previous.incusRecreation.replacementIncarnation !== expectedMarker.replacementIncarnation))
        throw new Error('Incus recreation recovery marker changed');
      const completion = pendingAfterCompletion ? { pendingRebuild: await pendingAfterCompletion(),
        hostMountsRevoked: false, hardwareDevicesRevoked: false } : {};
      const next = { ...previous, ...change, ...completion, updatedAt: new Date().toISOString() };
      map.set(id, structuredClone(next));
      try { await this.persistUser(userId); }
      catch (error) { map.set(id, previous); throw error; }
      return structuredClone(next);
    });
  }

  async setDesiredRuntimeStatus(
    userId: string,
    id: string,
    desiredRuntimeStatus: "running" | "stopped",
  ): Promise<WorkerRecord> {
    const current = this.get(userId, id);
    if (!current)
      throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
    const updated: WorkerRecord = {
      ...current,
      desiredRuntimeStatus,
      updatedAt: new Date().toISOString(),
    };
    await this.setItem(userId, updated);
    return updated;
  }

  /** Persist the desired host-mount set after a grant/hierarchy change. Active
   * workers additionally carry a restart guard until a rebuild has replaced
   * the old Docker container and its immutable bind configuration. */
  async updateHostMountAccess(
    userId: string,
    id: string,
    mounts: MountConfig[] | undefined,
    revoked: boolean,
  ): Promise<WorkerRecord> {
    const current = this.get(userId, id);
    if (!current)
      throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
    const updated: WorkerRecord = {
      ...current,
      mounts: mounts?.length ? structuredClone(mounts) : undefined,
      ...(current.status === "active" && revoked
        ? { pendingRebuild: true, hostMountsRevoked: true }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.setItem(userId, updated);
    return updated;
  }

  /** Persist desired device assignments after policy changes. Active workers
   * keep a durable restart guard until Docker is rebuilt without revoked nodes. */
  async updateHardwareDeviceAccess(
    userId: string,
    id: string,
    hardwareDeviceIds: string[] | undefined,
    revoked: boolean,
  ): Promise<WorkerRecord> {
    const current = this.get(userId, id);
    if (!current)
      throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
    const updated: WorkerRecord = {
      ...current,
      hardwareDeviceIds: hardwareDeviceIds?.length ? [...hardwareDeviceIds] : undefined,
      ...(current.status === "active" && revoked
        ? { pendingRebuild: true, hardwareDevicesRevoked: true }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.setItem(userId, updated);
    return updated;
  }

  async archive(userId: string, id: string): Promise<void> {
    const worker = await this.setArchiveStatus(userId, id, 'archived');
    useLogger().info(
      `[worker-store] archived worker ${worker.displayName || worker.id}`,
    );
  }

  async markDeletionPending(userId: string, id: string): Promise<void> {
    const worker = this.get(userId, id);
    if (!worker) throw new Error(`Worker not found: ${id}`);
    const updatedAt = new Date().toISOString();
    const archivedAt = worker.archivedAt ?? updatedAt;
    await this.setItem(userId, {
      ...worker,
      status: "archived",
      deletionPending: true,
      archivedAt,
      updatedAt,
    });
  }

  async unarchive(userId: string, id: string): Promise<void> {
    const worker = await this.setArchiveStatus(userId, id, 'active');
    useLogger().info(
      `[worker-store] unarchived worker ${worker.displayName || worker.id}`,
    );
  }

  private async setArchiveStatus(userId: string, id: string, status: WorkerRecord['status']): Promise<WorkerRecord> {
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), previous = map?.get(id);
      if (!map || !previous) throw new Error(`Worker not found: ${id}`);
      if (status === 'active' && previous.deletionPending)
        throw Object.assign(new Error('Worker deletion cleanup is still pending'), { statusCode: 409 });
      const stamp = new Date().toISOString();
      const next: WorkerRecord = { ...previous, status, updatedAt: stamp,
        archivedAt: status === 'archived' ? previous.archivedAt ?? stamp : undefined,
        deletionPending: status === 'archived' && previous.deletionPending === true };
      map.set(id, next);
      try { await this.persistUser(userId); }
      catch (error) { map.set(id, previous); throw error; }
      return structuredClone(next);
    });
  }

  async delete(userId: string, id: string): Promise<void> {
    const existed = await this.deleteItem(userId, id);
    if (!existed) {
      useLogger().warn(
        `[worker-store] delete failed — worker not found: ${userId}/${id}`,
      );
      throw new Error(`Worker not found: ${id}`);
    }
    useLogger().info(`[worker-store] deleted worker ${userId}/${id}`);
  }
}
