import type { PortMapping } from '~/types';

// Module-level singleton — the sidebar and the Port Mappings panel share one
// list and a single poller (matching useWorkerMetrics/useUsage), so opening the
// panel does not spin up a second 10s poll or a divergent copy of the data.
const mappings = ref<PortMapping[]>([]);
let initialized = false;

async function fetchMappings() {
  try {
    mappings.value = await $fetch<PortMapping[]>('/api/port-mappings');
  } catch {
    mappings.value = [];
  }
}

async function createMapping(opts: {
  externalPort: number;
  type: 'localhost' | 'external';
  workerId: string;
  internalPort: number;
  appType?: string;
  instanceId?: string;
}) {
  const result = await $fetch<PortMapping>('/api/port-mappings', {
    method: 'POST',
    body: opts,
  });
  await fetchMappings();
  return result;
}

async function removeMapping(port: number) {
  // Removing a mapping can wait for Traefik reconciliation, which need not
  // finish before the server has persisted the delete.  Hide it immediately
  // so the sidebar represents the requested state, then restore authoritative
  // data if the request is rejected (for example by a protection lock).
  mappings.value = mappings.value.filter((mapping) => mapping.externalPort !== port);
  try {
    await $fetch(`/api/port-mappings/${port}`, { method: 'DELETE' });
  } finally {
    await fetchMappings();
  }
}

export function usePortMappings() {
  if (!initialized) {
    initialized = true;
    fetchMappings();
  }
  usePolling(fetchMappings, 10_000);

  return {
    mappings,
    createMapping,
    removeMapping,
  };
}
