import { hostname } from 'node:os';
import Docker from 'dockerode';
import type { LogStore } from './log-store';
import type { LogBroadcaster } from './log-broadcaster';
import type { Config } from './config';
import type { LogLevel, LogSource, LogEntry } from '../../shared/types';
import { shouldLog } from './log-levels';
import { useContainerManager } from './services';
import { withOperationDeadline } from './operation-deadline';
import { StringDecoder } from 'node:string_decoder';
import type { ContainerManager } from './container';

const LOG_DOCKER_TIMEOUT_MS = 8_000;

interface AttachedStream {
  stream: NodeJS.ReadableStream;
  source: LogSource;
  containerName: string;
  displayName?: string;
  destroy: () => void;
}

export interface AttachOptions {
  // When true, only logs after now are captured. When false (default), all
  // logs since container start are captured. Use sinceNow=true on orchestrator
  // startup to avoid re-ingesting historical entries already on disk.
  sinceNow?: boolean;
}

export class LogCollector {
  private docker: Docker;
  private logStore: LogStore;
  private broadcaster: LogBroadcaster;
  private config: Config;
  private attached: Map<string, AttachedStream> = new Map();
  private pendingIncus = new Map<string, AbortController>();

  constructor(config: Config, logStore: LogStore, broadcaster: LogBroadcaster,
    private getContainers: () => ContainerManager = useContainerManager) {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.logStore = logStore;
    this.broadcaster = broadcaster;
    this.config = config;
  }

  // Attach to the orchestrator's own container so framework/runtime stdout
  // (Nuxt, Nitro, Vite, console.warn outside useLogger, unhandled errors) is
  // captured alongside intentional useLogger() output. Source is 'orchestrator'.
  async attachSelf(): Promise<void> {
    try {
      const id = hostname();
      const container = this.docker.getContainer(id);
      const info = await withOperationDeadline(
        (signal) => container.inspect({ abortSignal: signal }),
        LOG_DOCKER_TIMEOUT_MS,
        'Docker self-log inspection',
      );
      const name = (info.Name || '').replace(/^\//, '') || id;
      await this.attach(name, info.Id, 'orchestrator', undefined, { sinceNow: true });
    } catch {
      // Not running in Docker or container not visible — skip silently.
    }
  }

  async init(): Promise<void> {
    // Attach to all running managed containers (workers + traefik). Use
    // sinceNow so an orchestrator restart does not replay historical lines
    // that were already written to disk during the previous lifetime.
    let containers: Docker.ContainerInfo[];
    try {
      containers = await withOperationDeadline(
        (signal) => this.docker.listContainers({
          filters: { label: ['agentor.managed'] },
          abortSignal: signal,
        }),
        LOG_DOCKER_TIMEOUT_MS,
        'Docker log-collector inventory',
      );
    } catch {
      containers = [];
    }

    for (const info of containers) {
      const name = (info.Names[0] || '').replace(/^\//, '');
      const labelValue = info.Labels['agentor.managed'] || '';

      let source: LogSource;
      if (labelValue === 'traefik') source = 'traefik';
      else source = 'worker';

      // Workers carry no `agentor.display-name` label (labels are deliberately
      // minimal — only `agentor.managed` + `agentor.id`). Resolve the friendly
      // display name from the container manager, which `reconcileWorkers()` has
      // already populated by the time this runs, so re-attached worker logs
      // keep their `sourceName` after an orchestrator restart.
      const displayName = source === 'worker'
        ? this.getContainers().findByContainerName(name)?.displayName
        : undefined;
      await this.attach(name, info.Id, source, displayName, { sinceNow: true });
    }
    for (const worker of this.getContainers().list()) {
      if (worker.runtimeKind === 'incus-vm' && worker.status === 'running')
        await this.attach(worker.containerName, worker.containerId, 'worker', worker.displayName, { sinceNow: true });
    }
  }

  async attach(
    containerName: string,
    containerId: string,
    source: LogSource,
    displayName?: string,
    options: AttachOptions = {},
  ): Promise<void> {
    if (this.attached.has(containerId)) return;
    if (source === 'worker' && containerId.startsWith('incus:')) {
      await this.attachIncus(containerName, containerId, displayName, options);
      return;
    }

    try {
      const container = this.docker.getContainer(containerId);
      const logsOpts: { follow: true; stdout: true; stderr: true; timestamps: true; since?: number } = {
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
      };
      if (options.sinceNow) {
        logsOpts.since = Math.floor(Date.now() / 1000);
      }
      const stream = await withOperationDeadline(
        (signal) => container.logs({ ...logsOpts, abortSignal: signal }),
        LOG_DOCKER_TIMEOUT_MS,
        'Docker log stream setup',
      );

      const containerInfo = await withOperationDeadline(
        (signal) => container.inspect({ abortSignal: signal }),
        LOG_DOCKER_TIMEOUT_MS,
        'Docker log-container inspection',
      );
      const isTty = containerInfo.Config?.Tty ?? false;

      const ingest = (line: string, levelOverride?: LogLevel) => {
        const entry = this.parseLine(line, source, containerName, displayName);
        if (!entry) return;
        if (levelOverride) entry.level = levelOverride;
        if (!shouldLog(entry.level, this.config.logLevel)) return;
        // Orchestrator self-capture writes to the orchestrator log file so
        // it sits alongside useLogger() entries. Worker/traefik entries go
        // to the containers log.
        const category: 'orchestrator' | 'containers' = source === 'orchestrator' ? 'orchestrator' : 'containers';
        this.logStore.append(entry, category);
        this.broadcaster.broadcast(entry);
      };

      const makeLineHandler = (levelOverride?: LogLevel) => {
        let buffer = '';
        return (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          // Split on either \r\n (TTY mode) or bare \n. A trailing \r on its
          // own line was previously breaking the timestamp regex's $ anchor.
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            ingest(line, levelOverride);
          }
        };
      };

      let destroy: () => void;

      if (isTty) {
        const onData = makeLineHandler();
        (stream as NodeJS.ReadableStream).on('data', onData);
        destroy = () => {
          try {
            (stream as NodeJS.ReadableStream).removeAllListeners();
            const s = stream as NodeJS.ReadableStream & { destroy?: () => void };
            if (typeof s.destroy === 'function') s.destroy();
          } catch {}
        };
      } else {
        // Non-TTY streams are 8-byte-framed multiplexed stdout/stderr. Each
        // demuxed side gets its own buffer so partial lines from one stream
        // never get glued onto the other.
        const { PassThrough } = await import('node:stream');
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        this.docker.modem.demuxStream(stream, stdout, stderr);
        stdout.on('data', makeLineHandler());
        stderr.on('data', makeLineHandler('error'));
        destroy = () => {
          try {
            stdout.removeAllListeners();
            stderr.removeAllListeners();
            stdout.destroy();
            stderr.destroy();
            const s = stream as NodeJS.ReadableStream & { destroy?: () => void };
            if (typeof s.destroy === 'function') s.destroy();
          } catch {}
        };
      }

      this.attached.set(containerId, {
        stream: stream as NodeJS.ReadableStream,
        source,
        containerName,
        displayName,
        destroy,
      });
      (stream as NodeJS.ReadableStream).once('error', (error) => {
        if (source === 'worker') {
          const worker = this.getContainers().findByContainerName(containerName);
          if (worker)
            this.getContainers().reportRuntimeFailure(
              worker.id,
              'Docker worker log stream',
              error,
              containerId,
            );
        }
        this.detach(containerId);
      });
    } catch (error) {
      if (source === 'worker') {
        const worker = this.getContainers().findByContainerName(containerName);
        if (worker)
          this.getContainers().reportRuntimeFailure(
            worker.id,
            'Docker worker log attachment',
            error,
            containerId,
          );
      }
    }
  }

  /** Idempotent retry on the existing periodic worker reconciliation. Avoid
   * replaying old journal lines after a transient failure or guest reboot. */
  async reconcileIncus(): Promise<void> {
    for (const worker of this.getContainers().list()) {
      if (worker.runtimeKind === 'incus-vm' && worker.status === 'running')
        await this.attach(worker.containerName, worker.containerId, 'worker', worker.displayName, { sinceNow: true });
    }
  }

  private async attachIncus(containerName: string, containerId: string, displayName: string | undefined, options: AttachOptions): Promise<void> {
    if (this.pendingIncus.has(containerId)) return;
    const controller = new AbortController();
    this.pendingIncus.set(containerId, controller);
    try {
      const manager = this.getContainers(), worker = manager.findByContainerName(containerName);
      if (!worker || worker.runtimeKind !== 'incus-vm' || worker.containerId !== containerId) return;
      const ownerId = worker.userId;
      const session = await manager.openWorkerJournal(worker.id, { follow: true, sinceNow: options.sinceNow, signal: controller.signal });
      if (controller.signal.aborted || manager.get(worker.id)?.containerId !== containerId) { session.close(); return; }
      const attached: AttachedStream = { stream: session.stdout, source: 'worker', containerName, displayName,
        destroy: () => { controller.abort(); session.close(); } };
      this.attached.set(containerId, attached);
      const finish = () => { if (this.attached.get(containerId) === attached) this.detach(containerId); };
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      session.stdout.on('data', (chunk: Buffer) => {
        const current = manager.get(worker.id);
        if (!session.isCurrent() || current?.runtimeKind !== 'incus-vm' || current.containerId !== containerId || current.userId !== ownerId) { finish(); return; }
        buffer += decoder.write(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = (lines.pop() || '').slice(-64 * 1024);
        for (const line of lines) {
          const entry = this.parseLine(line.slice(0, 64 * 1024), 'worker', containerName, displayName);
          if (!entry || !shouldLog(entry.level, this.config.logLevel)) continue;
          this.logStore.append(entry, 'containers'); this.broadcaster.broadcast(entry);
        }
      });
      session.stderr.on('error', finish); session.stderr.resume();
      session.stdout.once('error', finish); session.stdout.once('end', finish); session.stdout.once('close', finish);
      void session.result.then(finish, finish);
    } catch {
      // A journal failure is telemetry failure, never a lifecycle failure.
      // Normal reconciliation can retry attachment on a subsequent pass.
    } finally {
      if (this.pendingIncus.get(containerId) === controller) this.pendingIncus.delete(containerId);
    }
  }

  detach(containerId: string): void {
    this.pendingIncus.get(containerId)?.abort();
    this.pendingIncus.delete(containerId);
    const attached = this.attached.get(containerId);
    if (attached) {
      attached.destroy();
      this.attached.delete(containerId);
    }
  }

  detachAll(): void {
    for (const controller of this.pendingIncus.values()) controller.abort();
    this.pendingIncus.clear();
    for (const [id] of this.attached) {
      this.detach(id);
    }
  }

  private parseLine(line: string, source: LogSource, containerName: string, displayName?: string): LogEntry | null {
    // Docker timestamp format: 2026-03-11T14:30:00.123456789Z <message>
    let timestamp: string;
    let message: string;

    // Trim a trailing \r defensively in case any caller bypassed the splitter.
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;

    const tsMatch = clean.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/);
    if (tsMatch) {
      const raw = tsMatch[1]!;
      const parsed = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + 'Z');
      timestamp = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
      message = tsMatch[2]!;
    } else {
      timestamp = new Date().toISOString();
      message = clean;
    }

    if (!message.trim()) return null;

    const level = this.detectLevel(message);

    const entry: LogEntry = {
      timestamp,
      level,
      source,
      sourceId: containerName,
      message: message.trim(),
    };
    if (displayName) entry.sourceName = displayName;
    return entry;
  }

  private detectLevel(message: string): LogLevel {
    const lower = message.toLowerCase();
    if (lower.includes('[error]') || lower.includes('error:') || lower.startsWith('err ') || lower.includes(' err ')) return 'error';
    if (lower.includes('[warn]') || lower.includes('warning:') || lower.includes(' warn ') || lower.startsWith('warn ')) return 'warn';
    if (lower.includes('[debug]') || lower.includes('debug:') || lower.startsWith('debug ')) return 'debug';
    return 'info';
  }
}
