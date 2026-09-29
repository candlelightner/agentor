import { WorkerDurableStore, type WorkerStoreIO } from "./worker-durable-store";
import type {
  RepoConfig,
  MountConfig,
  UserOwnedResource,
  WorkerSelfApiAccess,
  WorkerRuntimeProfile,
  RuntimeSnapshotIdentity,
} from "../../shared/types";

const SHA256_IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const RUNTIME_IMAGE_REFERENCE = /^agentor-import-[a-zA-Z0-9_-]+:runtime-[a-zA-Z0-9_-]+$/;

export function validRuntimeSnapshotIdentity(value: unknown, importedImage?: string, workerId?: string): value is RuntimeSnapshotIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  if (Object.keys(identity).some((key) => !["reference", "imageId", "portableIdentity"].includes(key))) return false;
  if (typeof identity.reference !== "string" || !RUNTIME_IMAGE_REFERENCE.test(identity.reference) ||
      identity.reference !== importedImage ||
      (workerId !== undefined && !identity.reference.startsWith(`agentor-import-${workerId}:runtime-`)) ||
      typeof identity.imageId !== "string" || !SHA256_IMAGE_ID.test(identity.imageId)) return false;
  const portable = identity.portableIdentity;
  if (portable === undefined) return true;
  if (!portable || typeof portable !== "object" || Array.isArray(portable)) return false;
  const portableRecord = portable as Record<string, unknown>;
  if (Object.keys(portableRecord).some((key) => !["version", "configDigest", "platform"].includes(key))) return false;
  const platform = portableRecord.platform;
  if (!platform || typeof platform !== "object" || Array.isArray(platform)) return false;
  const platformRecord = platform as Record<string, unknown>;
  if (Object.keys(platformRecord).some((key) => !["os", "architecture", "variant"].includes(key))) return false;
  const component = (item: unknown) => typeof item === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(item);
  return portableRecord.version === 1 && typeof portableRecord.configDigest === "string" &&
    SHA256_IMAGE_ID.test(portableRecord.configDigest) &&
    component(platformRecord.os) && component(platformRecord.architecture) &&
    (platformRecord.variant === undefined || component(platformRecord.variant));
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
  /** Editable, user-facing label. Free-form and not required to be unique. */
  displayName: string;
  /** Lifecycle marker. `active` = a Docker container exists for this worker;
   * `archived` = the container was removed but the worker's volumes + config are
   * kept for unarchiving. (For archived workers the record is the only evidence
   * the worker exists, since no container remains to discover it from.) */
  status: "active" | "archived";
  /** New records carry an explicit profile; absence is pre-upgrade legacy. */
  runtimeProfile?: WorkerRuntimeProfile;
  /** Granted only by a trusted admin operation or migration from Docker inspect. */
  legacyPrivilegeGrant?: "preexisting" | "admin";
  /** Instance restore requires a fresh destination administrator decision. */
  runtimeRestoreApprovalRequired?: boolean;
  /** Desired runtime state survives daemon/orchestrator restarts. Legacy
   * records are migrated from the first successfully verified observation. */
  desiredRuntimeStatus?: "running" | "stopped";
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
  /** Dirty-signal generation; old backup arrays without it start at zero. */
  configurationRevision?: number;
  hostMountsRevoked?: boolean;
  hardwareDevicesRevoked?: boolean;
  /** Set on workers restored via import that captured the source container's
   * filesystem (`docker import`). The per-worker image reference the worker runs
   * — reused across rebuild/unarchive so the captured rootfs survives. Unset for
   * normal workers (which run the shared standard worker image). */
  importedImage?: string;
  /** Expected stopped-container snapshot identity; local Docker content must
   * still be proved before every container recreation. */
  runtimeSnapshotIdentity?: RuntimeSnapshotIdentity;
  /** Internal ownership marker for a custom environment created implicitly by
   * this import. The environment is removed with its final owning worker unless
   * another worker adopted it. Never projected into the public worker response. */
  importCreatedEnvironmentId?: string;
  imageDefinitionId?: string;
  imageVersion?: string;
  imageDigest?: string;
  imageRuntimeReference?: string;
}

export type WorkerRuntimeProjection = Pick<WorkerRecord,
  'runtimeProfile' | 'legacyPrivilegeGrant' | 'importedImage' | 'runtimeSnapshotIdentity'>;
/** Absent legacy profile is intentionally distinct from explicit legacy-runc.
 * Only capturePreexistingRuntime or an explicitly guarded trusted write may
 * normalize it. Snapshot comparison is independent of JSON property order. */
export function workerRuntimeProjection(record: WorkerRuntimeProjection): WorkerRuntimeProjection {
  return structuredClone({ runtimeProfile: record.runtimeProfile, legacyPrivilegeGrant: record.legacyPrivilegeGrant,
    importedImage: record.importedImage, runtimeSnapshotIdentity: record.runtimeSnapshotIdentity });
}
export function sameWorkerRuntimeProjection(left: WorkerRuntimeProjection, right: WorkerRuntimeProjection): boolean {
  const canonical = (value: WorkerRuntimeProjection) => {
    const identity = value.runtimeSnapshotIdentity, portable = identity?.portableIdentity;
    return JSON.stringify([value.runtimeProfile ?? null, value.legacyPrivilegeGrant ?? null, value.importedImage ?? null,
      identity ? [identity.reference, identity.imageId, portable ? [portable.version, portable.configDigest,
        portable.platform.os, portable.platform.architecture, portable.platform.variant ?? null] : null] : null]);
  };
  return canonical(left) === canonical(right);
}
export interface WorkerRuntimeWriteGuard {
  expectedRuntime: WorkerRuntimeProjection;
  /** Absence/false both mean no restore hold. Trusted admin context only. */
  expectedRestoreApprovalRequired?: boolean;
}
export interface WorkerRuntimeMigrationTransition {
  userId: string;
  workerId: string;
  expected: WorkerRuntimeProjection;
  target: WorkerRuntimeProjection;
}
export type WorkerSettingsPatch = Partial<Pick<WorkerRecord,
  'displayName' | 'workerSelfApiAccess' | 'environmentId' | 'excludedGlobalEnvVarKeys' |
  'excludedGroupEnvVarKeys' | 'initScript' | 'repos' | 'mounts' | 'hardwareDeviceIds'>> & { pendingRebuild?: true };
function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409, code: 'WORKER_RECORD_RUNTIME_CONFLICT' });
}
function nextConfigurationRevision(record: WorkerRecord): number {
  const revision = record.configurationRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER)
    throw conflict('Worker configuration revision is exhausted or invalid');
  return revision + 1;
}

export class WorkerStore extends WorkerDurableStore<WorkerRecord> {
  constructor(dataDir: string, io?: WorkerStoreIO) {
    super(dataDir, (w) => {
      if (!w || typeof w.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(w.id) ||
          !['active', 'archived'].includes(w.status) ||
          (w.runtimeProfile !== undefined && !['legacy-runc', 'kata-qemu'].includes(w.runtimeProfile)) ||
          (w.configurationRevision !== undefined && (!Number.isSafeInteger(w.configurationRevision) || w.configurationRevision < 0)) ||
          (w.legacyPrivilegeGrant !== undefined && !['admin', 'preexisting'].includes(w.legacyPrivilegeGrant)))
        throw new Error('Invalid worker record');
      if (w.runtimeSnapshotIdentity !== undefined &&
          !validRuntimeSnapshotIdentity(w.runtimeSnapshotIdentity, w.importedImage, w.id))
        throw new Error("Invalid worker runtime snapshot identity");
      return w.id;
    }, io);
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

  /** Ordinary full metadata writes must leave the runtime tuple/hold unchanged.
   * A trusted expected-runtime guard instead selects a runtime-only CAS: apply
   * its tuple/hold and timestamp to queue-current metadata, never the caller's
   * possibly stale labels/settings/lifecycle. This is used by admin grants and
   * immutable-image backfill; it is not permission to replace other fields. */
  async upsert(worker: WorkerRecord, guard?: WorkerRuntimeWriteGuard): Promise<void> {
    const owned = structuredClone(worker), expected = guard ? structuredClone(guard) : undefined;
    await this.transaction(owned.userId, draft => {
      const current = draft.get(owned.id);
      if (expected) {
        if (!current || !sameWorkerRuntimeProjection(current, expected.expectedRuntime) ||
            (current.runtimeRestoreApprovalRequired === true) !== (expected.expectedRestoreApprovalRequired === true))
          throw conflict('Worker runtime changed before guarded record write');
      } else if (current && (!sameWorkerRuntimeProjection(current, owned) ||
          (current.runtimeRestoreApprovalRequired === true) !== (owned.runtimeRestoreApprovalRequired === true))) {
        throw conflict('Changing an existing worker runtime or restore hold requires an expected runtime guard');
      }
      if (!expected && current && (current.configurationRevision ?? 0) !== (owned.configurationRevision ?? 0))
        throw conflict('Stale worker configuration cannot replace newer metadata');
      if (current?.deletionPending && !owned.deletionPending)
        throw conflict('Worker deletion cleanup is still pending');
      draft.set(owned.id, expected && current ? {
        ...current, ...workerRuntimeProjection(owned),
        runtimeRestoreApprovalRequired: owned.runtimeRestoreApprovalRequired,
        updatedAt: owned.updatedAt,
      } : current ? { ...owned, configurationRevision: nextConfigurationRevision(current) } : owned);
      return { result: undefined, persist: true };
    });
  }

  /** Runtime-only compare-and-set under the owner queue. Caller owns the
   * owner/worker lifecycle fence and has verified Docker/journal authority.
   * Neither this method nor a matching tuple proves Docker settlement.
   * An idempotent match still fsyncs the complete owner snapshot. */
  async transitionRuntimeMigration(input: WorkerRuntimeMigrationTransition): Promise<WorkerRecord> {
    const owned = structuredClone(input);
    return this.transaction(owned.userId, draft => {
      const current = draft.get(owned.workerId);
      if (!current) throw Object.assign(conflict('Worker not found for runtime migration transition'), { statusCode: 404 });
      if (current.userId !== owned.userId || current.status !== 'active' || current.deletionPending ||
          current.runtimeRestoreApprovalRequired)
        throw conflict('Worker lifecycle does not permit a runtime migration transition');
      if (!sameWorkerRuntimeProjection(current, owned.expected) && !sameWorkerRuntimeProjection(current, owned.target))
        throw conflict('Worker runtime no longer matches the migration source or target');
      const next = { ...current, ...workerRuntimeProjection(owned.target), updatedAt: new Date().toISOString() };
      draft.set(owned.workerId, next);
      return { result: next, persist: true };
    });
  }

  private updateExisting(userId: string, id: string, update: (current: WorkerRecord) => WorkerRecord): Promise<WorkerRecord> {
    return this.transaction(userId, draft => {
      const current = draft.get(id);
      if (!current) throw Object.assign(new Error('Worker not found'), { statusCode: 404 });
      const next = update(current);
      draft.set(id, next);
      return { result: next, persist: true };
    });
  }

  /** Field-specific settings merge against queue-current metadata. A settings
   * edit can require a rebuild, but cannot clear another writer's rebuild debt. */
  async updateSettings(userId: string, id: string, patch: WorkerSettingsPatch,
    expectedRuntime: WorkerRuntimeProjection): Promise<WorkerRecord> {
    const owned = structuredClone(patch), expected = workerRuntimeProjection(expectedRuntime);
    const allowed = new Set(['displayName', 'workerSelfApiAccess', 'environmentId', 'excludedGlobalEnvVarKeys',
      'excludedGroupEnvVarKeys', 'initScript', 'repos', 'mounts', 'hardwareDeviceIds', 'pendingRebuild']);
    if (Object.keys(owned).some(key => !allowed.has(key)) ||
        ('pendingRebuild' in owned && owned.pendingRebuild !== true))
      throw conflict('Invalid worker settings patch');
    return this.updateExisting(userId, id, current => {
      if (current.status !== 'active' || current.deletionPending || !sameWorkerRuntimeProjection(current, expected))
        throw conflict('Worker runtime changed before settings were saved');
      return { ...current, ...owned, configurationRevision: nextConfigurationRevision(current), updatedAt: new Date().toISOString() };
    });
  }

  /** A successful recreation applies only the configuration generation it
   * actually read. A newer dirty signal keeps its metadata and rebuild debt;
   * it is not a reason to destroy an otherwise valid replacement. */
  async completeRecreation(userId: string, id: string, expected: WorkerRuntimeProjection,
    configurationRevision: number): Promise<WorkerRecord> {
    const runtime = workerRuntimeProjection(expected);
    if (!Number.isSafeInteger(configurationRevision) || configurationRevision < 0)
      throw conflict('Invalid applied configuration revision');
    return this.updateExisting(userId, id, current => {
      if (current.status !== 'active' || current.deletionPending || current.runtimeRestoreApprovalRequired ||
          !sameWorkerRuntimeProjection(current, runtime))
        throw conflict('Worker authority or lifecycle changed during recreation');
      const applied = (current.configurationRevision ?? 0) === configurationRevision;
      return { ...current, ...(applied ? { pendingRebuild: false, hostMountsRevoked: false, hardwareDevicesRevoked: false } : {}),
        updatedAt: new Date().toISOString() };
    });
  }

  /** No missing-worker resurrection, including when queued behind deletion. */
  async markPendingRebuild(userId: string, id: string): Promise<WorkerRecord | undefined> {
    return this.transaction(userId, draft => {
      const current = draft.get(id);
      if (!current) return { result: undefined, persist: false };
      const next = { ...current, pendingRebuild: true, configurationRevision: nextConfigurationRevision(current), updatedAt: new Date().toISOString() };
      draft.set(id, next);
      return { result: next, persist: true };
    });
  }

  async setDesiredRuntimeStatus(userId: string, id: string, desiredRuntimeStatus: 'running' | 'stopped'): Promise<WorkerRecord> {
    return this.updateExisting(userId, id, current => ({
      ...current, desiredRuntimeStatus, updatedAt: new Date().toISOString(),
    }));
  }

  /** Trusted, inspected one-way enrollment of a pre-profile legacy worker. */
  async capturePreexistingRuntime(userId: string, id: string, privileged: boolean): Promise<WorkerRecord | undefined> {
    return this.transaction(userId, draft => {
      const current = draft.get(id);
      if (!current || current.status !== 'active' || current.runtimeProfile !== undefined ||
          current.deletionPending || current.runtimeRestoreApprovalRequired)
        return { result: current, persist: false };
      const next: WorkerRecord = { ...current, runtimeProfile: 'legacy-runc',
        ...(privileged ? { legacyPrivilegeGrant: 'preexisting' as const } : {}),
        updatedAt: new Date().toISOString() };
      draft.set(id, next);
      return { result: next, persist: true };
    });
  }

  async updateHostMountAccess(userId: string, id: string, mounts: MountConfig[] | undefined, revoked: boolean): Promise<WorkerRecord> {
    const owned = mounts?.length ? structuredClone(mounts) : undefined;
    return this.updateExisting(userId, id, current => ({
      ...current, mounts: owned,
      configurationRevision: nextConfigurationRevision(current),
      ...(current.status === 'active' && revoked ? { pendingRebuild: true, hostMountsRevoked: true } : {}),
      updatedAt: new Date().toISOString(),
    }));
  }

  async updateHardwareDeviceAccess(userId: string, id: string, hardwareDeviceIds: string[] | undefined, revoked: boolean): Promise<WorkerRecord> {
    const owned = hardwareDeviceIds?.length ? [...hardwareDeviceIds] : undefined;
    return this.updateExisting(userId, id, current => ({
      ...current, hardwareDeviceIds: owned,
      configurationRevision: nextConfigurationRevision(current),
      ...(current.status === 'active' && revoked ? { pendingRebuild: true, hardwareDevicesRevoked: true } : {}),
      updatedAt: new Date().toISOString(),
    }));
  }

  async archive(userId: string, id: string): Promise<void> {
    await this.updateExisting(userId, id, current => {
      const updatedAt = new Date().toISOString();
      return { ...current, status: 'archived', deletionPending: current.deletionPending === true,
        archivedAt: current.archivedAt ?? updatedAt, updatedAt };
    });
  }

  async markDeletionPending(userId: string, id: string): Promise<void> {
    await this.updateExisting(userId, id, current => {
      const updatedAt = new Date().toISOString();
      return { ...current, status: 'archived', deletionPending: true,
        archivedAt: current.archivedAt ?? updatedAt, updatedAt };
    });
  }

  async unarchive(userId: string, id: string): Promise<void> {
    await this.updateExisting(userId, id, current => {
      if (current.deletionPending) throw conflict('Worker deletion cleanup is still pending');
      return { ...current, status: 'active', archivedAt: undefined, deletionPending: false,
        desiredRuntimeStatus: 'running',
        updatedAt: new Date().toISOString() };
    });
  }

  async delete(userId: string, id: string): Promise<void> {
    if (!await this.deleteItem(userId, id))
      throw Object.assign(new Error('Worker not found'), { statusCode: 404 });
  }
}
