<script setup lang="ts">
import type { WorkerRuntimeProfile } from '../../shared/types';

interface MigrationRecoveryEntry {
  workerId: string;
  operationId: string;
  displayName?: string;
  phase: string;
  sourceProfile: WorkerRuntimeProfile;
  targetProfile: WorkerRuntimeProfile;
  reconciliationRequired: boolean;
  workerRecordTransitionPending: boolean;
}
const { isAdmin } = useAuth();
const entries = ref<MigrationRecoveryEntry[]>([]);
const loading = ref(false);
const error = ref('');
const loaded = ref(false);
let requestVersion = 0;
let mounted = true;
onBeforeUnmount(() => { mounted = false; requestVersion++; });
async function refresh() {
  if (!isAdmin.value) return;
  const request = ++requestVersion;
  loading.value = true; error.value = ''; loaded.value = false;
  // A failed inventory is not evidence of no retained journals. Hide stale
  // mutation controls until the authoritative inventory can be read again.
  entries.value = [];
  try {
    const result = await $fetch<MigrationRecoveryEntry[]>('/api/admin/runtime-migrations');
    if (mounted && isAdmin.value && request === requestVersion) { entries.value = result; loaded.value = true; }
  } catch (cause: any) {
    if (mounted && isAdmin.value && request === requestVersion)
      error.value = cause?.data?.statusMessage || cause?.message || 'Migration recovery inventory unavailable';
  } finally { if (mounted && request === requestVersion) loading.value = false; }
}
watch(isAdmin, () => {
  requestVersion++; entries.value = []; loaded.value = false; loading.value = false; error.value = '';
  if (isAdmin.value) void refresh();
}, { immediate: true });
</script>

<template>
  <section v-if="isAdmin" aria-label="Runtime migration recovery" class="shrink-0 border-b border-gray-200 p-3 text-xs dark:border-gray-800">
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-semibold">Runtime migration recovery<span v-if="loaded"> ({{ entries.length }})</span></h2>
      <UButton size="xs" color="neutral" variant="outline" :loading="loading" :disabled="loading" @click="refresh">{{ error ? 'Retry recovery inventory' : 'Refresh recovery inventory' }}</UButton>
    </div>
    <p class="mt-1">Retained migration journals are separate from live workers. A worker held for recovery may be absent from the worker list.</p>
    <p v-if="loading" role="status">Loading recovery inventory…</p>
    <p v-if="error" role="alert" class="mt-2 text-red-500">Recovery inventory is unavailable; do not assume no migrations need attention. {{ error }}</p>
    <p v-else-if="loaded && entries.length === 0" class="mt-2">No retained runtime migration journals.</p>
    <div v-if="loaded && entries.length" class="mt-2 max-h-80 space-y-2 overflow-y-auto">
      <details v-for="entry in entries" :key="entry.operationId" class="rounded border border-gray-200 p-2 dark:border-gray-800">
        <summary class="cursor-pointer">
          {{ entry.displayName || entry.workerId }} — {{ entry.phase }}{{ entry.reconciliationRequired || entry.workerRecordTransitionPending ? ' — reconciliation required' : ' — rollback evidence retained' }}
        </summary>
        <p class="my-2 break-all">Worker: {{ entry.workerId }} · Operation: {{ entry.operationId }}</p>
        <p class="mb-2">{{ entry.sourceProfile }} → {{ entry.targetProfile }}. This is recovery metadata, not evidence that the worker is running.</p>
        <WorkerRuntimeControl :worker-id="entry.workerId" :can-migrate="true" recovery-only @changed="refresh" />
      </details>
    </div>
  </section>
</template>
