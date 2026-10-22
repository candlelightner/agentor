import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
const catalogWrites = new Map<string, Promise<void>>();

export function isPhysicalGpuDevice(device: Pick<HardwareDevice, 'kind' | 'selector'> | undefined): boolean {
  return device?.kind === 'gpu' && device.selector.startsWith('pci-gpu:');
}

export function gpuAssignments(device: Pick<HardwareDevice, 'physicalAssignment' | 'mdevAssignments'> | undefined) {
  return [...(device?.physicalAssignment ? [device.physicalAssignment] : []), ...(device?.mdevAssignments ?? [])];
}
export function gpuAssignmentFor(device: HardwareDevice | undefined, userId: string, workerId: string) {
  return gpuAssignments(device).find(binding => binding.userId === userId && binding.workerId === workerId);
}

export async function physicalGpuIdentityReceipts(dataDir: string | undefined) {
  if (!dataDir) return [];
  let catalog: HardwareDevice[];
  try { catalog = JSON.parse(await readFile(join(dataDir, PLATFORM_FILE), 'utf8')); }
  catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(catalog)) throw new Error('Invalid hardware identity catalog');
  for (const item of catalog) validatePersistedDevice(item);
  const receipts = catalog.filter(item => item.physicalIdentity).map(({ selector, physicalIdentity }) => ({ selector, physicalIdentity }));
  if (JSON.stringify(receipts).length > 65536) throw new Error('Hardware identity evidence exceeds probe input bound');
  return receipts;
}

function validPhysicalIdentity(identity: HardwareDevice['physicalIdentity']) {
  return !!identity && typeof identity.bootId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(identity.bootId) &&
    typeof identity.deviceInode === 'string' && /^[1-9][0-9]{0,19}$/.test(identity.deviceInode) &&
    (identity.deviceNodes === undefined || Array.isArray(identity.deviceNodes) && identity.deviceNodes.length <= 128 &&
      identity.deviceNodes.every(node => typeof node === 'string' && /^\/dev\/(?:dri\/(?:card|renderD)|nvidia)[0-9]+$/.test(node)));
}

export interface HardwareDeviceRevocation {
  deviceIds: string[];
  removedGrantIds: string[];
}

function statusError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode, statusMessage: message });
}

function validateCandidate(input: HardwareDeviceCandidate) {
  if (!input || !["gpu", "usb"].includes(input.kind) || !input.selector ||
      !Array.isArray(input.deviceNodes) || (!input.deviceNodes.length &&
        !(input.kind === 'gpu' && input.selector.startsWith('pci-gpu:'))) ||
      input.deviceNodes.some((node) => !node.startsWith("/dev/")) ||
      !Array.isArray(input.groupIds) || input.groupIds.some((gid) => !Number.isInteger(gid) || gid < 0) ||
      (input.physicalIdentity !== undefined && !validPhysicalIdentity(input.physicalIdentity)))
    throw statusError(503, "Host hardware discovery returned an invalid device");
  return input;
}

/** Old shell discovery converted each sysfs newline to one trailing space. */
export function hardwareDeviceSelector(device: Pick<HardwareDevice, 'kind' | 'selector' | 'vendor' | 'product' | 'serial'>): string {
  if (device.kind !== 'usb' || !/^[0-9a-f]{4} $/.test(device.vendor ?? '') ||
      !/^[0-9a-f]{4} $/.test(device.product ?? '')) return device.selector;
  const identity = device.serial || device.selector.split(':').slice(3).join(':');
  if (device.selector !== `usb:${device.vendor}:${device.product}:${identity}`) return device.selector;
  if (device.serial && !/^[\x20-\x7e]{1,128} $/.test(device.serial)) return device.selector;
  if (!device.serial && !/^port:[0-9]+-[0-9]+(?:\.[0-9]+)*$/.test(identity)) return device.selector;
  return `usb:${device.vendor!.slice(0, -1)}:${device.product!.slice(0, -1)}:${device.serial ? identity.slice(0, -1) : identity}`;
}

/** Persistent platform device catalog plus owner-partitioned entitlements and assignments. */
export class HardwareDeviceStore extends UserScopedJsonStore<string, HardwareDeviceGrant> {
  private catalog = new Map<string, HardwareDevice>();
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

  /** Only the authenticated platform assignment domain calls this method.
   * A single catalog write makes cross-account authority indivisible. Native
   * release must be confirmed before clearing a binding or selecting a peer. */
  async setPhysicalGpuAssignment(deviceId: string, target?: HardwareDevice['physicalAssignment'],
    expected?: HardwareDevice['physicalAssignment'], profile?: string) {
    const previous = target && gpuAssignmentFor(this.getDevice(deviceId), target.userId, target.workerId);
    const inventory = target && profile && (!previous || !('profile' in previous) || previous.profile !== profile) ? await this.listDiscoveredDevices() : [];
    let updated!: HardwareDevice;
    await this.mutateCatalog(catalog => {
      const current = catalog.get(deviceId);
      if (!isPhysicalGpuDevice(current)) throw statusError(400, 'Select an approved PCI GPU');
      const owner = target ?? expected;
      const existing = owner && gpuAssignmentFor(current, owner.userId, owner.workerId);
      if (!target && gpuAssignments(current).length && (!existing ||
          expected?.incarnation !== undefined && existing.incarnation !== expected.incarnation))
        throw statusError(409, 'GPU release authority changed; preserve the current assignment');
      if (target) {
        const worker = this.workers.get(target.userId, target.workerId);
        if (!worker || worker.runtimeKind !== 'incus-vm' || worker.status !== 'active' || worker.deletionPending)
          throw statusError(409, 'GPU assignment requires an existing ordinary Incus worker');
        if ([...catalog.values()].some(device => device.id !== deviceId && gpuAssignmentFor(device, target.userId, target.workerId)))
          throw statusError(409, 'This VM already has a GPU assignment');
        const others = gpuAssignments(current).filter(binding => binding !== existing);
        if (!profile && others.length || profile && current!.physicalAssignment && current!.physicalAssignment !== existing)
          throw statusError(409, 'Release the existing physical GPU assignment before selecting another VM');
        if (profile && (!existing || !('profile' in existing) || existing.profile !== profile)) {
          const evidence = inventory.find(item => item.selector === current!.selector)?.incus?.evidence;
          if (!evidence?.mediatedProfiles?.includes(profile)) throw statusError(409, 'Unsupported mediated GPU profile');
          // shortcut: use homogeneous profiles until a driver exposes explicit mixed-profile compatibility.
          if (others.some(binding => !('profile' in binding) || binding.profile !== profile))
            throw statusError(409, 'GPU requires compatible homogeneous profiles; release other allocations first');
          const total = evidence.mediatedProfileInfo?.[profile]?.total ?? ((evidence.mediatedAvailable?.[profile] ?? 0) + (evidence.mediatedInstances?.[profile]?.length ?? 0));
          if (total !== undefined && others.length >= total)
            throw statusError(409, 'Selected mediated GPU profile has no available capacity');
        }
      }
      const mdevAssignments = (current!.mdevAssignments ?? []).filter(binding => binding !== existing);
      if (target && profile) mdevAssignments.push({ ...target, profile });
      updated = { ...current!,
        physicalAssignment: target && !profile ? { ...target } : current!.physicalAssignment === existing ? undefined : current!.physicalAssignment,
        mdevAssignments: mdevAssignments.length ? mdevAssignments : undefined, updatedAt: new Date().toISOString() };
      validatePersistedDevice(updated); catalog.set(deviceId, updated);
    });
    return structuredClone(updated);
  }

  assertPhysicalGpuSelection(userId: string, workerId: string, deviceIds: string[] | undefined) {
    const selected = [...new Set(deviceIds ?? [])].filter(id => isPhysicalGpuDevice(this.getDevice(id))).sort();
    const assigned = this.listCatalog().filter(device => isPhysicalGpuDevice(device) &&
      !!gpuAssignmentFor(device, userId, workerId)).map(device => device.id).sort();
    if (JSON.stringify(selected) !== JSON.stringify(assigned))
      throw statusError(403, 'Only a platform administrator may change a physical GPU assignment');
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
    return this.listCatalog().filter((path) => entitled.has(path.id) || gpuAssignments(path).some(binding => binding.userId === userId));
  }

  listGrants(userId: string, includeEntitlements = false) {
    return this.listForUser(userId).filter(
      (grant) => includeEntitlements || grant.targetType !== "entitlement",
    );
  }

  async listDiscoveredDevices() {
    const candidates = await this.discoverHardware();
    const validated = candidates.map((candidate) => structuredClone(validateCandidate(candidate)));
    const refreshed = validated.filter(candidate => candidate.physicalIdentity &&
      validated.filter(other => other.selector === candidate.selector).length === 1 &&
      [...this.catalog.values()].some(item => item.selector === candidate.selector &&
        JSON.stringify(item.physicalIdentity) !== JSON.stringify(candidate.physicalIdentity)));
    if (refreshed.length) await this.mutateCatalog(catalog => {
      for (const candidate of refreshed) for (const [id, item] of catalog)
        if (item.selector === candidate.selector) catalog.set(id, { ...item, physicalIdentity: candidate.physicalIdentity });
    });
    return validated;
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
      ...(candidate.physicalIdentity ? { physicalIdentity: candidate.physicalIdentity } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.mutateCatalog((catalog) => {
      if ([...catalog.values()].some((existing) => hardwareDeviceSelector(existing) === hardwareDeviceSelector(item)))
        throw statusError(409, "This hardware device is already approved");
      catalog.set(item.id, item);
    });
    return structuredClone(item);
  }

  async updateDevice(deviceId: string, patch: { name?: unknown }) {
    let updated!: HardwareDevice;
    await this.mutateCatalog((catalog) => {
      const current = catalog.get(deviceId);
      if (!current) throw statusError(404, "Approved hardware device not found");
      updated = { ...current, ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}), updatedAt: new Date().toISOString() };
      catalog.set(deviceId, updated);
    });
    return structuredClone(updated);
  }

  async deleteDevice(deviceId: string): Promise<HardwareDeviceRevocation> {
    if (!this.getDevice(deviceId)) throw statusError(404, "Approved hardware device not found");
    await this.mutateCatalog((catalog) => {
      if (gpuAssignments(catalog.get(deviceId)).length)
        throw statusError(409, 'Release the physical GPU assignment before deleting its catalog entry');
      catalog.delete(deviceId);
    });
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
      this.assertNotPhysicalGpu(input.deviceId);
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
      this.assertNotPhysicalGpu(input.deviceId);
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
    this.assertNotPhysicalGpu(grant.deviceId);
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
    this.assertPhysicalGpuSelection(userId, workerId, deviceIds);
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
    this.authorizeDeviceIds(userId, workerId, authorized, directGroupId);
    return authorized.map((deviceId) => {
      const device = this.getDevice(deviceId)!;
      const selector = hardwareDeviceSelector(device);
      const matches = candidates.filter((item) => item.selector === selector);
      if (matches.length > 1) throw statusError(409, `Hardware device "${device.name}" has an ambiguous identity`);
      const candidate = matches[0];
      if (!candidate)
        throw statusError(409, `Hardware device \"${device.name}\" is unavailable. Reconnect it, then rebuild the worker.`);
      return {
        deviceId,
        mdevProfile: (gpuAssignmentFor(device, userId, workerId) as { profile?: string } | undefined)?.profile,
        candidate: structuredClone(candidate),
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
    const device = this.getDevice(deviceId);
    if (!device) return false;
    if (isPhysicalGpuDevice(device)) return !!gpuAssignmentFor(device, userId, workerId);
    if (!this.isEntitled(userId, deviceId)) return false;
    return this.listForUser(userId).some((grant) => {
      if (grant.deviceId !== deviceId || grant.targetType === "entitlement") return false;
      if (!this.isGrantActive(userId, grant)) return false;
      if (grant.targetType === "all") return true;
      if (grant.targetType === "worker") return grant.targetId === workerId;
      return grant.targetType === "group" && grant.targetId === directGroupId;
    });
  }

  effectiveDevicesForWorker(userId: string, workerId: string, directGroupId?: string) {
    return this.listCatalog().filter((path) =>
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
      !isPhysicalGpuDevice(path) && this.canWorkerUseDevice(userId, syntheticWorkerId, path.id, targetGroupId),
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

  private assertNotPhysicalGpu(deviceId: string) {
    if (isPhysicalGpuDevice(this.getDevice(deviceId)))
      throw statusError(403, 'Physical GPUs require a platform-admin assignment to one explicit VM');
  }

  private isGrantActive(userId: string, grant: HardwareDeviceGrant, seen = new Set<string>()): boolean {
    if (seen.has(grant.id) || !this.catalog.has(grant.deviceId)) return false;
    seen.add(grant.id);
    if (grant.targetType === "entitlement") return grant.grantorType === "platform";
    if (isPhysicalGpuDevice(this.getDevice(grant.deviceId))) return false;
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
        if ([...next.values()].some((existing) => hardwareDeviceSelector(existing) === hardwareDeviceSelector(item)))
          throw new Error("Duplicate approved hardware selector");
        next.set(item.id, structuredClone(item));
      }
      this.catalog = next;
      this.catalogUnavailable = false;
    } catch (error: any) {
      if (error?.code === "ENOENT") { this.catalog = new Map(); this.catalogUnavailable = false; return; }
      this.catalogUnavailable = true;
      throw error;
    }
  }

  private mutateCatalog(operation: (catalog: Map<string, HardwareDevice>) => void) {
    const path = resolve(this.catalogPath());
    const result = (catalogWrites.get(path) ?? Promise.resolve()).then(async () => {
      this.assertCatalogAvailable();
      await this.loadCatalog();
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
    const settled = result.then(() => undefined, () => undefined);
    catalogWrites.set(path, settled);
    void settled.then(() => { if (catalogWrites.get(path) === settled) catalogWrites.delete(path); });
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
      (item.physicalIdentity !== undefined && !validPhysicalIdentity(item.physicalIdentity)) ||
      (item.physicalAssignment !== undefined && (!isPhysicalGpuDevice(item) || !item.physicalAssignment ||
        typeof item.physicalAssignment.userId !== 'string' || !item.physicalAssignment.userId ||
        typeof item.physicalAssignment.workerId !== 'string' || !item.physicalAssignment.workerId ||
        item.physicalAssignment.incarnation !== undefined && (typeof item.physicalAssignment.incarnation !== 'string' ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(item.physicalAssignment.incarnation)) ||
        Object.keys(item.physicalAssignment).some(key => !['userId', 'workerId', 'incarnation'].includes(key)))) ||
      (item.mdevAssignments !== undefined && (!isPhysicalGpuDevice(item) || !Array.isArray(item.mdevAssignments) ||
        item.mdevAssignments.some(binding => !binding || typeof binding.userId !== 'string' || !binding.userId ||
          typeof binding.workerId !== 'string' || !binding.workerId || typeof binding.profile !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(binding.profile) ||
          binding.incarnation !== undefined && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(binding.incarnation) ||
          Object.keys(binding).some(key => !['userId', 'workerId', 'incarnation', 'profile'].includes(key))) ||
        new Set(item.mdevAssignments.map(binding => binding.workerId)).size !== item.mdevAssignments.length ||
        !!item.physicalAssignment && item.mdevAssignments.length > 0)) ||
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
