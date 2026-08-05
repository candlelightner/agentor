import { expect, test, type Page } from "@playwright/test";
import { goToDashboard } from "../helpers/ui-helpers";

async function mockManagementMcp(page: Page) {
  let policy = {
    schemaVersion: 1,
    default: "deny",
    revision: 4,
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "System administrator policy",
    groups: {
      "read-only-status": { enabled: true, source: "System baseline" },
      logs: { enabled: true },
      "volume-browsing": { enabled: true },
      "configuration-inspection": { enabled: true },
      "worker-lifecycle": { enabled: false },
      exports: { enabled: false },
      backups: { enabled: false },
      "image-builds": { enabled: false },
      "configuration-proposals": { enabled: true },
      "configuration-application": { enabled: false },
    },
  };
  let proposals = [
    {
      id: "change-immutable-1",
      immutable: true,
      status: "pending-dashboard-approval",
      diff: { logLevel: "debug" },
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ];
  let audit = [
    {
      id: "audit-1",
      at: "2026-01-03T00:00:00.000Z",
      action: "authorization.denied",
      outcome: "failure",
      details: { tool: "worker.stop" },
    },
  ];
  await page.route("**/api/admin/management-mcp/policy", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      for (const [name, enabled] of Object.entries(body.groups))
        policy.groups[name as keyof typeof policy.groups].enabled =
          enabled as boolean;
      policy = { ...policy, revision: policy.revision + 1 };
    }
    await route.fulfill({ json: policy });
  });
  await page.route("**/api/admin/management-mcp/proposals", (route) =>
    route.fulfill({ json: proposals }),
  );
  await page.route(
    "**/api/admin/management-mcp/proposals/change-immutable-1/approve",
    (route) => {
      proposals = proposals.map((item) => ({
        ...item,
        status: "approved" as const,
      }));
      audit = [
        {
          id: "audit-2",
          at: "2026-01-04T00:00:00.000Z",
          action: "proposal.approved",
          outcome: "success",
          details: { proposalId: "change-immutable-1" },
        },
        ...audit,
      ];
      return route.fulfill({ json: proposals[0] });
    },
  );
  await page.route("**/api/admin/management-mcp/audit?**", (route) =>
    route.fulfill({ json: audit }),
  );
}
async function openManagementMcp(page: Page) {
  await goToDashboard(page);
  await page.getByRole("button", { name: /management mcp/i }).click();
  return page.locator('[data-testid="management-mcp"]');
}

test.beforeEach(async ({ page }) => mockManagementMcp(page));

test("shows internal-only fail-closed policy, effective source, and current decisions", async ({
  page,
}) => {
  const modal = await openManagementMcp(page);
  await expect(modal).toContainText("ADMIN / ORCHESTRATOR");
  await expect(modal).toContainText("Internal only");
  await expect(modal).toContainText("Default: deny");
  await expect(modal).toContainText("System administrator policy");
  await expect(modal).toContainText("Effective source: System baseline");
  await expect(modal.getByLabel("Allow read-only-status")).toBeChecked();
  await expect(modal.getByLabel("Allow logs")).toBeChecked();
  await expect(modal.getByLabel("Allow volume-browsing")).toBeChecked();
  await expect(modal.getByLabel("Allow worker-lifecycle")).not.toBeChecked();
});

test("updates live group policy explicitly while preserving default deny", async ({
  page,
}) => {
  const modal = await openManagementMcp(page);
  await modal.getByLabel("Allow worker-lifecycle").check();
  const request = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/admin/management-mcp/policy") &&
      req.method() === "PUT",
  );
  await modal.getByRole("button", { name: "Save live policy" }).click();
  expect((await request).postDataJSON()).toEqual({
    groups: { "worker-lifecycle": true },
  });
  await expect(modal).toContainText("revision 5");
  await expect(modal).toContainText("Default: deny");
});

test("reviews and dashboard-approves the exact immutable change ID", async ({
  page,
}) => {
  const modal = await openManagementMcp(page);
  await modal.getByRole("button", { name: /proposals/i }).click();
  const proposal = modal.locator('[data-testid="proposal-change-immutable-1"]');
  await expect(proposal).toContainText("pending-dashboard-approval");
  await expect(proposal).toContainText("Immutable");
  await expect(proposal).toContainText('"logLevel": "debug"');
  await proposal.getByRole("button", { name: "Review and approve" }).click();
  const confirmation = page.locator(
    '[data-testid="proposal-approval-confirmation"]',
  );
  await expect(confirmation).toContainText("change-immutable-1");
  await confirmation
    .getByRole("button", { name: "Approve exact change ID" })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(proposal).toContainText("approved");
  await expect(
    proposal.getByRole("button", { name: "Review and approve" }),
  ).toHaveCount(0);
});

test("shows authorization, policy, approval, and application security audit history", async ({
  page,
}) => {
  const modal = await openManagementMcp(page);
  await modal.getByRole("button", { name: "Audit" }).click();
  await expect(modal).toContainText("authorization.denied");
  await expect(modal).toContainText("worker.stop");
  await expect(modal).toContainText("failure");
  await expect(
    modal.getByRole("button", { name: "Refresh audit" }),
  ).toBeVisible();
});
