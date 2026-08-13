import { expect, test } from "@playwright/test";
import { createWorker, cleanupWorker } from "../helpers/worker-lifecycle";
import { goToDashboard } from "../helpers/ui-helpers";
import { captureCommandOutput } from "../helpers/terminal-ws";

test("real browser configures fake provider, backs up, and starts restore", async ({
  page,
  request,
}) => {
  test.setTimeout(600_000);
  const worker = await createWorker(request, {
    displayName: `Backup-real-${Date.now()}`,
  });
  const restoreName = `Backup-restored-${Date.now()}`;
  const marker = `BACKUP_REAL_${Date.now()}`;
  let restoredWorkerId = "";
  try {
    expect(
      (
        await request.post("/api/backup-providers/fake/connect", {
          data: { testMode: true },
        })
      ).status(),
    ).toBe(201);
    await captureCommandOutput(
      worker.id,
      `printf %s ${marker} > /workspace/backup-real-marker`,
      30_000,
    );
    await goToDashboard(page);
    await page.getByRole("button", { name: /backup management/i }).click();
    const modal = page.locator('[data-testid="backup-management"]');
    await modal.getByLabel("Provider").selectOption("fake");
    await modal.getByLabel("Selected workspaces").check();
    await modal.getByPlaceholder("workspace-a, workspace-b").fill(worker.id);
    await modal.getByRole("button", { name: "Save schedule" }).click();
    await modal.getByRole("button", { name: "Back up now" }).click();
    await expect(modal).toContainText("succeeded", { timeout: 120_000 });
    await expect(modal).toContainText("Integrity verified");
    const artifact = modal
      .locator(".border.rounded")
      .filter({ hasText: worker.id })
      .filter({ hasText: "Integrity verified" })
      .first();
    await artifact.getByRole("button", { name: "Restore" }).click();
    const restorePanel = modal.getByTestId("restore-backup");
    await expect(restorePanel).toBeVisible();
    await restorePanel.getByLabel("New worker").check();
    await restorePanel
      .getByPlaceholder("New worker display name")
      .fill(restoreName);
    const restoreResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/restore") &&
        response.request().method() === "POST",
    );
    await restorePanel.getByRole("button", { name: "Start restore" }).click();
    expect((await restoreResponse).status()).toBe(202);
    await expect(restorePanel).toBeHidden();
    await expect
      .poll(
        async () => {
          const workers = await (await request.get("/api/containers")).json();
          restoredWorkerId =
            workers.find(
              (candidate: any) => candidate.displayName === restoreName,
            )?.id || "";
          return Boolean(restoredWorkerId);
        },
        { timeout: 120_000 },
      )
      .toBe(true);
    expect(
      await captureCommandOutput(
        restoredWorkerId,
        "cat /workspace/backup-real-marker",
        30_000,
      ),
    ).toContain(marker);
    await artifact.getByRole("button", { name: "Delete" }).click();
    await expect(artifact).toBeHidden();
  } finally {
    if (restoredWorkerId)
      await cleanupWorker(request, restoredWorkerId).catch(() => {});
    await cleanupWorker(request, worker.id);
  }
});
