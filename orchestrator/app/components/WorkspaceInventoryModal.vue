<script setup lang="ts">
import type { WorkspaceInventoryItem } from '~/composables/useWorkspaces';

const open = defineModel<boolean>('open', { default: false });
const selected = ref<WorkspaceInventoryItem | null>(null);
const browserOpen = ref(false);
const { workspaces, loading, error, refresh } = useWorkspaces();
const toast = useToast();
const cloning = ref<string | null>(null);
const backingUp = ref<string | null>(null);

watch(open, (shown) => {
  if (shown) void refresh();
});

function ownerLabel(item: WorkspaceInventoryItem) {
  if (typeof item.owner === 'string') return item.owner;
  return item.owner.name || item.owner.email || item.owner.id;
}

function browse(item: WorkspaceInventoryItem) {
  selected.value = item;
  browserOpen.value = true;
}

function closeModal() {
  open.value = false;
}

async function cloneWorkspace(item: WorkspaceInventoryItem) {
  cloning.value = item.id;
  try {
    const result = await $fetch<{ displayName?: string }>(`/api/containers/${encodeURIComponent(item.workerId || item.id)}/clone`, { method: 'POST', body: {} });
    toast.add({ title: 'Workspace cloned', description: result.displayName || 'A new worker was created.', color: 'success' });
    await refresh();
  } catch (err: any) {
    toast.add({ title: 'Clone failed', description: err?.data?.statusMessage || err?.message || 'Could not clone this workspace.', color: 'error' });
  } finally { cloning.value = null; }
}

async function backupWorkspace(item: WorkspaceInventoryItem) {
  backingUp.value = item.id;
  try {
    await $fetch(`/api/workspaces/${encodeURIComponent(item.id)}/backup`, { method: 'POST' });
    toast.add({ title: 'Backup queued', description: 'Progress is available in Backup management.', color: 'success' });
    await refresh();
  } catch (err: any) {
    toast.add({ title: 'Backup failed', description: err?.data?.statusMessage || err?.message || 'Could not start the backup.', color: 'error' });
  } finally { backingUp.value = null; }
}
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-6xl' }">
    <template #content>
      <div class="p-6 space-y-4 max-h-[90vh] overflow-y-auto" data-testid="workspace-inventory">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-semibold">Workspace storage</h2>
            <p class="text-xs text-gray-500 mt-1">Browse persistent workspace data independently of worker runtime state.</p>
          </div>
          <div class="flex gap-2">
            <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="loading" @click="refresh">Refresh</UButton>
            <UButton color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close" @click="closeModal" />
          </div>
        </div>
        <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ error }}</p>

        <div class="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-md">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-800 text-left text-xs text-gray-500">
              <tr><th class="p-3">Workspace / worker</th><th class="p-3">Owner</th><th class="p-3">Storage</th><th class="p-3">State</th><th class="p-3">Size</th><th class="p-3">Updated</th><th class="p-3">Latest backup</th><th class="p-3">Actions</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in workspaces" :key="item.id" class="border-t border-gray-100 dark:border-gray-800">
                <td class="p-3"><p class="font-medium">{{ item.workerName || item.project || item.id }}</p><p class="text-[11px] text-gray-500 font-mono">{{ item.id }}</p></td>
                <td class="p-3">{{ ownerLabel(item) }}</td>
                <td class="p-3"><p>{{ item.backend }}</p><p v-if="item.dockerEnvironment" class="text-xs text-gray-500">{{ item.dockerEnvironment }}</p></td>
                <td class="p-3"><UBadge :color="item.state === 'orphaned' ? 'warning' : item.state === 'deleted' ? 'error' : item.state === 'running' ? 'success' : 'neutral'" variant="subtle">{{ item.state }}</UBadge></td>
                <td class="p-3 tabular-nums">{{ item.sizeBytes === null ? 'Not calculated' : formatBytes(item.sizeBytes) }}</td>
                <td class="p-3 text-xs">{{ new Date(item.updatedAt).toLocaleString() }}</td>
                <td class="p-3"><span v-if="item.latestBackup">{{ item.latestBackup.status }}<span v-if="item.latestBackup.completedAt" class="block text-xs text-gray-500">{{ new Date(item.latestBackup.completedAt).toLocaleString() }}</span></span><span v-else class="text-gray-500">Never</span></td>
                <td class="p-3"><div class="flex gap-1"><UButton size="xs" variant="outline" icon="i-lucide-folder-open" :disabled="item.capabilities.browse === false" :aria-label="item.capabilities.browse === false ? 'Browse unavailable until orphan is adopted' : 'Browse workspace'" @click="browse(item)">Browse</UButton><UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-cloud-upload" :disabled="!item.capabilities.backup" :loading="backingUp === item.id" aria-label="Back up now" @click="backupWorkspace(item)">Back up</UButton><UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :disabled="!item.capabilities.clone" :loading="cloning === item.id" :aria-label="item.capabilities.clone ? 'Clone workspace into a new worker' : 'Clone unavailable'" @click="cloneWorkspace(item)">Clone</UButton></div></td>
              </tr>
            </tbody>
          </table>
          <p v-if="!loading && !workspaces.length" class="p-8 text-center text-gray-500">No persistent workspaces found.</p>
        </div>
      </div>
    </template>
  </UModal>

  <WorkspaceBrowserModal v-model:open="browserOpen" :workspace="selected" />
</template>
