import { expect, test, type Page } from "@playwright/test";
import { goToDashboard } from "../helpers/ui-helpers";

const workspace = {
  id: "admin-workspace-1",
  kind: "administrative",
  trusted: true,
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  image: {
    name: "agentor-admin-worker:stable",
    digest: `sha256:${"a".repeat(64)}`,
    promoted: true,
  },
  presentation: {
    terminalTheme: "administrative-red",
    banner: "ADMIN / ORCHESTRATOR",
    promptMarker: "[ADMIN ORCHESTRATOR]",
    browserTitle: "ADMIN ORCHESTRATOR",
    environmentMarker: "AGENTOR_ADMIN_WORKSPACE",
    warningBeforePrivilegedActions: true,
  },
  services: ["terminal", "editor", "desktop"],
};

async function mockAdminWorkspace(page: Page) {
  let state = structuredClone(workspace);
  await page.route("**/api/admin/workspace", async (route) => {
    if (route.request().method() === "POST")
      state = { ...state, status: "running" };
    await route.fulfill({ json: state });
  });
  for (const action of ["start", "stop", "rebuild"]) {
    await page.route(`**/api/admin/workspace/${action}`, async (route) => {
      state = {
        ...state,
        status: action === "stop" ? "stopped" : "running",
        updatedAt: "2026-01-03T00:00:00.000Z",
      };
      await route.fulfill({ json: state });
    });
  }
}
async function openAdminWorkspace(page: Page) {
  await goToDashboard(page);
  await page.getByRole("button", { name: /admin workspace/i }).click();
  return page.locator('[data-testid="admin-workspace"]');
}

test.beforeEach(async ({ page }) => mockAdminWorkspace(page));

test("uses unmistakable red ADMIN / ORCHESTRATOR identity and warns about privilege", async ({
  page,
}) => {
  const modal = await openAdminWorkspace(page);
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole("heading", { name: "ADMIN / ORCHESTRATOR" }),
  ).toBeVisible();
  await expect(modal).toHaveClass(/bg-red-950/);
  await expect(modal.getByRole("alert")).toContainText("affect every worker");
  await expect(modal).toContainText("AGENTOR_ADMIN_WORKSPACE=1");
});

test("shows persistent lifecycle, trusted immutable image identity, and existing services", async ({
  page,
}) => {
  const modal = await openAdminWorkspace(page);
  await expect(modal).toContainText("running");
  await expect(modal).toContainText("agentor-admin-worker:stable");
  await expect(modal).toContainText(/sha256:a+/);
  await expect(modal).toContainText("Explicitly promoted");
  for (const service of ["terminal", "VS Code", "desktop"])
    await expect(
      modal.getByRole("button", { name: new RegExp(service, "i") }),
    ).toBeVisible();
});

test("requires explicit warning acknowledgement before lifecycle changes", async ({
  page,
}) => {
  const modal = await openAdminWorkspace(page);
  await modal.getByRole("button", { name: "Stop admin workspace" }).click();
  const confirmation = page.locator(
    '[data-testid="admin-action-confirmation"]',
  );
  const confirm = confirmation.getByRole("button", { name: "Confirm stop" });
  await expect(confirm).toBeDisabled();
  await confirmation.getByLabel(/I understand this is an ADMIN/).check();
  await confirm.click();
  await expect(confirmation).toBeHidden();
  await expect(modal).toContainText("stopped");
  await expect(
    modal.getByRole("button", { name: "Start admin workspace" }),
  ).toBeVisible();
});

test("requires the same privileged confirmation before rebuilding the trusted overlay", async ({
  page,
}) => {
  const modal = await openAdminWorkspace(page);
  await modal.getByRole("button", { name: "Rebuild trusted image" }).click();
  const confirmation = page.locator(
    '[data-testid="admin-action-confirmation"]',
  );
  await expect(confirmation).toContainText("Confirm privileged rebuild action");
  await confirmation.getByLabel(/I understand this is an ADMIN/).check();
  await confirmation.getByRole("button", { name: "Confirm rebuild" }).click();
  await expect(confirmation).toBeHidden();
});
