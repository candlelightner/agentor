import type { WorkerMetrics } from './types';

export const WORKER_METRICS_MAX_AGE_MS = 30_000;

export function isWorkerMetricAvailable(metric: WorkerMetrics, now = Date.now()): boolean {
  const sampled = metric.lastChecked ? Date.parse(metric.lastChecked) : NaN;
  const age = now - sampled;
  return metric.status === 'running' && !metric.error && Number.isFinite(sampled) &&
    age >= -WORKER_METRICS_MAX_AGE_MS && age <= WORKER_METRICS_MAX_AGE_MS;
}

/** Preserve the measurement timestamp and values so callers can identify old data. */
export function withWorkerMetricFreshness(metric: WorkerMetrics, now = Date.now()): WorkerMetrics {
  return metric.status === 'running' && !metric.error && !isWorkerMetricAvailable(metric, now)
    ? { ...metric, status: 'unknown', error: 'Metric sample is stale; awaiting a fresh reading.' }
    : metric;
}
