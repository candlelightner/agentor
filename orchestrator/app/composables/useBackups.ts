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
  attempt?: number;
  workspaceIds?: string[];
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
    googleOAuthInstallation = ref<GoogleBackupOAuthInstallationStatus | null>(null);
  const settings = ref<BackupSettings>({
    providerId: "local",
    enabled: false,
    selection: "all",
    workspaceIds: [],
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
  ) {
    const job = await $fetch<BackupJob>("/api/backups", {
      method: "POST",
      body: { selection, workspaceIds, providerId: settings.value.providerId },
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
  return {
    artifacts,
    jobs,
    providers,
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
  };
}
