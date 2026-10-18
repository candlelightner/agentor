<script setup lang="ts">
const props = defineProps<{ endpoint: string }>();
const settings = ref<{ memoryLimit: string; appliedMemoryLimit: string; pendingRebuild: boolean } | null>(null);
const memoryLimit = ref('');
const error = ref('');
const busy = ref(false);
async function request(save = false) {
  busy.value = true;
  error.value = '';
  try {
    settings.value = await $fetch<NonNullable<typeof settings.value>>(props.endpoint, {
      method: save ? 'PUT' : 'GET',
      ...(save ? { body: { memoryLimit: memoryLimit.value } } : {}),
      timeout: 15_000, retry: 0,
    });
    memoryLimit.value = settings.value!.memoryLimit;
  } catch (cause: any) {
    error.value = cause?.data?.statusMessage || cause?.data?.message || 'Could not load or save memory. Refresh before retrying.';
  } finally { busy.value = false; }
}
onMounted(() => { void request(); });
</script>

<template>
  <section class="rounded border border-current/30 p-3" data-testid="admin-memory-editor">
    <h3 class="font-bold">VM memory</h3>
    <p class="my-2 text-xs">Saving does not restart the VM. Use Rebuild trusted image to apply the limit; persistent data is retained.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="settings" class="flex flex-wrap items-center gap-2">
      <label>Memory limit <UInput v-model="memoryLimit" aria-label="Admin VM memory limit" placeholder="4GiB" /></label>
      <UButton :disabled="busy" @click="request(true)">Save memory limit</UButton>
      <span class="text-xs">Applied: {{ settings.appliedMemoryLimit }}</span>
      <span v-if="settings.pendingRebuild" role="status" class="text-amber-400">Rebuild required to apply {{ settings.memoryLimit }}</span>
    </div>
    <UButton :loading="busy" @click="request()">Refresh memory</UButton>
  </section>
</template>
