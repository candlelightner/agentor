import { randomUUID } from "node:crypto";
import type { ImageCatalogManager, ImageDefinition } from "./image-catalog";
import {
  decryptGitImageCredential,
  encryptGitImageCredential,
  gitImageCredentialAad,
} from "./git-image-crypto";
import {
  GIT_IMAGE_CATALOG_FORMAT,
  hashDefinition,
  parseCatalog as parseCatalogUnsafe,
  serializeCatalog,
  type GitFileMap,
} from "./git-image-format";
import {
  FakeGitHubProvider,
  GitHubRestProvider,
  configureFakeGitRepository,
  inspectFakeGitRepository,
  mintGitHubAppInstallationToken,
  type GitImageProvider,
} from "./git-image-provider";
import {
  GitImageStore,
  type GitImageConnection,
  type GitImageLink,
} from "./git-image-store";

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
const now = () => new Date().toISOString();
function parseCatalog(files: GitFileMap) {
  try {
    const bytes = Object.values(files).reduce(
      (sum, value) => sum + Buffer.byteLength(value),
      0,
    );
    if (
      bytes > 350 * 1024 * 1024 ||
      Buffer.byteLength(files[".agentor/image-catalog.v1.json"] || "") >
        1024 * 1024
    )
      fail(400, "Remote image catalog exceeds import limits");
    return parseCatalogUnsafe(files);
  } catch (error: any) {
    if (error?.statusCode) throw error;
    fail(400, "Remote image catalog failed validation");
  }
}
function repository(value: unknown) {
  const result = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result))
    fail(400, "repository must be an owner/name GitHub repository");
  return result;
}
function branch(value: unknown, fallback = "main") {
  const result = String(value || fallback);
  if (
    !/^(?!\/|.*(?:\.\.|\/\/|@\{|[~^:?*\[]))[A-Za-z0-9._/-]{1,200}$/.test(
      result,
    ) ||
    result.endsWith("/") ||
    result.endsWith(".lock")
  )
    fail(400, "Invalid Git branch");
  return result;
}
function publicConnection(connection: GitImageConnection) {
  return {
    id: connection.id,
    provider: connection.provider,
    repository: connection.repository,
    visibility: connection.visibility,
    defaultBranch: connection.defaultBranch,
    workflow: connection.workflow,
    buildMode: connection.buildMode,
    actionsWorkflow: connection.actionsWorkflow,
    publishGhcr: connection.publishGhcr,
    credential: {
      type: connection.auth.type,
      configured: connection.auth.type !== "none",
      shortLived: connection.auth.type === "github-app",
    },
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastSyncAt: connection.lastSyncAt,
    lastRemoteRevision: connection.lastRemoteRevision,
    lastError: connection.lastError,
  };
}

export class GitImageCatalogManager {
  constructor(private store = new GitImageStore()) {}
  init() {
    return this.store.init();
  }
  ownerIds() {
    return this.store.state.connections.map((connection) => connection.ownerId);
  }
  async forgetOwner(ownerId: string) {
    this.store.state.connections = this.store.state.connections.filter((connection) => connection.ownerId !== ownerId);
    delete this.store.state.links[ownerId];
    delete this.store.state.recovery[ownerId];
    await this.store.persist();
  }
  format() {
    return GIT_IMAGE_CATALOG_FORMAT;
  }
  connection(ownerId: string) {
    const value = this.store.state.connections.find(
      (c) => c.ownerId === ownerId,
    );
    return value ? publicConnection(value) : { connected: false };
  }
  recovery(ownerId: string) {
    return (
      this.store.state.recovery[ownerId] ?? {
        state: "not-run",
        catalogEntries: 0,
        importedDefinitions: 0,
        imageDigests: 0,
        pullableImages: 0,
        note: "Connect and recover the Git catalog after reinstall. Workspace data is not included.",
      }
    );
  }
  private get(ownerId: string) {
    const value = this.store.state.connections.find(
      (c) => c.ownerId === ownerId,
    );
    if (!value) fail(404, "Git image catalog is not connected");
    return value;
  }
  async connect(ownerId: string, input: any) {
    const prior = this.store.state.connections.find(
      (c) => c.ownerId === ownerId,
    );
    if (prior)
      fail(
        409,
        "Disconnect the existing Git image catalog before replacing it",
      );
    if (!["fake", "github"].includes(input?.provider))
      fail(400, "provider must be github or fake");
    const id = randomUUID(),
      provider = input.provider as "fake" | "github",
      visibility = input?.visibility === "public" ? "public" : "private",
      authType = String(
        input?.auth?.type || (visibility === "public" ? "none" : "pat"),
      );
    let auth: GitImageConnection["auth"];
    if (authType === "none") {
      if (visibility === "private")
        fail(400, "Private repositories require a credential");
      auth = { type: "none" };
    } else if (authType === "pat") {
      const token = String(input?.auth?.token || "");
      if (token.length < 8)
        fail(400, "A fine-grained repository token is required");
      auth = {
        type: "pat",
        token: await encryptGitImageCredential(
          token,
          gitImageCredentialAad(ownerId, id, "pat"),
        ),
      };
    } else if (authType === "github-app") {
      const appId = String(input?.auth?.appId || ""),
        installationId = String(input?.auth?.installationId || "");
      if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId))
        fail(400, "GitHub App and installation IDs are required");
      auth = { type: "github-app", appId, installationId };
    } else fail(400, "Unsupported GitHub credential type");
    const actionsWorkflow = String(
      input?.actionsWorkflow || ".github/workflows/agentor-images.yml",
    );
    if (
      input?.buildMode === "github-actions" &&
      !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(actionsWorkflow)
    )
      fail(400, "Invalid GitHub Actions workflow path");
    const stamp = now(),
      connection: GitImageConnection = {
        id,
        ownerId,
        provider,
        repository: repository(input?.repository),
        visibility,
        defaultBranch: branch(input?.defaultBranch),
        workflow: ["direct", "branch", "pull-request"].includes(input?.workflow)
          ? input.workflow
          : "pull-request",
        buildMode:
          input?.buildMode === "github-actions" ? "github-actions" : "local",
        actionsWorkflow:
          input?.buildMode === "github-actions" ? actionsWorkflow : undefined,
        publishGhcr: Boolean(input?.publishGhcr),
        auth,
        createdAt: stamp,
        updatedAt: stamp,
      };
    this.store.state.connections.push(connection);
    this.store.state.links[ownerId] = [];
    await this.store.persist();
    return publicConnection(connection);
  }
  async disconnect(ownerId: string) {
    const connection = this.get(ownerId);
    try {
      await (await this.provider(connection)).revoke?.();
    } catch {}
    this.store.state.connections = this.store.state.connections.filter(
      (c) => c !== connection,
    );
    delete this.store.state.links[ownerId];
    delete this.store.state.recovery[ownerId];
    await this.store.persist();
    return {
      disconnected: true,
      credentialErased: true,
      remoteRepositoryUnchanged: true,
    };
  }
  private async provider(
    connection: GitImageConnection,
  ): Promise<GitImageProvider> {
    if (connection.provider === "fake")
      return new FakeGitHubProvider(connection.auth.type !== "none");
    const token = async () => {
      if (connection.auth.type === "pat")
        return decryptGitImageCredential(
          connection.auth.token,
          gitImageCredentialAad(connection.ownerId, connection.id, "pat"),
        );
      if (connection.auth.type === "github-app") {
        const path = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
        if (!path)
          throw new Error(
            "GITHUB_APP_PRIVATE_KEY_FILE is required for GitHub App authentication",
          );
        return mintGitHubAppInstallationToken(
          connection.auth.appId,
          connection.auth.installationId,
          path,
        );
      }
      return undefined;
    };
    return new GitHubRestProvider(token);
  }
  async sync(ownerId: string, catalog: ImageCatalogManager, input: any = {}) {
    const connection = this.get(ownerId),
      direction = input.direction === "pull" ? "pull" : "push",
      provider = await this.provider(connection),
      workflow = (input.workflow ??
        connection.workflow) as GitImageConnection["workflow"];
    if (!["direct", "branch", "pull-request"].includes(workflow))
      fail(400, "Invalid Git workflow");
    const target = connection.defaultBranch,
      remote = await provider.read(connection.repository, target),
      links =
        this.store.state.links[ownerId] ??
        (this.store.state.links[ownerId] = []),
      local = catalog.list(ownerId, false),
      conflicts: Array<{ remoteId: string; localId?: string; reason: string }> =
        [],
      imported: string[] = [];
    if (direction === "pull") {
      const entries = parseCatalog(remote.files);
      for (const entry of entries) {
        const link = links.find((x) => x.remoteId === entry.remoteId),
          localDefinition = link
            ? local.find((x) => x.id === link.localId)
            : undefined;
        if (localDefinition) {
          const localHash = hashDefinition(localDefinition);
          if (localHash !== link!.baseHash && localHash !== entry.hash) {
            conflicts.push({
              remoteId: entry.remoteId,
              localId: localDefinition.id,
              reason: "local-and-remote-diverged",
            });
            continue;
          }
          if (localHash !== entry.hash) {
            if (input.resolution !== "remote-copy") {
              conflicts.push({
                remoteId: entry.remoteId,
                localId: localDefinition.id,
                reason: "remote-changed; remote-copy resolution required",
              });
              continue;
            }
            const copy = await catalog.importRecovered(ownerId, {
              ...entry.definition,
              name: `${entry.definition.name} (Git recovery)`,
            });
            imported.push(copy.id);
            links.push(
              this.link(
                entry.remoteId,
                copy,
                entry.hash,
                remote.revision,
                entry.definition.versions,
              ),
            );
          } else {
            link!.baseHash = entry.hash;
            link!.remoteRevision = remote.revision;
          }
        } else {
          const nameCollision = local.find(
            (x) => x.name === entry.definition.name,
          );
          if (nameCollision && input.resolution !== "remote-copy") {
            conflicts.push({
              remoteId: entry.remoteId,
              localId: nameCollision.id,
              reason: "untracked-local-name-collision",
            });
            continue;
          }
          const created = await catalog.importRecovered(ownerId, {
            ...entry.definition,
            name: nameCollision
              ? `${entry.definition.name} (Git recovery)`
              : entry.definition.name,
          });
          imported.push(created.id);
          links.push(
            this.link(
              entry.remoteId,
              created,
              entry.hash,
              remote.revision,
              entry.definition.versions,
            ),
          );
        }
      }
      const versions = entries.flatMap((x) => x.definition.versions),
        pullable = entries
          .flatMap((x) => x.definition.versions)
          .filter((v: any) => v.ghcr?.reference).length;
      this.store.state.recovery[ownerId] = {
        state: conflicts.length ? "conflict" : "recovered",
        checkedAt: now(),
        catalogEntries: entries.length,
        importedDefinitions: imported.length,
        imageDigests: versions.length,
        pullableImages: pullable,
        note: "Catalog metadata recovered independently of workspace backups. GHCR references may be pulled by the local image builder integration.",
      };
      connection.lastRemoteRevision = remote.revision;
      connection.lastSyncAt = connection.updatedAt = now();
      await this.store.persist();
      return {
        direction,
        revision: remote.revision,
        imported,
        conflicts,
        recovery: this.recovery(ownerId),
      };
    }
    const changed = local.filter((def) => {
      const link = links.find((x) => x.localId === def.id);
      return !link || hashDefinition(def) !== link.baseHash;
    });
    if (
      connection.lastRemoteRevision !== undefined &&
      remote.revision !== connection.lastRemoteRevision
    ) {
      for (const def of changed)
        conflicts.push({
          remoteId: links.find((x) => x.localId === def.id)?.remoteId || def.id,
          localId: def.id,
          reason: "remote-changed-since-last-sync",
        });
      if (!conflicts.length)
        conflicts.push({
          remoteId: "catalog",
          reason: "remote-changed-since-last-sync",
        });
      await this.store.persist();
      return {
        direction,
        revision: remote.revision,
        conflicts,
        written: false,
      };
    }
    const files = serializeCatalog(local, {
      buildMode: connection.buildMode,
      workflow: connection.actionsWorkflow,
      publishGhcr: connection.publishGhcr,
      ghcrByDigest: input.ghcrByDigest,
    });
    if (connection.auth.type === "pat") {
      const credential = await decryptGitImageCredential(
        connection.auth.token,
        gitImageCredentialAad(ownerId, connection.id, "pat"),
      );
      if (Object.values(files).some((value) => value.includes(credential)))
        fail(400, "Catalog content contains the configured GitHub credential");
    }
    const syncBranch =
        workflow === "direct"
          ? target
          : branch(input.branch, `agentor/catalog-${Date.now()}`),
      result = await provider.write(connection.repository, {
        branch: syncBranch,
        targetBranch: target,
        expectedRevision: remote.revision,
        files,
        message: String(input.message || "Sync Agentor image catalog"),
        workflow,
      });
    let workflowDispatched = false;
    if (connection.buildMode === "github-actions") {
      if (!connection.actionsWorkflow || !provider.dispatchWorkflow)
        fail(400, "GitHub Actions build workflow is not available");
      await provider.dispatchWorkflow(connection.repository, connection.actionsWorkflow, result.branch);
      workflowDispatched = true;
    }
    for (const def of local) {
      const hash = hashDefinition(def),
        existing = links.find((x) => x.localId === def.id);
      if (existing) {
        existing.baseHash = hash;
        existing.remoteRevision = result.revision;
      } else
        links.push({
          remoteId: def.id,
          localId: def.id,
          baseHash: hash,
          remoteRevision: result.revision,
          recoveredVersions: [],
        });
    }
    connection.lastRemoteRevision =
      workflow === "direct" ? result.revision : remote.revision;
    connection.lastSyncAt = connection.updatedAt = now();
    delete connection.lastError;
    await this.store.persist();
    return {
      direction,
      written: true,
      revision: result.revision,
      branch: result.branch,
      pullRequest: result.pullRequest,
      workflowDispatched,
      conflicts: [],
    };
  }
  private link(
    remoteId: string,
    created: ImageDefinition,
    hash: string,
    revision: string | null,
    versions: any[],
  ): GitImageLink {
    return {
      remoteId,
      localId: created.id,
      baseHash: hash,
      remoteRevision: revision,
      recoveredVersions: versions.map((v) => ({
        version: v.version,
        digest: v.digest,
        ghcrReference: v.ghcr?.reference,
      })),
    };
  }
  fakeConfigure(ownerId: string, input: any) {
    const connection = this.get(ownerId);
    if (connection.provider !== "fake")
      fail(404, "Fake provider is not configured");
    return configureFakeGitRepository(connection.repository, input);
  }
  fakeInspect(ownerId: string) {
    const connection = this.get(ownerId);
    if (connection.provider !== "fake")
      fail(404, "Fake provider is not configured");
    return inspectFakeGitRepository(connection.repository);
  }
  async fakeSetFiles(ownerId: string, files: GitFileMap, branchName?: string) {
    const connection = this.get(ownerId);
    if (connection.provider !== "fake")
      fail(404, "Fake provider is not configured");
    const repo =
      inspectFakeGitRepository(connection.repository) ??
      configureFakeGitRepository(connection.repository);
    const name = branch(branchName, connection.defaultBranch),
      revision = `external-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    repo.branches[name] = { revision, files: structuredClone(files) };
    return { revision };
  }
}

let singleton: GitImageCatalogManager | undefined;
export function useGitImageCatalogManager() {
  return (singleton ??= new GitImageCatalogManager());
}
