export interface WorkerGroup { id: string; userId: string; name: string; workerIds: string[]; createdAt: string; updatedAt: string; }
export function useWorkerGroups() {
  const { data: groups, refresh } = useFetch<WorkerGroup[]>('/api/worker-groups', { default: () => [] });
  const create = async (name: string) => { const group = await $fetch<WorkerGroup>('/api/worker-groups', { method: 'POST', body: { name } }); await refresh(); return group; };
  const update = async (id: string, patch: Partial<Pick<WorkerGroup, 'name' | 'workerIds'>>) => { const group = await $fetch<WorkerGroup>(`/api/worker-groups/${id}`, { method: 'PATCH', body: patch }); await refresh(); return group; };
  const remove = async (id: string) => { await $fetch(`/api/worker-groups/${id}`, { method: 'DELETE' }); await refresh(); };
  return { groups, refresh, create, update, remove };
}
