import type { ContainerInfo, TmuxWindow } from '~/types';

const POLL_INTERVAL = 3000;

export function useTmuxTabs(containerId: Ref<string>) {
  const { data: workers } = useNuxtData<ContainerInfo[]>('workers');
  const available = computed(() => workers.value?.some(worker => worker.id === containerId.value && worker.status === 'running') ?? false);
  const { getTmuxActiveWindow, setTmuxActiveWindow } = useUiState();
  const windows = ref<TmuxWindow[]>([]);
  const activeWindowIndex = ref<number | null>(null);

  const defaultWindowIndex = 0;

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let fetchGeneration = 0;
  let destroyed = false;
  let pollGeneration = 0;
  let failures = 0;

  async function fetchWindows() {
    if (destroyed || !available.value) return false;
    const currentGeneration = ++fetchGeneration;
    try {
      const data = await $fetch<TmuxWindow[]>(`/api/containers/${containerId.value}/panes`, { retry: 0 });

      // Discard stale response if containerId changed during fetch
      if (destroyed || !available.value || currentGeneration !== fetchGeneration) return false;

      windows.value = data;

      // If active window was removed externally, pick first available
      if (activeWindowIndex.value != null && !data.some((w) => w.index === activeWindowIndex.value)) {
        activeWindowIndex.value = data.length > 0 ? data[0]!.index : null;
      }

      // Auto-select first window when nothing is active
      if (activeWindowIndex.value == null && data.length > 0) {
        const saved = getTmuxActiveWindow(containerId.value);
        activeWindowIndex.value = data.some(window => window.index === saved) ? saved! : data[0]!.index;
      }

      // Persist for reopen
      if (activeWindowIndex.value != null) {
        setTmuxActiveWindow(containerId.value, activeWindowIndex.value);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function poll() {
    const generation = pollGeneration;
    const succeeded = await fetchWindows();
    if (destroyed || !available.value || generation !== pollGeneration) return;
    failures = succeeded ? 0 : Math.min(failures + 1, 4);
    // Expected unavailable responses back off; inventory must still confirm running.
    pollTimer = setTimeout(poll, POLL_INTERVAL * 2 ** failures);
  }

  function stopPolling() {
    pollGeneration++;
    fetchGeneration++;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function createWindow(name?: string, lockPassword?: string): Promise<TmuxWindow | null> {
    try {
      const window = await $fetch<TmuxWindow>(
        `/api/containers/${containerId.value}/panes`,
        { method: 'POST', body: { ...(name ? { name } : {}), ...(lockPassword ? { lockPassword } : {}) } },
      );
      await fetchWindows();
      activeWindowIndex.value = window.index;
      setTmuxActiveWindow(containerId.value, window.index);
      return window;
    } catch {
      return null;
    }
  }

  async function renameWindow(windowIndex: number, newName: string, lockPassword?: string): Promise<boolean> {
    try {
      await $fetch(`/api/containers/${containerId.value}/panes/${windowIndex}`, {
        method: 'PUT',
        body: { newName, ...(lockPassword ? { lockPassword } : {}) },
      });

      // Update windows array
      const win = windows.value.find((w) => w.index === windowIndex);
      if (win) win.name = newName;

      return true;
    } catch {
      return false;
    }
  }

  async function closeWindow(windowIndex: number, lockPassword?: string): Promise<boolean> {
    try {
      await $fetch(`/api/containers/${containerId.value}/panes/${windowIndex}`, {
        method: 'DELETE',
        body: lockPassword ? { lockPassword } : undefined,
      });
    } catch {
      return false;
    }
    windows.value = windows.value.filter((w) => w.index !== windowIndex);
    if (activeWindowIndex.value === windowIndex) {
      activeWindowIndex.value = windows.value.length > 0 ? windows.value[0]!.index : null;
    }
    if (activeWindowIndex.value != null) {
      setTmuxActiveWindow(containerId.value, activeWindowIndex.value);
    }
    return true;
  }

  function activateWindow(windowIndex: number) {
    activeWindowIndex.value = windowIndex;
    setTmuxActiveWindow(containerId.value, windowIndex);
  }

  function destroy() {
    destroyed = true;
    stopPolling();
  }

  watch([containerId, available], () => {
    stopPolling();
    windows.value = [];
    activeWindowIndex.value = null;
    failures = 0;
    if (!destroyed && available.value) void poll();
  }, { immediate: true });

  return {
    windows,
    activeWindowIndex,
    defaultWindowIndex,
    createWindow,
    renameWindow,
    closeWindow,
    activateWindow,
    destroy,
  };
}
