export type BackupJobStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface BackupProviderStatus {
  id: string;
  type: string;
  connected: boolean;
  testMode?: boolean;
  tokenEncrypted?: boolean;
}
export interface GoogleBackupOAuthInstallationStatus {
  configured: boolean;
  source: "installation" | "environment" | "none";
  clientId?: string;
  redirectUri?: string;
  clientSecretConfigured: boolean;
  updatedAt?: string;
}
export interface BackupSettings {
  providerId: string;
  enabled: boolean;
  selection: "all" | "selected";
  workspaceIds: string[];
  selectedPathsByWorkspace: Record<string, string[]>;
  intervalMinutes: number;
  retentionCount: number;
  nextRunAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}
export interface BackupJob {
  id: string;
  status: BackupJobStatus;
  phase: string;
  progress: number;
  bytesProcessed?: number;
  sizeBytes?: number;
  durationMs?: number;
  error?: string;
  errorCode?: string;
  providerStatus?: number;
  retryable?: boolean;
  attempt?: number;
  workspaceIds?: string[];
  workspaceId?: string;
  artifactId?: string;
  operation?: "backup" | "restore" | "discovery" | "adoption" | "dependency-resolution";
  /** IDs only: portable image recipes remain inside the authenticated bundle. */
  recoveredImageDefinitionId?: string;
  recoveredImageBuildId?: string;
  /** Compatibility with an early server response spelling. */
  imageBuildId?: string;
  consistency?: { warning?: string };
}
export interface BackupArtifact {
  id: string;
  provider: string;
  workspaceIds?: string[];
  workspaceId?: string;
  createdAt: string;
  sizeBytes?: number;
  size?: number;
  integrityVerified?: boolean;
  missingSecrets?: string[];
  /** Member labels are present on newer multi-worker backup artifacts. */
  workspaceMembers?: BackupWorkspaceMember[];
  formatVersion?: number;
  keyFingerprint?: string;
  sourceInstallationId?: string;
  provenance?: "local" | "remote-adopted";
  integrityStatus?: "verified" | "failed" | "unavailable";
  reconstruction?: BackupWorkspaceReconstruction[];
  dependencies?: BackupDependency[];
}
export interface BackupDependency {
  kind: "image" | "plugin" | "secret" | "template";
  id: string;
  workspaceId?: string;
  status: "resolved" | "missing" | "replacement-required" | "warning";
  required?: boolean;
  reason?: string;
}
export type BackupImageResolution =
  | { mode: "exact" }
  | { mode: "workspace-only"; acknowledged: true }
  | {
      mode: "replacement";
      imageDefinitionId: string;
      imageVersion: string;
    };
export interface BackupRecoveryKeyStatus { fingerprint: string; active: boolean; source: "generated" | "imported" | "legacy"; createdAt?: string }
export interface BackupWorkspaceReconstruction {
  workspaceId: string;
  displayName?: string;
  image: { kind: "legacy" | "platform-default" | "unmanaged" | "custom"; definitionId?: string; version?: string; digest?: string; runtimeImageAvailable?: boolean; /** Safe server-derived capability bit; recipe bytes are never returned. */ recoveryAvailable?: boolean; catalogSource?: { kind: "git"; connectionId: string; remoteId: string; hash: string } };
  pluginDefinitions: Array<{ sourceId: string; name: string; version: string }>;
  desiredPluginCount: number;
  requiredSecretNames: string[];
}
export interface DiscoveredBackup {
  id: string; provider: string; providerObjectId?: string; createdAt?: string;
  size?: number; backupIdentity?: string; formatVersion?: number; keyFingerprint?: string;
  state: "discovered" | "missing-key" | "unsupported-format" | "too-large" | "incomplete" | "inaccessible" | "damaged" | "ready-to-adopt" | "adopted";
  integrityStatus?: "unverified" | "verified" | "failed";
  blockedReason?: string; adoptedArtifactId?: string;
  knownLocally?: boolean;
  restorable?: boolean;
  keyAvailable?: boolean | null;
  sourceInstallationId?: string;
  workspaceMembers?: BackupWorkspaceMember[];
}
export interface BackupWorkspaceMember {
  id: string;
  displayName?: string;
}

const message = (e: any, fallback: string) =>
  e?.data?.statusMessage || e?.data?.message || e?.message || fallback;

export function useBackups() {
  const artifacts = ref<BackupArtifact[]>([]),
    jobs = ref<BackupJob[]>([]),
    providers = ref<BackupProviderStatus[]>([]),
    recoveryKeys = ref<BackupRecoveryKeyStatus[]>([]),
    discovered = ref<DiscoveredBackup[]>([]),
    googleOAuthInstallation = ref<GoogleBackupOAuthInstallationStatus | null>(null);
  const settings = ref<BackupSettings>({
    providerId: "local",
    enabled: false,
    selection: "all",
  workspaceIds: [],
    selectedPathsByWorkspace: {},
    intervalMinutes: 1440,
    retentionCount: 7,
    nextRunAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
  });
  const loading = ref(false),
    error = ref("");
  const activeJobs = computed(() =>
    jobs.value.filter((j) => j.status === "queued" || j.status === "running"),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh() {
    loading.value = true;
    error.value = "";
    try {
      const [data, providerData, settingsData] = await Promise.all([
        $fetch<{ backups: BackupArtifact[]; jobs: BackupJob[] }>(
          "/api/backups",
        ),
        $fetch<BackupProviderStatus[]>("/api/backup-providers"),
        $fetch<BackupSettings>("/api/backup-settings"),
      ]);
      artifacts.value = data.backups;
      jobs.value = data.jobs;
      providers.value = providerData;
      settings.value = settingsData;
      // These additive endpoints are deliberately best-effort during rolling
      // upgrades, so an older server still renders ordinary backup management.
      const [keyResult, discoveryResult] = await Promise.allSettled([
        $fetch<{ keys?: BackupRecoveryKeyStatus[] } | BackupRecoveryKeyStatus[]>("/api/backups/recovery-key"),
        $fetch<DiscoveredBackup[] | { backups: DiscoveredBackup[] }>(
          "/api/backups/remote",
        ),
      ]);
      if (keyResult.status === "fulfilled") recoveryKeys.value = Array.isArray(keyResult.value) ? keyResult.value : keyResult.value.keys ?? [];
      if (discoveryResult.status === "fulfilled") discovered.value = Array.isArray(discoveryResult.value) ? discoveryResult.value : discoveryResult.value.backups ?? [];
      try {
        googleOAuthInstallation.value = await $fetch<GoogleBackupOAuthInstallationStatus>(
          "/api/admin/backup-providers/google-oauth",
        );
      } catch {
        // Installation OAuth configuration is intentionally administrator-only.
        googleOAuthInstallation.value = null;
      }
    } catch (e) {
      error.value = message(e, "Could not load backup management.");
    } finally {
      loading.value = false;
      schedule();
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = activeJobs.value.length
      ? setTimeout(() => void refresh(), 1500)
      : undefined;
  }
  function stop() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  async function saveSettings(value: BackupSettings) {
    settings.value = await $fetch("/api/backup-settings", {
      method: "PUT",
      body: value,
    });
    return settings.value;
  }
  async function startBackup(
    selection = settings.value.selection,
    workspaceIds = settings.value.workspaceIds,
    selectedPathsByWorkspace = settings.value.selectedPathsByWorkspace,
    providerId = settings.value.providerId,
  ) {
    const job = await $fetch<BackupJob>("/api/backups", {
      method: "POST",
      body: { selection, workspaceIds, providerId, selectedPathsByWorkspace },
    });
    jobs.value.unshift(job);
    schedule();
    return job;
  }
  async function retry(id: string) {
    const job = await $fetch<BackupJob>(
      `/api/backup-jobs/${encodeURIComponent(id)}/retry`,
      { method: "POST" },
    );
    jobs.value.unshift(job);
    schedule();
    return job;
  }
  async function cancel(id: string) {
    await $fetch(`/api/backup-jobs/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await refresh();
  }
  async function restore(
    id: string,
    target: "new" | "original",
    displayName = "",
    confirmOverwrite = false,
    lockPassword = "",
    workspaceIds?: string[],
    requestId?: string,
    imageResolutions?: Record<string, BackupImageResolution>,
  ) {
    return $fetch<{ jobId: string }>(
      `/api/backups/${encodeURIComponent(id)}/restore`,
      {
        method: "POST",
        body: {
          target,
          displayName,
          confirmOverwrite,
          ...(workspaceIds === undefined ? {} : { workspaceIds }),
          ...(requestId ? { requestId } : {}),
          ...(imageResolutions ? { imageResolutions } : {}),
          ...(target === "original" && lockPassword ? { lockPassword } : {}),
        },
      },
    );
  }
  async function remove(id: string) {
    await $fetch<unknown>(`/api/backups/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    artifacts.value = artifacts.value.filter((a) => a.id !== id);
  }
  async function linkGoogle() {
    const result = await $fetch<{ authorizationUrl: string }>(
      "/api/backup-providers/google/oauth/start",
      {
        method: "POST",
        body: { redirectUri: `${location.origin}/api/backup-providers/google/oauth/callback` },
      },
    );
    location.assign(result.authorizationUrl);
  }
  async function configureGoogleInstallation(input: {
    clientId: string;
    redirectUri: string;
    clientSecret: string;
  }) {
    googleOAuthInstallation.value = await $fetch<GoogleBackupOAuthInstallationStatus>(
      "/api/admin/backup-providers/google-oauth",
      { method: "PUT", body: input },
    );
    return googleOAuthInstallation.value;
  }
  async function disconnectGoogle() {
    await $fetch("/api/backup-providers/google", { method: "DELETE" });
    await refresh();
  }
  async function scanProvider(provider: string, requestId?: string) {
    const result = await $fetch<{ jobId: string; status: BackupJobStatus }>("/api/backups/remote", { method: "POST", body: { provider, ...(requestId ? { requestId } : {}) } });
    const job: BackupJob = { id: result.jobId, status: result.status, phase: "queued", progress: 0 };
    jobs.value.unshift(job); schedule(); return job;
  }
  async function inspectDiscovered(id: string) {
    return $fetch<DiscoveredBackup>(`/api/backups/remote/${encodeURIComponent(id)}`);
  }
  async function adoptDiscovered(id: string, requestId?: string) {
    const result = await $fetch<{ jobId: string; status: BackupJobStatus }>(`/api/backups/remote/${encodeURIComponent(id)}/adopt`, { method: "POST", body: requestId ? { requestId } : {} });
    const job: BackupJob = { id: result.jobId, status: result.status, phase: "queued", progress: 0 };
    jobs.value.unshift(job); schedule(); return job;
  }
  async function recoverImageDefinition(
    artifactId: string,
    workspaceId: string,
    requestId?: string,
  ) {
    const result = await $fetch<{ jobId: string; status: BackupJobStatus }>(
      `/api/backups/${encodeURIComponent(artifactId)}/image-recovery`,
      {
        method: "POST",
        body: { workspaceId, startBuild: true, ...(requestId ? { requestId } : {}) },
      },
    );
    const job: BackupJob = {
      id: result.jobId,
      status: result.status,
      phase: "queued",
      progress: 0,
      artifactId,
      workspaceId,
      operation: "dependency-resolution",
    };
    jobs.value.unshift(job);
    schedule();
    return job;
  }
  async function importRecoveryMaterial(material: string) {
    const result = await $fetch<BackupRecoveryKeyStatus>("/api/backups/recovery-key/import", { method: "POST", body: { kit: material } });
    await refresh(); return result;
  }
  async function revealRecoveryKey(reauth: { password?: string; useFreshSession?: boolean }) {
    return $fetch<{ keyMaterial: string; fingerprint: string }>("/api/backups/recovery-key/reveal", { method: "POST", body: reauth, cache: "no-store" as RequestCache });
  }
  async function exportRecoveryKit(
    reauth: { password?: string; useFreshSession?: boolean },
    fingerprint?: string,
  ) {
    return $fetch<unknown>("/api/backups/recovery-key/export", {
      method: "POST",
      body: { ...reauth, ...(fingerprint ? { fingerprint } : {}) },
      cache: "no-store" as RequestCache,
    });
  }
  return {
    artifacts,
    jobs,
    providers,
    recoveryKeys,
    discovered,
    googleOAuthInstallation,
    settings,
    activeJobs,
    loading,
    error,
    refresh,
    stop,
    saveSettings,
    startBackup,
    retry,
    cancel,
    restore,
    remove,
    linkGoogle,
    configureGoogleInstallation,
    disconnectGoogle,
    scanProvider,
    inspectDiscovered,
    adoptDiscovered,
    recoverImageDefinition,
    importRecoveryMaterial,
    revealRecoveryKey,
    exportRecoveryKit,
  };
}
