import { useImageCatalogManager } from "./image-catalog";
import { useBackupManager } from "./backup-manager";
import { useInstanceBackupManager } from "./instance-backup-manager";
import { useGitImageCatalogManager } from "./git-image-manager";
import { useContainerManager, usePluginDefinitionStore } from "./services";
import { useGroupAdminWorkspaceStore } from "./group-admin-workspace-store";
import type { BackupProviderKind } from "./backup-types";

export interface ImageBackupTool {
  name: string;
  group: "images" | "backups";
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
}
const ro = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const mut = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Transport-free MCP adapter for image catalog and backup services. All calls
 * go through existing managers; secrets/tokens are never returned. */
export class ManagementImageBackupDomain {
  tools(): ImageBackupTool[] {
    return [
      [
        "images.list",
        "images",
        "List an owner's definitions. MCP structured responses use { items: [...] }.",
        ro,
      ],
      ["images.get", "images", "Get a definition", ro],
      [
        "images.create",
        "images",
        "Create a validated, secret-free image definition with server-rendered provisioning.",
        mut,
      ],
      [
        "images.update",
        "images",
        "Replace a validated definition while retaining built versions.",
        mut,
      ],
      [
        "images.validate",
        "images",
        "Validate structured provisioning, context roles/destinations, and legacy compatibility without writing.",
        ro,
      ],
      [
        "images.delete",
        "images",
        "Delete an unused definition",
        { ...mut, destructiveHint: true },
      ],
      [
        "images.delete-version",
        "images",
        "Delete an unused built version",
        { ...mut, destructiveHint: true },
      ],
      ["images.usage", "images", "Read catalog artifact storage usage", ro],
      [
        "images.test-worker",
        "images",
        "Persist and start an asynchronous ordinary smoke-test worker job from a built version. The accepted result names the shared image-build status, logs, and cancellation tools.",
        mut,
      ],
      [
        "images.build",
        "images",
        "Persist and start an asynchronous controlled approved-base build. It returns promptly with a durable build id and machine-readable status/log/cancel next actions; it never waits for Docker, BuildKit, or compatibility validation.",
        mut,
      ],
      [
        "images.build-status",
        "images",
        "Read persisted build, test-worker, and compatibility-validation state; safe to poll.",
        ro,
      ],
      [
        "images.build-logs",
        "images",
        "Read a bounded incremental slice of sanitized build, test-worker, or validation logs.",
        ro,
      ],
      [
        "images.build-cancel",
        "images",
        "Request cancellation of a build, test-worker startup, or validation phase.",
        { ...mut, destructiveHint: true },
      ],
      [
        "images.validation-retry",
        "images",
        "Persist and start asynchronous compatibility-validation retry for an existing built artifact. The accepted result names its status, logs, and cancellation tools.",
        mut,
      ],
      ["images.promote", "images", "Promote a compatible version", mut],
      ["images.rollback", "images", "Roll back promoted version", mut],
      [
        "images.default",
        "images",
        "Set owner/system default to a compatible version",
        mut,
      ],
      [
        "images.cleanup",
        "images",
        "Remove unused artifacts",
        { ...mut, destructiveHint: true },
      ],
      ["images.git-status", "images", "Read safe Git catalog status", ro],
      ["images.git-sync", "images", "Synchronize configured Git catalog", mut],
      [
        "backups.list",
        "backups",
        "List sanitized local backups/jobs/settings",
        ro,
      ],
      [
        "backups.providers",
        "backups",
        "List provider status without tokens",
        ro,
      ],
      [
        "backups.discovery.start",
        "backups",
        "Persist and start an asynchronous owner-scoped provider scan. Returns a durable job and the status/log/cancel tools to call next.",
        mut,
      ],
      [
        "backups.discovery.list",
        "backups",
        "List owner-scoped remotely discovered backup records and safe recovery-key availability state.",
        ro,
      ],
      [
        "backups.inspect",
        "backups",
        "Inspect one owner-scoped remotely discovered backup, including safe metadata and whether it is restorable.",
        ro,
      ],
      [
        "backups.adopt",
        "backups",
        "Persist and start asynchronous download, authentication, integrity verification, and adoption of a discovered backup. Returns a durable job and next actions.",
        mut,
      ],
      [
        "backups.image-recovery.start",
        "backups",
        "Persist and start asynchronous image dependency recovery for one backup workspace. When a build id is available, status names exact image build status/log/cancel follow-ups.",
        mut,
      ],
      [
        "backups.key-status",
        "backups",
        "Report recovery-key fingerprints and safe availability only; never returns raw key material.",
        ro,
      ],
      [
        "backups.recovery-material.import",
        "backups",
        "Securely import user-supplied portable recovery material. The value is write-only and is never returned, logged, or audited.",
        mut,
      ],
      [
        "backups.paths.list",
        "backups",
        "List readable file and directory metadata inside one authorized running worker. Starts at /workspace when path is omitted and permits navigation up to /. No file content is returned.",
        ro,
      ],
      [
        "backups.settings",
        "backups",
        "Read or replace safe backup settings, including optional absolute paths per worker. Saving first copies additional directories from the running workspace into managed local volumes, which are attached on later rebuilds. Individual files and / remain backup-only. Omission preserves the legacy /workspace plus filtered agent-data payload; explicit sensitive/authentication paths are allowed and are not treated as secret values.",
        mut,
      ],
      [
        "backups.create",
        "backups",
        "Start a backup for authorized workers. selectedPathsByWorkspace optionally selects absolute readable files/directories per worker; omission preserves legacy defaults.",
        mut,
      ],
      ["backups.status", "backups", "Read persisted job status", ro],
      [
        "backups.logs",
        "backups",
        "Read a bounded incremental page of sanitized persisted backup job logs.",
        ro,
      ],
      [
        "backups.cancel",
        "backups",
        "Cancel job",
        { ...mut, destructiveHint: true },
      ],
      ["backups.retry", "backups", "Retry failed job", mut],
      [
        "backups.delete",
        "backups",
        "Delete backup artifact",
        { ...mut, destructiveHint: true },
      ],
      [
        "backups.restore",
        "backups",
        "Restore all workspaces in an existing backup, or an exact non-empty workspaceIds subset, as new workers. Explicit selected paths are restored to their original absolute locations. Original-worker restore rejects such artifacts with a prompt 409. Returns a durable job and next actions.",
        mut,
      ],
      [
        "instance-backups.list",
        "backups",
        "List whole-instance disaster-recovery jobs, verified artifacts, and remotely discovered instance backups. ownerId must identify a platform administrator. Raw recovery keys and provider credentials are never returned.",
        ro,
      ],
      [
        "instance-backups.create",
        "backups",
        "Persist and start an asynchronous encrypted whole-instance backup in a platform-administrator recovery namespace. All workspaces must be stopped. The result names the exact status, logs, and cancellation tools.",
        mut,
      ],
      [
        "instance-backups.discovery.start",
        "backups",
        "Persist and start an asynchronous scan for instance DR objects using the selected connected provider, including Google Drive.",
        mut,
      ],
      [
        "instance-backups.discovery.list",
        "backups",
        "List remotely discovered whole-instance backup objects and safe key-availability state.",
        ro,
      ],
      [
        "instance-backups.inspect",
        "backups",
        "Inspect safe authenticated or discovery metadata for one whole-instance backup.",
        ro,
      ],
      [
        "instance-backups.preflight",
        "backups",
        "Inspect whole-instance restore blockers, volume conflicts, and external dependencies without changing the installation.",
        ro,
      ],
      [
        "instance-backups.adopt",
        "backups",
        "Start asynchronous download, decryption, nested-archive validation, and local adoption of a discovered instance backup.",
        mut,
      ],
      [
        "instance-backups.restore",
        "backups",
        "Persist and start a staged whole-instance restore after explicit control-plane replacement and external-dependency confirmations. The result names the exact status, logs, and cancellation tools.",
        { ...mut, destructiveHint: true },
      ],
      [
        "instance-backups.status",
        "backups",
        "Poll persisted whole-instance backup job state idempotently.",
        ro,
      ],
      [
        "instance-backups.logs",
        "backups",
        "Read a bounded incremental page of sanitized whole-instance backup logs.",
        ro,
      ],
      [
        "instance-backups.cancel",
        "backups",
        "Cancel a queued or active whole-instance backup operation.",
        { ...mut, destructiveHint: true },
      ],
    ].map(([name, group, description, annotations]) => ({
      name: name as string,
      group: group as "images" | "backups",
      description: description as string,
      inputSchema: enrichBackupRecoverySchema(
        name as string,
        enrichImageProvisioningSchema(
          name as string,
          catalogSchema(name as string),
        ),
      ),
      annotations: annotations as any,
    }));
  }
  async execute(name: string, args: Record<string, unknown>) {
    if (!this.tools().some((t) => t.name === name)) return { handled: false };
    if (name === "images.update") {
      const catalog = useImageCatalogManager();
      await catalog.init();
      return {
        handled: true,
        result: await catalog.update(
          required(args.definitionId, "definitionId"),
          required(args.ownerId, "ownerId"),
          true,
          args.definition,
        ),
      };
    }
    if (name.startsWith("images."))
      return { handled: true, result: await this.images(name, args) };
    if (name.startsWith("instance-backups."))
      return { handled: true, result: await this.instanceBackups(name, args) };
    return { handled: true, result: await this.backups(name, args) };
  }
  private async images(name: string, a: Record<string, unknown>): Promise<any> {
    const catalog = useImageCatalogManager();
    await catalog.init();
    const owner = required(a.ownerId, "ownerId"),
      id = string(a.definitionId),
      buildId = string(a.buildId);
    if (name === "images.list") return catalog.list(owner, true);
    if (name === "images.create") return catalog.create(owner, a.definition);
    if (name === "images.validate") return catalog.validate(a.definition);
    if (name === "images.get")
      return catalog.definition(required(id, "definitionId"), owner, true);
    if (name === "images.delete") {
      await catalog.removeDefinition(required(id, "definitionId"), owner, true);
      return { deleted: true };
    }
    if (name === "images.delete-version") {
      await catalog.deleteVersion(
        required(id, "definitionId"),
        required(a.version, "version"),
        owner,
        true,
      );
      return { deleted: true };
    }
    if (name === "images.usage") return catalog.usage(owner, true);
    // Image test workers are durable jobs, not a long-running MCP request.
    if (name === "images.test-worker")
      return accepted(
        await catalogAsync(catalog, "startTestWorker")(
          required(id, "definitionId"),
          required(a.version, "version"),
          owner,
          true,
          {
            displayName: string(a.displayName),
            requestId: string(a.requestId),
          },
        ),
      );
    if (name === "images.build")
      return accepted(
        await catalog.startBuild(required(id, "definitionId"), owner, true, {
          builder: a.builder === "fake" ? "fake" : "controlled",
          baseImage: a.baseImage,
          requestId: string(a.requestId),
        }),
      );
    if (name === "images.build-status")
      return ownerImageStatus(
        catalog.publicBuild(required(buildId, "buildId"), owner, true),
      );
    if (name === "images.build-logs")
      return imageLogs(
        catalog,
        required(buildId, "buildId"),
        owner,
        number(a.after, 0),
        limit(a.limit),
      );
    if (name === "images.build-cancel")
      return catalog.cancelBuild(required(buildId, "buildId"), owner, true);
    if (name === "images.validation-retry")
      return accepted(
        await catalogAsync(catalog, "startValidation")(
          required(id, "definitionId"),
          required(a.version, "version"),
          owner,
          true,
          { requestId: string(a.requestId) },
        ),
      );
    if (name === "images.promote")
      return catalog.promote(
        required(id, "definitionId"),
        required(a.version, "version"),
        owner,
        true,
      );
    if (name === "images.rollback")
      return catalog.rollback(
        required(id, "definitionId"),
        required(a.version, "version"),
        owner,
        true,
      );
    if (name === "images.default")
      return a.system === true
        ? catalog.setSystemDefault(
            required(id, "definitionId"),
            required(a.version, "version"),
            owner,
          )
        : catalog.setUserDefault(
            owner,
            required(id, "definitionId"),
            required(a.version, "version"),
          );
    if (name === "images.cleanup") return catalog.cleanup(owner, true, a);
    const git = useGitImageCatalogManager();
    if (name === "images.git-status")
      return sanitize({
        connection: git.connection(owner),
        recovery: git.recovery(owner),
      });
    if (name === "images.git-sync")
      return sanitize(
        await git.sync(owner, catalog, a, usePluginDefinitionStore()),
      );
    throw fail(400, "Unknown image tool");
  }
  private async backups(
    name: string,
    a: Record<string, unknown>,
  ): Promise<any> {
    const manager = useBackupManager();
    await manager.init();
    const owner = required(a.ownerId, "ownerId");
    if (name === "backups.list") return sanitize(await manager.list(owner));
    if (name === "backups.providers")
      return sanitize(manager.providersStatus(owner));
    if (name === "backups.key-status")
      return sanitize(await manager.recoveryKeyStatus(owner));
    if (name === "backups.recovery-material.import")
      return sanitize(
        await manager.importRecoveryKit(
          owner,
          required(a.recoveryMaterial, "recoveryMaterial"),
        ),
      );
    if (name === "backups.discovery.list")
      return sanitize(await manager.listRemoteBackups(owner));
    if (name === "backups.inspect") {
      const remote = await manager.getRemoteBackup(
        required(a.remoteBackupId, "remoteBackupId"),
      );
      if (!remote || remote.userId !== owner)
        throw fail(404, "Remote backup not found");
      return sanitize(remote);
    }
    if (name === "backups.discovery.start")
      return backupAccepted(
        await manager.createDiscovery(
          owner,
          backupProvider(a.providerId),
          string(a.requestId),
        ),
        owner,
      );
    if (name === "backups.adopt")
      return backupAccepted(
        await manager.createAdoption(
          owner,
          required(a.remoteBackupId, "remoteBackupId"),
          string(a.requestId),
        ),
        owner,
      );
    if (name === "backups.image-recovery.start") {
      const artifact = await manager.getArtifact(
        required(a.artifactId, "artifactId"),
      );
      if (!artifact || artifact.userId !== owner)
        throw fail(404, "Backup artifact not found");
      return backupAccepted(
        await manager.createImageRecovery(
          owner,
          artifact.id,
          required(a.workspaceId, "workspaceId"),
          string(a.requestId),
          a.startBuild !== false,
        ),
        owner,
      );
    }
    if (name === "backups.paths.list") {
      const worker = await resolveBackupWorkspace(
        required(a.workerId, "workerId"),
        owner,
      );
      return useContainerManager().listBackupPaths(
        worker.id,
        string(a.path) || "/workspace",
      );
    }
    if (name === "backups.settings") {
      if (a.settings !== undefined)
        return sanitize(await manager.setConfig(owner, a.settings as any));
      return sanitize(await manager.getConfig(owner));
    }
    if (name === "backups.create") {
      const workspaceIds = strings(a.workspaceIds, "workspaceIds");
      for (const id of workspaceIds) await resolveBackupWorkspace(id, owner);
      return backupAccepted(
        await manager.createMany(
          owner,
          workspaceIds,
          undefined,
          1,
          0,
          pathSelections(a.selectedPathsByWorkspace),
          string(a.requestId),
        ),
        owner,
      );
    }
    if (name === "backups.restore" || name === "backups.delete") {
      const artifact = await manager.getArtifact(
        required(a.artifactId, "artifactId"),
      );
      if (!artifact || artifact.userId !== owner)
        throw fail(404, "Backup artifact not found");
      if (name === "backups.restore")
        return backupAccepted(
          await createRecoveryRestore(
            manager,
            owner,
            artifact,
            string(a.displayName),
            optionalUniqueStrings(a.workspaceIds, "workspaceIds"),
            imageResolutions(a.imageResolutions),
            string(a.requestId),
          ),
          owner,
        );
      await manager.deleteArtifact(artifact);
      return { deleted: true };
    }
    const job = await manager.getJob(required(a.jobId, "jobId"));
    if (!job || job.userId !== owner) throw fail(404, "Backup job not found");
    if (name === "backups.status") return backupStatus(job, owner);
    if (name === "backups.logs")
      return sanitize(
        await manager.getJobLogs(job.id, number(a.after, 0), limit(a.limit)),
      );
    if (name === "backups.cancel") return sanitize(await manager.cancel(job));
    if (name === "backups.retry")
      return backupAccepted(await manager.retry(job), owner);
    throw fail(400, "Unknown backup tool");
  }

  private async instanceBackups(
    name: string,
    a: Record<string, unknown>,
  ): Promise<any> {
    const manager = useInstanceBackupManager();
    await manager.init();
    const owner = required(a.ownerId, "ownerId");
    if (name === "instance-backups.list")
      return sanitize(await manager.list(owner));
    if (name === "instance-backups.discovery.list")
      return sanitize((await manager.list(owner)).remoteBackups);
    if (name === "instance-backups.inspect") {
      if (typeof a.remoteBackupId === "string" && a.remoteBackupId) {
        const remote = await manager.getRemote(a.remoteBackupId);
        if (!remote || remote.userId !== owner)
          throw fail(404, "Remote instance backup not found");
        return sanitize(remote);
      }
      const artifact = await manager.getArtifact(
        required(a.artifactId, "artifactId"),
      );
      if (!artifact || artifact.userId !== owner)
        throw fail(404, "Instance backup artifact not found");
      return sanitize(artifact);
    }
    if (name === "instance-backups.preflight")
      return sanitize(
        await manager.restorePreflight(
          owner,
          required(a.artifactId, "artifactId"),
          instanceRestoreOptions(a.options),
        ),
      );
    if (name === "instance-backups.create")
      return instanceBackupAccepted(
        await manager.create(
          owner,
          backupProvider(a.providerId),
          instanceBackupOptions(a.options),
          string(a.requestId),
        ),
        owner,
      );
    if (name === "instance-backups.discovery.start")
      return instanceBackupAccepted(
        await manager.discover(
          owner,
          backupProvider(a.providerId) ?? "google-drive",
          string(a.requestId),
        ),
        owner,
      );
    if (name === "instance-backups.adopt")
      return instanceBackupAccepted(
        await manager.adopt(
          owner,
          required(a.remoteBackupId, "remoteBackupId"),
          string(a.requestId),
        ),
        owner,
      );
    if (name === "instance-backups.restore")
      return instanceBackupAccepted(
        await manager.restore(
          owner,
          required(a.artifactId, "artifactId"),
          instanceRestoreOptions(a.options),
          string(a.requestId),
        ),
        owner,
      );
    const job = await manager.getJob(required(a.jobId, "jobId"));
    if (!job || job.userId !== owner)
      throw fail(404, "Instance backup job not found");
    if (name === "instance-backups.status")
      return instanceBackupStatus(job, owner);
    if (name === "instance-backups.logs")
      return sanitize(
        await manager.logs(job.id, number(a.after, 0), limit(a.limit)),
      );
    if (name === "instance-backups.cancel")
      return sanitize(await manager.cancel(job.id));
    throw fail(400, "Unknown instance backup tool");
  }
}
function backupProvider(value: unknown): BackupProviderKind | undefined {
  if (value === undefined) return undefined;
  if (value === "local" || value === "fake" || value === "google-drive")
    return value;
  throw fail(400, "providerId is invalid");
}
async function resolveBackupWorkspace(id: string, owner: string) {
  const containers = useContainerManager();
  let worker = containers.get(id);
  if (worker?.userId === owner) return worker;
  // Administrative workspaces are external ContainerManager registrations and
  // may briefly be absent after an orchestrator refresh. Reconcile only the
  // exact persisted group-admin identity; never broaden this to owner-wide
  // worker discovery.
  const record = useGroupAdminWorkspaceStore().findByWorkspaceId(id);
  if (record?.ownerId === owner) {
    await useGroupAdminWorkspaceStore().ensure(record.groupId);
    worker = containers.get(id);
    if (worker?.userId === owner && worker.administrativeKind === "group")
      return worker;
  }
  throw fail(404, "Resource not found");
}
function required(v: unknown, n: string) {
  if (typeof v !== "string" || !v) throw fail(400, `${n} is required`);
  return v;
}
function string(v: unknown) {
  return typeof v === "string" && v ? v : undefined;
}
function number(v: unknown, d: number) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : d;
}
function limit(v: unknown) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0
    ? Math.min(v, 1000)
    : 200;
}
function strings(v: unknown, n: string) {
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string"))
    throw fail(400, `${n} is required`);
  return [...new Set(v as string[])];
}
function optionalUniqueStrings(v: unknown, n: string) {
  if (v === undefined) return undefined;
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.some((x) => typeof x !== "string" || !x)
  )
    throw fail(400, `${n} must be a non-empty array of strings`);
  if (new Set(v).size !== v.length)
    throw fail(400, `${n} must not contain duplicates`);
  return v as string[];
}
function pathSelections(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(400, "selectedPathsByWorkspace must be an object");
  return value as Record<string, string[]>;
}
function imageResolutions(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(400, "imageResolutions must be an object");
  for (const [workspaceId, resolution] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      !workspaceId ||
      !resolution ||
      typeof resolution !== "object" ||
      Array.isArray(resolution)
    )
      throw fail(
        400,
        "imageResolutions must contain valid workspace resolutions",
      );
    const candidate = resolution as Record<string, unknown>;
    if (candidate.mode === "exact" && Object.keys(candidate).length === 1)
      continue;
    if (
      candidate.mode === "workspace-only" &&
      candidate.acknowledged === true &&
      Object.keys(candidate).length === 2
    )
      continue;
    if (
      candidate.mode === "replacement" &&
      typeof candidate.imageDefinitionId === "string" &&
      candidate.imageDefinitionId &&
      typeof candidate.imageVersion === "string" &&
      candidate.imageVersion &&
      Object.keys(candidate).length === 3
    )
      continue;
    throw fail(400, "imageResolutions contains an invalid resolution");
  }
  return value as any;
}
function instanceBackupOptions(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(400, "options must be an object");
  return value as any;
}
function instanceRestoreOptions(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(400, "options must be an object");
  return value as any;
}
function fail(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/** Keep the MCP boundary additive while older manager instances can still be
 * loaded during a rolling orchestrator update. The core implementation owns
 * the durable job state; this adapter never emulates it with an in-request
 * fallback. */
function catalogAsync(
  catalog: unknown,
  method: string,
): (...args: any[]) => Promise<any> {
  const candidate = (catalog as Record<string, unknown>)[method];
  if (typeof candidate !== "function")
    throw fail(501, `Image catalog does not support ${method} on this server`);
  return candidate.bind(catalog) as (...args: any[]) => Promise<any>;
}
/** The restore manager gained dependency choices additively.  Calling it
 * through this narrow structural signature keeps an in-flight rolling update
 * compatible with the earlier six-argument manager (extra JS arguments are
 * ignored there) while allowing the durable manager to persist choices and a
 * request identity as soon as it supports them. */
function createRecoveryRestore(
  manager: unknown,
  ownerId: string,
  artifact: unknown,
  displayName: string | undefined,
  workspaceIds: string[] | undefined,
  resolutions: unknown,
  requestId: string | undefined,
) {
  const createRestore = (manager as { createRestore?: unknown }).createRestore;
  if (typeof createRestore !== "function")
    throw fail(501, "Backup restore is not supported on this server");
  return (createRestore as (...args: any[]) => Promise<any>).call(
    manager,
    ownerId,
    artifact,
    "new",
    displayName,
    undefined,
    workspaceIds,
    requestId,
    resolutions,
  );
}
function imageLogs(
  catalog: unknown,
  buildId: string,
  ownerId: string,
  after: number,
  pageSize: number,
) {
  const manager = catalog as {
    logs: (...args: any[]) => unknown;
    logPage?: (...args: any[]) => unknown;
  };
  // New managers return cursor-aware pages. Keeping the old call as a
  // fallback preserves existing log history during an additive upgrade.
  if (typeof manager.logPage === "function")
    return manager.logPage(buildId, ownerId, true, { after, limit: pageSize });
  return {
    logs: manager.logs(buildId, ownerId, true, after),
    after,
    limit: pageSize,
  };
}
function accepted(result: any) {
  const jobId = typeof result?.id === "string" ? result.id : result?.jobId;
  if (typeof jobId !== "string" || !jobId) return result;
  // A durable build id identifies its owner server-side. Do not make an agent
  // copy an owner selector through the status/log/cancel chain.
  const jobArguments = { buildId: jobId };
  const active = result?.status === "queued" || result?.status === "running";
  return {
    ...result,
    accepted: true,
    jobId,
    message:
      result?.message ||
      (result?.operation === "validation"
        ? "Validation started"
        : result?.operation === "test-worker"
          ? "Test-worker creation started"
          : "Build started"),
    nextActions: {
      status: { tool: "images.build-status", arguments: jobArguments },
      logs: { tool: "images.build-logs", arguments: jobArguments },
      ...(active
        ? {
            cancel: {
              tool: "images.build-cancel",
              arguments: jobArguments,
            },
          }
        : {}),
    },
  };
}
function ownerImageStatus(result: any) {
  const jobId = typeof result?.id === "string" ? result.id : result?.jobId;
  if (!jobId) return result;
  const arguments_ = { buildId: jobId };
  const active = result.status === "queued" || result.status === "running";
  return {
    ...result,
    nextActions: {
      status: { tool: "images.build-status", arguments: arguments_ },
      logs: { tool: "images.build-logs", arguments: arguments_ },
      ...(active
        ? { cancel: { tool: "images.build-cancel", arguments: arguments_ } }
        : {}),
      ...((result.outcome === "validation-unavailable" ||
        result.outcome === "built-incompatible") &&
      result.definitionId &&
      result.version
        ? {
            retryValidation: {
              tool: "images.validation-retry",
              arguments: {
                definitionId: result.definitionId,
                version: result.version,
              },
            },
          }
        : {}),
    },
  };
}
function backupAccepted(result: any, ownerId: string) {
  const jobId = typeof result?.id === "string" ? result.id : result?.jobId;
  if (!jobId) return sanitize(result);
  const arguments_ = { ownerId, jobId };
  const active = result?.status === "queued" || result?.status === "running";
  const message =
    result?.message ||
    (
      {
        discovery: "Provider discovery started",
        adoption: "Backup adoption started",
        restore: "Restore started",
        backup: "Backup started",
      } as Record<string, string>
    )[String(result?.operation)] ||
    "Backup operation started";
  return sanitize({
    ...result,
    accepted: true,
    jobId,
    message,
    nextActions: {
      status: { tool: "backups.status", arguments: arguments_ },
      logs: { tool: "backups.logs", arguments: arguments_ },
      ...(active
        ? { cancel: { tool: "backups.cancel", arguments: arguments_ } }
        : {}),
      ...imageRecoveryBuildActions(result),
    },
  });
}
function backupStatus(job: any, ownerId: string) {
  const jobId = typeof job?.id === "string" ? job.id : undefined;
  if (!jobId) return sanitize(job);
  const arguments_ = { ownerId, jobId };
  const active = job.status === "queued" || job.status === "running";
  return sanitize({
    ...job,
    nextActions: {
      status: { tool: "backups.status", arguments: arguments_ },
      logs: { tool: "backups.logs", arguments: arguments_ },
      ...(active
        ? { cancel: { tool: "backups.cancel", arguments: arguments_ } }
        : {}),
      ...(job.status === "failed"
        ? { retry: { tool: "backups.retry", arguments: arguments_ } }
        : {}),
      ...imageRecoveryBuildActions(job),
    },
  });
}
function instanceBackupAccepted(result: any, ownerId: string) {
  if (result?.alreadyAdopted) return sanitize(result);
  const jobId = typeof result?.id === "string" ? result.id : result?.jobId;
  if (!jobId) return sanitize(result);
  const arguments_ = { ownerId, jobId };
  const active = result.status === "queued" || result.status === "running";
  const cancellable =
    active && !(result.operation === "restore" && result.phase === "applying");
  return sanitize({
    ...result,
    accepted: true,
    jobId,
    message:
      result.message ||
      ({
        create: "Instance backup started",
        discovery: "Instance backup discovery started",
        adoption: "Instance backup adoption started",
        verify: "Instance backup verification started",
        restore: "Instance restore started",
      } as Record<string, string>)[String(result.operation)] ||
      "Instance backup operation started",
    nextActions: {
      status: { tool: "instance-backups.status", arguments: arguments_ },
      logs: { tool: "instance-backups.logs", arguments: arguments_ },
      ...(cancellable
        ? { cancel: { tool: "instance-backups.cancel", arguments: arguments_ } }
        : {}),
    },
  });
}
function instanceBackupStatus(job: any, ownerId: string) {
  const jobId = typeof job?.id === "string" ? job.id : undefined;
  if (!jobId) return sanitize(job);
  const arguments_ = { ownerId, jobId };
  const active = job.status === "queued" || job.status === "running";
  const cancellable =
    active && !(job.operation === "restore" && job.phase === "applying");
  return sanitize({
    ...job,
    nextActions: {
      status: { tool: "instance-backups.status", arguments: arguments_ },
      logs: { tool: "instance-backups.logs", arguments: arguments_ },
      ...(cancellable
        ? { cancel: { tool: "instance-backups.cancel", arguments: arguments_ } }
        : {}),
    },
  });
}
function imageRecoveryBuildActions(value: any) {
  const buildId =
    typeof value?.recoveredImageBuildId === "string"
      ? value.recoveredImageBuildId
      : typeof value?.buildId === "string"
      ? value.buildId
      : typeof value?.imageBuildId === "string"
        ? value.imageBuildId
        : undefined;
  if (!buildId) return {};
  const arguments_ = { buildId };
  return {
    imageBuildStatus: { tool: "images.build-status", arguments: arguments_ },
    imageBuildLogs: { tool: "images.build-logs", arguments: arguments_ },
    imageBuildCancel: { tool: "images.build-cancel", arguments: arguments_ },
  };
}
function catalogSchema(name: string): Record<string, unknown> {
  const contextFile = {
    type: "object",
    additionalProperties: false,
    required: ["path", "contentBase64"],
    properties: {
      path: {
        type: "string",
        description:
          "Relative canonical context path; traversal, Dockerfile replacement, symlinks, and duplicate paths are rejected.",
      },
      contentBase64: {
        type: "string",
        description:
          "Canonical base64 file bytes. Decoded contents are secret-scanned and size-bounded.",
      },
      role: {
        type: "string",
        enum: ["asset", "script"],
        description:
          "asset copies into the image; script may be executed only by an explicit provisioning script step.",
      },
      destination: {
        type: "string",
        pattern: "^/opt/agentor-context/",
        description:
          "Controlled absolute image destination under /opt/agentor-context/.",
      },
    },
  };
  const provisioning = {
    type: "array",
    maxItems: 100,
    description:
      "Ordered server-rendered provisioning. Safe mode applies the Agentor worker-image policy. Advanced mode permits arbitrary build-time shell only inside Agentor's controlled Docker boundary; neither accepts secrets.",
    items: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "manager", "packages"],
          properties: {
            type: { const: "packages" },
            manager: { type: "string", enum: ["apt", "npm", "pip"] },
            packages: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "string",
                description:
                  "Pinned or otherwise safe package spec; secret-like values are rejected.",
              },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "command"],
          properties: {
            type: { const: "command" },
            command: {
              type: "string",
              maxLength: 16384,
              description:
                "Build-time shell command. Safe mode policy-checks it; Advanced may break the derived image but never exposes a host, Docker socket, base selection, or full Dockerfile execution.",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "path", "interpreter"],
          properties: {
            type: { const: "script" },
            path: {
              type: "string",
              description:
                "Must name a contextFiles item whose role is script.",
            },
            interpreter: {
              type: "string",
              enum: ["sh", "bash", "python3", "node"],
            },
          },
        },
      ],
    },
  };
  const definition = {
    type: "object",
    additionalProperties: false,
    required: ["name", "baseImage", "contextFiles"],
    description:
      "Image definitions use only approved agentor-worker:approved-* bases. Structured provisioning is rendered server-side. Context bytes and all provisioning text are secret-scanned. dockerfileFragment is Safe-mode legacy compatibility only: it remains readable/buildable when provisioning is absent, but new definitions should use provisioning and Advanced requires it to be empty.",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      description: { type: "string" },
      baseImage: {
        type: "string",
        pattern: "^agentor-worker:approved-[A-Za-z0-9._-]+$",
      },
      provisioningMode: {
        type: "string",
        enum: ["safe", "advanced"],
        default: "safe",
        description:
          "Safe is the default. Advanced runs arbitrary provisioning only in Agentor's generated Docker build and can make an unusable derived image; it grants neither host nor raw-Docker authority.",
      },
      dockerfileFragment: {
        type: "string",
        maxLength: 262144,
        description:
          "Legacy Safe-mode compatibility fragment. Advanced requires this field to be empty and accepts shell only through structured provisioning. Existing Safe fragments remain readable/buildable when provisioning is absent; policy rejects unsafe directives and secret references.",
      },
      provisioning,
      contextFiles: { type: "array", items: contextFile },
    },
  };
  const absolutePaths = {
    type: "object",
    description:
      "Map each authorized worker UUID to up to 32 absolute POSIX file/directory paths. Explicit sensitive/authentication paths are permitted. Omit for legacy defaults.",
    additionalProperties: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", pattern: "^/", maxLength: 4096 },
    },
  };
  const imageResolution = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode: { const: "exact" } },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["mode", "acknowledged"],
        properties: {
          mode: { const: "workspace-only" },
          acknowledged: {
            const: true,
            description:
              "Explicitly acknowledges that the restored workspace will not use the original custom image.",
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["mode", "imageDefinitionId", "imageVersion"],
        properties: {
          mode: { const: "replacement" },
          imageDefinitionId: { type: "string", minLength: 1 },
          imageVersion: { type: "string", minLength: 1 },
        },
      },
    ],
  };
  const p: any = {
    ownerId: { type: "string", minLength: 1 },
    workerId: { type: "string", minLength: 1 },
    path: {
      type: "string",
      pattern: "^/",
      description:
        "Absolute directory path; defaults to /workspace and may navigate to /.",
    },
    definitionId: { type: "string" },
    buildId: { type: "string", minLength: 1 },
    version: { type: "string" },
    definition,
    workspaceIds: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
      description:
        "For backups.restore, an optional exact subset of artifact workspace IDs. Omit to restore every workspace in the artifact. For backups.create, the workspaces to include.",
    },
    selectedPathsByWorkspace: absolutePaths,
    artifactId: { type: "string" },
    jobId: { type: "string" },
    displayName: {
      type: "string",
      description: "Optional display name for the first restored worker.",
    },
    imageResolutions: {
      type: "object",
      additionalProperties: imageResolution,
      description:
        "Optional per-source-workspace image dependency choices. A custom image that cannot be resolved must use an explicit replacement or an acknowledged workspace-only restore; Agentor never silently substitutes its default image.",
    },
    settings: {
      type: "object",
      properties: { selectedPathsByWorkspace: absolutePaths },
    },
    after: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
    requestId: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Caller-supplied durable request identity. Retrying the same accepted request returns the original job rather than starting duplicate work.",
    },
    providerId: {
      type: "string",
      enum: ["local", "fake", "google-drive"],
    },
    remoteBackupId: { type: "string", minLength: 1 },
    options: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeWorkers: { type: "boolean", default: true },
        includeAgentData: { type: "boolean", default: true },
        includeDockerVolumes: { type: "boolean", default: true },
        includeLocalBackups: { type: "boolean", default: false },
        includeLogs: { type: "boolean", default: false },
      },
    },
    builder: { type: "string", enum: ["controlled", "fake"] },
    system: { type: "boolean" },
    direction: {
      type: "string",
      enum: ["push", "pull"],
      description: "Git sync direction; defaults to push.",
    },
    resolution: {
      type: "string",
      enum: ["remote-copy"],
      description:
        "Required to import a conflicting remote image definition as a separate recovery copy.",
    },
    workflow: { type: "string", enum: ["direct", "branch", "pull-request"] },
    branch: { type: "string", minLength: 1, maxLength: 200 },
    message: { type: "string", minLength: 1, maxLength: 500 },
    ghcrByDigest: {
      type: "object",
      additionalProperties: {
        type: "string",
        pattern: "^ghcr\\.io/.+@sha256:[0-9a-fA-F]{64}$",
      },
      description:
        "Optional immutable GHCR references keyed by the matching built digest.",
    },
  };
  if (
    name === "instance-backups.preflight" ||
    name === "instance-backups.restore"
  )
    p.options = {
      type: "object",
      additionalProperties: false,
      properties: {
        restoreDockerVolumes: {
          type: "boolean",
          default: true,
          description:
            "Restore the Agentor-owned Docker volumes embedded in the bundle. Existing destination volumes are never overwritten.",
        },
        restoreHostMountPolicies: {
          type: "boolean",
          default: false,
          description:
            "Restore host-mount allowlists and grants. External host contents are not embedded and must be prepared separately.",
        },
        confirmReplaceControlPlane: {
          type: "boolean",
          description:
            "For restore, must be true to acknowledge replacement of the destination control-plane data.",
        },
        confirmExternalDependencies: {
          type: "boolean",
          description:
            "For restore, must be true to acknowledge that environment values, external secret files, image layers, and selected host data have been prepared separately.",
        },
      },
      ...(name === "instance-backups.restore"
        ? {
            required: [
              "confirmReplaceControlPlane",
              "confirmExternalDependencies",
            ],
          }
        : {}),
    };
  let r = ["ownerId"];
  if (name === "images.create" || name === "images.validate")
    r = ["ownerId", "definition"];
  else if (name === "images.get" || name === "images.delete")
    r = ["ownerId", "definitionId"];
  else if (name === "images.build") r = ["ownerId", "definitionId"];
  else if (
    [
      "images.build-status",
      "images.build-logs",
      "images.build-cancel",
    ].includes(name)
  )
    r = ["buildId"];
  else if (name === "images.validation-retry") r = ["definitionId", "version"];
  else if (
    [
      "images.delete-version",
      "images.test-worker",
      "images.promote",
      "images.rollback",
      "images.default",
    ].includes(name)
  )
    r = ["ownerId", "definitionId", "version"];
  else if (name === "backups.paths.list") r = ["ownerId", "workerId"];
  else if (name === "backups.create") r = ["ownerId", "workspaceIds"];
  else if (["backups.status", "backups.cancel", "backups.retry"].includes(name))
    r = ["ownerId", "jobId"];
  else if (["backups.delete", "backups.restore"].includes(name))
    r = ["ownerId", "artifactId"];
  else if (
    [
      "instance-backups.status",
      "instance-backups.logs",
      "instance-backups.cancel",
    ].includes(name)
  )
    r = ["ownerId", "jobId"];
  else if (name === "instance-backups.adopt")
    r = ["ownerId", "remoteBackupId"];
  else if (
    name === "instance-backups.preflight" ||
    name === "instance-backups.restore"
  )
    r = ["ownerId", "artifactId"];
  else if (name === "instance-backups.inspect") r = ["ownerId"];
  return {
    type: "object",
    additionalProperties: false,
    required: r,
    properties: p,
  };
}
function enrichImageProvisioningSchema(
  name: string,
  schema: Record<string, unknown>,
) {
  if (!name.startsWith("images.")) return schema;
  const definition = (schema.properties as any)?.definition;
  if (!definition) return schema;
  const properties = definition.properties || {},
    context = properties.contextFiles?.items?.properties,
    steps = properties.provisioning?.items?.oneOf;
  properties.pluginComposition = {
    type: "array",
    maxItems: 50,
    description:
      "Reusable plugin build contributions selected for this image. Only secret-free image construction and validation are baked in; worker configuration, secrets, ports, displays, and runtime state remain per-worker.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["definitionId", "validation"],
      properties: {
        definitionId: { type: "string", minLength: 1 },
        validation: { type: "string", enum: ["required", "optional"] },
      },
    },
  };
  if (context?.role)
    context.role.description =
      "asset copies into the image as agent-owned runtime content; script may be executed only by an explicit provisioning script step.";
  if (Array.isArray(steps)) {
    const packages = steps.find(
      (step: any) => step?.properties?.type?.const === "packages",
    )?.properties?.packages?.items;
    if (packages) {
      packages.pattern = "^(?!-)";
      packages.description =
        "Pinned or otherwise safe package spec; option-like tokens beginning with - and secret-like values are rejected.";
    }
  }
  return schema;
}
function enrichBackupRecoverySchema(name: string, schema: any) {
  if (
    ![
      "backups.discovery.start",
      "backups.discovery.list",
      "backups.inspect",
      "backups.adopt",
      "backups.image-recovery.start",
      "backups.key-status",
      "backups.recovery-material.import",
      "backups.logs",
    ].includes(name)
  )
    return schema;
  const props = schema.properties ?? (schema.properties = {});
  props.remoteBackupId = { type: "string", minLength: 1 };
  props.artifactId = { type: "string", minLength: 1 };
  props.workspaceId = { type: "string", minLength: 1 };
  props.startBuild = {
    type: "boolean",
    description: "When true, resolve recovered image dependencies and start an asynchronous controlled image build when required.",
  };
  props.providerId = {
    type: "string",
    enum: ["local", "fake", "google-drive"],
  };
  props.recoveryMaterial = {
    type: "string",
    minLength: 1,
    maxLength: 16384,
    writeOnly: true,
    description:
      "Portable recovery material; never returned, logged, or audited.",
  };
  props.after = { type: "integer", minimum: 0 };
  props.limit = { type: "integer", minimum: 1, maximum: 1000 };
  if (["backups.inspect", "backups.adopt"].includes(name))
    schema.required = ["ownerId", "remoteBackupId"];
  else if (name === "backups.image-recovery.start")
    schema.required = ["ownerId", "artifactId", "workspaceId"];
  else if (name === "backups.recovery-material.import")
    schema.required = ["ownerId", "recoveryMaterial"];
  else if (name === "backups.logs") schema.required = ["ownerId", "jobId"];
  else schema.required = ["ownerId"];
  // The recovery manager owns its build strategy. Do not advertise an image
  // builder selector that its durable API does not accept.
  if (name === "backups.image-recovery.start") delete props.builder;
  return schema;
}
export function sanitizeManagementBackupPayload(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeManagementBackupPayload);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        // Secret *names* are required reconstruction diagnostics and contain no
        // values. Keep those two contract fields visible while still applying
        // recursive redaction if their shape ever grows beyond string arrays.
        if (key === "requiredSecretNames" || key === "missingSecrets")
          return [key, sanitizeManagementBackupPayload(item)];
        return /token|secret|credential|password|authorization|recoveryMaterial|keyMaterial|recoveryKit|recipe|dockerfile|provisioning|contextFiles|providerUploadId|pendingProvider(?:Object|Artifact|Upload)Id/i.test(
          key,
        )
          ? [key, "[REDACTED]"]
          : [key, sanitizeManagementBackupPayload(item)];
      }),
    );
  return value;
}
const sanitize = sanitizeManagementBackupPayload;
