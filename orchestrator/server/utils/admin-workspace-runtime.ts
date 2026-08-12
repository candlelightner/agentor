import Docker from "dockerode";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { pack } from "tar-stream";
import type { Config } from "./config";
import type { ContainerInfo } from "../../shared/types";
import { useContainerManager, useDockerService } from "./services";
import { useImageCatalogManager } from "./image-catalog";
import type {
  AdministrativeWorkspaceRecord,
  AdminWorkspaceRuntimeAdapter,
  AdminWorkspaceRuntimeImage,
} from "./admin-workspace-store";

const MANAGEMENT_NETWORK = "agentor-management";
// Bump this whenever the trusted overlay/base contract changes in a way that
// must be materialized for existing persistent administrative workspaces.
// The workspace volume remains untouched; only its disposable compute image
// is refreshed.
const ADMIN_OVERLAY_VERSION = "2";
const ADMIN_CONTAINER = "agentor-admin-workspace";
const ADMIN_WORKSPACE_VOLUME = "agentor-admin-workspace-data";
const ADMIN_AGENTS_VOLUME = "agentor-admin-agent-data";
const ADMIN_LABEL = "agentor.administrative";

/** Docker boundary for the singleton administrative workspace. Every Docker
 * input is generated here; requests cannot choose images, mounts, commands,
 * networks, or capabilities. No account credentials or Docker socket enter
 * this container. */
export class DockerAdminWorkspaceRuntime implements AdminWorkspaceRuntimeAdapter {
  private readonly docker = new Docker({ socketPath: "/var/run/docker.sock" });
  private readonly image: string;
  constructor(private readonly config: Config) {
    this.image =
      process.env.AGENTOR_ADMIN_WORKER_IMAGE || "agentor-admin-worker:latest";
  }

  async initializeBoundary(): Promise<void> {
    await this.ensureManagementNetwork();
    await this.attachOrchestrator();
    await this.reconcileManagementNetwork();
  }

  async managementAddress(): Promise<string> {
    try {
      const inspection = await this.docker
        .getContainer(process.env.HOSTNAME || hostname())
        .inspect();
      return (
        inspection.NetworkSettings?.Networks?.[MANAGEMENT_NETWORK]?.IPAddress ||
        "127.0.0.1"
      );
    } catch {
      return "127.0.0.1";
    }
  }

  async materializeCredential(credential: string): Promise<void> {
    const container = this.docker.getContainer(ADMIN_CONTAINER);
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

  async ensure(
    record: Readonly<AdministrativeWorkspaceRecord>,
  ): Promise<AdminWorkspaceRuntimeImage> {
    await this.initializeBoundary();
    const image = await this.ensureOverlayImage(false, record.imageDigest);
    let container = this.docker.getContainer(ADMIN_CONTAINER);
    try {
      const inspection = await container.inspect();
      if (
        inspection.Config?.Labels?.[ADMIN_LABEL] !== "true" ||
        inspection.Image !== image.digest ||
        // NetworkMode is immutable. Recreate legacy administrative containers
        // whose primary network was the ordinary worker network rather than
        // silently retaining that privilege boundary violation on restart.
        inspection.HostConfig?.NetworkMode !== MANAGEMENT_NETWORK
      ) {
        await container.remove({ force: true });
        container = await this.create(record, image.digest);
      }
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
      container = await this.create(record, image.digest);
    }
    const status = await container.inspect();
    if (record.status === "running" && !status.State.Running)
      await container.start();
    if (record.status === "stopped" && status.State.Running)
      await container.stop({ t: 15 });
    if (record.status === "running") await this.waitForReady(container);
    await this.ensureAdminAttached(container);
    if (record.status === "running")
      await this.syncControlRepresentation(container);
    await this.registerServices(record, container);
    await this.reconcileManagementNetwork(container.id);
    return image;
  }

  async start(record: Readonly<AdministrativeWorkspaceRecord>): Promise<void> {
    await this.ensure(record);
    const container = this.docker.getContainer(ADMIN_CONTAINER);
    if (!(await container.inspect()).State.Running) await container.start();
    await this.waitForReady(container);
    await this.ensureAdminAttached(container);
    await this.syncControlRepresentation(container);
    await this.registerServices(record, container);
  }

  async stop(_record: Readonly<AdministrativeWorkspaceRecord>): Promise<void> {
    try {
      const container = this.docker.getContainer(ADMIN_CONTAINER);
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
    try {
      await this.docker.getContainer(ADMIN_CONTAINER).remove({ force: true });
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
    }
    const image = await this.ensureOverlayImage(true);
    const container = await this.create(record, image.digest);
    await container.start();
    await this.waitForReady(container);
    await this.ensureAdminAttached(container);
    await this.syncControlRepresentation(container);
    await this.registerServices(record, container);
    await this.reconcileManagementNetwork(container.id);
    return image;
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
    if (!workerId || workerId === adminId) {
      try {
        const stream = await this.docker
          .getContainer(ADMIN_CONTAINER)
          .getArchive({
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
      managementNetworkAttached: Boolean(
        inspection.NetworkSettings?.Networks?.[MANAGEMENT_NETWORK],
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
    const admin = members.find((member) => member.name === ADMIN_CONTAINER);
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
      attachedWorkspaceIds: admin ? [await this.adminId()].filter(Boolean) : [],
      normalWorkerIds: [],
      members,
      orchestratorAttached: Boolean(orchestrator),
      unexpectedMembers: members.filter(
        (member) => member !== admin && member !== orchestrator,
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

  private async create(
    record: Readonly<AdministrativeWorkspaceRecord>,
    imageDigest: string,
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
    const worker = {
      id: record.id,
      displayName: "ADMIN / ORCHESTRATOR",
      repos: [],
      initScript: "",
      gitName: "Agentor Administrator",
      gitEmail: "admin@agentor.internal",
    };
    const container = await this.docker.createContainer({
      Image: imageDigest,
      name: ADMIN_CONTAINER,
      Env: [
        `ENVIRONMENT=${JSON.stringify(environment)}`,
        "CAPABILITIES=[]",
        "INSTRUCTIONS=[]",
        `WORKER=${JSON.stringify(worker)}`,
        "AGENTOR_ADMIN_WORKSPACE=1",
        "AGENTOR_ADMIN_BANNER=ADMIN / ORCHESTRATOR",
        "AGENTOR_MANAGEMENT_MCP_URL=http://agentor-orchestrator:3099/mcp",
        "ORCHESTRATOR_URL=http://agentor-orchestrator:3000",
        `WORKER_CONTAINER_NAME=${ADMIN_CONTAINER}`,
      ],
      Tty: true,
      OpenStdin: true,
      Labels: {
        [ADMIN_LABEL]: "true",
        "agentor.admin.workspace-id": record.id,
        "agentor.managed": "false",
      },
      HostConfig: {
        // Make the restricted network part of the immutable container
        // configuration. A secondary network attachment made before first
        // start can be discarded by some Docker daemons (notably nested
        // dockerd); using it as the primary network keeps the boundary stable.
        NetworkMode: MANAGEMENT_NETWORK,
        Binds: [
          `${ADMIN_WORKSPACE_VOLUME}:/workspace`,
          `${ADMIN_AGENTS_VOLUME}:/home/agent/.agent-data`,
        ],
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
    await this.reconcileManagementNetwork(container.id);
    return container;
  }

  private async registerServices(
    record: Readonly<AdministrativeWorkspaceRecord>,
    container: Docker.Container,
  ) {
    const inspection = await container.inspect();
    const info: ContainerInfo = {
      id: record.id,
      userId: "__agentor_admin__",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      containerId: inspection.Id,
      containerName: ADMIN_CONTAINER,
      displayName: "ADMIN / ORCHESTRATOR",
      imageName: this.image,
      imageId: inspection.Image,
      imageDigest: inspection.Image,
      imageRuntimeReference: inspection.Image,
      status: inspection.State.Running ? "running" : "stopped",
    };
    useContainerManager().registerExternal(info);
  }

  private async syncControlRepresentation(container: Docker.Container) {
    const catalog = useImageCatalogManager();
    await catalog.init();
    const definitions = catalog
      .list("__agentor_admin__", true)
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
      "# ADMIN / ORCHESTRATOR\n\nThis directory is an orchestrator-generated, read-only-in-intent representation of image definitions and runtime topology. Use the management MCP proposal/approval workflow for changes. It never contains account credentials or worker secret values.\n",
    );
    archive.entry(
      { name: "agentor-control/image-definitions.json", mode: 0o444 },
      `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), definitions }, null, 2)}\n`,
    );
    archive.entry(
      { name: "agentor-control/runtime.json", mode: 0o444 },
      `${JSON.stringify({ schemaVersion: 1, managementNetwork: MANAGEMENT_NETWORK, workerNetwork: this.config.dockerNetwork, adminImage: this.image }, null, 2)}\n`,
    );
    archive.finalize();
    await container.putArchive(archive as any, { path: "/workspace" });
  }

  private async ensureManagementNetwork() {
    const existing = await this.docker.listNetworks({
      filters: { name: [MANAGEMENT_NETWORK] },
    });
    const network = existing.find(
      (candidate) => candidate.Name === MANAGEMENT_NETWORK,
    );
    if (!network)
      await this.docker.createNetwork({
        Name: MANAGEMENT_NETWORK,
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

  private async attachOrchestrator() {
    const self = this.docker.getContainer(process.env.HOSTNAME || hostname());
    try {
      const inspection = await self.inspect();
      if (!inspection.NetworkSettings?.Networks?.[MANAGEMENT_NETWORK])
        await this.docker
          .getNetwork(MANAGEMENT_NETWORK)
          .connect({ Container: inspection.Id });
    } catch {
      /* direct-host development has no orchestrator container */
    }
  }

  private async reconcileManagementNetwork(adminContainerId?: string) {
    const network = this.docker.getNetwork(MANAGEMENT_NETWORK);
    const inspection = await network.inspect();
    if (!inspection.Internal || inspection.Driver !== "bridge")
      throw new Error("Management network is not an internal bridge");
    let selfId: string | undefined;
    try {
      selfId = (
        await this.docker
          .getContainer(process.env.HOSTNAME || hostname())
          .inspect()
      ).Id;
    } catch {
      /* direct-host development */
    }
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

  private async ensureAdminAttached(container: Docker.Container) {
    const inspection = await container.inspect();
    if (!inspection.NetworkSettings?.Networks?.[MANAGEMENT_NETWORK])
      await this.docker
        .getNetwork(MANAGEMENT_NETWORK)
        .connect({ Container: inspection.Id });

    // Docker permits secondary network attachments after creation. Remove any
    // such attachment rather than relying on the create-time NetworkMode
    // alone, so the invariant also holds after daemon restarts and manual
    // operator intervention. MANAGEMENT_NETWORK is the only permitted
    // endpoint for this container.
    for (const networkName of Object.keys(
      (await container.inspect()).NetworkSettings?.Networks || {},
    )) {
      if (networkName === MANAGEMENT_NETWORK) continue;
      await this.docker
        .getNetwork(networkName)
        .disconnect({ Container: inspection.Id, Force: true });
    }
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
