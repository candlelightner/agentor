import { UserScopedJsonStore } from "./user-scoped-store";
import type {
  RepoConfig,
  MountConfig,
  UserOwnedResource,
} from "../../shared/types";

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
  /** Editable, user-facing label. Free-form and not required to be unique. */
  displayName: string;
  /** Lifecycle marker. `active` = a Docker container exists for this worker;
   * `archived` = the container was removed but the worker's volumes + config are
   * kept for unarchiving. (For archived workers the record is the only evidence
   * the worker exists, since no container remains to discover it from.) */
  status: "active" | "archived";
  archivedAt?: string;
  /** Internal fail-closed marker: Docker is already gone, but permanent
   * resource cleanup must be retried. Such a record cannot be unarchived. */
  deletionPending?: boolean;
  /** Foreign key to the assigned environment — the only environment data stored
   * on the worker. The environment's config (CPU/memory/network/docker/setup
   * script/env vars/exposed APIs/capabilities/instructions) lives in the
   * EnvironmentStore and is resolved live at build time. Git identity is resolved
   * live from `userId`. */
  environmentId?: string;
  /** Account env-var names intentionally excluded; absent legacy value means []. */
  excludedGlobalEnvVarKeys?: string[];
  excludedGroupEnvVarKeys?: string[];
  repos?: RepoConfig[];
  mounts?: MountConfig[];
  initScript?: string;
  /** True when rebuild-requiring settings (environment, repos, mounts, init
   * script) were edited after the container was last (re)created and have not
   * yet been applied. Cleared on create/rebuild/unarchive. */
  pendingRebuild?: boolean;
  hostMountsRevoked?: boolean;
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

  /** Flat list of every worker across every user, sorted by the immutable UUID
   * `id` for a stable global ordering. */
  override list(): WorkerRecord[] {
    return super.list().sort((a, b) => a.id.localeCompare(b.id));
  }

  override listForUser(userId: string): WorkerRecord[] {
    // Sort by the user-facing label (the UUID `id` is meaningless to sort on).
    return super
      .listForUser(userId)
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
    return this.findWithOwner((w) => w.id === id)?.item;
  }

  async upsert(worker: WorkerRecord): Promise<void> {
    const isNew = !this.has(worker.userId, worker.id);
    await this.setItem(worker.userId, worker);
    const label = worker.displayName || worker.id;
    if (isNew) {
      useLogger().info(
        `[worker-store] registered worker ${label} (status=${worker.status})`,
      );
    } else {
      useLogger().debug(`[worker-store] updated worker ${label}`);
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

  async archive(userId: string, id: string): Promise<void> {
    const worker = this.get(userId, id);
    if (!worker) {
      useLogger().warn(
        `[worker-store] archive failed — worker not found: ${userId}/${id}`,
      );
      throw new Error(`Worker not found: ${id}`);
    }
    const updatedAt = new Date().toISOString();
    const archivedAt = worker.archivedAt ?? updatedAt;
    await this.setItem(userId, {
      ...worker,
      status: "archived",
      // Once destructive deletion has begun, no generic archive/reconcile path
      // may silently make the record unarchivable again.
      deletionPending: worker.deletionPending === true,
      archivedAt,
      updatedAt,
    });
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
    const worker = this.get(userId, id);
    if (!worker) {
      useLogger().warn(
        `[worker-store] unarchive failed — worker not found: ${userId}/${id}`,
      );
      throw new Error(`Worker not found: ${id}`);
    }
    if (worker.deletionPending) {
      throw Object.assign(
        new Error("Worker deletion cleanup is still pending"),
        { statusCode: 409 },
      );
    }
    await this.setItem(userId, {
      ...worker,
      status: "active",
      archivedAt: undefined,
      deletionPending: false,
      updatedAt: new Date().toISOString(),
    });
    useLogger().info(
      `[worker-store] unarchived worker ${worker.displayName || worker.id}`,
    );
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
