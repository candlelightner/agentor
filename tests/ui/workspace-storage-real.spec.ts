import { test, expect } from "@playwright/test";
import { goToDashboard } from "../helpers/ui-helpers";
import {
  createWorker,
  cleanupWorker,
  waitForWorkerRunning,
} from "../helpers/worker-lifecycle";
import { ApiClient } from "../helpers/api-client";
import { gunzipSync } from "node:zlib";

/** Real browser/API journey; mocked UI states remain in workspace-storage.spec.ts. */
test.describe.serial("Workspace storage UI against real APIs", () => {
  test("browses, downloads, and clones a stopped workspace", async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000);
    const api = new ApiClient(request);
    const displayName = `storage-ui-${Date.now()}`;
    const marker = `offline-ui-${Date.now()}.txt`;
    let sourceId = "";
    let cloneId = "";
    try {
      const source = await createWorker(request, { displayName });
      sourceId = source.id;
      expect(
        (
          await api.uploadToWorkspace(sourceId, [
            { name: marker, content: Buffer.from("offline UI marker") },
          ])
        ).status,
      ).toBe(200);
      expect((await api.stopContainer(sourceId)).status).toBe(200);

      await goToDashboard(page);
      await page.getByRole("button", { name: "Workspace storage" }).click();
      const inventory = page.locator('[data-testid="workspace-inventory"]');
      const row = inventory.locator("tr").filter({ hasText: displayName });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText("stopped");
      await row.getByRole("button", { name: "Browse workspace" }).click();
      const browser = page.locator('[data-testid="workspace-browser"]');
      await expect(
        browser.getByRole("button", { name: marker, exact: true }),
      ).toBeVisible();
      await browser.getByRole("button", { name: marker, exact: true }).click();
      await expect(browser).toContainText("offline UI marker");

      const download = page.waitForEvent("download");
      await browser.getByRole("button", { name: "Download item" }).click();
      expect((await download).suggestedFilename()).toBe(marker);
      await browser.getByRole("button", { name: "Close" }).click();

      const cloneResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/containers/${sourceId}/clone`) &&
          response.request().method() === "POST",
      );
      await row
        .getByRole("button", { name: "Clone workspace into a new worker" })
        .click();
      const clone = await cloneResponse;
      expect(clone.status()).toBe(201);
      cloneId = (await clone.json()).id;
      expect(cloneId).toBeTruthy();
      await waitForWorkerRunning(request, cloneId, 90_000);
      const restored = await api.downloadWorkspace(cloneId);
      expect(restored.status).toBe(200);
      expect(
        gunzipSync(Buffer.from(restored.body)).toString("latin1"),
      ).toContain(marker);
    } finally {
      if (cloneId) await cleanupWorker(request, cloneId).catch(() => {});
      if (sourceId) await cleanupWorker(request, sourceId).catch(() => {});
    }
  });
});
