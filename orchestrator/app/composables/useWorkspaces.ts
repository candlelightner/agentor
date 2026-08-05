export type WorkspaceState = 'running' | 'stopped' | 'archived' | 'deleted' | 'orphaned';

export interface WorkspaceInventoryItem {
  id: string;
  owner: { id: string; name?: string; email?: string } | string;
  workerId?: string;
  workerName?: string;
  project?: string;
  backend: string;
  dockerEnvironment?: string;
  state: WorkspaceState;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number | null;
  latestBackup: { status: string; completedAt?: string; error?: string } | null;
  capabilities: { browse?: boolean; backup?: boolean; clone?: boolean };
}

export type WorkspaceEntryType = 'file' | 'directory' | 'symlink';
export interface WorkspaceEntry {
  name: string;
  path: string;
  type: WorkspaceEntryType;
  size: number;
  mtime: string;
  mode?: string;
  owner?: string;
  group?: string;
  linkTarget?: string;
  previewable?: boolean;
  mimeType?: string;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  truncated?: boolean;
}

export interface WorkspacePreview {
  path: string;
  type: 'text' | 'image';
  mimeType: string;
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
}

export interface WorkspaceSearchResult {
  query: string;
  path: string;
  results: WorkspaceEntry[];
  truncated?: boolean;
}

function errorMessage(err: any, fallback: string): string {
  return err?.data?.statusMessage || err?.data?.message || err?.message || fallback;
}

export function useWorkspaces() {
  const workspaces = ref<WorkspaceInventoryItem[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function refresh() {
    loading.value = true;
    error.value = '';
    try {
      const response = await $fetch<WorkspaceInventoryItem[] | { workspaces: WorkspaceInventoryItem[] }>('/api/workspaces');
      workspaces.value = Array.isArray(response) ? response : response.workspaces;
    } catch (err) {
      error.value = errorMessage(err, 'Could not load workspace inventory.');
    } finally {
      loading.value = false;
    }
  }

  return { workspaces, loading, error, refresh };
}

export function useWorkspaceBrowser(workspaceId: MaybeRef<string>) {
  const listing = ref<WorkspaceListing | null>(null);
  const selected = ref<WorkspaceEntry | null>(null);
  const metadata = ref<WorkspaceEntry | null>(null);
  const preview = ref<WorkspacePreview | null>(null);
  const search = ref<WorkspaceSearchResult | null>(null);
  const loading = ref(false);
  const error = ref('');
  let previewObjectUrl: string | undefined;

  const base = () => `/api/workspaces/${encodeURIComponent(toValue(workspaceId))}`;

  async function list(path = '') {
    loading.value = true;
    error.value = '';
    selected.value = null;
    metadata.value = null;
    clearPreview();
    try {
      listing.value = await $fetch<WorkspaceListing>(`${base()}/files`, { query: { path } });
    } catch (err) {
      error.value = errorMessage(err, 'Could not browse this workspace.');
    } finally {
      loading.value = false;
    }
  }

  async function inspect(entry: WorkspaceEntry) {
    selected.value = entry;
    metadata.value = null;
    clearPreview();
    error.value = '';
    try {
      metadata.value = await $fetch<WorkspaceEntry>(`${base()}/metadata`, { query: { path: entry.path } });
      if (entry.type === 'file' && entry.previewable !== false) {
        const response = await fetch(`${base()}/preview?path=${encodeURIComponent(entry.path)}`);
        if (!response.ok) {
          const failure: any = new Error(`Preview failed (${response.status})`);
          failure.status = response.status;
          throw failure;
        }
        const mimeType = response.headers.get('content-type') || 'application/octet-stream';
        if (mimeType.startsWith('image/')) {
          previewObjectUrl = URL.createObjectURL(await response.blob());
          preview.value = { path: entry.path, type: 'image', mimeType, dataUrl: previewObjectUrl };
        } else {
          preview.value = { path: entry.path, type: 'text', mimeType, content: await response.text() };
        }
      }
    } catch (err: any) {
      if (Number(err?.statusCode || err?.status) !== 415) {
        error.value = errorMessage(err, 'Could not inspect this item.');
      }
    }
  }

  async function runSearch(query: string, path = '') {
    const q = query.trim();
    if (!q) {
      search.value = null;
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      search.value = await $fetch<WorkspaceSearchResult>(`${base()}/search`, { query: { q, path } });
    } catch (err) {
      error.value = errorMessage(err, 'Workspace search failed.');
    } finally {
      loading.value = false;
    }
  }

  async function download(paths: string[]) {
    error.value = '';
    try {
      const anchor = document.createElement('a');
      const params = new URLSearchParams();
      for (const path of paths) params.append('path', path);
      anchor.href = `${base()}/download?${params}`;
      anchor.download = '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      error.value = errorMessage(err, 'Could not download the selected item.');
    }
  }

  function clearPreview() {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = undefined;
    preview.value = null;
  }

  onBeforeUnmount(clearPreview);

  return { listing, selected, metadata, preview, search, loading, error, list, inspect, runSearch, download };
}
