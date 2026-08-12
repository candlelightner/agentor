<script setup lang="ts">
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ changed: []; restored: [jobId: string] }>();
const api = useBackups(),
  { isAdmin } = useAuth(),
  draft = reactive({
    providerId: "local",
    enabled: false,
    selection: "all" as "all" | "selected",
    workspaceText: "",
    intervalMinutes: 1440,
    retentionCount: 7,
  });
const busy = ref(""),
  restoreItem = ref<any>(null),
  restoreTarget = ref<"new" | "original">("new"),
  restoreName = ref(""),
  confirmOverwrite = ref(false),
  actionError = ref("");
const googleDraft = reactive({ clientId: "", redirectUri: "", clientSecret: "" });
watch(open, async (shown) => {
  if (shown) {
    await api.refresh();
    Object.assign(draft, {
      ...api.settings.value,
      workspaceText: api.settings.value.workspaceIds.join(", "),
    });
  } else api.stop();
});
onBeforeUnmount(api.stop);
const workspaceIds = () =>
  draft.workspaceText
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
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
async function save() {
  await run("save", async () => {
    await api.saveSettings({
      ...api.settings.value,
      providerId: draft.providerId,
      enabled: draft.enabled,
      selection: draft.selection,
      intervalMinutes: draft.intervalMinutes,
      retentionCount: draft.retentionCount,
      workspaceIds: workspaceIds(),
      nextRunAt: api.settings.value.nextRunAt,
    });
    emit("changed");
  });
}
async function backup() {
  await run("backup", async () => {
    await api.startBackup(draft.selection, workspaceIds());
    emit("changed");
  });
}
async function configureGoogle() {
  await run("google-config", async () => {
    await api.configureGoogleInstallation({ ...googleDraft });
    googleDraft.clientSecret = "";
  });
}
async function restore() {
  if (!restoreItem.value) return;
  const result = await run("restore", () =>
    api.restore(
      restoreItem.value.id,
      restoreTarget.value,
      restoreName.value,
      confirmOverwrite.value,
    ),
  );
  if (result) {
    emit("restored", result.jobId);
    restoreItem.value = null;
  }
}
const fmt = (n?: number) => (n == null ? "—" : formatBytes(n)),
  date = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");
function close() {
  open.value = false;
}
function selectRestore(item: any) {
  restoreItem.value = item;
}
function cancelRestore() {
  restoreItem.value = null;
}
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
          <label v-if="draft.selection === 'selected'"
            >Workspace IDs (comma separated)<input
              v-model="draft.workspaceText"
              class="block w-full border rounded p-2"
              placeholder="workspace-a, workspace-b"
          /></label>
          <div class="flex gap-2">
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
              {{ j.error }}
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
              <b>{{ (a.workspaceIds || [a.workspaceId]).join(", ") }}</b>
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
          <label
            ><input v-model="restoreTarget" type="radio" value="new" /> New
            worker</label
          >
          <label
            ><input v-model="restoreTarget" type="radio" value="original" />
            Original worker</label
          ><input
            v-if="restoreTarget === 'new'"
            v-model="restoreName"
            class="block border rounded p-2"
            placeholder="New worker display name"
          /><label
            v-if="restoreTarget === 'original'"
            class="block text-red-600"
            ><input v-model="confirmOverwrite" type="checkbox" /> Original
            worker is stopped; overwrite its workspace</label
          >
          <div>
            <UButton
              :disabled="restoreTarget === 'original' && !confirmOverwrite"
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
