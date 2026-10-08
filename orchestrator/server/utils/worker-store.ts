import { UserScopedJsonStore } from "./user-scoped-store";
import type {
  RepoConfig,
  MountConfig,
  UserOwnedResource,
  WorkerSelfApiAccess,
  WorkerRuntimeKind,
} from "../../shared/types";
import { normalizeWorkerRuntimeKind } from "../../shared/types";
import { isDeepStrictEqual } from "node:util";
import { posix } from "node:path";

export interface WorkerIncusMigration {
  nonce: string;
  phase: 'preparing' | 'source-stopped' | 'destination-created' | 'validating' | 'validated' | 'retained' | 'recovery-required';
  source: { containerId: string; createdAt: string; imageId: string; wasRunning: boolean };
  destinationIncarnation?: string;
  sourceVolumes?: Array<{ name: string; createdAt: string }>;
  sourceDirectories?: Array<{ path: string; dev: number; ino: number }>;
}

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
  /** Server-only bounded offline migration/source-retention authority. Never a
   * portable import grant, current IP or preservation of disposable rootfs. */
  incusMigration?: WorkerIncusMigration;
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
  incusRecreation?: { nonce: string; originalIncarnation?: string; replacementIncarnation?: string; initialCreate?: true;
    /** Initial restore bytes are not yet authoritative; rollback must fence
     * partial data for deletion, never make it an ordinary archived worker. */
    importIncomplete?: true };
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
    super(dataDir, "workers.json", (w) => { assertImportIncompleteMarker(w); assertIncusMigration(w); return w.id; });
  }

  override get(userId: string, key: string): WorkerRecord | undefined {
    const item = super.get(userId, key);
    if (!item) return undefined;
    return {
      ...item,
      runtimeKind: normalizeWorkerRuntimeKind(item.runtimeKind),
      ...(item.incusMigration ? { incusMigration: structuredClone(item.incusMigration) } : {}),
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
        ...(w.incusMigration ? { incusMigration: structuredClone(w.incusMigration) } : {}),
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
        ...(w.incusMigration ? { incusMigration: structuredClone(w.incusMigration) } : {}),
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
      ...(item.incusMigration ? { incusMigration: structuredClone(item.incusMigration) } : {}),
    };
  }

  async upsert(worker: WorkerRecord): Promise<void> {
    const normalized: WorkerRecord = structuredClone({
      ...worker,
      runtimeKind: normalizeWorkerRuntimeKind(worker.runtimeKind),
    });
    assertImportIncompleteMarker(normalized);
    assertIncusMigration(normalized);
    const isNew = !this.has(normalized.userId, normalized.id);
    await this.withUserMutation(normalized.userId, async () => {
      let map = this.items.get(normalized.userId);
      const created = !map;
      const previous = map?.get(normalized.id);
      if (previous?.incusMigration && (!isDeepStrictEqual(previous.incusMigration, normalized.incusMigration) ||
          normalizeWorkerRuntimeKind(previous.runtimeKind) !== normalized.runtimeKind))
        throw new Error('Incus migration authority requires its exact guarded transition');
      if (!map) { map = new Map(); this.items.set(normalized.userId, map); }
      map.set(normalized.id, structuredClone(normalized));
      try { await this.persistUser(normalized.userId); }
      catch (error) {
        if (previous) map.set(normalized.id, previous); else map.delete(normalized.id);
        if (created && !map.size) this.items.delete(normalized.userId);
        throw error;
      }
    });
    const label = normalized.displayName || normalized.id;
    if (isNew) {
      this.storeLogger().info(
        `[worker-store] registered worker ${label} (status=${normalized.status}, runtime=${normalized.runtimeKind})`,
      );
    } else {
      this.storeLogger().debug(`[worker-store] updated worker ${label} (runtime=${normalized.runtimeKind})`);
    }
  }

  /** Offline migration bookkeeping only; never starts, resumes or adopts runtime. */
  async transitionIncusMigration(userId: string, id: string, expected: WorkerIncusMigration | undefined,
    next: WorkerIncusMigration): Promise<WorkerRecord> {
    expected = expected && cloneMigration(expected); next = structuredClone(next);
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), previous = map?.get(id);
      if (!map || !previous || normalizeWorkerRuntimeKind(previous.runtimeKind) !== 'legacy-docker' ||
          previous.deletionPending || previous.incusRecreation)
        throw new Error('Legacy migration durable authority is unavailable');
      if (!isDeepStrictEqual(previous.incusMigration, expected)) throw new Error('Incus migration marker changed');
      const candidate = { ...previous, incusMigration: next };
      assertIncusMigration(candidate);
      if (!expected && next.phase !== 'preparing') throw new Error('Initial Incus migration must be preparing');
      if (expected && (expected.nonce !== next.nonce || !sameMigrationSource(expected, next) ||
          expected.destinationIncarnation && expected.destinationIncarnation !== next.destinationIncarnation))
        throw new Error('Incus migration source or captured destination changed');
      return this.persistMigration(userId, id, map, previous, candidate);
    });
  }

  async cutoverIncusMigration(userId: string, id: string, expected: WorkerIncusMigration): Promise<WorkerRecord> {
    expected = cloneMigration(expected);
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), previous = map?.get(id);
      if (!map || !previous || normalizeWorkerRuntimeKind(previous.runtimeKind) !== 'legacy-docker' ||
          previous.deletionPending || previous.incusRecreation || !isDeepStrictEqual(previous.incusMigration, expected))
        throw new Error('Validated legacy migration authority changed');
      if (expected.phase !== 'validated' || !expected.destinationIncarnation)
        throw new Error('Incus migration cutover requires validated captured destination');
      return this.persistMigration(userId, id, map, previous, { ...previous, runtimeKind: 'incus-vm',
        importedImage: undefined,
        desiredRuntimeStatus: previous.desiredRuntimeStatus ?? (expected.source.wasRunning ? 'running' : 'stopped'),
        incusMigration: { ...expected, phase: 'retained' } });
    });
  }

  async clearIncusMigration(userId: string, id: string, expected: WorkerIncusMigration): Promise<WorkerRecord> {
    expected = cloneMigration(expected);
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), previous = map?.get(id);
      if (!map || !previous || normalizeWorkerRuntimeKind(previous.runtimeKind) !== 'legacy-docker' ||
          previous.deletionPending || expected.phase === 'retained' || !isDeepStrictEqual(previous.incusMigration, expected))
        throw new Error('Only exact pre-cutover legacy migration authority may be cleared');
      return this.persistMigration(userId, id, map, previous, { ...previous, incusMigration: undefined });
    });
  }

  /** Caller first proves exact retained source cleanup. This is not rollback. */
  async clearRetainedIncusMigration(userId: string, id: string, expected: WorkerIncusMigration): Promise<WorkerRecord> {
    expected = cloneMigration(expected);
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), previous = map?.get(id);
      if (!map || !previous || normalizeWorkerRuntimeKind(previous.runtimeKind) !== 'incus-vm' ||
          expected.phase !== 'retained' || !expected.destinationIncarnation || !isDeepStrictEqual(previous.incusMigration, expected))
        throw new Error('Exact retained Incus migration source cleanup authority is unavailable');
      return this.persistMigration(userId, id, map, previous, { ...previous, incusMigration: undefined });
    });
  }

  private async persistMigration(userId: string, id: string, map: Map<string, WorkerRecord>, previous: WorkerRecord,
    candidate: WorkerRecord): Promise<WorkerRecord> {
    const next = { ...candidate, updatedAt: new Date().toISOString() };
    assertImportIncompleteMarker(next); assertIncusMigration(next);
    map.set(id, structuredClone(next));
    try { await this.persistUser(userId); }
    catch (error) { map.set(id, previous); throw error; }
    return structuredClone(next);
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
          previous.incusRecreation.replacementIncarnation !== expectedMarker.replacementIncarnation ||
          previous.incusRecreation.initialCreate !== expectedMarker.initialCreate ||
          previous.incusRecreation.importIncomplete !== expectedMarker.importIncomplete))
        throw new Error('Incus recreation recovery marker changed');
      const completion = pendingAfterCompletion ? { pendingRebuild: await pendingAfterCompletion(),
        hostMountsRevoked: false, hardwareDevicesRevoked: false } : {};
      const incompleteRollback = previous.incusRecreation?.importIncomplete === true &&
        change.status === 'archived' && change.incusRecreation === undefined;
      const next = { ...previous, ...change, ...completion,
        ...(incompleteRollback ? { deletionPending: true } : {}), updatedAt: new Date().toISOString() };
      assertImportIncompleteMarker(next);
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
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), current = map?.get(id);
      if (!map || !current) throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
      return this.persistMigration(userId, id, map, current, { ...current, desiredRuntimeStatus });
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
    mounts = mounts?.length ? structuredClone(mounts) : undefined;
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), current = map?.get(id);
      if (!map || !current) throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
      return this.persistMigration(userId, id, map, current, { ...current, mounts,
        ...(current.status === "active" && revoked ? { pendingRebuild: true, hostMountsRevoked: true } : {}) });
    });
  }

  /** Persist desired device assignments after policy changes. Active workers
   * keep a durable restart guard until Docker is rebuilt without revoked nodes. */
  async updateHardwareDeviceAccess(
    userId: string,
    id: string,
    hardwareDeviceIds: string[] | undefined,
    revoked: boolean,
  ): Promise<WorkerRecord> {
    hardwareDeviceIds = hardwareDeviceIds?.length ? [...hardwareDeviceIds] : undefined;
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), current = map?.get(id);
      if (!map || !current) throw Object.assign(new Error("Worker not found"), { statusCode: 404 });
      return this.persistMigration(userId, id, map, current, { ...current, hardwareDeviceIds,
        ...(current.status === "active" && revoked ? { pendingRebuild: true, hardwareDevicesRevoked: true } : {}) });
    });
  }

  async archive(userId: string, id: string): Promise<void> {
    const worker = await this.setArchiveStatus(userId, id, 'archived');
    this.storeLogger().info(
      `[worker-store] archived worker ${worker.displayName || worker.id}`,
    );
  }

  async markDeletionPending(userId: string, id: string): Promise<void> {
    await this.withUserMutation(userId, async () => {
      const map = this.items.get(userId), worker = map?.get(id);
      if (!map || !worker) throw new Error(`Worker not found: ${id}`);
      if (worker.incusMigration) throw new Error('Migration source-retention authority must be finalized before deletion');
      await this.persistMigration(userId, id, map, worker, { ...worker, status: "archived", deletionPending: true,
        archivedAt: worker.archivedAt ?? new Date().toISOString() });
    });
  }

  async unarchive(userId: string, id: string): Promise<void> {
    const worker = await this.setArchiveStatus(userId, id, 'active');
    this.storeLogger().info(
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
      this.storeLogger().warn(
        `[worker-store] delete failed — worker not found: ${userId}/${id}`,
      );
      throw new Error(`Worker not found: ${id}`);
    }
    this.storeLogger().info(`[worker-store] deleted worker ${userId}/${id}`);
  }
}

function assertImportIncompleteMarker(record: WorkerRecord): void {
  const marker = record.incusRecreation;
  if (marker?.importIncomplete === undefined) return; // Existing records unchanged.
  if (record.runtimeKind !== 'incus-vm' || marker.importIncomplete !== true ||
      marker.initialCreate !== true || marker.originalIncarnation !== undefined ||
      typeof marker.nonce !== 'string' || !marker.nonce || marker.nonce.length > 128)
    throw new Error('Incomplete Incus import requires an initial-create recovery marker');
}

function sameMigrationSource(left: WorkerIncusMigration, right: WorkerIncusMigration): boolean {
  return isDeepStrictEqual(left.source, right.source) &&
    isDeepStrictEqual(left.sourceVolumes ?? [], right.sourceVolumes ?? []) &&
    isDeepStrictEqual(left.sourceDirectories ?? [], right.sourceDirectories ?? []);
}

function cloneMigration(marker: WorkerIncusMigration): WorkerIncusMigration {
  const owned = structuredClone(marker);
  if (owned.sourceVolumes === undefined) owned.sourceVolumes = [];
  if (owned.sourceDirectories === undefined) owned.sourceDirectories = [];
  return owned;
}

function assertIncusMigration(record: WorkerRecord): void {
  const marker = record.incusMigration;
  if (marker === undefined) return;
  const invalid = () => { throw new Error('Invalid bounded Incus migration marker'); };
  const object = (value: unknown, allowed: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' &&
    !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
  const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
  const iso = (value: unknown) => typeof value === 'string' && value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!object(marker, ['nonce', 'phase', 'source', 'destinationIncarnation', 'sourceVolumes', 'sourceDirectories']) ||
      !uuid(marker.nonce) || !['preparing', 'source-stopped', 'destination-created', 'validating', 'validated', 'retained', 'recovery-required'].includes(marker.phase) ||
      !object(marker.source, ['containerId', 'createdAt', 'imageId', 'wasRunning']) ||
      typeof marker.source.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(marker.source.containerId) || !iso(marker.source.createdAt) ||
      typeof marker.source.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(marker.source.imageId) || typeof marker.source.wasRunning !== 'boolean' ||
      marker.destinationIncarnation !== undefined && !uuid(marker.destinationIncarnation)) invalid();
  if (['destination-created', 'validating', 'validated', 'retained'].includes(marker.phase) && !marker.destinationIncarnation) invalid();
  const runtime = normalizeWorkerRuntimeKind(record.runtimeKind);
  if (marker.phase === 'retained' ? runtime !== 'incus-vm' : runtime !== 'legacy-docker' || !!record.incusRecreation) invalid();
  const volumes = marker.sourceVolumes === undefined ? [] : marker.sourceVolumes;
  const directories = marker.sourceDirectories === undefined ? [] : marker.sourceDirectories;
  if (!Array.isArray(volumes) || !Array.isArray(directories) || volumes.length + directories.length > 35) invalid();
  if (volumes.some(volume => !object(volume, ['name', 'createdAt']) || typeof volume.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(volume.name) || !iso(volume.createdAt)) ||
      new Set(volumes.map(volume => volume.name)).size !== volumes.length) invalid();
  if (directories.some(directory => !object(directory, ['path', 'dev', 'ino']) || typeof directory.path !== 'string' ||
      directory.path.length > 4096 || !directory.path.startsWith('/') || directory.path.startsWith('//') || directory.path === '/' ||
      /[\x00-\x1f\x7f]/.test(directory.path) || posix.normalize(directory.path) !== directory.path ||
      !Number.isSafeInteger(directory.dev) || directory.dev < 0 || !Number.isSafeInteger(directory.ino) || directory.ino < 0) ||
      new Set(directories.map(directory => directory.path)).size !== directories.length) invalid();
  marker.sourceVolumes = structuredClone(volumes); marker.sourceDirectories = structuredClone(directories);
}
