import { expect, test } from "@playwright/test";
import { cleanupWorker, createWorker } from "../helpers/worker-lifecycle";
import { goToDashboard } from "../helpers/ui-helpers";

test.describe.serial("Worker groups dashboard", () => {
  let workerId = "";
  let workerName = "";
  let groupId = "";

  test.beforeAll(async ({ request }) => {
    const worker = await createWorker(request, {
      displayName: `group-ui-worker-${Date.now()}`,
    });
    workerId = worker.id;
    workerName = String(worker.displayName);
  });

  test.afterAll(async ({ request }) => {
    if (groupId)
      await request.delete(`/api/worker-groups/${groupId}`).catch(() => {});
    if (workerId) await cleanupWorker(request, workerId);
  });

  test("creates a group, changes real worker membership, and deletes only the group", async ({
    page,
    request,
  }) => {
    const groupName = `UI experiment ${Date.now()}`;
    await goToDashboard(page);
    await page.getByRole("button", { name: "Worker groups" }).click();
    const modal = page.getByRole("dialog", { name: "Worker groups" });
    await expect(modal).toBeVisible();
    await modal.getByLabel("Group name").fill(groupName);
    await modal.getByRole("button", { name: "Create group" }).click();
    const group = modal.locator("section").filter({ hasText: groupName });
    await expect(group).toBeVisible();
    const membership = group.getByRole("checkbox", { name: workerName });
    await membership.check();
    await expect(membership).toBeChecked();
    await expect
      .poll(async () => {
        const groups = (await (
          await request.get("/api/worker-groups")
        ).json()) as Array<{ id: string; name: string; workerIds: string[] }>;
        const persisted = groups.find((entry) => entry.name === groupName);
        groupId = persisted?.id || "";
        return persisted?.workerIds || [];
      })
      .toEqual([workerId]);
    await group.getByRole("button", { name: "Provision group admin" }).click();
    await expect(group.getByText("running", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect.poll(async () => (await request.get(`/api/worker-groups/${groupId}/admin-workspace`)).status(), { timeout: 120_000 }).toBe(200);
    await group.getByRole("button", { name: "Open terminal" }).click();
    await expect(page.getByText("GROUP ADMIN - Terminal", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Worker groups" }).click();
    const reopened = page.getByRole("dialog", { name: "Worker groups" }).locator("section").filter({ hasText: groupName });
    await reopened.getByRole("button", { name: "Delete" }).click();
    await expect(reopened).toBeHidden();
    groupId = "";
    expect((await request.get(`/api/containers/${workerId}`)).status()).toBe(
      200,
    );
  });
});
