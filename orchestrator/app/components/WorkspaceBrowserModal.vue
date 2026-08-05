<script setup lang="ts">
import type { WorkspaceEntry, WorkspaceInventoryItem } from '~/composables/useWorkspaces';

const props = defineProps<{ workspace: WorkspaceInventoryItem | null }>();
const open = defineModel<boolean>('open', { default: false });
const query = ref('');
const { listing, selected, metadata, preview, search, loading, error, list, inspect, runSearch, download } =
  useWorkspaceBrowser(computed(() => props.workspace?.id || ''));

const currentPath = computed(() => listing.value?.path || '');
const breadcrumbs = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean);
  return [{ label: 'workspace', path: '' }, ...parts.map((label, index) => ({
    label,
    path: parts.slice(0, index + 1).join('/'),
  }))];
});
const visibleEntries = computed(() => search.value?.results || listing.value?.entries || []);

watch(open, (shown) => {
  if (shown && props.workspace) {
    query.value = '';
    void list('');
  }
});

function navigate(path: string) {
  query.value = '';
  search.value = null;
  void list(path);
}

function openEntry(entry: WorkspaceEntry) {
  if (entry.type === 'directory') {
    query.value = '';
    search.value = null;
    navigate(entry.path);
  } else {
    void inspect(entry);
  }
}

function closeModal() {
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-6xl' }">
    <template #content>
      <div class="p-5 space-y-4 max-h-[90vh] overflow-hidden flex flex-col" data-testid="workspace-browser">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-semibold">{{ workspace?.workerName || workspace?.project || 'Workspace' }}</h2>
            <p class="text-xs text-gray-500">Read-only · {{ workspace?.state }} · {{ workspace?.backend }}</p>
          </div>
          <UButton color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close" @click="closeModal" />
        </div>

        <div class="flex flex-wrap gap-1 items-center text-sm">
          <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
            <span v-if="index" class="text-gray-400">/</span>
            <UButton size="xs" color="neutral" variant="ghost" @click="navigate(crumb.path)">{{ crumb.label }}</UButton>
          </template>
        </div>

        <form class="flex gap-2" @submit.prevent="runSearch(query, currentPath)">
          <UInput v-model="query" class="flex-1" icon="i-lucide-search" placeholder="Search this directory and descendants" />
          <UButton type="submit" :loading="loading">Search</UButton>
          <UButton v-if="search" color="neutral" variant="outline" @click="query = ''; search = null">Clear</UButton>
        </form>
        <p v-if="search?.truncated" class="text-xs text-amber-600">Results were truncated. Refine your query or browse into a narrower directory.</p>
        <p v-if="listing?.truncated" class="text-xs text-amber-600">This directory listing was truncated.</p>
        <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ error }}</p>

        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-4 min-h-0 flex-1">
          <div class="border border-gray-200 dark:border-gray-700 rounded-md overflow-auto min-h-64">
            <button
              v-for="entry in visibleEntries"
              :key="entry.path"
              type="button"
              :aria-label="entry.name"
              class="w-full grid grid-cols-[1fr_auto_auto] gap-3 items-center px-3 py-2 text-left border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800"
              :class="selected?.path === entry.path ? 'bg-blue-50 dark:bg-blue-950/30' : ''"
              @click="openEntry(entry)"
            >
              <span class="flex items-center gap-2 min-w-0">
                <UIcon :name="entry.type === 'directory' ? 'i-lucide-folder' : entry.type === 'symlink' ? 'i-lucide-link' : 'i-lucide-file'" class="size-4 flex-none" />
                <span class="truncate">{{ entry.name }}</span>
              </span>
              <span class="text-xs text-gray-500 font-mono">{{ entry.mode || '' }}</span>
              <span class="text-xs text-gray-500 tabular-nums">{{ entry.type === 'file' ? formatBytes(entry.size) : '' }}</span>
            </button>
            <p v-if="!loading && !visibleEntries.length" class="p-6 text-center text-sm text-gray-500">No items found.</p>
          </div>

          <aside class="border border-gray-200 dark:border-gray-700 rounded-md p-4 overflow-auto space-y-3">
            <template v-if="metadata">
              <div class="flex items-center justify-between gap-2">
                <h3 class="font-medium truncate" :title="metadata.path">{{ metadata.name }}</h3>
                <UButton size="xs" icon="i-lucide-download" aria-label="Download item" @click="download([metadata.path])" />
              </div>
              <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt class="text-gray-500">Path</dt><dd class="font-mono break-all">{{ metadata.path }}</dd>
                <dt class="text-gray-500">Type</dt><dd>{{ metadata.type }}</dd>
                <dt class="text-gray-500">Size</dt><dd>{{ formatBytes(metadata.size) }}</dd>
                <dt class="text-gray-500">Permissions</dt><dd class="font-mono">{{ metadata.mode || '—' }}</dd>
                <dt class="text-gray-500">Owner</dt><dd>{{ metadata.owner || '—' }}<span v-if="metadata.group">:{{ metadata.group }}</span></dd>
                <dt class="text-gray-500">Modified</dt><dd>{{ metadata.mtime ? new Date(metadata.mtime).toLocaleString() : '—' }}</dd>
                <template v-if="metadata.linkTarget"><dt class="text-gray-500">Target</dt><dd class="font-mono break-all">{{ metadata.linkTarget }}</dd></template>
              </dl>
              <div v-if="preview" class="border-t border-gray-200 dark:border-gray-700 pt-3">
                <img v-if="preview.type === 'image' && preview.dataUrl" :src="preview.dataUrl" :alt="metadata.name" class="max-w-full max-h-80 object-contain mx-auto">
                <pre v-else-if="preview.type === 'text'" class="text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto">{{ preview.content }}</pre>
                <p v-if="preview.truncated" class="mt-2 text-xs text-amber-600">Preview truncated. Download the file to view it in full.</p>
              </div>
              <p v-else-if="metadata.type === 'file'" class="text-xs text-gray-500">No safe preview is available for this file.</p>
            </template>
            <p v-else class="text-sm text-gray-500">Select a file for metadata and a safe preview. Open folders to browse them.</p>
          </aside>
        </div>
      </div>
    </template>
  </UModal>
</template>
