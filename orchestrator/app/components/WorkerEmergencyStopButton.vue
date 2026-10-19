<script setup lang="ts">
const props = defineProps<{
  workerId: string;
  workerName: string;
  administrative?: boolean;
  compact?: boolean;
}>();
const emit = defineEmits<{ settled: [] }>();
const toast = useToast();
const open = ref(false);
const busy = ref(false);
const error = ref('');
const needsPassword = ref(false);
const lockPassword = ref('');

async function refreshStatus() {
  emit('settled');
  await refreshNuxtData('workers').catch(() => {
    toast.add({ title: 'Refresh worker status', description: 'Worker status could not be refreshed. Refresh it before retrying.', color: 'warning' });
  });
}

watch(open, (shown) => {
  if (shown) {
    error.value = '';
    needsPassword.value = false;
    lockPassword.value = '';
  } else {
    lockPassword.value = '';
  }
});

async function emergencyStop() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await $fetch(`/api/containers/${encodeURIComponent(props.workerId)}/emergency-stop`, {
      method: 'POST',
      body: { confirmed: true, ...(needsPassword.value ? { lockPassword: lockPassword.value } : {}) },
      timeout: 30_000,
      retry: 0,
    });
  } catch (cause: any) {
    const status = cause?.statusCode ?? cause?.response?.status;
    needsPassword.value = needsPassword.value || status === 423;
    error.value = status === 423
      ? 'Enter the worker lock password to confirm the emergency stop.'
      : (cause?.data?.statusMessage || cause?.data?.message || 'The emergency stop has no confirmed outcome. Refresh worker status before retrying.');
    if (status !== 423) await refreshStatus();
    return;
  } finally {
    busy.value = false;
    lockPassword.value = '';
  }

  open.value = false;
  toast.add({ title: 'Worker stopped', description: `${props.workerName} was stopped immediately.`, color: 'success' });
  await refreshStatus();
}
</script>

<template>
  <span class="inline-flex">
    <UTooltip text="Emergency stop">
      <UButton
        color="error"
        variant="subtle"
        :size="compact ? 'xs' : 'sm'"
        icon="i-lucide-octagon-x"
        aria-label="Emergency stop"
        :label="compact ? undefined : 'Emergency stop'"
        @click="() => { open = true; }"
      />
    </UTooltip>
    <UModal
      v-model:open="open"
      :title="`Emergency stop ${workerName}?`"
      description="This will instantly pull the plug on this worker. There is no graceful shutdown or grace period: running processes will be terminated immediately without time to finish or clean up, and unsaved work may be lost."
      :dismissible="!busy"
      :close="false"
    >
      <template #body>
        <p class="break-words text-sm">Worker: <strong>{{ workerName }}</strong> <span class="text-gray-500">({{ workerId }})</span></p>
        <p v-if="administrative" class="mt-3 text-sm font-semibold text-red-600 dark:text-red-400">
          This is a privileged administrative workspace. Stopping it will interrupt its management sessions and processes.
        </p>
        <div v-if="needsPassword" class="mt-3">
          <label :for="`emergency-stop-password-${workerId}`" class="mb-1 block text-sm">Worker lock password</label>
          <UInput :id="`emergency-stop-password-${workerId}`" v-model="lockPassword" type="password" autocomplete="off" class="w-full" :disabled="busy" />
        </div>
        <p v-if="error" role="alert" class="mt-3 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="busy" @click="() => { open = false; }">Cancel</UButton>
          <UButton color="error" :loading="busy" :disabled="busy || (needsPassword && !lockPassword)" @click="emergencyStop">Emergency stop now</UButton>
        </div>
      </template>
    </UModal>
  </span>
</template>
