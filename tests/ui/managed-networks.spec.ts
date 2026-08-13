import { expect, Page, test } from "@playwright/test";
import { cleanupWorker, createWorker } from "../helpers/worker-lifecycle";
import { goToDashboard } from "../helpers/ui-helpers";

async function openGroups(page: Page) {
  await page.getByRole("button", { name: "Worker groups" }).click();
  const modal = page.getByRole("dialog", { name: "Worker groups" });
  await expect(modal).toBeVisible();
  return modal;
}

test.describe.serial("Managed networks dashboard", () => {
  let workerId = "";
  let workerName = "";
  let groupId = "";
  let networkId = "";

  test.beforeAll(async ({ request }) => {
    const worker = await createWorker(request, {
      displayName: `network-ui-worker-${Date.now()}`,
    });
    workerId = worker.id;
    workerName = String(worker.displayName);
  });

  test.afterAll(async ({ request }) => {
    if (networkId)
      await request
        .delete(`/api/managed-networks/${networkId}`)
        .catch(() => {});
    if (groupId)
      await request.delete(`/api/worker-groups/${groupId}`).catch(() => {});
    if (workerId) await cleanupWorker(request, workerId);
  });

  test("creates, validates, detaches, and deletes a group-scoped network without deleting its worker", async ({
    page,
    request,
  }) => {
    const groupName = `Network group ${Date.now()}`;
    const networkName = `Group network ${Date.now()}`;
    await goToDashboard(page);
    const groups = await openGroups(page);
    await groups.getByLabel("Group name").fill(groupName);
    await groups.getByRole("button", { name: "Create group" }).click();
    const group = groups.locator("section").filter({ hasText: groupName });
    await expect(group).toBeVisible();
    const membership = group.getByRole("checkbox", { name: workerName });
    await membership.check();
    await expect
      .poll(async () => {
        const allGroups = (await (
          await request.get("/api/worker-groups")
        ).json()) as Array<{ id: string; name: string; workerIds: string[] }>;
        const persisted = allGroups.find((entry) => entry.name === groupName);
        groupId = persisted?.id || "";
        return persisted?.workerIds || [];
      })
      .toEqual([workerId]);
    await page.keyboard.press("Escape");
    await expect(groups).toBeHidden();

    await page.getByRole("button", { name: "Managed networks" }).click();
    const networks = page.getByRole("dialog", { name: "Managed networks" });
    await expect(networks).toBeVisible();
    await networks.getByLabel("Network name").fill(networkName);
    await networks.getByLabel("Network scope").selectOption("group");
    await networks.getByLabel("Worker group").selectOption(groupId);
    await networks.getByRole("button", { name: "Create network" }).click();
    const network = networks
      .locator("section")
      .filter({ hasText: networkName });
    await expect(network).toContainText(`group: ${groupName}`);
    await expect
      .poll(async () => {
        const allNetworks = (await (
          await request.get("/api/managed-networks")
        ).json()) as Array<{ id: string; name: string }>;
        networkId =
          allNetworks.find((entry) => entry.name === networkName)?.id || "";
        return networkId;
      })
      .not.toBe("");
    await network.getByRole("button", { name: "Validate" }).click();
    await expect(network).toContainText(
      /Connectivity membership verified\.|Missing:/,
    );

    await page.keyboard.press("Escape");
    await expect(networks).toBeHidden();
    const updatedGroups = await openGroups(page);
    const updatedGroup = updatedGroups
      .locator("section")
      .filter({ hasText: groupName });
    await updatedGroup.getByRole("checkbox", { name: workerName }).uncheck();
    await expect
      .poll(
        async () =>
          (
            (await (
              await request.get(`/api/worker-groups/${groupId}`)
            ).json()) as { workerIds: string[] }
          ).workerIds,
      )
      .toEqual([]);
    await page.keyboard.press("Escape");
    await expect(updatedGroups).toBeHidden();

    await page.getByRole("button", { name: "Managed networks" }).click();
    const reopenedNetwork = page
      .getByRole("dialog", { name: "Managed networks" })
      .locator("section")
      .filter({ hasText: networkName });
    await expect(reopenedNetwork).toBeVisible();
    await reopenedNetwork.getByRole("button", { name: "Validate" }).click();
    await expect(reopenedNetwork).toContainText(
      /Connectivity membership verified\.|Missing:/,
    );
    await reopenedNetwork.getByRole("button", { name: "Delete" }).click();
    await expect(reopenedNetwork).toBeHidden();
    networkId = "";
    expect((await request.get(`/api/containers/${workerId}`)).status()).toBe(
      200,
    );
    await page.keyboard.press("Escape");
    const cleanupGroups = await openGroups(page);
    await cleanupGroups
      .locator("section")
      .filter({ hasText: groupName })
      .getByRole("button", { name: "Delete" })
      .click();
    groupId = "";
  });
});
