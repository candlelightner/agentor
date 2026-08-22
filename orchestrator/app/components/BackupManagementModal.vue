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
  confirmOverwrite = ref(false),
  pickerWorkspaceId = ref(""),
  actionError = ref(""),
  savedNotice = ref("");
const googleDraft = reactive({ clientId: "", redirectUri: "", clientSecret: "" });
watch(open, async (shown) => {
  if (shown) {
    await api.refresh();
    await refreshWorkspaceNames();
    Object.assign(draft, {
      ...api.settings.value,
      workspaceIds: [...api.settings.value.workspaceIds],
      selectedPathsByWorkspace: structuredClone(api.settings.value.selectedPathsByWorkspace || {}),
    });
    savedNotice.value = "";
  } else {
    api.stop();
    restoreLockPassword.value = "";
  }
});
onBeforeUnmount(api.stop);
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
      selectedPathsByWorkspace: structuredClone(
        persisted.selectedPathsByWorkspace || {},
      ),
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
async function restore() {
  if (!restoreItem.value || !restoreWorkspaceIds.value.length) return;
  const result = await run("restore", () =>
    api.restore(
      restoreItem.value.id,
      restoreTarget.value,
      restoreName.value,
      confirmOverwrite.value,
      restoreLockPassword.value,
      restoreWorkspaceIds.value,
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
}
function cancelRestore() {
  restoreItem.value = null;
  restoreWorkspaceIds.value = [];
  restoreName.value = "";
  confirmOverwrite.value = false;
  restoreLockPassword.value = "";
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
              :disabled="!restoreWorkspaceIds.length || (restoreTarget === 'original' && !confirmOverwrite)"
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
