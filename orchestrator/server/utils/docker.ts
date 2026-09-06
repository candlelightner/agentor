import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { Duplex, Readable } from 'node:stream';
import type { Config } from './config';
import { getAppType } from './apps';
import { renderUserEnvVars } from './user-env-store';
import type { MountConfig, TmuxWindow, AppInstanceInfo, NetworkMode, ExposeApis, UserEnvVars, FileEntry } from '../../shared/types';
import type { StorageManager } from './storage';
import type { ExecCaptureResult } from './workspace-probe';
import type { PersistentPathMount } from './persistent-backup-paths';
import {
  validateHostMountCatalogSource,
  validateHostMountTarget,
} from './host-mount-store';
import { withOperationDeadline } from './operation-deadline';

export interface EnvironmentJsonPayload {
  networkMode: string;
  allowedDomains: string[];
  dockerEnabled: boolean;
  setupScript: string;
  envVars: string;
  exposeApis: ExposeApis;
}

export interface CapabilityJsonEntry {
  name: string;
  content: string;
}

export interface InstructionJsonEntry {
  name: string;
  content: string;
}

export interface WorkerJsonPayload {
  id: string;
  displayName: string;
  repos: { provider: string; url: string; branch?: string }[];
  initScript: string;
  gitName: string;
  gitEmail: string;
}

/** Runtime image config replicated onto a container created from an *imported*
 * image (`docker import` strips all config), so it boots like the standard
 * worker image. Sourced from the standard image's own config at import time. */
export interface ImageConfigOverride {
  Entrypoint?: string[];
  Cmd?: string[];
  WorkingDir?: string;
  User?: string;
  Env?: string[];
}

/** Subset of the Docker container stats payload the resource monitor reads.
 * CPU% is derived from `total_usage`/`system_cpu_usage`/`online_cpus`; the
 * unused `percpu_usage` array is omitted. `cache` is read as a fallback for
 * `inactive_file` in the memory accounting. */
export interface RawContainerStats {
  cpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
  };
  memory_stats: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number; cache?: number };
  };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
  blkio_stats?: { io_service_bytes_recursive?: { op: string; value: number }[] };
}

const MANAGED_LABEL = 'agentor.managed';
/** The worker's UUID `id` — the only identifying label on a worker container.
 * Owner + config live in the WorkerStore record, not in labels. */
const ID_LABEL = 'agentor.id';
const DOCKER_READ_TIMEOUT_MS = 10_000;
const DOCKER_EXEC_TIMEOUT_MS = 30_000;
const DOCKER_LIFECYCLE_TIMEOUT_MS = 30_000;
const DOCKER_TRANSFER_SETUP_TIMEOUT_MS = 15_000;
const DOCKER_IMAGE_TIMEOUT_MS = 10 * 60_000;
// A complete feature-rich worker rootfs is several gigabytes. Nested Docker
// and slower production disks can legitimately need well over ten minutes to
// ingest it; keep the operation bounded without converting a healthy streamed
// import into a misleading standard-image fallback.
const DOCKER_ROOTFS_IMPORT_TIMEOUT_MS = 40 * 60_000;

/** Validate host-mount request shape or, at the final Docker boundary, a fully
 * resolved catalog mount. Authorization is intentionally performed by the
 * HostMountStore; this function is the independent structural backstop. */
export function validateMounts(
  mounts: MountConfig[] | undefined,
  dataHostPath = '',
  resolved = false,
): string | null {
  for (const m of mounts || []) {
    if (!m || typeof m !== 'object') return 'each mount must be an object';
    if (typeof m.pathId !== 'string' || !m.pathId)
      return 'host mounts must reference an approved pathId; ask the platform administrator to approve and assign the host path';
    if (m.readOnly !== undefined && typeof m.readOnly !== 'boolean')
      return 'mount readOnly must be a boolean';
    try {
      validateHostMountTarget(m.target);
      if (resolved) {
        if (typeof m.source !== 'string' || !m.source)
          return 'resolved host mount source is missing';
        validateHostMountCatalogSource(m.source, dataHostPath);
      } else if (m.source !== undefined && typeof m.source !== 'string') {
        return 'mount source must be a string when supplied';
      }
    } catch (error) {
      return error instanceof Error ? error.message : 'invalid host mount';
    }
  }
  return null;
}

export class DockerService {
  private docker: Docker;
  private config: Config;

  constructor(config: Config) {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.config = config;
  }

  async ensureNetwork(): Promise<void> {
    const networks = await withOperationDeadline(
      (operationSignal) => this.docker.listNetworks({
        filters: { name: [this.config.dockerNetwork] },
        abortSignal: operationSignal,
      }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker network inspection',
    );
    if (networks.length === 0) {
      await withOperationDeadline(
        (operationSignal) => this.docker.createNetwork({
          Name: this.config.dockerNetwork,
          Driver: 'bridge',
          abortSignal: operationSignal,
        }),
        DOCKER_LIFECYCLE_TIMEOUT_MS,
        'Docker network creation',
      );
      useLogger().info(`[docker] created network ${this.config.dockerNetwork}`);
    }
  }

  async createWorkerContainer(opts: {
    /** Owner user id — used for directory paths and env var injection. */
    userId: string;
    /** Worker UUID `id` (immutable internal identity) — used for the `agentor.id`
     * label and the workspace/agents dir leaf. The container's hostname is left
     * to Docker's default (the short container id). */
    id: string;
    /** Globally unique Docker container name (`<prefix>-<id>`). */
    containerName: string;
    cpuLimit?: number;
    memoryLimit?: string;
    mounts?: MountConfig[];
    dockerEnabled?: boolean;
    credentialBinds?: string[];
    /** Trusted named volumes generated from explicit backup-directory
     * selections; never accepts client-selected Docker sources. */
    persistentPathMounts?: PersistentPathMount[];
    environmentJson: EnvironmentJsonPayload;
    capabilitiesJson: CapabilityJsonEntry[];
    instructionsJson: InstructionJsonEntry[];
    workerJson: WorkerJsonPayload;
    storageManager?: StorageManager;
    /** Per-user env vars (agent API keys, GitHub token, custom). Already
     * resolved against the worker owner's account by the container manager. */
    userEnv: UserEnvVars;
    /** Decrypted only at the final container-creation boundary. Values are
     * never logged; secret files are materialized into an ephemeral tmpfs. */
    workerConfig?: Array<{ kind: 'variable' | 'secret' | 'secretFile'; key: string; value: string; fileName?: string }>;
    /** Image to run. Defaults to the standard worker image; set to a per-worker
     * imported image (from `docker import`) for restored workers. */
    image?: string;
    /** When false, the container is created but not started (used by import so
     * the volumes can be populated before the entrypoint runs). Defaults to true. */
    start?: boolean;
    /** Runtime config to apply when running an imported image (which has no
     * baked entrypoint/env). Ignored for the standard image. */
    imageConfig?: ImageConfigOverride;
  }): Promise<Docker.Container> {
    const env: string[] = [];

    // When running an imported image (no baked config), seed the base env
    // (PATH, LANG, …) from the original image so binaries resolve.
    if (opts.imageConfig?.Env?.length) env.push(...opts.imageConfig.Env);

    // 4 structured JSON env vars
    env.push(`ENVIRONMENT=${JSON.stringify(opts.environmentJson)}`);
    env.push(`CAPABILITIES=${JSON.stringify(opts.capabilitiesJson)}`);
    env.push(`INSTRUCTIONS=${JSON.stringify(opts.instructionsJson)}`);
    env.push(`WORKER=${JSON.stringify(opts.workerJson)}`);

    // Agent API keys, git provider tokens, and custom env vars — all
    // sourced from the worker owner's per-user account in a single pass
    // via `renderUserEnvVars`. CustomEnvVars entries can override well-known
    // slots using the same KEY.
    for (const line of renderUserEnvVars(opts.userEnv)) {
      // Reserved internal identity is supplied below by this trusted creation
      // path. Do not permit a duplicate account variable whose ordering could
      // be interpreted differently by an OCI runtime or process launcher.
      if (line.startsWith('AGENTOR_RUNTIME_ROLE=')) continue;
      env.push(line);
    }

    const localEnv = (opts.workerConfig ?? []).filter((entry) => entry.kind === 'variable').map(({ key, value }) => ({ key, value }));
    if (localEnv.length) env.push(`WORKER_LOCAL_ENV=${Buffer.from(JSON.stringify(localEnv)).toString('base64')}`);
    const hasSensitiveWorkerConfig = (opts.workerConfig ?? []).some((entry) => entry.kind !== 'variable');
    if (hasSensitiveWorkerConfig) env.push('WORKER_SECRET_HANDSHAKE=1');

    env.push('ORCHESTRATOR_URL=http://agentor-orchestrator:3000');
    env.push(`WORKER_CONTAINER_NAME=${opts.containerName}`);
    // Internal authoritative runtime identity. This method provisions only
    // ordinary workers; append after all account/worker values so custom
    // environment data cannot select a privileged guidance role.
    env.push('AGENTOR_RUNTIME_ROLE=worker');

    const memBytes = opts.memoryLimit ? this.parseMemoryLimit(opts.memoryLimit) : 0;
    const nanoCpus = opts.cpuLimit ? Math.floor(opts.cpuLimit * 1e9) : 0;

    // Defense in depth — the API boundary already validates mounts, but
    // re-check here so import/rebuild paths can never build an unsafe bind
    // string (a `:` in either side could inject extra Docker mount options;
    // the Docker socket / data dir are off-limits).
    const mountError = validateMounts(
      opts.mounts,
      opts.storageManager?.dataHostPath || '',
      true,
    );
    if (mountError) {
      const err = new Error(mountError) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const binds = (opts.mounts || []).map(
      (m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
    );

    // Persistent workspace — named volume (volume mode) or host directory under
    // the user's data dir (directory mode).
    if (opts.storageManager) {
      await opts.storageManager.ensureWorkerDirs(opts.userId, opts.id);
      binds.push(opts.storageManager.getWorkerWorkspaceBind(opts.userId, opts.id, opts.containerName));
      binds.push(opts.storageManager.getWorkerAgentsBind(opts.userId, opts.id, opts.containerName));
      if (opts.dockerEnabled) {
        binds.push(opts.storageManager.getWorkerDockerBind(opts.containerName));
      }
    } else {
      binds.push(`${opts.containerName}-workspace:/workspace`);
      binds.push(`${opts.containerName}-agents:/home/agent/.agent-data`);
      if (opts.dockerEnabled) {
        binds.push(`${opts.containerName}-docker:/var/lib/docker`);
      }
    }

    if (opts.credentialBinds?.length) {
      binds.push(...opts.credentialBinds);
    }

    const image = opts.image || this.config.workerImagePrefix + this.config.workerImage;
    await this.ensureImage(image);

    // Add CAP_NET_ADMIN when network restrictions are needed (for iptables)
    // Docker-in-Docker requires --privileged (which implies all caps)
    const networkMode = opts.environmentJson.networkMode;
    const needsNetAdmin = networkMode && networkMode !== 'full';
    const capAdd = needsNetAdmin && !opts.dockerEnabled ? ['NET_ADMIN'] : [];

    const cfg = opts.imageConfig;
    const container = await withOperationDeadline((operationSignal) => this.docker.createContainer({
      Image: image,
      name: opts.containerName,
      // Hostname is left unset — Docker defaults it to the short container id
      // (e.g. `16b082a7681b`), so the in-container prompt looks like a normal
      // Docker container. The worker's identity lives in the `agentor.id` label.
      Env: env,
      Tty: true,
      OpenStdin: true,
      // Imported images carry no config — replicate the standard image's
      // entrypoint/cmd/workdir/user so the restored worker boots identically.
      ...(cfg?.Entrypoint ? { Entrypoint: cfg.Entrypoint } : {}),
      ...(cfg?.Cmd ? { Cmd: cfg.Cmd } : {}),
      ...(cfg?.WorkingDir ? { WorkingDir: cfg.WorkingDir } : {}),
      ...(cfg?.User ? { User: cfg.User } : {}),
      Labels: {
        [MANAGED_LABEL]: 'true',
        [ID_LABEL]: opts.id,
      },
      HostConfig: {
        NetworkMode: this.config.dockerNetwork,
        ...(nanoCpus > 0 ? { NanoCpus: nanoCpus } : {}),
        ...(memBytes > 0 ? { Memory: memBytes } : {}),
        ...(capAdd.length > 0 ? { CapAdd: capAdd } : {}),
        ...(opts.dockerEnabled ? { Privileged: true } : {}),
        Init: true,
        // A Docker-daemon-only restart cannot repopulate ephemeral secrets.
        // Keep secret-bearing workers stopped until the orchestrator can run
        // the authenticated bootstrap handshake; non-secret workers retain the
        // existing automatic restart behavior.
        RestartPolicy: { Name: hasSensitiveWorkerConfig ? 'no' : 'unless-stopped' },
        ShmSize: 512 * 1024 * 1024,
        Binds: binds.length > 0 ? binds : undefined,
        Mounts: (opts.persistentPathMounts?.length
          ? opts.persistentPathMounts.map((mount) => ({
              Type: 'volume' as const,
              Source: mount.source,
              Target: mount.target,
              VolumeOptions: { NoCopy: true },
            }))
          : undefined) as any,
        Tmpfs: { '/run/agentor-secrets': 'rw,nosuid,nodev,noexec,mode=0711,uid=0,gid=0,size=16777216' },
      },
      abortSignal: operationSignal,
    }), DOCKER_LIFECYCLE_TIMEOUT_MS, 'Docker worker creation');

    if (opts.start !== false) {
      try {
        await withOperationDeadline(
          (operationSignal) => container.start({ abortSignal: operationSignal }),
          DOCKER_LIFECYCLE_TIMEOUT_MS,
          'Docker worker start',
        );
        await this.materializeWorkerSecretFiles(container.id, opts.workerConfig ?? []);
      } catch (err) {
        await withOperationDeadline(
          (operationSignal) => container.remove({ force: true, abortSignal: operationSignal } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
          DOCKER_LIFECYCLE_TIMEOUT_MS,
          'Docker failed-worker cleanup',
        ).catch(() => {});
        throw err;
      }
    }
    useLogger().info(`[docker] created container ${opts.containerName}${opts.image ? ` (image ${opts.image})` : ''}`);
    return container;
  }

  async listContainers(): Promise<Docker.ContainerInfo[]> {
    return withOperationDeadline(
      (operationSignal) => this.docker.listContainers({
        all: true,
        filters: { label: [`${MANAGED_LABEL}=true`] },
        abortSignal: operationSignal,
      }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker worker inventory',
    );
  }

  /** Administrative runtimes deliberately use `agentor.managed=false`, so
   * they must never be discovered through the ordinary worker inventory.
   * Keep this separate label-filtered query for privileged source-IP identity
   * resolution; callers still validate the live workspace record, container
   * registration, immutable labels, and private management network. */
  async listAdministrativeContainers(): Promise<Docker.ContainerInfo[]> {
    return withOperationDeadline(
      (operationSignal) => this.docker.listContainers({
        all: true,
        filters: { label: ["agentor.administrative=true"] },
        abortSignal: operationSignal,
      }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker administrative workspace inventory',
    );
  }

  async execAttachTmuxWindow(
    containerId: string,
    windowIndex: number
  ): Promise<{ exec: Docker.Exec; stream: Duplex; tmuxSession: string }> {
    const container = this.docker.getContainer(containerId);
    const tmuxSession = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Each WebSocket gets a linked session (shares windows with 'main' but has
    // its own current-window pointer). Cleaned up explicitly on disconnect.
    const attachExec = await withOperationDeadline((operationSignal) => container.exec({
      Cmd: [
        'sh', '-c',
        `tmux new-session -d -t main -s "${tmuxSession}" && { tmux select-window -t "${tmuxSession}:${windowIndex}" 2>/dev/null || true; } && exec tmux attach-session -t "${tmuxSession}"`,
      ],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      abortSignal: operationSignal,
    }), DOCKER_EXEC_TIMEOUT_MS, 'Docker terminal setup');

    const stream = (await withOperationDeadline((operationSignal) => attachExec.start({
      Detach: false,
      Tty: true,
      hijack: true,
      stdin: true,
      abortSignal: operationSignal,
    }), DOCKER_EXEC_TIMEOUT_MS, 'Docker terminal attach')) as Duplex;

    return { exec: attachExec, stream, tmuxSession };
  }

  async killTmuxSession(containerId: string, sessionName: string): Promise<void> {
    try {
      await this.execTmux(containerId, ['kill-session', '-t', sessionName]);
    } catch {}
  }

  async execTmux(containerId: string, args: string[]): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const exec = await withOperationDeadline((operationSignal) => container.exec({
      Cmd: ['tmux', ...args],
      AttachStdout: true,
      AttachStderr: true,
      abortSignal: operationSignal,
    }), DOCKER_EXEC_TIMEOUT_MS, 'Docker tmux command setup');
    const stream = await withOperationDeadline(
      (operationSignal) => exec.start({ Detach: false, Tty: false, abortSignal: operationSignal }),
      DOCKER_EXEC_TIMEOUT_MS,
      'Docker tmux command start',
    );
    // Drain the stream so the command has completed before we resolve. tmux
    // rename/kill of a non-existent window is intentionally idempotent (a silent
    // no-op returning 200), so we deliberately do NOT fail on a non-zero exit
    // here; createTmuxWindow verifies success by re-listing windows instead.
    await withOperationDeadline(
      this.streamToString(stream),
      DOCKER_EXEC_TIMEOUT_MS,
      'Docker tmux command',
    ).catch((error) => {
      (stream as Duplex).destroy();
      throw error;
    });
  }

  async execListTmuxWindows(containerId: string): Promise<TmuxWindow[]> {
    const container = this.docker.getContainer(containerId);
    const exec = await withOperationDeadline((operationSignal) => container.exec({
      Cmd: [
        'tmux',
        'list-windows',
        '-t',
        'main:',
        '-F',
        '#{window_index}:#{window_name}:#{window_active}',
      ],
      AttachStdout: true,
      AttachStderr: true,
      abortSignal: operationSignal,
    }), DOCKER_EXEC_TIMEOUT_MS, 'Docker tmux listing setup');

    const stream = await withOperationDeadline(
      (operationSignal) => exec.start({ Detach: false, Tty: true, abortSignal: operationSignal }),
      DOCKER_EXEC_TIMEOUT_MS,
      'Docker tmux listing start',
    );
    const output = await withOperationDeadline(
      this.streamToString(stream),
      DOCKER_EXEC_TIMEOUT_MS,
      'Docker tmux listing',
    ).catch((error) => {
      (stream as Duplex).destroy();
      throw error;
    });

    return output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(':');
        return {
          index: parseInt(parts[0] ?? '0', 10),
          name: parts[1] ?? '',
          active: parts[2] === '1',
        };
      });
  }

  async resizeExec(execId: string, cols: number, rows: number): Promise<void> {
    const exec = this.docker.getExec(execId);
    await withOperationDeadline(
      (operationSignal) => exec.resize({ h: rows, w: cols, abortSignal: operationSignal }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker terminal resize',
    );
  }

  /** Read the tail of a container's logs as a single string. Assumes a TTY
   * container (raw stream) — worker containers always run with `Tty: true`, so
   * the output has no 8-byte multiplex framing. The centralized `LogCollector`
   * handles non-TTY demuxing separately. */
  async getLogs(
    containerId: string,
    tail: number = 200
  ): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const logs = await withOperationDeadline(
      (operationSignal) => container.logs({
        stdout: true,
        stderr: true,
        tail,
        follow: false,
        abortSignal: operationSignal,
      }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker worker log read',
    );
    return logs.toString();
  }

  async stopContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await withOperationDeadline(
      (operationSignal) => container.stop({ t: 15, abortSignal: operationSignal }),
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      'Docker worker stop',
    );
    useLogger().debug(`[docker] stopped container ${containerId.slice(0, 12)}`);
  }

  async removeContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await withOperationDeadline(
      (operationSignal) => container.remove({ force: true, abortSignal: operationSignal } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      'Docker worker removal',
    );
    useLogger().debug(`[docker] removed container ${containerId.slice(0, 12)}`);
  }

  async removeVolume(name: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(name);
      await withOperationDeadline(
        (operationSignal) => volume.remove({ abortSignal: operationSignal }),
        DOCKER_LIFECYCLE_TIMEOUT_MS,
        'Docker volume removal',
      );
      useLogger().debug(`[docker] removed volume ${name}`);
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number })
        ?.statusCode ?? (error as { status?: number })?.status;
      if (status !== 404) throw error;
    }
  }

  async restartContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await withOperationDeadline(
      (operationSignal) => container.restart({ t: 15, abortSignal: operationSignal }),
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      'Docker worker restart',
    );
  }

  async startContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await withOperationDeadline(
      (operationSignal) => container.start({ abortSignal: operationSignal }),
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      'Docker worker start',
    );
  }

  async killContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await withOperationDeadline(
      (operationSignal) => container.kill({ signal: 'SIGKILL', abortSignal: operationSignal }),
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      'Docker worker SIGKILL',
    );
  }

  async updateContainerRestartPolicy(
    containerId: string,
    sensitive: boolean,
  ): Promise<void> {
    await withOperationDeadline(
      (operationSignal) => this.docker.getContainer(containerId).update({
        RestartPolicy: { Name: sensitive ? 'no' : 'unless-stopped' },
        abortSignal: operationSignal,
      }),
      DOCKER_LIFECYCLE_TIMEOUT_MS,
      'Docker worker restart-policy migration',
    );
  }

  async inspectContainerRuntime(containerId: string): Promise<{
    status: string;
    running: boolean;
    restartPolicy: string;
    secretHandshakeRequired: boolean;
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number;
    error?: string;
  }> {
    const info = await withOperationDeadline(
      (operationSignal) => this.docker.getContainer(containerId).inspect({ abortSignal: operationSignal }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker worker inspection',
    );
    return {
      status: info.State?.Status || 'unknown',
      running: info.State?.Running === true,
      restartPolicy: info.HostConfig?.RestartPolicy?.Name || 'no',
      secretHandshakeRequired: (info.Config?.Env ?? []).some(
        (entry) => entry === 'WORKER_SECRET_HANDSHAKE=1',
      ),
      ...(info.State?.StartedAt ? { startedAt: info.State.StartedAt } : {}),
      ...(info.State?.FinishedAt ? { finishedAt: info.State.FinishedAt } : {}),
      ...(typeof info.State?.ExitCode === 'number'
        ? { exitCode: info.State.ExitCode }
        : {}),
      ...(info.State?.Error ? { error: 'Docker reported a runtime error' } : {}),
    };
  }

  async inspectContainerImage(containerId: string): Promise<string> {
    const info = await withOperationDeadline(
      (operationSignal) => this.docker.getContainer(containerId).inspect({ abortSignal: operationSignal }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker worker image inspection',
    );
    return info.Image || '';
  }

  async assertWorkerPersistenceMounts(
    containerId: string,
    selectedTargets: string[] = [],
  ): Promise<void> {
    const info = await withOperationDeadline(
      (operationSignal) => this.docker.getContainer(containerId).inspect({ abortSignal: operationSignal }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker worker persistence inspection',
    );
    const destinations = new Set(
      (info.Mounts ?? []).map((mount) => mount.Destination).filter(Boolean),
    );
    const required = [
      '/workspace',
      '/home/agent/.agent-data',
      ...selectedTargets,
    ];
    const missing = required.filter((target) => !destinations.has(target));
    if (missing.length)
      throw Object.assign(
        new Error(
          `Worker recovery stopped before replacement because ${missing.length} persistent mount(s) could not be verified`,
        ),
        {
          statusCode: 409,
          code: 'WORKER_PERSISTENCE_UNVERIFIED',
          data: {
            code: 'WORKER_PERSISTENCE_UNVERIFIED',
            missingTargets: missing,
            volumesPreserved: true,
          },
        },
      );
  }

  /** `docker ps` and health-check timestamps can remain stale when a shim is
   * wedged. A bounded exec proves that Docker can still create and observe
   * work in the task. Secret-bearing workers additionally prove that the
   * orchestrator-owned tmpfs handshake survived; an auto/manual daemon start
   * cannot therefore masquerade as a successfully bootstrapped runtime. No
   * worker data, secret name, or environment value is read. */
  async probeContainerTask(
    containerId: string,
    secretHandshakeRequired = false,
  ): Promise<void> {
    const command = secretHandshakeRequired
      ? [
          'python3',
          '-c',
          "import os,sys; p='/run/agentor-secrets/.ready'; st=os.stat(p,follow_symlinks=False); sys.exit(0 if st.st_uid==0 and (st.st_mode & 0o777)==0o444 and open(p,'rb').read()==b'agentor-secret-bootstrap-v1\\n' else 1)",
        ]
      : ['true'];
    const result = await this.execCapture(containerId, command, {
      user: 'agent',
      timeoutMs: 5_000,
      operationLabel: 'Docker worker task probe',
    });
    if (result.exitCode !== 0)
      throw Object.assign(new Error(
        secretHandshakeRequired
          ? 'Worker secret bootstrap handshake is unavailable'
          : 'Docker worker task probe failed',
      ), {
        statusCode: 503,
        code: secretHandshakeRequired
          ? 'WORKER_SECRET_BOOTSTRAP_REQUIRED'
          : 'WORKER_TASK_UNRESPONSIVE',
        data: {
          code: secretHandshakeRequired
            ? 'WORKER_SECRET_BOOTSTRAP_REQUIRED'
            : 'WORKER_TASK_UNRESPONSIVE',
          operation: 'Docker worker task probe',
          retryable: true,
          nextAction:
            secretHandshakeRequired
              ? 'Start the worker through Agentor so managed secrets can be bootstrapped; rebuilding is not required.'
              : 'Retry the individual operation or use managed worker recovery; persistent volumes were not changed.',
        },
      });
  }

  async materializeWorkerSecretFiles(containerId: string, config: Array<{ kind: string; key: string; value: string; fileName?: string }>): Promise<void> {
    const files = config.filter((entry) => entry.kind === 'secretFile').map((entry) => ({ name: entry.fileName, content: Buffer.from(entry.value).toString('base64') }));
    const secrets = config.filter((entry) => entry.kind === 'secret').map((entry) => ({ key: entry.key, value: entry.value }));
    if (!files.length && !secrets.length) return;
    const script = String.raw`import sys,json,base64,os
root='/run/agentor-secrets'
rootfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
for item in json.loads(sys.stdin.readline()):
 name=item['name']
 if not isinstance(name,str) or not name or '\\' in name or any(part in ('','.','..') for part in name.split('/')): raise ValueError('invalid secret file name')
 parts=name.split('/'); parentfd=os.dup(rootfd)
 for part in parts[:-1]:
  try: os.mkdir(part,0o711,dir_fd=parentfd)
  except FileExistsError: pass
  nextfd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parentfd)
  os.close(parentfd); parentfd=nextfd
 fd=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600,dir_fd=parentfd)
 try: os.write(fd,base64.b64decode(item['content'],validate=True)); os.fchmod(fd,0o600); os.fchown(fd,1000,1000)
 finally: os.close(fd); os.close(parentfd)
os.close(rootfd)
`;
    if (files.length) {
      const result = await this.execCapture(containerId, ['python3', '-c', script], {
        user: 'root',
        stdin: Buffer.from(`${JSON.stringify(files)}\n`),
        timeoutMs: 15_000,
        operationLabel: 'Worker secret-file bootstrap',
      });
      if (result.exitCode !== 0) throw new Error('Failed to materialize worker secret files');
    }
    const envScript = String.raw`import sys,json,subprocess
for item in json.loads(sys.stdin.readline()):
 subprocess.run(['tmux','set-environment','-g',item['key'],item['value']],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
`;
    if (secrets.length) {
      const result = await this.execCapture(containerId, ['python3', '-c', envScript], {
        user: 'agent',
        stdin: Buffer.from(`${JSON.stringify(secrets)}\n`),
        timeoutMs: 15_000,
        operationLabel: 'Worker secret-environment bootstrap',
      });
      if (result.exitCode !== 0) throw new Error('Failed to apply worker secrets');
    }
    const ready = await this.execCapture(containerId, ['python3', '-c', "import os; root='/run/agentor-secrets'; rootfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);\ntry:\n try: os.unlink('.ready',dir_fd=rootfd)\n except FileNotFoundError: pass\n fd=os.open('.ready',os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o444,dir_fd=rootfd)\n try: os.write(fd,b'agentor-secret-bootstrap-v1\\n'); os.fchmod(fd,0o444); os.fchown(fd,0,0)\n finally: os.close(fd)\nfinally: os.close(rootfd)"], {
      user: 'root',
      timeoutMs: 15_000,
      operationLabel: 'Worker secret bootstrap handshake',
    });
    if (ready.exitCode !== 0) throw new Error('Failed to complete worker secret handshake');
  }

  // --- Generic app instance management (runs in worker container) ---

  async execAppManage(containerId: string, appTypeId: string, args: string[]): Promise<string> {
    const appType = getAppType(appTypeId);
    if (!appType) throw new Error(`Unknown app type: ${appTypeId}`);

    const container = this.docker.getContainer(containerId);
    const exec = await withOperationDeadline((operationSignal) => container.exec({
      Cmd: [`/home/agent/apps/${appType.manageScript}`, ...args],
      AttachStdout: true,
      AttachStderr: true,
      abortSignal: operationSignal,
    }), DOCKER_EXEC_TIMEOUT_MS, 'Docker app-management setup');
    const stream = await withOperationDeadline(
      (operationSignal) => exec.start({ Detach: false, Tty: true, abortSignal: operationSignal }),
      DOCKER_EXEC_TIMEOUT_MS,
      'Docker app-management start',
    );
    return withOperationDeadline(
      this.streamToString(stream),
      DOCKER_EXEC_TIMEOUT_MS,
      'Docker app-management execution',
    ).catch((error) => {
      (stream as Duplex).destroy();
      throw error;
    });
  }

  async listAppInstances(containerId: string, appTypeId: string): Promise<AppInstanceInfo[]> {
    const output = await this.execAppManage(containerId, appTypeId, ['list']);
    const trimmed = output.trim();
    if (!trimmed) return [];

    const entries: AppInstanceInfo[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean) continue;
      // Tolerate occasional non-JSON stdout lines (e.g. a stray shell warning)
      // so a single bad line doesn't wipe the whole list.
      if (clean[0] !== '{') continue;
      try {
        const parsed = JSON.parse(clean) as Partial<AppInstanceInfo>;
        if (!parsed.id) continue;
        entries.push({
          id: String(parsed.id),
          appType: appTypeId,
          port: typeof parsed.port === 'number' ? parsed.port : parseInt(String(parsed.port ?? 0), 10) || 0,
          status: (parsed.status as AppInstanceInfo['status']) ?? 'stopped',
          ...(parsed.machineName ? { machineName: String(parsed.machineName) } : {}),
          ...(parsed.authUrl ? { authUrl: String(parsed.authUrl) } : {}),
          ...(parsed.authCode ? { authCode: String(parsed.authCode) } : {}),
        });
      } catch {
        // Malformed JSON line — skip.
      }
    }
    return entries;
  }

  async startAppInstance(
    containerId: string,
    appTypeId: string,
    id: string,
    port: number,
    extraArgs: string[] = [],
  ): Promise<void> {
    const output = await this.execAppManage(containerId, appTypeId, ['start', id, String(port), ...extraArgs]);
    this.assertManageOk(output, `start ${appTypeId}/${id}`);
  }

  async stopAppInstance(containerId: string, appTypeId: string, id: string): Promise<void> {
    const output = await this.execAppManage(containerId, appTypeId, ['stop', id]);
    this.assertManageOk(output, `stop ${appTypeId}/${id}`);
  }

  /** Scan NDJSON output from manage.sh and throw if any line signals an error. */
  private assertManageOk(output: string, context: string): void {
    const trimmed = output.trim();
    if (!trimmed) return;
    for (const line of trimmed.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean[0] !== '{') continue;
      let parsed: { status?: string; message?: string };
      try {
        parsed = JSON.parse(clean) as { status?: string; message?: string };
      } catch {
        // Non-JSON line or parse error — ignore (likely stderr noise).
        continue;
      }
      if (parsed.status === 'error') {
        throw new Error(parsed.message || `app manage failed: ${context}`);
      }
    }
  }

  // --- Workspace archive methods ---

  async putWorkspaceArchive(containerId: string, tarBuffer: Buffer): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await withOperationDeadline(
      (operationSignal) => container.putArchive(tarBuffer, {
        path: '/workspace',
        abortSignal: operationSignal,
      }),
      DOCKER_IMAGE_TIMEOUT_MS,
      'Docker workspace restore',
    );
  }

  async getWorkspaceArchive(containerId: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    const container = this.docker.getContainer(containerId);
    return withOperationDeadline(
      (operationSignal) => container.getArchive({
        path: '/workspace',
        abortSignal: operationSignal,
      }),
      DOCKER_TRANSFER_SETUP_TIMEOUT_MS,
      'Docker workspace archive preparation',
      signal,
    );
  }

  // --- Generic archive + export/import (worker export/import) ---

  /** Stream a tar of an arbitrary path inside a container. Entries are prefixed
   * with the basename of `path` (e.g. `/workspace` → `workspace/...`). */
  async getArchive(containerId: string, path: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    return withOperationDeadline(
      (operationSignal) => this.docker.getContainer(containerId).getArchive({
        path,
        abortSignal: operationSignal,
      }),
      DOCKER_TRANSFER_SETUP_TIMEOUT_MS,
      'Docker archive preparation',
      signal,
    );
  }

  /** Extract a tar (buffer or stream; gzip auto-detected) into `path` inside a
   * container. `path` is the directory the tar entries are written under. */
  async putArchive(containerId: string, src: Buffer | NodeJS.ReadableStream, path: string, signal?: AbortSignal): Promise<void> {
    const abortSource = () => {
      if (!Buffer.isBuffer(src)) (src as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.();
    };
    signal?.addEventListener('abort', abortSource, { once: true });
    try {
      await withOperationDeadline(
        (operationSignal) => this.docker.getContainer(containerId).putArchive(src, {
          path,
          abortSignal: operationSignal,
        }),
        DOCKER_IMAGE_TIMEOUT_MS,
        'Docker archive restore',
        signal,
      );
    } finally {
      signal?.removeEventListener('abort', abortSource);
    }
  }

  /** Stream the full container filesystem as a tar (`docker export`). Excludes
   * mounted volumes — those are exported separately via `getArchive`. */
  async exportContainer(containerId: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    return withOperationDeadline(
      (operationSignal) => this.docker.getContainer(containerId).export({
        abortSignal: operationSignal,
      }),
      DOCKER_TRANSFER_SETUP_TIMEOUT_MS,
      'Docker root-filesystem export preparation',
      signal,
    );
  }

  /** Create a local image from a filesystem tar (`docker import`; gzip auto-
   * detected). Returns once the import progress stream completes. Rejects if any
   * progress event carries an error (Docker can report `errorDetail` inside an
   * otherwise-successful stream — followProgress alone would not surface it). */
  async importImage(src: Buffer | NodeJS.ReadableStream, repo: string, tag: string): Promise<string> {
    // dockerode resolves importImage only after it has uploaded the complete
    // request body and received Docker's response headers. For a multi-GB
    // rootfs that is the transfer itself, not a cheap "stream setup" call.
    // Apply one end-to-end deadline across upload + daemon progress so a valid
    // slow import is not aborted after the ordinary 15-second setup budget.
    let progressStream: NodeJS.ReadableStream | undefined;
    await withOperationDeadline(async (operationSignal) => {
      const abortStreams = () => {
        (progressStream as
          | (NodeJS.ReadableStream & { destroy?: () => void })
          | undefined)?.destroy?.();
        if (!Buffer.isBuffer(src))
          (src as NodeJS.ReadableStream & { destroy?: (error?: Error) => void })
            .destroy?.();
      };
      operationSignal.addEventListener('abort', abortStreams, { once: true });
      try {
        // dockerode's importImage overloads don't cleanly accept a stream
        // union; the runtime accepts both a Buffer and a readable.
        progressStream = (await this.docker.importImage(
          src as NodeJS.ReadableStream,
          { repo, tag, abortSignal: operationSignal },
        )) as NodeJS.ReadableStream;
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(
            progressStream!,
            (err: Error | null) => (err ? reject(err) : resolve()),
            (event: { error?: string; errorDetail?: { message?: string } }) => {
              const message = event?.errorDetail?.message || event?.error;
              if (message) reject(new Error(message));
            },
          );
        });
      } finally {
        operationSignal.removeEventListener('abort', abortStreams);
      }
    }, DOCKER_ROOTFS_IMPORT_TIMEOUT_MS, 'Docker image import').catch((error) => {
      (progressStream as
        | (NodeJS.ReadableStream & { destroy?: () => void })
        | undefined)?.destroy?.();
      if (!Buffer.isBuffer(src))
        (src as NodeJS.ReadableStream & { destroy?: (error?: Error) => void })
          .destroy?.();
      throw error;
    });
    return `${repo}:${tag}`;
  }

  /** Read the runtime config (entrypoint/cmd/workdir/user/env) of an image. */
  async inspectImageConfig(image: string): Promise<ImageConfigOverride> {
    const info = await withOperationDeadline(
      (operationSignal) => this.docker.getImage(image).inspect({
        abortSignal: operationSignal,
      } as Docker.ImageInspectOptions & { abortSignal: AbortSignal }),
      DOCKER_READ_TIMEOUT_MS,
      'Docker image inspection',
    );
    const c = info.Config ?? {};
    return {
      Entrypoint: c.Entrypoint as string[] | undefined,
      Cmd: c.Cmd as string[] | undefined,
      WorkingDir: c.WorkingDir,
      User: c.User,
      Env: c.Env as string[] | undefined,
    };
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await withOperationDeadline(
        (operationSignal) => this.docker.getImage(image).inspect({
          abortSignal: operationSignal,
        } as Docker.ImageInspectOptions & { abortSignal: AbortSignal }),
        DOCKER_READ_TIMEOUT_MS,
        'Docker image existence check',
      );
      return true;
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number })
        ?.statusCode ?? (error as { status?: number })?.status;
      if (status === 404) return false;
      throw error;
    }
  }

  async removeImage(image: string): Promise<void> {
    try {
      await withOperationDeadline(
        (operationSignal) => this.docker.getImage(image).remove({
          force: true,
          abortSignal: operationSignal,
        } as Docker.ImageRemoveOptions & { abortSignal: AbortSignal }),
        DOCKER_LIFECYCLE_TIMEOUT_MS,
        'Docker image removal',
      );
      useLogger().debug(`[docker] removed image ${image}`);
    } catch (error) {
      // Missing is already the requested state. Surface daemon/in-use failures
      // so transactional import rollback can retain its authoritative handles
      // and report cleanup that still needs operator attention. Normal delete
      // callers deliberately catch, log, and continue.
      const status = (error as { statusCode?: number; status?: number })
        ?.statusCode ?? (error as { status?: number })?.status;
      if (status !== 404) throw error;
    }
  }

  // --- Workspace file manager (in-container, as uid 1000 / agent) ---
  //
  // These methods implement the secure full `/workspace` file manager. They
  // NEVER touch host workspace paths: every operation runs through Docker
  // exec/getArchive/putArchive against the running worker container, executed
  // as the `agent` user (uid 1000). Path arguments are always normalised,
  // lexically-validated relative paths (see `workspace-path.ts`) converted to
  // in-container absolute paths; an in-container realpath/lstat containment
  // check (see `workspace-probe.ts`) defeats symlink traversal so an operation
  // can never escape `/workspace`.

  /**
   * Run a command inside a container as the `agent` user (uid 1000), capturing
   * demuxed stdout/stderr and the exit code. Non-TTY so stdout/stderr are
   * separate clean streams (no 8-byte framing on the captured buffers). When
   * `stdin` is supplied it is written without relying on half-close/EOF (Docker
   * hijacked sockets do not propagate it reliably); stdin consumers must use a
   * framed record or explicit byte count. Commands are passed as argv arrays.
   */
  async execCapture(
    containerId: string,
    cmd: string[],
    opts: {
      stdin?: Buffer;
      user?: string;
      workdir?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      /** Fixed server-owned label only; never pass a command or secret. */
      operationLabel?: string;
    } = {},
  ): Promise<ExecCaptureResult> {
    const container = this.docker.getContainer(containerId);
    const timeoutMs = opts.timeoutMs ?? DOCKER_EXEC_TIMEOUT_MS;
    const label = opts.operationLabel ?? 'Docker worker command';
    const exec = await withOperationDeadline(
      (operationSignal) => container.exec({
        Cmd: cmd,
        AttachStdin: !!opts.stdin,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        ...(opts.user ? { User: opts.user } : {}),
        ...(opts.workdir ? { WorkingDir: opts.workdir } : {}),
        abortSignal: operationSignal,
      }),
      timeoutMs,
      `${label} setup`,
      opts.signal,
    );
    const stream = (await withOperationDeadline(
      (operationSignal) => exec.start({
        Detach: false,
        Tty: false,
        stdin: !!opts.stdin,
        abortSignal: operationSignal,
      }),
      timeoutMs,
      `${label} start`,
      opts.signal,
    )) as Duplex;
    const abortStream = () => stream.destroy();
    opts.signal?.addEventListener('abort', abortStream, { once: true });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // Demux the multiplexed Docker stream into separate stdout/stderr buffers.
    // Falls back to raw passthrough on stdout if the stream is not framed.
    container.modem.demuxStream(stream, stdout, stderr);

    // docker-modem's demuxStream only forwards `data`; it does not close the
    // destination streams when the Docker attach stream ends. Close them here
    // so capture promises cannot wait forever after a successful exec.
    let captureEnded = false;
    const finishCapture = (err?: Error) => {
      if (captureEnded) return;
      captureEnded = true;
      if (err) {
        stdout.destroy(err);
        stderr.destroy(err);
      } else {
        stdout.end();
        stderr.end();
      }
    };
    stream.once('end', () => finishCapture());
    stream.once('close', () => finishCapture());
    stream.once('error', (err) => finishCapture(err));

    if (opts.stdin) {
      stream.write(opts.stdin);
    }

    // Consume stdout AND stderr concurrently. Awaiting them sequentially can
    // deadlock the demuxer: if stderr's internal buffer fills while we are
    // still awaiting stdout (or vice versa), the multiplexed stream stops
    // being drained and neither side ever ends. Promise.all drains both sides
    // in parallel so backpressure never stalls the other half.
    let stdoutBuf: Buffer;
    let stderrBuf: Buffer;
    try {
      [stdoutBuf, stderrBuf] = await withOperationDeadline(
        Promise.all([
          this.streamToBuffer(stdout),
          this.streamToBuffer(stderr),
        ]),
        timeoutMs,
        label,
        opts.signal,
      );
    } catch (error) {
      stream.destroy();
      stdout.destroy();
      stderr.destroy();
      throw error;
    } finally {
      opts.signal?.removeEventListener('abort', abortStream);
    }
    // Capture completion means the attach stream ended/closed. Docker normally
    // records ExitCode synchronously, but allow a brief propagation window.
    let info = await withOperationDeadline(
      (operationSignal) => exec.inspect({ abortSignal: operationSignal }),
      DOCKER_READ_TIMEOUT_MS,
      `${label} result inspection`,
      opts.signal,
    );
    for (let attempt = 0; info.ExitCode == null && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      info = await withOperationDeadline(
        (operationSignal) => exec.inspect({ abortSignal: operationSignal }),
        DOCKER_READ_TIMEOUT_MS,
        `${label} result inspection`,
        opts.signal,
      );
    }
    return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: info.ExitCode ?? 0 };
  }

  private streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  // --- Resource metrics ---

  /** One-shot container stats snapshot (cpu/memory/network/blkio). The Docker
   * engine includes `precpu_stats` so an instantaneous CPU% can be derived from
   * a single call; network/disk rates still need two samples. */
  async getContainerStats(containerId: string): Promise<RawContainerStats> {
    const container = this.docker.getContainer(containerId);
    // dockerode types `stats` as a stream; with `{ stream: false }` it resolves
    // with the parsed JSON object instead.
    return (await withOperationDeadline(
      (operationSignal) => container.stats({
        stream: false,
        abortSignal: operationSignal,
      } as { stream: false; abortSignal: AbortSignal }) as unknown as Promise<RawContainerStats>,
      DOCKER_READ_TIMEOUT_MS,
      'Docker worker stats',
    )) as RawContainerStats;
  }

  /** Bounded disk sample for durable worker data. Docker's `inspect?size=true`
   * asks the storage driver to walk the writable layer and was observed to pin
   * lifecycle/recovery calls behind a wedged task. Keep critical monitoring to
   * a bounded in-container `du` of `/workspace` and agent data instead. */
  async getWorkerDiskUsageBytes(containerId: string): Promise<number> {
    let volumes = 0;
    try {
      const result = await this.execCapture(
        containerId,
        ['du', '-skc', '/workspace', '/home/agent/.agent-data'],
        {
          user: 'agent',
          timeoutMs: 20_000,
          operationLabel: 'Docker worker disk sample',
        },
      );
      const out = result.stdout.toString('utf8');
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const totalLine = [...lines].reverse().find((l) => /\btotal\b/.test(l)) ?? lines[lines.length - 1] ?? '';
      const kb = parseInt(totalLine.trim().split(/\s+/)[0] || '0', 10);
      if (Number.isFinite(kb) && kb > 0) volumes = kb * 1024;
    } catch {
      // keep volumes at 0
    }

    return volumes;
  }

  // --- Helpers ---

  async ensureImage(image: string, signal?: AbortSignal): Promise<void> {
    try {
      await withOperationDeadline(
        (operationSignal) => this.docker.getImage(image).inspect({
          abortSignal: operationSignal,
        } as Docker.ImageInspectOptions & { abortSignal: AbortSignal }),
        DOCKER_READ_TIMEOUT_MS,
        'Docker image inspection',
        signal,
      );
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number })
        ?.statusCode ?? (error as { status?: number })?.status;
      // A timeout or unavailable daemon is not evidence that the image is
      // absent. Starting a pull in that state compounds the blocked queue.
      if (status !== 404) throw error;
      useLogger().info(`[docker] pulling image ${image}...`);
      const stream = await withOperationDeadline(
        (operationSignal) => this.docker.pull(image, {
          abortSignal: operationSignal,
        }),
        DOCKER_TRANSFER_SETUP_TIMEOUT_MS,
        'Docker image pull preparation',
        signal,
      );
      const cancelPull = () => (stream as Readable).destroy(
        new Error('Docker image pull cancelled'),
      );
      signal?.addEventListener('abort', cancelPull, { once: true });
      try {
        await withOperationDeadline(new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
        }), DOCKER_IMAGE_TIMEOUT_MS, 'Docker image pull', signal);
      } finally {
        signal?.removeEventListener('abort', cancelPull);
      }
      useLogger().info(`[docker] pulled image ${image}`);
    }
  }

  private parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|kb|mb|gb)$/i);
    if (!match) throw new Error(`Invalid memory limit: ${limit}`);
    const value = parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();
    const multipliers: Record<string, number> = {
      b: 1,
      k: 1024,
      kb: 1024,
      m: 1024 ** 2,
      mb: 1024 ** 2,
      g: 1024 ** 3,
      gb: 1024 ** 3,
    };
    return Math.floor(value * (multipliers[unit] || 1));
  }

  private streamToString(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      stream.on('error', reject);
    });
  }
}
