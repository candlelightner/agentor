import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ImageCatalogManager } from "../../orchestrator/server/utils/image-catalog";
import { GitImageCatalogManager } from "../../orchestrator/server/utils/git-image-manager";
import { GitImageStore } from "../../orchestrator/server/utils/git-image-store";
import { serializeCatalog } from "../../orchestrator/server/utils/git-image-format";
import { withDeletedOwnerCleanupFence } from "../../orchestrator/server/utils/orphan-sweeper";

const definition = (name: string) => ({
  name,
  description: name,
  baseImage: "agentor-worker:approved-test",
  dockerfileFragment: "RUN true",
  contextFiles: [],
});

test("image catalog transactions discard a failed create without clobbering a queued create", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-image-transactions-"),
  );
  try {
    let attempt = 0;
    let entered!: () => void;
    let release!: () => void;
    const enteredWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const catalog = new ImageCatalogManager(directory, async () => {
      if (attempt++ === 1) {
        entered();
        await releaseWrite;
        throw new Error("injected catalog failure");
      }
    });
    await catalog.init();
    const failed = catalog.create("owner", definition("failed"));
    await enteredWrite;
    const succeeding = catalog.create("owner", definition("succeeding"));
    release();
    await expect(failed).rejects.toThrow("injected catalog failure");
    await expect(succeeding).resolves.toMatchObject({ name: "succeeding" });
    expect(catalog.list("owner", false).map((item) => item.name)).toEqual([
      "succeeding",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git image store transactions recover after rejection without retaining the failed connection", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-git-image-transactions-"),
  );
  try {
    let attempt = 0;
    let entered!: () => void;
    let release!: () => void;
    const enteredWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new GitImageCatalogManager(
      new GitImageStore(directory, async () => {
        if (attempt++ === 1) {
          entered();
          await releaseWrite;
          throw new Error("injected git store failure");
        }
      }),
    );
    await manager.init();
    const input = (repository: string) => ({
      provider: "fake",
      repository,
      visibility: "public",
      auth: { type: "none" },
    });
    const failed = manager.connect("failed-owner", input("owner/failed"));
    await enteredWrite;
    const succeeding = manager.connect("good-owner", input("owner/good"));
    release();
    await expect(failed).rejects.toThrow("injected git store failure");
    await expect(succeeding).resolves.toMatchObject({
      repository: "owner/good",
    });
    expect(manager.connection("failed-owner")).toEqual({ connected: false });
    expect(manager.connection("good-owner")).toMatchObject({
      repository: "owner/good",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git catalog connection cannot resurrect a deleted owner's credentials", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-git-image-owner-fence-"),
  );
  const ownerId = `deleted-git-owner-${Date.now()}-${Math.random()}`;
  try {
    const manager = new GitImageCatalogManager(
      new GitImageStore(directory),
      () => false,
    );
    await manager.init();
    let cleanupEntered!: () => void;
    let releaseCleanup!: () => void;
    const entered = new Promise<void>((resolve) => {
      cleanupEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanup = withDeletedOwnerCleanupFence(
      ownerId,
      () => false,
      async () => {
        await manager.forgetOwner(ownerId);
        cleanupEntered();
        await release;
      },
    );
    await entered;
    const staleConnect = manager.connect(ownerId, {
      provider: "fake",
      repository: "owner/deleted",
      visibility: "private",
      auth: {
        type: "pat",
        token: "github_pat_DELETED_OWNER_MUST_NOT_PERSIST",
      },
    });
    releaseCleanup();
    await expect(cleanup).resolves.toBe(true);
    await expect(staleConnect).rejects.toMatchObject({
      statusCode: 404,
      message: "Owner not found",
    });
    expect(manager.connection(ownerId)).toEqual({ connected: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fake image builder terminalizes and releases its execution after a scheduled persistence failure", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-image-step-failure-"),
  );
  try {
    let writes = 0;
    let failSteps = true;
    const catalog = new ImageCatalogManager(directory, async () => {
      writes++;
      // init, definition create, and queued build admission commit first.
      if (failSteps && writes > 3)
        throw new Error("injected fake-step failure");
    });
    await catalog.init();
    const created = await catalog.create("owner", definition("step-failure"));
    const build = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 100,
    });
    await expect
      .poll(() => catalog.publicBuild(build.id, "owner", false).status)
      .toBe("failed");
    expect(catalog.publicBuild(build.id, "owner", false)).toMatchObject({
      phase: "failed",
      recovery: "persistence-failed-safe",
    });
    failSteps = false;
    await expect(
      catalog.removeDefinition(created.id, "owner", false),
    ).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("controlled image builder terminalizes after its failure-state write is rejected", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-controlled-terminal-"),
  );
  try {
    let failTerminalWrite = true;
    const catalog = new ImageCatalogManager(directory, async (state: any) => {
      if (
        failTerminalWrite &&
        state.builds?.some((build: any) => build.status === "failed")
      ) {
        failTerminalWrite = false;
        throw new Error("injected terminal persistence failure");
      }
    });
    await catalog.init();
    const created = await catalog.create(
      "owner",
      definition("controlled-terminal"),
    );
    (catalog as any).docker = {
      getImage: () => ({
        inspect: async () => ({ Id: `sha256:${"a".repeat(64)}` }),
        remove: async () => undefined,
      }),
      info: async () => {
        throw new Error("injected builder failure");
      },
    };

    const first = await catalog.startBuild(created.id, "owner", false, {
      builder: "controlled",
    });
    await expect
      .poll(() => catalog.publicBuild(first.id, "owner", false).status)
      .toBe("failed");
    expect(catalog.publicBuild(first.id, "owner", false)).toMatchObject({
      status: "failed",
      recovery: "persistence-failed-safe",
    });

    const second = await catalog.startBuild(created.id, "owner", false, {
      builder: "controlled",
    });
    await expect
      .poll(() => catalog.publicBuild(second.id, "owner", false).status)
      .toBe("failed");
    expect((catalog as any).definitionBuilds.has(created.id)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("definition deletion resumes its durable artifact cleanup after final persistence fails", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-image-delete-journal-"),
  );
  const path = join(directory, "image-catalog.json");
  try {
    let sawDeletionIntent = false;
    let failFinalCommit = true;
    const writer = async (state: any) => {
      if (state.deletions?.length) sawDeletionIntent = true;
      if (
        failFinalCommit &&
        sawDeletionIntent &&
        state.deletions?.length === 0 &&
        state.definitions?.length === 0
      ) {
        failFinalCommit = false;
        throw new Error("injected deletion commit failure");
      }
      await writeFile(path, JSON.stringify(state));
    };
    const catalog = new ImageCatalogManager(directory, writer);
    await catalog.init();
    const digest = `sha256:${"a".repeat(64)}`;
    const created = await catalog.importRecovered("owner", {
      ...definition("delete-journal"),
      versions: [
        {
          version: "v1",
          digest,
          baseImage: "agentor-worker:approved-test",
          createdAt: new Date().toISOString(),
          ghcr: { reference: `ghcr.io/example/delete-journal@${digest}` },
        },
      ],
    });
    let removals = 0;
    (catalog as any).docker = {
      getImage: () => ({
        remove: async () => {
          removals++;
        },
      }),
    };

    await expect(
      catalog.removeDefinition(created.id, "owner", false),
    ).rejects.toThrow("injected deletion commit failure");
    expect(removals).toBe(1);
    expect(() => catalog.definition(created.id, "owner", false)).toThrow(
      "Image definition is being deleted",
    );
    await expect(
      catalog.startBuild(created.id, "owner", false, {
        builder: "fake",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const restarted = new ImageCatalogManager(directory, writer);
    (restarted as any).docker = {
      getImage: () => ({
        remove: async () => {
          removals++;
          const error = new Error("No such image") as Error & {
            statusCode?: number;
          };
          error.statusCode = 404;
          throw error;
        },
      }),
    };
    await restarted.init();
    expect(removals).toBe(2);
    expect(restarted.list("owner", false)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt image catalog state fails closed without overwriting durable bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-image-corrupt-"));
  try {
    const path = join(directory, "image-catalog.json");
    const corrupt = '{"definitions":[';
    await writeFile(path, corrupt);
    await expect(new ImageCatalogManager(directory).init()).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(corrupt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt Git image state fails closed without replacing it with an empty catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-image-corrupt-"));
  try {
    await mkdir(directory, { recursive: true });
    const path = join(directory, "state.json");
    const corrupt = '{"version":1,"connections":[';
    await writeFile(path, corrupt);
    await expect(new GitImageStore(directory).init()).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(corrupt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git synchronization does not hold the global store lock during remote I/O", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-owner-locks-"));
  try {
    const manager = new GitImageCatalogManager(new GitImageStore(directory));
    await manager.init();
    for (const owner of ["owner-a", "owner-b"])
      await manager.connect(owner, {
        provider: "fake",
        repository: `${owner}/catalog`,
        visibility: "public",
        auth: { type: "none" },
        workflow: "direct",
      });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    (manager as any).provider = async (connection: any) => ({
      read: async () => {
        if (connection.ownerId === "owner-a") {
          entered();
          await blocked;
        }
        return { revision: null, files: {} };
      },
      write: async (_repository: string, input: any) => ({
        revision: `revision-${connection.ownerId}`,
        branch: input.branch,
      }),
    });
    const catalog = { list: () => [] } as unknown as ImageCatalogManager;
    const first = manager.sync("owner-a", catalog);
    await firstRead;
    let secondSettled = false;
    const second = manager.sync("owner-b", catalog).then((result) => {
      secondSettled = true;
      return result;
    });
    await expect.poll(() => secondSettled, { timeout: 2_000 }).toBe(true);
    release();
    await expect(first).resolves.toMatchObject({
      revision: "revision-owner-a",
    });
    await expect(second).resolves.toMatchObject({
      revision: "revision-owner-b",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git push retry reconciles its committed remote content after local persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-push-retry-"));
  const catalogDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-push-catalog-"),
  );
  try {
    let failNext = false;
    const manager = new GitImageCatalogManager(
      new GitImageStore(directory, async () => {
        if (failNext) {
          failNext = false;
          throw new Error("injected post-remote persistence failure");
        }
      }),
    );
    const catalog = new ImageCatalogManager(catalogDirectory);
    await Promise.all([manager.init(), catalog.init()]);
    await manager.connect("owner", {
      provider: "fake",
      repository: "owner/retry-push",
      visibility: "public",
      workflow: "direct",
      auth: { type: "none" },
    });
    manager.fakeConfigure("owner", { private: false });
    await catalog.create("owner", definition("first"));
    await manager.sync("owner", catalog, {
      direction: "push",
      workflow: "direct",
    });
    await catalog.create("owner", definition("second"));

    failNext = true;
    await expect(
      manager.sync("owner", catalog, { direction: "push", workflow: "direct" }),
    ).rejects.toThrow("injected post-remote persistence failure");
    const committedRevision =
      manager.fakeInspect("owner")!.branches.main!.revision;
    const retry = await manager.sync("owner", catalog, {
      direction: "push",
      workflow: "direct",
    });

    expect(retry).toMatchObject({
      written: true,
      reconciled: true,
      revision: committedRevision,
    });
    expect(manager.fakeInspect("owner")!.branches.main!.revision).toBe(
      committedRevision,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(catalogDirectory, { recursive: true, force: true });
  }
});

test("first Git push retry reconciles its remote commit and Actions dispatch without a prior revision", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-git-first-push-retry-"),
  );
  const catalogDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-first-push-catalog-"),
  );
  try {
    let failNext = false;
    const manager = new GitImageCatalogManager(
      new GitImageStore(directory, async () => {
        if (failNext) {
          failNext = false;
          throw new Error("injected first-push persistence failure");
        }
      }),
    );
    const catalog = new ImageCatalogManager(catalogDirectory);
    await Promise.all([manager.init(), catalog.init()]);
    await manager.connect("owner", {
      provider: "fake",
      repository: "owner/retry-first-push",
      visibility: "public",
      workflow: "direct",
      buildMode: "github-actions",
      actionsWorkflow: ".github/workflows/agentor-images.yml",
      auth: { type: "none" },
    });
    manager.fakeConfigure("owner", { private: false });
    await catalog.create("owner", definition("first-push"));

    failNext = true;
    await expect(
      manager.sync("owner", catalog, { direction: "push" }),
    ).rejects.toThrow("injected first-push persistence failure");
    const afterFailure = manager.fakeInspect("owner")!;
    const committedRevision = afterFailure.branches.main!.revision;
    expect(afterFailure.workflowDispatches).toHaveLength(1);

    const retry = await manager.sync("owner", catalog, { direction: "push" });
    const afterRetry = manager.fakeInspect("owner")!;
    expect(retry).toMatchObject({
      written: true,
      reconciled: true,
      revision: committedRevision,
      branch: "main",
      workflowDispatched: false,
    });
    expect(afterRetry.branches.main!.revision).toBe(committedRevision);
    expect(afterRetry.workflowDispatches).toEqual(
      afterFailure.workflowDispatches,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(catalogDirectory, { recursive: true, force: true });
  }
});

test("Git branch retry reuses its content-addressed remote branch after local persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-branch-retry-"));
  const catalogDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-branch-catalog-"),
  );
  try {
    let failNext = false;
    const manager = new GitImageCatalogManager(
      new GitImageStore(directory, async () => {
        if (failNext) {
          failNext = false;
          throw new Error("injected post-branch persistence failure");
        }
      }),
    );
    const catalog = new ImageCatalogManager(catalogDirectory);
    await Promise.all([manager.init(), catalog.init()]);
    await manager.connect("owner", {
      provider: "fake",
      repository: "owner/retry-branch",
      visibility: "public",
      workflow: "branch",
      auth: { type: "none" },
    });
    manager.fakeConfigure("owner", {
      private: false,
      branches: { main: { revision: "main-revision", files: {} } },
    });
    await catalog.create("owner", definition("branch-image"));

    failNext = true;
    await expect(
      manager.sync("owner", catalog, { direction: "push", workflow: "branch" }),
    ).rejects.toThrow("injected post-branch persistence failure");
    const afterFailure = manager.fakeInspect("owner")!;
    const reviewBranches = Object.keys(afterFailure.branches).filter(
      (name) => name !== "main",
    );
    expect(reviewBranches).toEqual([
      expect.stringMatching(/^agentor\/catalog-[a-f0-9]{20}$/),
    ]);
    const reviewBranch = reviewBranches[0]!;
    const committedRevision = afterFailure.branches[reviewBranch]!.revision;

    const retry = await manager.sync("owner", catalog, {
      direction: "push",
      workflow: "branch",
    });
    const afterRetry = manager.fakeInspect("owner")!;
    expect(retry).toMatchObject({
      written: true,
      reconciled: true,
      revision: committedRevision,
      branch: reviewBranch,
      workflowDispatched: false,
    });
    expect(
      Object.keys(afterRetry.branches).filter((name) => name !== "main"),
    ).toEqual([reviewBranch]);
    expect(afterRetry.branches[reviewBranch]!.revision).toBe(committedRevision);
    expect(afterRetry.pullRequests).toHaveLength(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(catalogDirectory, { recursive: true, force: true });
  }
});

test("Git pull-request retry reuses its branch and PR without dispatching Actions twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-pr-retry-"));
  const catalogDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-pr-catalog-"),
  );
  try {
    let failNext = false;
    const manager = new GitImageCatalogManager(
      new GitImageStore(directory, async () => {
        if (failNext) {
          failNext = false;
          throw new Error("injected post-PR persistence failure");
        }
      }),
    );
    const catalog = new ImageCatalogManager(catalogDirectory);
    await Promise.all([manager.init(), catalog.init()]);
    await manager.connect("owner", {
      provider: "fake",
      repository: "owner/retry-pr",
      visibility: "public",
      workflow: "pull-request",
      buildMode: "github-actions",
      actionsWorkflow: ".github/workflows/agentor-images.yml",
      auth: { type: "none" },
    });
    manager.fakeConfigure("owner", {
      private: false,
      branches: { main: { revision: "main-revision", files: {} } },
    });
    await catalog.create("owner", definition("pr-image"));

    failNext = true;
    await expect(
      manager.sync("owner", catalog, { direction: "push" }),
    ).rejects.toThrow("injected post-PR persistence failure");
    const afterFailure = manager.fakeInspect("owner")!;
    expect(afterFailure.pullRequests).toHaveLength(1);
    expect(afterFailure.workflowDispatches).toHaveLength(1);
    const originalPr = structuredClone(afterFailure.pullRequests[0]!);
    const committedRevision = afterFailure.branches[originalPr.head]!.revision;

    const retry = await manager.sync("owner", catalog, { direction: "push" });
    const afterRetry = manager.fakeInspect("owner")!;
    expect(retry).toMatchObject({
      written: true,
      reconciled: true,
      revision: committedRevision,
      branch: originalPr.head,
      pullRequest: {
        number: originalPr.number,
        url: originalPr.url,
        state: "open",
      },
      workflowDispatched: false,
    });
    expect(afterRetry.pullRequests).toEqual([originalPr]);
    expect(afterRetry.workflowDispatches).toEqual(
      afterFailure.workflowDispatches,
    );
    expect(
      Object.keys(afterRetry.branches).filter((name) => name !== "main"),
    ).toEqual([originalPr.head]);
    expect(afterRetry.branches[originalPr.head]!.revision).toBe(
      committedRevision,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(catalogDirectory, { recursive: true, force: true });
  }
});

test("Git pull retry reuses an imported definition after link persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-pull-retry-"));
  const catalogDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-pull-catalog-"),
  );
  try {
    let failNext = false;
    const manager = new GitImageCatalogManager(
      new GitImageStore(directory, async () => {
        if (failNext) {
          failNext = false;
          throw new Error("injected post-import persistence failure");
        }
      }),
    );
    const catalog = new ImageCatalogManager(catalogDirectory);
    await Promise.all([manager.init(), catalog.init()]);
    const connection = await manager.connect("owner", {
      provider: "fake",
      repository: "owner/retry-pull",
      visibility: "public",
      workflow: "direct",
      auth: { type: "none" },
    });
    const stamp = new Date().toISOString();
    const remoteDefinition = {
      id: "remote-image",
      ownerId: "remote-owner",
      ...definition("remote"),
      createdAt: stamp,
      updatedAt: stamp,
      versions: [],
    };
    manager.fakeConfigure("owner", {
      private: false,
      branches: {
        main: {
          revision: "remote-revision",
          files: serializeCatalog([remoteDefinition], { buildMode: "local" }),
        },
      },
    });

    failNext = true;
    await expect(
      manager.sync("owner", catalog, { direction: "pull" }),
    ).rejects.toThrow("injected post-import persistence failure");
    const imported = catalog.list("owner", false)[0]!;
    const importedId = imported.id;
    expect(imported.gitRecovery).toEqual({
      connectionId: connection.id,
      remoteId: "remote-image",
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const restartedCatalog = new ImageCatalogManager(catalogDirectory);
    await restartedCatalog.init();
    expect(restartedCatalog.list("owner", false)[0]!.gitRecovery).toEqual(
      imported.gitRecovery,
    );
    const retry = await manager.sync("owner", restartedCatalog, {
      direction: "pull",
    });

    expect(retry.imported).toEqual([importedId]);
    expect(retry.conflicts).toEqual([]);
    expect(restartedCatalog.list("owner", false)).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(catalogDirectory, { recursive: true, force: true });
  }
});

test("hierarchical image catalogs expose inherited images read-only and descendant images manageable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-image-hierarchy-"));
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const global = await catalog.create("owner", definition("global"));
    const ancestor = await catalog.createForGroup(
      "owner",
      "ancestor",
      definition("ancestor"),
    );
    const own = await catalog.createForGroup("owner", "own", definition("own"));
    const descendant = await catalog.createForGroup(
      "owner",
      "descendant",
      definition("descendant"),
    );
    await catalog.createForGroup("owner", "sibling", definition("sibling"));
    await catalog.createForGroup("other-owner", "own", definition("foreign"));

    const visible = catalog.listForGroupHierarchy(
      "owner",
      ["ancestor", "own", "descendant"],
      ["own", "descendant"],
    );
    expect(visible.map((item) => item.id)).toEqual([
      global.id,
      ancestor.id,
      own.id,
      descendant.id,
    ]);
    expect(
      visible.find((item) => item.id === global.id)?.access.manageable,
    ).toBe(false);
    expect(
      visible.find((item) => item.id === ancestor.id)?.access.manageable,
    ).toBe(false);
    expect(visible.find((item) => item.id === own.id)?.access.manageable).toBe(
      true,
    );
    expect(
      visible.find((item) => item.id === descendant.id)?.access.manageable,
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
