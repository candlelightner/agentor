<script setup lang="ts">
const props = defineProps<{
  containerId: string;
  containerName: string;
}>();

const open = defineModel<boolean>('open', { default: false });

const files = ref<File[]>([]);
const isUploading = ref(false);
const uploadError = ref('');
const protection = ref<{ protected: boolean }>({ protected: false });
const lockPassword = ref('');

watch(open, async (isOpen) => {
  if (isOpen) {
    protection.value = { protected: false };
    try { protection.value = await $fetch(`/api/containers/${props.containerId}/protection`); } catch { /* server still enforces */ }
  }
  if (!isOpen) {
    files.value = [];
    uploadError.value = '';
    lockPassword.value = '';
  }
});

async function upload() {
  if (files.value.length === 0) return;

  isUploading.value = true;
  uploadError.value = '';
  try {
    const formData = new FormData();
    if (lockPassword.value) formData.append('lockPassword', lockPassword.value);
    for (const file of files.value) {
      formData.append('files', file, file.name);
    }
    await $fetch(`/api/containers/${props.containerId}/workspace`, {
      method: 'POST',
      body: formData,
    });
    open.value = false;
  } catch (err: any) {
    // Keep the modal open and surface the failure rather than silently closing.
    uploadError.value = err?.data?.statusMessage || err?.statusMessage || 'Upload failed';
  } finally {
    isUploading.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open">
    <template #content>
      <div class="p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
          Upload to Workspace
        </h2>
        <p class="text-xs text-gray-400 dark:text-gray-500">
          Files will be uploaded to <code class="text-gray-500 dark:text-gray-400">/workspace</code> in {{ containerName }}
        </p>

        <FileDropZone v-model="files" />

        <label v-if="protection.protected" class="block text-xs text-amber-700 dark:text-amber-300">
          Protected worker lock password
          <UInput v-model="lockPassword" type="password" autocomplete="current-password" class="mt-1" />
        </label>

        <p v-if="uploadError" class="text-red-500 dark:text-red-400 text-xs">{{ uploadError }}</p>

        <div class="flex gap-3 pt-2">
          <UButton
            class="flex-1"
            :loading="isUploading"
            :disabled="files.length === 0"
            @click="upload"
          >
            Upload {{ files.length > 0 ? `(${files.length} file${files.length !== 1 ? 's' : ''})` : '' }}
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            @click="() => { open = false; }"
          >
            Cancel
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
