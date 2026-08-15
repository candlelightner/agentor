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
async function mock(page: Page) {
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
    r.fulfill({ json: [{ id: "group-1", name: "Evaluation team", workerIds: [] }] }),
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
    await r.fulfill({ json: gitConnected ? { repository: "owner/images", workflow: "pull-request", buildMode: "local", credential: { type: "pat", configured: true, shortLived: false } } : { connected: false } });
  });
  await page.route("**/api/image-catalog/git/recovery", (r) => r.fulfill({ json: { state: "not-run", catalogEntries: 0, imageDigests: 0, note: "Workspace data is not included." } }));
  await page.route("**/api/image-catalog/git/sync", async (r) => r.fulfill({ json: { direction: (await r.request().postDataJSON()).direction, written: true, conflicts: [] } }));
  await page.route("**/api/image-catalog/definitions/def-1/builds", (r) =>
    r.fulfill({
      status: 202,
      json: {
        id: "build-1",
        definitionId: "def-1",
        status: "running",
        phase: "building",
      },
    }),
  );
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
  await page.route("**/api/image-builds/build-1/logs", (r) =>
    r.fulfill({ body: "[builder] safe build log" }),
  );
  for (const pattern of [
    "**/promote",
    "**/rollback",
    "**/test-worker",
    "**/defaults",
  ])
    await page.route(pattern, (r) =>
      r.fulfill({
        json: pattern.includes("test-worker")
          ? { workerId: "test-worker-1" }
          : { ok: true },
      }),
    );
}
async function open(page: Page) {
  await goToDashboard(page);
  await page.getByRole("button", { name: /image catalog/i }).click();
  return page.locator('[data-testid="image-catalog"]');
}
test.beforeEach(async ({ page }) => mock(page));
test("creates a constrained definition and follows asynchronous build logs", async ({
  page,
}) => {
  const m = await open(page);
  await expect(m).toContainText("Storage: 1.0 MB");
  await m.getByPlaceholder("Definition name").fill("Python tools");
  await m.getByPlaceholder("Description").fill("Prebuilt");
  await m.getByRole("button", { name: "Create definition" }).click();
  await m.getByRole("button", { name: "Build", exact: true }).first().click();
  await expect(m.locator('[data-testid="image-build"]')).toContainText(
    "safe build log",
  );
});
test("exposes test, promotion, rollback, defaults, base rebuild and usage controls", async ({
  page,
}) => {
  const m = await open(page);
  await expect(m).toContainText("sha256:abc");
  await expect(
    m.getByRole("button", { name: "Create test worker" }).first(),
  ).toBeVisible();
  await expect(m.getByRole("button", { name: "Promote" }).first()).toBeVisible();
  await expect(m.getByRole("button", { name: "Rollback" }).first()).toBeVisible();
  await expect(m.getByRole("button", { name: "Set my default" }).first()).toBeVisible();
  await expect(
    m.getByRole("button", { name: "Rebuild newer base" }).first(),
  ).toBeVisible();
  await expect(m.getByRole("button", { name: "Delete version" }).first()).toBeVisible();
});
test("shows whether each image belongs to the global catalog or a worker group", async ({ page }) => {
  const m = await open(page);
  await expect(m.getByTestId("image-catalog-scope").filter({ hasText: "Global catalog" })).toBeVisible();
  await expect(m.getByTestId("image-catalog-scope").filter({ hasText: "Worker group: Evaluation team" })).toBeVisible();
});
test("connects, syncs, recovers, and disconnects an optional GitHub catalog without conflating workspace backups", async ({ page }) => {
  const m = await open(page);
  const git = m.locator('[data-testid="git-image-catalog"]');
  await expect(git).toContainText("does not back up workspace data");
  await git.getByLabel("GitHub repository").fill("owner/images");
  await git.getByLabel("Fine-grained GitHub token").fill("github_pat_test_only");
  await git.getByRole("button", { name: "Connect" }).click();
  await expect(git).toContainText("owner/images");
  await expect(git.getByRole("button", { name: "Sync local changes" })).toBeVisible();
  await expect(git.getByRole("button", { name: "Recover / pull" })).toBeVisible();
  await git.getByRole("button", { name: "Disconnect and erase credential" }).click();
  await expect(git.getByRole("button", { name: "Connect" })).toBeVisible();
});
