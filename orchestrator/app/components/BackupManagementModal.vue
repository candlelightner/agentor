<script setup lang="ts">
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ changed: []; restored: [jobId: string] }>();
const api = useBackups(),
  { isAdmin } = useAuth(),
  draft = reactive({
    providerId: "local",
    enabled: false,
    selection: "all" as "all" | "selected",
    workspaceIds: [] as string[],
    selectedPathsByWorkspace: {} as Record<string, string[]>,
    intervalMinutes: 1440,
    retentionCount: 7,
  });
const busy = ref(""),
  restoreItem = ref<any>(null),
  restoreTarget = ref<"new" | "original">("new"),
  restoreWorkspaceIds = ref<string[]>([]),
  workspaceNames = ref<Record<string, string>>({}),
  workspaceOptions = ref<WorkspaceOption[]>([]),
  restoreName = ref(""),
  restoreLockPassword = ref(""),
  restoreRequestId = ref(""),
  confirmOverwrite = ref(false),
  pickerWorkspaceId = ref(""),
  recoveryMaterial = ref(""),
  revealedRecoveryKey = ref(""),
  reauthPassword = ref(""),
  restoreImageModes = ref<
    Record<string, "exact" | "replacement" | "workspace-only">
  >({}),
  restoreReplacementImages = ref<
    Record<string, { imageDefinitionId: string; imageVersion: string }>
  >({}),
  selectedDiscovered = ref<any>(null),
  actionError = ref(""),
  savedNotice = ref("");
const googleDraft = reactive({ clientId: "", redirectUri: "", clientSecret: "" });
let recoverySecretTimer: ReturnType<typeof setTimeout> | undefined;
function clonePathSelections(value: Record<string, string[]> | undefined) {
  return JSON.parse(JSON.stringify(value || {})) as Record<string, string[]>;
}
watch(open, async (shown) => {
  if (shown) {
    await api.refresh();
    await refreshWorkspaceNames();
    Object.assign(draft, {
      ...api.settings.value,
      workspaceIds: [...api.settings.value.workspaceIds],
      selectedPathsByWorkspace: clonePathSelections(api.settings.value.selectedPathsByWorkspace),
    });
    savedNotice.value = "";
  } else {
    api.stop();
    restoreLockPassword.value = "";
    clearRecoverySecret();
  }
});
onBeforeUnmount(() => { api.stop(); clearRecoverySecret(); });
type WorkspaceOption = {
  id: string;
  label: string;
  displayName: string;
  kind: string;
  status: string;
};
const workspaceIds = () => draft.workspaceIds;
const selectableWorkspaceOptions = computed(() => {
  const known = new Set(workspaceOptions.value.map((option) => option.id));
  return [
    ...workspaceOptions.value,
    ...draft.workspaceIds
      .filter((id) => !known.has(id))
      .map((id) => ({
        id,
        label: `${workspaceNames.value[id] || id} — unavailable`,
        displayName: workspaceNames.value[id] || id,
        kind: "Unavailable workspace",
        status: "unavailable",
      })),
  ];
});
async function run(key: string, fn: () => Promise<any>) {
  busy.value = key;
  actionError.value = "";
  try {
    return await fn();
  } catch (e: any) {
    actionError.value =
      e?.data?.statusMessage || e?.message || "Backup operation failed.";
  } finally {
    busy.value = "";
  }
}
function settingsPayload() {
  return {
    ...api.settings.value,
    providerId: draft.providerId,
    enabled: draft.enabled,
    selection: draft.selection,
    intervalMinutes: draft.intervalMinutes,
    retentionCount: draft.retentionCount,
    workspaceIds: workspaceIds(),
    selectedPathsByWorkspace: draft.selectedPathsByWorkspace,
    nextRunAt: api.settings.value.nextRunAt,
  };
}
function settingsChanged() {
  const current = api.settings.value;
  const next = settingsPayload();
  return (
    current.providerId !== next.providerId ||
    current.enabled !== next.enabled ||
    current.selection !== next.selection ||
    current.intervalMinutes !== next.intervalMinutes ||
    current.retentionCount !== next.retentionCount ||
    JSON.stringify(current.workspaceIds) !== JSON.stringify(next.workspaceIds) ||
    JSON.stringify(current.selectedPathsByWorkspace) !==
      JSON.stringify(next.selectedPathsByWorkspace)
  );
}
function confirmRemovedPathPersistence() {
  const removed = removedAdditionalPaths();
  if (
    removed.length &&
    !window.confirm(
      `Stop rebuild persistence for ${removed.length} selected path${removed.length === 1 ? "" : "s"}? ` +
        "No persisted data is deleted now: the existing volume is retained until the worker is deleted. " +
        "After the next rebuild, this path uses temporary container storage; changes made there are lost by another rebuild unless you reselect or back them up first. " +
        "If you reselect the path before rebuilding again, current files are merged into the retained volume: current same-named files overwrite their older persisted versions, while other old and new files are kept.",
    )
  )
    return false;
  return true;
}
async function save() {
  if (!confirmRemovedPathPersistence()) return;
  await run("save", async () => {
    const persisted = await api.saveSettings(settingsPayload());
    // Rehydrate the draft from the server's canonical response. This makes
    // normalization or a rejected path visible immediately instead of
    // leaving an optimistic selection that disappears on the next refresh.
    Object.assign(draft, {
      ...persisted,
      workspaceIds: [...persisted.workspaceIds],
      selectedPathsByWorkspace: clonePathSelections(persisted.selectedPathsByWorkspace),
    });
    savedNotice.value = `Saved at ${new Date().toLocaleTimeString()}`;
    emit("changed");
  });
}
async function backup() {
  if (settingsChanged() && !confirmRemovedPathPersistence()) return;
  await run("backup", async () => {
    const effective = settingsChanged()
      ? await api.saveSettings(settingsPayload())
      : api.settings.value;
    const selectedPaths = effective.selection === 'all'
      ? effective.selectedPathsByWorkspace
      : Object.fromEntries(
          Object.entries(effective.selectedPathsByWorkspace).filter(([id]) =>
            effective.workspaceIds.includes(id),
          ),
        );
    await api.startBackup(
      effective.selection,
      effective.workspaceIds,
      selectedPaths,
      effective.providerId,
    );
    emit("changed");
  });
}
function openPathPicker(workerId: string) {
  pickerWorkspaceId.value = workerId;
  if (!(workerId in draft.selectedPathsByWorkspace))
    draft.selectedPathsByWorkspace[workerId] = ['/workspace', '/home/agent/.agent-data'];
}
const defaultBackupPaths = new Set(['/workspace', '/home/agent/.agent-data']);
function removedAdditionalPaths() {
  const removed: string[] = [];
  for (const [workerId, previous] of Object.entries(
    api.settings.value.selectedPathsByWorkspace || {},
  )) {
    const current = new Set(draft.selectedPathsByWorkspace[workerId] || []);
    for (const path of previous)
      if (!defaultBackupPaths.has(path) && !current.has(path))
        removed.push(`${workerId}:${path}`);
  }
  return removed;
}
function selectedPathCount(workerId: string) {
  return draft.selectedPathsByWorkspace[workerId]?.length ?? defaultBackupPaths.size;
}
function additionalPathCount(workerId: string) {
  return (draft.selectedPathsByWorkspace[workerId] || []).filter(
    path => !defaultBackupPaths.has(path),
  ).length;
}
async function configureGoogle() {
  await run("google-config", async () => {
    await api.configureGoogleInstallation({ ...googleDraft });
    googleDraft.clientSecret = "";
  });
}
function clearRecoverySecret() {
  if (recoverySecretTimer) clearTimeout(recoverySecretTimer);
  recoverySecretTimer = undefined;
  revealedRecoveryKey.value = "";
  reauthPassword.value = "";
  recoveryMaterial.value = "";
}
function requestIdentity(prefix: string) {
  // A new human-initiated operation needs a new identity. The identity is
  // retained by the server for a transport retry, but must not turn every
  // later click on “scan” into a stale result from the first click.
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}
async function importRecoveryKey() {
  if (!recoveryMaterial.value.trim()) return;
  await run("recovery-import", async () => {
    try { await api.importRecoveryMaterial(recoveryMaterial.value); }
    finally { recoveryMaterial.value = ""; }
  });
}
function reauthBody() { return reauthPassword.value ? { password: reauthPassword.value } : { useFreshSession: true }; }
async function revealRecoveryKey() {
  await run("recovery-reveal", async () => {
    const reauth = reauthBody();
    clearRecoverySecret();
    const result = await api.revealRecoveryKey(reauth);
    revealedRecoveryKey.value = result.keyMaterial;
    reauthPassword.value = "";
    recoverySecretTimer = setTimeout(clearRecoverySecret, 60_000);
  });
}
async function copyRecoveryKey() {
  if (!revealedRecoveryKey.value) return;
  try { await navigator.clipboard.writeText(revealedRecoveryKey.value); savedNotice.value = "Recovery key copied. Clear your clipboard when finished."; }
  catch { clearRecoverySecret(); actionError.value = "Could not copy the recovery key."; }
}
async function downloadRecoveryKit(fingerprint?: string) {
  await run("recovery-export", async () => {
    try {
      const result: any = await api.exportRecoveryKit(reauthBody(), fingerprint);
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `agentor-recovery-${String(result.fingerprint || "kit").slice(-12)}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally { clearRecoverySecret(); }
  });
}
async function scanRemoteBackups() {
  const provider = draft.providerId === "google" ? "google-drive" : draft.providerId;
  await run("remote-scan", () => api.scanProvider(provider, requestIdentity("ui-discovery")));
}
async function inspectDiscovered(item: any) {
  selectedDiscovered.value = await run(`remote-inspect-${item.id}`, () => api.inspectDiscovered(item.id));
}
async function adoptDiscovered(item: any) {
  await run(`remote-adopt-${item.id}`, () => api.adoptDiscovered(item.id, requestIdentity("ui-adopt")));
}
async function recoverImageDefinition(summary: BackupWorkspaceReconstruction) {
  if (!restoreItem.value || !imageRecoveryAvailable(summary)) return;
  await run(`image-recovery-${summary.workspaceId}`, () =>
    api.recoverImageDefinition(
      restoreItem.value.id,
      summary.workspaceId,
      requestIdentity("ui-image-recovery"),
    ),
  );
}
async function restore() {
  if (!restoreItem.value || !restoreWorkspaceIds.value.length) return;
  const imageResolutions: Record<string, any> = {};
  for (const summary of selectedCustomImageSummaries.value) {
    const mode = restoreImageModes.value[summary.workspaceId] || "exact";
    if (mode === "workspace-only") {
      imageResolutions[summary.workspaceId] = {
        mode: "workspace-only",
        acknowledged: true,
      };
    } else if (mode === "replacement") {
      const replacement = restoreReplacementImages.value[summary.workspaceId];
      if (
        !replacement?.imageDefinitionId.trim() ||
        !replacement.imageVersion.trim()
      ) {
        actionError.value =
          "Enter both a replacement image definition ID and version.";
        return;
      }
      imageResolutions[summary.workspaceId] = {
        mode: "replacement",
        imageDefinitionId: replacement.imageDefinitionId.trim(),
        imageVersion: replacement.imageVersion.trim(),
      };
    } else imageResolutions[summary.workspaceId] = { mode: "exact" };
  }
  const result = await run("restore", () =>
    api.restore(
      restoreItem.value.id,
      restoreTarget.value,
      restoreName.value,
      confirmOverwrite.value,
      restoreLockPassword.value,
      restoreWorkspaceIds.value,
      restoreRequestId.value || (restoreRequestId.value = requestIdentity("ui-restore")),
      Object.keys(imageResolutions).length ? imageResolutions : undefined,
    ),
  );
  if (result) {
    emit("restored", result.jobId);
    cancelRestore();
  }
}
const fmt = (n?: number) => (n == null ? "—" : formatBytes(n)),
  date = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");
function close() {
  open.value = false;
}
function selectRestore(item: any) {
  restoreItem.value = item;
  restoreTarget.value = "new";
  restoreWorkspaceIds.value = restoreMembers(item).map((member) => member.id);
  restoreName.value = "";
  confirmOverwrite.value = false;
  restoreLockPassword.value = "";
  restoreRequestId.value = requestIdentity("ui-restore");
  restoreImageModes.value = Object.fromEntries(
    (item.reconstruction || [])
      .filter(
        (summary: any) =>
          summary.image?.kind === "custom" ||
          summary.image?.kind === "unmanaged",
      )
      .map((summary: any) => [
        summary.workspaceId,
        (item.dependencies || []).some(
          (dependency: any) =>
            dependency.kind === "image" &&
            dependency.workspaceId === summary.workspaceId &&
            dependency.status === "replacement-required",
        )
          ? "replacement"
          : "exact",
      ]),
  );
  restoreReplacementImages.value = Object.fromEntries(
    (item.reconstruction || [])
      .filter(
        (summary: any) =>
          summary.image?.kind === "custom" ||
          summary.image?.kind === "unmanaged",
      )
      .map((summary: any) => [
        summary.workspaceId,
        { imageDefinitionId: "", imageVersion: "" },
      ]),
  );
}
function cancelRestore() {
  restoreItem.value = null;
  restoreWorkspaceIds.value = [];
  restoreName.value = "";
  confirmOverwrite.value = false;
  restoreLockPassword.value = "";
  restoreRequestId.value = "";
  restoreImageModes.value = {};
  restoreReplacementImages.value = {};
}
const selectedCustomImageSummaries = computed(() =>
  ((restoreItem.value?.reconstruction || []) as BackupWorkspaceReconstruction[])
    .filter(
      (summary) =>
        (summary.image.kind === "custom" || summary.image.kind === "unmanaged") &&
        restoreWorkspaceIds.value.includes(summary.workspaceId),
    ),
);
function imageDependency(workspaceId: string) {
  return (restoreItem.value?.dependencies || []).find(
    (dependency: any) =>
      dependency.kind === "image" &&
      dependency.workspaceId === workspaceId,
  );
}
function exactImageAvailable(workspaceId: string) {
  return imageDependency(workspaceId)?.status !== "replacement-required";
}
function imageRecoveryAvailable(summary: BackupWorkspaceReconstruction) {
  // Do not infer this from IDs or a dependency message. The backup bundle is
  // untrusted and its recipe is deliberately not sent to the browser; only a
  // server-derived capability bit enables recovery.
  return summary.image.kind === "custom" && summary.image.recoveryAvailable === true;
}
function imageRecoveryJob(workspaceId: string) {
  return api.jobs.value.find(
    (job) =>
      job.artifactId === restoreItem.value?.id &&
      job.workspaceId === workspaceId &&
      job.operation === "dependency-resolution",
  );
}
function imageBuildId(job: BackupJob | undefined) {
  return job?.recoveredImageBuildId ?? job?.imageBuildId;
}
const restoreCanStart = computed(() => {
  if (!restoreWorkspaceIds.value.length) return false;
  if (restoreTarget.value === "original") return confirmOverwrite.value;
  return selectedCustomImageSummaries.value.every((summary) => {
    const mode = restoreImageModes.value[summary.workspaceId] || "exact";
    if (mode === "exact") return exactImageAvailable(summary.workspaceId);
    if (mode === "workspace-only") return true;
    const replacement = restoreReplacementImages.value[summary.workspaceId];
    return Boolean(
      replacement?.imageDefinitionId.trim() && replacement.imageVersion.trim(),
    );
  });
});
function setReplacementField(
  workspaceId: string,
  field: "imageDefinitionId" | "imageVersion",
  value: string,
) {
  const current = restoreReplacementImages.value[workspaceId] ?? {
    imageDefinitionId: "",
    imageVersion: "",
  };
  restoreReplacementImages.value[workspaceId] = {
    ...current,
    [field]: value,
  };
}
function restoreMembers(item = restoreItem.value): Array<{ id: string; displayName?: string }> {
  if (!item) return [];
  if (Array.isArray(item.workspaceMembers) && item.workspaceMembers.length)
    return item.workspaceMembers;
  const workspaceIds: string[] = Array.isArray(item.workspaceIds)
    ? item.workspaceIds.filter((id: unknown): id is string => typeof id === "string")
    : typeof item.workspaceId === "string"
      ? [item.workspaceId]
      : [];
  return [...new Set(workspaceIds)]
    .filter(Boolean)
    .map((id: string) => ({ id, displayName: workspaceNames.value[id] }));
}
async function refreshWorkspaceNames() {
  try {
    const workers = await $fetch<Array<{
      id: string;
      userId: string;
      displayName?: string;
      status?: string;
      administrativeKind?: "platform" | "group";
    }>>("/api/containers");
    workspaceOptions.value = workers
      .map((worker) => {
        const displayName = worker.displayName || worker.id;
        const kind =
          worker.administrativeKind === "platform"
            ? "Global admin"
            : worker.administrativeKind === "group"
              ? "Group admin"
              : "Worker";
        const status = worker.status || "unknown";
        return {
          id: worker.id,
          displayName,
          kind,
          status,
          label: `${displayName} — ${kind} · ${status}`,
        };
      })
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, {
          sensitivity: "base",
        }),
      );
    workspaceNames.value = Object.fromEntries(
      workspaceOptions.value.map((worker) => [worker.id, worker.displayName]),
    );
  } catch {
    // Artifact IDs remain usable when a source worker has since been removed.
    workspaceOptions.value = [];
    workspaceNames.value = {};
  }
}
function memberLabel(member: { id: string; displayName?: string }) {
  return member.displayName && member.displayName !== member.id
    ? `${member.displayName} (${member.id})`
    : member.id;
}
function resetRestoreSelection() {
  const members = restoreMembers();
  restoreWorkspaceIds.value =
    restoreTarget.value === "new"
      ? members.map((member) => member.id)
      : members.slice(0, 1).map((member) => member.id);
}
function selectOriginalWorkspace(id: string) {
  restoreWorkspaceIds.value = [id];
}
watch(restoreTarget, (target) => {
  if (!restoreItem.value) return;
  const members = restoreMembers();
  if (target === "original" && restoreWorkspaceIds.value.length !== 1)
    restoreWorkspaceIds.value = members.slice(0, 1).map((member) => member.id);
  if (target === "new" && !restoreWorkspaceIds.value.length) resetRestoreSelection();
});
</script>
<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-6xl' }"
    ><template #content
      ><div
        class="p-6 space-y-5 max-h-[90vh] overflow-y-auto"
        data-testid="backup-management"
      >
        <header class="flex justify-between">
          <div>
            <h2 class="text-lg font-semibold">Backup management</h2>
            <p class="text-xs text-gray-500">
              Encrypted, integrity-verified workspace backups. Credentials and
              worker secrets are excluded.
            </p>
          </div>
          <UButton
            aria-label="Close"
            variant="ghost"
            color="neutral"
            icon="i-lucide-x"
            @click="close"
          />
        </header>
        <p
          v-if="api.error.value || actionError"
          role="alert"
          class="text-sm text-red-600"
        >
          {{ api.error.value || actionError }}
        </p>
        <section class="border rounded-md p-4 space-y-3">
          <div class="flex justify-between">
            <h3 class="font-medium">Provider and schedule</h3>
            <span data-testid="next-backup"
              >Next run: {{ date(api.settings.value.nextRunAt) }}</span
            >
          </div>
          <div class="grid gap-1 text-xs text-gray-500 md:grid-cols-3">
            <span
              >Last attempt: {{ date(api.settings.value.lastAttemptAt) }}</span
            >
            <span
              >Last success: {{ date(api.settings.value.lastSuccessAt) }}</span
            >
            <span
              :class="
                api.settings.value.consecutiveFailures ? 'text-red-600' : ''
              "
              >Consecutive failures:
              {{ api.settings.value.consecutiveFailures || 0 }}</span
            >
          </div>
          <p v-if="api.settings.value.lastError" class="text-xs text-red-600">
            {{ api.settings.value.lastError }}
          </p>
          <div class="grid md:grid-cols-3 gap-3">
            <label
              >Provider<select
                v-model="draft.providerId"
                class="block w-full border rounded p-2"
              >
                <option
                  v-for="p in api.providers.value"
                  :key="p.id"
                  :value="p.type"
                >
                  {{ p.type }} — {{ p.connected ? "linked" : "not linked" }}
                </option>
              </select></label
            ><label
              >Interval (minutes)<input
                v-model.number="draft.intervalMinutes"
                type="number"
                min="1"
                class="block w-full border rounded p-2" /></label
            ><label
              >Retention count<input
                v-model.number="draft.retentionCount"
                type="number"
                min="1"
                class="block w-full border rounded p-2"
            /></label>
          </div>
          <div class="flex flex-wrap gap-4 items-center">
            <label
              ><input v-model="draft.enabled" type="checkbox" /> Enable
              scheduled backups</label
            ><label
              ><input v-model="draft.selection" type="radio" value="all" /> All
              workspaces</label
            ><label
              ><input v-model="draft.selection" type="radio" value="selected" />
              Selected workspaces</label
            ><UButton
              v-if="
                api.providers.value.some(
                  (p) => p.type === 'google-drive' && !p.connected,
                )
              "
              variant="outline"
              @click="run('link', api.linkGoogle)"
              >Link Google Drive</UButton
            >
            <UButton
              v-if="
                api.providers.value.some(
                  (p) => p.type === 'google-drive' && p.connected,
                )
              "
              color="error"
              variant="outline"
              @click="run('unlink', api.disconnectGoogle)"
              >Disconnect Google Drive</UButton
            >
          </div>
          <section
            v-if="isAdmin && api.providers.value.some((p) => p.type === 'google-drive')"
            class="rounded border bg-gray-50 p-3 space-y-2 dark:bg-gray-900"
            data-testid="google-oauth-installation"
          >
            <div>
              <h4 class="text-sm font-medium">Google Drive OAuth installation</h4>
              <p class="text-xs text-gray-500">
                {{ api.googleOAuthInstallation.value?.configured
                  ? `Configured from ${api.googleOAuthInstallation.value.source}. Client secret is write-only.`
                  : "Configure this installation before linking Google Drive. The client secret is write-only and encrypted at rest." }}
              </p>
            </div>
            <div class="grid gap-2 md:grid-cols-3">
              <label class="text-xs">Client ID<input v-model="googleDraft.clientId" class="block w-full border rounded p-2" autocomplete="off" /></label>
              <label class="text-xs">Redirect URI<input v-model="googleDraft.redirectUri" class="block w-full border rounded p-2" placeholder="https://…/api/backup-providers/google/oauth/callback" /></label>
              <label class="text-xs">Client secret<input v-model="googleDraft.clientSecret" type="password" class="block w-full border rounded p-2" autocomplete="new-password" /></label>
            </div>
            <UButton size="xs" :loading="busy === 'google-config'" @click="configureGoogle">Save Google OAuth configuration</UButton>
          </section>
          <label v-if="draft.selection === 'selected'" class="block space-y-1">
            <span>Workspaces</span>
            <UInputMenu
              v-model="draft.workspaceIds"
              :items="selectableWorkspaceOptions"
              multiple
              value-key="id"
              label-key="label"
              :filter-fields="['displayName', 'id', 'kind', 'status']"
              placeholder="Search workers and administrative workspaces…"
              class="w-full"
              aria-label="Workspaces"
              data-testid="backup-workspace-selector"
            >
              <template #item-label="{ item }">
                <span class="flex min-w-0 flex-col">
                  <span class="truncate font-medium">{{ item.displayName }}</span>
                  <span class="truncate text-xs text-gray-500">
                    {{ item.kind }} · {{ item.status }} · {{ item.id }}
                  </span>
                </span>
              </template>
            </UInputMenu>
          </label>
          <section v-if="workspaceIds().length" class="rounded border p-3 space-y-2" data-testid="backup-path-settings">
            <h4 class="text-sm font-medium">Backup paths</h4>
            <p class="text-xs text-gray-500">The existing portable defaults (<code>/workspace</code> and credential-filtered agent data) start selected but may be changed. Any readable file or directory may be selected explicitly, including sensitive paths. Saving prepares additional directories as local rebuild-persistent volumes; files and <code>/</code> remain backup-only. Deselected volumes are retained until worker deletion and merged with current files if selected again.</p>
            <div v-for="id in workspaceIds()" :key="id" class="flex items-center gap-2 text-sm">
              <span class="min-w-0">
                <span class="block truncate font-medium">{{ workspaceNames[id] || id }}</span>
                <code class="block truncate text-xs text-gray-500">{{ id }}</code>
              </span>
              <span class="text-xs text-gray-500">{{ selectedPathCount(id) }} selected · {{ additionalPathCount(id) }} additional</span>
              <UButton size="xs" variant="outline" @click="openPathPicker(id)">Choose paths</UButton>
            </div>
          </section>
          <div class="flex gap-2">
            <span v-if="settingsChanged()" class="self-center text-xs text-amber-600" role="status">Unsaved changes</span>
            <span v-else-if="savedNotice" class="self-center text-xs text-green-600" role="status">{{ savedNotice }}</span>
            <UButton :loading="busy === 'save'" @click="save"
              >Save schedule</UButton
            ><UButton
              color="neutral"
              variant="outline"
              :loading="busy === 'backup'"
              @click="backup"
              >Back up now</UButton
            >
          </div>
        </section>
        <BackupPathPickerModal v-if="pickerWorkspaceId" :open="Boolean(pickerWorkspaceId)" v-model:paths="draft.selectedPathsByWorkspace[pickerWorkspaceId]" :worker-id="pickerWorkspaceId" @update:open="shown => { if (!shown) pickerWorkspaceId = '' }" />
        <section class="border rounded-md p-4 space-y-3" data-testid="backup-recovery-keys">
          <div>
            <h3 class="font-medium">Recovery key</h3>
            <p class="text-xs text-amber-700 dark:text-amber-300">Anyone who has this key and a backup artifact can decrypt that backup. Keep the exported kit offline and do not share it in chat or source control.</p>
          </div>
          <p v-if="!api.recoveryKeys.value.length" class="text-sm text-gray-500">No owner recovery key has been generated yet. It is created when a new-format backup is made.</p>
          <ul v-else class="text-xs space-y-1" data-testid="recovery-key-fingerprints">
            <li v-for="key in api.recoveryKeys.value" :key="key.fingerprint" class="flex flex-wrap items-center gap-2"><code>{{ key.fingerprint }}</code> · {{ key.active ? "current" : key.source }}<UButton size="xs" color="neutral" variant="ghost" :loading="busy === 'recovery-export'" @click="downloadRecoveryKit(key.fingerprint)">Export this key</UButton></li>
          </ul>
          <label class="block text-sm">Import recovery key or kit<textarea v-model="recoveryMaterial" autocomplete="off" class="mt-1 block w-full border rounded p-2 font-mono text-xs" rows="3" placeholder="Paste an Agentor recovery kit or recovery material"></textarea></label>
          <UButton size="xs" variant="outline" :disabled="!recoveryMaterial.trim()" :loading="busy === 'recovery-import'" @click="importRecoveryKey">Import recovery material</UButton>
          <div class="rounded border p-3 space-y-2">
            <label class="block text-sm">Current password (fresh server-side reauthentication)<input v-model="reauthPassword" type="password" autocomplete="current-password" class="mt-1 block w-full border rounded p-2" /></label>
            <p class="text-xs text-gray-500">Passkey-only accounts: sign in again, then use these actions within five minutes without entering a password.</p>
            <div class="flex flex-wrap gap-2"><UButton size="xs" :loading="busy === 'recovery-reveal'" @click="revealRecoveryKey">Reveal recovery key</UButton><UButton size="xs" variant="outline" :loading="busy === 'recovery-export'" @click="downloadRecoveryKit()">Download recovery kit</UButton><UButton v-if="revealedRecoveryKey" size="xs" variant="outline" @click="copyRecoveryKey">Copy revealed key</UButton><UButton v-if="revealedRecoveryKey" size="xs" color="neutral" variant="ghost" @click="clearRecoverySecret">Hide key</UButton></div>
            <output v-if="revealedRecoveryKey" class="block break-all rounded bg-amber-50 p-2 font-mono text-xs dark:bg-amber-950" data-testid="revealed-recovery-key">{{ revealedRecoveryKey }}</output>
          </div>
        </section>
        <section class="border rounded-md p-4 space-y-3" data-testid="remote-backup-discovery">
          <div class="flex items-center justify-between gap-2"><div><h3 class="font-medium">Remote backup discovery</h3><p class="text-xs text-gray-500">Scans the linked provider account for Agentor artifacts not yet in this installation.</p></div><UButton size="xs" variant="outline" :loading="busy === 'remote-scan'" @click="scanRemoteBackups">Scan provider</UButton></div>
          <p v-if="!api.discovered.value.length" class="text-sm text-gray-500">No remote-only backups discovered.</p>
          <div v-for="item in api.discovered.value" :key="item.id" class="rounded border p-3 text-sm" :data-testid="`discovered-backup-${item.id}`">
            <div class="flex justify-between gap-2"><div><b>{{ item.workspaceMembers?.map(memberLabel).join(', ') || item.id }}</b><p class="text-xs text-gray-500">{{ date(item.createdAt) }} · {{ fmt(item.size) }} · format {{ item.formatVersion ?? 'unknown' }} · <code>{{ item.keyFingerprint || 'key unknown' }}</code></p></div><span class="text-xs">{{ item.state }}</span></div>
            <p v-if="item.blockedReason" class="mt-1 text-xs text-amber-700 dark:text-amber-300">{{ item.blockedReason }}</p><p class="text-xs text-gray-500">Integrity: {{ item.integrityStatus || 'unverified' }} · recovery key: {{ item.keyAvailable === true ? 'available' : item.keyAvailable === false ? 'missing' : 'unknown' }} · {{ item.knownLocally ? 'already adopted locally' : 'remote only' }}</p>
            <div class="mt-2 flex gap-2"><UButton size="xs" variant="outline" @click="inspectDiscovered(item)">Inspect</UButton><UButton v-if="item.state !== 'adopted'" size="xs" :loading="busy === `remote-adopt-${item.id}`" :disabled="item.state !== 'ready-to-adopt'" @click="adoptDiscovered(item)">Adopt locally</UButton></div>
          </div>
          <div v-if="selectedDiscovered" class="rounded bg-gray-50 p-3 text-xs space-y-1 dark:bg-gray-900"><b>Remote backup details</b><p>Workers: {{ selectedDiscovered.workspaceMembers?.map(memberLabel).join(', ') || 'not inspected' }}</p><p>Ready to restore: {{ selectedDiscovered.restorable ? 'yes' : 'not until adoption and verification complete' }}</p><p v-if="selectedDiscovered.sourceInstallationId">Source installation: <code>{{ selectedDiscovered.sourceInstallationId }}</code></p><p v-if="selectedDiscovered.blockedReason">Blocked: {{ selectedDiscovered.blockedReason }}</p></div>
        </section>
        <section>
          <h3 class="font-medium mb-2">Jobs</h3>
          <div v-if="!api.jobs.value.length" class="text-sm text-gray-500">
            No backup jobs.
          </div>
          <div
            v-for="j in api.jobs.value"
            :key="j.id"
            class="border rounded p-3 mb-2"
          >
            <div class="flex justify-between">
              <span
                ><b>{{ j.status }}</b> · {{ j.phase }}</span
              ><span>{{ j.progress || 0 }}% · {{ fmt(j.bytesProcessed) }}</span>
            </div>
            <progress class="w-full" max="100" :value="j.progress || 0" />
            <p v-if="j.consistency?.warning" class="text-amber-600 text-xs">
              {{ j.consistency.warning }}
            </p>
            <p v-if="j.error" class="text-red-600 text-xs">
              <code v-if="j.errorCode" class="mr-1">{{ j.errorCode }}</code>
              {{ j.error }}<span v-if="j.providerStatus"> (HTTP {{ j.providerStatus }})</span>
              <UButton
                size="xs"
                variant="ghost"
                :loading="busy === j.id"
                @click="run(j.id, () => api.retry(j.id))"
                >Retry</UButton
              >
            </p>
            <UButton
              v-if="j.status === 'queued' || j.status === 'running'"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="run(j.id, () => api.cancel(j.id))"
              >Cancel</UButton
            >
          </div>
        </section>
        <section>
          <h3 class="font-medium mb-2">Backup history</h3>
          <div v-if="!api.artifacts.value.length" class="text-sm text-gray-500">
            No completed backups.
          </div>
          <div
            v-for="a in api.artifacts.value"
            :key="a.id"
            class="border rounded p-3 mb-2 flex items-center justify-between gap-3"
          >
            <div>
              <b>{{ restoreMembers(a).map(memberLabel).join(", ") }}</b>
              <p class="text-xs text-gray-500">
                {{ date(a.createdAt) }} · {{ fmt(a.sizeBytes ?? a.size) }} ·
                {{ a.provider }} ·
                {{
                  a.integrityVerified
                    ? "Integrity verified"
                    : "Verification unavailable"
                }}
              </p>
              <p v-if="a.missingSecrets?.length" class="text-xs text-amber-600">
                Secrets to reconfigure: {{ a.missingSecrets.join(", ") }}
              </p>
              <p v-if="a.reconstruction?.length" class="text-xs text-gray-500">
                Reconstruction: {{ a.reconstruction.map(item => item.image.kind === 'custom' ? `custom image ${item.image.definitionId || 'unknown'}${item.image.version ? ` v${item.image.version}` : ''}` : item.image.kind === 'unmanaged' ? 'unmanaged per-worker image' : item.image.kind).join('; ') }} · {{ a.reconstruction.reduce((count, item) => count + item.desiredPluginCount, 0) }} plugin installation{{ a.reconstruction.reduce((count, item) => count + item.desiredPluginCount, 0) === 1 ? '' : 's' }}
              </p>
            </div>
            <div class="flex gap-1">
              <UButton size="xs" @click="selectRestore(a)">Restore</UButton
              ><UButton
                size="xs"
                color="error"
                variant="ghost"
                @click="run(a.id, () => api.remove(a.id))"
                >Delete</UButton
              >
            </div>
          </div>
        </section>
        <div
          v-if="restoreItem"
          class="border-2 rounded p-4 space-y-2"
          data-testid="restore-backup"
        >
          <h3 class="font-medium">Restore backup</h3>
          <fieldset class="space-y-1">
            <legend class="text-sm font-medium">Restore target</legend>
            <label
              ><input
                v-model="restoreTarget"
                name="restore-target"
                type="radio"
                value="new"
              /> New worker</label
            >
            <label
              ><input
                v-model="restoreTarget"
                name="restore-target"
                type="radio"
                value="original"
              /> Original worker</label
            >
          </fieldset>
          <fieldset class="rounded border p-3 space-y-1">
            <legend class="px-1 text-sm font-medium">
              Workspaces to restore
            </legend>
            <p class="text-xs text-gray-500">
              {{ restoreTarget === "new"
                ? "Choose one or more workspaces to restore as new workers."
                : "Choose the single original workspace to overwrite." }}
            </p>
            <label
              v-for="member in restoreMembers()"
              :key="member.id"
              class="block"
            >
              <input
                v-if="restoreTarget === 'new'"
                v-model="restoreWorkspaceIds"
                type="checkbox"
                :value="member.id"
              />
              <input
                v-else
                type="radio"
                name="restore-original-workspace"
                :checked="restoreWorkspaceIds[0] === member.id"
                :value="member.id"
                @change="selectOriginalWorkspace(member.id)"
              />
              {{ memberLabel(member) }}
            </label>
            <UButton size="xs" variant="ghost" color="neutral" @click="resetRestoreSelection">
              Reset selection
            </UButton>
          </fieldset>
          <fieldset
            v-if="restoreTarget === 'new' && selectedCustomImageSummaries.length"
            class="rounded border border-amber-300 p-3 space-y-3"
            data-testid="restore-image-dependencies"
          >
            <legend class="px-1 text-sm font-medium">
              Custom image reconstruction
            </legend>
            <p class="text-xs text-gray-500">
              Agentor will never silently replace a required custom image with
              the platform default. Resolve each selected worker explicitly.
            </p>
            <div
              v-for="summary in selectedCustomImageSummaries"
              :key="summary.workspaceId"
              class="rounded border p-2 space-y-2"
            >
              <p class="text-sm font-medium">
                {{ memberLabel({ id: summary.workspaceId, displayName: summary.displayName }) }}
              </p>
              <p class="break-all text-xs text-gray-500">
                <template v-if="summary.image.kind === 'custom'">
                  Required: <code>{{ summary.image.definitionId }}</code>
                  version <code>{{ summary.image.version }}</code>
                </template>
                <template v-else>Required: unmanaged per-worker image</template>
                <span v-if="summary.image.digest">
                  · <code>{{ summary.image.digest }}</code>
                </span>
              </p>
              <p
                v-if="imageDependency(summary.workspaceId)?.reason"
                class="text-xs text-amber-700 dark:text-amber-300"
              >
                {{ imageDependency(summary.workspaceId).reason }}
              </p>
              <div
                v-if="imageRecoveryAvailable(summary)"
                class="rounded border border-amber-300 bg-amber-50 p-2 text-xs space-y-2 dark:bg-amber-950"
                data-testid="backup-image-recovery"
              >
                <p>
                  A secret-free image recipe is available in this backup. Recover a new image definition and start its controlled build.
                </p>
                <UButton
                  size="xs"
                  variant="outline"
                  :loading="busy === `image-recovery-${summary.workspaceId}`"
                  :disabled="Boolean(imageRecoveryJob(summary.workspaceId) && (imageRecoveryJob(summary.workspaceId)?.status === 'queued' || imageRecoveryJob(summary.workspaceId)?.status === 'running'))"
                  @click="recoverImageDefinition(summary)"
                >Recover definition &amp; build</UButton>
                <template v-if="imageRecoveryJob(summary.workspaceId)">
                  <p>
                    Recovery job <code>{{ imageRecoveryJob(summary.workspaceId)?.id }}</code>:
                    {{ imageRecoveryJob(summary.workspaceId)?.status }} ·
                    {{ imageRecoveryJob(summary.workspaceId)?.phase }}
                  </p>
                  <p v-if="imageRecoveryJob(summary.workspaceId)?.recoveredImageDefinitionId">
                    Recovered definition: <code>{{ imageRecoveryJob(summary.workspaceId)?.recoveredImageDefinitionId }}</code>.
                  </p>
                  <p v-if="imageBuildId(imageRecoveryJob(summary.workspaceId))">
                    Image build: <code>{{ imageBuildId(imageRecoveryJob(summary.workspaceId)) }}</code> ·
                    <NuxtLink
                      :to="`/api/image-builds/${encodeURIComponent(imageBuildId(imageRecoveryJob(summary.workspaceId))!)}`"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="underline"
                    >Inspect build status</NuxtLink>.
                  </p>
                  <p
                    v-if="imageRecoveryJob(summary.workspaceId)?.status === 'succeeded' && imageBuildId(imageRecoveryJob(summary.workspaceId))"
                    class="font-medium"
                  >
                    Definition recovery succeeded and the image build was started. Wait for its Agentor compatibility validation to succeed, then retry restore.
                  </p>
                  <p
                    v-if="imageRecoveryJob(summary.workspaceId)?.error"
                    class="text-red-700 dark:text-red-300"
                  >
                    {{ imageRecoveryJob(summary.workspaceId)?.error }}
                  </p>
                </template>
              </div>
              <label class="block text-xs">
                Image resolution
                <select
                  v-model="restoreImageModes[summary.workspaceId]"
                  class="mt-1 block w-full rounded border p-2"
                >
                  <option
                    value="exact"
                    :disabled="!exactImageAvailable(summary.workspaceId)"
                  >
                    Use exact captured image identity
                  </option>
                  <option value="replacement">Select replacement image</option>
                  <option value="workspace-only">
                    Restore workspace with platform image (not faithful)
                  </option>
                </select>
              </label>
              <div
                v-if="restoreImageModes[summary.workspaceId] === 'replacement'"
                class="grid gap-2 md:grid-cols-2"
              >
                <label class="text-xs">
                  Replacement definition ID
                  <input
                    :value="restoreReplacementImages[summary.workspaceId]?.imageDefinitionId || ''"
                    class="mt-1 block w-full rounded border p-2"
                    placeholder="image definition UUID"
                    @input="setReplacementField(summary.workspaceId, 'imageDefinitionId', ($event.target as HTMLInputElement).value)"
                  />
                </label>
                <label class="text-xs">
                  Replacement version
                  <input
                    :value="restoreReplacementImages[summary.workspaceId]?.imageVersion || ''"
                    class="mt-1 block w-full rounded border p-2"
                    placeholder="version"
                    @input="setReplacementField(summary.workspaceId, 'imageVersion', ($event.target as HTMLInputElement).value)"
                  />
                </label>
              </div>
              <p
                v-if="restoreImageModes[summary.workspaceId] === 'workspace-only'"
                class="text-xs font-medium text-amber-700 dark:text-amber-300"
              >
                By starting restore you acknowledge that only the workspace and
                portable configuration are restored; the worker image differs.
              </p>
            </div>
          </fieldset>
          <label v-if="restoreTarget === 'new'" class="block text-sm"
            >Display name (applies only to the first selected workspace)<input
              v-model="restoreName"
              class="block border rounded p-2"
              placeholder="New worker display name"
          /></label><label
            v-if="restoreTarget === 'original'"
            class="block text-red-600"
            ><input v-model="confirmOverwrite" type="checkbox" /> Original
            worker is stopped; overwrite its workspace</label
          >
          <label v-if="restoreTarget === 'original'" class="block text-sm"
            >Worker lock password (if protected)<input
              v-model="restoreLockPassword"
              type="password"
              autocomplete="current-password"
              class="block border rounded p-2"
          /></label>
          <div>
            <UButton
              :disabled="!restoreCanStart"
              :loading="busy === 'restore'"
              @click="restore"
              >Start restore</UButton
            >
            <UButton variant="ghost" color="neutral" @click="cancelRestore"
              >Cancel</UButton
            >
          </div>
        </div>
      </div></template
    ></UModal
  >
</template>
