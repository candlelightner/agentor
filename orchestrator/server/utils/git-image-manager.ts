import { createHash, randomUUID } from "node:crypto";
import { getUserById } from "./auth";
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
  type GitImageRecovery,
} from "./git-image-store";
import { withOwnerLifecycleMutation } from "./worker-lifecycle-coordinator";

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
function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function canonicalCatalogFile(path: string, value: string) {
  if (path !== ".agentor/image-catalog.v1.json") return value;
  const manifest = JSON.parse(value);
  // generatedAt is intentionally nondeterministic and does not describe
  // catalog content. Every other field remains part of reconciliation.
  delete manifest.generatedAt;
  return canonicalJson(manifest);
}
function equivalentCatalogFiles(left: GitFileMap, right: GitFileMap) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  )
    return false;
  try {
    return leftKeys.every(
      (key) =>
        canonicalCatalogFile(key, left[key]!) ===
        canonicalCatalogFile(key, right[key]!),
    );
  } catch {
    return false;
  }
}
function catalogBranch(files: GitFileMap) {
  const canonical = Object.keys(files)
    .sort()
    .map((path) => [path, canonicalCatalogFile(path, files[path]!)]);
  return `agentor/catalog-${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 20)}`;
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
  private ownerQueues = new Map<string, Promise<void>>();
  constructor(
    private store = new GitImageStore(),
    private ownerExists: (ownerId: string) => boolean | Promise<boolean> = () =>
      true,
  ) {}

  private withOwner<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ownerQueues.get(ownerId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.ownerQueues.set(ownerId, tail);
    void tail.finally(() => {
      if (this.ownerQueues.get(ownerId) === tail)
        this.ownerQueues.delete(ownerId);
    });
    return result;
  }
  init() {
    return this.store.init();
  }
  ownerIds() {
    return this.store.state.connections.map((connection) => connection.ownerId);
  }
  async forgetOwner(ownerId: string) {
    await this.withOwner(ownerId, () =>
      this.store.transaction(() => {
        this.store.state.connections = this.store.state.connections.filter(
          (connection) => connection.ownerId !== ownerId,
        );
        delete this.store.state.links[ownerId];
        delete this.store.state.recovery[ownerId];
      }),
    );
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
    return withOwnerLifecycleMutation(ownerId, () =>
      this.withOwner(ownerId, async () => {
        if (!(await this.ownerExists(ownerId)))
          fail(404, "Owner not found");
        return this.connectUnlocked(ownerId, input);
      }),
    );
  }
  private async connectUnlocked(ownerId: string, input: any) {
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
    await this.store.transaction(() => {
      if (
        this.store.state.connections.some(
          (candidate) => candidate.ownerId === ownerId,
        )
      )
        fail(
          409,
          "Disconnect the existing Git image catalog before replacing it",
        );
      this.store.state.connections.push(connection);
      this.store.state.links[ownerId] = [];
    });
    return publicConnection(connection);
  }
  async disconnect(ownerId: string) {
    return this.withOwner(ownerId, async () => {
      const connection = await this.store.read(() =>
        structuredClone(this.get(ownerId)),
      );
      try {
        await (await this.provider(connection)).revoke?.();
      } catch {}
      await this.store.transaction(() => {
        const live = this.get(ownerId);
        if (live.id !== connection.id)
          fail(409, "Git image catalog connection changed concurrently");
        this.store.state.connections = this.store.state.connections.filter(
          (candidate) => candidate.id !== connection.id,
        );
        delete this.store.state.links[ownerId];
        delete this.store.state.recovery[ownerId];
      });
      return {
        disconnected: true,
        credentialErased: true,
        remoteRepositoryUnchanged: true,
      };
    });
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
    return this.withOwner(ownerId, async () => {
      const working = await this.store.read(() => {
        const connection = structuredClone(this.get(ownerId));
        return {
          connection,
          links: structuredClone(this.store.state.links[ownerId] ?? []),
          recovery: structuredClone(this.store.state.recovery[ownerId]),
        };
      });
      const result = await this.syncUnlocked(ownerId, catalog, input, working);
      await this.store.transaction(() => {
        const live = this.get(ownerId);
        if (live.id !== working.connection.id)
          fail(409, "Git image catalog connection changed concurrently");
        const index = this.store.state.connections.findIndex(
          (candidate) => candidate.id === live.id,
        );
        this.store.state.connections[index] = structuredClone(
          working.connection,
        );
        this.store.state.links[ownerId] = structuredClone(working.links);
        if (working.recovery)
          this.store.state.recovery[ownerId] = structuredClone(
            working.recovery,
          );
      });
      return result;
    });
  }
  private async syncUnlocked(
    ownerId: string,
    catalog: ImageCatalogManager,
    input: any,
    working: {
      connection: GitImageConnection;
      links: GitImageLink[];
      recovery?: GitImageRecovery;
    },
  ) {
    const connection = working.connection,
      direction = input.direction === "pull" ? "pull" : "push",
      provider = await this.provider(connection),
      workflow = (input.workflow ??
        connection.workflow) as GitImageConnection["workflow"];
    if (!["direct", "branch", "pull-request"].includes(workflow))
      fail(400, "Invalid Git workflow");
    const target = connection.defaultBranch,
      remote = await provider.read(connection.repository, target),
      links = working.links,
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
            const copy = await catalog.importRecovered(
              ownerId,
              {
                ...entry.definition,
                name: `${entry.definition.name} (Git recovery)`,
              },
              {
                connectionId: connection.id,
                remoteId: entry.remoteId,
                hash: entry.hash,
              },
            );
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
          // A previous pull can durably import into the catalog and then lose
          // only its independent Git-store link commit. Re-adopt exclusively
          // from server-minted provenance for this exact connection/entry;
          // content similarity alone must not turn a deliberate reconnect
          // into an implicit recovery merge.
          const recovered = local.find(
            (candidate) =>
              !links.some((existing) => existing.localId === candidate.id) &&
              candidate.gitRecovery?.connectionId === connection.id &&
              candidate.gitRecovery.remoteId === entry.remoteId &&
              candidate.gitRecovery.hash === entry.hash &&
              hashDefinition(candidate) === entry.hash,
          );
          if (recovered) {
            imported.push(recovered.id);
            links.push(
              this.link(
                entry.remoteId,
                recovered,
                entry.hash,
                remote.revision,
                entry.definition.versions,
              ),
            );
            continue;
          }
          if (nameCollision && input.resolution !== "remote-copy") {
            conflicts.push({
              remoteId: entry.remoteId,
              localId: nameCollision.id,
              reason: "untracked-local-name-collision",
            });
            continue;
          }
          const created = await catalog.importRecovered(
            ownerId,
            {
              ...entry.definition,
              name: nameCollision
                ? `${entry.definition.name} (Git recovery)`
                : entry.definition.name,
            },
            {
              connectionId: connection.id,
              remoteId: entry.remoteId,
              hash: entry.hash,
            },
          );
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
      working.recovery = {
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
      return {
        direction,
        revision: remote.revision,
        imported,
        conflicts,
        recovery: working.recovery,
      };
    }
    const changed = local.filter((def) => {
      const link = links.find((x) => x.localId === def.id);
      return !link || hashDefinition(def) !== link.baseHash;
    });
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
    const message = String(input.message || "Sync Agentor image catalog"),
      syncBranch =
        workflow === "direct"
          ? target
          : branch(input.branch, catalogBranch(files));
    if (workflow !== "direct" && syncBranch === target)
      fail(400, "Review branch must differ from the default branch");
    const reviewSnapshot =
      workflow === "direct"
        ? undefined
        : await provider.read(connection.repository, syncBranch);
    if (
      reviewSnapshot &&
      reviewSnapshot.revision !== null &&
      !equivalentCatalogFiles(reviewSnapshot.files, files)
    ) {
      return {
        direction,
        revision: remote.revision,
        branch: syncBranch,
        conflicts: [
          {
            remoteId: "catalog",
            reason: "review-branch-already-exists-with-different-content",
          },
        ],
        written: false,
      };
    }
    if (
      workflow === "direct" &&
      remote.revision !== null &&
      equivalentCatalogFiles(remote.files, files)
    ) {
      // This also covers a first-ever push whose remote commit (and optional
      // Actions dispatch) succeeded before the initial local state write
      // failed, when no lastRemoteRevision existed to reveal the split commit.
      this.updatePushLinks(links, local, remote.revision);
      connection.lastRemoteRevision = remote.revision;
      connection.lastSyncAt = connection.updatedAt = now();
      delete connection.lastError;
      return {
        direction,
        written: true,
        reconciled: true,
        revision: remote.revision,
        branch: target,
        workflowDispatched: false,
        conflicts: [],
      };
    }
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
      return {
        direction,
        revision: remote.revision,
        conflicts,
        written: false,
      };
    }
    if (reviewSnapshot && reviewSnapshot.revision !== null) {
      let pullRequest;
      let workflowDispatched = false;
      if (workflow === "pull-request") {
        if (!provider.ensurePullRequest)
          fail(400, "Git pull-request workflow is not available");
        const ensured = await provider.ensurePullRequest(
          connection.repository,
          {
            branch: syncBranch,
            targetBranch: target,
            title: message,
          },
        );
        pullRequest = ensured.pullRequest;
        // A matching existing PR is the reconciliation point for an earlier
        // successful push whose local state commit failed. GitHub's workflow
        // dispatch endpoint has no idempotency key, so dispatch only when this
        // retry had to create the missing PR.
        if (ensured.created && connection.buildMode === "github-actions") {
          if (!connection.actionsWorkflow || !provider.dispatchWorkflow)
            fail(400, "GitHub Actions build workflow is not available");
          await provider.dispatchWorkflow(
            connection.repository,
            connection.actionsWorkflow,
            syncBranch,
          );
          workflowDispatched = true;
        }
      }
      this.updatePushLinks(links, local, reviewSnapshot.revision);
      connection.lastRemoteRevision = remote.revision;
      connection.lastSyncAt = connection.updatedAt = now();
      delete connection.lastError;
      return {
        direction,
        written: true,
        reconciled: true,
        revision: reviewSnapshot.revision,
        branch: syncBranch,
        pullRequest,
        workflowDispatched,
        conflicts: [],
      };
    }
    const result = await provider.write(connection.repository, {
      branch: syncBranch,
      targetBranch: target,
      expectedRevision: remote.revision,
      files,
      message,
      workflow,
    });
    let workflowDispatched = false;
    if (connection.buildMode === "github-actions") {
      if (!connection.actionsWorkflow || !provider.dispatchWorkflow)
        fail(400, "GitHub Actions build workflow is not available");
      await provider.dispatchWorkflow(
        connection.repository,
        connection.actionsWorkflow,
        result.branch,
      );
      workflowDispatched = true;
    }
    this.updatePushLinks(links, local, result.revision);
    connection.lastRemoteRevision =
      workflow === "direct" ? result.revision : remote.revision;
    connection.lastSyncAt = connection.updatedAt = now();
    delete connection.lastError;
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
  private updatePushLinks(
    links: GitImageLink[],
    definitions: ImageDefinition[],
    revision: string | null,
  ) {
    for (const definition of definitions) {
      const hash = hashDefinition(definition);
      const existing = links.find(
        (candidate) => candidate.localId === definition.id,
      );
      if (existing) {
        existing.baseHash = hash;
        existing.remoteRevision = revision;
      } else {
        links.push({
          remoteId: definition.id,
          localId: definition.id,
          baseHash: hash,
          remoteRevision: revision,
          recoveredVersions: [],
        });
      }
    }
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
  return (singleton ??= new GitImageCatalogManager(
    undefined,
    (ownerId) => getUserById(ownerId) !== null,
  ));
}
