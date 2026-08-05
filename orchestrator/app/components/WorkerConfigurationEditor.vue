<script setup lang="ts">
import type { WorkerConfigurationInput } from "../../shared/types";

const props = defineProps<{ workerId?: string }>();
const boundModel = defineModel<WorkerConfigurationInput>({
  default: () => ({ variables: [], secrets: [], secretFiles: [] }),
});
const standaloneModel = ref<WorkerConfigurationInput>({
  variables: [],
  secrets: [],
  secretFiles: [],
});
const model = computed<WorkerConfigurationInput>({
  get: () => (props.workerId ? standaloneModel.value : boundModel.value),
  set: (value) => {
    if (props.workerId) standaloneModel.value = value;
    else boundModel.value = value;
  },
});
const effective = ref<
  Array<{
    key: string;
    value?: string;
    source: string;
    type: string;
    masked?: boolean;
    overriddenScopes?: Array<{ source: string }>;
  }>
>([]);
const existingSecrets = ref<string[]>([]);
const existingFiles = ref<Array<{ name: string; path: string }>>([]);
const loading = ref(Boolean(props.workerId));
const saving = ref(false);
const message = ref("");

function addVariable() {
  (model.value.variables ||= []).push({ key: "", value: "" });
}
function addSecret() {
  (model.value.secrets ||= []).push({ key: "", value: "" });
}
function addSecretFile() {
  (model.value.secretFiles ||= []).push({ name: "", path: "", content: "" });
}

async function load() {
  if (!props.workerId) return;
  loading.value = true;
  try {
    const response = await $fetch<any>(
      `/api/containers/${props.workerId}/configuration`,
    );
    model.value = {
      variables: response.local.variables,
      secrets: [],
      secretFiles: [],
    };
    existingSecrets.value = response.local.secrets.map(
      (entry: any) => entry.key,
    );
    existingFiles.value = response.local.secretFiles.map((entry: any) => ({
      name: entry.name,
      path: entry.path,
    }));
    effective.value = response.effective;
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!props.workerId) return;
  saving.value = true;
  message.value = "";
  try {
    const body: WorkerConfigurationInput = {
      variables: model.value.variables ?? [],
    };
    if (model.value.envFile !== undefined) body.envFile = model.value.envFile;
    const secrets = (model.value.secrets ?? []).filter(
      (entry) => entry.key && entry.value,
    );
    const files = (model.value.secretFiles ?? []).filter(
      (entry) => entry.name && entry.path && entry.content,
    );
    if (secrets.length) body.secrets = secrets;
    if (files.length) body.secretFiles = files;
    body.deleteSecrets = model.value.deleteSecrets;
    body.deleteSecretFiles = model.value.deleteSecretFiles;
    await $fetch(`/api/containers/${props.workerId}/configuration`, {
      method: "PUT",
      body,
    });
    message.value = "Saved. Rebuild the worker to apply these changes.";
    await load();
  } catch (err: any) {
    message.value =
      err?.data?.statusMessage ||
      err?.message ||
      "Could not save configuration.";
  } finally {
    saving.value = false;
  }
}

function removeExistingSecret(key: string) {
  (model.value.deleteSecrets ||= []).push(key);
  existingSecrets.value = existingSecrets.value.filter(
    (entry) => entry !== key,
  );
}
function removeExistingFile(name: string) {
  (model.value.deleteSecretFiles ||= []).push(name);
  existingFiles.value = existingFiles.value.filter(
    (entry) => entry.name !== name,
  );
}

watch(
  () => props.workerId,
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div
    class="space-y-4"
    data-testid="worker-configuration-editor"
    :aria-busy="loading"
    :inert="loading || undefined"
  >
    <p class="text-xs text-gray-500">
      Precedence: orchestrator → user → environment → worker. Values are applied
      only when the worker is created or rebuilt. Secret files appear under
      <code>/run/agentor-secrets</code> and are never stored in the workspace.
    </p>
    <UFormField label="Bulk variables (.env / KEY=value)">
      <UTextarea
        v-model="model.envFile"
        :rows="3"
        class="w-full font-mono text-xs"
        placeholder="# comments allowed&#10;API_URL=https://example.test"
      />
    </UFormField>
    <div class="space-y-2">
      <div
        v-for="(entry, index) in model.variables"
        :key="index"
        class="grid grid-cols-[1fr_1fr_auto] gap-2"
      >
        <UInput
          v-model="entry.key"
          placeholder="VARIABLE_NAME"
          class="font-mono"
        />
        <UInput v-model="entry.value" placeholder="value" />
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          aria-label="Remove variable"
          @click="
            () => {
              model.variables!.splice(index, 1);
            }
          "
        />
      </div>
      <UButton size="xs" variant="outline" @click="addVariable"
        >Add variable</UButton
      >
    </div>
    <div class="space-y-2">
      <div v-if="existingSecrets.length" class="text-xs text-gray-500">
        <p>
          Configured secrets: {{ existingSecrets.join(", ") }} (values cannot be
          read back)
        </p>
        <span
          v-for="key in existingSecrets"
          :key="key"
          class="inline-flex items-center mr-2"
          ><code>{{ key }}</code
          ><UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :aria-label="`Remove configured secret ${key}`"
            @click="removeExistingSecret(key)"
        /></span>
      </div>
      <div
        v-for="(entry, index) in model.secrets"
        :key="index"
        class="grid grid-cols-[1fr_1fr_auto] gap-2"
      >
        <UInput
          v-model="entry.key"
          placeholder="SECRET_NAME"
          class="font-mono"
        />
        <UInput
          v-model="entry.value"
          type="password"
          placeholder="write-only value"
        />
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          aria-label="Remove secret"
          @click="
            () => {
              model.secrets!.splice(index, 1);
            }
          "
        />
      </div>
      <UButton size="xs" variant="outline" @click="addSecret"
        >Add masked secret</UButton
      >
    </div>
    <div class="space-y-2">
      <div v-if="existingFiles.length" class="text-xs text-gray-500">
        <p>
          Configured secret files:
          {{
            existingFiles
              .map((entry) => `${entry.name} → ${entry.path}`)
              .join(", ")
          }}
        </p>
        <span
          v-for="entry in existingFiles"
          :key="entry.name"
          class="inline-flex items-center mr-2"
          ><code>{{ entry.name }}</code
          ><UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :aria-label="`Remove configured secret file ${entry.name}`"
            @click="removeExistingFile(entry.name)"
        /></span>
      </div>
      <div
        v-for="(entry, index) in model.secretFiles"
        :key="index"
        class="grid grid-cols-[1fr_1fr_1fr_auto] gap-2"
      >
        <UInput v-model="entry.name" placeholder="logical name" />
        <UInput
          v-model="entry.path"
          placeholder="relative/path"
          class="font-mono"
        />
        <UInput
          v-model="entry.content"
          type="password"
          placeholder="write-only content"
        />
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          aria-label="Remove secret file"
          @click="
            () => {
              model.secretFiles!.splice(index, 1);
            }
          "
        />
      </div>
      <UButton size="xs" variant="outline" @click="addSecretFile"
        >Add secret file</UButton
      >
    </div>
    <details v-if="effective.length">
      <summary class="text-sm cursor-pointer">
        Effective environment preview
      </summary>
      <div class="mt-2 max-h-48 overflow-auto text-xs font-mono">
        <div
          v-for="entry in effective"
          :key="entry.key"
          class="grid grid-cols-[1fr_auto_1fr] gap-2 py-1 border-b border-gray-100 dark:border-gray-800"
        >
          <span>{{ entry.key }}</span
          ><span
            ><UBadge size="xs" color="neutral">{{ entry.source }}</UBadge
            ><span
              v-if="entry.overriddenScopes?.length"
              class="ml-1 text-gray-400"
              >overrides
              {{
                entry.overriddenScopes
                  .map((item: any) => item.source)
                  .join(", ")
              }}</span
            ></span
          ><span>{{ entry.masked ? "••••••••" : entry.value }}</span>
        </div>
      </div>
    </details>
    <div v-if="workerId" class="flex items-center gap-2">
      <UButton size="sm" :loading="saving" @click="save"
        >Save worker configuration</UButton
      ><span class="text-xs text-gray-500">{{ message }}</span>
    </div>
  </div>
</template>
