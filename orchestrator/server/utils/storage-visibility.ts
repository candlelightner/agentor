import Docker from "dockerode";
import { readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { useConfig } from "./services";
import { listWorkspaceInventory } from "./workspace-inventory";

const STALE_TEMP_MS = 2 * 60 * 60 * 1000;
const HELPER_LABELS = ["agentor.workspace-helper", "agentor.backup-restore-helper"] as const;

export interface StorageVisibility {
  generatedAt: string;
  disk: { freeBytes: number; totalBytes: number; usedBytes: number; warning: "ok" | "warning" | "critical" };
  workspaces: { count: number; bytes: number | null };
  docker: { imagesBytes: number | null; buildCacheBytes: number | null; reclaimableImageBytes: number | null };
  staging: Array<{ id: string; label: string; bytes: number; cleanup: boolean }>;
  helpers: { total: number; stale: number };
}

/** Bounded administration-only disk view. It intentionally avoids deleting any
 * referenced worker/custom image or active artifact; cleanup is limited to
 * Docker's dangling images, exited Agentor helpers, and old Agentor tmp dirs. */
export class StorageVisibilityManager {
  private docker = new Docker({ socketPath: "/var/run/docker.sock" });
  async inspect(): Promise<StorageVisibility> {
    const config = useConfig();
    const fs = await statfs(config.dataDir);
    const totalBytes = Number(fs.blocks) * Number(fs.bsize);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const ratio = totalBytes ? freeBytes / totalBytes : 1;
    const workspaces = await listWorkspaceInventory(true);
    let dockerDf: any;
    try { dockerDf = await (this.docker as any).df(); } catch { /* Docker unavailable in direct-host dev */ }
    const images = Array.isArray(dockerDf?.Images) ? dockerDf.Images : [];
    const buildCache = Array.isArray(dockerDf?.BuildCache) ? dockerDf.BuildCache : [];
    const containers = await this.docker.listContainers({ all: true, filters: { label: HELPER_LABELS.map((label) => `${label}=true`) } }).catch(() => []);
    const staging = await Promise.all([
      this.directory("export-artifacts", "Export artifacts", false),
      this.directory("tmp", "Backup/export staging", true),
      this.directory("backup-objects", "Local backup objects", false),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      disk: { freeBytes, totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes), warning: ratio < 0.05 ? "critical" : ratio < 0.15 ? "warning" : "ok" },
      workspaces: { count: workspaces.length, bytes: workspaces.some((item) => item.size == null) ? null : workspaces.reduce((sum, item) => sum + (item.size || 0), 0) },
      docker: {
        imagesBytes: images.reduce((sum: number, image: any) => sum + Number(image.Size || 0), 0) || null,
        buildCacheBytes: buildCache.reduce((sum: number, cache: any) => sum + Number(cache.Size || 0), 0) || null,
        reclaimableImageBytes: images.reduce((sum: number, image: any) => sum + (Number(image.Containers || 0) === 0 ? Number(image.Size || 0) : 0), 0) || null,
      },
      staging,
      helpers: { total: containers.length, stale: containers.filter((container: any) => container.State !== "running").length },
    };
  }
  async cleanup(input: { danglingImages?: boolean; buildCache?: boolean; staleHelpers?: boolean; staleStaging?: boolean }) {
    let reclaimedBytes = 0;
    const actions: string[] = [];
    if (input.danglingImages) {
      const result: any = await new Promise((resolve) =>
        this.docker.pruneImages({ filters: { dangling: ["true"] } } as any, (error, value) => resolve(error ? undefined : value)),
      );
      reclaimedBytes += Number(result?.SpaceReclaimed || 0); actions.push("dangling-images");
    }
    if (input.buildCache) {
      const result: any = await (this.docker as any).pruneBuilds?.({ filters: { dangling: ["true"] } }).catch(() => undefined);
      reclaimedBytes += Number(result?.SpaceReclaimed || 0); actions.push("build-cache");
    }
    if (input.staleHelpers) {
      const containers = await this.docker.listContainers({ all: true, filters: { label: HELPER_LABELS.map((label) => `${label}=true`) } }).catch(() => []);
      for (const container of containers.filter((item: any) => item.State !== "running")) await this.docker.getContainer(container.Id).remove({ force: true }).catch(() => {});
      actions.push("stale-helpers");
    }
    if (input.staleStaging) { reclaimedBytes += await this.removeStaleStaging(); actions.push("stale-staging"); }
    return { reclaimedBytes, actions, inventory: await this.inspect() };
  }
  private async directory(id: string, label: string, cleanup: boolean) {
    const path = join(useConfig().dataDir, id);
    return { id, label, bytes: await directoryBytes(path), cleanup };
  }
  private async removeStaleStaging() {
    const root = join(useConfig().dataDir, "tmp"); let reclaimed = 0;
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!/^(backup|export)-/.test(name)) continue;
      const path = join(root, name); const info = await stat(path).catch(() => undefined);
      if (!info || Date.now() - info.mtimeMs < STALE_TEMP_MS) continue;
      reclaimed += await directoryBytes(path); await rm(path, { recursive: true, force: true });
    }
    return reclaimed;
  }
}
async function directoryBytes(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined); if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0; for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) bytes += await directoryBytes(join(path, entry.name)); return bytes;
}
let singleton: StorageVisibilityManager | undefined;
export function useStorageVisibilityManager() { return (singleton ??= new StorageVisibilityManager()); }
