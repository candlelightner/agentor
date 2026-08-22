<script setup lang="ts">
const props = defineProps<{ workerId: string }>();
const open = defineModel<boolean>('open', { default: false });
const paths = defineModel<string[]>('paths', { default: () => [] });
type Entry = { name: string; path: string; type: 'file'|'directory'|'symlink'; readable: boolean; linkTarget?: string };
const cwd = ref('/workspace'), entries = ref<Entry[]>([]), error = ref(''), loading = ref(false);
const isSelected = (path: string) => paths.value.includes(path);
const sensitive = (path: string) => /^\/(?:home\/agent\/\.agent-data|run\/agentor-secrets|root|etc\/ssh)(?:\/|$)/.test(path);
function parent(path: string) { return path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/'; }
async function load(path = cwd.value) { loading.value = true; error.value = ''; try { const data = await $fetch<{path:string;entries:Entry[]}>(`/api/containers/${encodeURIComponent(props.workerId)}/backup-paths`, { query: { path } }); cwd.value = data.path; entries.value = data.entries; } catch (e) { error.value = fetchErrorMessage(e, 'Could not list backup paths'); } finally { loading.value = false; } }
function toggle(path: string) { paths.value = paths.value.includes(path) ? paths.value.filter(x => x !== path) : [...paths.value, path]; }
function openDirectory(entry: Entry) { if (entry.type === 'directory') void load(entry.path); }
function close() { open.value = false; }
// The picker is mounted only after its parent has already passed `open=true`.
// Run once on mount as well as for subsequent openings; otherwise the initial
// directory listing is never requested and the picker looks empty.
watch(open, shown => { if (shown) void load('/workspace'); }, { immediate: true });
</script>
<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-3xl' }"><template #content><div class="p-5 space-y-3" data-testid="backup-path-picker">
    <header><h3 class="font-medium">Backup paths</h3><p class="text-xs text-gray-500">Defaults remain selected. Browse from <code>/workspace</code> up to <code>/</code>; files and directories are backed up as explicitly selected. When settings are saved, additional directories are copied into managed local volumes so later rebuilds preserve them. Individual files and <code>/</code> remain backup-only.</p></header>
    <div class="flex gap-2 items-center text-sm"><UButton size="xs" variant="ghost" :disabled="cwd==='/'" @click="load(parent(cwd))">Up</UButton><code class="break-all">{{ cwd }}</code><span v-if="loading">Loading…</span></div>
    <label class="flex gap-2 items-center rounded border px-2 py-1 text-sm">
      <input type="checkbox" aria-label="Select current directory" :checked="isSelected(cwd)" @change="toggle(cwd)">
      <span>Select this directory</span>
      <span v-if="sensitive(cwd)" class="text-xs text-amber-600">Sensitive — explicit selection only</span>
    </label>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <label v-for="entry in entries" :key="entry.path" class="flex gap-2 items-center py-1 text-sm" :class="!entry.readable ? 'opacity-50' : ''">
      <input type="checkbox" :checked="isSelected(entry.path)" :disabled="!entry.readable" @change="toggle(entry.path)">
      <button type="button" class="text-left hover:underline" @dblclick="openDirectory(entry)"><span v-if="entry.type==='directory'" aria-hidden="true">📁 </span><span v-else-if="entry.type==='file'" aria-hidden="true">📄 </span>{{ entry.name }}</button>
      <UButton v-if="entry.type==='directory'" size="xs" variant="ghost" @click="openDirectory(entry)">Open</UButton>
      <span v-if="sensitive(entry.path)" class="text-xs text-amber-600">Sensitive — explicit selection only</span>
    </label>
    <div class="flex justify-end"><UButton @click="close">Done</UButton></div>
  </div></template></UModal>
</template>
