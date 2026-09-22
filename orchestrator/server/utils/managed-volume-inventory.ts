import { createHash } from "node:crypto";
import type { VolumeInventoryItem } from "../../shared/managed-volumes";
import { useManagedVolumeManager } from "./managed-volume-manager";
import { useContainerManager, useStorageManager, useWorkerGroupStore, useWorkerStore } from "./services";
import { useAdminWorkspaceStore } from "./admin-workspace-store";
import { administrativeWorkspaceResourceNames } from "./admin-workspace-runtime";
import { useBackupManager } from "./backup-manager";
import { withOperationDeadline } from "./operation-deadline";

/** Owner/subtree filtering occurs before projecting metadata. Docker names and
 * host mountpoints are never part of this response, including admin inventory. */
export async function managedVolumeInventory(scope: { userId?: string; workerIds?: Set<string>; platform?: boolean }) {
  const manager = useManagedVolumeManager(); await manager.init();
  const workers = useWorkerStore().list();
  const allowed = (userId?: string, workerId?: string) =>
    (scope.platform || !!userId && userId === scope.userId) &&
    (!scope.workerIds || !!workerId && scope.workerIds.has(workerId));
  const result: VolumeInventoryItem[] = [];
  let available = true;
  const raw = await withOperationDeadline(manager.runtime.docker.listVolumes(), 8000, "Agentor volume inventory").catch(() => { available = false; return { Volumes: [] }; });
  const volumes = new Map((raw.Volumes ?? []).map((v) => [v.Name, v]));
  const containers = await withOperationDeadline(manager.runtime.docker.listContainers({ all: true }), 8000, "Volume attachment inventory").catch(() => { available = false; return []; });
  const referenced = new Set(containers.flatMap((c) => (c.Mounts ?? []).map((m) => m.Name).filter(Boolean)));
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
    result.push({ id: v.id, name: v.name, userId: v.userId, purpose: v.purpose,
      workerId: v.workerId, workerName: worker?.displayName, target: v.target,
      desired: v.attached, observed: !available ? "unknown" : !physical ? "missing" : referenced.has(v.dockerName) ? "mounted" : v.liveContainerId ? "unknown" : "unmounted",
      state: v.retainedAfterAccountDeletion ? "retained after account deletion" : v.state, sizeBytes: physical?.UsageData?.Size ?? null,
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
    result.push({ id: `builtin-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
      name: workerName ? `${workerName}: ${purpose}` : purpose, userId, workerId, workerName, purpose, target,
      desired: true, observed: available ? referenced.has(name) ? "mounted" : "unmounted" : "unknown",
      state: "built-in", sizeBytes: physical.UsageData?.Size ?? null,
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
    result.push({ id: `orphan-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
      name: "Retained volume without an owner record", purpose: legacy ? "legacy-backup-path" : "persistent-path", desired: false,
      observed: referenced.has(name) ? "mounted" : "unmounted", state: "orphaned", sizeBytes: v.UsageData?.Size ?? null,
      backupCoverage: "unknown", managed: false, canDelete: false });
  }
  return { volumes: result, dockerAvailable: available };
}
