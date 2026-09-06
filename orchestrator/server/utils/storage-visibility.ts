import Docker from "dockerode";
import { readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { useConfig } from "./services";
import { listWorkspaceInventory } from "./workspace-inventory";
import { withOperationDeadline } from "./operation-deadline";
import { isOperationHelperActive } from "./operation-helper-registry";

const STALE_TEMP_MS = 2 * 60 * 60 * 1000;
const HELPER_LABELS = ["agentor.workspace-helper", "agentor.backup-restore-helper"] as const;
const STORAGE_DOCKER_TIMEOUT_MS = 8_000;

export async function cleanupStaleDockerHelpers(
  docker: Pick<Docker, "listContainers" | "getContainer">,
  timeoutMs = STORAGE_DOCKER_TIMEOUT_MS,
): Promise<{
  attempted: number;
  removed: number;
  failures: Array<{ helperName: string; code: string }>;
}> {
  const containers = await listDockerHelpers(docker, timeoutMs);
  // Docker's `running` state can itself be stale. Protect helpers that still
  // have a live in-process request owner, but retry every unowned helper even
  // when Docker reports it running. This also catches an object created after
  // an aborted create response settled.
  const stale = containers.filter(
    (item: any) =>
      item.State !== "running" ||
      !isOperationHelperActive(
        item.Labels?.["agentor.helper.operation-id"],
      ),
  );
  const settled = await Promise.allSettled(
    stale.map((container) =>
      withOperationDeadline(
        (operationSignal) => docker.getContainer(container.Id).remove({
          force: true,
          abortSignal: operationSignal,
        } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
        timeoutMs,
        "Docker stale-helper cleanup",
      ),
    ),
  );
  return {
    attempted: stale.length,
    removed: settled.filter((result) => result.status === "fulfilled").length,
    failures: settled.flatMap((result, index) =>
      result.status === "rejected"
        ? [{
            // Never expose a Docker/containerd id through the API or MCP.
            // Helper names are server-generated operation handles and remain
            // sufficient to retry or correlate bounded cleanup.
            helperName: (
              stale[index]!.Names?.[0]?.replace(/^\//, "") ||
              `helper-${index + 1}`
            ).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200),
            code:
              (result.reason as { code?: string })?.code ||
              "HELPER_CLEANUP_FAILED",
          }]
        : [],
    ),
  };
}

/** Docker combines repeated label filters with AND, while these helper kinds
 * are intentionally disjoint. Query each deterministic label independently
 * and deduplicate by container id so one kind (or one failed inventory call)
 * cannot hide the other from cleanup. */
async function listDockerHelpers(
  docker: Pick<Docker, "listContainers">,
  timeoutMs: number,
): Promise<Docker.ContainerInfo[]> {
  const settled = await Promise.allSettled(
    HELPER_LABELS.map((label) =>
      withOperationDeadline(
        (operationSignal) => docker.listContainers({
          all: true,
          filters: { label: [`${label}=true`] },
          abortSignal: operationSignal,
        }),
        timeoutMs,
        "Docker helper inventory",
      ),
    ),
  );
  const unique = new Map<string, Docker.ContainerInfo>();
  for (const result of settled)
    if (result.status === "fulfilled")
      for (const container of result.value) unique.set(container.Id, container);
  return [...unique.values()];
}

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
    try {
      dockerDf = await withOperationDeadline(
        (this.docker as any).df(),
        STORAGE_DOCKER_TIMEOUT_MS,
        "Docker storage inventory",
      );
    } catch { /* Docker unavailable in direct-host dev */ }
    const images = Array.isArray(dockerDf?.Images) ? dockerDf.Images : [];
    const buildCache = Array.isArray(dockerDf?.BuildCache) ? dockerDf.BuildCache : [];
    const containers = await listDockerHelpers(
      this.docker,
      STORAGE_DOCKER_TIMEOUT_MS,
    );
    const staging = await Promise.all([
      this.directory("export-artifacts", "Export artifacts", false),
      this.directory("tmp", "Backup/export/import staging", true),
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
      helpers: {
        total: containers.length,
        stale: containers.filter(
          (container: any) =>
            container.State !== "running" ||
            !isOperationHelperActive(
              container.Labels?.["agentor.helper.operation-id"],
            ),
        ).length,
      },
    };
  }
  async cleanup(input: { danglingImages?: boolean; buildCache?: boolean; staleHelpers?: boolean; staleStaging?: boolean }) {
    let reclaimedBytes = 0;
    const actions: string[] = [];
    let helperCleanup: { attempted: number; removed: number; failures: Array<{ helperName: string; code: string }> } | undefined;
    if (input.danglingImages) {
      const result: any = await withOperationDeadline(
        new Promise((resolve) =>
          this.docker.pruneImages({ filters: { dangling: ["true"] } } as any, (error, value) => resolve(error ? undefined : value)),
        ),
        STORAGE_DOCKER_TIMEOUT_MS,
        "Docker dangling-image cleanup",
      );
      reclaimedBytes += Number(result?.SpaceReclaimed || 0); actions.push("dangling-images");
    }
    if (input.buildCache) {
      const prune = (this.docker as any).pruneBuilds?.({ filters: { dangling: ["true"] } });
      const result: any = prune
        ? await withOperationDeadline(
            prune,
            STORAGE_DOCKER_TIMEOUT_MS,
            "Docker build-cache cleanup",
          ).catch(() => undefined)
        : undefined;
      reclaimedBytes += Number(result?.SpaceReclaimed || 0); actions.push("build-cache");
    }
    if (input.staleHelpers) {
      helperCleanup = await cleanupStaleDockerHelpers(this.docker);
      actions.push("stale-helpers");
    }
    if (input.staleStaging) { reclaimedBytes += await this.removeStaleStaging(); actions.push("stale-staging"); }
    return { reclaimedBytes, actions, ...(helperCleanup ? { helperCleanup } : {}), inventory: await this.inspect() };
  }
  private async directory(id: string, label: string, cleanup: boolean) {
    const path = join(useConfig().dataDir, id);
    return { id, label, bytes: await directoryBytes(path), cleanup };
  }
  private async removeStaleStaging() {
    const root = join(useConfig().dataDir, "tmp"); let reclaimed = 0;
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!isCleanupEligibleStaging(name)) continue;
      const path = join(root, name); const info = await stat(path).catch(() => undefined);
      if (!info || Date.now() - info.mtimeMs < STALE_TEMP_MS) continue;
      reclaimed += await directoryBytes(path); await rm(path, { recursive: true, force: true });
    }
    return reclaimed;
  }
}
export function isCleanupEligibleStaging(name: string) {
  return /^(backup|restore|export|management-import)-/.test(name);
}
async function directoryBytes(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined); if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0; for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) bytes += await directoryBytes(join(path, entry.name)); return bytes;
}
let singleton: StorageVisibilityManager | undefined;
export function useStorageVisibilityManager() { return (singleton ??= new StorageVisibilityManager()); }
