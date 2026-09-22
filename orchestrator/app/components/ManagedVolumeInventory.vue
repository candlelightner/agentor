<script setup lang="ts">
import type { PublicVolumeSizeJob, VolumeInventoryItem } from '../../shared/managed-volumes';
const volumes = ref<VolumeInventoryItem[]>([]), loading = ref(false), inventoryError = ref(''), actionError = ref(''), filter = ref('');
const error = computed(() => actionError.value || inventoryError.value);
const selected = ref<VolumeInventoryItem | null>(null), newName = ref(''), confirmation = ref(''), lockPassword = ref('');
const workerId = ref(''), workerOpen = ref(false), workerLockPassword = ref('');
let sizePoll: ReturnType<typeof setInterval> | undefined;
let pollPending = false;
let requestGeneration = 0;
watch(workerOpen, () => { workerLockPassword.value = ''; });
const visible = computed(() => volumes.value.filter((v) => `${v.name} ${v.purpose} ${v.workerName || ''} ${v.target || ''} ${v.userId || ''} ${v.state}`.toLowerCase().includes(filter.value.toLowerCase())));
const terminalSizeJob = (job?: PublicVolumeSizeJob) => Boolean(job && ['succeeded', 'failed', 'cancelled'].includes(job.status));
function currentJob(current: PublicVolumeSizeJob | undefined, incoming: PublicVolumeSizeJob | undefined) {
  if (!incoming) return terminalSizeJob(current) ? current : incoming;
  if (!current || current.id !== incoming.id) return incoming;
  if (terminalSizeJob(current) && !terminalSizeJob(incoming)) return current;
  return Date.parse(current.updatedAt) > Date.parse(incoming.updatedAt) ? current : incoming;
}
function applyInventory(incoming: VolumeInventoryItem[]) {
  const current = new Map(volumes.value.map((volume) => [volume.id, volume]));
  volumes.value = incoming.map((volume) => {
    const previous = current.get(volume.id);
    if (!previous) return volume;
    const sizeJob = currentJob(previous.sizeJob, volume.sizeJob);
    return sizeJob === previous.sizeJob && sizeJob !== volume.sizeJob
      ? { ...volume, sizeJob, size: previous.size, sizeBytes: previous.sizeBytes, logicalSizeBytes: previous.logicalSizeBytes }
      : { ...volume, sizeJob };
  });
}
function applySizeJob(volume: VolumeInventoryItem, job: PublicVolumeSizeJob) {
  const selected = currentJob(volume.sizeJob, job);
  volume.sizeJob = selected;
  if (selected === job && job.measurement) {
    volume.size = job.measurement;
    volume.sizeBytes = job.measurement.allocatedBytes;
    volume.logicalSizeBytes = job.measurement.logicalBytes;
  }
}
async function refresh(source: 'initial' | 'manual' | 'poll' | 'action' = 'manual', generation = ++requestGeneration) {
  const foreground = source !== 'poll';
  if (foreground) loading.value = true;
  if (source !== 'poll') inventoryError.value = '';
  try {
    const result = await $fetch<{ volumes: VolumeInventoryItem[]; dockerAvailable: boolean }>('/api/volumes');
    if (generation !== requestGeneration) return;
    applyInventory(result.volumes);
    inventoryError.value = result.dockerAvailable ? '' : 'Docker is unavailable. Desired storage remains listed; runtime state and deletion are unavailable.';
  } catch (e: any) {
    if (generation === requestGeneration && source !== 'poll') inventoryError.value = e?.data?.statusMessage || 'Could not load volume inventory.';
  } finally {
    if (source === 'poll') pollPending = false;
    if (foreground && generation === requestGeneration) loading.value = false;
  }
}
onMounted(() => {
  void refresh('initial');
  sizePoll = setInterval(() => {
    if (!loading.value && !pollPending && volumes.value.some((v) => v.sizeJob && ['queued', 'running'].includes(v.sizeJob.status))) {
      pollPending = true; void refresh('poll');
    }
  }, 2000);
});
onBeforeUnmount(() => { if (sizePoll) clearInterval(sizePoll); });
async function startSize(volume: VolumeInventoryItem) {
  const generation = ++requestGeneration;
  loading.value = true; actionError.value = '';
  try {
    const job = await $fetch<PublicVolumeSizeJob>(`/api/volumes/${volume.id}/size-jobs`, { method: 'POST', body: { force: volume.size.state !== 'unknown' } });
    if (generation !== requestGeneration) return;
    applySizeJob(volume, job);
    await refresh('action', generation);
  } catch (e: any) {
    if (generation === requestGeneration) actionError.value = e?.data?.statusMessage || 'Could not measure volume size.';
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}
async function cancelSize(volume: VolumeInventoryItem) {
  if (!volume.sizeJob) return;
  const generation = ++requestGeneration;
  loading.value = true; actionError.value = '';
  try {
    const job = await $fetch<PublicVolumeSizeJob>(`/api/volume-size-jobs/${volume.sizeJob.id}`, { method: 'DELETE' });
    if (generation !== requestGeneration) return;
    applySizeJob(volume, job);
    await refresh('action', generation);
  } catch (e: any) {
    if (generation === requestGeneration) actionError.value = e?.data?.statusMessage || 'Could not cancel volume size scan.';
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}
async function mutate(action: 'rename' | 'delete') {
  if (!selected.value) return;
  loading.value = true; actionError.value = '';
  try {
    await $fetch(`/api/volumes/${selected.value.id}`, { method: 'POST', body: { action, name: action === 'rename' ? newName.value : undefined, confirmed: action === 'delete' && confirmation.value === selected.value.name, lockPassword: lockPassword.value || undefined } });
    selected.value = null; lockPassword.value = ''; await refresh();
  } catch (e: any) { actionError.value = e?.data?.statusMessage || 'Volume operation failed.'; }
  finally { loading.value = false; }
}
</script>
<template>
  <section class="space-y-3" data-testid="managed-volume-inventory">
    <div class="flex gap-2 items-center"><UInput v-model="filter" placeholder="Filter volumes, owners, workers or paths" aria-label="Filter managed volumes" class="flex-1" /><UButton :loading="loading" variant="outline" @click="refresh('manual')">Refresh volumes</UButton></div>
    <p class="text-xs text-gray-500">Includes Agentor-created volumes, even when workers are stopped or archived. Directory-backed workspaces remain under Workspaces. Inner DinD volumes are represented by their outer Docker storage. “Selected for backup” describes configuration, not a completed backup.</p>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <div class="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
      <table class="w-full text-sm text-left"><thead class="bg-gray-50 dark:bg-gray-800"><tr><th class="p-2">Volume / purpose</th><th class="p-2">Owner / worker</th><th class="p-2">Path</th><th class="p-2">State</th><th class="p-2">Size</th><th class="p-2">Backup</th><th class="p-2">Actions</th></tr></thead>
        <tbody><tr v-for="v in visible" :key="v.id" class="border-t border-gray-200 dark:border-gray-700">
          <td class="p-2"><p>{{ v.name }}</p><p class="text-xs text-gray-500">{{ v.purpose }}</p></td>
          <td class="p-2"><p>{{ v.workerName || v.workerId || 'Platform' }}</p><p class="text-xs text-gray-500">{{ v.userId || 'Platform' }}</p></td>
          <td class="p-2 font-mono text-xs">{{ v.target || '—' }}</td>
          <td class="p-2"><p>{{ v.state }} / {{ v.observed }}</p><p v-if="v.error" class="text-xs text-red-600">{{ v.error }}</p></td>
          <td class="p-2">
            <p>{{ v.sizeBytes === null ? 'Unknown' : `${formatBytes(v.sizeBytes)} allocated` }}</p>
            <p v-if="v.logicalSizeBytes !== null && v.logicalSizeBytes !== undefined" class="text-xs text-gray-500">{{ formatBytes(v.logicalSizeBytes) }} logical</p>
            <p class="text-xs text-gray-500">
              {{ v.size.state }}<template v-if="v.size.measuredAt"> · {{ new Date(v.size.measuredAt).toLocaleString() }}</template>
              <template v-if="v.size.consistency === 'live-approximate'"> · approximate live traversal</template>
            </p>
            <div class="mt-1">
              <UButton v-if="v.sizeJob && ['queued', 'running'].includes(v.sizeJob.status)" size="xs" variant="ghost" :disabled="loading" @click="cancelSize(v)">Cancel size scan</UButton>
              <UButton v-else-if="v.canMeasureSize" size="xs" variant="ghost" :disabled="loading" @click="startSize(v)">{{ v.size.state === 'unknown' ? 'Calculate size' : 'Refresh size' }}</UButton>
              <span v-else class="text-xs text-gray-500">Measurement unavailable</span>
            </div>
            <p v-if="v.sizeJob?.status === 'succeeded'" class="text-xs text-green-600">Size scan completed.</p>
            <p v-else-if="v.sizeJob?.status === 'cancelled'" class="text-xs text-gray-500">Cancellation requested. Scanner cleanup may still be finishing.</p>
            <p v-else-if="v.sizeJob?.status === 'failed'" class="text-xs text-red-600">{{ v.sizeJob.error || 'Volume size scan failed.' }}</p>
          </td>
          <td class="p-2">{{ v.backupCoverage === 'selected' ? 'Selected for backup' : v.backupCoverage === 'not-configured' ? 'Not backed up' : 'Unknown' }}</td>
          <td class="p-2"><div class="flex gap-1"><UButton v-if="v.managed" size="xs" variant="outline" @click="selected = v; newName = v.name; confirmation = ''">Manage volume</UButton><UButton v-if="v.managed && v.workerName" size="xs" variant="ghost" @click="workerId = v.workerId!; workerOpen = true">Worker storage</UButton></div></td>
        </tr></tbody>
      </table>
      <p v-if="!loading && !visible.length" class="p-6 text-center text-gray-500">No matching Agentor volumes.</p>
    </div>
    <div v-if="selected" class="rounded border p-4 space-y-3">
      <h3 class="font-medium">Manage {{ selected.name }}</h3>
      <UInput v-model="newName" aria-label="Rename volume" /><UInput v-model="lockPassword" type="password" placeholder="Worker lock password, if protected" aria-label="Volume worker lock password" />
      <UButton size="xs" :disabled="loading || !newName" @click="mutate('rename')">Rename</UButton>
      <template v-if="selected.canDelete"><p class="text-sm text-red-600">Deletion permanently removes this detached volume and its data. Type its current name to confirm.</p><UInput v-model="confirmation" aria-label="Confirm volume name for deletion" /><UButton color="error" :disabled="loading || confirmation !== selected.name" @click="mutate('delete')">Permanently delete volume</UButton></template>
      <p v-else class="text-xs text-gray-500">Deletion is unavailable while the volume is desired, mounted, or its state is unknown.</p>
      <UButton variant="ghost" @click="selected = null; lockPassword = ''">Close volume controls</UButton>
    </div>
    <UModal v-model:open="workerOpen" :ui="{ content: 'max-w-3xl' }"><template #content><div class="p-5 max-h-[85vh] overflow-y-auto space-y-3"><UButton variant="ghost" @click="() => { workerOpen = false; }">Close</UButton><UInput v-model="workerLockPassword" type="password" placeholder="Worker lock password, if protected" aria-label="Storage worker lock password" /><WorkerStoragePanel v-if="workerOpen" :worker-id="workerId" :lock-password="workerLockPassword || undefined" /></div></template></UModal>
  </section>
</template>
