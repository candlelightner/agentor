import type { WorkerMetrics, WorkerMetricsStatus } from '~/types';
import { ref } from 'vue';
import { withWorkerMetricFreshness } from '../../shared/worker-metrics';
import { usePolling } from './usePolling';

// Module-level singleton — every ContainerCard reads from one poll.
const workers = ref<WorkerMetrics[]>([]);
let initialized = false;

async function fetchWorkerMetrics() {
  workers.value = workers.value.map((metric) => withWorkerMetricFreshness(metric));
  try {
    const status = await $fetch<WorkerMetricsStatus>('/api/worker-metrics', { timeout: 10_000 });
    workers.value = status.workers.map((metric) => withWorkerMetricFreshness(metric));
  } catch {
    workers.value = workers.value.map((metric) => withWorkerMetricFreshness(metric));
  }
}

export function useWorkerMetrics() {
  if (!initialized) {
    initialized = true;
    fetchWorkerMetrics();
  }
  usePolling(() => fetchWorkerMetrics(), 10_000);
  return { workers, refresh: fetchWorkerMetrics };
}
