import { expect, test } from "@playwright/test";
import { deleteApprovedHostPath } from "../helpers/host-mounts";
import { goToDashboard, openCreateWorkerModal } from "../helpers/ui-helpers";

test("platform host-mount UI creates, entitles, assigns, and exposes an approved path", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const name = `UI governed mount ${stamp}`;
  const sourcePath = `/tmp/ui-governed-mount-${stamp}`;
  let pathId = "";

  try {
    await goToDashboard(page);
    await page.getByRole("button", { name: "Host mount permissions" }).click();
    const modal = page.getByTestId("host-mount-management");
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Host access is security-sensitive")).toBeVisible();
    await expect(modal.getByText("Group administrative workspaces")).toBeVisible();

    const catalog = modal.locator("section").filter({
      hasText: "Platform path catalog",
    });
    await catalog.getByPlaceholder("Display name").fill(name);
    await catalog.getByPlaceholder("/dedicated/host/data").fill(sourcePath);
    await catalog.getByRole("button", { name: "Approve" }).click();
    const catalogRow = catalog
      .locator("div.flex.items-center.gap-3.p-3")
      .filter({ hasText: name });
    await expect(catalogRow).toBeVisible();

    const read = await request.get("/api/host-mounts");
    expect(read.status()).toBe(200);
    const created = (await read.json()).catalog.find(
      (path: { sourcePath: string }) => path.sourcePath === sourcePath,
    );
    expect(created).toMatchObject({ name, sourcePath, allowWrite: false, entitled: false });
    pathId = created.id;

    // Writable access is a separate, explicit platform decision. The catalog
    // entry remains read-only until this checkbox is deliberately enabled.
    const allowWrite = catalogRow.getByRole("checkbox", { name: "Allow write" });
    await expect(allowWrite).not.toBeChecked();
    await allowWrite.click();
    await expect.poll(async () => {
      const state = await (await request.get("/api/host-mounts")).json();
      return state.catalog.find((path: { id: string }) => path.id === pathId)?.allowWrite;
    }).toBe(true);

    const entitlements = modal.locator("section").filter({
      hasText: "Account entitlements",
    });
    const entitlementRow = entitlements.locator("label").filter({ hasText: name });
    await entitlementRow.getByRole("checkbox").click();
    await expect.poll(async () => {
      const state = await (await request.get("/api/host-mounts")).json();
      return state.catalog.find((path: { id: string }) => path.id === pathId)?.entitled;
    }).toBe(true);

    const assignments = modal.locator("section").filter({
      hasText: "Assignments for",
    });
    await expect(assignments.getByRole("combobox").first()).toContainText(name);
    await expect(assignments.getByRole("combobox").nth(1)).toContainText("All workers");
    await assignments.getByRole("button", { name: "Assign" }).click();
    const grantRow = assignments
      .locator("div.flex.items-center.gap-3.p-3")
      .filter({ hasText: name })
      .filter({ hasText: "All workers" });
    await expect(grantRow).toBeVisible();
    await expect.poll(async () => {
      const state = await (await request.get("/api/host-mounts")).json();
      return state.grants.some(
        (grant: { pathId: string; targetType: string }) =>
          grant.pathId === pathId && grant.targetType === "all",
      );
    }).toBe(true);

    await modal.getByRole("button", { name: "Close" }).click();
    await expect(modal).toBeHidden();
    await openCreateWorkerModal(page);
    const createModal = page.getByRole("dialog");
    const addMount = createModal.getByRole("button", { name: "Add mount" });
    await expect(addMount).toBeEnabled();
    await addMount.click();
    const pathSelector = createModal.getByRole("combobox", {
      name: "Approved host path",
    });
    await pathSelector.click();
    await page.getByRole("option", { name: new RegExp(sourcePath) }).click();
    const access = createModal.getByRole("combobox", { name: "Mount access" });
    await expect(access).toContainText("Read only");
    await access.click();
    await expect(page.getByRole("option", { name: "Read and write", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await createModal.getByRole("button", { name: "Cancel" }).click();
  } finally {
    await deleteApprovedHostPath(request, pathId);
  }
});
