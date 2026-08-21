<script setup lang="ts">
import type { ContainerInfo, FileEntry, FileListing } from '~/types';

const props = defineProps<{
  container: Pick<ContainerInfo, 'id' | 'status'> & { displayName?: string };
}>();

const open = defineModel<boolean>('open', { default: false });

const displayLabel = computed(() => props.container.displayName || shortName(props.container.id));
const isRunning = computed(() => props.container.status === 'running');

const { list, mkdir, rename, move, remove, upload, download, toastSuccess, toastError } = useWorkspaceFiles(() => props.container.id);

// ─── Current directory state ──────────────────────────────────────────────
// `cwd` is a POSIX path relative to `/workspace` (`` for the root). The
// breadcrumb is rooted at `/workspace` and rebuilt from `cwd` segments.
const cwd = ref<string>('');
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const error = ref<string>('');
const selection = ref<Set<string>>(new Set()); // entry `path` values, current dir only

// Breadcrumb segments: [{ label, path }], root first.
const breadcrumbs = computed(() => {
  const segs = cwd.value ? cwd.value.split('/').filter(Boolean) : [];
  const crumbs: { label: string; path: string }[] = [{ label: '/workspace', path: '' }];
  let acc = '';
  for (const s of segs) {
    acc = acc ? `${acc}/${s}` : s;
    crumbs.push({ label: s, path: acc });
  }
  return crumbs;
});

// Sorted view: directories first (already sorted by the API, but keep stable
// for symlinks-to-dirs which the API reports as `symlink`).
const sortedEntries = computed(() => [...entries.value]);

const allSelected = computed(() => entries.value.length > 0 && selection.value.size === entries.value.length);
const someSelected = computed(() => selection.value.size > 0);
const selectedEntries = computed(() => entries.value.filter((e) => selection.value.has(e.path)));

// Any escaping symlink in the current selection disables destructive ops.
const selectionHasEscaping = computed(() => selectedEntries.value.some((e) => e.type === 'symlink' && e.linkEscapes));

// ─── Action panel state ───────────────────────────────────────────────────
// A single inline panel replaces the listing toolbar actions. Only one panel
// is open at a time; Escape clears it before closing the modal.
type Panel = 'none' | 'upload' | 'mkdir' | 'rename' | 'move' | 'delete';
const panel = ref<Panel>('none');
const panelError = ref<string>('');
const panelBusy = ref(false);
const protection = ref<{ protected: boolean }>({ protected: false });
const lockPassword = ref('');

// Upload panel
const uploadFiles = ref<File[]>([]);
const uploadConflict = ref<string[] | null>(null);

// New folder / rename inputs
const newName = ref<string>('');
const renameTarget = ref<FileEntry | null>(null);

// Move destination
const moveDest = ref<string>('');
const moveConflict = ref<{ source: string; target: string }[] | null>(null);

// ─── Helpers ─────────────────────────────────────────────────────────────
function formatSize(bytes: number): string {
  return formatBytes(bytes);
}

function formatMtime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function iconFor(entry: FileEntry): string {
  if (entry.type === 'directory') return 'i-lucide-folder';
  if (entry.type === 'symlink') {
    return entry.linkEscapes ? 'i-lucide-link-2-off' : 'i-lucide-link';
  }
  return 'i-lucide-file';
}

function isDir(entry: FileEntry): boolean {
  return entry.type === 'directory';
}

// ─── Listing / navigation ─────────────────────────────────────────────────
async function refresh() {
  if (!isRunning.value) {
    error.value = 'Worker is not running — start it to browse files.';
    entries.value = [];
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const listing: FileListing = await list(cwd.value);
    entries.value = listing.entries;
  } catch (err) {
    error.value = fetchErrorMessage(err, 'Failed to list workspace files');
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function navigateTo(path: string) {
  if (cwd.value === path) return;
  cwd.value = path;
  selection.value = new Set();
  clearPanel();
  refresh();
}

function goUp() {
  if (!cwd.value) return;
  const segs = cwd.value.split('/').filter(Boolean);
  segs.pop();
  navigateTo(segs.join('/'));
}

function openEntry(entry: FileEntry) {
  if (entry.type === 'symlink' && entry.linkEscapes) return;
  if (entry.type === 'directory') {
    navigateTo(entry.path);
  }
}

// ─── Selection ───────────────────────────────────────────────────────────
function toggleSelect(entry: FileEntry, value?: boolean) {
  const next = new Set(selection.value);
  const want = value ?? !next.has(entry.path);
  if (want) next.add(entry.path);
  else next.delete(entry.path);
  selection.value = next;
}

function toggleSelectAll(value?: boolean) {
  if (value ?? !allSelected.value) {
    selection.value = new Set(entries.value.map((e) => e.path));
  } else {
    selection.value = new Set();
  }
}

function clearSelection() {
  selection.value = new Set();
}

// ─── Panel management ────────────────────────────────────────────────────
function clearPanel() {
  panel.value = 'none';
  panelError.value = '';
  panelBusy.value = false;
  uploadFiles.value = [];
  uploadConflict.value = null;
  newName.value = '';
  renameTarget.value = null;
  moveDest.value = '';
  moveConflict.value = null;
  lockPassword.value = '';
}

function openPanel(p: Panel) {
  clearPanel();
  panel.value = p;
  if (p === 'rename') {
    const target = selectedEntries.value[0];
    renameTarget.value = target ?? null;
    newName.value = target ? target.name : '';
  }
  if (p === 'move') {
    moveDest.value = '';
  }
}

// ─── Upload ──────────────────────────────────────────────────────────────
const uploadDestinationLabel = computed(() => (cwd.value ? `/workspace/${cwd.value}` : '/workspace'));

async function doUpload(overwrite: boolean) {
  if (uploadFiles.value.length === 0) return;
  panelBusy.value = true;
  panelError.value = '';
  uploadConflict.value = null;
  try {
    const result = await upload(cwd.value, uploadFiles.value, overwrite, lockPassword.value);
    if (!result.ok) {
      uploadConflict.value = result.conflict.conflicts as string[];
      panelError.value = result.message;
    } else {
      toastSuccess(
        'Upload complete',
        `${(result.data as { uploaded: number }).uploaded} entr${(result.data as { uploaded: number }).uploaded === 1 ? 'y' : 'ies'} uploaded to ${uploadDestinationLabel.value}`,
      );
      uploadFiles.value = [];
      clearPanel();
      await refresh();
    }
  } catch (err) {
    panelError.value = fetchErrorMessage(err, 'Upload failed');
  } finally {
    panelBusy.value = false;
  }
}

// ─── New folder ───────────────────────────────────────────────────────────
const mkdirValid = computed(() => {
  const n = newName.value.trim();
  return n.length > 0 && !n.includes('/') && n !== '.' && n !== '..';
});

async function doMkdir() {
  if (!mkdirValid.value) return;
  const rel = cwd.value ? `${cwd.value}/${newName.value.trim()}` : newName.value.trim();
  panelBusy.value = true;
  panelError.value = '';
  try {
    await mkdir(rel, lockPassword.value);
    toastSuccess('Folder created', newName.value.trim());
    clearPanel();
    await refresh();
  } catch (err) {
    panelError.value = fetchErrorMessage(err, 'Could not create folder');
  } finally {
    panelBusy.value = false;
  }
}

// ─── Rename ──────────────────────────────────────────────────────────────
const renameValid = computed(() => {
  const n = newName.value.trim();
  if (!renameTarget.value) return false;
  return n.length > 0 && !n.includes('/') && n !== '.' && n !== '..' && n !== renameTarget.value.name;
});

async function doRename() {
  if (!renameTarget.value || !renameValid.value) return;
  panelBusy.value = true;
  panelError.value = '';
  try {
    await rename(renameTarget.value.path, newName.value.trim(), lockPassword.value);
    toastSuccess('Renamed', `${renameTarget.value.name} → ${newName.value.trim()}`);
    // Keep the renamed entry selected under its new path.
    const parent = renameTarget.value.path.includes('/') ? renameTarget.value.path.slice(0, renameTarget.value.path.lastIndexOf('/')) : '';
    const newPath = parent ? `${parent}/${newName.value.trim()}` : newName.value.trim();
    clearPanel();
    await refresh();
    selection.value = new Set([newPath]);
  } catch (err) {
    panelError.value = fetchErrorMessage(err, 'Rename failed');
  } finally {
    panelBusy.value = false;
  }
}

// ─── Move ─────────────────────────────────────────────────────────────────
const moveDestValid = computed(() => {
  const d = moveDest.value.trim();
  if (d === '') return true; // root destination allowed
  // Light client-side validation: no leading slash, no backslash, no `..`.
  if (d.startsWith('/') || d.includes('\\') || d.split('/').includes('..')) return false;
  return true;
});

// Prevent trivially moving a folder into itself (or one of its descendants).
const moveSelfTarget = computed(() => {
  const dest = moveDest.value.trim();
  if (!dest) return false;
  return selectedEntries.value.some((e) => {
    if (e.type !== 'directory') return false;
    return dest === e.path || dest.startsWith(`${e.path}/`);
  });
});

const moveCanSubmit = computed(() => someSelected.value && moveDestValid.value && !moveSelfTarget.value && !selectionHasEscaping.value);

async function doMove(overwrite: boolean) {
  if (!moveCanSubmit.value) return;
  panelBusy.value = true;
  panelError.value = '';
  moveConflict.value = null;
  const paths = selectedEntries.value.map((e) => e.path);
  try {
    const result = await move(paths, moveDest.value.trim(), overwrite, lockPassword.value);
    if (!result.ok) {
      moveConflict.value = result.conflict.conflicts as {
        source: string;
        target: string;
      }[];
      panelError.value = result.message;
    } else {
      toastSuccess('Move complete', `${(result.data as { moved: number }).moved} moved`);
      clearPanel();
      clearSelection();
      await refresh();
    }
  } catch (err) {
    panelError.value = fetchErrorMessage(err, 'Move failed');
  } finally {
    panelBusy.value = false;
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────
async function doDelete() {
  if (selectionHasEscaping.value) return;
  const paths = selectedEntries.value.map((e) => e.path);
  if (paths.length === 0) return;
  panelBusy.value = true;
  panelError.value = '';
  try {
    const res = await remove(paths, lockPassword.value);
    toastSuccess('Deleted', `${res.deleted} entr${res.deleted === 1 ? 'y' : 'ies'} removed`);
    clearPanel();
    clearSelection();
    await refresh();
  } catch (err) {
    panelError.value = fetchErrorMessage(err, 'Delete failed');
  } finally {
    panelBusy.value = false;
  }
}

// ─── Download ─────────────────────────────────────────────────────────────
const downloading = ref(false);

async function doDownload() {
  if (selectionHasEscaping.value) return;
  const paths = selectedEntries.value.map((e) => e.path);
  if (paths.length === 0) return;
  downloading.value = true;
  try {
    await download(paths);
    toastSuccess('Download started');
  } catch (err) {
    toastError('Download failed', err, 'Could not download the selected files');
  } finally {
    downloading.value = false;
  }
}

// ─── Keyboard handling ────────────────────────────────────────────────────
// Row keyboard focus + Enter/Space/Delete/F2 semantics. A focused row id;
// navigation is by ArrowUp/ArrowDown. Escape clears action state first.
const focusedPath = ref<string | null>(null);

function focusRow(entry: FileEntry) {
  focusedPath.value = entry.path;
  const index = sortedEntries.value.findIndex((item) => item.path === entry.path);
  // Move DOM focus to the row element.
  nextTick(() => {
    const el = document.querySelector<HTMLElement>(`[data-workspace-row-index="${index}"]`);
    el?.focus();
  });
}

function onRowKeydown(e: KeyboardEvent, entry: FileEntry) {
  switch (e.key) {
    case 'Enter':
      e.preventDefault();
      openEntry(entry);
      break;
    case ' ':
      e.preventDefault();
      toggleSelect(entry);
      break;
    case 'Delete':
      e.preventDefault();
      if (selection.value.size > 0) openPanel('delete');
      break;
    case 'F2':
      e.preventDefault();
      if (selection.value.size === 1) openPanel('rename');
      break;
    case 'ArrowDown':
    case 'ArrowUp': {
      e.preventDefault();
      const idx = sortedEntries.value.findIndex((x) => x.path === entry.path);
      const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
      const next = sortedEntries.value[nextIdx];
      if (next) focusRow(next);
      break;
    }
    case 'Escape':
      e.preventDefault();
      if (panel.value !== 'none') clearPanel();
      break;
  }
}

// Modal-level Escape: clear an open action panel before closing the modal.
function onModalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && panel.value !== 'none') {
    e.stopPropagation();
    clearPanel();
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────
watch(open, async (isOpen) => {
  if (isOpen) {
    cwd.value = '';
    clearSelection();
    clearPanel();
    focusedPath.value = null;
    protection.value = { protected: false };
    try {
      protection.value = await $fetch(`/api/containers/${props.container.id}/protection`);
    } catch {
      // Listing remains usable if optional protection-state discovery fails;
      // the server still enforces every mutation fail-closed.
    }
    refresh();
  } else {
    // Tear down state so a re-open is clean.
    entries.value = [];
    error.value = '';
    clearSelection();
    clearPanel();
  }
});

// If the worker stops while the modal is open, surface it and keep the modal
// recoverable (refresh re-checks `isRunning`).
watch(
  () => props.container.status,
  (status) => {
    if (open.value && status !== 'running') {
      error.value = 'Worker is not running — start it to browse files.';
      entries.value = [];
    } else if (open.value && status === 'running' && error.value) {
      refresh();
    }
  },
);
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'sm:max-w-4xl w-full', body: 'p-0 sm:p-0' }" @keydown="onModalKeydown">
    <template #content>
      <div class="flex flex-col max-h-[90vh] w-full" data-testid="workspace-files-modal" @keydown="onModalKeydown">
        <!-- Header: worker name + refresh -->
        <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-gray-900 dark:text-white truncate" :title="displayLabel">
              {{ displayLabel }}
              <span class="text-gray-400 dark:text-gray-500 font-normal">— Files</span>
            </h2>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <UButton size="xs" color="neutral" variant="subtle" icon="i-lucide-rotate-cw" :loading="loading" :disabled="!isRunning" aria-label="Refresh listing" @click="refresh">
              <span class="hidden sm:inline">Refresh</span>
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-x"
              aria-label="Close"
              @click="
                () => {
                  open = false;
                }
              "
            />
          </div>
        </div>

        <!-- Breadcrumb (horizontally scrollable on mobile) -->
        <div class="flex items-center gap-0.5 px-4 py-2 border-b border-gray-200 dark:border-gray-800 overflow-x-auto whitespace-nowrap" data-testid="workspace-breadcrumb">
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-corner-left-up" :disabled="!cwd" aria-label="Up one level" @click="goUp" />
          <template v-for="(crumb, idx) in breadcrumbs" :key="crumb.path">
            <span v-if="idx > 0" class="text-gray-400 dark:text-gray-600">/</span>
            <button
              type="button"
              class="px-1.5 py-0.5 rounded text-xs hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              :class="idx === breadcrumbs.length - 1 ? 'text-gray-900 dark:text-white font-medium' : 'text-blue-600 dark:text-blue-400'"
              @click="navigateTo(crumb.path)"
            >
              {{ crumb.label }}
            </button>
          </template>
        </div>

        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-gray-200 dark:border-gray-800">
          <UButton size="xs" color="neutral" variant="subtle" icon="i-lucide-upload" :disabled="!isRunning || panel === 'upload'" @click="openPanel('upload')"> Upload </UButton>
          <UButton size="xs" color="neutral" variant="subtle" icon="i-lucide-folder-plus" :disabled="!isRunning || panel !== 'none'" @click="openPanel('mkdir')"> New Folder </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-download"
            :disabled="!isRunning || !someSelected || selectionHasEscaping || downloading"
            :loading="downloading"
            @click="doDownload"
          >
            Download
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-folder-input"
            :disabled="!isRunning || !someSelected || selectionHasEscaping || panel !== 'none'"
            @click="openPanel('move')"
          >
            Move
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-pencil"
            :disabled="!isRunning || selection.size !== 1 || selectionHasEscaping || panel !== 'none'"
            @click="openPanel('rename')"
          >
            Rename
          </UButton>
          <UButton size="xs" color="error" variant="subtle" icon="i-lucide-trash-2" :disabled="!isRunning || !someSelected || selectionHasEscaping || panel !== 'none'" @click="openPanel('delete')">
            Delete
          </UButton>

          <div class="flex-1" />

          <span v-if="someSelected" class="text-xs text-gray-500 dark:text-gray-400"> {{ selection.size }} selected </span>
        </div>

        <!-- Inline action panels -->
        <div v-if="panel !== 'none'" class="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
          <label v-if="protection.protected" class="mb-3 block text-xs text-amber-700 dark:text-amber-300">
            Protected worker lock password
            <UInput v-model="lockPassword" type="password" autocomplete="current-password" class="mt-1" />
          </label>
          <!-- Upload -->
          <div v-if="panel === 'upload'" class="space-y-3" data-testid="workspace-upload-panel">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-medium text-gray-900 dark:text-white">Upload to {{ uploadDestinationLabel }}</h3>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel upload" @click="clearPanel" />
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400">Files and folders are uploaded into the current directory, preserving their relative paths.</p>
            <FileDropZone v-model="uploadFiles" />
            <div
              v-if="uploadConflict && uploadConflict.length > 0"
              class="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
              data-testid="workspace-upload-conflict"
            >
              <p class="font-medium mb-1">Conflicts — these paths already exist:</p>
              <ul class="list-disc list-inside space-y-0.5 max-h-24 overflow-y-auto">
                <li v-for="c in uploadConflict" :key="c" class="font-mono truncate">
                  {{ c }}
                </li>
              </ul>
              <p class="mt-1.5">Retry with overwrite to replace them.</p>
            </div>
            <p v-if="panelError && !(uploadConflict && uploadConflict.length)" class="text-red-500 dark:text-red-400 text-xs">
              {{ panelError }}
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <UButton size="xs" :loading="panelBusy" :disabled="uploadFiles.length === 0" @click="doUpload(false)"> Upload{{ uploadFiles.length > 0 ? ` (${uploadFiles.length})` : '' }} </UButton>
              <UButton v-if="uploadConflict && uploadConflict.length > 0" size="xs" color="warning" variant="solid" :loading="panelBusy" :disabled="uploadFiles.length === 0" @click="doUpload(true)">
                Overwrite &amp; retry
              </UButton>
              <UButton size="xs" color="neutral" variant="outline" @click="clearPanel">Cancel</UButton>
            </div>
          </div>

          <!-- New folder -->
          <div v-else-if="panel === 'mkdir'" class="space-y-3" data-testid="workspace-mkdir-panel">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-medium text-gray-900 dark:text-white">New folder in {{ uploadDestinationLabel }}</h3>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel" @click="clearPanel" />
            </div>
            <UInput v-model="newName" placeholder="folder name" class="w-full" autofocus @keydown.enter="doMkdir" />
            <p v-if="newName && !mkdirValid" class="text-xs text-red-500 dark:text-red-400">Name must not contain slashes or be empty.</p>
            <p v-if="panelError" class="text-red-500 dark:text-red-400 text-xs">
              {{ panelError }}
            </p>
            <div class="flex items-center gap-2">
              <UButton size="xs" :loading="panelBusy" :disabled="!mkdirValid" @click="doMkdir">Create</UButton>
              <UButton size="xs" color="neutral" variant="outline" @click="clearPanel">Cancel</UButton>
            </div>
          </div>

          <!-- Rename -->
          <div v-else-if="panel === 'rename'" class="space-y-3" data-testid="workspace-rename-panel">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                Rename
                <span class="font-mono text-gray-500 dark:text-gray-400">{{ renameTarget?.name }}</span>
              </h3>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel" @click="clearPanel" />
            </div>
            <UInput v-model="newName" placeholder="new name" class="w-full" autofocus @keydown.enter="doRename" />
            <p v-if="newName && !renameValid" class="text-xs text-red-500 dark:text-red-400">Name must differ, contain no slashes, and not be empty.</p>
            <p v-if="panelError" class="text-red-500 dark:text-red-400 text-xs">
              {{ panelError }}
            </p>
            <div class="flex items-center gap-2">
              <UButton size="xs" :loading="panelBusy" :disabled="!renameValid" @click="doRename">Rename</UButton>
              <UButton size="xs" color="neutral" variant="outline" @click="clearPanel">Cancel</UButton>
            </div>
          </div>

          <!-- Move -->
          <div v-else-if="panel === 'move'" class="space-y-3" data-testid="workspace-move-panel">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-medium text-gray-900 dark:text-white">Move {{ selection.size }} item{{ selection.size === 1 ? '' : 's' }}</h3>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel" @click="clearPanel" />
            </div>
            <UFormField label="Destination" hint="Relative to /workspace; empty = root">
              <UInput v-model="moveDest" placeholder="e.g. docs or (empty for /workspace)" class="w-full font-mono text-xs" autofocus @keydown.enter="doMove(false)" />
            </UFormField>
            <p v-if="moveSelfTarget" class="text-xs text-red-500 dark:text-red-400">Cannot move a folder into itself or one of its descendants.</p>
            <p v-if="moveDest && !moveDestValid" class="text-xs text-red-500 dark:text-red-400">Destination must be relative to /workspace (no leading slash, no backslash, no ..).</p>
            <div
              v-if="moveConflict && moveConflict.length > 0"
              class="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
              data-testid="workspace-move-conflict"
            >
              <p class="font-medium mb-1">Conflicts at the destination:</p>
              <ul class="list-disc list-inside space-y-0.5 max-h-24 overflow-y-auto">
                <li v-for="c in moveConflict" :key="c.source" class="font-mono truncate">{{ c.source }} → {{ c.target }}</li>
              </ul>
              <p class="mt-1.5">Retry with overwrite to replace them.</p>
            </div>
            <p v-if="panelError && !(moveConflict && moveConflict.length)" class="text-red-500 dark:text-red-400 text-xs">
              {{ panelError }}
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <UButton size="xs" :loading="panelBusy" :disabled="!moveCanSubmit" @click="doMove(false)">Move</UButton>
              <UButton v-if="moveConflict && moveConflict.length > 0" size="xs" color="warning" variant="solid" :loading="panelBusy" :disabled="!moveCanSubmit" @click="doMove(true)">
                Overwrite &amp; retry
              </UButton>
              <UButton size="xs" color="neutral" variant="outline" @click="clearPanel">Cancel</UButton>
            </div>
          </div>

          <!-- Delete -->
          <div v-else-if="panel === 'delete'" class="space-y-3" data-testid="workspace-delete-panel">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-medium text-red-600 dark:text-red-400">Delete {{ selection.size }} item{{ selection.size === 1 ? '' : 's' }}?</h3>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel" @click="clearPanel" />
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              This permanently removes the following from
              <code class="font-mono">{{ uploadDestinationLabel }}</code
              >. This cannot be undone.
            </p>
            <ul class="max-h-40 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
              <li v-for="e in selectedEntries" :key="e.path" class="flex items-center gap-2 px-2 py-1 text-xs">
                <UIcon :name="iconFor(e)" class="size-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
                <span class="truncate text-gray-700 dark:text-gray-300" :title="e.path">{{ e.name }}</span>
              </li>
            </ul>
            <p v-if="panelError" class="text-red-500 dark:text-red-400 text-xs">
              {{ panelError }}
            </p>
            <div class="flex items-center gap-2">
              <UButton size="xs" color="error" variant="solid" icon="i-lucide-trash-2" :loading="panelBusy" @click="doDelete">
                Delete {{ selection.size }} item{{ selection.size === 1 ? '' : 's' }}
              </UButton>
              <UButton size="xs" color="neutral" variant="outline" @click="clearPanel">Cancel</UButton>
            </div>
          </div>
        </div>

        <!-- Listing -->
        <div class="flex-1 overflow-y-auto min-h-0">
          <!-- Error / stopped banner -->
          <div v-if="error" class="m-4 rounded-md border border-red-500/40 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" data-testid="workspace-files-error">
            <p>{{ error }}</p>
            <UButton size="xs" color="neutral" variant="outline" class="mt-2" :loading="loading" @click="refresh">Retry</UButton>
          </div>

          <div v-else-if="loading && entries.length === 0" class="flex items-center justify-center py-12 text-sm text-gray-400 dark:text-gray-500">
            <UIcon name="i-lucide-loader-2" class="size-4 animate-spin mr-2" />
            Loading…
          </div>

          <div v-else-if="entries.length === 0" class="py-12 text-center text-sm text-gray-400 dark:text-gray-500">This folder is empty.</div>

          <table v-else class="w-full text-sm" data-testid="workspace-files-list">
            <thead class="sticky top-0 bg-gray-50 dark:bg-gray-900 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
              <tr>
                <th class="w-8 px-3 py-1.5">
                  <UCheckbox :model-value="allSelected" aria-label="Select all" @update:model-value="toggleSelectAll(!!$event)" />
                </th>
                <th class="text-left px-2 py-1.5 font-medium">Name</th>
                <th class="text-left px-2 py-1.5 font-medium hidden sm:table-cell">Size</th>
                <th class="text-left px-2 py-1.5 font-medium hidden md:table-cell">Modified</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              <tr
                v-for="(entry, rowIndex) in sortedEntries"
                :key="entry.path"
                :data-row-path="entry.path"
                :data-workspace-row-index="rowIndex"
                tabindex="0"
                class="outline-none focus-visible:bg-blue-50 dark:focus-visible:bg-blue-500/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                :class="selection.has(entry.path) ? 'bg-blue-50/50 dark:bg-blue-500/5' : 'hover:bg-gray-50 dark:hover:bg-gray-800/40'"
                @keydown="onRowKeydown($event, entry)"
              >
                <td class="px-3 py-1.5 align-middle">
                  <UCheckbox :model-value="selection.has(entry.path)" :aria-label="`Select ${entry.name}`" @update:model-value="toggleSelect(entry, !!$event)" @click.stop />
                </td>
                <td class="px-2 py-1.5">
                  <button
                    type="button"
                    class="flex items-center gap-2 min-w-0 text-left w-full focus-visible:outline-none"
                    :disabled="entry.type === 'symlink' && entry.linkEscapes"
                    :title="entry.type === 'symlink' && entry.linkEscapes ? `Symlink escapes /workspace: ${entry.linkTarget}` : entry.type === 'symlink' ? `Symlink → ${entry.linkTarget}` : entry.name"
                    @dblclick="openEntry(entry)"
                    @click="focusRow(entry)"
                  >
                    <UIcon
                      :name="iconFor(entry)"
                      class="size-4 shrink-0"
                      :class="isDir(entry) ? 'text-blue-500 dark:text-blue-400' : entry.type === 'symlink' && entry.linkEscapes ? 'text-red-500 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'"
                    />
                    <span class="truncate text-gray-900 dark:text-white">{{ entry.name }}</span>
                    <UIcon v-if="entry.type === 'symlink' && entry.linkEscapes" name="i-lucide-alert-triangle" class="size-3.5 text-amber-500 dark:text-amber-400 shrink-0" aria-hidden="true" />
                  </button>
                </td>
                <td class="px-2 py-1.5 hidden sm:table-cell text-xs text-gray-500 dark:text-gray-400 font-mono">
                  {{ isDir(entry) || entry.type === 'symlink' ? '—' : formatSize(entry.size) }}
                </td>
                <td class="px-2 py-1.5 hidden md:table-cell text-xs text-gray-500 dark:text-gray-400">
                  {{ formatMtime(entry.mtime) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-between gap-2 px-4 py-2 border-t border-gray-200 dark:border-gray-800 text-xs text-gray-500 dark:text-gray-400">
          <span class="truncate"> <UIcon name="i-lucide-folder" class="size-3.5 mr-1 align-text-bottom" />{{ uploadDestinationLabel }} </span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            @click="
              () => {
                open = false;
              }
            "
            >Close</UButton
          >
        </div>
      </div>
    </template>
  </UModal>
</template>
