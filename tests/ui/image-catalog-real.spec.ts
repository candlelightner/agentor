import { expect, test } from "@playwright/test";
import { goToDashboard } from "../helpers/ui-helpers";
import { captureCommandOutput } from "../helpers/terminal-ws";

test("real browser creates, builds, and promotes an approved-base image", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const name = `Image-real-${Date.now()}`;
  let definitionId = "";
  let testWorkerId = "";
  let buildJobId = "";
  try {
    await goToDashboard(page);
    await page.getByRole("button", { name: /image catalog/i }).click();
    const modal = page.locator('[data-testid="image-catalog"]');
    await modal.getByPlaceholder("Definition name").fill(name);
    await modal
      .getByPlaceholder("Description")
      .fill("Real browser controlled-build proof");
    await modal
      .getByPlaceholder("Optional shell setup command")
      .fill("printf agentor-image-proof > /etc/agentor-image-proof");
    const createResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/image-catalog/definitions") &&
        response.request().method() === "POST",
    );
    await modal
      .getByRole("button", { name: "Create image definition" })
      .click();
    const created = await createResponse;
    expect(created.ok(), await created.text()).toBe(true);
    definitionId = (await created.json()).id;
    const article = modal.locator("article").filter({ hasText: name });
    await expect(article).toBeVisible();
    const buildResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(`/api/image-catalog/definitions/${definitionId}/builds`) &&
        response.request().method() === "POST",
    );
    await article.getByRole("button", { name: "Build", exact: true }).click();
    const buildAccepted = await buildResponse;
    expect(buildAccepted.status(), await buildAccepted.text()).toBe(202);
    buildJobId = (await buildAccepted.json()).id;
    expect(buildJobId).toBeTruthy();
    const build = modal.locator('[data-testid="image-build"]').last();
    // Docker completion alone is not enough: the UI may briefly state
    // “Built — validating” before compatibility has made the version ready.
    await expect(build).toContainText("Ready", { timeout: 240_000 });
    await expect(article.locator("code")).toContainText("sha256:");
    const status = await request.get(`/api/image-builds/${buildJobId}`);
    expect(status.ok(), await status.text()).toBe(true);
    expect((await status.json()).outcome).toMatch(/ready/);
    const logs = await request.get(
      `/api/image-builds/${buildJobId}/logs?format=json&after=0&limit=10`,
    );
    expect(logs.ok(), await logs.text()).toBe(true);
    expect(await logs.json()).toMatchObject({ after: 0 });
    const testWorkerResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/test-worker") &&
        response.request().method() === "POST",
    );
    await article.getByRole("button", { name: "Create test worker" }).click();
    const testWorkerAccepted = await testWorkerResponse;
    expect(testWorkerAccepted.status(), await testWorkerAccepted.text()).toBe(
      202,
    );
    const testWorkerJobId = (await testWorkerAccepted.json()).id;
    expect(testWorkerJobId).toBeTruthy();
    await expect
      .poll(
        async () => {
          const response = await request.get(
            `/api/image-builds/${testWorkerJobId}`,
          );
          expect(response.ok(), await response.text()).toBe(true);
          return response.json();
        },
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "succeeded", outcome: "test-worker-ready" });
    const testWorkerJob = await (
      await request.get(`/api/image-builds/${testWorkerJobId}`)
    ).json();
    testWorkerId = testWorkerJob.workerId;
    expect(testWorkerId).toBeTruthy();
    await expect
      .poll(
        async () =>
          (await request.get(`/api/containers/${testWorkerId}`)).status(),
        { timeout: 60_000 },
      )
      .toBe(200);
    expect(
      await captureCommandOutput(
        testWorkerId,
        "cat /etc/agentor-image-proof",
        30_000,
      ),
    ).toContain("agentor-image-proof");
    await article.getByRole("button", { name: "Promote" }).click();
    await expect(article).toContainText("promoted");
  } finally {
    if (testWorkerId) {
      const deleted = await request.delete(`/api/containers/${testWorkerId}`);
      expect(deleted.ok()).toBe(true);
    }
    if (definitionId) {
      const deleted = await request.delete(
        `/api/image-catalog/definitions/${definitionId}`,
      );
      expect(deleted.status()).toBe(204);
    }
  }
});
