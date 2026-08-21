export interface CatalogVersion {
  version: string;
  digest: string;
  baseImage: string;
  createdAt: string;
  promoted?: boolean;
}
export interface ImageDefinition {
  id: string;
  /** Undefined for an owner/global catalog definition. */
  groupId?: string;
  name: string;
  description: string;
  baseImage: string;
  dockerfileFragment: string;
  contextFiles: Array<{ path: string; contentBase64: string; role?: "asset" | "script"; destination?: string }>;
  provisioning?: Array<
    | { type: "packages"; manager: "apt" | "npm" | "pip"; packages: string[] }
    | { type: "command"; command: string }
    | { type: "script"; path: string; interpreter: "sh" | "bash" | "python3" | "node" }
  >;
  versions: CatalogVersion[];
  promotedVersion?: string;
}
export interface ImageBuild {
  id: string;
  definitionId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  phase: string;
  version?: string;
  digest?: string;
  error?: string;
  durationMs?: number;
  cache?: { enabled: boolean; hits: number };
}
export interface CatalogUsage {
  totalBytes: number;
  partialBuildBytes: number;
  definitions: Array<{ id: string; bytes: number }>;
}
export interface GitCatalogConnection {
  connected?: boolean;
  repository?: string;
  visibility?: "public" | "private";
  workflow?: "direct" | "branch" | "pull-request";
  buildMode?: "local" | "github-actions";
  publishGhcr?: boolean;
  credential?: { type: string; configured: boolean; shortLived: boolean };
  lastSyncAt?: string;
}
export function useImageCatalog() {
  const definitions = ref<ImageDefinition[]>([]),
    builds = ref<Record<string, ImageBuild>>({}),
    logs = ref<Record<string, string>>({});
  const usage = ref<CatalogUsage>({
    totalBytes: 0,
    partialBuildBytes: 0,
    definitions: [],
  });
  const effectiveDefault = ref<any>(null),
    gitConnection = ref<GitCatalogConnection>({ connected: false }),
    gitRecovery = ref<any>(null),
    gitSyncResult = ref<any>(null),
    loading = ref(false),
    error = ref("");
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let liveTimer: ReturnType<typeof setInterval> | undefined;
  async function refresh() {
    if (loading.value) return;
    loading.value = true;
    error.value = "";
    try {
      const [nextDefinitions, nextUsage, nextDefault, nextGit, nextRecovery, recentBuilds] =
        await Promise.all([
          $fetch<ImageDefinition[]>("/api/image-catalog/definitions"),
          $fetch<CatalogUsage>("/api/image-catalog/usage"),
          $fetch<any>("/api/image-catalog/defaults/effective"),
          $fetch<GitCatalogConnection>("/api/image-catalog/git/connection"),
          $fetch<any>("/api/image-catalog/git/recovery"),
          $fetch<ImageBuild[]>("/api/image-builds"),
        ]);
      definitions.value = nextDefinitions;
      usage.value = nextUsage;
      effectiveDefault.value = nextDefault;
      gitConnection.value = nextGit;
      gitRecovery.value = nextRecovery;
      builds.value = Object.fromEntries(recentBuilds.map((build: ImageBuild) => [build.id, build]));
      await Promise.all(recentBuilds.map(async (build: ImageBuild) => {
        logs.value[build.id] = await $fetch<string>(`/api/image-builds/${build.id}/logs`).catch(() => logs.value[build.id] || "");
      }));
    } catch (e: any) {
      error.value =
        e?.data?.statusMessage || e?.message || "Could not load image catalog.";
    } finally {
      loading.value = false;
    }
  }
  function start() {
    stop();
    void refresh();
    liveTimer = setInterval(() => void refresh(), 2000);
  }
  async function create(
    input: Omit<ImageDefinition, "id" | "versions" | "promotedVersion">,
  ) {
    const value = await $fetch<ImageDefinition>(
      "/api/image-catalog/definitions",
      { method: "POST", body: input },
    );
    definitions.value.push(value);
    return value;
  }
  async function startBuild(id: string, rebuildBase?: string) {
    const path = rebuildBase
      ? `/api/image-catalog/definitions/${id}/rebuild-base`
      : `/api/image-catalog/definitions/${id}/builds`;
    const b = await $fetch<ImageBuild>(path, {
      method: "POST",
      body: {
        builder: "controlled",
        ...(rebuildBase ? { baseImage: rebuildBase } : {}),
      },
    });
    builds.value[b.id] = b;
    poll(b.id);
    return b;
  }
  async function poll(id: string) {
    const b = await $fetch<ImageBuild>(`/api/image-builds/${id}`);
    builds.value[id] = b;
    logs.value[id] = await $fetch<string>(`/api/image-builds/${id}/logs`);
    if (["queued", "running"].includes(b.status)) {
      const previous = pollTimers.get(id);
      if (previous) clearTimeout(previous);
      pollTimers.set(id, setTimeout(() => void poll(id), 1000));
    } else {
      const previous = pollTimers.get(id);
      if (previous) clearTimeout(previous);
      pollTimers.delete(id);
      // Terminal build state changes the definition's immutable version list
      // and storage accounting. Refresh those views before enabling version
      // actions such as smoke-test and promotion.
      await refresh();
    }
    return b;
  }
  async function cancel(id: string) {
    builds.value[id] = await $fetch(`/api/image-builds/${id}`, {
      method: "DELETE",
    });
  }
  async function promote(d: string, v: string) {
    await $fetch(`/api/image-catalog/definitions/${d}/versions/${v}/promote`, {
      method: "POST",
    });
    await refresh();
  }
  async function rollback(d: string, v: string) {
    await $fetch(`/api/image-catalog/definitions/${d}/rollback`, {
      method: "POST",
      body: { version: v },
    });
    await refresh();
  }
  async function testWorker(d: string, v: string) {
    return $fetch(
      `/api/image-catalog/definitions/${d}/versions/${v}/test-worker`,
      { method: "POST" },
    );
  }
  async function setDefault(d: string, v: string, system = false) {
    await $fetch(`/api/image-catalog/defaults${system ? "/system" : ""}`, {
      method: "PUT",
      body: { definitionId: d, version: v },
    });
    await refresh();
  }
  async function removeVersion(d: string, v: string) {
    await $fetch(`/api/image-catalog/definitions/${d}/versions/${v}`, {
      method: "DELETE",
    });
    await refresh();
  }
  async function removeDefinition(id: string) {
    await $fetch(`/api/image-catalog/definitions/${id}`, { method: "DELETE" });
    await refresh();
  }
  async function connectGit(input: Record<string, unknown>) {
    gitConnection.value = await $fetch<GitCatalogConnection>("/api/image-catalog/git/connection", { method: "PUT", body: input });
  }
  async function disconnectGit() {
    await $fetch("/api/image-catalog/git/connection", { method: "DELETE" });
    gitConnection.value = { connected: false };
    gitRecovery.value = null;
    gitSyncResult.value = null;
  }
  async function syncGit(direction: "push" | "pull", resolution?: "remote-copy") {
    gitSyncResult.value = await $fetch("/api/image-catalog/git/sync", { method: "POST", body: { direction, resolution } });
    await refresh();
    return gitSyncResult.value;
  }
  function stop() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = undefined;
    for (const timer of pollTimers.values()) clearTimeout(timer);
    pollTimers.clear();
  }
  return {
    definitions,
    builds,
    logs,
    usage,
    effectiveDefault,
    gitConnection,
    gitRecovery,
    gitSyncResult,
    loading,
    error,
    refresh,
    start,
    create,
    startBuild,
    poll,
    cancel,
    promote,
    rollback,
    testWorker,
    setDefault,
    removeVersion,
    removeDefinition,
    connectGit,
    disconnectGit,
    syncGit,
    stop,
  };
}
