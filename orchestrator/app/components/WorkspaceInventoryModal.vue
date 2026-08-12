<script setup lang="ts">
import type { WorkspaceInventoryItem } from '~/composables/useWorkspaces';

const open = defineModel<boolean>('open', { default: false });
const selected = ref<WorkspaceInventoryItem | null>(null);
const browserOpen = ref(false);
const { workspaces, loading, error, refresh } = useWorkspaces();
const toast = useToast();
const cloning = ref<string | null>(null);
const backingUp = ref<string | null>(null);
const { isAdmin } = useAuth();
const storage = ref<any>(null);
const storageLoading = ref(false);
const storageError = ref('');
const cleaning = ref('');

watch(open, (shown) => {
  if (shown) { void refresh(); if (isAdmin.value) void refreshStorage(); }
});
async function refreshStorage() {
  storageLoading.value = true; storageError.value = '';
  try { storage.value = await $fetch('/api/admin/storage'); }
  catch (error: any) { storageError.value = error?.data?.statusMessage || 'Could not load storage inventory.'; }
  finally { storageLoading.value = false; }
}
async function cleanupStorage(kind: string) {
  cleaning.value = kind;
  try {
    const result: any = await $fetch('/api/admin/storage/cleanup', { method: 'POST', body: { [kind]: true } });
    storage.value = result.inventory;
    toast.add({ title: 'Storage cleanup complete', description: `Reclaimed ${formatBytes(result.reclaimedBytes || 0)}.`, color: 'success' });
  } catch (error: any) { toast.add({ title: 'Storage cleanup failed', description: error?.data?.statusMessage || error?.message || 'Could not complete cleanup.', color: 'error' }); }
  finally { cleaning.value = ''; }
}

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

        <section v-if="isAdmin" class="rounded border p-4 space-y-3" data-testid="storage-management">
          <div class="flex items-center justify-between gap-2"><div><h3 class="font-medium">Agentor disk storage</h3><p class="text-xs text-gray-500">Only safe cleanup targets are offered; referenced images and active artifacts are never deleted.</p></div><UButton size="xs" variant="outline" :loading="storageLoading" @click="refreshStorage">Refresh</UButton></div>
          <p v-if="storageError" role="alert" class="text-xs text-red-600">{{ storageError }}</p>
          <template v-if="storage"><p :class="storage.disk.warning === 'critical' ? 'text-red-600' : storage.disk.warning === 'warning' ? 'text-amber-600' : 'text-xs text-gray-500'" class="text-sm">{{ storage.disk.warning === 'ok' ? 'Disk capacity healthy' : `Disk space ${storage.disk.warning}` }} · {{ formatBytes(storage.disk.freeBytes) }} free of {{ formatBytes(storage.disk.totalBytes) }}</p><div class="grid gap-2 text-xs md:grid-cols-3"><span>Workspaces: {{ storage.workspaces.count }} · {{ storage.workspaces.bytes === null ? 'size unavailable' : formatBytes(storage.workspaces.bytes) }}</span><span>Docker images: {{ storage.docker.imagesBytes === null ? 'unavailable' : formatBytes(storage.docker.imagesBytes) }}</span><span>Build cache: {{ storage.docker.buildCacheBytes === null ? 'unavailable' : formatBytes(storage.docker.buildCacheBytes) }}</span></div><div class="flex flex-wrap gap-2"><UButton size="xs" variant="outline" :loading="cleaning === 'danglingImages'" @click="cleanupStorage('danglingImages')">Prune dangling images</UButton><UButton size="xs" variant="outline" :loading="cleaning === 'buildCache'" @click="cleanupStorage('buildCache')">Prune build cache</UButton><UButton size="xs" variant="outline" :loading="cleaning === 'staleHelpers'" @click="cleanupStorage('staleHelpers')">Remove stale helpers ({{ storage.helpers.stale }})</UButton><UButton size="xs" variant="outline" :loading="cleaning === 'staleStaging'" @click="cleanupStorage('staleStaging')">Clean old staging</UButton></div><ul class="text-xs text-gray-500"><li v-for="item in storage.staging" :key="item.id">{{ item.label }}: {{ formatBytes(item.bytes) }}</li></ul></template>
        </section>

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
