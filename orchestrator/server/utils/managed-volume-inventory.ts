import { createHash } from "node:crypto";
import type { VolumeInventoryItem } from "../../shared/managed-volumes";
import { useManagedVolumeManager } from "./managed-volume-manager";
import { useContainerManager, useStorageManager, useWorkerGroupStore, useWorkerStore } from "./services";
import { useAdminWorkspaceStore } from "./admin-workspace-store";
import { administrativeWorkspaceResourceNames } from "./admin-workspace-runtime";
import { useBackupManager } from "./backup-manager";
import { withOperationDeadline } from "./operation-deadline";
import { VOLUME_LABEL } from "./managed-volume-runtime";

export interface ManagedVolumeSizingResource {
  /** Opaque public inventory id. Docker names never leave this server type. */
  id: string;
  dockerName: string;
  userId?: string;
  workerId?: string;
  purpose: string;
  ownerKey: string;
  classification: "managed" | "builtin" | "orphan";
  incarnation?: string;
  live: boolean;
}

export interface ManagedVolumeControlTarget {
  id: string;
  userId?: string;
  workerId?: string;
  ownerKey: string;
  classification: "managed" | "builtin" | "orphan";
  platformOnly: boolean;
  retainedAfterAccountDeletion?: boolean;
}

type VolumeDiscovery = {
  available: boolean;
  volumes: Map<string, any>;
  referenced: Set<string>;
  liveReferenced: Set<string>;
  resources: Map<string, ManagedVolumeSizingResource>;
};

const opaqueVolumeId = (prefix: string, name: string) =>
  `${prefix}-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;


/** Resolve only current durable control-plane ownership. The caller must
 * initialize the managed-volume manager first. This deliberately performs no
 * Docker discovery and does not assert that physical volume data still exists. */
export function resolveManagedVolumeControlTarget(id: string): ManagedVolumeControlTarget | undefined {
  const managed = useManagedVolumeManager().store.list().find((volume) => volume.id === id);
  if (managed) return {
    id: managed.id,
    userId: managed.userId,
    workerId: managed.workerId,
    ownerKey: managed.retainedAfterAccountDeletion ? "platform" : managed.userId,
    classification: "managed",
    platformOnly: Boolean(managed.retainedAfterAccountDeletion),
    ...(managed.retainedAfterAccountDeletion ? { retainedAfterAccountDeletion: true } : {}),
  };

  const builtin = (name: string, userId?: string, workerId?: string): ManagedVolumeControlTarget | undefined => {
    const targetId = opaqueVolumeId("builtin", name);
    return targetId === id ? {
      id: targetId,
      userId,
      workerId,
      ownerKey: userId ?? "platform",
      classification: "builtin",
      platformOnly: !userId,
    } : undefined;
  };
  for (const worker of useWorkerStore().list()) {
    const name = useContainerManager().buildContainerName(worker.id);
    const candidates = [
      ...(useStorageManager().mode === "volume" ? [`${name}-workspace`, `${name}-agents`] : []),
      `${name}-docker`,
    ];
    for (const candidate of candidates) {
      const found = builtin(candidate, worker.userId, worker.id);
      if (found) return found;
    }
  }
  const admin = useAdminWorkspaceStore().getRecord();
  if (admin) {
    const names = administrativeWorkspaceResourceNames(admin);
    const found = builtin(names.workspaceVolume) ?? builtin(names.agentsVolume);
    if (found) return found;
  }
  for (const group of useWorkerGroupStore().list()) {
    if (!group.adminWorkspace) continue;
    const names = administrativeWorkspaceResourceNames(group.adminWorkspace as any);
    const found = builtin(names.workspaceVolume, group.userId, group.adminWorkspace.id) ??
      builtin(names.agentsVolume, group.userId, group.adminWorkspace.id);
    if (found) return found;
  }
  return builtin("agentor-traefik-certs");

}
export function managedVolumeIsLive(
  dockerName: string,
  liveContainerId: string | undefined,
  liveReferenced: Set<string>,
  runningContainerIds: Set<string>,
) {
  return liveReferenced.has(dockerName) || Boolean(liveContainerId && runningContainerIds.has(liveContainerId));
}
function volumeIncarnation(volume: any, identity: Record<string, string>, allowLabelIdentity = false) {
  if (!volume || volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length) return undefined;
  const createdAt = typeof volume.CreatedAt === "string" && volume.CreatedAt ? volume.CreatedAt : undefined;
  // Derived legacy names alone are reusable after delete/recreate. Require
  // Docker's creation marker unless an immutable Agentor id label is also
  // verified against a durable record.
  if (!createdAt && !allowLabelIdentity) return undefined;
  return createHash("sha256").update(JSON.stringify({
    name: volume.Name,
    driver: volume.Driver,
    createdAt: createdAt ?? null,
    identity: Object.entries(identity).sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
}

async function discoverSizingResources(): Promise<VolumeDiscovery> {
  const manager = useManagedVolumeManager(); await manager.init();
  let available = true;
  const raw = await withOperationDeadline(manager.runtime.docker.listVolumes(), 8000, "Agentor volume inventory").catch(() => { available = false; return { Volumes: [] }; });
  const volumes = new Map<string, any>((raw.Volumes ?? []).map((v: any) => [v.Name, v]));
  const containers = await withOperationDeadline(manager.runtime.docker.listContainers({ all: true }), 8000, "Volume attachment inventory").catch(() => { available = false; return [] as any[]; });
  const referenced = new Set<string>(containers.flatMap((c: any) => (c.Mounts ?? []).map((m: any) => m.Name).filter(Boolean)));
  const liveReferenced = new Set<string>(containers.filter((c: any) => c.State === "running").flatMap((c: any) => (c.Mounts ?? []).map((m: any) => m.Name).filter(Boolean)));
  const runningContainerIds = new Set<string>(containers.filter((c: any) => c.State === "running").map((c: any) => c.Id));
  const resources = new Map<string, ManagedVolumeSizingResource>();
  const known = new Set<string>();
  const add = (resource: Omit<ManagedVolumeSizingResource, "incarnation" | "live">, identity: Record<string, string>, allowLabelIdentity = false) => {
    known.add(resource.dockerName);
    const physical = volumes.get(resource.dockerName);
    resources.set(resource.id, { ...resource,
      incarnation: volumeIncarnation(physical, identity, allowLabelIdentity),
      live: liveReferenced.has(resource.dockerName),
    });
  };
  for (const v of manager.store.list()) {
    const physical = volumes.get(v.dockerName);
    const labels = physical?.Labels ?? {};
    const owned = v.purpose === "legacy-backup-path"
      ? labels["agentor.persistent-backup-path"] === "true" && labels["agentor.worker-id"] === v.workerId
      : labels[VOLUME_LABEL] === v.id && labels["agentor.owner-id"] === v.userId && labels["agentor.worker-id"] === v.workerId;
    add({ id: v.id, dockerName: v.dockerName, userId: v.userId, workerId: v.workerId,
      purpose: v.purpose, ownerKey: v.retainedAfterAccountDeletion ? "platform" : v.userId, classification: "managed" },
      { volumeId: v.id, ownerId: v.userId, workerId: v.workerId, purpose: v.purpose },
      Boolean(owned && v.purpose === "persistent-path"));
    resources.get(v.id)!.live = managedVolumeIsLive(v.dockerName, v.liveContainerId, liveReferenced, runningContainerIds);
    // A mismatched physical object is visible as unsafe/missing in inventory,
    // but can never be selected for a helper scan.
    if (physical && !owned) resources.get(v.id)!.incarnation = undefined;
  }
  const addBuiltin = (name: string, purpose: string, userId?: string, workerId?: string) =>
    add({ id: opaqueVolumeId("builtin", name), dockerName: name, userId, workerId,
      purpose, ownerKey: userId ?? "platform", classification: "builtin" },
      { purpose, ...(userId ? { ownerId: userId } : {}), ...(workerId ? { workerId } : {}) });
  for (const worker of useWorkerStore().list()) {
    const name = useContainerManager().buildContainerName(worker.id);
    if (useStorageManager().mode === "volume") {
      addBuiltin(`${name}-workspace`, "workspace", worker.userId, worker.id);
      addBuiltin(`${name}-agents`, "agent-data", worker.userId, worker.id);
    }
    addBuiltin(`${name}-docker`, "docker-in-docker", worker.userId, worker.id);
  }
  const admin = useAdminWorkspaceStore().getRecord();
  if (admin) {
    const names = administrativeWorkspaceResourceNames(admin);
    addBuiltin(names.workspaceVolume, "admin-workspace");
    addBuiltin(names.agentsVolume, "admin-agent-data");
  }
  for (const group of useWorkerGroupStore().list()) {
    if (!group.adminWorkspace) continue;
    const names = administrativeWorkspaceResourceNames(group.adminWorkspace as any);
    addBuiltin(names.workspaceVolume, "group-admin-workspace", group.userId, group.adminWorkspace.id);
    addBuiltin(names.agentsVolume, "group-admin-agent-data", group.userId, group.adminWorkspace.id);
  }
  addBuiltin("agentor-traefik-certs", "proxy-certificates");
  for (const [name, physical] of volumes) {
    if (known.has(name) || physical.Driver !== "local" || Object.keys(physical.Options ?? {}).length) continue;
    const labels = physical.Labels ?? {};
    const legacy = labels["agentor.persistent-backup-path"] === "true" && /^[a-f0-9-]{36}$/i.test(labels["agentor.worker-id"] ?? "");
    const custom = /^[a-f0-9-]{36}$/i.test(labels[VOLUME_LABEL] ?? "") &&
      typeof labels["agentor.owner-id"] === "string" && labels["agentor.owner-id"] &&
      /^[a-f0-9-]{36}$/i.test(labels["agentor.worker-id"] ?? "");
    if (!legacy && !custom) continue;
    // Orphans are platform-only. Labels classify them but never grant the
    // asserted owner ordinary-user access.
    add({ id: opaqueVolumeId("orphan", name), dockerName: name,
      purpose: legacy ? "legacy-backup-path" : "persistent-path", ownerKey: "platform", classification: "orphan" },
      legacy
        ? { legacy: "true", workerId: labels["agentor.worker-id"] }
        : { volumeId: labels[VOLUME_LABEL], ownerId: labels["agentor.owner-id"], workerId: labels["agentor.worker-id"] });
  }
  return { available, volumes, referenced, liveReferenced, resources };
}

/** Resolve only positively classified named volumes. The returned Docker name
 * is server-private and must never be serialized by an API or MCP caller. */
export async function resolveManagedVolumeSizingResource(
  id: string,
  scope: { userId?: string; workerIds?: Set<string>; platform?: boolean },
): Promise<ManagedVolumeSizingResource | undefined> {
  const discovery = await discoverSizingResources();
  if (!discovery.available) return undefined;
  const found = discovery.resources.get(id);
  if (!found || !found.incarnation) return undefined;
  if (!scope.platform) {
    if (!scope.userId || found.userId !== scope.userId || found.classification === "orphan") return undefined;
    if (scope.workerIds && (!found.workerId || !scope.workerIds.has(found.workerId))) return undefined;
    const managed = useManagedVolumeManager().store.list().find((v) => v.id === id);
    if (managed?.retainedAfterAccountDeletion) return undefined;
  }
  return found;
}

/** Owner/subtree filtering occurs before projecting metadata. Docker names and
 * host mountpoints are never part of this response, including admin inventory. */
export async function managedVolumeInventory(scope: { userId?: string; workerIds?: Set<string>; platform?: boolean }) {
  const manager = useManagedVolumeManager(); await manager.init();
  const workers = useWorkerStore().list();
  const allowed = (userId?: string, workerId?: string) =>
    (scope.platform || !!userId && userId === scope.userId) &&
    (!scope.workerIds || !!workerId && scope.workerIds.has(workerId));
  const result: VolumeInventoryItem[] = [];
  const discovery = await discoverSizingResources();
  const { available, volumes, referenced } = discovery;
  const { useManagedVolumeSizingManager } = await import("./managed-volume-sizing");
  const sizing = useManagedVolumeSizingManager(); await sizing.init();
  const known = new Set<string>();
  const configurations = new Map<string, any>();
  const coverage = async (userId: string | undefined, workerId: string | undefined, target: string | undefined) => {
    if (!userId || !workerId || !target) return "unknown" as const;
    if (!configurations.has(userId)) configurations.set(userId, await useBackupManager().getConfig(userId).catch(() => null));
    const config = configurations.get(userId);
    if (!config) return "not-configured" as const;
    const selected = config.selectedPathsByWorkspace?.[workerId];
    // Report selection, not a guarantee that a backup has successfully run.
    return Array.isArray(selected) && selected.some((p: string) => p === "/" || p === target || target.startsWith(`${p}/`))
      ? "selected" as const : "not-configured" as const;
  };
  for (const v of manager.store.list()) {
    known.add(v.dockerName);
    if (v.retainedAfterAccountDeletion && !scope.platform) continue;
    if (!allowed(v.userId, v.workerId)) continue;
    const physical = volumes.get(v.dockerName);
    const worker = workers.find((w) => w.id === v.workerId && w.userId === v.userId);
    const size = sizing.measurementFor(v.id, discovery.resources.get(v.id)?.incarnation, available);
    result.push({ id: v.id, name: v.name, userId: v.userId, purpose: v.purpose,
      workerId: v.workerId, workerName: worker?.displayName, target: v.target,
      desired: v.attached, observed: !available ? "unknown" : !physical ? "missing" : referenced.has(v.dockerName) ? "mounted" : v.liveContainerId ? "unknown" : "unmounted",
      state: v.retainedAfterAccountDeletion ? "retained after account deletion" : v.state, sizeBytes: size.allocatedBytes,
      logicalSizeBytes: size.logicalBytes, size, sizeJob: sizing.latestJobFor(v.id), canMeasureSize: available && Boolean(discovery.resources.get(v.id)?.incarnation),
      backupCoverage: await coverage(v.userId, v.workerId, v.target), createdAt: v.createdAt,
      managed: true, canDelete: available && !v.attached && !v.liveContainerId && !referenced.has(v.dockerName),
      error: v.operation?.error,
    });
  }
  const builtin = async (name: string, purpose: string, userId?: string, workerId?: string, target?: string, workerName?: string) => {
    known.add(name);
    if (!allowed(userId, workerId)) return;
    const physical = volumes.get(name);
    if (!physical) return;
    const id = opaqueVolumeId("builtin", name), size = sizing.measurementFor(id, discovery.resources.get(id)?.incarnation, available);
    result.push({ id,
      name: workerName ? `${workerName}: ${purpose}` : purpose, userId, workerId, workerName, purpose, target,
      desired: true, observed: available ? referenced.has(name) ? "mounted" : "unmounted" : "unknown",
      state: "built-in", sizeBytes: size.allocatedBytes, logicalSizeBytes: size.logicalBytes,
      size, sizeJob: sizing.latestJobFor(id), canMeasureSize: available && Boolean(discovery.resources.get(id)?.incarnation),
      backupCoverage: await coverage(userId, workerId, target), createdAt: (physical as any).CreatedAt,
      managed: false, canDelete: false });
  };
  for (const worker of workers) {
    const name = useContainerManager().buildContainerName(worker.id);
    if (useStorageManager().mode === "volume") {
      await builtin(`${name}-workspace`, "workspace", worker.userId, worker.id, "/workspace", worker.displayName);
      await builtin(`${name}-agents`, "agent-data", worker.userId, worker.id, "/home/agent/.agent-data", worker.displayName);
    }
    await builtin(`${name}-docker`, "docker-in-docker", worker.userId, worker.id, "/var/lib/docker", worker.displayName);
  }
  const admin = useAdminWorkspaceStore().getRecord();
  if (admin) {
    const names = administrativeWorkspaceResourceNames(admin);
    await builtin(names.workspaceVolume, "admin-workspace");
    await builtin(names.agentsVolume, "admin-agent-data");
  }
  for (const group of useWorkerGroupStore().list()) {
    if (!group.adminWorkspace) continue;
    const names = administrativeWorkspaceResourceNames(group.adminWorkspace as any);
    await builtin(names.workspaceVolume, "group-admin-workspace", group.userId, group.adminWorkspace.id);
    await builtin(names.agentsVolume, "group-admin-agent-data", group.userId, group.adminWorkspace.id);
  }
  await builtin("agentor-traefik-certs", "proxy-certificates");
  // Only positively labeled, unattributed legacy data is shown as an orphan.
  // A name prefix alone never grants ownership or a destructive action.
  if (scope.platform && !scope.workerIds) for (const [name, v] of volumes) {
    const legacy = v.Labels?.["agentor.persistent-backup-path"] === "true";
    const custom = /^[a-f0-9-]{36}$/.test(v.Labels?.["agentor.volume-id"] ?? "") && !!v.Labels?.["agentor.owner-id"];
    if (known.has(name) || !legacy && !custom) continue;
    const id = opaqueVolumeId("orphan", name), size = sizing.measurementFor(id, discovery.resources.get(id)?.incarnation, available);
    result.push({ id,
      name: "Retained volume without an owner record", purpose: legacy ? "legacy-backup-path" : "persistent-path", desired: false,
      observed: referenced.has(name) ? "mounted" : "unmounted", state: "orphaned", sizeBytes: size.allocatedBytes,
      logicalSizeBytes: size.logicalBytes, size, sizeJob: sizing.latestJobFor(id), canMeasureSize: available && Boolean(discovery.resources.get(id)?.incarnation),
      backupCoverage: "unknown", managed: false, canDelete: false });
  }
  return { volumes: result, dockerAvailable: available };
}
