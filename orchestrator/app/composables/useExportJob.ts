export type ExportJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ExportJob {
  id: string;
  status: ExportJobState;
  phase?: string;
  progress?: number;
  bytesProcessed?: number;
  error?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
}

function jobId(value: any): string {
  return String(value?.id || value?.jobId || '');
}

function normalize(value: any): ExportJob {
  const rawProgress = Number(value?.progress);
  const status = value?.status || value?.state;
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status)) {
    throw new Error('The server returned an invalid export job status.');
  }
  return {
    id: jobId(value),
    status,
    phase: typeof value?.phase === 'string' ? value.phase : undefined,
    progress: Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress)) : undefined,
    bytesProcessed: Number.isFinite(Number(value?.bytesProcessed)) ? Number(value.bytesProcessed) : undefined,
    error: value?.error || value?.errorMessage,
    createdAt: value?.createdAt,
    startedAt: value?.startedAt,
    completedAt: value?.completedAt,
    expiresAt: value?.expiresAt,
  };
}

export function useExportJob(workerId: MaybeRef<string>) {
  const job = ref<ExportJob | null>(null);
  const statusError = ref('');
  const loading = ref(false);
  let pollFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const storageKey = computed(() => `agentor:export-job:${toValue(workerId)}`);
  const active = computed(() => job.value?.status === 'queued' || job.value?.status === 'running');

  function persist() {
    if (!import.meta.client) return;
    if (job.value) {
      localStorage.setItem(storageKey.value, job.value.id);
    } else {
      localStorage.removeItem(storageKey.value);
    }
  }

  function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function schedulePoll() {
    stopPolling();
    if (active.value) timer = setTimeout(() => void refresh(), Math.min(10_000, 1000 * (2 ** pollFailures)));
  }

  async function refresh() {
    if (!job.value?.id) return;
    try {
      job.value = normalize(await $fetch(`/api/export-jobs/${job.value.id}`));
      pollFailures = 0;
      statusError.value = '';
      persist();
    } catch (err: any) {
      const status = Number(err?.statusCode || err?.status || err?.response?.status);
      if (status === 404) {
        clear();
        statusError.value = 'This export job has expired or no longer exists.';
        return;
      }
      pollFailures += 1;
      statusError.value = err?.data?.statusMessage || err?.message || 'Could not refresh export status. Retrying…';
    } finally {
      schedulePoll();
    }
  }

  async function restore() {
    if (!import.meta.client || job.value) return;
    const id = localStorage.getItem(storageKey.value);
    if (!id) return;
    job.value = { id, status: 'queued' };
    await refresh();
  }

  async function start(includeRootfs = false) {
    if (loading.value || active.value) return;
    loading.value = true;
    statusError.value = '';
    stopPolling();
    try {
      const created = await $fetch(`/api/containers/${toValue(workerId)}/export-jobs`, {
        method: 'POST',
        body: { includeRootfs },
      });
      job.value = normalize(created);
      if (!job.value.id) throw new Error('The server did not return an export job ID.');
      persist();
      schedulePoll();
    } finally {
      loading.value = false;
    }
  }

  async function cancel() {
    if (!job.value?.id || !active.value) return;
    loading.value = true;
    try {
      await $fetch(`/api/export-jobs/${job.value.id}`, { method: 'DELETE' });
      await refresh();
    } finally {
      loading.value = false;
    }
  }

  function clear() {
    stopPolling();
    job.value = null;
    statusError.value = '';
    pollFailures = 0;
    if (import.meta.client) localStorage.removeItem(storageKey.value);
  }

  async function download() {
    if (job.value?.status !== 'succeeded') return;
    await refresh();
    if (statusError.value) throw new Error(statusError.value);
    if (job.value?.status !== 'succeeded') return;
    // A same-origin navigation lets the browser stream directly to disk while
    // retaining the session cookie; no archive bytes are buffered in JS.
    const a = document.createElement('a');
    a.href = `/api/export-jobs/${job.value.id}/download`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  onBeforeUnmount(stopPolling);

  return { job, active, loading, statusError, restore, start, refresh, cancel, clear, download };
}
