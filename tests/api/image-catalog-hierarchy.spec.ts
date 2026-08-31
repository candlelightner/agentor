import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  ImageCatalogManager,
  renderDefinitionDockerfile,
} from "../../orchestrator/server/utils/image-catalog";
import { GitImageCatalogManager } from "../../orchestrator/server/utils/git-image-manager";
import { GitImageStore } from "../../orchestrator/server/utils/git-image-store";
import {
  parseCatalog,
  serializeCatalog,
} from "../../orchestrator/server/utils/git-image-format";
import { serializePluginCatalog } from "../../orchestrator/server/utils/git-plugin-format";
import { PluginDefinitionStore } from "../../orchestrator/server/utils/plugin-definition-store";
import {
  pluginDefinitionHash,
  validatePluginManifest,
} from "../../orchestrator/server/utils/plugin-manifest";
import { withDeletedOwnerCleanupFence } from "../../orchestrator/server/utils/orphan-sweeper";

const definition = (name: string) => ({
  name,
  description: name,
  baseImage: "agentor-worker:approved-test",
  dockerfileFragment: "RUN true",
  contextFiles: [],
});

test("Git catalog parses legacy v1 fragments and v2 structured provisioning", () => {
  const legacyHash = createHash("sha256")
    .update(
      '{"baseImage":"agentor-worker:approved-test","contextFiles":[],"description":"","dockerfileFragment":"RUN true","name":"legacy"}',
    )
    .digest("hex");
  const legacy = {
    ".agentor/image-catalog.v1.json": JSON.stringify({
      schema: "https://agentor.dev/schemas/image-catalog/v1",
      version: 1,
      entries: [
        {
          id: "legacy",
          name: "legacy",
          description: "",
          baseImage: "agentor-worker:approved-test",
          dockerfilePath: "images/legacy/Dockerfile",
          metadataPath: "images/legacy/metadata.json",
          contextPrefix: "images/legacy/context/",
          definitionHash: legacyHash,
        },
      ],
    }),
    "images/legacy/Dockerfile": "FROM agentor-worker:approved-test\nRUN true\n",
    "images/legacy/metadata.json": JSON.stringify({
      name: "legacy",
      baseImage: "agentor-worker:approved-test",
    }),
  };
  // The hash protects the imported v1 representation exactly as it was stored.
  expect(parseCatalog(legacy)).toMatchObject([
    { definition: { dockerfileFragment: "RUN true" } },
  ]);
  const v2 = serializeCatalog(
    [
      {
        id: "structured",
        ownerId: "owner",
        ...definition("structured"),
        dockerfileFragment: "",
        provisioning: [
          { type: "command" as const, command: "mkdir -p /opt/example" },
        ],
        contextFiles: [
          {
            path: "setup.sh",
            contentBase64: Buffer.from("echo setup").toString("base64"),
            role: "script" as const,
            destination: "/opt/agentor-context/setup.sh",
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        versions: [],
      },
    ],
    { buildMode: "local" },
  );
  expect(JSON.parse(v2[".agentor/image-catalog.v2.json"]!)).toMatchObject({
    schema: "https://agentor.dev/schemas/image-catalog/v2",
    version: 2,
  });
  expect(parseCatalog(v2)).toMatchObject([
    {
      definition: {
        provisioning: [{ type: "command" }],
        contextFiles: [
          { role: "script", destination: "/opt/agentor-context/setup.sh" },
        ],
      },
    },
  ]);
  const secretDefinition = {
    id: "secret",
    ownerId: "owner",
    ...definition("secret"),
    description: "TOKEN=github_pat_abcdefghijklmnopqrstuvwxyz",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    versions: [],
  };
  expect(() =>
    serializeCatalog([secretDefinition], { buildMode: "local" }),
  ).toThrow("secret values");
});

test("legacy v1 Git catalog pulls remain idempotent after current-format recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-v1-pull-"));
  const catalogDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-v1-catalog-"),
  );
  try {
    const manager = new GitImageCatalogManager(new GitImageStore(directory));
    const catalog = new ImageCatalogManager(catalogDirectory);
    await Promise.all([manager.init(), catalog.init()]);
    await manager.connect("owner", {
      provider: "fake",
      repository: "owner/v1-pull",
      visibility: "public",
      workflow: "direct",
      auth: { type: "none" },
    });
    const legacyHash = createHash("sha256")
      .update(
        '{"baseImage":"agentor-worker:approved-test","contextFiles":[],"description":"","dockerfileFragment":"RUN true","name":"legacy"}',
      )
      .digest("hex");
    manager.fakeConfigure("owner", {
      private: false,
      branches: {
        main: {
          revision: "legacy-revision",
          files: {
            ".agentor/image-catalog.v1.json": JSON.stringify({
              schema: "https://agentor.dev/schemas/image-catalog/v1",
              version: 1,
              entries: [
                {
                  id: "legacy",
                  name: "legacy",
                  description: "",
                  baseImage: "agentor-worker:approved-test",
                  dockerfilePath: "images/legacy/Dockerfile",
                  metadataPath: "images/legacy/metadata.json",
                  contextPrefix: "images/legacy/context/",
                  definitionHash: legacyHash,
                },
              ],
            }),
            "images/legacy/Dockerfile":
              "FROM agentor-worker:approved-test\nRUN true\n",
            "images/legacy/metadata.json": JSON.stringify({
              name: "legacy",
              baseImage: "agentor-worker:approved-test",
            }),
          },
        },
      },
    });
    await expect(
      manager.sync("owner", catalog, { direction: "pull" }),
    ).resolves.toMatchObject({ conflicts: [] });
    await expect(
      manager.sync("owner", catalog, { direction: "pull" }),
    ).resolves.toMatchObject({ imported: [], conflicts: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(catalogDirectory, { recursive: true, force: true });
  }
});

test("Git plugin pull rejects group definitions not owned by the importer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-plugin-group-"));
  const catalogDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-plugin-catalog-"),
  );
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-plugin-store-"),
  );
  try {
    const manager = new GitImageCatalogManager(
      new GitImageStore(directory),
      () => true,
      () => false,
    );
    const catalog = new ImageCatalogManager(catalogDirectory);
    const plugins = new PluginDefinitionStore(pluginDirectory);
    await Promise.all([manager.init(), catalog.init(), plugins.init()]);
    await manager.connect("owner", {
      provider: "fake",
      repository: "owner/plugin-group",
      visibility: "public",
      workflow: "direct",
      auth: { type: "none" },
    });
    const manifest: any = validatePluginManifest({
      schemaVersion: 1,
      name: "Scoped",
      slug: "scoped",
      description: "",
      version: "1.0.0",
      lifecycle: { start: { argv: ["echo", "start"] } },
    });
    const remotePlugin: any = {
      schemaVersion: 1,
      id: "foreign-group-plugin",
      userId: "remote-owner",
      scope: "group",
      groupId: "foreign-group",
      name: manifest.name,
      builtIn: false,
      manifest,
      definitionHash: pluginDefinitionHash(manifest),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    manager.fakeConfigure("owner", {
      private: false,
      branches: {
        main: {
          revision: "plugin-revision",
          files: {
            ...serializeCatalog([], { buildMode: "local" }),
            ...serializePluginCatalog([remotePlugin]),
          },
        },
      },
    });
    await expect(
      manager.sync("owner", catalog, { direction: "pull" }, plugins),
    ).rejects.toThrow("unknown group");
    expect(plugins.listForOwner("owner")).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(catalogDirectory, { recursive: true, force: true });
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

test("Git recovery preserves plugin ids referenced by composed image definitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-git-plugin-image-"));
  const catalogDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-plugin-image-catalog-"),
  );
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "agentor-git-plugin-image-store-"),
  );
  try {
    const manager = new GitImageCatalogManager(new GitImageStore(directory));
    const catalog = new ImageCatalogManager(catalogDirectory);
    const plugins = new PluginDefinitionStore(pluginDirectory);
    await Promise.all([manager.init(), catalog.init(), plugins.init()]);
    await manager.connect("owner", {
      provider: "fake",
      repository: "owner/plugin-image",
      visibility: "public",
      workflow: "direct",
      auth: { type: "none" },
    });
    const manifest = validatePluginManifest({
      schemaVersion: 1,
      name: "Recovered build tool",
      slug: "recovered-build-tool",
      description: "",
      version: "1.0.0",
      lifecycle: { start: { argv: ["true"] } },
      imageBuild: {
        provisioning: [{ type: "packages", manager: "apt", packages: ["jq"] }],
      },
    });
    const remotePlugin: any = {
      schemaVersion: 1,
      id: "recovered-build-plugin",
      userId: "remote-owner",
      scope: "owner",
      name: manifest.name,
      builtIn: false,
      manifest,
      definitionHash: pluginDefinitionHash(manifest),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const remoteDefinition: any = {
      id: "composed-image",
      ownerId: "remote-owner",
      ...definition("composed-image"),
      provisioningMode: "safe",
      pluginComposition: [
        { definitionId: remotePlugin.id, validation: "optional" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      versions: [],
    };
    manager.fakeConfigure("owner", {
      private: false,
      branches: {
        main: {
          revision: "plugin-image-revision",
          files: {
            ...serializeCatalog([remoteDefinition], { buildMode: "local" }),
            ...serializePluginCatalog([remotePlugin]),
          },
        },
      },
    });
    await expect(
      manager.sync("owner", catalog, { direction: "pull" }, plugins),
    ).resolves.toMatchObject({ conflicts: [] });
    expect(plugins.getById(remotePlugin.id)).toMatchObject({
      userId: "owner",
      definitionHash: remotePlugin.definitionHash,
    });
    expect(catalog.list("owner", false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginComposition: [
            { definitionId: remotePlugin.id, validation: "optional" },
          ],
        }),
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(catalogDirectory, { recursive: true, force: true });
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

test("Git export renders resolved plugin imageBuild steps while recovery keeps the stable plugin selection", () => {
  const plugin: any = {
    definitionId: "stable-plugin-id",
    validation: "required",
    name: "Git build plugin",
    definitionHash: "a".repeat(64),
    provisioning: [{ type: "packages", manager: "apt", packages: ["jq"] }],
    contextFiles: [
      {
        path: "plugins/stable-plugin-id/install.sh",
        contentBase64: Buffer.from("echo plugin").toString("base64"),
        role: "script",
        destination: "/opt/agentor-context/plugins/install.sh",
      },
    ],
  };
  const exported = serializeCatalog(
    [
      {
        id: "plugin-dockerfile",
        ownerId: "owner",
        ...definition("plugin-dockerfile"),
        provisioningMode: "safe" as const,
        pluginComposition: [
          {
            definitionId: plugin.definitionId,
            validation: "required" as const,
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        versions: [],
      },
    ],
    {
      buildMode: "github-actions",
      pluginBuildsByDefinitionId: { "plugin-dockerfile": [plugin] },
    },
  );
  expect(exported["images/plugin-dockerfile/Dockerfile"]).toContain(
    "apt-get install -y --no-install-recommends jq",
  );
  expect(
    exported[
      "images/plugin-dockerfile/context/plugins/stable-plugin-id/install.sh"
    ],
  ).toBe(plugin.contextFiles[0].contentBase64);
  expect(parseCatalog(exported)).toMatchObject([
    {
      definition: {
        pluginComposition: [
          { definitionId: "stable-plugin-id", validation: "required" },
        ],
      },
    },
  ]);
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
    const created = await catalog.create("owner", {
      ...definition("controlled-terminal"),
      baseImage: "agentor-worker:approved-default",
    });
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

test("image catalog normalizes legacy definitions to Safe mode and ready compatibility", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-image-legacy-safe-"));
  try {
    const stamp = new Date().toISOString();
    await writeFile(
      join(directory, "image-catalog.json"),
      JSON.stringify({
        definitions: [
          {
            id: "legacy-definition",
            ownerId: "owner",
            ...definition("legacy-safe"),
            createdAt: stamp,
            updatedAt: stamp,
            versions: [
              {
                version: "v1",
                digest: `sha256:${"a".repeat(64)}`,
                baseImage: "agentor-worker:approved-test",
                createdAt: stamp,
              },
            ],
          },
        ],
        builds: [],
        userDefaults: {},
        faults: {},
        deletions: [],
      }),
    );
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const legacy = catalog.list("owner", false)[0]!;
    expect(legacy.provisioningMode).toBe("safe");
    expect(legacy.versions[0]).toMatchObject({
      readiness: "ready",
      compatibility: { state: "passed", coreState: "passed" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Safe provisioning returns an actionable preflight diagnostic without starting Docker", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-image-safe-diagnostic-"),
  );
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    let rejected: any;
    try {
      await catalog.create("owner", {
        ...definition("safe-rejection"),
        dockerfileFragment: "",
        provisioning: [{ type: "command", command: "echo one\necho two" }],
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({
      statusCode: 400,
      code: "safe-mode-blocked",
    });
    expect(rejected.diagnostic).toMatchObject({
      code: "safe-mode-blocked",
      blockedField: "provisioning[0]",
      blockedStep: { index: 0, type: "command" },
      dockerAttempted: false,
      advancedModeAvailable: true,
    });
    expect(rejected.diagnostic.reason).toContain("Agentor");
    expect(rejected.diagnostic.remediation).toContain("structured");
    expect(rejected.diagnostic.advancedModeWarning).toContain(
      "controlled Docker/BuildKit",
    );
    expect(catalog.publicBuilds("owner", false)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Advanced provisioning accepts shell recipes but retains base, Dockerfile, and secret boundaries", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-image-advanced-boundary-"),
  );
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const advanced = await catalog.create("owner", {
      ...definition("advanced-recipe"),
      dockerfileFragment: "",
      provisioningMode: "advanced",
      provisioning: [
        {
          type: "command",
          command:
            "set -eux\nprintf '%s\\n' experimental > /tmp/agentor-recipe\nrm -f /tmp/agentor-recipe",
        },
      ],
    });
    expect(advanced).toMatchObject({ provisioningMode: "advanced" });
    const rendered = renderDefinitionDockerfile(advanced);
    expect(rendered.match(/^USER .+$/gm)).toEqual(["USER root", "USER agent"]);
    expect(rendered).toContain("\\nrm -f /tmp/agentor-recipe");
    for (const invalid of [
      { baseImage: "ubuntu:latest" },
      { dockerfileFragment: "FROM ubuntu:latest" },
      {
        dockerfileFragment:
          "COPY --from=ubuntu:latest /etc/os-release /tmp/external-base",
      },
      {
        provisioning: [
          {
            type: "command",
            command: "echo IMAGE_BUILD_MUST_NEVER_LEAK_TOKEN",
          },
        ],
      },
    ]) {
      await expect(
        catalog.create("owner", {
          ...definition(`advanced-boundary-${Math.random()}`),
          dockerfileFragment: "",
          provisioningMode: "advanced",
          ...invalid,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fake builds are asynchronous, idempotent by request id, and retain distinct compatibility outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-image-outcomes-"));
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const created = await catalog.create("owner", definition("outcomes"));
    const startedAt = Date.now();
    const accepted = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 800,
      requestId: "outcomes-request-1",
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(accepted).toMatchObject({
      status: expect.stringMatching(/queued|running/),
      operation: "build",
      requestId: "outcomes-request-1",
      dockerAttempted: false,
    });
    const retried = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 800,
      requestId: "outcomes-request-1",
    });
    expect(retried.id).toBe(accepted.id);
    expect(
      catalog
        .publicBuilds("owner", false)
        .filter((build) => build.requestId === "outcomes-request-1"),
    ).toHaveLength(1);
    await expect(
      catalog.startBuild(created.id, "owner", false, {
        builder: "fake",
        baseImage: "agentor-worker:approved-other",
        requestId: "outcomes-request-1",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect
      .poll(() => catalog.publicBuild(accepted.id, "owner", false).outcome)
      .toBe("ready");
    await catalog.update(created.id, "owner", false, {
      ...definition("outcomes"),
      description: "edited after the original request was accepted",
    });
    const completedRetry = await catalog.startBuild(
      created.id,
      "owner",
      false,
      {
        builder: "fake",
        fakeDurationMs: 800,
        requestId: "outcomes-request-1",
      },
    );
    expect(completedRetry.id).toBe(accepted.id);

    const warning = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 100,
      fakeValidationOutcome: "warnings",
    });
    const incompatible = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 100,
      fakeValidationOutcome: "incompatible",
    });
    const unavailable = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 100,
      fakeValidationOutcome: "unavailable",
    });
    await expect
      .poll(() => catalog.publicBuild(warning.id, "owner", false).outcome)
      .toBe("ready-with-warnings");
    await expect
      .poll(() => catalog.publicBuild(incompatible.id, "owner", false).outcome)
      .toBe("built-incompatible");
    await expect
      .poll(() => catalog.publicBuild(unavailable.id, "owner", false).outcome)
      .toBe("validation-unavailable");
    expect(
      catalog.publicBuild(warning.id, "owner", false).compatibility,
    ).toMatchObject({ state: "warnings" });
    expect(catalog.publicBuild(incompatible.id, "owner", false)).toMatchObject({
      status: "succeeded",
      imageCreated: false,
      validationState: "incompatible",
    });
    expect(catalog.publicBuild(unavailable.id, "owner", false)).toMatchObject({
      status: "failed",
      imageCreated: false,
      validationState: "unavailable",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("incompatible and validation-unavailable versions cannot be promoted, selected, or made defaults", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-image-readiness-gates-"),
  );
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const created = await catalog.create(
      "owner",
      definition("readiness-gates"),
    );
    const incompatible = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 100,
      fakeValidationOutcome: "incompatible",
    });
    const unavailable = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 100,
      fakeValidationOutcome: "unavailable",
    });
    await expect
      .poll(() => catalog.publicBuild(incompatible.id, "owner", false).outcome)
      .toBe("built-incompatible");
    await expect
      .poll(() => catalog.publicBuild(unavailable.id, "owner", false).outcome)
      .toBe("validation-unavailable");
    for (const build of [incompatible, unavailable]) {
      const result = catalog.publicBuild(build.id, "owner", false);
      await expect(
        catalog.promote(created.id, result.version!, "owner", false),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        catalog.setUserDefault("owner", created.id, result.version!),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(() =>
        catalog.resolveSelection("owner", created.id, result.version!),
      ).toThrow(/compatibility|incompatible/i);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("build logs paginate and cancellation is prompt and idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-image-cancel-page-"));
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const created = await catalog.create("owner", definition("cancel-page"));
    const completed = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 100,
    });
    await expect
      .poll(() => catalog.publicBuild(completed.id, "owner", false).status)
      .toBe("succeeded");
    const firstPage = catalog.logPage(completed.id, "owner", false, {
      after: 0,
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      after: 0,
      entries: [expect.any(String)],
      nextAfter: 1,
    });
    const secondPage = catalog.logPage(completed.id, "owner", false, {
      after: firstPage.nextCursor,
      limit: 1,
    });
    expect(secondPage.after).toBe(1);
    expect(secondPage.entries).not.toEqual(firstPage.entries);

    await catalog.setFault("owner", {
      failPhase: "building",
      message: "Authorization: Bearer abcdefghijklmnop",
    });
    const redactedFailure = await catalog.startBuild(
      created.id,
      "owner",
      false,
      { builder: "fake", fakeDurationMs: 100 },
    );
    await expect
      .poll(
        () =>
          catalog.publicBuild(redactedFailure.id, "owner", false).status,
      )
      .toBe("failed");
    const redactedLogs = catalog.logs(
      redactedFailure.id,
      "owner",
      false,
    );
    expect(redactedLogs).toContain("[redacted]");
    expect(redactedLogs).not.toContain("abcdefghijklmnop");

    const pending = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 10_000,
    });
    const cancelStartedAt = Date.now();
    const firstCancel = await catalog.cancelBuild(pending.id, "owner", false);
    expect(Date.now() - cancelStartedAt).toBeLessThan(500);
    const secondCancel = await catalog.cancelBuild(pending.id, "owner", false);
    expect(firstCancel).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
    });
    expect(secondCancel).toMatchObject({
      id: pending.id,
      status: "cancelled",
      outcome: "cancelled",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compatibility distinguishes Docker validator infrastructure failures from failed worker contract checks", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-image-validator-outcome-"),
  );
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const runtimeImage = {
      Id: `sha256:${"b".repeat(64)}`,
      Config: {
        User: "agent",
        WorkingDir: "/workspace",
        Entrypoint: ["/home/agent/entrypoint.sh"],
      },
    };
    const validation = async (docker: any) => {
      (catalog as any).docker = docker;
      const build: any = {
        id: `validator-${Math.random()}`,
        definitionId: "validator-definition",
        ownerId: "owner",
        status: "running",
        phase: "validating",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        logs: [],
        builder: "controlled",
      };
      const version: any = {
        version: "v1",
        digest: runtimeImage.Id,
        baseImage: "agentor-worker:approved-test",
        createdAt: new Date().toISOString(),
      };
      return (catalog as any).runCompatibilityValidation(
        build,
        version,
        { pluginComposition: [] },
        runtimeImage.Id,
        runtimeImage,
      );
    };

    for (const docker of [
      {
        getImage: () => ({ inspect: async () => runtimeImage }),
        createContainer: async () => {
          throw new Error("validator container creation failed");
        },
      },
      {
        getImage: () => ({ inspect: async () => runtimeImage }),
        createContainer: async () => ({
          start: async () => {
            throw new Error("validator container start failed");
          },
          remove: async () => undefined,
        }),
      },
    ]) {
      await expect(validation(docker)).resolves.toMatchObject({
        state: "unavailable",
        coreState: "unavailable",
        infrastructureError: expect.stringContaining("could not complete"),
      });
    }

    await expect(
      validation({
        getImage: () => ({ inspect: async () => runtimeImage }),
        createContainer: async () => ({
          start: async () => undefined,
          wait: async () => ({ StatusCode: 1 }),
          remove: async () => undefined,
        }),
      }),
    ).resolves.toMatchObject({
      state: "incompatible",
      coreState: "failed",
      requiredFailures: ["Agentor worker bootstrap contract"],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation during compatibility validation is prompt, durable, and retryable", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentor-image-validator-cancel-"),
  );
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const created = await catalog.create(
      "owner",
      definition("validator-cancel"),
    );
    const initial = await catalog.startBuild(created.id, "owner", false, {
      builder: "fake",
      fakeDurationMs: 100,
    });
    await expect
      .poll(() => catalog.publicBuild(initial.id, "owner", false).outcome)
      .toBe("ready");
    const version = catalog.definition(created.id, "owner", false).versions[0]!;
    version.artifactTag = "agentor-validator-cancel:test";
    version.readiness = "validation-unavailable";
    version.compatibility = {
      state: "unavailable",
      coreState: "unavailable",
      pluginState: "none",
      checks: [],
      requiredFailures: [],
      warnings: [],
    };

    let validatorStarted = false;
    let rejectWait: ((error: Error) => void) | undefined;
    (catalog as any).docker = {
      getImage: () => ({
        inspect: async () => ({
          Id: version.digest,
          Config: {
            User: "agent",
            WorkingDir: "/workspace",
            Entrypoint: ["/home/agent/entrypoint.sh"],
          },
        }),
      }),
      createContainer: async () => ({
        start: async () => {
          validatorStarted = true;
        },
        wait: () =>
          new Promise((_, reject) => {
            rejectWait = reject;
          }),
        kill: async () => rejectWait?.(new Error("validator cancelled")),
        remove: async () => undefined,
      }),
    };
    const retry = await catalog.startValidation(
      created.id,
      version.version,
      "owner",
      false,
      { requestId: "cancel-validation-1" },
    );
    await expect.poll(() => validatorStarted).toBe(true);
    await expect
      .poll(() => catalog.publicBuild(retry.id, "owner", false).phase)
      .toBe("validating");
    const startedAt = Date.now();
    const cancelled = await catalog.cancelBuild(retry.id, "owner", false);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      phase: "cancelled",
      outcome: "cancelled",
    });
    expect(
      catalog.definition(created.id, "owner", false).versions[0],
    ).toMatchObject({
      readiness: "validation-unavailable",
      compatibility: {
        state: "unavailable",
        infrastructureError: "Compatibility validation was cancelled.",
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
