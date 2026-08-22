import Docker from "dockerode";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { PassThrough } from "node:stream";
import { pack } from "tar-stream";
import type { Config } from "./config";
import type { ContainerInfo } from "../../shared/types";
import {
  useContainerManager,
  useDockerService,
  useUserEnvStore,
} from "./services";
import { renderUserEnvVars } from "./user-env-store";
import { useImageCatalogManager } from "./image-catalog";
import type {
  AdministrativeWorkspaceRecord,
  AdminWorkspaceRuntimeAdapter,
  AdminWorkspaceRuntimeImage,
  AdminWorkspaceStartupScriptRuntimeStatus,
} from "./admin-workspace-store";
import { normalizedRevision } from "./admin-workspace-store";

const MANAGEMENT_NETWORK = "agentor-management";
const EGRESS_NETWORK = "agentor-admin-egress-v1";
// Bump this whenever the trusted overlay/base contract changes in a way that
// must be materialized for existing persistent administrative workspaces.
// The workspace volume remains untouched; only its disposable compute image
// is refreshed.
const ADMIN_OVERLAY_VERSION = "4";
const ADMIN_CONTAINER = "agentor-admin-workspace";
const ADMIN_WORKSPACE_VOLUME = "agentor-admin-workspace-data";
const ADMIN_AGENTS_VOLUME = "agentor-admin-agent-data";
const ADMIN_LABEL = "agentor.administrative";
const STARTUP_REVISION_LABEL = "agentor.admin.startup-script-revision";
const STARTUP_STATUS_PATH =
  "/home/agent/.agent-data/.agentor/admin-startup-script-status.json";
const STARTUP_STATUS_DIR = "/home/agent/.agent-data/.agentor";

/** Docker boundary for the singleton administrative workspace. Every Docker
 * input is generated here; requests cannot choose images, mounts, commands,
 * networks, or capabilities. Only the owning administrator's standard worker
 * environment enters the container; no Docker socket or host bind does. */
export class DockerAdminWorkspaceRuntime
  implements AdminWorkspaceRuntimeAdapter
{
  private readonly docker = new Docker({ socketPath: "/var/run/docker.sock" });
  private readonly image: string;
  private managementListener?: (host: string) => Promise<void>;
  constructor(private readonly config: Config) {
    this.image =
      process.env.AGENTOR_ADMIN_WORKER_IMAGE || "agentor-admin-worker:latest";
  }

  private resources(record: Readonly<AdministrativeWorkspaceRecord>) {
    const groupId =
      record.kind === "group-administrative"
        ? ((record as any).groupId as string)
        : undefined;
    const suffix = groupId ? `group-${groupId}` : "workspace";
    return {
      groupId,
      container: groupId ? `agentor-admin-${suffix}` : ADMIN_CONTAINER,
      workspaceVolume: groupId
        ? `agentor-admin-${suffix}-data`
        : ADMIN_WORKSPACE_VOLUME,
      agentsVolume: groupId
        ? `agentor-admin-${suffix}-agent-data`
        : ADMIN_AGENTS_VOLUME,
      displayName: groupId ? "GROUP ADMIN" : "ADMIN / ORCHESTRATOR",
      managementNetwork: groupId
        ? `agentor-management-group-${groupId}`
        : MANAGEMENT_NETWORK,
      egressNetwork: groupId
        ? `agentor-admin-egress-group-${groupId}`
        : EGRESS_NETWORK,
    };
  }
  setManagementListener(listener: (host: string) => Promise<void>) {
    this.managementListener = listener;
  }

  async setClipboard(
    mime: "image/png" | "text/plain",
    bytes: Buffer,
    record?: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<void> {
    const container = this.docker.getContainer(
      record ? this.resources(record).container : ADMIN_CONTAINER,
    );
    const inspection = await container.inspect();
    if (!inspection.State.Running)
      throw Object.assign(
        new Error("Administrative workspace is not running"),
        { statusCode: 409 },
      );
    const execution = await container.exec({
      Cmd: [
        "sh",
        "-c",
        'head -c "$1" | /home/agent/clipboard/set.sh "$2"',
        "agentor-clipboard",
        String(bytes.length),
        mime,
      ],
      AttachStdin: true,
      AttachStdout: false,
      AttachStderr: false,
      User: "agent",
    });
    const stream = await execution.start({ hijack: true, stdin: true });
    stream.end(bytes);
    let result = await execution.inspect();
    for (let attempt = 0; result.Running && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      result = await execution.inspect();
    }
    if (result.Running)
      throw Object.assign(
        new Error("Administrative clipboard helper timed out"),
        { statusCode: 504 },
      );
    if (result.ExitCode !== 0)
      throw Object.assign(new Error("Failed to set administrative clipboard"), {
        statusCode: 422,
      });
  }

  async initializeBoundary(): Promise<void> {
    await this.ensureManagementNetwork();
    await this.ensureEgressNetwork();
    await this.attachOrchestrator();
    await this.reconcileManagementNetwork();
    await this.reconcileEgressNetwork();
  }

  async managementAddress(networkName = MANAGEMENT_NETWORK): Promise<string> {
    const inspection = await this.orchestratorInspection();
    if (!inspection) return "127.0.0.1";
    const address =
      inspection.NetworkSettings?.Networks?.[networkName]?.IPAddress;
    if (!address)
      throw new Error("Orchestrator is not attached to the management network");
    return address;
  }

  async materializeCredential(
    credential: string,
    record?: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<void> {
    const container = this.docker.getContainer(
      record ? this.resources(record).container : ADMIN_CONTAINER,
    );
    const inspection = await container.inspect();
    if (!inspection.State.Running) return;
    const execution = await container.exec({
      Cmd: [
        "sh",
        "-c",
        "umask 077; tee /run/agentor-management/.credential.tmp >/dev/null && mv /run/agentor-management/.credential.tmp /run/agentor-management/credential",
      ],
      AttachStdin: true,
      AttachStdout: false,
      AttachStderr: false,
    });
    const stream = await execution.start({ hijack: true, stdin: true });
    stream.end(`${credential}\n`);
  }

  private async ensureContainer(
    record: Readonly<AdministrativeWorkspaceRecord>,
    reconcileDesiredStatus: boolean,
  ): Promise<AdminWorkspaceRuntimeImage> {
    const resources = this.resources(record);
    await this.ensureManagementNetwork(resources.managementNetwork);
    await this.ensureEgressNetwork(resources.egressNetwork);
    await this.attachOrchestrator(resources.managementNetwork);
    if (this.managementListener)
      await this.managementListener(
        await this.managementAddress(resources.managementNetwork),
      );
    const image = await this.ensureOverlayImage(false, record.imageDigest);
    let container = this.docker.getContainer(resources.container);
    try {
      const inspection = await container.inspect();
      if (
        inspection.Config?.Labels?.[ADMIN_LABEL] !== "true" ||
        inspection.Image !== image.digest ||
        // NetworkMode is immutable. Recreate legacy administrative containers
        // whose primary network was the ordinary worker network rather than
        // silently retaining that privilege boundary violation on restart.
        inspection.HostConfig?.NetworkMode !== resources.managementNetwork
      ) {
        const persistentPathMounts = await this.persistentBackupPathMounts(
          record,
          inspection.Id,
          inspection.State.Running,
        );
        await container.remove({ force: true });
        container = await this.create(record, image.digest, persistentPathMounts);
      }
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
      container = await this.create(record, image.digest);
    }
    const status = await container.inspect();
    if (reconcileDesiredStatus) {
      if (record.status === "running" && !status.State.Running)
        await container.start();
      if (record.status === "stopped" && status.State.Running)
        await container.stop({ t: 15 });
      if (record.status === "running") await this.waitForReady(container);
    }
    const current = await container.inspect();
    await this.ensureAdminAttached(container, record);
    if (current.State.Running)
      await this.syncControlRepresentation(container, record);
    await this.registerServices(record, container);
    await this.reconcileManagementNetwork(
      resources.managementNetwork,
      container.id,
    );
    return this.runtimeImage(image, current);
  }

  async ensure(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceRuntimeImage> {
    return this.ensureContainer(record, true);
  }

  async start(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceRuntimeImage> {
    // An explicit start is also the application boundary for a pending script.
    // Prepare the container without reconciling a persisted `running` state;
    // otherwise a stopped legacy container could briefly execute the previous
    // revision before it is replaced below.
    const image = await this.ensureContainer(record, false);
    let container = this.docker.getContainer(
      this.resources(record).container,
    );
    const before = await container.inspect();
    if (
      this.appliedStartupScriptRevision(before) !==
      normalizedRevision(record.startupScriptRevision)
    ) {
      // Docker Env is immutable. An explicit start is the application boundary
      // for a pending script: replace disposable compute while retaining both
      // persistent volumes and the stable administrative workspace identity.
      const persistentPathMounts = await this.persistentBackupPathMounts(
        record,
        before.Id,
        before.State.Running,
      );
      await container.remove({ force: true });
      container = await this.create(record, image.digest, persistentPathMounts);
    }
    if (!(await container.inspect()).State.Running) await container.start();
    await this.waitForReady(container);
    await this.ensureAdminAttached(container, record);
    await this.syncControlRepresentation(container, record);
    await this.registerServices(record, container);
    return this.runtimeImage(image, await container.inspect());
  }

  async stop(_record: Readonly<AdministrativeWorkspaceRecord>): Promise<void> {
    try {
      const container = this.docker.getContainer(
        this.resources(_record).container,
      );
      if ((await container.inspect()).State.Running)
        await container.stop({ t: 15 });
      await this.registerServices(_record, container);
    } catch (error: any) {
      if (error?.statusCode !== 404 && error?.statusCode !== 304) throw error;
    }
  }

  async rebuild(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceRuntimeImage> {
    let persistentPathMounts: Array<{ source: string; target: string }> = [];
    try {
      const old = this.docker.getContainer(this.resources(record).container);
      const inspection = await old.inspect();
      persistentPathMounts = await this.persistentBackupPathMounts(
        record,
        inspection.Id,
        inspection.State.Running,
      );
      await old.remove({ force: true });
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
    }
    const image = await this.ensureOverlayImage(true);
    const container = await this.create(
      record,
      image.digest,
      persistentPathMounts.length ? persistentPathMounts : undefined,
    );
    await container.start();
    await this.waitForReady(container);
    await this.ensureAdminAttached(container, record);
    await this.syncControlRepresentation(container, record);
    await this.registerServices(record, container);
    await this.reconcileManagementNetwork(
      this.resources(record).managementNetwork,
      container.id,
    );
    return this.runtimeImage(image, await container.inspect());
  }

  async startupScriptStatus(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceStartupScriptRuntimeStatus> {
    if (!record.startupScript) return { state: "not-configured" };
    if (
      normalizedRevision(record.startupScriptRevision) !==
      normalizedRevision(record.appliedStartupScriptRevision)
    )
      return {
        state: "pending-rebuild",
        revision: normalizedRevision(record.startupScriptRevision),
      };
    const container = this.docker.getContainer(this.resources(record).container);
    const inspection = await container.inspect();
    if (!inspection.State.Running)
      return {
        state: "unavailable",
        revision: normalizedRevision(record.appliedStartupScriptRevision),
      };
    const execution = await container.exec({
      Cmd: [
        "timeout",
        "1",
        "sh",
        "-c",
        `status='${STARTUP_STATUS_PATH}'; if [ -L "$status" ] || [ ! -f "$status" ]; then exit 0; fi; size=$(wc -c < "$status") || exit 0; [ "$size" -le 16384 ] || exit 0; head -c 16384 -- "$status"`,
      ],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: "agent",
    });
    const stream = await execution.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output: Buffer[] = [];
    let outputBytes = 0;
    stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= 16_384) output.push(Buffer.from(chunk));
    });
    stderr.resume();
    const completion = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.removeListener("end", onEnd);
        stream.removeListener("close", onEnd);
        stream.removeListener("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onEnd = () => settle();
      const onError = (error: Error) => settle(error);
      const timer = setTimeout(() => {
        // The command has its own one-second bound. Destroy the hijacked
        // attachment as well so a broken daemon/stream cannot accumulate
        // listeners or buffered output after the API request has settled.
        stream.destroy();
        settle(new Error("Administrative startup status timed out"));
      }, 2_000);
      timer.unref?.();
      stream.once("end", onEnd);
      stream.once("close", onEnd);
      stream.once("error", onError);
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);
    await completion;
    const raw = Buffer.concat(output).toString("utf8").trim();
    if (!raw)
      return {
        state: "starting",
        revision: normalizedRevision(record.appliedStartupScriptRevision),
      };
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      !["running", "succeeded", "failed"].includes(parsed.state) ||
      parsed.revision !== normalizedRevision(record.appliedStartupScriptRevision)
    )
      return {
        state: "starting",
        revision: normalizedRevision(record.appliedStartupScriptRevision),
      };
    return {
      state: parsed.state,
      revision: parsed.revision,
      ...(typeof parsed.startedAt === "string"
        ? { startedAt: parsed.startedAt }
        : {}),
      ...(typeof parsed.finishedAt === "string"
        ? { finishedAt: parsed.finishedAt }
        : {}),
      ...(Number.isInteger(parsed.exitCode) ? { exitCode: parsed.exitCode } : {}),
    };
  }

  async remove(record: Readonly<AdministrativeWorkspaceRecord>): Promise<void> {
    const resources = this.resources(record);
    try {
      await this.docker
        .getContainer(resources.container)
        .remove({ force: true });
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
    }
    for (const volume of [resources.workspaceVolume, resources.agentsVolume]) {
      try {
        await this.docker.getVolume(volume).remove();
      } catch (error: any) {
        if (error?.statusCode !== 404) throw error;
      }
    }
    const { usePersistentBackupPathManager } = await import("./services");
    await usePersistentBackupPathManager().removeWorkerVolumes(record.id);
    for (const networkName of [
      resources.managementNetwork,
      resources.egressNetwork,
    ]) {
      if (networkName === MANAGEMENT_NETWORK || networkName === EGRESS_NETWORK)
        continue;
      try {
        const network = this.docker.getNetwork(networkName);
        const inspection = await network.inspect();
        for (const containerId of Object.keys(inspection.Containers || {}))
          await network.disconnect({ Container: containerId, Force: true });
        await network.remove();
      } catch (error: any) {
        if (error?.statusCode !== 404) throw error;
      }
    }
    useContainerManager().unregisterExternal?.(record.id);
  }

  private async waitForReady(container: Docker.Container): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const inspection = await container.inspect();
      const state = inspection.State;
      if (!state.Running)
        throw new Error(
          `Administrative workspace stopped during startup${state.Error ? `: ${state.Error}` : ""}`,
        );
      if (!inspection.Config?.Healthcheck && !state.Health) return;
      if (state.Health?.Status === "healthy") return;
      if (state.Health?.Status === "unhealthy")
        throw new Error(
          "Administrative workspace failed its startup health check",
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      "Administrative workspace did not become ready within 90 seconds",
    );
  }

  async security(workerId?: string) {
    const adminId = await this.adminId();
    const target =
      workerId && workerId !== adminId
        ? useContainerManager().get(workerId)?.containerId
        : ADMIN_CONTAINER;
    if (!target) return undefined;
    const inspection = await this.docker.getContainer(target).inspect();
    let controlRepresentation = false;
    if (inspection.Config?.Labels?.[ADMIN_LABEL] === "true") {
      try {
        const stream = await this.docker.getContainer(target).getArchive({
          path: "/workspace/agentor-control/image-definitions.json",
        });
        controlRepresentation = true;
        (stream as any).destroy?.();
      } catch {
        /* missing representation is reported, never synthesized */
      }
    }
    const mounts = (inspection.Mounts || []).map((mount) => ({
      type: mount.Type,
      destination: mount.Destination,
      readOnly: mount.RW === false,
    }));
    return {
      managedWorker: true,
      administrative: inspection.Config?.Labels?.[ADMIN_LABEL] === "true",
      managementNetworkAttached: Object.keys(
        inspection.NetworkSettings?.Networks || {},
      ).some(
        (name) =>
          name === MANAGEMENT_NETWORK ||
          name.startsWith("agentor-management-group-"),
      ),
      networks: Object.keys(inspection.NetworkSettings?.Networks || {}),
      publishedPorts: Object.values(inspection.NetworkSettings?.Ports || {})
        .flatMap((bindings) => bindings || [])
        .map((binding) => binding.HostPort),
      rawDockerSocket: mounts.some(
        (mount) =>
          mount.destination === "/var/run/docker.sock" ||
          mount.destination === "/run/docker.sock",
      ),
      hostExecution: Boolean(
        inspection.HostConfig?.Privileged ||
          inspection.HostConfig?.PidMode === "host",
      ),
      hostFilesystemMounts: mounts.filter((mount) => mount.type === "bind"),
      mounts,
      controlRepresentation,
    };
  }

  async managementNetworkSecurity() {
    await this.reconcileManagementNetwork();
    const inspection = await this.docker
      .getNetwork(MANAGEMENT_NETWORK)
      .inspect();
    const members = Object.entries(inspection.Containers || {}).map(
      ([containerId, member]) => ({
        containerId,
        name: member.Name,
        ipv4Address: member.IPv4Address,
      }),
    );
    const admins = [] as typeof members;
    for (const member of members) {
      const candidate = await this.docker
        .getContainer(member.containerId)
        .inspect();
      if (candidate.Config?.Labels?.[ADMIN_LABEL] === "true")
        admins.push(member);
    }
    const admin = admins.find((member) => member.name === ADMIN_CONTAINER);
    const orchestratorName = process.env.HOSTNAME || hostname();
    const orchestrator = members.find(
      (member) =>
        member.name === orchestratorName ||
        member.containerId.startsWith(orchestratorName),
    );
    return {
      network: MANAGEMENT_NETWORK,
      internal: inspection.Internal === true,
      publishedPorts: [],
      traefikRoutes: [],
      rawDockerSocket: false,
      attachedWorkspaceIds: (
        await Promise.all(
          admins.map(
            async (member) =>
              (await this.docker.getContainer(member.containerId).inspect())
                .Config?.Labels?.["agentor.admin.workspace-id"],
          ),
        )
      ).filter(Boolean),
      normalWorkerIds: [],
      members,
      orchestratorAttached: Boolean(orchestrator),
      unexpectedMembers: members.filter(
        (member) => !admins.includes(member) && member !== orchestrator,
      ),
    };
  }

  private async adminId(): Promise<string | undefined> {
    try {
      return (await this.docker.getContainer(ADMIN_CONTAINER).inspect()).Config
        ?.Labels?.["agentor.admin.workspace-id"];
    } catch {
      return undefined;
    }
  }

  private async persistentBackupPathMounts(
    record: Readonly<AdministrativeWorkspaceRecord>,
    containerId?: string,
    running = false,
  ) {
    if (!record.ownerId) return [];
    const [{ useBackupManager }, { usePersistentBackupPathManager }] =
      await Promise.all([import("./backup-manager"), import("./services")]);
    const config = await useBackupManager().getConfig(record.ownerId);
    const paths = config?.selectedPathsByWorkspace?.[record.id];
    const manager = usePersistentBackupPathManager();
    return containerId
      ? manager.prepareWorker(
          { id: record.id, containerId, status: running ? "running" : "stopped" },
          paths,
        )
      : manager.mountsForSelections(record.id, paths);
  }

  private async create(
    record: Readonly<AdministrativeWorkspaceRecord>,
    imageDigest: string,
    preparedPersistentPathMounts?: Array<{ source: string; target: string }>,
  ): Promise<Docker.Container> {
    const environment = {
      networkMode: "full",
      allowedDomains: [],
      dockerEnabled: false,
      setupScript: "",
      envVars: "",
      exposeApis: {
        portMappings: false,
        domainMappings: false,
        usage: false,
        tmux: false,
      },
    };
    const resources = this.resources(record);
    const persistentPathMounts =
      preparedPersistentPathMounts ??
      (await this.persistentBackupPathMounts(record));
    const worker = {
      id: record.id,
      displayName: resources.displayName,
      repos: [],
      initScript: renderAdministrativeStartupScript(record),
      gitName: "Agentor Administrator",
      gitEmail: "admin@agentor.internal",
    };
    const container = await this.docker.createContainer({
      Image: imageDigest,
      name: resources.container,
      Env: [
        `ENVIRONMENT=${JSON.stringify(environment)}`,
        "CAPABILITIES=[]",
        "INSTRUCTIONS=[]",
        `WORKER=${JSON.stringify(worker)}`,
        "AGENTOR_ADMIN_WORKSPACE=1",
        `AGENTOR_ADMIN_BANNER=${resources.displayName}`,
        ...(resources.groupId
          ? [
              `AGENTOR_GROUP_ADMIN_WORKSPACE=1`,
              `AGENTOR_GROUP_ID=${resources.groupId}`,
            ]
          : []),
        "AGENTOR_MANAGEMENT_MCP_URL=http://agentor-orchestrator:3099/mcp",
        "ORCHESTRATOR_URL=http://agentor-orchestrator:3000",
        `WORKER_CONTAINER_NAME=${resources.container}`,
        ...(record.ownerId
          ? renderUserEnvVars(
              useUserEnvStore().getOrDefault(record.ownerId),
            ).filter((line) => !line.startsWith("AGENTOR_RUNTIME_ROLE="))
          : []),
        // Derived from the authoritative administrative workspace record,
        // never from request-controlled worker or environment data. Appending
        // after owner env prevents a same-named custom variable from choosing
        // another role.
        `AGENTOR_RUNTIME_ROLE=${resources.groupId ? "group-admin" : "platform-admin"}`,
      ],
      Tty: true,
      OpenStdin: true,
      Labels: {
        [ADMIN_LABEL]: "true",
        "agentor.admin.workspace-id": record.id,
        ...(resources.groupId
          ? { "agentor.admin.group-id": resources.groupId }
          : {}),
        "agentor.managed": "false",
        [STARTUP_REVISION_LABEL]: String(
          normalizedRevision(record.startupScriptRevision),
        ),
      },
      HostConfig: {
        // Make the restricted network part of the immutable container
        // configuration. A secondary network attachment made before first
        // start can be discarded by some Docker daemons (notably nested
        // dockerd); using it as the primary network keeps the boundary stable.
        NetworkMode: resources.managementNetwork,
        Binds: [
          `${resources.workspaceVolume}:/workspace`,
          `${resources.agentsVolume}:/home/agent/.agent-data`,
        ],
        Mounts: (persistentPathMounts.length
          ? persistentPathMounts.map((mount) => ({
              Type: "volume" as const,
              Source: mount.source,
              Target: mount.target,
              VolumeOptions: { NoCopy: true },
            }))
          : undefined) as any,
        Init: true,
        RestartPolicy: { Name: "unless-stopped" },
        ShmSize: 512 * 1024 * 1024,
        CapDrop: ["NET_RAW"],
        Tmpfs: {
          "/run/agentor-management":
            "rw,nosuid,nodev,noexec,mode=0700,uid=1000,gid=1000,size=1048576",
        },
      },
    });
    // Keep the administrative workspace off the ordinary worker network. The
    // orchestrator is attached to MANAGEMENT_NETWORK and proxies its normal
    // terminal/editor/desktop routes from there, so a second attachment is
    // neither needed nor safe: it would let every ordinary worker on
    // dockerNetwork address this privileged workspace directly.
    await this.reconcileManagementNetwork(
      resources.managementNetwork,
      container.id,
    );
    return container;
  }

  private appliedStartupScriptRevision(
    inspection: Docker.ContainerInspectInfo,
  ) {
    const parsed = Number(
      inspection.Config?.Labels?.[STARTUP_REVISION_LABEL] ?? 0,
    );
    return normalizedRevision(parsed);
  }

  private runtimeImage(
    image: AdminWorkspaceRuntimeImage,
    inspection: Docker.ContainerInspectInfo,
  ): AdminWorkspaceRuntimeImage {
    return {
      ...image,
      appliedStartupScriptRevision:
        this.appliedStartupScriptRevision(inspection),
    };
  }

  private async registerServices(
    record: Readonly<AdministrativeWorkspaceRecord>,
    container: Docker.Container,
  ) {
    const inspection = await container.inspect();
    const resources = this.resources(record);
    const info: ContainerInfo = {
      administrativeKind: resources.groupId ? "group" : "platform",
      id: record.id,
      userId: record.ownerId || "__agentor_admin__",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      containerId: inspection.Id,
      containerName: resources.container,
      displayName: resources.displayName,
      imageName: this.image,
      imageId: inspection.Image,
      imageDigest: inspection.Image,
      imageRuntimeReference: inspection.Image,
      status: inspection.State.Running ? "running" : "stopped",
    };
    useContainerManager().registerExternal(info);
  }

  private async syncControlRepresentation(
    container: Docker.Container,
    record: Readonly<AdministrativeWorkspaceRecord>,
  ) {
    const resources = this.resources(record);
    const catalog = useImageCatalogManager();
    await catalog.init();
    const definitions = catalog
      .list(
        resources.groupId ? record.ownerId || "" : "__agentor_admin__",
        !resources.groupId,
      )
      .map((definition) => ({
        id: definition.id,
        ownerId: definition.ownerId,
        name: definition.name,
        description: definition.description,
        baseImage: definition.baseImage,
        dockerfileFragment: definition.dockerfileFragment,
        contextPaths: definition.contextFiles.map((file) => file.path),
        promotedVersion: definition.promotedVersion,
        versions: definition.versions.map(
          ({
            version,
            digest,
            baseImage,
            createdAt,
            promoted,
            runtimeImage,
            recovered,
          }) => ({
            version,
            digest,
            baseImage,
            createdAt,
            promoted,
            runtimeImage,
            recovered,
          }),
        ),
      }));
    const archive = pack();
    archive.entry(
      { name: "agentor-control/README.md", mode: 0o444 },
      resources.groupId
        ? `# GROUP ADMIN\n\nThis workspace is restricted to worker group ${resources.groupId}. Its management identity is checked against live membership on every call.\n`
        : "# ADMIN / ORCHESTRATOR\n\nThis directory is an orchestrator-generated, read-only-in-intent representation of image definitions and runtime topology. Use the management MCP proposal/approval workflow for changes. It never contains account credentials or worker secret values.\n",
    );
    archive.entry(
      { name: "agentor-control/image-definitions.json", mode: 0o444 },
      `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), definitions }, null, 2)}\n`,
    );
    archive.entry(
      { name: "agentor-control/runtime.json", mode: 0o444 },
      `${JSON.stringify({ schemaVersion: 1, managementNetwork: resources.managementNetwork, adminImage: this.image, ...(resources.groupId ? { groupId: resources.groupId } : { workerNetwork: this.config.dockerNetwork }) }, null, 2)}\n`,
    );
    archive.finalize();
    await container.putArchive(archive as any, { path: "/workspace" });
  }

  private async ensureManagementNetwork(networkName = MANAGEMENT_NETWORK) {
    const existing = await this.docker.listNetworks({
      filters: { name: [networkName] },
    });
    const network = existing.find(
      (candidate) => candidate.Name === networkName,
    );
    if (!network)
      await this.docker.createNetwork({
        Name: networkName,
        Driver: "bridge",
        Internal: true,
        CheckDuplicate: true,
        Labels: { "agentor.management": "true" },
      });
    else {
      const inspection = await this.docker.getNetwork(network.Id).inspect();
      if (
        !inspection.Internal ||
        inspection.Driver !== "bridge" ||
        inspection.Labels?.["agentor.management"] !== "true"
      )
        throw new Error(
          "Existing management network does not satisfy the internal trusted-network policy",
        );
    }
  }

  private async ensureEgressNetwork(networkName = EGRESS_NETWORK) {
    const existing = await this.docker.listNetworks({
      filters: { name: [networkName] },
    });
    const network = existing.find(
      (candidate) => candidate.Name === networkName,
    );
    if (!network) {
      await this.docker.createNetwork({
        Name: networkName,
        Driver: "bridge",
        Internal: false,
        CheckDuplicate: true,
        Labels: { "agentor.admin-egress": "true" },
      });
      return;
    }
    const inspection = await this.docker.getNetwork(network.Id).inspect();
    if (
      inspection.Internal ||
      inspection.Driver !== "bridge" ||
      inspection.Labels?.["agentor.admin-egress"] !== "true"
    )
      throw new Error(
        "Existing admin egress network does not satisfy the isolated outbound-network policy",
      );
  }

  private async reconcileEgressNetwork(
    networkName = EGRESS_NETWORK,
    adminContainerId?: string,
  ) {
    const network = this.docker.getNetwork(networkName);
    const inspection = await network.inspect();
    if (inspection.Internal || inspection.Driver !== "bridge")
      throw new Error("Admin egress network is not an outbound bridge");
    if (!adminContainerId) {
      try {
        adminContainerId = (
          await this.docker.getContainer(ADMIN_CONTAINER).inspect()
        ).Id;
      } catch {
        /* not provisioned yet */
      }
    } else {
      adminContainerId = (
        await this.docker.getContainer(adminContainerId).inspect()
      ).Id;
    }
    const administrativeIds = new Set<string>(
      adminContainerId ? [adminContainerId] : [],
    );
    for (const containerId of Object.keys(inspection.Containers || {})) {
      if (administrativeIds.has(containerId)) continue;
      await network.disconnect({ Container: containerId, Force: true });
    }
  }

  private async attachOrchestrator(networkName = MANAGEMENT_NETWORK) {
    const inspection = await this.orchestratorInspection();
    if (!inspection) return; // direct-host development
    if (!inspection.NetworkSettings?.Networks?.[networkName])
      await this.docker
        .getNetwork(networkName)
        .connect({ Container: inspection.Id });
    const attached = await this.docker.getContainer(inspection.Id).inspect();
    if (!attached.NetworkSettings?.Networks?.[networkName])
      throw new Error(
        "Docker did not attach the orchestrator to the management network",
      );
  }

  /** Resolve the current orchestrator even when Docker/Compose gives it a
   * hostname that differs from its stable container name. Only 404 is treated
   * as a candidate miss; operational Docker errors must remain visible. */
  private async orchestratorInspection(): Promise<
    Docker.ContainerInspectInfo | undefined
  > {
    const candidates = [
      process.env.HOSTNAME,
      hostname(),
      "agentor-orchestrator",
    ].filter(
      (value, index, all): value is string =>
        Boolean(value) && all.indexOf(value) === index,
    );
    for (const candidate of candidates) {
      try {
        return await this.docker.getContainer(candidate).inspect();
      } catch (error: any) {
        if (error?.statusCode !== 404) throw error;
      }
    }
    return undefined;
  }

  private async reconcileManagementNetwork(
    networkName = MANAGEMENT_NETWORK,
    adminContainerId?: string,
  ) {
    const network = this.docker.getNetwork(networkName);
    const inspection = await network.inspect();
    if (!inspection.Internal || inspection.Driver !== "bridge")
      throw new Error("Management network is not an internal bridge");
    const selfId = (await this.orchestratorInspection())?.Id;
    if (adminContainerId) {
      // Dockerode containers obtained by name keep that name in `.id`; the
      // network membership map is keyed by the full immutable container ID.
      // Normalize either form before comparing or reconciliation would
      // disconnect the authorized admin workspace itself.
      adminContainerId = (
        await this.docker.getContainer(adminContainerId).inspect()
      ).Id;
    } else {
      try {
        adminContainerId = (
          await this.docker.getContainer(ADMIN_CONTAINER).inspect()
        ).Id;
      } catch {
        /* not provisioned yet */
      }
    }
    const allowed = new Set(
      [selfId, adminContainerId].filter((value): value is string =>
        Boolean(value),
      ),
    );
    for (const containerId of Object.keys(inspection.Containers || {})) {
      if (allowed.has(containerId)) continue;
      await network.disconnect({ Container: containerId, Force: true });
    }
  }

  private async ensureAdminAttached(
    container: Docker.Container,
    record: Readonly<AdministrativeWorkspaceRecord>,
  ) {
    const resources = this.resources(record);
    const inspection = await container.inspect();
    if (!inspection.NetworkSettings?.Networks?.[resources.managementNetwork])
      await this.docker
        .getNetwork(resources.managementNetwork)
        .connect({ Container: inspection.Id });
    if (!inspection.NetworkSettings?.Networks?.[resources.egressNetwork])
      await this.docker
        .getNetwork(resources.egressNetwork)
        .connect({ Container: inspection.Id });

    // Docker permits secondary network attachments after creation. Remove any
    // such attachment rather than relying on the create-time NetworkMode
    // alone, so the invariant also holds after daemon restarts and manual
    // operator intervention. Only the private management plane and the
    // admin-only outbound bridge are permitted.
    for (const networkName of Object.keys(
      (await container.inspect()).NetworkSettings?.Networks || {},
    )) {
      if (
        networkName === resources.managementNetwork ||
        networkName === resources.egressNetwork
      )
        continue;
      await this.docker
        .getNetwork(networkName)
        .disconnect({ Container: inspection.Id, Force: true });
    }
    await this.reconcileEgressNetwork(resources.egressNetwork, inspection.Id);
  }

  private async ensureOverlayImage(
    force = false,
    pinnedDigest?: string,
  ): Promise<AdminWorkspaceRuntimeImage> {
    if (!force && pinnedDigest && /^sha256:[0-9a-f]{64}$/.test(pinnedDigest)) {
      try {
        const pinned = await this.docker.getImage(pinnedDigest).inspect();
        if (!isTrustedOverlay(pinned))
          throw new Error(
            "Pinned administrative image failed the trusted-overlay provenance check; explicit rebuild is required",
          );
        if (
          pinned.Config?.Labels?.["agentor.admin.overlay-version"] ===
          ADMIN_OVERLAY_VERSION
        )
          return { name: this.image, digest: pinnedDigest };
        // Persistent records pin the last known-good runtime image. Older
        // overlays predate required admin-workspace integrations (including
        // management MCP discovery), so refresh disposable compute while
        // retaining the persistent workspace and agent-data volumes.
      } catch (error: any) {
        if (error?.statusCode !== 404) throw error;
        // A missing or superseded generated overlay is recoverable from the
        // approved Agentor worker base below.
      }
    }
    const base = `${this.config.workerImagePrefix}${this.config.workerImage}`;
    await useDockerService().ensureImage(base);
    const baseDigest = normalizeDigest(
      (await this.docker.getImage(base).inspect()).Id,
      base,
    );
    if (!force) {
      try {
        const existing = await this.docker.getImage(this.image).inspect();
        if (
          isTrustedOverlay(existing) &&
          existing.Config?.Labels?.["agentor.admin.base"] === baseDigest &&
          existing.Config?.Labels?.["agentor.admin.overlay-version"] ===
            ADMIN_OVERLAY_VERSION
        )
          return {
            name: this.image,
            digest: normalizeDigest(existing.Id, this.image),
          };
        // A mutable local tag is not a trust decision. Replace anything that
        // was not generated by this server-side overlay build.
      } catch (error: any) {
        if (error?.statusCode !== 404) throw error;
      }
    }
    // Dockerfile FROM does not reliably resolve a raw local image ID as a
    // build stage. Give that immutable ID a private digest-derived tag; unlike
    // the configured mutable base tag, this name cannot select different
    // content without explicit Docker-level authority.
    const baseRepo = "agentor-admin-approved-base";
    const baseVersion = baseDigest.slice(
      "sha256:".length,
      "sha256:".length + 32,
    );
    await this.docker
      .getImage(baseDigest)
      .tag({ repo: baseRepo, tag: baseVersion });
    const pinnedBase = `${baseRepo}:${baseVersion}`;
    const context = pack();
    const dockerfile = [
      `FROM ${pinnedBase}`,
      "USER root",
      "COPY admin-profile.sh /etc/profile.d/agentor-admin.sh",
      "RUN chmod 0644 /etc/profile.d/agentor-admin.sh",
      'RUN printf "ADMIN / ORCHESTRATOR\\n" > /etc/agentor-admin && chown root:root /etc/agentor-admin',
      'ENV AGENTOR_ADMIN_WORKSPACE=1 AGENTOR_ADMIN_BANNER="ADMIN / ORCHESTRATOR"',
      "USER agent",
    ].join("\n");
    const profile =
      "export AGENTOR_ADMIN_WORKSPACE=1\nexport PS1='\\[\\e[1;41;97m\\] ADMIN / ORCHESTRATOR \\u@\\h:\\w \\$ \\[\\e[0m\\]'\nprintf '\\033]0;ADMIN / ORCHESTRATOR\\007'\nif [ -t 1 ]; then printf '\\033[1;41;97m  ADMIN / ORCHESTRATOR — privileged workspace  \\033[0m\\n'; fi\n";
    context.entry({ name: "Dockerfile", mode: 0o600 }, dockerfile);
    context.entry({ name: "admin-profile.sh", mode: 0o644 }, profile);
    context.finalize();
    const output = await this.docker.buildImage(context as any, {
      t: this.image,
      rm: true,
      forcerm: true,
      labels: {
        "agentor.admin.overlay": "true",
        "agentor.admin.overlay-version": ADMIN_OVERLAY_VERSION,
        "agentor.admin.base": baseDigest,
        "agentor.admin.configured-base": base,
      },
    });
    await new Promise<void>((resolve, reject) => {
      let buildError: Error | undefined;
      this.docker.modem.followProgress(
        output,
        (error: Error | null) =>
          error || buildError ? reject(error || buildError) : resolve(),
        (event: { error?: string; errorDetail?: { message?: string } }) => {
          const message = event.errorDetail?.message || event.error;
          if (message) buildError = new Error(message);
        },
      );
    });
    const built = await this.docker.getImage(this.image).inspect();
    return { name: this.image, digest: normalizeDigest(built.Id, this.image) };
  }
}

function normalizeDigest(id: string | undefined, fallback: string): string {
  return /^sha256:[0-9a-f]{64}$/.test(id || "")
    ? id!
    : `sha256:${createHash("sha256")
        .update(id || fallback)
        .digest("hex")}`;
}

function isTrustedOverlay(inspection: Docker.ImageInspectInfo): boolean {
  const labels = inspection.Config?.Labels || {};
  return (
    labels["agentor.admin.overlay"] === "true" &&
    /^sha256:[0-9a-f]{64}$/.test(labels["agentor.admin.base"] || "")
  );
}

/** Wrap the user-authored script without interpolating its contents into shell
 * syntax. The nested memfd execution preserves the ordinary worker init-script
 * semantics, while the small status file exposes only revision/timing/exit
 * metadata. A foreground service remains `running`; a completed script leaves
 * a clean interactive shell. Neither outcome can block container readiness. */
function renderAdministrativeStartupScript(
  record: Readonly<AdministrativeWorkspaceRecord>,
) {
  const script = record.startupScript || "";
  if (!script) return "";
  const revision = normalizedRevision(record.startupScriptRevision);
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return [
    "#!/bin/bash",
    "set +e",
    `status_dir='${STARTUP_STATUS_DIR}'`,
    `status_file='${STARTUP_STATUS_PATH}'`,
    `revision=${revision}`,
    "mkdir -p \"$status_dir\"",
    "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "status_tmp=\"$status_file.$$\"",
    "printf '{\"state\":\"running\",\"revision\":%s,\"startedAt\":\"%s\"}\\n' \"$revision\" \"$started_at\" >\"$status_tmp\" && mv \"$status_tmp\" \"$status_file\"",
    `printf '%s' '${encoded}' | base64 -d | python3 /home/agent/memfd-exec.py`,
    "exit_code=$?",
    "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "if [ \"$exit_code\" -eq 0 ]; then final_state=succeeded; else final_state=failed; fi",
    "printf '{\"state\":\"%s\",\"revision\":%s,\"startedAt\":\"%s\",\"finishedAt\":\"%s\",\"exitCode\":%s}\\n' \"$final_state\" \"$revision\" \"$started_at\" \"$finished_at\" \"$exit_code\" >\"$status_tmp\" && mv \"$status_tmp\" \"$status_file\"",
    "if [ \"$exit_code\" -ne 0 ]; then printf '[admin startup] script exited with status %s\\n' \"$exit_code\" >&2; fi",
    "exec bash",
  ].join("\n");
}
