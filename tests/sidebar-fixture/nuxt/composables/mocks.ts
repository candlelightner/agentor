import { computed, ref } from 'vue';

const state = ref({ sidebar: { activeTab: 'workers' } });

export function useAuth() {
  const admin = window.location.search.includes('role=ordinary') === false;
  return {
    user: ref({ name: admin ? 'Admin Operator' : 'Ordinary Operator', email: admin ? 'admin@example.test' : 'operator@example.test' }),
    isAdmin: computed(() => admin),
    signOut: () => {},
  };
}
export function useUiState() { return { state, setActiveTab: (id: string) => { state.value.sidebar.activeTab = id; } }; }
export function useUsage() { return { refreshing: ref(false), refresh: () => {} }; }
export function useWorkerMetrics() { return { workers: ref([]) }; }
export function usePortMappings() { return { mappings: ref([]) }; }
export function useDomainMappings() { return { mappings: ref([]) }; }
export function useWorkerGroups() {
  const groups = ref([
    { id: 'root-group', name: 'Research', workerIds: ['ordinary-fixture'], memberCounts: { total: 1, active: 1, archived: 0 }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'nested-group', name: 'Nested team', parentId: 'root-group', workerIds: ['nested-fixture', 'archived-fixture'], memberCounts: { total: 2, active: 1, archived: 1 }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  ]);
  return { groups, refresh: () => {} };
}
export function usePolling() {}
export function useSplitPanes() { return { openPluginTab: () => {} }; }
export function usePlugins() { return { definitions: ref([]), installations: ref([]), stop: () => {} }; }
export function shortName(id: string) { return id.slice(0, 8); }
export function formatBytes(n: number) { return `${n} B`; }
export function formatRate(n: number) { return `${n} B/s`; }
