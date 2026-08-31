import { test, expect, type Page } from "@playwright/test";
import { goToDashboard } from "../helpers/ui-helpers";
const definition = {
  id: "def-1",
  name: "Node tools",
  description: "Prebuilt tooling",
  baseImage: "agentor-worker:approved-latest",
  dockerfileFragment: "RUN npm i -g pnpm",
  contextFiles: [],
  versions: [
    {
      version: "v1",
      digest: "sha256:abc",
      baseImage: "agentor-worker:approved-latest",
      createdAt: "2026-01-01",
      promoted: false,
    },
  ],
};
const groupDefinition = {
  ...definition,
  id: "def-group-1",
  name: "Group-only tools",
  groupId: "group-1",
};
const compatibilityDefinitions = [
  {
    ...definition,
    id: "def-compat",
    name: "Compatibility outcomes",
    versions: [
      { ...definition.versions[0], version: "ready", readiness: "ready" },
      {
        ...definition.versions[0],
        version: "warn",
        readiness: "ready-with-warnings",
        warnings: ["Optional plugin is unavailable"],
      },
      {
        ...definition.versions[0],
        version: "incompatible",
        readiness: "built-incompatible",
        compatibility: {
          requiredChecks: [
            {
              id: "bootstrap",
              name: "Worker bootstrap",
              status: "failed",
              required: true,
              message: "Worker handshake did not complete",
            },
          ],
        },
      },
      {
        ...definition.versions[0],
        version: "unknown",
        readiness: "validation-unavailable",
      },
    ],
  },
];
async function mock(page: Page) {
  let buildStarted = false;
  await page.route("**/api/plugins/definitions", (r) =>
    r.fulfill({
      json: [
        {
          id: "plugin-build-tools",
          manifest: {
            name: "Build tools",
            description: "Install a reusable toolchain",
            imageBuild: {
              requiresAdvancedProvisioning: true,
              validation: { defaultRequired: false },
            },
          },
        },
      ],
    }),
  );
  await page.route("**/api/image-builds", (route) =>
    route.fulfill({
      json: buildStarted
        ? [
            {
              id: "build-1",
              definitionId: "def-1",
              status: "succeeded",
              phase: "complete",
              version: "v2",
              digest: "sha256:def",
            },
          ]
        : [],
    }),
  );
  await page.route("**/api/image-catalog/definitions", async (r) =>
    r.fulfill({
      status: r.request().method() === "POST" ? 201 : 200,
      json:
        r.request().method() === "POST"
          ? {
              ...definition,
              ...(await r.request().postDataJSON()),
              id: "def-2",
              versions: [],
            }
          : [definition, groupDefinition],
    }),
  );
  await page.route("**/api/worker-groups", (r) =>
    r.fulfill({
      json: [{ id: "group-1", name: "Evaluation team", workerIds: [] }],
    }),
  );
  await page.route("**/api/image-catalog/usage", (r) =>
    r.fulfill({
      json: { totalBytes: 1048576, partialBuildBytes: 0, definitions: [] },
    }),
  );
  await page.route("**/api/image-catalog/defaults/effective", (r) =>
    r.fulfill({ json: { source: "platform", version: null } }),
  );
  let gitConnected = false;
  await page.route("**/api/image-catalog/git/connection", async (r) => {
    if (r.request().method() === "PUT") gitConnected = true;
    if (r.request().method() === "DELETE") gitConnected = false;
    await r.fulfill({
      json: gitConnected
        ? {
            repository: "owner/images",
            workflow: "pull-request",
            buildMode: "local",
            credential: { type: "pat", configured: true, shortLived: false },
          }
        : { connected: false },
    });
  });
  await page.route("**/api/image-catalog/git/recovery", (r) =>
    r.fulfill({
      json: {
        state: "not-run",
        catalogEntries: 0,
        imageDigests: 0,
        note: "Workspace data is not included.",
      },
    }),
  );
  await page.route("**/api/image-catalog/git/sync", async (r) =>
    r.fulfill({
      json: {
        direction: (await r.request().postDataJSON()).direction,
        written: true,
        conflicts: [],
      },
    }),
  );
  await page.route("**/api/image-catalog/definitions/def-1/builds", (r) => {
    buildStarted = true;
    return r.fulfill({
      status: 202,
      json: {
        id: "build-1",
        definitionId: "def-1",
        status: "running",
        phase: "building",
      },
    });
  });
  await page.route("**/api/image-builds/build-1", (r) =>
    r.fulfill({
      json: {
        id: "build-1",
        definitionId: "def-1",
        status: "succeeded",
        phase: "complete",
        version: "v2",
        digest: "sha256:def",
      },
    }),
  );
  await page.route("**/api/image-builds/build-1/logs?**", (r) => {
    const url = new URL(r.request().url());
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("limit")).toBe("200");
    return r.fulfill({
      json: {
        entries: ["[builder] safe build log"],
        logs: "[builder] safe build log",
        after: 0,
        nextCursor: 1,
      },
    });
  });
  await page.route(
    "**/api/image-catalog/definitions/def-1/versions/v1/test-worker",
    (r) =>
      r.fulfill({
        status: 202,
        json: {
          id: "test-worker-job-1",
          definitionId: "def-1",
          operation: "test-worker",
          status: "queued",
          phase: "queued",
        },
      }),
  );
  let testWorkerPolls = 0;
  await page.route("**/api/image-builds/test-worker-job-1", (r) =>
    r.fulfill({
      json:
        ++testWorkerPolls > 1
          ? {
              id: "test-worker-job-1",
              status: "succeeded",
              phase: "completed",
              outcome: "test-worker-ready",
              workerId: "test-worker-1",
            }
          : {
              id: "test-worker-job-1",
              status: "running",
              phase: "creating-test-worker",
              operation: "test-worker",
            },
    }),
  );
  for (const pattern of ["**/promote", "**/rollback", "**/defaults"])
    await page.route(pattern, (r) =>
      r.fulfill({
        json: { ok: true },
      }),
    );
}
async function open(page: Page) {
  await goToDashboard(page);
  await page.getByRole("button", { name: /image catalog/i }).click();
  return page.locator('[data-testid="image-catalog"]');
}
test.beforeEach(async ({ page }) => mock(page));
test("creates a constrained definition and inspects asynchronous logs on demand", async ({
  page,
}) => {
  const m = await open(page);
  await expect(m).toContainText("Storage: 1.0 MB");
  await m.getByPlaceholder("Definition name").fill("Python tools");
  await m.getByPlaceholder("Description").fill("Prebuilt");
  await m
    .getByRole("button", { name: "Create image definition" })
    .click();
  await m.getByRole("button", { name: "Build", exact: true }).first().click();
  const build = m.locator('[data-testid="image-build"]');
  await expect(build).not.toContainText("safe build log");
  await build.getByRole("button", { name: "Show logs for build-1" }).click();
  await expect(build).toContainText("safe build log");
});
test("offers structured package, command, and context-script provisioning", async ({
  page,
}) => {
  const m = await open(page);
  await expect(m.getByTestId("image-provisioning")).toContainText(
    "server-rendered",
  );
  await m
    .getByPlaceholder("Pinned packages (space separated)")
    .fill("jq=1.7.1-3");
  await m.getByPlaceholder("Pinned packages (space separated)").press("Tab");
  await m
    .getByPlaceholder("Optional shell setup command")
    .fill("mkdir -p /opt/example");
  await m.getByPlaceholder("Optional shell setup command").press("Tab");
  await m
    .locator('input[type="file"]')
    .setInputFiles({
      name: "setup.sh",
      mimeType: "text/x-shellscript",
      buffer: Buffer.from("echo setup"),
    });
  await m.getByLabel("Context file role").selectOption("script");
  await expect(m.getByLabel("Context file destination")).toHaveValue(
    "/opt/agentor-context/setup.sh",
  );
});
test("makes Safe the explicit default and explains the bounded Advanced opt-in", async ({
  page,
}) => {
  let updatedDefinition: any;
  await page.route("**/api/image-catalog/definitions/def-1", async (route) => {
    updatedDefinition = await route.request().postDataJSON();
    return route.fulfill({ json: { ...definition, ...updatedDefinition } });
  });
  const m = await open(page);
  const mode = m.getByLabel("Provisioning mode");
  await expect(mode).toHaveValue("safe");
  await expect(m).toContainText("Existing definitions stay in Safe mode");
  await mode.selectOption("advanced");
  await expect(m.getByTestId("advanced-provisioning-warning")).toContainText(
    "controlled Docker/BuildKit build",
  );
  await expect(m.getByTestId("advanced-provisioning-warning")).toContainText(
    "not host access",
  );
  await m.getByRole("button", { name: "Edit Node tools" }).click();
  await m.getByLabel("Provisioning mode").selectOption("advanced");
  await m.getByRole("button", { name: "Save image definition" }).click();
  await expect.poll(() => updatedDefinition?.dockerfileFragment).toBe("");
});
test("selects plugin image contributions and requires an explicit Advanced opt-in when needed", async ({
  page,
}) => {
  const m = await open(page);
  const bake = m.getByLabel("Bake plugin Build tools");
  await expect(bake).toBeVisible();
  await bake.check();
  await expect(m).toContainText("Agentor will never switch modes silently");
  await expect(
    m.getByRole("button", { name: "Create image definition" }),
  ).toBeDisabled();
  await m.getByLabel("Provisioning mode").selectOption("advanced");
  await expect(m.getByLabel("Plugin requirement for Build tools")).toHaveValue(
    "optional",
  );
  await m
    .getByLabel("Plugin requirement for Build tools")
    .selectOption("required");
  await expect(m.getByLabel("Plugin requirement for Build tools")).toHaveValue(
    "required",
  );
});
test("renders compatibility outcomes and keeps unsafe version actions unavailable", async ({
  page,
}) => {
  await page.route("**/api/image-catalog/definitions", (route) =>
    route.fulfill({ json: compatibilityDefinitions }),
  );
  const m = await open(page);
  await expect(
    m.getByTestId("image-version-status-incompatible"),
  ).toContainText("Built but incompatible");
  await expect(m.getByTestId("image-version-status-unknown")).toContainText(
    "Validation unavailable",
  );
  await expect(m).toContainText("Worker handshake did not complete");
  const incompatibleRow = m.locator("tr", { hasText: "incompatible" });
  await expect(
    incompatibleRow.getByRole("button", { name: "Promote" }),
  ).toBeDisabled();
  await expect(
    incompatibleRow.getByRole("button", { name: "Create test worker" }),
  ).toBeDisabled();
  await expect(
    incompatibleRow.getByRole("button", {
      name: /Retry compatibility validation/,
    }),
  ).toBeVisible();
  const warningsRow = m.locator("tr", { hasText: "warn" });
  await expect(
    warningsRow.getByRole("button", { name: "Promote" }),
  ).toBeEnabled();
  await expect(
    warningsRow.getByRole("button", { name: "Set my default" }),
  ).toBeEnabled();
  await expect(
    warningsRow.getByRole("button", { name: "Create test worker" }),
  ).toBeEnabled();
});
test("renders an actionable Safe-mode preflight diagnostic without implying Docker ran", async ({
  page,
}) => {
  await page.route("**/api/image-builds", (route) =>
    route.fulfill({
      json: [
        {
          id: "blocked-build",
          definitionId: "def-1",
          status: "failed",
          phase: "preflight",
          dockerAttempted: false,
          diagnostic: {
            code: "safe-mode-blocked",
            blockedField: "provisioning[0]",
            constraint: "Safe mode does not permit Docker socket mounts",
            reason: "The command requests a host-controlled Docker socket.",
            remediation: "Use a package install or context script instead",
            advancedModeAvailable: true,
          },
        },
      ],
    }),
  );
  const m = await open(page);
  await expect(m.getByTestId("image-build-status-blocked-build")).toContainText(
    "Blocked by Safe mode",
  );
  await expect(m.getByTestId("image-build-diagnostic")).toContainText(
    "Safe-mode constraint",
  );
  await expect(m.getByTestId("image-build-diagnostic")).toContainText(
    "Use a package install",
  );
  await expect(m.getByTestId("image-build-diagnostic")).toContainText(
    "does not grant host access",
  );
});
test("keeps a running preflight as progress rather than a Safe-mode block", async ({
  page,
}) => {
  await page.route("**/api/image-builds", (route) =>
    route.fulfill({
      json: [
        {
          id: "preflight-running",
          definitionId: "def-1",
          status: "running",
          phase: "preflight",
          progress: 5,
        },
      ],
    }),
  );
  await page.route("**/api/image-builds/preflight-running", (route) =>
    route.fulfill({
      json: {
        id: "preflight-running",
        definitionId: "def-1",
        status: "running",
        phase: "preflight",
        progress: 5,
      },
    }),
  );
  const m = await open(page);
  await expect(
    m.getByTestId("image-build-status-preflight-running"),
  ).toContainText("Building");
  await expect(
    m.getByTestId("image-build-status-preflight-running"),
  ).not.toContainText("Blocked");
});
test("a double-click submits only one image build", async ({ page }) => {
  let requests = 0;
  await page.route(
    "**/api/image-catalog/definitions/def-1/builds",
    async (route) => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        status: 202,
        json: {
          id: "build-1",
          definitionId: "def-1",
          status: "running",
          phase: "building",
        },
      });
    },
  );
  const modal = await open(page);
  await modal
    .getByRole("button", { name: "Build", exact: true })
    .first()
    .dblclick();
  await expect.poll(() => requests).toBe(1);
});
test("creating a test worker submits exactly one request", async ({ page }) => {
  let requests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/test-worker"))
      requests++;
  });
  const modal = await open(page);
  await modal
    .getByRole("button", { name: "Create test worker" })
    .first()
    .click();
  await expect.poll(() => requests).toBe(1);
  await expect
    .poll(() =>
      modal.getByText(/Test worker test-worker-job-1: succeeded/).count(),
    )
    .toBe(1);
});
test("only fetches cursor logs when they are requested for a terminal job", async ({
  page,
}) => {
  let logRequests = 0;
  await page.route("**/api/image-builds", (route) =>
    route.fulfill({
      json: [
        {
          id: "completed-build",
          definitionId: "def-1",
          status: "succeeded",
          phase: "completed",
          outcome: "ready",
          digest: "sha256:completed",
        },
      ],
    }),
  );
  await page.route("**/api/image-builds/completed-build/logs?**", (route) => {
    logRequests++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("limit")).toBe("200");
    return route.fulfill({
      json: {
        entries: ["final build log"],
        logs: "final build log",
        after: 0,
        nextCursor: 1,
      },
    });
  });
  const modal = await open(page);
  await expect(
    modal.getByTestId("image-build-status-completed-build"),
  ).toContainText("Ready");
  expect(logRequests).toBe(0);
  await modal
    .getByRole("button", { name: "Show logs for completed-build" })
    .click();
  await expect.poll(() => logRequests).toBe(1);
  await expect(modal).toContainText("final build log");
});
test("starts an asynchronous compatibility retry and then polls its durable job", async ({
  page,
}) => {
  await page.route("**/api/image-catalog/definitions", (route) =>
    route.fulfill({ json: compatibilityDefinitions }),
  );
  let retries = 0;
  await page.route(
    "**/api/image-catalog/definitions/def-compat/versions/unknown/validation-retry",
    async (route) => {
      retries++;
      const body = await route.request().postDataJSON();
      expect(body.requestId).toBeTruthy();
      return route.fulfill({
        status: 202,
        json: {
          id: "validation-retry-job",
          definitionId: "def-compat",
          version: "unknown",
          operation: "validation",
          status: "queued",
          phase: "queued",
          outcome: "validation-pending",
        },
      });
    },
  );
  await page.route("**/api/image-builds/validation-retry-job", (route) =>
    route.fulfill({
      json: {
        id: "validation-retry-job",
        definitionId: "def-compat",
        operation: "validation",
        status: "running",
        phase: "validating",
        outcome: "validation-pending",
      },
    }),
  );
  const modal = await open(page);
  await modal
    .getByRole("button", { name: "Retry compatibility validation for unknown" })
    .click();
  await expect.poll(() => retries).toBe(1);
  await expect(
    modal.getByTestId("image-build-status-validation-retry-job"),
  ).toContainText("Built — validating");
});
test("discovers builds and versions created externally while open", async ({
  page,
}) => {
  let buildPosts = 0;
  let buildPolls = 0;
  let catalogPolls = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/builds"))
      buildPosts++;
  });
  await page.route("**/api/image-builds", (route) => {
    // The first refresh must expose the externally-started build; the next
    // regular UI poll completes it. Request counts avoid coupling this test to
    // dashboard/navigation speed on a busy CI runner.
    const complete = ++buildPolls > 1;
    return route.fulfill({
      json: [
        {
          id: "external-build",
          definitionId: "def-1",
          status: complete ? "succeeded" : "running",
          phase: complete ? "complete" : "building",
          ...(complete ? { version: "v2", digest: "sha256:external" } : {}),
        },
      ],
    });
  });
  await page.route("**/api/image-builds/external-build/logs", (route) =>
    route.fulfill({ body: "[builder] external build" }),
  );
  await page.route("**/api/image-catalog/definitions", (route) => {
    const complete = ++catalogPolls > 1;
    return route.fulfill({
      json: [
        {
          ...definition,
          versions: complete
            ? [
                ...definition.versions,
                {
                  version: "v2",
                  digest: "sha256:external",
                  baseImage: definition.baseImage,
                  createdAt: "2026-01-02",
                },
              ]
            : definition.versions,
        },
        groupDefinition,
      ],
    });
  });
  const modal = await open(page);
  await expect(
    modal.getByRole("button", { name: "Show logs for external-build" }),
  ).toBeVisible();
  await expect(modal.getByTestId("image-build")).toContainText(
    /Building|Ready/,
  );
  await expect(modal.getByText("v2", { exact: true })).toBeVisible({
    timeout: 5000,
  });
  expect(buildPosts).toBe(0);
});
test("exposes test, promotion, rollback, defaults, base rebuild and usage controls", async ({
  page,
}) => {
  const m = await open(page);
  await expect(m).toContainText("sha256:abc");
  await expect(
    m.getByRole("button", { name: "Create test worker" }).first(),
  ).toBeVisible();
  await expect(
    m.getByRole("button", { name: "Promote" }).first(),
  ).toBeVisible();
  await expect(
    m.getByRole("button", { name: "Rollback" }).first(),
  ).toBeVisible();
  await expect(
    m.getByRole("button", { name: "Set my default" }).first(),
  ).toBeVisible();
  await expect(
    m.getByRole("button", { name: "Rebuild newer base" }).first(),
  ).toBeVisible();
  await expect(
    m.getByRole("button", { name: "Delete version" }).first(),
  ).toBeVisible();
});
test("shows whether each image belongs to the global catalog or a worker group", async ({
  page,
}) => {
  const m = await open(page);
  await expect(
    m.getByTestId("image-catalog-scope").filter({ hasText: "Global catalog" }),
  ).toBeVisible();
  await expect(
    m
      .getByTestId("image-catalog-scope")
      .filter({ hasText: "Worker group: Evaluation team" }),
  ).toBeVisible();
});
test("connects, syncs, recovers, and disconnects an optional GitHub catalog without conflating workspace backups", async ({
  page,
}) => {
  const m = await open(page);
  const git = m.locator('[data-testid="git-image-catalog"]');
  await expect(git).toContainText("does not back up workspace data");
  await git.getByLabel("GitHub repository").fill("owner/images");
  await git
    .getByLabel("Fine-grained GitHub token")
    .fill("github_pat_test_only");
  await git.getByRole("button", { name: "Connect" }).click();
  await expect(git).toContainText("owner/images");
  await expect(
    git.getByRole("button", { name: "Sync local changes" }),
  ).toBeVisible();
  await expect(
    git.getByRole("button", { name: "Recover / pull" }),
  ).toBeVisible();
  await git
    .getByRole("button", { name: "Disconnect and erase credential" })
    .click();
  await expect(git.getByRole("button", { name: "Connect" })).toBeVisible();
});
