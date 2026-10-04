import type { Config } from "./config";
import type { DockerService } from "./docker";
import { IncusClient, type IncusInstance, type IncusDevice } from "./incus-client";
import { AGENT_CREDENTIAL_MAPPINGS } from "./user-credentials";
import { join } from "node:path";
import { renderUserEnvVars } from "./user-env-store";
import { backupInstallationId } from "./backup-installation";
import { IncusWorkerStorage, type IncusStorageOwner } from "./incus-worker-storage";
import { resolveIncusPrimaryLease } from "./incus-worker-network";
import type { ContainerStatus } from "../../shared/types";
import { IncusWorkerCommands } from "./incus-worker-commands";
import { withOwnerWorkerRuntimeSetup } from "./worker-lifecycle-coordinator";

export type IncusWorkerOptions = Parameters<DockerService["createWorkerContainer"]>[0] & { sshAuthorizedKeys?: string };

function sameDevice(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return !!actual && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** Config is a shell file consumed only by entrypoint.sh, never systemd's
 * EnvironmentFile parser. Quote values literally, including newlines. */
export function serializeIncusWorkerEnv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"))
      throw new Error("Invalid worker environment value");
    return `${key}='${value.replaceAll("'", "'\\''")}'`;
  }).join("\n") + "\n";
}

export function incusWorkerStatus(instance: IncusInstance): ContainerStatus {
  return ({ Running: "running", Stopped: "stopped", Starting: "starting",
    Stopping: "removing", Frozen: "unknown", Error: "error" } as Record<string, ContainerStatus>)[instance.status] ?? "unknown";
}

/** Ordinary worker VM lifecycle. Incus credentials stay in the control plane;
 * guest configuration crosses only the agent file API after each boot. */
export class IncusWorkerRuntime {
  readonly client: IncusClient;
  private installation?: Promise<string>;
  constructor(private config: Config, client = IncusClient.fromConfig(config)) {
    this.client = client;
  }

  private installationId(): Promise<string> {
    return this.installation ??= backupInstallationId(this.config.dataDir);
  }

  private async storage(): Promise<IncusWorkerStorage> {
    return new IncusWorkerStorage(this.client, this.config, await this.installationId());
  }

  async removeStorage(owner: IncusStorageOwner): Promise<void> {
    await (await this.storage()).remove(owner);
  }

  async matchesWorkerIdentity(instance: IncusInstance, workerId: string, userId?: string): Promise<boolean> {
    return instance.type === "virtual-machine" && instance.config["user.agentor.id"] === workerId &&
      instance.name === `${this.config.containerPrefix}-${workerId}` &&
      instance.config["user.agentor.installation"] === await this.installationId() &&
      (!userId || instance.config["user.agentor.owner"] === userId);
  }

  /** Telemetry is diagnostic only. It never supplies routing/worker identity. */
  async inspectState(owner: IncusStorageOwner, incarnation: string) {
    const check = async () => {
      const instance = await this.assertOwned(owner.containerName, owner.id);
      if (instance.config['user.agentor.owner'] !== owner.userId || !incarnation ||
          instance.config['volatile.uuid'] !== incarnation)
        throw new Error('Incus observation target ownership or incarnation changed');
      return instance;
    };
    const instance = await check();
    const state = await this.client.getInstanceState(owner.containerName);
    await check();
    const limit = (instance.expanded_config ?? instance.config)['limits.cpu'] ?? '1';
    const nic = (instance.expanded_devices ?? instance.devices).eth0;
    return { state, cpuCount: /^[1-9][0-9]*$/.test(limit) ? Number(limit) : 0,
      primaryMac: nic?.hwaddr ?? instance.config['volatile.eth0.hwaddr'] };
  }

  /** Read the journal without requiring provisioned /run config. This remains
   * available to diagnose a running guest whose worker service is unhealthy. */
  async openJournal(owner: IncusStorageOwner, incarnation: string, validateRecord: () => void,
    options: { tail?: number; follow?: boolean; sinceNow?: boolean; signal?: AbortSignal } = {}) {
    return withOwnerWorkerRuntimeSetup(owner.userId, owner.id, async () => {
      const validate = async () => {
        validateRecord();
        const instance = await this.assertOwned(owner.containerName, owner.id);
        validateRecord();
        if (instance.config['user.agentor.owner'] !== owner.userId || !incarnation || instance.config['volatile.uuid'] !== incarnation)
          throw new Error('Incus journal target ownership or incarnation changed');
        if (instance.status !== 'Running') throw new Error('Incus guest journal requires a running VM');
      };
      await validate();
      const command = ['journalctl', '--boot', '--no-pager', '--output=short-iso-precise',
        '_SYSTEMD_UNIT=agentor-worker.service', '+', 'SYSLOG_IDENTIFIER=agentor-app',
        '--lines=' + Math.min(10_000, Math.max(1, Math.trunc(options.tail ?? 200)))];
      if (options.follow) command.push('--follow');
      if (options.sinceNow) command.push('--since=now');
      const session = await this.client.execStream(owner.containerName, command, {
        command: [], user: 0, group: 0, signal: options.signal,
        timeoutMs: options.follow ? 24 * 60 * 60_000 : 10_000,
      });
      try {
        await validate(); session.stdin.end();
        return Object.assign(session, { isCurrent: () => { try { validateRecord(); return true; } catch { return false; } } });
      }
      catch (error) { session.close(); throw error; }
    });
  }

  async resolvePrimaryAddress(owner: IncusStorageOwner): Promise<{ address: string; incarnation: string }> {
    const initial = await this.assertOwned(owner.containerName, owner.id);
    if (initial.config["user.agentor.owner"] !== owner.userId) throw new Error("Incus worker account identity does not match");
    const [network, leases, peers] = await Promise.all([
      this.client.getNetwork(this.config.incusNetwork), this.client.getNetworkLeases(this.config.incusNetwork), this.client.listInstances(),
    ]);
    const result = resolveIncusPrimaryLease(initial, peers, network, leases, this.config.incusNetwork);
    // A name survives recreation. Revalidate host incarnation/metadata after
    // the network reads rather than trusting a potentially stale name/IP pair.
    const current = await this.assertOwned(owner.containerName, owner.id);
    if (current.config["user.agentor.owner"] !== owner.userId) throw new Error("Incus worker account identity does not match");
    const confirmed = resolveIncusPrimaryLease(current, peers, network, leases, this.config.incusNetwork);
    if (confirmed.incarnation !== result.incarnation || confirmed.address !== result.address)
      throw new Error("Incus worker changed during address resolution; retry");
    return confirmed;
  }

  private async assertOwned(name: string, workerId?: string): Promise<IncusInstance> {
    const instance = await this.client.getInstance(name);
    const id = workerId ?? instance.config["user.agentor.id"];
    if (!id || !await this.matchesWorkerIdentity(instance, id))
      throw new Error("Refusing to manage an Incus instance without matching Agentor installation/worker identity");
    return instance;
  }

  commands(owner: IncusStorageOwner, incarnation: string, validateRecord: () => void,
    setup?: <T>(operation: () => Promise<T>) => Promise<T>,
  ): IncusWorkerCommands {
    return new IncusWorkerCommands(this.client, owner.containerName, `incus:${incarnation}`, async () => {
      validateRecord();
      const instance = await this.assertOwned(owner.containerName, owner.id);
      validateRecord();
      if (instance.config['user.agentor.owner'] !== owner.userId ||
          instance.config['volatile.uuid'] !== incarnation || instance.status !== 'Running')
        throw new Error('Incus command target ownership, incarnation or running state changed');
    }, setup ?? ((operation) => withOwnerWorkerRuntimeSetup(owner.userId, owner.id, operation)));
  }

  private validateOptions(opts: IncusWorkerOptions): void {
    // Refuse pending storage features on restart too; never put persistent
    // Docker/account data on disposable rootfs when settings change.
    if (opts.mounts?.length || opts.hardwareDevices?.length)
      throw new Error("Incus mounts and hardware require their feature integration");
    if (opts.credentialBinds?.length && !opts.storageManager)
      throw new Error("Incus account shares require authoritative platform storage");
    if (opts.dockerEnabled !== undefined && opts.dockerEnabled !== opts.environmentJson.dockerEnabled)
      throw new Error("Docker capability must match the resolved worker environment");
    if (opts.image) throw new Error("A custom OCI image requires its derived Incus image mapping");
  }

  private async accountDevices(opts: IncusWorkerOptions): Promise<Record<string, IncusDevice>> {
    if (!opts.storageManager) return {};
    const userHost = opts.storageManager.getUserHostDir(opts.userId);
    const credentials = join(userHost, "credentials");
    const allowedBinds = new Set([
      ...AGENT_CREDENTIAL_MAPPINGS.filter((mapping) => mapping.fileBind !== false)
        .map((mapping) => `${join(credentials, mapping.fileName)}:${mapping.containerPath}`),
      opts.storageManager.getSshAuthorizedKeysBind(opts.userId),
      opts.storageManager.getKiloConfigBind(opts.userId), opts.storageManager.getKiloSharedDataBind(opts.userId),
    ]);
    if (opts.credentialBinds?.some((bind) => !allowedBinds.has(bind)))
      throw new Error("Refusing an unrecognized account share");
    const devices: Record<string, IncusDevice> = {
      // Short device keys also bound QEMU's Unix socket pathname (108 bytes).
      cred: { type: "disk", source: credentials, path: "/run/agentor/account-credentials" },
      kcfg: { type: "disk", source: join(userHost, "kilo/config"), path: "/home/agent/.agent-data/.kilo/config" },
      kdata: { type: "disk", source: join(userHost, "kilo/data"), path: "/home/agent/.agent-data/.kilo/shared-data" },
    };
    const project = await this.client.request<{ config: Record<string, string> }>("GET", `/1.0/projects/${encodeURIComponent(this.config.incusProject)}`);
    const paths = project.config["restricted.devices.disk.paths"]?.split(",").map((path) => path.trim()) ?? [];
    if (project.config.restricted !== "true" || project.config["restricted.devices.disk"] !== "allow" ||
        Object.values(devices).some((device) => !paths.includes(device.source!)))
      throw new Error("Host setup must explicitly allowlist this account's credential and Kilo directories in the restricted Incus project");
    return devices;
  }

  private async assertReady(): Promise<void> {
    const c = this.config;
    if (!c.incusEndpoint?.startsWith("https://") || !c.incusClientCertPath ||
        !c.incusClientKeyPath || !c.incusServerCertPath || !c.incusProject || c.incusProject === "default")
      throw new Error("Incus workers require HTTPS, verified server TLS, client credentials, and a dedicated project");
    if (!c.incusInternalGatewayUrl)
      throw new Error("INCUS_INTERNAL_GATEWAY_URL is required for VM to orchestrator communication");
    if (!c.dataDir || !c.incusNetwork || !c.incusStoragePool)
      throw new Error("Incus workers require installation data, configured worker network and storage pool");
    const readiness = await this.client.getReadiness();
    if (!readiness.ready) throw new Error("Incus worker runtime is unavailable");
    // Earlier 6.0 LTS exports restricted host paths with an implicit unmapped
    // user namespace. Do not compensate by granting host-root ID mappings or
    // unrestricted low-level options; use the upstream fixed share transport.
    const version = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(readiness.serverVersion);
    // LTS backports are not a numeric lower bound for older rolling releases:
    // 6.1–6.9 still have the defect; rolling 6.10 contains the fixed transport.
    if (!version || !(Number(version[1]) > 6 || (Number(version[1]) === 6 &&
        (Number(version[2]) >= 10 || (Number(version[2]) === 0 && Number(version[3] ?? 0) >= 5)))))
      throw new Error("Incus workers require patched Incus (6.0 LTS >=6.0.5 or >=6.10) and compatible Rust virtiofsd; run host setup/check");
    const project = await this.client.request<{ config: Record<string, string> }>(
      "GET", `/1.0/projects/${encodeURIComponent(c.incusProject)}`);
    if (project.config.restricted !== "true") throw new Error("Agentor Incus project must be restricted");
  }

  async create(opts: IncusWorkerOptions): Promise<IncusInstance> {
    await this.assertReady();
    // These features are integrated in the following storage/device phases.
    // Refuse them here rather than silently placing data on disposable rootfs.
    this.validateOptions(opts);
    if (opts.containerName !== `${this.config.containerPrefix}-${opts.id}`)
      throw new Error("Incus worker name must match its WorkerRecord identity");
    const alias = await this.client.getImageAlias(this.config.incusWorkerImage);
    if (alias.type !== "virtual-machine") throw new Error("Incus worker image must be a virtual machine");
    const image = await this.client.getImage(alias.target);
    if (image.properties?.bootstrap_generation !== "3")
      throw new Error("Rebuild the derived Incus worker image with the current safe storage bootstrap");
    const account = await this.accountDevices(opts);
    const persistent = await (await this.storage()).devices(opts, opts.environmentJson.dockerEnabled);
    const instance = await this.client.createInstance({
      name: opts.containerName, type: "virtual-machine", profiles: [],
      source: { type: "image", fingerprint: alias.target },
      config: {
        "user.agentor.id": opts.id,
        "user.agentor.owner": opts.userId,
        "user.agentor.installation": await this.installationId(),
        "user.agentor.runtime-generation": "1",
        "security.secureboot": "false",
        "boot.autostart": "false",
        ...(opts.memoryLimit ? { "limits.memory": opts.memoryLimit } : {}),
        ...(opts.cpuLimit ? { "limits.cpu": String(Math.max(1, Math.ceil(opts.cpuLimit))) } : {}),
      },
      devices: {
        ...persistent,
        ...account,
        root: { type: "disk", path: "/", pool: this.config.incusStoragePool },
        eth0: { type: "nic", name: "eth0", network: this.config.incusNetwork,
          "security.mac_filtering": "true", "security.ipv4_filtering": "true", "security.ipv6_filtering": "true" },
      },
    });
    if (opts.start !== false) await this.start(opts);
    return instance;
  }

  private async checkedExec(name: string, command: string[]): Promise<void> {
    const result = await this.client.exec(name, command);
    if (result.returnCode !== 0) throw new Error(`Incus worker bootstrap command failed (${command[0]}, exit ${result.returnCode})`);
  }

  async start(opts: IncusWorkerOptions): Promise<void> {
    this.validateOptions(opts);
    await this.assertReady();
    const name = opts.containerName;
    const instance = await this.assertOwned(name, opts.id);
    if (instance.config['user.agentor.owner'] !== opts.userId)
      throw new Error('Incus worker account identity does not match');
    const state = await this.client.getInstanceState(name);
    const account = await this.accountDevices(opts);
    for (const [key, expected] of Object.entries(account)) {
      if (!sameDevice(instance.devices[key], expected))
        throw new Error("Incus account share layout is missing or ambiguous; rebuild required");
    }
    const storage = await this.storage();
    const persistent = await storage.devices(opts, opts.environmentJson.dockerEnabled, { docker: !!instance.devices.docker });
    for (const role of ["workspace", "agents"] as const) {
      if (!sameDevice(instance.devices[role], persistent[role]!))
        throw new Error("Incus persistent layout is missing or ambiguous; explicit recovery is required");
    }
    if (persistent.docker && !sameDevice(instance.devices.docker, persistent.docker)) {
      if (instance.devices.docker && (instance.devices.docker.source !== persistent.docker.source || instance.devices.docker.pool !== this.config.incusStoragePool))
        throw new Error("Incus Docker device identity is ambiguous");
      if (state.status === "Running") throw new Error("Restart the VM to attach native Docker storage");
      await this.client.updateInstanceDevices(name, { ...instance.devices, ...persistent });
    }
    if (state.status !== "Running") await this.client.startInstance(name);
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const result = await this.client.exec(name, ["true"]);
        if (result.returnCode === 0) { ready = true; break; }
      } catch { /* Agent becomes available after the guest has booted. */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("Incus worker agent did not become ready");
    try {
      await this.checkedExec(name, ["bash", "-ec", 'test "$(cat /usr/lib/agentor/bootstrap-generation)" = 3; mountpoint -q /workspace; mountpoint -q /home/agent/.agent-data']);
      await this.checkedExec(name, ["systemctl", "stop", "agentor-worker.service"]);
      if (Object.keys(account).length) {
        for (const device of Object.values(account)) await this.checkedExec(name, ["mountpoint", "-q", device.path!]);
        // Reproduce existing regular-file bind semantics. CLI atomic rename
        // then falls back to in-place writes; symlinks would break sharing.
        for (const mapping of AGENT_CREDENTIAL_MAPPINGS.filter((entry) => entry.fileBind !== false)) {
          await this.checkedExec(name, ["bash", "-ec", [
            'source="$1"; target="$2"', 'test -f "$source"', 'test ! -L "$source"', 'test "$(stat -c %h "$source")" = 1',
            // Replaced virtiofs files leave an unstatable pinned inode. Read
            // kernel mount metadata before touching the target, then detach
            // without canonicalizing it. Never force/lazily unmount a busy file.
            'if awk -v target="$target" \'$5 == target { mounted=1 } END { exit !mounted }\' /proc/self/mountinfo; then umount --internal-only --no-canonicalize -- "$target"; fi',
            'test ! -L "$target"',
            'mkdir -p "$(dirname "$target")"', 'if [ ! -e "$target" ]; then install -o 1000 -g 1000 -m 0600 /dev/null "$target"; fi',
            'test -f "$target"', 'mount --bind "$source" "$target"',
          ].join("; "), "agentor-bind", `/run/agentor/account-credentials/${mapping.fileName}`, mapping.containerPath]);
        }
      }
      await this.checkedExec(name, ["rm", "-f", "/tmp/worker-events", "/run/agentor/provisioned", "/run/agentor/worker.env"]);
      await this.provision(opts);
      await this.checkedExec(name, ["systemctl", "stop", "docker", "docker.socket", "containerd", "agentor-docker-storage"]);
      if (opts.environmentJson.dockerEnabled) {
        await this.client.pushFile(name, "/run/agentor/docker-storage.json", JSON.stringify({
          serial: "incus_docker", volume: persistent.docker!.source,
          initialize: await storage.dockerInitializationAllowed(opts),
        }), { uid: 0, gid: 0, mode: 0o600 });
        await this.checkedExec(name, ["systemctl", "unmask", "docker", "docker.socket", "containerd", "agentor-docker-storage"]);
        await this.checkedExec(name, ["systemctl", "start", "agentor-docker-storage"]);
        await this.checkedExec(name, ["mountpoint", "-q", "/var/lib/docker"]);
        await storage.markDockerInitialized(opts);
      } else {
        await this.checkedExec(name, ["rm", "-f", "/run/agentor/docker-storage.json"]);
        // The local storage unit is gated by absent /run authorization. Unlike
        // vendor Docker units, masking it would overwrite an installed unit.
        await this.checkedExec(name, ["systemctl", "mask", "docker", "docker.socket", "containerd"]);
      }
      await this.checkedExec(name, ["systemctl", "start", "agentor-worker.service"]);
      await this.checkedExec(name, ["systemctl", "is-active", "--quiet", "agentor-worker.service"]);
      const workerDeadline = Date.now() + 120_000;
      let workerReady = false;
      while (Date.now() < workerDeadline) {
        await this.checkedExec(name, ["systemctl", "is-active", "--quiet", "agentor-worker.service"]);
        const result = await this.client.exec(name, ["grep", "-q", "^READY|", "/tmp/worker-events"]);
        if (result.returnCode === 0) { workerReady = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!workerReady) throw new Error("Incus worker service did not complete startup");
    } catch (error) {
      await this.stop(name).catch(() => {});
      throw error;
    }
  }

  private async provision(opts: IncusWorkerOptions): Promise<void> {
    const name = opts.containerName;
    await this.client.pushFile(name, "/run/agentor", "", { type: "directory", mode: 0o711 });
    const values: Record<string, string> = Object.fromEntries(renderUserEnvVars(opts.userEnv).map((line) => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const local = (opts.workerConfig ?? []).filter((entry) => entry.kind !== "secretFile")
      .map(({ key, value }) => ({ key, value }));
    values.WORKER_LOCAL_ENV = Buffer.from(JSON.stringify(local)).toString("base64");
    Object.assign(values, {
      ENVIRONMENT: JSON.stringify(opts.environmentJson),
      CAPABILITIES: JSON.stringify(opts.capabilitiesJson),
      INSTRUCTIONS: JSON.stringify(opts.instructionsJson),
      WORKER: JSON.stringify(opts.workerJson),
      ORCHESTRATOR_URL: this.config.incusInternalGatewayUrl,
      WORKER_CONTAINER_NAME: name, AGENTOR_RUNTIME_ROLE: "worker",
    });
    await this.client.pushFile(name, "/run/agentor-secrets", "", { type: "directory", mode: 0o711 });
    for (const file of opts.workerConfig ?? []) {
      if (file.kind !== "secretFile") continue;
      const parts = file.fileName?.split("/");
      if (!parts?.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")))
        throw new Error("Invalid worker secret-file name");
      let parent = "/run/agentor-secrets";
      for (const part of parts.slice(0, -1)) {
        parent += `/${part}`;
        await this.client.pushFile(name, parent, "", { type: "directory", mode: 0o711 });
      }
      await this.client.pushFile(name, `/run/agentor-secrets/${file.fileName}`, file.value,
        { mode: 0o600, uid: 1000, gid: 1000 });
    }
    await this.client.pushFile(name, "/home/agent/.ssh", "", { type: "directory", mode: 0o700, uid: 1000, gid: 1000 });
    await this.client.pushFile(name, "/home/agent/.ssh/authorized_keys", opts.sshAuthorizedKeys ?? "",
      { mode: 0o600, uid: 1000, gid: 1000 });
    // Publish service prerequisites only once all config/secrets/keys exist.
    await this.client.pushFile(name, "/run/agentor/worker.env", serializeIncusWorkerEnv(values),
      { mode: 0o640, uid: 0, gid: 1000 });
    await this.client.pushFile(name, "/run/agentor/provisioned", "agentor-runtime-v1\n", { mode: 0o600, uid: 0, gid: 0 });
  }

  async stop(name: string): Promise<void> {
    await this.assertOwned(name);
    const state = await this.client.getInstanceState(name);
    if (state.status !== "Stopped") await this.client.stopInstance(name, { timeout: 30 });
  }

  async refreshSshKeys(owner: IncusStorageOwner, content: string): Promise<void> {
    const instance = await this.assertOwned(owner.containerName, owner.id);
    if (instance.config["user.agentor.owner"] !== owner.userId)
      throw new Error("Incus worker account identity does not match");
    if ((await this.client.getInstanceState(owner.containerName)).status !== "Running") return;
    await this.client.pushFile(owner.containerName, "/home/agent/.ssh/authorized_keys", content,
      { mode: 0o600, uid: 1000, gid: 1000 });
  }

  async remove(name: string): Promise<void> {
    try {
      await this.assertOwned(name);
      await this.stop(name);
      await this.client.deleteInstance(name);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
  }
}
