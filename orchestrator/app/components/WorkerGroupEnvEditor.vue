<script setup lang="ts">
const props = defineProps<{ groupId: string }>();
const ownKeys = ref<string[]>([]), inheritedKeys = ref<string[]>([]), excludedInheritedKeys = ref<string[]>([]);
const key = ref(""), value = ref(""), busy = ref(false), error = ref("");

async function load() {
  try {
    const result = await $fetch<{ ownKeys: string[]; inheritedKeys: string[]; excludedInheritedKeys: string[] }>(`/api/worker-groups/${props.groupId}/env-var-keys`);
    ownKeys.value = result.ownKeys; inheritedKeys.value = result.inheritedKeys; excludedInheritedKeys.value = result.excludedInheritedKeys;
  } catch (cause: any) { error.value = cause?.data?.statusMessage || "Could not load group variable names."; }
}
onMounted(load);
async function update(body: Record<string, unknown>) {
  busy.value = true; error.value = "";
  try { await $fetch(`/api/worker-groups/${props.groupId}/env-var-keys`, { method: "PUT", body }); await load(); }
  catch (cause: any) { error.value = cause?.data?.statusMessage || "Could not update group variables."; }
  finally { busy.value = false; }
}
async function saveEntry() {
  if (!key.value || !value.value) return;
  await update({ entries: [{ key: key.value, value: value.value }] });
  key.value = ""; value.value = "";
}
async function remove(variable: string) { await update({ deleteKeys: [variable] }); }
function toggleInherited(variable: string, included: boolean) {
  const excluded = new Set(excludedInheritedKeys.value);
  if (included) excluded.delete(variable); else excluded.add(variable);
  excludedInheritedKeys.value = [...excluded].sort();
}
</script>
<template>
  <details class="mt-3 rounded border p-2" data-testid="group-env-editor">
    <summary class="cursor-pointer text-sm font-medium">Group variables</summary>
    <div class="mt-2 space-y-3">
      <p class="text-xs text-gray-500">Values are write-only. Descendant groups and workers inherit enabled names.</p>
      <p v-if="error" role="alert" class="text-xs text-red-500">{{ error }}</p>
      <div v-if="ownKeys.length"><h4 class="text-xs font-medium">Owned by this group</h4>
        <div v-for="variable in ownKeys" :key="variable" class="flex items-center justify-between text-xs font-mono"><span>{{ variable }} · configured</span><UButton size="xs" color="error" variant="ghost" :aria-label="`Delete ${variable}`" @click="remove(variable)">Delete</UButton></div>
      </div>
      <form class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" @submit.prevent="saveEntry">
        <UInput v-model="key" aria-label="Group variable name" placeholder="VARIABLE_NAME" />
        <UInput v-model="value" type="password" aria-label="Group variable value" placeholder="write-only value" />
        <UButton type="submit" size="xs" :loading="busy" :disabled="!key || !value">Add or replace</UButton>
      </form>
      <div v-if="inheritedKeys.length"><h4 class="text-xs font-medium">Inherited from ancestors</h4>
        <label v-for="variable in inheritedKeys" :key="variable" class="block text-xs font-mono"><input type="checkbox" :aria-label="`Inherit ancestor ${variable}`" :checked="!excludedInheritedKeys.includes(variable)" @change="toggleInherited(variable, ($event.target as HTMLInputElement).checked)" /> {{ variable }}</label>
        <UButton size="xs" variant="outline" :loading="busy" @click="update({ excludedInheritedKeys })">Save inherited selection</UButton>
      </div>
    </div>
  </details>
</template>
