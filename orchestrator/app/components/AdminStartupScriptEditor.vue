<script setup lang="ts">
interface StartupScriptSettings {
  script: string;
  configured: boolean;
  revision: number;
  appliedRevision: number;
  pendingRebuild: boolean;
  lastAppliedAt?: string;
  runtime?: {
    state: string;
    revision?: number;
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number;
  };
}

const props = defineProps<{
  endpoint: string;
  label?: string;
}>();
const emit = defineEmits<{ saved: [settings: StartupScriptSettings] }>();
const script = ref("");
const settings = ref<StartupScriptSettings | null>(null);
const loading = ref(false);
const saving = ref(false);
const loaded = ref(false);
const error = ref("");

function message(cause: any) {
  return (
    cause?.data?.statusMessage ||
    cause?.data?.message ||
    cause?.message ||
    "Startup script operation failed."
  );
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    settings.value = await $fetch<StartupScriptSettings>(props.endpoint);
    script.value = settings.value.script;
    loaded.value = true;
  } catch (cause) {
    error.value = message(cause);
  } finally {
    loading.value = false;
  }
}
async function save() {
  saving.value = true;
  error.value = "";
  try {
    settings.value = await $fetch<StartupScriptSettings>(props.endpoint, {
      method: "PUT",
      body: { startupScript: script.value },
    });
    emit("saved", settings.value);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    saving.value = false;
  }
}
function opened(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open && !loaded.value)
    void load();
}
</script>

<template>
  <details
    class="rounded border border-current/30 p-3"
    data-testid="admin-startup-script-editor"
    @toggle="opened"
  >
    <summary class="cursor-pointer text-sm font-bold">
      {{ label || "Startup script" }}
      <span v-if="settings?.pendingRebuild" class="ml-2 text-amber-400"
        >rebuild pending</span
      >
    </summary>
    <div class="mt-3 space-y-3">
      <p class="text-xs opacity-80">
        Runs in the administrative tmux workspace after every start. Store no
        credentials here. Saving does not interrupt a running workspace; use
        Stop + Start or Rebuild to apply a changed revision.
      </p>
      <p v-if="error" role="alert" class="rounded bg-red-100 p-2 text-xs text-red-900">
        {{ error }}
      </p>
      <p v-if="loading" class="text-xs">Loading startup script…</p>
      <template v-else-if="loaded">
        <UTextarea
          v-model="script"
          :aria-label="label || 'Administrative startup script'"
          :rows="8"
          autoresize
          placeholder="#!/bin/bash&#10;# Start persistent services here"
          class="w-full font-mono text-sm"
        />
        <div class="flex flex-wrap items-center gap-3 text-xs">
          <UButton size="xs" :loading="saving" @click="save">
            Save startup script
          </UButton>
          <span>desired revision {{ settings?.revision ?? 0 }}</span>
          <span>applied revision {{ settings?.appliedRevision ?? 0 }}</span>
          <span v-if="settings?.runtime?.state">
            runtime: {{ settings.runtime.state }}<template v-if="settings.runtime.exitCode !== undefined">
              (exit {{ settings.runtime.exitCode }})</template
            >
          </span>
        </div>
      </template>
    </div>
  </details>
</template>
