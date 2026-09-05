<script setup lang="ts">
import type {
  InstanceBackupArtifact,
  InstanceBackupJob,
  InstanceBackupOptions,
  InstanceBackupProvider,
  InstanceRestorePreflight,
  RemoteInstanceBackup,
} from "~/composables/useInstanceBackups";

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ openBackupManagement: [] }>();
const api = useInstanceBackups();

const provider = ref<InstanceBackupProvider>("local");
const options = reactive<InstanceBackupOptions>({
  includeWorkers: true,
  includeAgentData: true,
  includeDockerVolumes: true,
  includeLocalBackups: false,
  includeLogs: false,
});
const busy = ref("");
const actionError = ref("");
const notice = ref("");
const selectedArtifact = ref<InstanceBackupArtifact | null>(null);
const selectedRemote = ref<RemoteInstanceBackup | null>(null);
const selectedUpload = ref<File | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);
const logJobId = ref("");
const logsByJob = ref<
  Record<string, { lines: string[]; next: number; hasMore: boolean }>
>({});
const restoreDockerVolumes = ref(true);
const restoreHostMountPolicies = ref(false);
const confirmReplaceControlPlane = ref(false);
const confirmExternalDependencies = ref(false);
const restorePreflight = ref<InstanceRestorePreflight | null>(null);
const preflightLoading = ref(false);
let preflightVersion = 0;
const requestIdentities = new Map<string, string>();

const providerOptions = computed(() => {
  const items: Array<{
    value: InstanceBackupProvider;
    label: string;
    connected: boolean;
  }> = [{ value: "local", label: "Local encrypted artifact", connected: true }];
  const google = api.providers.value.find(
    (item) => item.type === "google-drive",
  );
  if (google)
    items.push({
      value: "google-drive",
      label: "Google Drive",
      connected: google.connected,
    });
  const fake = api.providers.value.find((item) => item.type === "fake");
  if (fake)
    items.push({ value: "fake", label: "Test provider", connected: fake.connected });
  return items;
});
const selectedProvider = computed(() =>
  providerOptions.value.find((item) => item.value === provider.value),
);
const canCreate = computed(
  () => selectedProvider.value?.connected !== false && !api.activeJobs.value.some(
    (job) => job.operation === "create",
  ),
);
const restoreCanStart = computed(
  () =>
    Boolean(selectedArtifact.value && restorePreflight.value?.ready) &&
    confirmReplaceControlPlane.value &&
    confirmExternalDependencies.value &&
    busy.value !== "restore",
);
const hasMatchingRecoveryKey = (fingerprint?: string) =>
  Boolean(
    fingerprint &&
      api.recoveryKeys.value.some((key) => key.fingerprint === fingerprint),
  );

watch(open, async (shown) => {
  if (!shown) {
    api.stop();
    selectedUpload.value = null;
    return;
  }
  await api.refresh();
  Object.assign(options, api.defaults.value);
  if (selectedProvider.value?.connected === false) provider.value = "local";
});
watch(
  () => options.includeWorkers,
  (included) => {
    if (!included) options.includeAgentData = false;
  },
);
watch([restoreDockerVolumes, restoreHostMountPolicies], () => {
  if (selectedArtifact.value) void loadPreflight();
});
onBeforeUnmount(api.stop);

function closeModal() {
  open.value = false;
}

function requestIdentity(key: string, prefix: string) {
  const existing = requestIdentities.get(key);
  if (existing) return existing;
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const identity = `${prefix}-${suffix}`;
  requestIdentities.set(key, identity);
  return identity;
}

function message(error: any, fallback: string) {
  return (
    error?.data?.statusMessage ||
    error?.data?.message ||
    error?.message ||
    fallback
  );
}

async function run<T>(key: string, action: () => Promise<T>) {
  busy.value = key;
  actionError.value = "";
  notice.value = "";
  try {
    return await action();
  } catch (error: any) {
    actionError.value = message(error, "Instance backup operation failed.");
    return undefined;
  } finally {
    busy.value = "";
  }
}

async function createBackup() {
  const key = `create:${provider.value}:${JSON.stringify({ ...options })}`;
  const result = await run("create", () =>
    api.create(
      provider.value,
      { ...options },
      requestIdentity(key, "ui-instance-create"),
    ),
  );
  if (result) {
    requestIdentities.delete(key);
    notice.value = `Backup accepted. Job ${result.jobId || result.job?.id || "created"} can be followed below.`;
  }
}

async function scanProvider() {
  const key = `discovery:${provider.value}`;
  const result = await run("discover", () =>
    api.discover(
      provider.value,
      requestIdentity(key, "ui-instance-discovery"),
    ),
  );
  if (result) {
    requestIdentities.delete(key);
    notice.value = `Provider scan accepted. Job ${result.jobId || result.job?.id || "created"} can be followed below.`;
  }
}

async function inspectArtifact(artifact: InstanceBackupArtifact) {
  const inspected = await run(`inspect-${artifact.id}`, () =>
    api.inspectArtifact(artifact.id),
  );
  if (!inspected) return;
  selectedArtifact.value = inspected;
  restoreDockerVolumes.value = Boolean(inspected.manifest?.volumes.length);
  restoreHostMountPolicies.value = false;
  confirmReplaceControlPlane.value = false;
  confirmExternalDependencies.value = false;
  await loadPreflight();
}

async function inspectRemote(remote: RemoteInstanceBackup) {
  const inspected = await run(`remote-inspect-${remote.id}`, () =>
    api.inspectRemote(remote.id),
  );
  if (inspected) selectedRemote.value = inspected;
}

async function adoptRemote(remote: RemoteInstanceBackup) {
  const key = `adopt:${remote.id}`;
  const result = await run(`adopt-${remote.id}`, () =>
    api.adopt(
      remote.id,
      requestIdentity(key, "ui-instance-adoption"),
    ),
  );
  if (!result) return;
  requestIdentities.delete(key);
  if (result.alreadyAdopted)
    notice.value = "This remote backup is already adopted locally.";
  else
    notice.value = `Adoption and verification accepted. Job ${result.jobId || result.job?.id || "created"} can be followed below.`;
}

function chooseUpload(event: Event) {
  selectedUpload.value =
    (event.target as HTMLInputElement).files?.item(0) ?? null;
}

async function uploadBackup() {
  if (!selectedUpload.value) return;
  const file = selectedUpload.value;
  const key = `upload:${file.name}:${file.size}:${file.lastModified}`;
  const result = await run("upload", () =>
    api.upload(
      file,
      requestIdentity(key, "ui-instance-upload"),
    ),
  );
  if (!result) return;
  requestIdentities.delete(key);
  selectedUpload.value = null;
  if (uploadInput.value) uploadInput.value.value = "";
  notice.value = `Upload received. Authentication and structural verification continue in job ${result.jobId || result.job?.id || "created"}.`;
}

async function toggleLogs(job: InstanceBackupJob) {
  if (logJobId.value === job.id) {
    logJobId.value = "";
    return;
  }
  const result = await run(`logs-${job.id}`, () => api.jobLogs(job.id));
  if (!result) return;
  logsByJob.value[job.id] = {
    lines: result.logs,
    next: result.next,
    hasMore: result.hasMore,
  };
  logJobId.value = job.id;
}

async function loadMoreLogs(job: InstanceBackupJob) {
  const current = logsByJob.value[job.id];
  if (!current?.hasMore) return;
  const result = await run(`logs-more-${job.id}`, () =>
    api.jobLogs(job.id, current.next),
  );
  if (!result) return;
  logsByJob.value[job.id] = {
    lines: [...current.lines, ...result.logs],
    next: result.next,
    hasMore: result.hasMore,
  };
}

async function loadPreflight() {
  if (!selectedArtifact.value) return;
  const version = ++preflightVersion;
  preflightLoading.value = true;
  actionError.value = "";
  try {
    const result = await api.preflight(selectedArtifact.value.id, {
      restoreDockerVolumes: restoreDockerVolumes.value,
      restoreHostMountPolicies: restoreHostMountPolicies.value,
    });
    if (version === preflightVersion) restorePreflight.value = result;
  } catch (error: any) {
    if (version === preflightVersion) {
      restorePreflight.value = null;
      actionError.value = message(error, "Restore preflight failed.");
    }
  } finally {
    if (version === preflightVersion) preflightLoading.value = false;
  }
}

async function startRestore() {
  if (!selectedArtifact.value || !restoreCanStart.value) return;
  const key = `restore:${selectedArtifact.value.id}:${restoreDockerVolumes.value}:${restoreHostMountPolicies.value}`;
  const result = await run("restore", () =>
    api.restore(
      selectedArtifact.value!.id,
      {
        restoreDockerVolumes: restoreDockerVolumes.value,
        restoreHostMountPolicies: restoreHostMountPolicies.value,
        confirmReplaceControlPlane: true,
        confirmExternalDependencies: true,
      },
      requestIdentity(key, "ui-instance-restore"),
    ),
  );
  if (!result) return;
  requestIdentities.delete(key);
  confirmReplaceControlPlane.value = false;
  confirmExternalDependencies.value = false;
  notice.value =
    `Restore accepted as job ${result.jobId || result.job?.id || "created"}. ` +
    "The orchestrator will stop and restart while the verified snapshot is applied.";
}

function downloadArtifact(artifact: InstanceBackupArtifact) {
  const link = document.createElement("a");
  link.href = `/api/admin/instance-backups/artifacts/${encodeURIComponent(artifact.id)}/download`;
  link.download = `agentor-instance-${artifact.id}.backup`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openRecoverySettings() {
  open.value = false;
  emit("openBackupManagement");
}

const date = (value?: string) =>
  value ? new Date(value).toLocaleString() : "—";
const size = (value?: number) =>
  value === undefined ? "—" : formatBytes(value);
const shortFingerprint = (value?: string) =>
  value ? `${value.slice(0, 18)}…${value.slice(-10)}` : "unknown";
const remoteDate = (remote: RemoteInstanceBackup) =>
  remote.remote.createdAt || remote.discoveredAt;
const statusClass = (status: string) => {
  if (status === "succeeded" || status === "ready-to-adopt" || status === "adopted")
    return "text-green-700 dark:text-green-300";
  if (status === "failed" || status === "damaged" || status === "inaccessible")
    return "text-red-700 dark:text-red-300";
  if (status === "cancelled") return "text-gray-500";
  return "text-amber-700 dark:text-amber-300";
};
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-7xl' }">
    <template #content>
      <div
        class="max-h-[92vh] space-y-5 overflow-y-auto p-6"
        data-testid="instance-backup-management"
      >
        <header class="flex items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-shield-alert" class="size-5 text-red-600" />
              <h2 class="text-lg font-semibold">Instance disaster recovery</h2>
              <UBadge color="error" size="xs">platform admin</UBadge>
            </div>
            <p class="mt-1 max-w-4xl text-xs text-gray-500">
              Encrypted, versioned snapshots of Agentor's control plane, plugin
              state, worker data and selected Agentor-owned volumes. Portable
              worker backups remain separate in Backup management.
            </p>
          </div>
          <UButton
            aria-label="Close instance disaster recovery"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            @click="closeModal"
          />
        </header>

        <p
          v-if="api.error.value || actionError"
          role="alert"
          class="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {{ api.error.value || actionError }}
        </p>
        <p
          v-if="notice"
          role="status"
          class="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-200"
        >
          {{ notice }}
        </p>

        <section class="rounded border p-4 space-y-4" data-testid="instance-backup-create">
          <div>
            <h3 class="font-medium">Create a recovery snapshot</h3>
            <p class="text-xs text-amber-700 dark:text-amber-300">
              Stop all workers and administrative workspaces first. Agentor
              rejects a live snapshot rather than claim consistency across the
              database, catalogs and volumes.
            </p>
          </div>
          <div class="grid gap-3 md:grid-cols-[minmax(16rem,1fr)_2fr]">
            <label class="text-sm">
              Destination
              <select
                v-model="provider"
                aria-label="Instance backup destination"
                class="mt-1 block w-full rounded border p-2"
              >
                <option
                  v-for="item in providerOptions"
                  :key="item.value"
                  :value="item.value"
                >
                  {{ item.label }} — {{ item.connected ? "available" : "not linked" }}
                </option>
              </select>
            </label>
            <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <label class="text-sm"><input v-model="options.includeWorkers" type="checkbox" /> Worker workspaces</label>
              <label class="text-sm" :class="{ 'opacity-50': !options.includeWorkers }"><input v-model="options.includeAgentData" type="checkbox" :disabled="!options.includeWorkers" /> Worker agent data</label>
              <label class="text-sm"><input v-model="options.includeDockerVolumes" type="checkbox" /> Agentor Docker volumes</label>
              <label class="text-sm"><input v-model="options.includeLocalBackups" type="checkbox" /> Existing local worker backups</label>
              <label class="text-sm"><input v-model="options.includeLogs" type="checkbox" /> Orchestrator logs</label>
            </div>
          </div>
          <p v-if="selectedProvider?.connected === false" class="text-xs text-amber-700 dark:text-amber-300">
            Google Drive uses the same encrypted backup provider connection as
            portable worker backups. Configure or link it first.
          </p>
          <p class="text-xs text-gray-500">
            Image definitions and plugin definitions/installations are included
            as control-plane data. Docker image layers, external host-mounted
            contents, <code>.env</code>, GitHub App keys, provider tokens outside
            Agentor and registry/DNS credentials are not portable dependencies.
          </p>
          <div class="flex flex-wrap gap-2">
            <UButton :loading="busy === 'create'" :disabled="!canCreate" @click="createBackup">
              Start instance backup
            </UButton>
            <UButton
              v-if="selectedProvider?.connected === false"
              color="neutral"
              variant="outline"
              @click="openRecoverySettings"
            >
              Open provider settings
            </UButton>
          </div>
        </section>

        <div class="grid gap-5 xl:grid-cols-2">
          <section class="rounded border p-4 space-y-3" data-testid="instance-backup-transfer">
            <div>
              <h3 class="font-medium">Transfer and provider discovery</h3>
              <p class="text-xs text-gray-500">
                Download a local recovery bundle, upload one from another
                installation, or discover instance bundles through the selected
                provider. Adoption always authenticates and verifies the bundle.
              </p>
            </div>
            <div class="flex flex-wrap items-end gap-2">
              <label class="min-w-0 flex-1 text-sm">
                Upload encrypted <code>.backup</code> bundle
                <input
                  ref="uploadInput"
                  type="file"
                  accept=".backup,application/octet-stream"
                  class="mt-1 block w-full text-xs"
                  @change="chooseUpload"
                />
              </label>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :disabled="!selectedUpload"
                :loading="busy === 'upload'"
                @click="uploadBackup"
              >
                Upload and verify
              </UButton>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2 rounded bg-gray-50 p-3 dark:bg-gray-900">
              <div class="text-xs">
                <b>Recovery keys:</b>
                {{ api.recoveryKeys.value.length ? `${api.recoveryKeys.value.length} available` : "none available" }}
                <p class="text-gray-500">
                  Only fingerprints are shown here; raw key reveal/export stays
                  behind the fresh-reauthentication workflow.
                </p>
              </div>
              <UButton size="xs" variant="outline" @click="openRecoverySettings">
                Manage provider &amp; recovery keys
              </UButton>
            </div>
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm">
                Scan <b>{{ selectedProvider?.label || provider }}</b>
              </span>
              <UButton
                size="xs"
                variant="outline"
                :disabled="selectedProvider?.connected === false"
                :loading="busy === 'discover'"
                @click="scanProvider"
              >
                Scan provider
              </UButton>
            </div>
            <p v-if="!api.remoteBackups.value.length" class="text-sm text-gray-500">
              No remotely discovered instance backups.
            </p>
            <article
              v-for="remote in api.remoteBackups.value"
              :key="remote.id"
              class="rounded border p-3 text-sm"
              :data-testid="`remote-instance-backup-${remote.id}`"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <b class="block truncate">{{ remote.remote.name || remote.id }}</b>
                  <p class="text-xs text-gray-500">
                    {{ date(remoteDate(remote)) }} · {{ size(remote.remote.size) }} ·
                    format {{ remote.formatVersion ?? "unknown" }}
                  </p>
                </div>
                <span class="text-xs font-medium" :class="statusClass(remote.state)">{{ remote.state }}</span>
              </div>
              <p class="mt-1 break-all text-xs text-gray-500">
                Required key: <code>{{ shortFingerprint(remote.keyFingerprint) }}</code>
                · {{ remote.keyAvailable || hasMatchingRecoveryKey(remote.keyFingerprint) ? "available" : "missing" }}
              </p>
              <p v-if="remote.blockedReason" class="mt-1 text-xs text-amber-700 dark:text-amber-300">
                {{ remote.blockedReason }}
              </p>
              <div class="mt-2 flex flex-wrap gap-2">
                <UButton size="xs" variant="outline" :loading="busy === `remote-inspect-${remote.id}`" @click="inspectRemote(remote)">Inspect</UButton>
                <UButton
                  v-if="remote.state !== 'adopted'"
                  size="xs"
                  :disabled="remote.state !== 'ready-to-adopt'"
                  :loading="busy === `adopt-${remote.id}`"
                  @click="adoptRemote(remote)"
                >Adopt and verify</UButton>
                <UButton
                  v-if="remote.state === 'missing-key'"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  @click="openRecoverySettings"
                >Import matching key</UButton>
              </div>
            </article>
            <div v-if="selectedRemote" class="rounded bg-gray-50 p-3 text-xs dark:bg-gray-900" data-testid="remote-instance-details">
              <b>Remote object details</b>
              <p>Source installation: <code>{{ selectedRemote.sourceInstallationId || "unknown" }}</code></p>
              <p>Provider object: <code class="break-all">{{ selectedRemote.providerObjectId }}</code></p>
              <p>Last seen: {{ date(selectedRemote.lastSeenAt) }}</p>
              <p>Locally restorable: {{ selectedRemote.restorable ? "yes" : "not until adoption and verification complete" }}</p>
            </div>
          </section>

          <section class="rounded border p-4 space-y-3" data-testid="instance-backup-jobs">
            <div class="flex items-center justify-between gap-2">
              <div>
                <h3 class="font-medium">Operations</h3>
                <p class="text-xs text-gray-500">Persisted status shared by the GUI, API and management MCP.</p>
              </div>
              <UButton size="xs" color="neutral" variant="ghost" :loading="api.loading.value" @click="api.refresh">Refresh</UButton>
            </div>
            <p v-if="!api.jobs.value.length" class="text-sm text-gray-500">No instance recovery jobs.</p>
            <article v-for="job in api.jobs.value" :key="job.id" class="rounded border p-3 text-sm" :data-testid="`instance-job-${job.id}`">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <b>{{ job.operation }}</b> · <span :class="statusClass(job.status)">{{ job.status }}</span>
                  <p class="text-xs text-gray-500">{{ job.phase }} · <code>{{ job.id }}</code></p>
                </div>
                <span class="text-xs">{{ job.progress }}% · {{ size(job.bytesProcessed) }}</span>
              </div>
              <progress class="mt-2 w-full" max="100" :value="job.progress" />
              <p v-if="job.error" class="mt-1 text-xs text-red-700 dark:text-red-300">
                <code v-if="job.errorCode">{{ job.errorCode }}</code> {{ job.error }}
              </p>
              <div class="mt-1 flex flex-wrap gap-1">
                <UButton size="xs" color="neutral" variant="ghost" :loading="busy === `logs-${job.id}`" @click="toggleLogs(job)">
                  {{ logJobId === job.id ? "Hide logs" : "Inspect logs" }}
                </UButton>
                <UButton
                  v-if="(job.status === 'queued' || job.status === 'running') && !(job.operation === 'restore' && job.phase === 'applying')"
                  size="xs"
                  color="error"
                  variant="ghost"
                  :loading="busy === `cancel-${job.id}`"
                  @click="run(`cancel-${job.id}`, () => api.cancel(job.id))"
                >Cancel</UButton>
              </div>
              <div v-if="logJobId === job.id" class="mt-2 rounded bg-gray-950 p-2 text-gray-100" data-testid="instance-job-logs">
                <pre class="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{{ logsByJob[job.id]?.lines.join('\n') || 'No log lines.' }}</pre>
                <UButton v-if="logsByJob[job.id]?.hasMore" size="xs" class="mt-2" color="neutral" variant="outline" :loading="busy === `logs-more-${job.id}`" @click="loadMoreLogs(job)">Load more</UButton>
              </div>
            </article>
          </section>
        </div>

        <section class="rounded border p-4 space-y-3" data-testid="instance-backup-artifacts">
          <div>
            <h3 class="font-medium">Verified recovery artifacts</h3>
            <p class="text-xs text-gray-500">
              Restore is available only after encryption authentication,
              integrity verification and structural manifest validation.
            </p>
          </div>
          <p v-if="!api.artifacts.value.length" class="text-sm text-gray-500">No adopted instance backups.</p>
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <article v-for="artifact in api.artifacts.value" :key="artifact.id" class="rounded border p-3 text-sm" :data-testid="`instance-artifact-${artifact.id}`">
              <div class="flex items-start justify-between gap-2">
                <b>{{ date(artifact.createdAt) }}</b>
                <span class="text-xs" :class="statusClass(artifact.integrityStatus === 'verified' ? 'succeeded' : 'failed')">{{ artifact.integrityStatus }}</span>
              </div>
              <p class="mt-1 text-xs text-gray-500">{{ size(artifact.size) }} · {{ artifact.provider }} · {{ artifact.provenance }}</p>
              <p class="break-all text-xs text-gray-500">Source: <code>{{ artifact.sourceInstallationId }}</code></p>
              <p class="break-all text-xs text-gray-500">Key: <code>{{ shortFingerprint(artifact.keyFingerprint) }}</code> · {{ hasMatchingRecoveryKey(artifact.keyFingerprint) ? "available" : "missing" }}</p>
              <div class="mt-2 flex flex-wrap gap-1">
                <UButton size="xs" :loading="busy === `inspect-${artifact.id}`" @click="inspectArtifact(artifact)">Inspect &amp; restore</UButton>
                <UButton size="xs" color="neutral" variant="outline" @click="downloadArtifact(artifact)">Download</UButton>
              </div>
            </article>
          </div>
        </section>

        <section v-if="selectedArtifact" class="rounded border-2 border-amber-400 p-4 space-y-4" data-testid="instance-restore-panel">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="font-medium">Inspect and restore instance</h3>
              <p class="break-all text-xs text-gray-500">Artifact <code>{{ selectedArtifact.id }}</code> from <code>{{ selectedArtifact.sourceInstallationId }}</code></p>
            </div>
            <UButton size="xs" color="neutral" variant="ghost" @click="selectedArtifact = null; restorePreflight = null">Close</UButton>
          </div>

          <div v-if="selectedArtifact.manifest" class="grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4" data-testid="instance-manifest-summary">
            <div class="rounded bg-gray-50 p-3 dark:bg-gray-900">
              <b>Format &amp; storage</b>
              <p>Format {{ selectedArtifact.manifest.formatVersion }} · Agentor {{ selectedArtifact.manifest.agentorVersion }}</p>
              <p>{{ selectedArtifact.manifest.storage.mode }} · prefix <code>{{ selectedArtifact.manifest.storage.containerPrefix }}</code></p>
            </div>
            <div class="rounded bg-gray-50 p-3 dark:bg-gray-900">
              <b>Plugins</b>
              <p>{{ selectedArtifact.manifest.plugins.platformDefinitionCount }} platform + {{ selectedArtifact.manifest.plugins.ownerDefinitionCount }} scoped definitions</p>
              <p>{{ selectedArtifact.manifest.plugins.installationCount }} desired installation records</p>
            </div>
            <div class="rounded bg-gray-50 p-3 dark:bg-gray-900">
              <b>Images</b>
              <p>{{ selectedArtifact.manifest.images.definitions }} definitions</p>
              <p>{{ selectedArtifact.manifest.images.immutableDigests.length }} immutable digests; layers not embedded</p>
            </div>
            <div class="rounded bg-gray-50 p-3 dark:bg-gray-900">
              <b>Volumes &amp; host paths</b>
              <p>{{ selectedArtifact.manifest.volumes.length }} volume archives</p>
              <p>{{ selectedArtifact.manifest.hostMounts.configuredPaths.length }} policies; host contents not embedded</p>
            </div>
          </div>

          <details v-if="selectedArtifact.manifest?.volumes.length" class="text-xs">
            <summary class="cursor-pointer font-medium">Contained Docker volumes</summary>
            <ul class="mt-1 list-disc pl-5">
              <li v-for="volume in selectedArtifact.manifest.volumes" :key="volume.name"><code>{{ volume.name }}</code> · {{ volume.kind }} · {{ size(volume.size) }}</li>
            </ul>
          </details>
          <details v-if="selectedArtifact.manifest?.images.immutableDigests.length" class="text-xs">
            <summary class="cursor-pointer font-medium">Image digests to pull or rebuild after restore</summary>
            <ul class="mt-1 list-disc break-all pl-5"><li v-for="digest in selectedArtifact.manifest.images.immutableDigests" :key="digest"><code>{{ digest }}</code></li></ul>
          </details>
          <details v-if="selectedArtifact.manifest?.hostMounts.configuredPaths.length" class="text-xs">
            <summary class="cursor-pointer font-medium">Captured host-mount policies (contents excluded)</summary>
            <ul class="mt-1 list-disc break-all pl-5"><li v-for="path in selectedArtifact.manifest.hostMounts.configuredPaths" :key="path"><code>{{ path }}</code></li></ul>
          </details>

          <fieldset class="rounded border p-3 space-y-2">
            <legend class="px-1 text-sm font-medium">Restore scope</legend>
            <label class="block text-sm"><input v-model="restoreDockerVolumes" type="checkbox" /> Restore contained Agentor-owned Docker volumes</label>
            <label class="block text-sm"><input v-model="restoreHostMountPolicies" type="checkbox" /> Restore host-mount allowlists and grants</label>
            <p v-if="restoreHostMountPolicies" class="text-xs font-medium text-amber-700 dark:text-amber-300">
              This restores only policy references. Copy and validate external
              host content separately; source paths are untrusted on this host.
            </p>
          </fieldset>

          <div class="rounded border p-3 text-sm" data-testid="instance-restore-preflight">
            <div class="flex items-center justify-between gap-2">
              <b>Restore preflight</b>
              <UButton size="xs" color="neutral" variant="ghost" :loading="preflightLoading" @click="loadPreflight">Run again</UButton>
            </div>
            <p v-if="preflightLoading" class="text-xs text-gray-500">Checking destination installation and volume conflicts…</p>
            <template v-else-if="restorePreflight">
              <p class="mt-1 text-xs" :class="restorePreflight.ready ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'">
                {{ restorePreflight.ready ? "Destination is ready for the selected restore scope." : "Restore is blocked until every issue below is resolved." }}
              </p>
              <ul v-if="restorePreflight.blockers.length" class="mt-2 list-disc space-y-1 pl-5 text-xs text-red-700 dark:text-red-300"><li v-for="item in restorePreflight.blockers" :key="item">{{ item }}</li></ul>
              <ul v-if="restorePreflight.warnings.length" class="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-300"><li v-for="item in restorePreflight.warnings" :key="item">{{ item }}</li></ul>
              <dl class="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                <div><dt class="font-medium">Storage mode</dt><dd>{{ restorePreflight.sourceStorageMode }} → {{ restorePreflight.destinationStorageMode }}</dd></div>
                <div><dt class="font-medium">Container prefix</dt><dd><code>{{ restorePreflight.sourceContainerPrefix }}</code> → <code>{{ restorePreflight.destinationContainerPrefix }}</code></dd></div>
              </dl>
            </template>
          </div>

          <fieldset class="rounded border-2 border-red-500 bg-red-50 p-3 space-y-2 dark:bg-red-950" data-testid="instance-restore-confirmations">
            <legend class="px-1 text-sm font-semibold text-red-700 dark:text-red-200">Destructive restore confirmations</legend>
            <label class="block text-sm"><input v-model="confirmReplaceControlPlane" type="checkbox" /> I understand that the current Agentor database and control-plane data will be replaced by this verified snapshot.</label>
            <label class="block text-sm"><input v-model="confirmExternalDependencies" type="checkbox" /> I have separately supplied or recorded required external configuration and credentials; image layers and host-mounted contents are not in this bundle.</label>
            <p class="text-xs text-red-700 dark:text-red-200">
              The destination must be an empty recovery installation. A helper
              stops Agentor, applies the staged snapshot and restarts the same
              orchestrator container. Success is reported only after apply.
            </p>
          </fieldset>
          <UButton color="error" :disabled="!restoreCanStart" :loading="busy === 'restore'" @click="startRestore">
            Apply verified snapshot and restart Agentor
          </UButton>
        </section>
      </div>
    </template>
  </UModal>
</template>
