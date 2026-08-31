export type ProvisioningMode = "safe" | "advanced";

export interface CompatibilityCheck {
  id?: string;
  name?: string;
  kind?: "core" | "plugin";
  state?: string;
  status?: string;
  required?: boolean;
  message?: string;
  details?: string;
}
export interface CompatibilityResult {
  state?: string;
  status?: string;
  core?:
    CompatibilityCheck[] | { status?: string; checks?: CompatibilityCheck[] };
  requiredChecks?: CompatibilityCheck[];
  optionalChecks?: CompatibilityCheck[];
  pluginChecks?: CompatibilityCheck[];
  checks?: CompatibilityCheck[];
  warnings?: string[];
  error?: string;
}
export interface CatalogVersion {
  version: string;
  digest: string;
  baseImage: string;
  createdAt: string;
  promoted?: boolean;
  runtimeImage?: string;
  /** Additive compatibility state. Older catalog records are safe/ready. */
  readiness?: string;
  compatibility?: CompatibilityResult;
  warnings?: string[];
}
export interface PluginCompositionSelection {
  definitionId: string;
  validation?: "required" | "optional";
  /** A plugin can explicitly require the definition's Advanced opt-in. */
  requiresAdvancedProvisioning?: boolean;
}
export interface ImageDefinition {
  id: string;
  groupId?: string;
  name: string;
  description: string;
  baseImage: string;
  dockerfileFragment: string;
  contextFiles: Array<{
    path: string;
    contentBase64: string;
    role?: "asset" | "script";
    destination?: string;
  }>;
  provisioning?: Array<
    | { type: "packages"; manager: "apt" | "npm" | "pip"; packages: string[] }
    | { type: "command"; command: string }
    | {
        type: "script";
        path: string;
        interpreter: "sh" | "bash" | "python3" | "node";
      }
  >;
  /** Missing persisted values deliberately mean Safe mode. */
  provisioningMode?: ProvisioningMode;
  pluginComposition?: PluginCompositionSelection[];
  versions: CatalogVersion[];
  promotedVersion?: string;
}
export interface BuildDiagnostic {
  kind?: string;
  code?: string;
  blockedStep?: string;
  blockedField?: string;
  field?: string;
  constraint?: string;
  reason?: string;
  remediation?: string;
  advancedAvailable?: boolean;
  advancedModeAvailable?: boolean;
}
export interface ImageBuild {
  id: string;
  definitionId: string;
  status: string;
  phase: string;
  version?: string;
  digest?: string;
  error?: string;
  durationMs?: number;
  cache?: { enabled: boolean; hits: number };
  dockerAttempted?: boolean;
  imageCreated?: boolean;
  compatibility?: CompatibilityResult;
  warnings?: string[];
  diagnostic?: BuildDiagnostic;
  nextActions?: Record<
    string,
    { tool?: string; arguments?: Record<string, unknown>; href?: string }
  >;
}
export interface CatalogUsage {
  totalBytes: number;
  partialBuildBytes: number;
  definitions: Array<{ id: string; bytes: number }>;
}
export interface PluginDefinition {
  id: string;
  manifest?: {
    name?: string;
    slug?: string;
    description?: string;
    lifecycle?: { install?: unknown };
    image?: { requiresAdvancedProvisioning?: boolean };
    imageBuild?: {
      requiresAdvancedProvisioning?: boolean;
      validation?: { defaultRequired?: boolean };
    };
  };
  name?: string;
  description?: string;
  imageBuild?: {
    requiresAdvancedProvisioning?: boolean;
    validation?: { defaultRequired?: boolean };
  };
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

function active(build: ImageBuild) {
  if (["succeeded", "failed", "cancelled"].includes(build.status)) return false;
  return (
    ["queued", "running"].includes(build.status) ||
    ["queued", "preflight", "building", "image-created", "validating"].includes(
      build.phase,
    )
  );
}
function logText(response: unknown): { text: string; cursor?: number } {
  if (typeof response === "string") return { text: response };
  const value = response as any;
  if (Array.isArray(value?.logs))
    return {
      text: value.logs.join("\n"),
      cursor: Number(value.nextCursor ?? value.cursor) || undefined,
    };
  return {
    text: String(value?.logs ?? value?.text ?? ""),
    cursor: Number(value?.nextCursor ?? value?.cursor) || undefined,
  };
}

export function useImageCatalog() {
  const definitions = ref<ImageDefinition[]>([]),
    builds = ref<Record<string, ImageBuild>>({}),
    logs = ref<Record<string, string>>({}),
    plugins = ref<PluginDefinition[]>([]);
  const logCursors = ref<Record<string, number>>({});
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
  async function refreshPlugins() {
    // Plugins predate image composition in some deployments. Treat a missing
    // endpoint as an empty catalog rather than preventing image management.
    plugins.value = await $fetch<PluginDefinition[]>(
      "/api/plugins/definitions",
    ).catch(() => plugins.value);
  }
  async function refresh() {
    if (loading.value) return;
    loading.value = true;
    error.value = "";
    try {
      const [
        nextDefinitions,
        nextUsage,
        nextDefault,
        nextGit,
        nextRecovery,
        recentBuilds,
      ] = await Promise.all([
        $fetch<ImageDefinition[]>("/api/image-catalog/definitions"),
        $fetch<CatalogUsage>("/api/image-catalog/usage"),
        $fetch<any>("/api/image-catalog/defaults/effective"),
        $fetch<GitCatalogConnection>("/api/image-catalog/git/connection"),
        $fetch<any>("/api/image-catalog/git/recovery"),
        $fetch<ImageBuild[]>("/api/image-builds"),
        refreshPlugins(),
      ]);
      definitions.value = nextDefinitions;
      usage.value = nextUsage;
      effectiveDefault.value = nextDefault;
      gitConnection.value = nextGit;
      gitRecovery.value = nextRecovery;
      builds.value = Object.fromEntries(
        recentBuilds.map((build: ImageBuild) => [build.id, build]),
      );
      for (const build of recentBuilds) if (active(build)) void poll(build.id);
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
    liveTimer = setInterval(() => void refresh(), 2_000);
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
  async function update(
    id: string,
    input: Omit<ImageDefinition, "id" | "versions" | "promotedVersion">,
  ) {
    const value = await $fetch<ImageDefinition>(
      `/api/image-catalog/definitions/${id}`,
      { method: "PUT", body: input },
    );
    definitions.value = definitions.value.map((d) => (d.id === id ? value : d));
    return value;
  }
  async function startBuild(
    id: string,
    rebuildBase?: string,
    requestId?: string,
  ) {
    const path = rebuildBase
      ? `/api/image-catalog/definitions/${id}/rebuild-base`
      : `/api/image-catalog/definitions/${id}/builds`;
    const b = await $fetch<ImageBuild>(path, {
      method: "POST",
      body: {
        builder: "controlled",
        ...(rebuildBase ? { baseImage: rebuildBase } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
    builds.value[b.id] = b;
    void poll(b.id);
    return b;
  }
  async function loadLogs(id: string, reset = false) {
    const after = reset ? 0 : logCursors.value[id] || 0;
    const response = await $fetch<any>(`/api/image-builds/${id}/logs`, {
      query: { after, limit: 200, format: "json" },
    });
    const entry = logText(response);
    logs.value[id] = reset
      ? entry.text
      : [logs.value[id], entry.text].filter(Boolean).join("\n");
    if (entry.cursor !== undefined) logCursors.value[id] = entry.cursor;
    // Legacy endpoints use an array-entry offset, not a byte offset. New
    // cursor-aware responses provide nextCursor explicitly.
    else if (entry.text)
      logCursors.value[id] = after + entry.text.split("\n").length;
    return logs.value[id];
  }
  async function poll(id: string) {
    const b = await $fetch<ImageBuild>(`/api/image-builds/${id}`);
    builds.value[id] = b;
    if (active(b)) {
      void loadLogs(id).catch(() => undefined);
      const previous = pollTimers.get(id);
      if (previous) clearTimeout(previous);
      pollTimers.set(
        id,
        setTimeout(() => void poll(id), 1_000),
      );
    } else {
      const previous = pollTimers.get(id);
      if (previous) clearTimeout(previous);
      pollTimers.delete(id);
      // A terminal status is enough to refresh versions/actions. Logs remain
      // an explicit, cursor-paged inspection action; do not fetch an entire
      // completed job merely because a poll reached its terminal state.
      await refresh();
    }
    return b;
  }
  async function cancel(id: string) {
    builds.value[id] = await $fetch<ImageBuild>(`/api/image-builds/${id}`, {
      method: "DELETE",
    });
    return builds.value[id];
  }
  async function retryValidation(d: string, v: string, requestId?: string) {
    const b = await $fetch<ImageBuild>(
      `/api/image-catalog/definitions/${d}/versions/${v}/validation-retry`,
      { method: "POST", body: requestId ? { requestId } : {} },
    );
    builds.value[b.id] = b;
    void poll(b.id);
    return b;
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
  async function testWorker(d: string, v: string, requestId?: string) {
    return $fetch<any>(
      `/api/image-catalog/definitions/${d}/versions/${v}/test-worker`,
      { method: "POST", body: requestId ? { requestId } : {} },
    );
  }
  async function testWorkerStatus(jobId: string) {
    return $fetch<any>(`/api/image-builds/${jobId}`);
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
    gitConnection.value = await $fetch<GitCatalogConnection>(
      "/api/image-catalog/git/connection",
      { method: "PUT", body: input },
    );
  }
  async function disconnectGit() {
    await $fetch("/api/image-catalog/git/connection", { method: "DELETE" });
    gitConnection.value = { connected: false };
    gitRecovery.value = null;
    gitSyncResult.value = null;
  }
  async function syncGit(
    direction: "push" | "pull",
    resolution?: "remote-copy",
  ) {
    gitSyncResult.value = await $fetch("/api/image-catalog/git/sync", {
      method: "POST",
      body: { direction, resolution },
    });
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
    logCursors,
    plugins,
    usage,
    effectiveDefault,
    gitConnection,
    gitRecovery,
    gitSyncResult,
    loading,
    error,
    refresh,
    refreshPlugins,
    start,
    create,
    update,
    startBuild,
    poll,
    loadLogs,
    cancel,
    retryValidation,
    promote,
    rollback,
    testWorker,
    testWorkerStatus,
    setDefault,
    removeVersion,
    removeDefinition,
    connectGit,
    disconnectGit,
    syncGit,
    stop,
  };
}
