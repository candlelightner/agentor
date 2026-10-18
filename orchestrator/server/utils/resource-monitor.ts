import type { DockerService, RawContainerStats } from './docker';
import type { ContainerManager } from './container';
import type { ContainerInfo, WorkerMetrics, WorkerMetricsStatus } from '../../shared/types';
import { isWorkerLifecycleMutationActive, workerLifecycleGeneration } from './worker-lifecycle-coordinator';

/** How often per-worker cpu/mem/net is sampled via the Docker stats API. Short
 * so the dashboard feels live; an overlap guard keeps a slow sample from
 * stacking the next tick. Network rates are derived from consecutive samples. */
const POLL_INTERVAL_MS = 3_000;

/** Per-worker durable disk usage is comparatively expensive and slow-changing,
 * so it samples on a much slower cadence. */
const DISK_POLL_INTERVAL_MS = 60_000;

/** Hard cap on a single per-worker Docker stats call. Without it, a hung stats
 * stream would never settle, the `Promise.all` in `pollWorkers` would never
 * resolve, and the `polling` overlap guard would stay `true` forever — silently
 * wedging all future metric samples. */
const STATS_TIMEOUT_MS = 10_000;

/** Reject after `ms` if `p` hasn't settled, so a single stuck container can't
 * deadlock the poller. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

interface WorkerSample {
  incarnation: string;
  cpu?: number;
  cpuCount?: number;
  rx: number;
  tx: number;
  blkRead: number;
  blkWrite: number;
  t: number;
}

/**
 * Polls per-worker resource metrics through the selected runtime API — cpu /
 * memory / network via `container.stats`, and durable disk via a bounded `du`
 * of `/workspace` plus agent data. This is OS- and
 * runtime-independent (no host `/proc`/`statfs`), so it behaves the same on
 * Docker Desktop, Linux, etc. Keeps the latest snapshot in memory only —
 * metrics are ephemeral, so nothing is persisted.
 */
export class ResourceMonitor {
  /** Latest per-worker metrics, keyed by the stable container name. */
  private workers = new Map<string, WorkerMetrics>();
  private prevWorker = new Map<string, WorkerSample>();
  /** Last-sampled per-worker disk usage (bytes), keyed by container name. */
  private workerDisk = new Map<string, { bytes: number; incarnation: string }>();
  private incarnations = new Map<string, string>();
  private sampleSequence = 0;
  private latestStats = new Map<string, number>();
  private latestDisk = new Map<string, number>();

  private pollInterval?: ReturnType<typeof setInterval>;
  private diskInterval?: ReturnType<typeof setInterval>;
  /** Guards against overlapping samples when a poll runs longer than the interval. */
  private polling = false;
  private diskPolling = false;

  constructor(
    private docker: DockerService,
    private containers: ContainerManager,
  ) {}

  async init(): Promise<void> {
    await this.poll();
    this.pollInterval = setInterval(() => {
      this.poll().catch((err) => {
        useLogger().error(`[resource-monitor] poll error: ${err instanceof Error ? err.message : err}`);
      });
    }, POLL_INTERVAL_MS);

    // Durable disk on a slower cadence (`du` is comparatively expensive).
    this.sampleWorkerDisk().catch(() => {});
    this.diskInterval = setInterval(() => {
      this.pollWorkerDisk().catch((err) => {
        useLogger().error(`[resource-monitor] disk poll error: ${err instanceof Error ? err.message : err}`);
      });
    }, DISK_POLL_INTERVAL_MS);

    // Don't keep the event loop alive solely for metrics polling.
    if (typeof this.pollInterval.unref === 'function') this.pollInterval.unref();
    if (typeof this.diskInterval.unref === 'function') this.diskInterval.unref();
    useLogger().info('[resource-monitor] started');
  }

  /** Stop both polling intervals (graceful shutdown / dev hot-reload cleanup). */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    if (this.diskInterval) {
      clearInterval(this.diskInterval);
      this.diskInterval = undefined;
    }
  }

  getWorkerMetricsStatus(): WorkerMetricsStatus {
    return { workers: Array.from(this.workers.values()).filter((m) => this.currentMetric(m)).map((m) => this.withLatestDisk(m)) };
  }

  /** Per-worker metrics for one worker, by its UUID `id`. */
  getWorkerMetric(workerId: string): WorkerMetrics | undefined {
    for (const m of this.workers.values()) {
      if (m.workerId === workerId && this.currentMetric(m)) return this.withLatestDisk(m);
    }
    return undefined;
  }

  /** Overlay the latest disk sample (from the slower disk poll) onto a snapshot
   * produced by the fast cpu/mem/net poll, so disk is never stale relative to
   * its own cadence. */
  private withLatestDisk(m: WorkerMetrics): WorkerMetrics {
    const disk = this.workerDisk.get(m.containerName);
    return disk && disk.incarnation === this.containers.get(m.workerId)?.containerId ? { ...m, diskUsedBytes: disk.bytes } : m;
  }

  private currentMetric(m: WorkerMetrics): boolean {
    const current = this.containers.get(m.workerId);
    return current?.status === 'running' && this.incarnations.get(m.containerName) === current.containerId;
  }

  private resetIncarnation(c: ContainerInfo): void {
    if (this.incarnations.get(c.containerName) === c.containerId) return;
    this.incarnations.set(c.containerName, c.containerId);
    this.workers.delete(c.containerName); this.prevWorker.delete(c.containerName); this.workerDisk.delete(c.containerName);
  }

  private diskBytes(c: Pick<ContainerInfo, 'containerName' | 'containerId'>): number {
    const disk = this.workerDisk.get(c.containerName);
    return disk && disk.incarnation === c.containerId ? disk.bytes : 0;
  }

  /** Force an immediate re-sample (used by the manual refresh endpoint) of
   * per-worker cpu/mem/net AND disk. Bypasses the interval overlap guards so a
   * manual refresh reliably samples even when a scheduled poll is mid-flight
   * (otherwise a just-created worker can be missing from the snapshot). */
  async refresh(): Promise<void> {
    await Promise.all([this.pollWorkers(), this.sampleWorkerDisk()]);
  }

  /** Guarded wrapper for the interval — skips if a sample is already running. */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollWorkers();
    } finally {
      this.polling = false;
    }
  }

  private async pollWorkers(): Promise<void> {
    const running = this.containers.list().filter((c) => c.status === 'running');
    const runningNames = new Set(running.map((c) => c.containerName));

    // Drop metrics + samples for workers that are no longer running.
    for (const name of [...this.workers.keys()]) {
      if (!runningNames.has(name)) this.workers.delete(name);
    }
    for (const name of [...this.prevWorker.keys()]) {
      if (!runningNames.has(name)) this.prevWorker.delete(name);
    }
    for (const name of [...this.incarnations.keys()]) {
      if (!runningNames.has(name)) { this.incarnations.delete(name); this.latestStats.delete(name); this.latestDisk.delete(name); }
    }

    await Promise.all(
      running.map(async (c) => {
        if (isWorkerLifecycleMutationActive(c.id)) return;
        const containerId = c.containerId;
        this.resetIncarnation(c);
        const sequence = ++this.sampleSequence;
        this.latestStats.set(c.containerName, sequence);
        const generation = workerLifecycleGeneration(c.id);
        const stale = () => isWorkerLifecycleMutationActive(c.id) || workerLifecycleGeneration(c.id) !== generation ||
          this.containers.get(c.id)?.containerId !== containerId || this.containers.get(c.id)?.status !== 'running' ||
          this.latestStats.get(c.containerName) !== sequence;
        const now = new Date().toISOString();
        try {
          if (c.runtimeKind === 'incus-vm') {
            const sample = await withTimeout(this.containers.incusWorkerMetrics(c.id), STATS_TIMEOUT_MS, `stats(${c.containerName})`);
            if (!stale()) this.workers.set(c.containerName, this.computeIncusMetrics(c, sample, now));
          } else {
            const stats = await withTimeout(this.docker.getContainerStats(containerId), STATS_TIMEOUT_MS, `stats(${c.containerName})`);
            if (!stale()) this.workers.set(c.containerName, this.computeWorkerMetrics(c, stats, now));
          }
        } catch (err) {
          if (stale()) return;
          // Telemetry failures are not evidence that the worker stopped.
          useLogger().warn(`[resource-monitor] stats(${c.containerName}) failed: ${err instanceof Error ? err.message : err}`);
          this.workers.set(c.containerName, {
            workerId: c.id,
            containerName: c.containerName,
            displayName: c.displayName,
            status: 'unknown',
            cpuUtilization: 0,
            memoryUsedBytes: 0,
            memoryLimitBytes: 0,
            memoryUtilization: 0,
            diskUsedBytes: this.diskBytes(c),
            netRxBytesPerSec: 0,
            netTxBytesPerSec: 0,
            blkReadBytesPerSec: 0,
            blkWriteBytesPerSec: 0,
            lastChecked: now,
            error:
              'Worker runtime metrics are unavailable. Retry the request.',
          });
        }
      }),
    );
  }

  private computeWorkerMetrics(
    c: ContainerInfo,
    stats: RawContainerStats,
    now: string,
  ): WorkerMetrics {
    // CPU% as a fraction of total host capacity (0-100). `system_cpu_usage`
    // counts jiffies across every core, so cpuDelta/systemDelta is the share of
    // the whole machine — already 0-1 without multiplying by core count.
    let cpuUtilization = 0;
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);
    if (cpuDelta > 0 && systemDelta > 0) {
      cpuUtilization = this.clampPct((cpuDelta / systemDelta) * 100);
    }

    // Memory — subtract inactive_file/cache to match `docker stats` "real" usage.
    const rawUsage = stats.memory_stats.usage ?? 0;
    const inactive = stats.memory_stats.stats?.inactive_file ?? stats.memory_stats.stats?.cache ?? 0;
    const memoryUsedBytes = Math.max(0, rawUsage - inactive);
    const memoryLimitBytes = stats.memory_stats.limit ?? 0;
    const memoryUtilization = memoryLimitBytes > 0 ? this.clampPct((memoryUsedBytes / memoryLimitBytes) * 100) : 0;

    // Network + block IO — derive a per-second rate from the previous sample.
    let rx = 0;
    let tx = 0;
    for (const net of Object.values(stats.networks ?? {})) {
      rx += net.rx_bytes ?? 0;
      tx += net.tx_bytes ?? 0;
    }
    let blkRead = 0;
    let blkWrite = 0;
    for (const e of stats.blkio_stats?.io_service_bytes_recursive ?? []) {
      if (e.op.toLowerCase() === 'read') blkRead += e.value;
      else if (e.op.toLowerCase() === 'write') blkWrite += e.value;
    }

    const rates = this.counterRates(c, { rx, tx, blkRead, blkWrite });

    return {
      workerId: c.id,
      containerName: c.containerName,
      displayName: c.displayName,
      status: c.status,
      cpuUtilization,
      memoryUsedBytes,
      memoryLimitBytes,
      memoryUtilization,
      diskUsedBytes: this.diskBytes(c),
      ...rates,
      lastChecked: now,
    };
  }

  private counterRates(c: ContainerInfo, counters: Omit<WorkerSample, 'incarnation' | 't'>) {
    const t = Date.now(), prev = this.prevWorker.get(c.containerName);
    this.prevWorker.set(c.containerName, { ...counters, incarnation: c.containerId, t });
    const dt = prev ? (t - prev.t) / 1000 : 0;
    // Guest reboot may reset counters without replacing the VM UUID.
    const valid = prev && dt > 0 && prev.incarnation === c.containerId && prev.cpuCount === counters.cpuCount &&
      (['rx', 'tx', 'blkRead', 'blkWrite', 'cpu'] as const).every((key) =>
        counters[key] === undefined || prev[key] !== undefined && counters[key]! >= prev[key]!);
    const rate = (key: 'rx' | 'tx' | 'blkRead' | 'blkWrite') => valid ? (counters[key] - prev[key]) / dt : 0;
    return { netRxBytesPerSec: rate('rx'), netTxBytesPerSec: rate('tx'),
      blkReadBytesPerSec: rate('blkRead'), blkWriteBytesPerSec: rate('blkWrite') };
  }

  private computeIncusMetrics(c: ContainerInfo, sample: Awaited<ReturnType<ContainerManager['incusWorkerMetrics']>>, now: string): WorkerMetrics {
    const { state, cpuCount, primaryMac } = sample;
    const cpu = state.cpu?.usage, memory = state.memory;
    if (state.status !== 'Running' || state.processes === -1 || !Number.isFinite(cpu) || cpu! < 0 ||
        !memory || !Number.isFinite(memory.usage) || memory.usage < 0 || !Number.isFinite(memory.total) || memory.total <= 0 ||
        !Number.isFinite(cpuCount) || cpuCount < 1)
      throw new Error('Incus guest metrics are unavailable');
    const interfaces = Object.values(state.network ?? {}).filter((nic) =>
      !!primaryMac && nic.hwaddr?.toLowerCase() === primaryMac.toLowerCase());
    if (interfaces.length !== 1 || !interfaces[0]!.counters) throw new Error('Incus primary NIC metrics are unavailable');
    const { bytes_received: rx, bytes_sent: tx } = interfaces[0]!.counters!;
    if (![rx, tx].every((n) => Number.isFinite(n) && n >= 0)) throw new Error('Incus NIC counters are invalid');
    const prev = this.prevWorker.get(c.containerName), dt = prev ? (Date.now() - prev.t) / 1000 : 0;
    const valid = prev?.incarnation === c.containerId && prev.cpuCount === cpuCount && prev.cpu !== undefined &&
      cpu! >= prev.cpu && rx >= prev.rx && tx >= prev.tx && dt > 0;
    const cpuUtilization = valid ? this.clampPct((cpu! - prev.cpu!) / (dt * 1e9 * cpuCount) * 100) : 0;
    const rates = this.counterRates(c, { cpu, cpuCount, rx, tx, blkRead: 0, blkWrite: 0 });
    return { workerId: c.id, containerName: c.containerName, displayName: c.displayName, status: c.status,
      cpuUtilization, cpuCapacity: 'worker', memoryUsedBytes: memory.usage, memoryLimitBytes: memory.total,
      memoryUtilization: this.clampPct(memory.usage / memory.total * 100), diskUsedBytes: this.diskBytes(c),
      ...rates, lastChecked: now };
  }

  // --- Per-worker disk usage (slow poll) ---

  /** Guarded wrapper for the interval — skips if a sample is already running so
   * a slow `du` can't stack the next tick. */
  private async pollWorkerDisk(): Promise<void> {
    if (this.diskPolling) return;
    this.diskPolling = true;
    try {
      await this.sampleWorkerDisk();
    } finally {
      this.diskPolling = false;
    }
  }

  /** The actual disk sample — unguarded, so `refresh()` always runs it. */
  private async sampleWorkerDisk(): Promise<void> {
    const running = this.containers.list().filter((c) => c.status === 'running');
    const names = new Set(running.map((c) => c.containerName));
    for (const name of [...this.workerDisk.keys()]) {
      if (!names.has(name)) this.workerDisk.delete(name);
    }
    await Promise.all(
      running.map(async (c) => {
        if (isWorkerLifecycleMutationActive(c.id)) return;
        this.resetIncarnation(c);
        const containerId = c.containerId, generation = workerLifecycleGeneration(c.id), sequence = ++this.sampleSequence;
        this.latestDisk.set(c.containerName, sequence);
        try {
          const bytes = c.runtimeKind === 'incus-vm' ? await this.containers.incusWorkerDiskUsageBytes(c.id)
            : await this.docker.getWorkerDiskUsageBytes(containerId);
          if (!isWorkerLifecycleMutationActive(c.id) && workerLifecycleGeneration(c.id) === generation &&
              this.containers.get(c.id)?.containerId === containerId && this.containers.get(c.id)?.status === 'running' &&
              this.latestDisk.get(c.containerName) === sequence &&
              Number.isFinite(bytes) && bytes >= 0)
            this.workerDisk.set(c.containerName, { bytes, incarnation: containerId });
        } catch {
          // Keep the last known value on a transient failure.
        }
      }),
    );
  }

  private clampPct(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, n));
  }
}
