export type InstanceBackupProvider = "local" | "google-drive" | "fake";
export type InstanceBackupJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface InstanceBackupOptions {
  includeWorkers: boolean;
  includeAgentData: boolean;
  includeDockerVolumes: boolean;
  includeLocalBackups: boolean;
  includeLogs: boolean;
}

export interface InstanceBackupVolume {
  name: string;
  kind: string;
  ownerId?: string;
  workerId?: string;
  groupId?: string;
  size: number;
}

export interface InstanceBackupManifest {
  kind: "agentor-instance-backup";
  formatVersion: number;
  backupId: string;
  sourceInstallationId: string;
  createdAt: string;
  agentorVersion: string;
  storage: { mode: "directory" | "volume"; containerPrefix: string };
  options: InstanceBackupOptions;
  volumes: InstanceBackupVolume[];
  plugins: {
    platformDefinitionCount: number;
    ownerDefinitionCount: number;
    installationCount: number;
  };
  hostMounts: { configuredPaths: string[]; contentsIncluded: false };
  images: {
    definitions: number;
    immutableDigests: string[];
    layersIncluded: false;
  };
  excludedDataPaths: string[];
}

export interface InstanceBackupArtifact {
  id: string;
  provider: InstanceBackupProvider;
  providerObjectId: string;
  createdAt: string;
  size: number;
  sha256: string;
  keyFingerprint: string;
  sourceInstallationId: string;
  formatVersion: number;
  integrityStatus: "verified" | "failed" | "unavailable";
  provenance: "local" | "remote-adopted";
  manifest?: InstanceBackupManifest;
}

export interface RemoteInstanceBackup {
  id: string;
  provider: InstanceBackupProvider;
  providerObjectId: string;
  discoveredAt: string;
  lastSeenAt: string;
  state:
    | "discovered"
    | "missing-key"
    | "unsupported-format"
    | "too-large"
    | "incomplete"
    | "inaccessible"
    | "damaged"
    | "ready-to-adopt"
    | "adopted";
  keyFingerprint?: string;
  keyAvailable?: boolean;
  sourceInstallationId?: string;
  formatVersion?: number;
  blockedReason?: string;
  adoptedArtifactId?: string;
  restorable?: boolean;
  remote: {
    name?: string;
    createdAt?: string;
    size?: number;
    metadata?: Record<string, string>;
  };
}

export interface InstanceBackupJob {
  id: string;
  operation: "create" | "discovery" | "adoption" | "verify" | "restore";
  provider: InstanceBackupProvider;
  status: InstanceBackupJobStatus;
  phase: string;
  progress: number;
  bytesProcessed: number;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  artifactId?: string;
  remoteBackupId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface InstanceRestorePreflight {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  sourceInstallationId: string;
  sourceStorageMode: "directory" | "volume";
  destinationStorageMode: "directory" | "volume";
  sourceContainerPrefix: string;
  destinationContainerPrefix: string;
  volumeConflicts: string[];
  hostMountPaths: string[];
  imageDigestsNotEmbedded: string[];
}

interface InstanceBackupListResponse {
  jobs: InstanceBackupJob[];
  artifacts: InstanceBackupArtifact[];
  remoteBackups: RemoteInstanceBackup[];
  options: InstanceBackupOptions;
}

interface AcceptedOperation {
  accepted?: boolean;
  message?: string;
  jobId?: string;
  state?: InstanceBackupJobStatus;
  job?: InstanceBackupJob;
  alreadyAdopted?: boolean;
  artifactId?: string;
}

interface ProviderStatus {
  id: string;
  type: string;
  connected: boolean;
}

interface RecoveryKeyStatus {
  fingerprint: string;
  active: boolean;
  source: "generated" | "imported" | "legacy";
}

const publicError = (error: any, fallback: string) =>
  error?.data?.statusMessage ||
  error?.data?.message ||
  error?.statusMessage ||
  error?.message ||
  fallback;

export function useInstanceBackups() {
  const jobs = ref<InstanceBackupJob[]>([]);
  const artifacts = ref<InstanceBackupArtifact[]>([]);
  const remoteBackups = ref<RemoteInstanceBackup[]>([]);
  const providers = ref<ProviderStatus[]>([]);
  const recoveryKeys = ref<RecoveryKeyStatus[]>([]);
  const defaults = ref<InstanceBackupOptions>({
    includeWorkers: true,
    includeAgentData: true,
    includeDockerVolumes: true,
    includeLocalBackups: false,
    includeLogs: false,
  });
  const loading = ref(false);
  const error = ref("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  const activeJobs = computed(() =>
    jobs.value.filter(
      (job) => job.status === "queued" || job.status === "running",
    ),
  );

  function schedule() {
    if (timer) clearTimeout(timer);
    timer =
      !stopped && activeJobs.value.length
        ? setTimeout(() => void refresh(), 1_500)
        : undefined;
  }

  async function refresh() {
    stopped = false;
    loading.value = true;
    error.value = "";
    try {
      const [state, providerResult, keyResult] = await Promise.all([
        $fetch<InstanceBackupListResponse>("/api/admin/instance-backups"),
        $fetch<ProviderStatus[]>("/api/backup-providers"),
        $fetch<{ keys?: RecoveryKeyStatus[] } | RecoveryKeyStatus[]>(
          "/api/backups/recovery-key",
        ).catch(() => [] as RecoveryKeyStatus[]),
      ]);
      jobs.value = state.jobs;
      artifacts.value = state.artifacts;
      remoteBackups.value = state.remoteBackups;
      defaults.value = state.options;
      providers.value = providerResult;
      recoveryKeys.value = Array.isArray(keyResult)
        ? keyResult
        : keyResult.keys ?? [];
    } catch (caught) {
      error.value = publicError(
        caught,
        "Could not load instance disaster recovery.",
      );
    } finally {
      loading.value = false;
      schedule();
    }
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function remember(result: AcceptedOperation) {
    if (result.job) {
      const index = jobs.value.findIndex((job) => job.id === result.job!.id);
      if (index >= 0) jobs.value[index] = result.job;
      else jobs.value.unshift(result.job);
    }
    schedule();
    return result;
  }

  async function create(
    provider: InstanceBackupProvider,
    options: InstanceBackupOptions,
    requestId: string,
  ) {
    return remember(
      await $fetch<AcceptedOperation>("/api/admin/instance-backups", {
        method: "POST",
        body: { provider, options, requestId },
        headers: { "Idempotency-Key": requestId },
      }),
    );
  }

  async function discover(
    provider: InstanceBackupProvider,
    requestId: string,
  ) {
    return remember(
      await $fetch<AcceptedOperation>("/api/admin/instance-backups/remote", {
        method: "POST",
        body: { provider, requestId },
        headers: { "Idempotency-Key": requestId },
      }),
    );
  }

  async function inspectArtifact(id: string) {
    return $fetch<InstanceBackupArtifact>(
      `/api/admin/instance-backups/artifacts/${encodeURIComponent(id)}`,
    );
  }

  async function inspectRemote(id: string) {
    return $fetch<RemoteInstanceBackup>(
      `/api/admin/instance-backups/remote/${encodeURIComponent(id)}`,
    );
  }

  async function adopt(id: string, requestId: string) {
    const result = await $fetch<AcceptedOperation>(
      `/api/admin/instance-backups/remote/${encodeURIComponent(id)}/adopt`,
      {
        method: "POST",
        body: { requestId },
        headers: { "Idempotency-Key": requestId },
      },
    );
    return remember(result);
  }

  async function upload(file: File, requestId: string) {
    return remember(
      await $fetch<AcceptedOperation>("/api/admin/instance-backups/import", {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": "application/octet-stream",
          "Idempotency-Key": requestId,
        },
      }),
    );
  }

  async function jobLogs(id: string, after = 0, limit = 100) {
    return $fetch<{
      jobId: string;
      after: number;
      next: number;
      hasMore: boolean;
      logs: string[];
    }>(`/api/admin/instance-backups/jobs/${encodeURIComponent(id)}/logs`, {
      query: { after, limit },
    });
  }

  async function cancel(id: string) {
    await $fetch(
      `/api/admin/instance-backups/jobs/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    await refresh();
  }

  async function preflight(
    id: string,
    options: Pick<
      InstanceRestoreOptions,
      "restoreDockerVolumes" | "restoreHostMountPolicies"
    >,
  ) {
    return $fetch<InstanceRestorePreflight>(
      `/api/admin/instance-backups/artifacts/${encodeURIComponent(id)}/preflight`,
      { query: options },
    );
  }

  async function restore(
    id: string,
    options: InstanceRestoreOptions,
    requestId: string,
  ) {
    return remember(
      await $fetch<AcceptedOperation>(
        `/api/admin/instance-backups/artifacts/${encodeURIComponent(id)}/restore`,
        {
          method: "POST",
          body: { options, requestId },
          headers: { "Idempotency-Key": requestId },
        },
      ),
    );
  }

  return {
    jobs,
    artifacts,
    remoteBackups,
    providers,
    recoveryKeys,
    defaults,
    activeJobs,
    loading,
    error,
    refresh,
    stop,
    create,
    discover,
    inspectArtifact,
    inspectRemote,
    adopt,
    upload,
    jobLogs,
    cancel,
    preflight,
    restore,
  };
}

export interface InstanceRestoreOptions {
  restoreDockerVolumes: boolean;
  restoreHostMountPolicies: boolean;
  confirmReplaceControlPlane: true;
  confirmExternalDependencies: true;
}
