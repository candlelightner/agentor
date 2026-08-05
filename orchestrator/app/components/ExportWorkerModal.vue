<script setup lang="ts">
const props = defineProps<{ workerId: string; workerName: string }>();
const open = defineModel<boolean>('open', { default: false });
const includeRootfs = ref(false);
const error = ref('');
const { job, active, loading, statusError, restore, start, cancel, clear, download } = useExportJob(toRef(props, 'workerId'));

const progressLabel = computed(() => {
  if (!job.value) return '';
  if (job.value.progress !== undefined) return `${Math.round(job.value.progress)}%`;
  if (job.value.bytesProcessed !== undefined) return formatBytes(job.value.bytesProcessed);
  return '';
});

function closeModal() {
  open.value = false;
}

watch(open, async (shown) => {
  error.value = '';
  if (shown) await restore();
});

async function begin() {
  if (loading.value || active.value) return;
  error.value = '';
  try {
    await start(includeRootfs.value);
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'Could not start the export.';
  }
}

async function cancelJob() {
  error.value = '';
  try {
    await cancel();
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'Could not cancel the export.';
  }
}

async function downloadArtifact() {
  error.value = '';
  try {
    await download();
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'Could not download the export.';
  }
}
</script>

<template>
  <UModal v-model:open="open">
    <template #content>
      <div class="p-6 space-y-4" data-testid="export-worker-modal">
        <div>
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Export {{ workerName }}</h2>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Exports continue in the background if this window is closed or the page is reloaded.
          </p>
        </div>

        <template v-if="!job">
          <label class="flex items-start gap-3 rounded-md border border-gray-200 dark:border-gray-700 p-3">
            <UCheckbox v-model="includeRootfs" data-testid="export-rootfs" />
            <span>
              <span class="block text-sm font-medium">Include container root filesystem</span>
              <span class="block text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                Advanced: this can be very large and take a long time. Workspace-only is the recommended default.
              </span>
            </span>
          </label>
          <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ error }}</p>
          <div class="flex gap-3">
            <UButton :loading="loading" :disabled="loading" data-testid="export-start" @click="begin">Start export</UButton>
            <UButton color="neutral" variant="outline" @click="closeModal">Close</UButton>
          </div>
        </template>

        <template v-else>
          <div class="rounded-md bg-gray-50 dark:bg-gray-800 p-4 space-y-2" aria-live="polite">
            <div class="flex items-center justify-between gap-3">
              <UBadge :color="job.status === 'succeeded' ? 'success' : job.status === 'failed' ? 'error' : job.status === 'cancelled' ? 'neutral' : 'info'" variant="subtle">
                {{ job.status }}
              </UBadge>
              <span v-if="progressLabel" class="text-xs font-mono">{{ progressLabel }}</span>
            </div>
            <p v-if="job.phase" class="text-sm">{{ job.phase }}</p>
            <div
              v-if="job.progress !== undefined"
              class="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="Math.round(job.progress)"
            >
              <div class="h-full bg-blue-500 transition-all" :style="{ width: `${job.progress}%` }" />
            </div>
            <p v-if="job.error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ job.error }}</p>
            <p v-if="statusError" class="text-sm text-amber-600 dark:text-amber-400" role="status">{{ statusError }}</p>
            <p v-if="job.expiresAt && job.status === 'succeeded'" class="text-xs text-gray-500">Available until {{ new Date(job.expiresAt).toLocaleString() }}</p>
          </div>
          <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ error }}</p>
          <div class="flex flex-wrap gap-3">
            <UButton v-if="job.status === 'succeeded'" icon="i-lucide-download" data-testid="export-download" @click="downloadArtifact">Download</UButton>
            <UButton v-if="active" color="error" variant="outline" :loading="loading" data-testid="export-cancel" @click="cancelJob">Cancel export</UButton>
            <UButton v-if="!active" color="neutral" variant="outline" @click="clear">New export</UButton>
            <UButton color="neutral" variant="ghost" @click="closeModal">Close</UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
