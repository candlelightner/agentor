<script setup lang="ts">
import { UNKNOWN_STATE_WARNING, type WorkerRecoveryState } from '../../shared/worker-recovery';
const props = defineProps<{ workerId: string }>();
const state = ref<WorkerRecoveryState & { paused: boolean; desiredRuntimeStatus?: string }>();
const maxRetries = ref(3), busy = ref(false), confirmed = ref(false), password = ref(''), needsPassword = ref(false), error = ref(''), outcome = ref('');
async function refresh() {
  state.value = await $fetch(`/api/containers/${encodeURIComponent(props.workerId)}/recovery`);
  maxRetries.value = state.value!.maxRetries;
}
onMounted(() => refresh().catch(() => { error.value = 'Recovery status is unavailable. Retry opening settings.'; }));
async function change(desiredRuntimeStatus?: 'running' | 'stopped') {
  busy.value = true; error.value = ''; outcome.value = '';
  try {
    const result = await $fetch<any>(`/api/containers/${encodeURIComponent(props.workerId)}/${desiredRuntimeStatus ? 'desired-state' : 'recovery'}`, {
      method: 'PUT', retry: 0, timeout: 20_000,
      body: { ...(desiredRuntimeStatus ? { desiredRuntimeStatus, confirmed: confirmed.value } : { maxRetries: Number(maxRetries.value) }), lockPassword: password.value },
    });
    outcome.value = desiredRuntimeStatus ? `Requested ${result.desiredRuntimeStatus}; runtime confirmation is pending.` : 'Retry limit saved; attempt count retained.';
    await refresh(); await refreshNuxtData('workers');
  } catch (cause: any) {
    needsPassword.value ||= (cause?.statusCode ?? cause?.response?.status) === 423;
    error.value = cause?.data?.statusMessage || cause?.data?.message || 'Change could not be confirmed. Refresh status before retrying.';
  } finally { busy.value = false; password.value = ''; }
}
</script>

<template>
  <section class="my-4 space-y-3 rounded border border-gray-300 p-3 dark:border-gray-700" aria-label="Runtime recovery controls">
    <h3 class="font-semibold">Runtime recovery</h3>
    <p v-if="state" class="text-sm">Requested: {{ state.desiredRuntimeStatus || 'unknown' }}. Automatic attempts: {{ state.attempts }}/{{ state.maxRetries }}. {{ state.paused ? 'Automatic recovery paused.' : '' }}</p>
    <p v-if="state?.lastFailure" role="status" class="text-sm text-amber-700 dark:text-amber-400">{{ state.lastFailure.message }}</p>
    <div class="flex items-end gap-2">
      <UFormField label="Maximum automatic retries" description="0 disables automatic retries. Start/Retry resets the counter.">
        <UInput v-model.number="maxRetries" type="number" :min="0" :max="100" :disabled="busy" />
      </UFormField>
      <UButton :disabled="busy || !state" @click="change()">Save limit</UButton>
    </div>
    <p class="text-sm text-amber-700 dark:text-amber-400">{{ UNKNOWN_STATE_WARNING }}</p>
    <UCheckbox v-model="confirmed" label="I understand that the requested state does not confirm the current state." :disabled="busy" />
    <UFormField v-if="needsPassword" label="Worker lock password"><UInput v-model="password" type="password" autocomplete="off" :disabled="busy" /></UFormField>
    <div class="flex gap-2">
      <UButton :disabled="busy || !confirmed" @click="change('stopped')">Request stopped</UButton>
      <UButton :disabled="busy || !confirmed" @click="change('running')">Request running / Retry</UButton>
    </div>
    <p v-if="outcome" role="status" class="text-sm">{{ outcome }}</p>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
  </section>
</template>
