import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
import {
  createTestUser,
  deleteTestUser,
  type CreatedUser,
} from "../helpers/test-users";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMPTY_AUTH = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};
const PAT = "github_pat_FAKE_REPOSITORY_ONLY_DO_NOT_LOG_123456789";
async function createDefinition(ctx: APIRequestContext, name: string) {
  const response = await ctx.post("/api/image-catalog/definitions", {
    data: {
      name,
      description: "Git recovery acceptance image",
      baseImage: "agentor-worker:approved-test",
      dockerfileFragment:
        "RUN apt-get update && apt-get install -y jq\nCOPY config/tool.json /opt/tool.json",
      contextFiles: [
        {
          path: "config/tool.json",
          contentBase64: Buffer.from('{"safe":true}').toString("base64"),
        },
      ],
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function createPluginDefinition(ctx: APIRequestContext, suffix: string) {
  const response = await ctx.post("/api/plugins/definitions", {
    data: {
      scope: "owner",
      manifest: {
        schemaVersion: 1,
        name: `Git plugin ${suffix}`,
        slug: `git-plugin-${suffix}`.toLowerCase(),
        description: "Credential-free Git recovery acceptance plugin",
        version: "1.0.0",
        lifecycle: {
          start: {
            argv: ["sh", "-c", "exec sleep 3600"],
            mode: "background",
          },
          stop: { argv: ["true"] },
        },
        documentation: {
          markdown: "# Git plugin\n\nRecovered technical documentation.\n",
          skillMarkdown:
            "Use this plugin only when its installed capability is relevant.\n",
        },
        iconSvg:
          '<svg viewBox="0 0 24 24"><path d="M1 1L2 2"/></svg>',
      },
    },
  });
  const payload = await response.text();
  expect(response.status(), payload).toBe(201);
  return JSON.parse(payload);
}

test.describe
  .serial("Git-backed custom image catalog and disaster recovery", () => {
  let user: CreatedUser, ctx: APIRequestContext, anonymous: APIRequestContext;
  test.beforeAll(async () => {
    user = await createTestUser("Git Image Catalog Owner");
    ctx = await playwrightRequest.newContext(EMPTY_AUTH);
    anonymous = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (await new ApiClient(ctx).signInEmail(user.email, user.password)).status,
    ).toBe(200);
  });
  test.afterAll(async () => {
    await ctx?.dispose();
    await anonymous?.dispose();
    if (user) await deleteTestUser(user.id).catch(() => {});
  });

  test("all Git catalog APIs require authentication and publish a versioned, credential-free format", async () => {
    expect(
      (await anonymous.get("/api/image-catalog/git/format")).status(),
    ).toBe(401);
    expect(
      (await anonymous.get("/api/image-catalog/git/connection")).status(),
    ).toBe(401);
    expect(
      (
        await anonymous.post("/api/image-catalog/git/sync", {
          data: { direction: "push" },
        })
      ).status(),
    ).toBe(401);
    const formatResponse = await ctx.get("/api/image-catalog/git/format");
    expect(formatResponse.status()).toBe(200);
    const format = await formatResponse.json();
    expect(format).toMatchObject({
      version: 2,
      layout: {
        manifest: ".agentor/image-catalog.v2.json",
        dockerfile: expect.stringContaining("Dockerfile"),
        metadata: expect.stringContaining("metadata.json"),
        context: expect.stringContaining("context"),
      },
    });
    expect(JSON.stringify(format)).toContain("separate from workspace backups");
    expect(JSON.stringify(format)).not.toMatch(/token|credential value/i);
  });

  test("private fake GitHub connection encrypts a fine-grained PAT and never returns it", async () => {
    const response = await ctx.put("/api/image-catalog/git/connection", {
      data: {
        provider: "fake",
        repository: `agentor-tests/private-${Date.now()}`,
        visibility: "private",
        defaultBranch: "main",
        workflow: "direct",
        buildMode: "local",
        publishGhcr: true,
        auth: { type: "pat", token: PAT },
      },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      provider: "fake",
      visibility: "private",
      credential: { type: "pat", configured: true, shortLived: false },
    });
    expect(JSON.stringify(body)).not.toContain(PAT);
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|\biv\b|\btag\b/);
    const status = await ctx.get("/api/image-catalog/git/connection");
    expect(JSON.stringify(await status.json())).not.toContain(PAT);
    expect(
      (
        await ctx.put("/api/image-catalog/git/fake/repository", {
          data: { private: true, branches: {}, pullRequests: [] },
        })
      ).status(),
    ).toBe(200);
    const other = await createTestUser("Git Catalog Isolated User"),
      otherCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    try {
      expect(
        (await new ApiClient(otherCtx).signInEmail(other.email, other.password))
          .status,
      ).toBe(200);
      expect(
        await (await otherCtx.get("/api/image-catalog/git/connection")).json(),
      ).toEqual({ connected: false });
      expect(
        (await otherCtx.get("/api/image-catalog/git/fake/repository")).status(),
      ).toBe(404);
    } finally {
      await otherCtx.dispose();
      await deleteTestUser(other.id);
    }
  });

  test("sync writes Dockerfile, metadata, context, digests, local/Actions and GHCR metadata without secrets", async () => {
    const definition = await createDefinition(ctx, `git-primary-${Date.now()}`);
    const plugin = await createPluginDefinition(ctx, String(Date.now()));
    const build = await ctx.post(
      `/api/image-catalog/definitions/${definition.id}/builds`,
      { data: { builder: "fake", fakeDurationMs: 100 } },
    );
    expect(build.status()).toBe(202);
    const buildId = (await build.json()).id;
    let completed: any;
    for (let i = 0; i < 40; i++) {
      const response = await ctx.get(`/api/image-builds/${buildId}`);
      completed = await response.json();
      if (completed.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(completed.status).toBe("succeeded");
    const mismatched = await ctx.post("/api/image-catalog/git/sync", {
      data: {
        direction: "push",
        workflow: "direct",
        ghcrByDigest: {
          [completed.digest]: `ghcr.io/agentor-tests/tool@sha256:${"0".repeat(64)}`,
        },
      },
    });
    expect(mismatched.status()).toBe(400);
    const sync = await ctx.post("/api/image-catalog/git/sync", {
      data: {
        direction: "push",
        workflow: "direct",
        ghcrByDigest: {
          [completed.digest]: `ghcr.io/agentor-tests/tool@${completed.digest}`,
        },
      },
    });
    expect(sync.status()).toBe(200);
    expect(await sync.json()).toMatchObject({
      written: true,
      branch: "main",
      conflicts: [],
    });
    const repository = await (
      await ctx.get("/api/image-catalog/git/fake/repository")
    ).json();
    const files = repository.branches.main.files;
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        ".agentor/image-catalog.v2.json",
        ".agentor/plugin-catalog.v1.json",
        `images/${definition.id}/Dockerfile`,
        `images/${definition.id}/metadata.json`,
        `images/${definition.id}/context/config/tool.json`,
        `plugins/${plugin.id}/manifest.json`,
        `plugins/${plugin.id}/scripts/start.json`,
        `plugins/${plugin.id}/README.md`,
        `plugins/${plugin.id}/SKILL.md`,
        `plugins/${plugin.id}/icon.svg`,
      ]),
    );
    const manifest = JSON.parse(files[".agentor/image-catalog.v2.json"]);
    expect(manifest).toMatchObject({
      version: 2,
      schema: expect.stringContaining("/image-catalog/v2"),
    });
    const entry = manifest.entries.find(
      (item: any) => item.id === definition.id,
    );
    expect(entry.build.mode).toBe("local");
    expect(entry.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          digest: completed.digest,
          ghcr: {
            reference: `ghcr.io/agentor-tests/tool@${completed.digest}`,
            digest: completed.digest,
          },
        }),
      ]),
    );
    expect(JSON.stringify(repository)).not.toContain(PAT);

    // The repository is a recovery source, not a mirror that deletes local
    // state. A recovered reusable plugin retains its durable catalog identity:
    // image composition and portable worker reconstruction reference plugin
    // definition IDs, so minting a local replacement ID would make those
    // references impossible to resolve faithfully after recovery.
    expect(
      (await ctx.delete(`/api/plugins/definitions/${plugin.id}`)).status(),
    ).toBe(204);
    const pull = await ctx.post("/api/image-catalog/git/sync", {
      data: { direction: "pull" },
    });
    expect(pull.status()).toBe(200);
    const pulled = await pull.json();
    expect(pulled.importedPlugins).toHaveLength(1);
    expect(pulled.importedPlugins[0]).toBe(plugin.id);
    const recoveredPlugins = await (
      await ctx.get("/api/plugins/definitions")
    ).json();
    expect(recoveredPlugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pulled.importedPlugins[0],
          scope: "owner",
          name: plugin.name,
        }),
      ]),
    );
  });

  test("branch and pull-request workflow returns review metadata instead of updating the default branch", async () => {
    const before = await (
      await ctx.get("/api/image-catalog/git/fake/repository")
    ).json();
    const mainRevision = before.branches.main.revision;
    const response = await ctx.post("/api/image-catalog/git/sync", {
      data: {
        direction: "push",
        workflow: "pull-request",
        branch: `agentor/review-${Date.now()}`,
        message: "Review catalog update",
      },
    });
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      written: true,
      branch: expect.stringMatching(/^agentor\/review-/),
      pullRequest: {
        number: 1,
        state: "open",
        url: expect.stringContaining("/pull/"),
      },
    });
    const after = await (
      await ctx.get("/api/image-catalog/git/fake/repository")
    ).json();
    expect(after.branches.main.revision).toBe(mainRevision);
    expect(after.pullRequests[0]).toMatchObject({
      base: "main",
      head: result.branch,
    });
  });

  test("configured GitHub credentials are rejected before catalog content can be created", async () => {
    const definition = await createDefinition(
      ctx,
      `credential-redaction-${Date.now()}`,
    );
    const created = await ctx.get(
      `/api/image-catalog/definitions/${definition.id}`,
    );
    const body = await created.json();
    // A maliciously supplied definition cannot cause the repository credential to be committed.
    const leaked = await ctx.post("/api/image-catalog/definitions", {
      data: {
        name: `credential-${Date.now()}`,
        description: PAT,
        baseImage: "agentor-worker:approved-test",
        dockerfileFragment: "RUN true",
        contextFiles: [],
      },
    });
    expect(leaked.status()).toBe(400);
    expect(await leaked.text()).not.toContain(PAT);
    expect(body.id).toBe(definition.id);
  });

  test("remote races and divergent local edits produce conflicts and never silently overwrite either side", async () => {
    const repository = await (
        await ctx.get("/api/image-catalog/git/fake/repository")
      ).json(),
      files = structuredClone(repository.branches.main.files);
    const manifest = JSON.parse(files[".agentor/image-catalog.v2.json"]);
    manifest.generatedAt = new Date(Date.now() + 1000).toISOString();
    files[".agentor/image-catalog.v2.json"] =
      `${JSON.stringify(manifest, null, 2)}\n`;
    expect(
      (
        await ctx.put("/api/image-catalog/git/fake/remote-files", {
          data: { branch: "main", files },
        })
      ).status(),
    ).toBe(200);
    await createDefinition(ctx, `local-divergence-${Date.now()}`);
    const response = await ctx.post("/api/image-catalog/git/sync", {
      data: { direction: "push", workflow: "direct" },
    });
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.written).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    const after = await (
      await ctx.get("/api/image-catalog/git/fake/repository")
    ).json();
    expect(after.branches.main.files[".agentor/image-catalog.v2.json"]).toBe(
      files[".agentor/image-catalog.v2.json"],
    );
  });

  test("disconnect erases credentials without deleting the repo, and recovery imports only explicit copies", async () => {
    const before = await (
      await ctx.get("/api/image-catalog/git/fake/repository")
    ).json();
    const repository = (
      await (await ctx.get("/api/image-catalog/git/connection")).json()
    ).repository;
    const disconnected = await ctx.delete("/api/image-catalog/git/connection");
    expect(disconnected.status()).toBe(200);
    expect(await disconnected.json()).toEqual({
      disconnected: true,
      credentialErased: true,
      remoteRepositoryUnchanged: true,
    });
    expect(
      await (await ctx.get("/api/image-catalog/git/connection")).json(),
    ).toEqual({ connected: false });
    expect(
      (
        await ctx.put("/api/image-catalog/git/connection", {
          data: {
            provider: "fake",
            repository,
            visibility: "private",
            defaultBranch: "main",
            workflow: "direct",
            auth: { type: "pat", token: PAT },
          },
        })
      ).status(),
    ).toBe(200);
    // Fake repositories model the external service and survive local disconnect/reinstall.
    const stillThere = await (
      await ctx.get("/api/image-catalog/git/fake/repository")
    ).json();
    expect(stillThere.branches.main.revision).toBe(
      before.branches.main.revision,
    );
    const first = await ctx.post("/api/image-catalog/git/recovery", {
      data: {},
    });
    expect(first.status()).toBe(200);
    const conflict = await first.json();
    expect(conflict.conflicts.length).toBeGreaterThan(0);
    expect(conflict.imported).toHaveLength(0);
    const copied = await ctx.post("/api/image-catalog/git/recovery", {
      data: { resolution: "remote-copy" },
    });
    expect(copied.status()).toBe(200);
    const recovered = await copied.json();
    expect(recovered.imported.length).toBeGreaterThan(0);
    expect(recovered.recovery).toMatchObject({
      state: expect.stringMatching(/recovered|conflict/),
      catalogEntries: expect.any(Number),
      imageDigests: expect.any(Number),
      note: expect.stringContaining("independently of workspace backups"),
    });
    const recoveredDefinitions = await Promise.all(
      recovered.imported.map(async (id: string) =>
        (await ctx.get(`/api/image-catalog/definitions/${id}`)).json(),
      ),
    );
    expect(
      recoveredDefinitions.some((definition: any) =>
        definition.versions.some(
          (version: any) =>
            version.recovered === true &&
            version.digest &&
            version.runtimeImage?.startsWith("ghcr.io/") &&
            version.runtimeImage.endsWith(`@${version.digest}`),
        ),
      ),
    ).toBe(true);
  });

  test("public repositories need no token and GitHub App configuration advertises short-lived credentials", async () => {
    expect(
      (await ctx.delete("/api/image-catalog/git/connection")).status(),
    ).toBe(200);
    const publicRepo = `agentor-tests/public-${Date.now()}`;
    const publicConnection = await ctx.put(
      "/api/image-catalog/git/connection",
      {
        data: {
          provider: "fake",
          repository: publicRepo,
          visibility: "public",
          auth: { type: "none" },
          workflow: "direct",
          buildMode: "github-actions",
          actionsWorkflow: ".github/workflows/agentor-images.yml",
        },
      },
    );
    expect(publicConnection.status()).toBe(200);
    expect(await publicConnection.json()).toMatchObject({
      visibility: "public",
      credential: { type: "none", configured: false },
    });
    expect(
      (
        await ctx.put("/api/image-catalog/git/fake/repository", {
          data: { private: false, branches: {}, pullRequests: [] },
        })
      ).status(),
    ).toBe(200);
    const actionsSync = await ctx.post("/api/image-catalog/git/sync", {
      data: { direction: "push" },
    });
    expect(actionsSync.status()).toBe(200);
    expect(await actionsSync.json()).toMatchObject({
      workflowDispatched: true,
    });
    const actionsRepository = await (
      await ctx.get("/api/image-catalog/git/fake/repository")
    ).json();
    expect(actionsRepository.workflowDispatches).toEqual(
      expect.arrayContaining([
        { workflow: ".github/workflows/agentor-images.yml", ref: "main" },
      ]),
    );
    expect(
      (await ctx.delete("/api/image-catalog/git/connection")).status(),
    ).toBe(200);
    const app = await ctx.put("/api/image-catalog/git/connection", {
      data: {
        provider: "github",
        repository: "agentor-tests/app-owned",
        visibility: "private",
        auth: { type: "github-app", appId: "1234", installationId: "5678" },
        buildMode: "github-actions",
        actionsWorkflow: ".github/workflows/build-images.yml",
        publishGhcr: true,
      },
    });
    expect(app.status()).toBe(200);
    const body = await app.json();
    expect(body).toMatchObject({
      provider: "github",
      buildMode: "github-actions",
      actionsWorkflow: ".github/workflows/build-images.yml",
      publishGhcr: true,
      credential: { type: "github-app", configured: true, shortLived: true },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private.?key|installation.?token/i,
    );
  });
});
