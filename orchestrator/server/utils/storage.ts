import Docker from 'dockerode';
import { mkdir, rm, chmod, chown, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from './config';
import { assertSafeUserId } from './user-id';
import { operationSettlement, type OperationFailureWithSettlement } from './operation-deadline';
import { withInstanceOperationDeadline } from './instance-operation-deadline';
import { instanceControlPlaneCoordinator } from './instance-snapshot-gate';

const storageFiles = { mkdir, rm, chmod, chown, stat, writeFile, readFile };

type StorageMode = 'volume' | 'directory';

const AGENT_UID = 1000;
const AGENT_GID = 1000;
const STORAGE_DOCKER_TIMEOUT_MS = 30_000;

/** Relative paths inside a worker's agents directory where the orchestrator
 * pre-creates empty mountpoint files. Docker Desktop's virtiofs refuses to
 * nest a file bind mount inside a directory bind mount unless the target
 * already exists on the host, so we touch these files before starting the
 * container and then bind the per-user credential file on top.
 *
 * Kilo is deliberately absent: its auth file lives under a per-user shared
 * directory bind (`.kilo/shared-data`, see SHARED_DIRECTORY_MOUNT_POINTS)
 * rather than a per-file bind, because Kilo rewrites `auth.json` atomically
 * via temp+rename which breaks a file bind. See `getKiloSharedDataBind`. */
const CREDENTIAL_MOUNT_POINTS = [
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.gemini/oauth_creds.json',
];

/** Relative directory paths inside a worker's agents directory that receive a
 * nested bind mount. Pre-creating them avoids Docker Desktop virtiofs treating
 * a missing directory target inconsistently with native Docker.
 *
 * These are also the shared per-user directories whose contents must be stripped
 * from worker exports (secrets belong to the account, not the portable worker)
 * — `worker-export.ts` derives its exclude list from this registry so the two
 * can never drift. */
export const SHARED_DIRECTORY_MOUNT_POINTS = [
  '.kilo/config',
  '.kilo/shared-data',
];

export class StorageManager {
  private docker: Docker;
  private config: Config;
  private initialized = false;
  private initialization?: Promise<void>;

  mode: StorageMode = 'volume';
  /** Volume name (volume mode) or host path (directory mode) — used in bind strings
   * that Docker interprets via name or path depending on the first character. */
  dataRef = '';
  /** Absolute host path of the data directory — always a filesystem path, even
   * in volume mode (`/var/lib/docker/volumes/<volume>/_data`). Used to build
   * file-level bind mounts for per-user credentials. Empty if resolution failed. */
  dataHostPath = '';
  /** In-container path for fs operations (always /data) */
  dataDir: string;

  constructor(docker: Docker, config: Config, private readonly files = storageFiles) {
    this.docker = docker;
    this.config = config;
    this.dataDir = config.dataDir;
  }

  init(): Promise<void> {
    return instanceControlPlaneCoordinator.run(async () => {
      if (!this.initialization) {
        this.initialized = false;
        const pending = this.initialize();
        this.initialization = pending;
        void pending.then(() => { this.initialization = undefined; }, () => { this.initialization = undefined; });
      }
      await this.initialization;
    });
  }

  /** Excluded snapshot inventory must never lazily initialize storage. */
  assertInitializedForInstanceSnapshot(): void {
    if (!this.initialized) throw Object.assign(new Error('Storage is not initialized for instance snapshot'), {
      statusCode: 503, code: 'INSTANCE_STORAGE_NOT_INITIALIZED',
    });
  }

  private retainCaughtSettlement(error: unknown): void {
    const settlement = (error as OperationFailureWithSettlement | undefined)?.[operationSettlement];
    if (!settlement) return;
    // A best-effort catch may return promptly, but its actual external lifetime
    // must remain registered independently of the completed caller.
    const child = instanceControlPlaneCoordinator.fork();
    void child.run(() => Promise.resolve(settlement).then(() => undefined, () => undefined));
  }

  private async initialize(): Promise<void> {
    const hostname = process.env.HOSTNAME;
    if (!hostname) {
      useLogger().info('[storage] HOSTNAME not set — falling back to volume mode');
      this.mode = 'volume';
      this.dataRef = this.config.dataVolume;
      this.initialized = true;
      return;
    }

    try {
      const container = this.docker.getContainer(hostname);
      const info = await withInstanceOperationDeadline(instanceControlPlaneCoordinator, () => container.inspect(), STORAGE_DOCKER_TIMEOUT_MS, 'Docker storage mount inspection');

      const dataMount = info.Mounts?.find(
        (m: { Destination: string }) => m.Destination === this.dataDir
      );

      if (!dataMount) {
        useLogger().info('[storage] /data not mounted — falling back to volume mode');
        this.mode = 'volume';
        this.dataRef = this.config.dataVolume;
        this.initialized = true;
        return;
      }

      if (dataMount.Type === 'bind') {
        this.mode = 'directory';
        this.dataRef = dataMount.Source;
        this.dataHostPath = dataMount.Source;
        useLogger().info(`[storage] directory mode — host path: ${this.dataRef}`);
      } else {
        this.mode = 'volume';
        this.dataRef = dataMount.Name || this.config.dataVolume;
        // Docker surfaces the volume's host data dir as Source for volume mounts.
        this.dataHostPath = dataMount.Source || '';
        useLogger().info(
          `[storage] volume mode — volume: ${this.dataRef}${this.dataHostPath ? ` (host path: ${this.dataHostPath})` : ''}`,
        );
      }
      this.initialized = true;
    } catch (err: unknown) {
      this.retainCaughtSettlement(err);
      useLogger().error(`[storage] init failed, falling back to volume mode: ${err instanceof Error ? err.message : err}`);
      this.mode = 'volume';
      this.dataRef = this.config.dataVolume;
    }
  }

  /** Bind string for mounting the data directory (used by Traefik) */
  getDataBind(readOnly = false): string {
    const suffix = readOnly ? ':ro' : '';
    return `${this.dataRef}:/data${suffix}`;
  }

  /** Bind string for a worker's workspace. Directory mode nests the path inside
   * the user's data dir so per-user name collisions do not clash on disk. */
  getWorkerWorkspaceBind(userId: string, name: string, containerName: string): string {
    if (this.mode === 'directory') {
      assertSafeUserId(userId);
      return `${join(this.dataRef, 'users', userId, 'workspaces', name)}:/workspace`;
    }
    return `${containerName}-workspace:/workspace`;
  }

  /** Bind string for a worker's Docker-in-Docker data (always a named volume — overlay2 requires a native filesystem) */
  getWorkerDockerBind(containerName: string): string {
    return `${containerName}-docker:/var/lib/docker`;
  }

  /** Bind string for a worker's persistent agent config data (~/.claude, ~/.gemini, ~/.codex, ~/.agents) */
  getWorkerAgentsBind(userId: string, name: string, containerName: string): string {
    if (this.mode === 'directory') {
      assertSafeUserId(userId);
      return `${join(this.dataRef, 'users', userId, 'agents', name)}:/home/agent/.agent-data`;
    }
    return `${containerName}-agents:/home/agent/.agent-data`;
  }

  /** Bind string for Traefik certificate storage */
  getCertBind(): string {
    if (this.mode === 'directory') {
      return `${join(this.dataRef, 'traefik-certs')}:/letsencrypt`;
    }
    return 'agentor-traefik-certs:/letsencrypt';
  }

  /** Ensure workspace and agents directories exist with correct ownership,
   * and pre-create nested directory/file mountpoints so Docker Desktop's
   * virtiofs can layer per-user binds on top (directory mode only). */
  ensureWorkerDirs(userId: string, name: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.ensureWorkerDirsAdmitted(userId, name));
  }

  private async ensureWorkerDirsAdmitted(userId: string, name: string): Promise<void> {
    if (this.mode !== 'directory') return;

    const userDir = this.getUserDir(userId);
    // Explicit 0o700 on per-user dirs so on a shared host another user's process
    // can't traverse/read into them (the entrypoint re-chowns to the agent uid).
    await this.files.mkdir(userDir, { recursive: true, mode: 0o700 });
    await this.chownDir(userDir);

    const workspaceDir = join(userDir, 'workspaces', name);
    await this.files.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    await this.chownDir(workspaceDir);

    const agentsDir = join(userDir, 'agents', name);
    await this.files.mkdir(agentsDir, { recursive: true, mode: 0o700 });
    await this.chownDir(agentsDir);

    for (const relPath of SHARED_DIRECTORY_MOUNT_POINTS) {
      const mountpoint = join(agentsDir, relPath);
      await this.files.mkdir(mountpoint, { recursive: true, mode: 0o700 });
      await this.files.chmod(mountpoint, 0o700);
      await this.chownDir(mountpoint);
    }

    for (const relPath of CREDENTIAL_MOUNT_POINTS) {
      const mountpoint = join(agentsDir, relPath);
      const parent = dirname(mountpoint);
      await this.files.mkdir(parent, { recursive: true, mode: 0o700 });
      await this.chownDir(parent);
      try {
        await this.files.stat(mountpoint);
      } catch (error) {
        this.retainCaughtSettlement(error);
        await this.files.writeFile(mountpoint, '', { mode: 0o600 });
        try {
          await this.files.chown(mountpoint, AGENT_UID, AGENT_GID);
        } catch (error) {
          this.retainCaughtSettlement(error);
          // See chownDir — best effort.
        }
      }
    }
  }

  /** Ensure the per-user SSH directory + `authorized_keys` file exist so the
   * bind mount target is valid before a worker starts. Idempotent. Writes via
   * the in-container data path so it works in both volume and directory mode;
   * the file surfaces on the host at `<dataHostPath>/users/<userId>/ssh/…`,
   * which is what the Docker bind string references. */
  ensureUserSshDir(userId: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.ensureUserSshDirAdmitted(userId));
  }

  private async ensureUserSshDirAdmitted(userId: string): Promise<void> {
    const sshDir = join(this.getUserDir(userId), 'ssh');
    const keyFile = join(sshDir, 'authorized_keys');
    // A tight `ssh/` dir (0o700) keeps a co-located process from tampering with
    // another user's keys. The file itself stays world-readable (0o644): it is a
    // public key, and it is bind-mounted read-only into the worker where the
    // unprivileged `agent` uid (1000, ≠ the orchestrator's uid) must read it for
    // sshd. A 0o600 file owned by the orchestrator uid is unreadable across that
    // bind mount and breaks pubkey auth.
    await this.files.mkdir(sshDir, { recursive: true, mode: 0o700 });
    try {
      await this.files.stat(keyFile);
    } catch (error) {
      this.retainCaughtSettlement(error);
      await this.files.writeFile(keyFile, '', { mode: 0o644 });
    }
  }

  /** Ensure the per-user Kilo global-config directory exists and is writable by
   * the worker's unprivileged agent user in both storage modes. */
  ensureUserKiloConfigDir(userId: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.ensureUserKiloConfigDirAdmitted(userId));
  }

  private async ensureUserKiloConfigDirAdmitted(userId: string): Promise<void> {
    const kiloDir = join(this.getUserDir(userId), 'kilo');
    const configDir = join(kiloDir, 'config');
    await this.files.mkdir(configDir, { recursive: true, mode: 0o700 });
    await this.files.chmod(kiloDir, 0o700);
    await this.files.chmod(configDir, 0o700);
    await this.chownDir(kiloDir);
    await this.chownDir(configDir);
  }

  /** Read the user's `authorized_keys` content for the Account UI (the field is
   * 1:1 with this file). Returns '' if not configured. Trailing whitespace is
   * trimmed so the value round-trips with what the UI submitted. */
  async readSshAuthorizedKeys(userId: string): Promise<string> {
    const keyFile = join(this.getUserDir(userId), 'ssh', 'authorized_keys');
    try {
      return (await this.files.readFile(keyFile, 'utf-8')).trimEnd();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /** Write the user's `authorized_keys` file (the SSH key's only home). The
   * content is the Account UI field 1:1; a trailing newline is added for sshd.
   * Empty → empty file (no logins accepted). Bind-mounted into every worker the
   * user owns, so updates are visible live. */
  writeSshAuthorizedKeys(userId: string, content: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.writeSshAuthorizedKeysAdmitted(userId, content));
  }

  private async writeSshAuthorizedKeysAdmitted(userId: string, content: string): Promise<void> {
    const sshDir = join(this.getUserDir(userId), 'ssh');
    await this.files.mkdir(sshDir, { recursive: true, mode: 0o700 });
    const trimmed = (content ?? '').trimEnd();
    // 0o644: bind-mounted read-only into the worker; the agent uid must read it
    // for sshd (see ensureUserSshDir). It is a public key, not a secret.
    await this.files.writeFile(join(sshDir, 'authorized_keys'), trimmed ? `${trimmed}\n` : '', { mode: 0o644 });
  }

  /** Bind string for the user's `authorized_keys` file, mounted read-only at
   * the path sshd reads from inside the worker. Resolved via the host path so
   * Docker can find the file regardless of storage mode. */
  getSshAuthorizedKeysBind(userId: string): string {
    if (!this.dataHostPath) {
      throw new Error('[storage] dataHostPath not resolved — cannot build ssh bind');
    }
    const hostFile = join(this.getUserHostDir(userId), 'ssh', 'authorized_keys');
    return `${hostFile}:/home/agent/.ssh/authorized_keys:ro`;
  }

  /** Bind string for the user's writable Kilo global-config directory. */
  getKiloConfigBind(userId: string): string {
    if (!this.dataHostPath) {
      throw new Error('[storage] dataHostPath not resolved — cannot build Kilo config bind');
    }
    const hostDir = join(this.getUserHostDir(userId), 'kilo', 'config');
    return `${hostDir}:/home/agent/.agent-data/.kilo/config`;
  }

  /** Ensure the per-user Kilo shared-data directory (the writable source for
   * Kilo's `~/.local/share/kilo`) exists with correct ownership in both
   * storage modes. Holds `auth.json` (provider keys + login) plus Kilo's
   * SQLite session/history DBs — all shared across that user's workers. */
  ensureUserKiloSharedDataDir(userId: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.ensureUserKiloSharedDataDirAdmitted(userId));
  }

  private async ensureUserKiloSharedDataDirAdmitted(userId: string): Promise<void> {
    const kiloDir = join(this.getUserDir(userId), 'kilo');
    const sharedDir = join(kiloDir, 'data');
    await this.files.mkdir(sharedDir, { recursive: true, mode: 0o700 });
    await this.files.chmod(kiloDir, 0o700);
    await this.files.chmod(sharedDir, 0o700);
    await this.chownDir(kiloDir);
    await this.chownDir(sharedDir);
  }

  /** Bind string for the user's writable Kilo shared-data directory, mounted
   * at `.agent-data/.kilo/shared-data` (distinct from the legacy per-worker
   * `.kilo/data`) so the entrypoint can migrate old per-worker data into it.
   * A directory bind survives Kilo's atomic temp+rename of `auth.json`, unlike
   * a per-file bind. */
  getKiloSharedDataBind(userId: string): string {
    if (!this.dataHostPath) {
      throw new Error('[storage] dataHostPath not resolved — cannot build Kilo shared-data bind');
    }
    const hostDir = join(this.getUserHostDir(userId), 'kilo', 'data');
    return `${hostDir}:/home/agent/.agent-data/.kilo/shared-data`;
  }

  /** In-container path of a user's private data directory (`/data/users/<userId>/`). */
  getUserDir(userId: string): string {
    assertSafeUserId(userId);
    return join(this.dataDir, 'users', userId);
  }

  /** Host path of a user's data directory, for constructing Docker bind strings.
   * Only valid when `dataHostPath` was resolved successfully at init. */
  getUserHostDir(userId: string): string {
    assertSafeUserId(userId);
    if (!this.dataHostPath) {
      throw new Error('[storage] dataHostPath not resolved — cannot build per-user host path');
    }
    return join(this.dataHostPath, 'users', userId);
  }

  /** Ensure a user's data + credentials directories exist with correct ownership
   * (directory mode only — volume mode relies on the entrypoint's chown). */
  ensureUserDir(userId: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.ensureUserDirAdmitted(userId));
  }

  private async ensureUserDirAdmitted(userId: string): Promise<void> {
    const userDir = this.getUserDir(userId);
    const credDir = join(userDir, 'credentials');
    await this.files.mkdir(credDir, { recursive: true, mode: 0o700 });
    if (this.mode === 'directory') {
      await this.chownDir(userDir);
      await this.chownDir(credDir);
    }
  }

  /** Remove a user's entire data directory (credentials, workers, mappings,
   * env vars, usage, workspaces, agents — everything). */
  removeUserDir(userId: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.removeUserDirAdmitted(userId));
  }

  private async removeUserDirAdmitted(userId: string): Promise<void> {
    await this.files.rm(this.getUserDir(userId), { recursive: true, force: true });
  }

  /** Remove a worker's workspace (volume or directory). In directory mode the
   * path is scoped by userId; in volume mode the volume is keyed by the globally
   * unique containerName. */
  removeWorkerWorkspace(userId: string, name: string, containerName: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.removeWorkerWorkspaceAdmitted(userId, name, containerName));
  }

  private async removeWorkerWorkspaceAdmitted(userId: string, name: string, containerName: string): Promise<void> {
    if (this.mode === 'directory') {
      await this.files.rm(join(this.getUserDir(userId), 'workspaces', name), { recursive: true, force: true });
    } else {
      await this.removeVolume(`${containerName}-workspace`);
    }
  }

  /** Remove a worker's Docker-in-Docker volume (always a named volume). */
  removeWorkerDocker(containerName: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.removeWorkerDockerAdmitted(containerName));
  }

  private async removeWorkerDockerAdmitted(containerName: string): Promise<void> {
    await this.removeVolume(`${containerName}-docker`);
  }

  /** Remove a worker's persistent agent config data (volume or directory). */
  removeWorkerAgents(userId: string, name: string, containerName: string): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.removeWorkerAgentsAdmitted(userId, name, containerName));
  }

  private async removeWorkerAgentsAdmitted(userId: string, name: string, containerName: string): Promise<void> {
    if (this.mode === 'directory') {
      await this.files.rm(join(this.getUserDir(userId), 'agents', name), { recursive: true, force: true });
    } else {
      await this.removeVolume(`${containerName}-agents`);
    }
  }

  /** Ensure Traefik cert directory exists (directory mode only) */
  ensureCertDir(): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.ensureCertDirAdmitted());
  }

  private async ensureCertDirAdmitted(): Promise<void> {
    if (this.mode !== 'directory') return;
    await this.files.mkdir(join(this.dataDir, 'traefik-certs'), { recursive: true });
  }

  /** Ensure self-signed cert directory exists (directory mode only) */
  ensureSelfSignedCertDir(): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.ensureSelfSignedCertDirAdmitted());
  }

  private async ensureSelfSignedCertDirAdmitted(): Promise<void> {
    if (this.mode !== 'directory') return;
    await this.files.mkdir(join(this.dataDir, 'selfsigned-certs'), { recursive: true });
  }

  /** In-container path of the built-in defaults directory
   * (`/data/defaults/`) — holds seeded capabilities, instructions, init scripts,
   * and environments that ship with the platform. */
  getDefaultsDir(): string {
    return join(this.dataDir, 'defaults');
  }

  /** Ensure the `defaults/` directory exists. Called at startup before built-in
   * seeding so the seed writers can simply write. */
  ensureDefaultsDir(): Promise<void> {
    return instanceControlPlaneCoordinator.run(() => this.ensureDefaultsDirAdmitted());
  }

  private async ensureDefaultsDirAdmitted(): Promise<void> {
    await this.files.mkdir(this.getDefaultsDir(), { recursive: true });
  }

  private async removeVolume(volumeName: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(volumeName);
      await withInstanceOperationDeadline(instanceControlPlaneCoordinator, () => volume.remove(), STORAGE_DOCKER_TIMEOUT_MS, 'Docker worker-volume cleanup');
    } catch (error) {
      this.retainCaughtSettlement(error);
      // Absence is idempotent success. Propagate daemon, permission, and
      // in-use failures so rollback callers can report incomplete cleanup;
      // ordinary deletion paths already log and continue explicitly.
      const status = (error as { statusCode?: number; status?: number })
        ?.statusCode ?? (error as { status?: number })?.status;
      if (status !== 404) throw error;
    }
  }

  private async chownDir(dir: string): Promise<void> {
    try {
      await this.files.chown(dir, AGENT_UID, AGENT_GID);
    } catch (error) {
      this.retainCaughtSettlement(error);
      // Best effort — mainly relevant in directory mode where the host
      // filesystem persists, and even there the entrypoint re-chowns.
    }
  }
}
