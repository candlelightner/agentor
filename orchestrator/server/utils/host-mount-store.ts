import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type {
  HostMountGrant,
  HostMountGrantTarget,
  HostMountPath,
  MountConfig,
} from "../../shared/types";
import { UserScopedJsonStore } from "./user-scoped-store";
import type { WorkerGroupStore } from "./worker-group-store";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import type { WorkerStore } from "./worker-store";

const PLATFORM_FILE = "admin/host-mount-paths.v1.json";
const PROTECTED_HOST_PATHS = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var/run",
  "/boot",
  "/etc",
  "/root",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var/lib/docker",
  "/var/lib/containerd",
] as const;

export interface HostMountRevocation {
  pathIds: string[];
  removedGrantIds: string[];
}

function statusError(statusCode: number, message: string) {
  // h3 deliberately replaces the public status text of a plain Error with
  // "Server Error", even when it carries a statusCode.  Keep the same Error
  // shape used by management domains, but opt this validation message into
  // the authenticated REST response as well so callers receive an actionable
  // denial instead of losing the reason at the HTTP boundary.
  return Object.assign(new Error(message), { statusCode, statusMessage: message });
}

function overlaps(left: string, right: string) {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

/** Validate a host source before it can enter the global catalog. This is a
 * lexical, fail-closed boundary: only canonical absolute POSIX paths are
 * accepted, and system/authority surfaces plus Agentor's actual host data
 * directory cannot be named directly or through an ancestor mount. */
export function validateHostMountCatalogSource(
  input: unknown,
  dataHostPath: string,
): string {
  if (!dataHostPath)
    throw statusError(
      503,
      "Agentor could not resolve its host data path, so adding host mounts is disabled until storage discovery succeeds.",
    );
  if (typeof input !== "string" || !input)
    throw statusError(400, "Host path is required");
  if (/[\u0000-\u001f\u007f]/.test(input) || input.includes("\\") || input.includes(":"))
    throw statusError(
      400,
      "Host path must be an absolute POSIX path without control, backslash, or colon characters.",
    );
  const canonical = posix.normalize(input);
  if (!posix.isAbsolute(input) || canonical !== input || input === "/")
    throw statusError(
      400,
      "Host path must be canonical and absolute; the host root and traversal aliases are not allowed.",
    );
  const protectedPaths = [...PROTECTED_HOST_PATHS, posix.normalize(dataHostPath)];
  const blocked = protectedPaths.find((candidate) => overlaps(canonical, candidate));
  if (blocked)
    throw statusError(
      400,
      `Host path overlaps protected system or Agentor storage (${blocked}). Choose a dedicated data directory instead.`,
    );
  return canonical;
}

export function validateHostMountTarget(input: unknown): string {
  if (typeof input !== "string" || !input)
    throw statusError(400, "Container mount target is required");
  if (/[\u0000-\u001f\u007f]/.test(input) || input.includes("\\") || input.includes(":"))
    throw statusError(
      400,
      "Container mount target must be an absolute POSIX path without control, backslash, or colon characters.",
    );
  const canonical = posix.normalize(input);
  if (!posix.isAbsolute(input) || canonical !== input || canonical === "/")
    throw statusError(
      400,
      "Container mount target must be a canonical absolute path below the container root.",
    );
  return canonical;
}

/** Persistent global path catalog plus owner-partitioned entitlements and
 * assignments. Raw host paths never live in the owner-controlled partition. */
export class HostMountStore extends UserScopedJsonStore<string, HostMountGrant> {
  private catalog = new Map<string, HostMountPath>();
  private catalogWrites = Promise.resolve();
  private catalogUnavailable = false;

  constructor(
    dataDir: string,
    private readonly dataHostPath: () => string,
    private readonly groups: WorkerGroupStore,
    private readonly workers: WorkerStore,
  ) {
    super(dataDir, "host-mount-grants.json", (grant) => {
      validatePersistedGrant(grant);
      return grant.id;
    });
  }

  override async init() {
    await Promise.all([super.init(), this.loadCatalog()]);
  }

  listCatalog() {
    this.assertCatalogAvailable();
    return [...this.catalog.values()]
      .map((item) => structuredClone(item))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getPath(pathId: string) {
    this.assertCatalogAvailable();
    const item = this.catalog.get(pathId);
    return item ? structuredClone(item) : undefined;
  }

  listEntitledPaths(userId: string) {
    const entitled = new Set(
      this.listForUser(userId)
        .filter(
          (grant) =>
            grant.targetType === "entitlement" &&
            grant.grantorType === "platform",
        )
        .map((grant) => grant.pathId),
    );
    return this.listCatalog().filter((path) => entitled.has(path.id));
  }

  listGrants(userId: string, includeEntitlements = false) {
    return this.listForUser(userId).filter(
      (grant) => includeEntitlements || grant.targetType !== "entitlement",
    );
  }

  async createPath(input: { name: unknown; sourcePath: unknown; allowWrite?: unknown }) {
    if (input.allowWrite !== undefined && typeof input.allowWrite !== "boolean")
      throw statusError(400, "allowWrite must be a boolean");
    const name = normalizeName(input.name);
    const sourcePath = validateHostMountCatalogSource(
      input.sourcePath,
      this.dataHostPath(),
    );
    const now = new Date().toISOString();
    const item: HostMountPath = {
      schemaVersion: 1,
      id: randomUUID(),
      name,
      sourcePath,
      allowWrite: input.allowWrite === true,
      createdAt: now,
      updatedAt: now,
    };
    await this.mutateCatalog((catalog) => {
      if ([...catalog.values()].some((existing) => existing.sourcePath === sourcePath))
        throw statusError(409, "This host path is already in the approved catalog");
      catalog.set(item.id, item);
    });
    return structuredClone(item);
  }

  async updatePath(
    pathId: string,
    patch: { name?: unknown; allowWrite?: unknown },
  ) {
    if (patch.allowWrite !== undefined && typeof patch.allowWrite !== "boolean")
      throw statusError(400, "allowWrite must be a boolean");
    const current = this.getPath(pathId);
    if (!current) throw statusError(404, "Approved host path not found");
    const updated: HostMountPath = {
      ...current,
      ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
      ...(patch.allowWrite !== undefined
        ? { allowWrite: patch.allowWrite === true }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.mutateCatalog((catalog) => catalog.set(pathId, updated));
    return structuredClone(updated);
  }

  async deletePath(pathId: string): Promise<HostMountRevocation> {
    if (!this.getPath(pathId)) throw statusError(404, "Approved host path not found");
    await this.mutateCatalog((catalog) => catalog.delete(pathId));
    const removed = this.list().filter((grant) => grant.pathId === pathId);
    await this.removeWhere((grant) => grant.pathId === pathId);
    return { pathIds: [pathId], removedGrantIds: removed.map((grant) => grant.id) };
  }

  async setEntitlement(userId: string, pathId: string, enabled: boolean) {
    return this.withUserMutation(userId, async () => {
      if (!this.getPath(pathId))
        throw statusError(404, "Approved host path not found");
      const existing = [...(this.items.get(userId)?.values() ?? [])].find(
        (grant) =>
          grant.pathId === pathId &&
          grant.targetType === "entitlement" &&
          grant.grantorType === "platform",
      );
      if (enabled) {
        if (existing)
          return { grant: structuredClone(existing), revocation: undefined };
        const grant = newGrant({
          userId,
          pathId,
          targetType: "entitlement",
          grantorType: "platform",
        });
        await this.insertGrantUnlocked(userId, grant);
        return { grant: structuredClone(grant), revocation: undefined };
      }
      if (!existing)
        return {
          grant: undefined,
          revocation: { pathIds: [], removedGrantIds: [] },
        };
      const removed = await this.removeGrantTreeUnlocked(
        userId,
        existing.id,
        true,
      );
      return {
        grant: undefined,
        revocation: { pathIds: [pathId], removedGrantIds: removed },
      };
    });
  }

  async createOwnerGrant(
    userId: string,
    input: { pathId: string; targetType: HostMountGrantTarget; targetId?: string },
  ) {
    return this.withUserMutation(userId, async () => {
      this.assertEntitled(userId, input.pathId);
      if (!(["all", "group", "worker"] as string[]).includes(input.targetType))
        throw statusError(400, "Owner grants must target all workers, one group, or one worker");
      this.validateTarget(userId, input.targetType, input.targetId);
      const duplicate = [...(this.items.get(userId)?.values() ?? [])].find(
        (grant) =>
          grant.pathId === input.pathId &&
          grant.targetType === input.targetType &&
          grant.targetId === input.targetId &&
          grant.grantorType === "owner",
      );
      if (duplicate) return structuredClone(duplicate);
      const grant = newGrant({
        userId,
        pathId: input.pathId,
        targetType: input.targetType,
        targetId: input.targetId,
        grantorType: "owner",
      });
      await this.insertGrantUnlocked(userId, grant);
      return structuredClone(grant);
    });
  }

  async createGroupDelegation(
    userId: string,
    authorityGroupId: string,
    input: { pathId: string; targetType: "group" | "worker"; targetId: string },
  ) {
    return this.withUserMutation(userId, async () => {
      if (!(["group", "worker"] as string[]).includes(input.targetType))
        throw statusError(
          400,
          "Group delegations must target a descendant group or an in-subtree worker",
        );
      this.assertEntitled(userId, input.pathId);
      const hierarchy = new WorkerGroupHierarchy(this.groups);
      if (!hierarchy.canAdminister(userId, authorityGroupId, input.targetType === "group"
        ? input.targetId
        : this.directGroupId(userId, input.targetId) || ""))
        throw statusError(403, "Delegation target is outside this administrative group subtree");
      const parent = [...(this.items.get(userId)?.values() ?? [])].find(
        (grant) =>
          grant.pathId === input.pathId &&
          grant.targetType === "group" &&
          grant.targetId === authorityGroupId &&
          this.isGrantActive(userId, grant),
      );
      if (!parent)
        throw statusError(
          403,
          "This host path is not available to the administrative group. Ask the account owner or platform administrator to grant it to this group first.",
        );
      const duplicate = [...(this.items.get(userId)?.values() ?? [])].find(
        (grant) =>
          grant.pathId === input.pathId &&
          grant.targetType === input.targetType &&
          grant.targetId === input.targetId &&
          grant.grantorType === "group" &&
          grant.grantorGroupId === authorityGroupId &&
          grant.parentGrantId === parent.id,
      );
      if (duplicate) return structuredClone(duplicate);
      const grant = newGrant({
        userId,
        pathId: input.pathId,
        targetType: input.targetType,
        targetId: input.targetId,
        grantorType: "group",
        grantorGroupId: authorityGroupId,
        parentGrantId: parent.id,
      });
      await this.insertGrantUnlocked(userId, grant);
      return structuredClone(grant);
    });
  }

  async deleteGrant(userId: string, grantId: string, authorityGroupId?: string) {
    const grant = this.get(userId, grantId);
    if (!grant || grant.targetType === "entitlement")
      throw statusError(404, "Host mount assignment not found");
    if (
      authorityGroupId &&
      (grant.grantorType !== "group" || grant.grantorGroupId !== authorityGroupId)
    )
      throw statusError(403, "Group administrators may revoke only delegations they created");
    const removed = await this.removeGrantTree(userId, grantId, false);
    return { pathIds: [grant.pathId], removedGrantIds: removed };
  }

  /** Resolve untrusted/legacy mount requests to authoritative catalog paths.
   * A legacy exact source can be adopted only after an administrator has added
   * that exact path and the destination worker has an effective grant. */
  resolveMounts(
    userId: string,
    workerId: string,
    mounts: MountConfig[] | undefined,
    directGroupId?: string,
  ): MountConfig[] | undefined {
    if (!mounts?.length) return undefined;
    const resolved: MountConfig[] = [];
    for (const input of mounts) {
      const target = validateHostMountTarget(input?.target);
      const path = input?.pathId
        ? this.getPath(input.pathId)
        : this.listCatalog().find((candidate) => candidate.sourcePath === input?.source);
      if (!path)
        throw statusError(
          403,
          "Host mount is not an approved catalog path. Ask the platform administrator to approve the exact host path, then assign it to this account and worker or group.",
        );
      if (!this.canWorkerUsePath(userId, workerId, path.id, directGroupId))
        throw statusError(
          403,
          `Host path \"${path.name}\" is not assigned to this worker. Ask the account owner to grant it to all workers, this worker, or its direct group.`,
        );
      const readOnly = input.readOnly !== false;
      if (!readOnly && !path.allowWrite)
        throw statusError(
          403,
          `Host path \"${path.name}\" is approved read-only. A platform administrator must explicitly allow writable mounts.`,
        );
      resolved.push({
        pathId: path.id,
        source: path.sourcePath,
        target,
        readOnly,
      });
    }
    return resolved;
  }

  canWorkerUsePath(
    userId: string,
    workerId: string,
    pathId: string,
    directGroupId = this.directGroupId(userId, workerId),
  ) {
    if (!this.getPath(pathId) || !this.isEntitled(userId, pathId)) return false;
    return this.listForUser(userId).some((grant) => {
      if (grant.pathId !== pathId || grant.targetType === "entitlement") return false;
      if (!this.isGrantActive(userId, grant)) return false;
      if (grant.targetType === "all") return true;
      if (grant.targetType === "worker") return grant.targetId === workerId;
      return grant.targetType === "group" && grant.targetId === directGroupId;
    });
  }

  effectivePathsForWorker(userId: string, workerId: string, directGroupId?: string) {
    return this.listEntitledPaths(userId).filter((path) =>
      this.canWorkerUsePath(userId, workerId, path.id, directGroupId),
    );
  }

  /** Only a grant whose target is this exact administrative group can be
   * delegated further. An account-wide grant may make a path usable by the
   * group's workers, but it is not a delegation root. */
  delegablePathsForGroup(userId: string, authorityGroupId: string) {
    return this.listEntitledPaths(userId).filter((path) =>
      this.listForUser(userId).some(
        (grant) =>
          grant.pathId === path.id &&
          grant.targetType === "group" &&
          grant.targetId === authorityGroupId &&
          this.isGrantActive(userId, grant),
      ),
    );
  }

  /** Paths usable before a new, not-yet-grouped worker exists. */
  pathsForNewWorker(userId: string, targetGroupId?: string) {
    const syntheticWorkerId = "__new_worker__";
    return this.listEntitledPaths(userId).filter((path) =>
      this.canWorkerUsePath(userId, syntheticWorkerId, path.id, targetGroupId),
    );
  }

  private isEntitled(userId: string, pathId: string) {
    return this.listForUser(userId).some(
      (grant) =>
        grant.pathId === pathId &&
        grant.targetType === "entitlement" &&
        grant.grantorType === "platform",
    );
  }

  private assertEntitled(userId: string, pathId: string) {
    if (!this.getPath(pathId)) throw statusError(404, "Approved host path not found");
    if (!this.isEntitled(userId, pathId))
      throw statusError(
        403,
        "This host path is not entitled to the account. Ask a platform administrator to grant it first.",
      );
  }

  private isGrantActive(userId: string, grant: HostMountGrant, seen = new Set<string>()): boolean {
    if (seen.has(grant.id) || !this.catalog.has(grant.pathId)) return false;
    seen.add(grant.id);
    if (grant.targetType === "entitlement") return grant.grantorType === "platform";
    if (!this.isEntitled(userId, grant.pathId)) return false;
    if (grant.grantorType === "owner") return true;
    if (
      grant.grantorType !== "group" ||
      !grant.grantorGroupId ||
      !grant.parentGrantId
    ) return false;
    const parent = this.get(userId, grant.parentGrantId);
    if (
      !parent ||
      parent.pathId !== grant.pathId ||
      parent.targetType !== "group" ||
      parent.targetId !== grant.grantorGroupId ||
      !this.isGrantActive(userId, parent, seen)
    ) return false;
    const hierarchy = new WorkerGroupHierarchy(this.groups);
    try {
      if (grant.targetType === "group")
        return !!grant.targetId && hierarchy.canAdminister(userId, grant.grantorGroupId, grant.targetId);
      if (grant.targetType === "worker") {
        const groupId = grant.targetId ? this.directGroupId(userId, grant.targetId) : undefined;
        return !!groupId && hierarchy.canAdminister(userId, grant.grantorGroupId, groupId);
      }
      return false;
    } catch {
      return false;
    }
  }

  private validateTarget(
    userId: string,
    targetType: HostMountGrantTarget,
    targetId?: string,
  ) {
    if (targetType === "all") {
      if (targetId) throw statusError(400, "All-worker assignments do not accept targetId");
      return;
    }
    if (!targetId) throw statusError(400, "targetId is required");
    if (targetType === "group" && !this.groups.get(userId, targetId))
      throw statusError(404, "Worker group not found");
    if (targetType === "worker") {
      const worker = this.workers.get(userId, targetId);
      if (!worker) throw statusError(404, "Worker not found");
    }
  }

  private directGroupId(userId: string, workerId: string) {
    const groups = this.groups
      .listForUser(userId)
      .filter((group) => group.workerIds.includes(workerId));
    return groups.length === 1 ? groups[0]!.id : undefined;
  }

  private async removeGrantTree(userId: string, rootId: string, includeEntitlement: boolean) {
    return this.withUserMutation(userId, () =>
      this.removeGrantTreeUnlocked(userId, rootId, includeEntitlement),
    );
  }

  /** Insert while the caller owns this user's mutation queue. Keeping duplicate
   * detection and persistence in the same critical section makes retries and
   * concurrent GUI/MCP requests converge on one logical grant. */
  private async insertGrantUnlocked(userId: string, grant: HostMountGrant) {
    let map = this.items.get(userId);
    const createdMap = !map;
    if (!map) {
      map = new Map();
      this.items.set(userId, map);
    }
    map.set(grant.id, structuredClone(grant));
    try {
      await this.persistUser(userId);
    } catch (error) {
      map.delete(grant.id);
      if (createdMap && !map.size) this.items.delete(userId);
      throw error;
    }
  }

  /** Remove a grant ancestry tree while the caller owns the user mutation
   * queue. Persistence is the commit point and restores the exact graph on
   * failure. */
  private async removeGrantTreeUnlocked(
    userId: string,
    rootId: string,
    includeEntitlement: boolean,
  ) {
    const map = this.items.get(userId);
    if (!map) return [];
    const root = map.get(rootId);
    if (!root || (!includeEntitlement && root.targetType === "entitlement"))
      return [];
    const removed = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const grant of map.values()) {
        if (
          grant.parentGrantId &&
          removed.has(grant.parentGrantId) &&
          !removed.has(grant.id)
        ) {
          removed.add(grant.id);
          changed = true;
        }
        if (
          includeEntitlement &&
          grant.pathId === root.pathId &&
          !removed.has(grant.id)
        ) {
          removed.add(grant.id);
          changed = true;
        }
      }
    }
    const previous = [...removed].map((id) => [id, map.get(id)!] as const);
    for (const id of removed) map.delete(id);
    if (!map.size) this.items.delete(userId);
    try {
      await this.persistUser(userId);
    } catch (error) {
      let rollback = this.items.get(userId);
      if (!rollback) {
        rollback = new Map();
        this.items.set(userId, rollback);
      }
      for (const [id, grant] of previous) rollback.set(id, grant);
      throw error;
    }
    return [...removed];
  }

  private async loadCatalog() {
    try {
      const raw = JSON.parse(await readFile(this.catalogPath(), "utf8"));
      if (!Array.isArray(raw)) throw new Error("Host mount catalog must be an array");
      const next = new Map<string, HostMountPath>();
      for (const item of raw) {
        validatePersistedPath(item);
        // The protection boundary is recomputed against the installation's
        // current host storage location on every boot. Editing the JSON file or
        // moving DATA_DIR can never bless a path that the GUI/API would reject.
        validateHostMountCatalogSource(item.sourcePath, this.dataHostPath());
        if (next.has(item.id)) throw new Error("Duplicate approved host path id");
        if ([...next.values()].some((existing) => existing.sourcePath === item.sourcePath))
          throw new Error("Duplicate approved host source path");
        next.set(item.id, structuredClone(item));
      }
      this.catalog = next;
      this.catalogUnavailable = false;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      this.catalogUnavailable = true;
      throw error;
    }
  }

  private mutateCatalog(operation: (catalog: Map<string, HostMountPath>) => void) {
    const result = this.catalogWrites.then(async () => {
      this.assertCatalogAvailable();
      const previous = this.catalog;
      const next = new Map(
        [...previous].map(([id, item]) => [id, structuredClone(item)]),
      );
      operation(next);
      this.catalog = next;
      try {
        await this.persistCatalog();
      } catch (error) {
        this.catalog = previous;
        throw error;
      }
    });
    this.catalogWrites = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persistCatalog() {
    const path = this.catalogPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify([...this.catalog.values()], null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  private catalogPath() {
    return join(this.dataDir, PLATFORM_FILE);
  }

  private assertCatalogAvailable() {
    if (this.catalogUnavailable)
      throw statusError(503, "Stored host mount catalog is unavailable");
  }
}

function normalizeName(input: unknown) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.trim().length > 100 ||
    /[\u0000-\u001f\u007f]/.test(input)
  )
    throw statusError(400, "Host path name must contain 1 to 100 characters");
  return input.trim();
}

function newGrant(input: Omit<HostMountGrant, "schemaVersion" | "id" | "createdAt" | "updatedAt">): HostMountGrant {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
  };
}

function validatePersistedPath(input: unknown): asserts input is HostMountPath {
  const item = input as HostMountPath;
  if (
    !item ||
    typeof item !== "object" ||
    item.schemaVersion !== 1 ||
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.sourcePath !== "string" ||
    typeof item.allowWrite !== "boolean" ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string"
  ) throw new Error("Invalid persisted host mount path");
}

function validatePersistedGrant(input: unknown): asserts input is HostMountGrant {
  const grant = input as HostMountGrant;
  if (
    !grant ||
    typeof grant !== "object" ||
    grant.schemaVersion !== 1 ||
    typeof grant.id !== "string" ||
    !grant.id ||
    typeof grant.userId !== "string" ||
    !grant.userId ||
    typeof grant.pathId !== "string" ||
    !grant.pathId ||
    !["entitlement", "all", "group", "worker"].includes(grant.targetType) ||
    !["platform", "owner", "group"].includes(grant.grantorType) ||
    typeof grant.createdAt !== "string" ||
    typeof grant.updatedAt !== "string"
  ) throw new Error("Invalid persisted host mount grant");
  if ((grant.targetType === "group" || grant.targetType === "worker") !== !!grant.targetId)
    throw new Error("Invalid persisted host mount target");
  if (
    grant.grantorType === "platform" &&
    (grant.targetType !== "entitlement" ||
      grant.targetId !== undefined ||
      grant.grantorGroupId !== undefined ||
      grant.parentGrantId !== undefined)
  ) throw new Error("Invalid persisted host mount entitlement");
  if (
    grant.grantorType === "owner" &&
    (grant.targetType === "entitlement" ||
      grant.grantorGroupId !== undefined ||
      grant.parentGrantId !== undefined)
  ) throw new Error("Invalid persisted owner host mount assignment");
  if (
    grant.grantorType === "group" &&
    (!["group", "worker"].includes(grant.targetType) ||
      typeof grant.grantorGroupId !== "string" ||
      !grant.grantorGroupId ||
      typeof grant.parentGrantId !== "string" ||
      !grant.parentGrantId)
  ) throw new Error("Invalid persisted host mount delegation");
}
