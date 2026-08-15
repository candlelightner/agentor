<script setup lang="ts">
import { PREDEFINED_ENV_VAR_KEYS } from "../../shared/types";
const props = withDefaults(defineProps<{ excludedKeys: string[]; excludedGroupKeys?: string[]; workerId?: string; groupId?: string }>(), { excludedGroupKeys: () => [] });
const emit = defineEmits<{ "update:excludedKeys": [keys: string[]]; "update:excludedGroupKeys": [keys: string[]] }>();

const keys = ref<string[]>([]);
const predefinedKeys = ref<string[]>([]);
const customKeys = ref<string[]>([]);
const groupKeys = ref<string[]>([]);
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    const response = await $fetch<{ keys: string[]; predefinedKeys?: string[]; customKeys?: string[]; groupKeys?: string[] }>("/api/account/env-var-keys", { query: { ...(props.workerId ? { workerId: props.workerId } : {}), ...(props.groupId ? { groupId: props.groupId } : {}) } });
    keys.value = [...new Set(response.keys || [])].sort();
    const predefined = new Set(PREDEFINED_ENV_VAR_KEYS as readonly string[]);
    predefinedKeys.value = [...new Set(response.predefinedKeys || keys.value.filter((key) => predefined.has(key)))].sort();
    customKeys.value = [...new Set(response.customKeys || keys.value.filter((key) => !predefined.has(key)))].sort();
    groupKeys.value = [...new Set(response.groupKeys || [])].sort();
  } catch (cause: any) {
    error.value = cause?.data?.statusMessage || "Could not load account variable names.";
  } finally {
    loading.value = false;
  }
});

function inherited(key: string) {
  return !props.excludedKeys.includes(key);
}
function toggle(key: string, selected: boolean) {
  const excluded = new Set(props.excludedKeys);
  if (selected) excluded.delete(key);
  else excluded.add(key);
  emit("update:excludedKeys", [...excluded].sort());
}
function groupInherited(key: string) { return !props.excludedGroupKeys.includes(key); }
function toggleGroup(key: string, selected: boolean) {
  const excluded = new Set(props.excludedGroupKeys);
  if (selected) excluded.delete(key); else excluded.add(key);
  emit("update:excludedGroupKeys", [...excluded].sort());
}
</script>

<template>
  <section class="space-y-2" data-testid="account-env-inheritance">
    <div class="flex items-center justify-between">
      <label class="text-sm font-medium text-gray-700 dark:text-gray-300">Inherited account variables</label>
      <UBadge color="warning" variant="subtle" size="xs">requires rebuild</UBadge>
    </div>
    <p class="text-xs text-gray-500">
      Select which account-level variables this worker inherits. Only variable names are shown; values remain hidden.
    </p>
    <p v-if="loading" class="text-xs text-gray-500">Loading variable names…</p>
    <p v-else-if="error" role="alert" class="text-xs text-red-500">{{ error }}</p>
    <p v-else-if="!keys.length" class="text-xs text-gray-500">No account variables configured.</p>
    <div v-else class="space-y-3 rounded border p-2 dark:border-gray-700">
      <div v-if="predefinedKeys.length">
        <h4 class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Predefined</h4>
        <div class="grid gap-1 sm:grid-cols-2">
          <label v-for="key in predefinedKeys" :key="key" class="flex items-center gap-2 text-xs font-mono">
            <input type="checkbox" :aria-label="`Inherit ${key}`" :checked="inherited(key)" @change="toggle(key, ($event.target as HTMLInputElement).checked)" />{{ key }}
          </label>
        </div>
      </div>
      <div v-if="customKeys.length">
        <h4 class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Custom</h4>
        <div class="grid gap-1 sm:grid-cols-2">
          <label v-for="key in customKeys" :key="key" class="flex items-center gap-2 text-xs font-mono">
            <input type="checkbox" :aria-label="`Inherit ${key}`" :checked="inherited(key)" @change="toggle(key, ($event.target as HTMLInputElement).checked)" />{{ key }}
          </label>
        </div>
      </div>
      <div v-if="groupKeys.length">
        <h4 class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Worker group</h4>
        <div class="grid gap-1 sm:grid-cols-2">
          <label v-for="key in groupKeys" :key="key" class="flex items-center gap-2 text-xs font-mono">
            <input type="checkbox" :aria-label="`Inherit group ${key}`" :checked="groupInherited(key)" @change="toggleGroup(key, ($event.target as HTMLInputElement).checked)" />{{ key }}
          </label>
        </div>
      </div>
    </div>
  </section>
</template>
