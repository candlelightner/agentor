import type { ContainerInfo, CreateContainerRequest, UpdateContainerSettingsRequest } from '~/types';
import { fetchErrorMessage } from '../utils/fetch-error';

export function useContainers() {
  const toast = useToast();
  const { data: containers, refresh } = useFetch<ContainerInfo[]>('/api/containers', {
    key: 'workers',
    default: () => [],
  });

  usePolling(() => refresh(), 10_000);

  async function createContainer(request: CreateContainerRequest): Promise<ContainerInfo> {
    const result = await $fetch<ContainerInfo>('/api/containers', {
      method: 'POST',
      body: request,
    });
    await refresh();
    return result;
  }

  async function stopContainer(id: string) {
    await $fetch(`/api/containers/${id}/stop`, { method: 'POST' });
    await refresh();
  }

  async function restartContainer(id: string) {
    const notice = toast.add({ title: 'Starting worker', description: 'Waiting for storage preparation and worker readiness.', duration: 0 });
    try {
      await $fetch(`/api/containers/${id}/restart`, { method: 'POST', retry: 0 });
      toast.add({ title: 'Worker started', description: 'Worker readiness confirmed.', color: 'success', duration: 5000 });
    } catch (error) {
      toast.add({ title: 'Worker start not confirmed', description: fetchErrorMessage(error, 'Inspect runtime recovery for the failed startup phase before retrying.'), color: 'error', duration: 0 });
    } finally { toast.remove(notice.id); await refresh(); }
  }

  async function recoverContainer(
    id: string,
    lockPassword?: string,
  ): Promise<ContainerInfo> {
    const result = await $fetch<ContainerInfo>(`/api/containers/${id}/recover`, {
      method: 'POST',
      body: lockPassword ? { lockPassword } : {},
    });
    await refresh();
    return result;
  }

  async function rebuildContainer(id: string): Promise<ContainerInfo> {
    const result = await $fetch<ContainerInfo>(`/api/containers/${id}/rebuild`, { method: 'POST' });
    await refresh();
    return result;
  }

  async function removeContainer(id: string) {
    await $fetch(`/api/containers/${id}`, { method: 'DELETE' });
    await refresh();
  }

  async function updateContainerSettings(
    id: string,
    patch: UpdateContainerSettingsRequest,
  ): Promise<ContainerInfo> {
    const result = await $fetch<ContainerInfo>(`/api/containers/${id}`, {
      method: 'PATCH',
      body: patch,
    });
    await refresh();
    return result;
  }

  /** Restore a worker from an exported bundle. The bundle is streamed as the raw
   * request body (`application/x-tar`) so multi-GB imports never buffer. */
  async function importContainer(file: File, displayName?: string): Promise<ContainerInfo> {
    const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : '';
    const result = await $fetch<ContainerInfo>(`/api/containers/import${query}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/x-tar' },
    });
    await refresh();
    return result;
  }

  return {
    containers,
    refresh,
    createContainer,
    stopContainer,
    restartContainer,
    recoverContainer,
    rebuildContainer,
    removeContainer,
    updateContainerSettings,
    importContainer,
  };
}
