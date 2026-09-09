import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  HardwareDevice,
  HardwareDeviceCandidate,
  HardwareDeviceGrant,
  HardwareDeviceGrantTarget,
  ResolvedHardwareDevice,
} from "../../shared/types";
import { UserScopedJsonStore } from "./user-scoped-store";
import type { WorkerGroupStore } from "./worker-group-store";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import type { WorkerStore } from "./worker-store";

const PLATFORM_FILE = "admin/hardware-devices.v1.json";

export interface HardwareDeviceRevocation {
  deviceIds: string[];
  removedGrantIds: string[];
}

function statusError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode, statusMessage: message });
}

function validateCandidate(input: HardwareDeviceCandidate) {
  if (!input || !["gpu", "usb"].includes(input.kind) || !input.selector ||
      !Array.isArray(input.deviceNodes) || !input.deviceNodes.length ||
      input.deviceNodes.some((node) => !node.startsWith("/dev/")) ||
      !Array.isArray(input.groupIds) || input.groupIds.some((gid) => !Number.isInteger(gid) || gid < 0))
    throw statusError(503, "Host hardware discovery returned an invalid device");
  return input;
}

/** Persistent platform device catalog plus owner-partitioned entitlements and assignments. */
export class HardwareDeviceStore extends UserScopedJsonStore<string, HardwareDeviceGrant> {
  private catalog = new Map<string, HardwareDevice>();
  private catalogWrites = Promise.resolve();
  private catalogUnavailable = false;

  constructor(
    dataDir: string,
    private readonly discoverHardware: () => Promise<HardwareDeviceCandidate[]>,
    private readonly groups: WorkerGroupStore,
    private readonly workers: WorkerStore,
  ) {
    super(dataDir, "hardware-device-grants.json", (grant) => {
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

  getDevice(deviceId: string) {
    this.assertCatalogAvailable();
    const item = this.catalog.get(deviceId);
    return item ? structuredClone(item) : undefined;
  }

  listEntitledDevices(userId: string) {
    const entitled = new Set(
      this.listForUser(userId)
        .filter(
          (grant) =>
            grant.targetType === "entitlement" &&
            grant.grantorType === "platform",
        )
        .map((grant) => grant.deviceId),
    );
    return this.listCatalog().filter((path) => entitled.has(path.id));
  }

  listGrants(userId: string, includeEntitlements = false) {
    return this.listForUser(userId).filter(
      (grant) => includeEntitlements || grant.targetType !== "entitlement",
    );
  }

  async listDiscoveredDevices() {
    const candidates = await this.discoverHardware();
    return candidates.map((candidate) => structuredClone(validateCandidate(candidate)));
  }

  async approveDevice(input: { selector: unknown; name?: unknown }) {
    if (typeof input.selector !== "string" || !input.selector)
      throw statusError(400, "A discovered hardware selector is required");
    const candidate = (await this.listDiscoveredDevices()).find(
      (item) => item.selector === input.selector,
    );
    if (!candidate)
      throw statusError(404, "The selected hardware device is no longer available");
    const now = new Date().toISOString();
    const item: HardwareDevice = {
      schemaVersion: 1,
      id: randomUUID(),
      name: input.name === undefined ? candidate.name : normalizeName(input.name),
      kind: candidate.kind,
      selector: candidate.selector,
      vendor: candidate.vendor,
      product: candidate.product,
      serial: candidate.serial,
      createdAt: now,
      updatedAt: now,
    };
    await this.mutateCatalog((catalog) => {
      if ([...catalog.values()].some((existing) => existing.selector === item.selector))
        throw statusError(409, "This hardware device is already approved");
      catalog.set(item.id, item);
    });
    return structuredClone(item);
  }

  async updateDevice(deviceId: string, patch: { name?: unknown }) {
    const current = this.getDevice(deviceId);
    if (!current) throw statusError(404, "Approved hardware device not found");
    const updated: HardwareDevice = {
      ...current,
      ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.mutateCatalog((catalog) => catalog.set(deviceId, updated));
    return structuredClone(updated);
  }

  async deleteDevice(deviceId: string): Promise<HardwareDeviceRevocation> {
    if (!this.getDevice(deviceId)) throw statusError(404, "Approved hardware device not found");
    await this.mutateCatalog((catalog) => catalog.delete(deviceId));
    const removed = this.list().filter((grant) => grant.deviceId === deviceId);
    await this.removeWhere((grant) => grant.deviceId === deviceId);
    return { deviceIds: [deviceId], removedGrantIds: removed.map((grant) => grant.id) };
  }

  async setEntitlement(userId: string, deviceId: string, enabled: boolean) {
    return this.withUserMutation(userId, async () => {
      if (!this.getDevice(deviceId))
        throw statusError(404, "Approved hardware device not found");
      const existing = [...(this.items.get(userId)?.values() ?? [])].find(
        (grant) =>
          grant.deviceId === deviceId &&
          grant.targetType === "entitlement" &&
          grant.grantorType === "platform",
      );
      if (enabled) {
        if (existing)
          return { grant: structuredClone(existing), revocation: undefined };
        const grant = newGrant({
          userId,
          deviceId,
          targetType: "entitlement",
          grantorType: "platform",
        });
        await this.insertGrantUnlocked(userId, grant);
        return { grant: structuredClone(grant), revocation: undefined };
      }
      if (!existing)
        return {
          grant: undefined,
          revocation: { deviceIds: [], removedGrantIds: [] },
        };
      const removed = await this.removeGrantTreeUnlocked(
        userId,
        existing.id,
        true,
      );
      return {
        grant: undefined,
        revocation: { deviceIds: [deviceId], removedGrantIds: removed },
      };
    });
  }

  async createOwnerGrant(
    userId: string,
    input: { deviceId: string; targetType: HardwareDeviceGrantTarget; targetId?: string },
  ) {
    return this.withUserMutation(userId, async () => {
      this.assertEntitled(userId, input.deviceId);
      if (!(["all", "group", "worker"] as string[]).includes(input.targetType))
        throw statusError(400, "Owner grants must target all workers, one group, or one worker");
      this.validateTarget(userId, input.targetType, input.targetId);
      const duplicate = [...(this.items.get(userId)?.values() ?? [])].find(
        (grant) =>
          grant.deviceId === input.deviceId &&
          grant.targetType === input.targetType &&
          grant.targetId === input.targetId &&
          grant.grantorType === "owner",
      );
      if (duplicate) return structuredClone(duplicate);
      const grant = newGrant({
        userId,
        deviceId: input.deviceId,
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
    input: { deviceId: string; targetType: "group" | "worker"; targetId: string },
  ) {
    return this.withUserMutation(userId, async () => {
      if (!(["group", "worker"] as string[]).includes(input.targetType))
        throw statusError(
          400,
          "Group delegations must target a descendant group or an in-subtree worker",
        );
      this.assertEntitled(userId, input.deviceId);
      const hierarchy = new WorkerGroupHierarchy(this.groups);
      if (!hierarchy.canAdminister(userId, authorityGroupId, input.targetType === "group"
        ? input.targetId
        : this.directGroupId(userId, input.targetId) || ""))
        throw statusError(403, "Delegation target is outside this administrative group subtree");
      const parent = [...(this.items.get(userId)?.values() ?? [])].find(
        (grant) =>
          grant.deviceId === input.deviceId &&
          grant.targetType === "group" &&
          grant.targetId === authorityGroupId &&
          this.isGrantActive(userId, grant),
      );
      if (!parent)
        throw statusError(
          403,
          "This hardware device is not available to the administrative group. Ask the account owner or platform administrator to grant it to this group first.",
        );
      const duplicate = [...(this.items.get(userId)?.values() ?? [])].find(
        (grant) =>
          grant.deviceId === input.deviceId &&
          grant.targetType === input.targetType &&
          grant.targetId === input.targetId &&
          grant.grantorType === "group" &&
          grant.grantorGroupId === authorityGroupId &&
          grant.parentGrantId === parent.id,
      );
      if (duplicate) return structuredClone(duplicate);
      const grant = newGrant({
        userId,
        deviceId: input.deviceId,
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
      throw statusError(404, "Hardware device assignment not found");
    if (
      authorityGroupId &&
      (grant.grantorType !== "group" || grant.grantorGroupId !== authorityGroupId)
    )
      throw statusError(403, "Group administrators may revoke only delegations they created");
    const removed = await this.removeGrantTree(userId, grantId, false);
    return { deviceIds: [grant.deviceId], removedGrantIds: removed };
  }

  authorizeDeviceIds(
    userId: string,
    workerId: string,
    deviceIds: string[] | undefined,
    directGroupId?: string,
  ): string[] | undefined {
    if (!deviceIds?.length) return undefined;
    const unique = [...new Set(deviceIds)];
    if (unique.some((id) => typeof id !== "string" || !id))
      throw statusError(400, "hardwareDeviceIds must contain non-empty device IDs");
    for (const deviceId of unique) {
      const device = this.getDevice(deviceId);
      if (!device)
        throw statusError(403, "Hardware device is not in the approved catalog");
      if (!this.canWorkerUseDevice(userId, workerId, deviceId, directGroupId))
        throw statusError(403, `Hardware device \"${device.name}\" is not assigned to this worker`);
    }
    return unique.sort();
  }

  async resolveAuthorizedDevices(
    userId: string,
    workerId: string,
    deviceIds: string[] | undefined,
    directGroupId?: string,
  ): Promise<ResolvedHardwareDevice[] | undefined> {
    const authorized = this.authorizeDeviceIds(userId, workerId, deviceIds, directGroupId);
    if (!authorized?.length) return undefined;
    const candidates = await this.listDiscoveredDevices();
    return authorized.map((deviceId) => {
      const device = this.getDevice(deviceId)!;
      const candidate = candidates.find((item) => item.selector === device.selector);
      if (!candidate)
        throw statusError(409, `Hardware device \"${device.name}\" is unavailable. Reconnect it, then rebuild the worker.`);
      return {
        deviceId,
        deviceNodes: [...candidate.deviceNodes],
        groupIds: [...candidate.groupIds],
      };
    });
  }

  canWorkerUseDevice(
    userId: string,
    workerId: string,
    deviceId: string,
    directGroupId = this.directGroupId(userId, workerId),
  ) {
    if (!this.getDevice(deviceId) || !this.isEntitled(userId, deviceId)) return false;
    return this.listForUser(userId).some((grant) => {
      if (grant.deviceId !== deviceId || grant.targetType === "entitlement") return false;
      if (!this.isGrantActive(userId, grant)) return false;
      if (grant.targetType === "all") return true;
      if (grant.targetType === "worker") return grant.targetId === workerId;
      return grant.targetType === "group" && grant.targetId === directGroupId;
    });
  }

  effectiveDevicesForWorker(userId: string, workerId: string, directGroupId?: string) {
    return this.listEntitledDevices(userId).filter((path) =>
      this.canWorkerUseDevice(userId, workerId, path.id, directGroupId),
    );
  }

  /** Only a grant whose target is this exact administrative group can be
   * delegated further. An account-wide grant may make a device usable by the
   * group's workers, but it is not a delegation root. */
  delegableDevicesForGroup(userId: string, authorityGroupId: string) {
    return this.listEntitledDevices(userId).filter((path) =>
      this.listForUser(userId).some(
        (grant) =>
          grant.deviceId === path.id &&
          grant.targetType === "group" &&
          grant.targetId === authorityGroupId &&
          this.isGrantActive(userId, grant),
      ),
    );
  }

  /** Devices usable before a new, not-yet-grouped worker exists. */
  devicesForNewWorker(userId: string, targetGroupId?: string) {
    const syntheticWorkerId = "__new_worker__";
    return this.listEntitledDevices(userId).filter((path) =>
      this.canWorkerUseDevice(userId, syntheticWorkerId, path.id, targetGroupId),
    );
  }

  private isEntitled(userId: string, deviceId: string) {
    return this.listForUser(userId).some(
      (grant) =>
        grant.deviceId === deviceId &&
        grant.targetType === "entitlement" &&
        grant.grantorType === "platform",
    );
  }

  private assertEntitled(userId: string, deviceId: string) {
    if (!this.getDevice(deviceId)) throw statusError(404, "Approved hardware device not found");
    if (!this.isEntitled(userId, deviceId))
      throw statusError(
        403,
        "This hardware device is not entitled to the account. Ask a platform administrator to grant it first.",
      );
  }

  private isGrantActive(userId: string, grant: HardwareDeviceGrant, seen = new Set<string>()): boolean {
    if (seen.has(grant.id) || !this.catalog.has(grant.deviceId)) return false;
    seen.add(grant.id);
    if (grant.targetType === "entitlement") return grant.grantorType === "platform";
    if (!this.isEntitled(userId, grant.deviceId)) return false;
    if (grant.grantorType === "owner") return true;
    if (
      grant.grantorType !== "group" ||
      !grant.grantorGroupId ||
      !grant.parentGrantId
    ) return false;
    const parent = this.get(userId, grant.parentGrantId);
    if (
      !parent ||
      parent.deviceId !== grant.deviceId ||
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
    targetType: HardwareDeviceGrantTarget,
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
  private async insertGrantUnlocked(userId: string, grant: HardwareDeviceGrant) {
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
          grant.deviceId === root.deviceId &&
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
      if (!Array.isArray(raw)) throw new Error("Hardware device catalog must be an array");
      const next = new Map<string, HardwareDevice>();
      for (const item of raw) {
        validatePersistedDevice(item);
        if (next.has(item.id)) throw new Error("Duplicate approved hardware device id");
        if ([...next.values()].some((existing) => existing.selector === item.selector))
          throw new Error("Duplicate approved hardware selector");
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

  private mutateCatalog(operation: (catalog: Map<string, HardwareDevice>) => void) {
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
      throw statusError(503, "Stored hardware device catalog is unavailable");
  }
}

function normalizeName(input: unknown) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.trim().length > 100 ||
    /[\u0000-\u001f\u007f]/.test(input)
  )
    throw statusError(400, "Hardware device name must contain 1 to 100 characters");
  return input.trim();
}

function newGrant(input: Omit<HardwareDeviceGrant, "schemaVersion" | "id" | "createdAt" | "updatedAt">): HardwareDeviceGrant {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
  };
}

function validatePersistedDevice(input: unknown): asserts input is HardwareDevice {
  const item = input as HardwareDevice;
  if (!item || typeof item !== "object" || item.schemaVersion !== 1 ||
      typeof item.id !== "string" || !item.id || typeof item.name !== "string" ||
      !["gpu", "usb"].includes(item.kind) || typeof item.selector !== "string" || !item.selector ||
      (item.vendor !== undefined && typeof item.vendor !== "string") ||
      (item.product !== undefined && typeof item.product !== "string") ||
      (item.serial !== undefined && typeof item.serial !== "string") ||
      typeof item.createdAt !== "string" || typeof item.updatedAt !== "string")
    throw new Error("Invalid persisted hardware device");
}

function validatePersistedGrant(input: unknown): asserts input is HardwareDeviceGrant {
  const grant = input as HardwareDeviceGrant;
  if (
    !grant ||
    typeof grant !== "object" ||
    grant.schemaVersion !== 1 ||
    typeof grant.id !== "string" ||
    !grant.id ||
    typeof grant.userId !== "string" ||
    !grant.userId ||
    typeof grant.deviceId !== "string" ||
    !grant.deviceId ||
    !["entitlement", "all", "group", "worker"].includes(grant.targetType) ||
    !["platform", "owner", "group"].includes(grant.grantorType) ||
    typeof grant.createdAt !== "string" ||
    typeof grant.updatedAt !== "string"
  ) throw new Error("Invalid persisted hardware device grant");
  if ((grant.targetType === "group" || grant.targetType === "worker") !== !!grant.targetId)
    throw new Error("Invalid persisted hardware device target");
  if (
    grant.grantorType === "platform" &&
    (grant.targetType !== "entitlement" ||
      grant.targetId !== undefined ||
      grant.grantorGroupId !== undefined ||
      grant.parentGrantId !== undefined)
  ) throw new Error("Invalid persisted hardware device entitlement");
  if (
    grant.grantorType === "owner" &&
    (grant.targetType === "entitlement" ||
      grant.grantorGroupId !== undefined ||
      grant.parentGrantId !== undefined)
  ) throw new Error("Invalid persisted owner hardware device assignment");
  if (
    grant.grantorType === "group" &&
    (!["group", "worker"].includes(grant.targetType) ||
      typeof grant.grantorGroupId !== "string" ||
      !grant.grantorGroupId ||
      typeof grant.parentGrantId !== "string" ||
      !grant.parentGrantId)
  ) throw new Error("Invalid persisted hardware device delegation");
}
