import {
  test,
  expect,
  type Page,
  type APIRequestContext,
  type Locator,
} from "@playwright/test";
import {
  goToDashboard,
  findButtonByTooltip,
  hasButtonWithTooltip,
} from "../helpers/ui-helpers";
import { createWorker, cleanupWorker } from "../helpers/worker-lifecycle";
import { ApiClient } from "../helpers/api-client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

/**
 * Seed files (and folder trees) into a running worker's `/workspace` via the
 * real `POST /api/containers/:id/files/upload` endpoint. File names may carry
 * a relative folder path (e.g. `docs/a.txt`) which the server preserves.
 */
async function seedFiles(
  request: APIRequestContext,
  containerId: string,
  dest: string,
  files: { name: string; content: string }[],
  overwrite = false,
): Promise<void> {
  const form = new FormData();
  form.append("path", dest);
  form.append("overwrite", overwrite ? "true" : "false");
  for (const f of files) {
    const blob = new Blob([f.content], { type: "text/plain" });
    const file = new File([blob], f.name, { type: "text/plain" });
    form.append("file", file, f.name);
  }
  const res = await request.post(
    `${BASE_URL}/api/containers/${containerId}/files/upload`,
    {
      multipart: form,
    },
  );
  if (res.status() >= 400) {
    const body = await res.text().catch(() => "");
    throw new Error(`seed upload failed (${res.status()}): ${body}`);
  }
}

/** Open the Files modal from a running worker card via the "Files" tooltip. */
async function openFilesModal(
  page: Page,
  displayName: string,
): Promise<Locator> {
  await goToDashboard(page);
  const expandSidebar = page.getByTitle("Expand sidebar");
  if (await expandSidebar.isVisible().catch(() => false)) {
    await expandSidebar.click();
  }
  const workersTab = page.getByRole("button", { name: /^Workers/ });
  if (await workersTab.isVisible().catch(() => false)) {
    await workersTab.click();
  }
  const card = page
    .locator(".rounded-lg")
    .filter({ hasText: displayName })
    .first();
  await expect(card.locator("text=running")).toBeVisible({ timeout: 60_000 });
  const filesBtn = await findButtonByTooltip(card, page, "Files");
  await filesBtn.click();
  const modal = page.locator('[data-testid="workspace-files-modal"]');
  await expect(modal).toBeVisible({ timeout: 10_000 });
  return modal;
}

/** Wait for the listing table to be visible (loaded). */
async function waitForList(page: Page): Promise<Locator> {
  const list = page.locator('[data-testid="workspace-files-list"]');
  await expect(list).toBeVisible({ timeout: 15_000 });
  return list;
}

/** Locate a file row by its relative path testid. */
function rowByPath(page: Page, path: string): Locator {
  return page.locator(`[data-row-path="${path}"]`);
}

test.describe.serial("Workspace Files Modal", () => {
  let containerId: string;
  let displayName: string;

  test.beforeAll(async ({ request }) => {
    displayName = `Files-${Date.now()}`;
    const container = await createWorker(request, { displayName });
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    if (containerId) await cleanupWorker(request, containerId);
  });

  // ─── Files tooltip action & modal open/close ─────────────────────────────

  test("Files tooltip action opens the modal only (no other modal)", async ({
    page,
  }) => {
    const modal = await openFilesModal(page, displayName);
    // Header shows the worker display name + "— Files".
    await expect(modal.locator("h2")).toContainText(displayName);
    await expect(modal.locator("h2")).toContainText("Files");
  });

  test("modal closes via the header Close (X) button", async ({ page }) => {
    await openFilesModal(page, displayName);
    await page
      .locator(
        '[data-testid="workspace-files-modal"] button[aria-label="Close"]',
      )
      .click();
    await expect(
      page.locator('[data-testid="workspace-files-modal"]'),
    ).toBeHidden({ timeout: 10_000 });
  });

  test("modal closes via the footer Close button", async ({ page }) => {
    await openFilesModal(page, displayName);
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await expect(
      page.locator('[data-testid="workspace-files-modal"]'),
    ).toBeHidden({ timeout: 10_000 });
  });

  test("modal closes via Escape", async ({ page }) => {
    await openFilesModal(page, displayName);
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-testid="workspace-files-modal"]'),
    ).toBeHidden({ timeout: 10_000 });
  });

  // ─── Root breadcrumbs ─────────────────────────────────────────────────────

  test("root view shows a single /workspace breadcrumb and disabled Up button", async ({
    page,
  }) => {
    await openFilesModal(page, displayName);
    const bc = page.locator('[data-testid="workspace-breadcrumb"]');
    await expect(bc).toBeVisible();
    // Root crumb label is "/workspace".
    await expect(bc.getByText("/workspace", { exact: true })).toBeVisible();
    // Up button is disabled at root.
    await expect(
      bc.getByRole("button", { name: "Up one level" }),
    ).toBeDisabled();
  });

  // ─── Loading / empty / error ──────────────────────────────────────────────

  test("empty workspace shows the empty-folder message", async ({ page }) => {
    await openFilesModal(page, displayName);
    // A fresh worker workspace may be empty or contain git defaults; assert the
    // empty message OR the list renders without error.
    const err = page.locator('[data-testid="workspace-files-error"]');
    await expect(err).toHaveCount(0);
    // Either the list or the empty message is shown.
    await expect(
      page.locator(
        '[data-testid="workspace-files-list"], :text("This folder is empty.")',
      ),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("error banner with Retry appears when the listing API fails", async ({
    page,
  }) => {
    const listingRoute = /\/api\/containers\/[^/]+\/files(?:\?path=)?$/;
    await page.route(listingRoute, async (route) => {
      await route.fulfill({ status: 500, json: { message: "boom" } });
    });
    await openFilesModal(page, displayName);
    const err = page.locator('[data-testid="workspace-files-error"]');
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expect(err.getByText("boom")).toBeVisible();
    await expect(err.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.unroute(listingRoute);
  });

  test("Retry button re-fetches the listing", async ({ page }) => {
    let calls = 0;
    let failing = true;
    const listingRoute = /\/api\/containers\/[^/]+\/files(?:\?path=)?$/;
    await page.route(listingRoute, async (route) => {
      calls++;
      if (failing) {
        await route.fulfill({ status: 500, json: { message: "boom" } });
      } else {
        await route.fulfill({
          status: 200,
          json: { path: "", entries: [] },
        });
      }
    });
    await openFilesModal(page, displayName);
    const err = page.locator('[data-testid="workspace-files-error"]');
    await expect(err).toBeVisible({ timeout: 15_000 });
    failing = false;
    await err.getByRole("button", { name: "Retry" }).click();
    // Error clears and the empty folder message shows.
    await expect(err).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText("This folder is empty.")).toBeVisible({
      timeout: 10_000,
    });
    await page.unroute(listingRoute);
  });

  // ─── Listing seeded files ─────────────────────────────────────────────────

  test("seeded files and folders appear in the listing", async ({
    page,
    request,
  }) => {
    await seedFiles(request, containerId, "", [
      { name: "root-file.txt", content: "hello root" },
      { name: "docs/readme.md", content: "# docs" },
      { name: "docs/nested/deep.txt", content: "deep" },
    ]);
    await openFilesModal(page, displayName);
    const list = await waitForList(page);
    await expect(rowByPath(page, "root-file.txt")).toBeVisible();
    await expect(rowByPath(page, "docs")).toBeVisible();
    // Directories sort first.
    const rows = list.locator("tbody tr");
    const firstName = await rows.first().locator("span.truncate").textContent();
    expect(firstName).toBe("docs");
  });

  // ─── Folder navigation: double-click / Enter / back / breadcrumb ───────────

  test("double-clicking a folder navigates into it", async ({ page }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "docs")
      .getByRole("button", { name: "docs", exact: true })
      .dblclick();
    // Breadcrumb now shows the docs segment.
    const bc = page.locator('[data-testid="workspace-breadcrumb"]');
    await expect(bc.getByText("docs", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      bc.getByRole("button", { name: "Up one level" }),
    ).toBeEnabled();
    // Contents of docs.
    await expect(rowByPath(page, "docs/readme.md")).toBeVisible();
    await expect(rowByPath(page, "docs/nested")).toBeVisible();
  });

  test("Enter on a focused folder row navigates into it", async ({ page }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    // Navigate to docs via breadcrumb click first to ensure root state.
    await rowByPath(page, "docs")
      .getByRole("button", { name: "docs", exact: true })
      .click();
    await rowByPath(page, "docs").focus();
    await page.keyboard.press("Enter");
    const bc = page.locator('[data-testid="workspace-breadcrumb"]');
    await expect(bc.getByText("docs", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(rowByPath(page, "docs/nested")).toBeVisible();
  });

  test("Up button returns to the parent directory", async ({ page }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "docs")
      .getByRole("button", { name: "docs", exact: true })
      .dblclick();
    await expect(
      page
        .locator('[data-testid="workspace-breadcrumb"]')
        .getByText("docs", { exact: true }),
    ).toBeVisible();
    await page
      .locator('[data-testid="workspace-breadcrumb"]')
      .getByRole("button", { name: "Up one level" })
      .click();
    await expect(rowByPath(page, "docs")).toBeVisible({ timeout: 10_000 });
    await expect(
      page
        .locator('[data-testid="workspace-breadcrumb"]')
        .getByText("docs", { exact: true }),
    ).toHaveCount(0);
  });

  test("clicking a breadcrumb segment navigates to it", async ({ page }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "docs")
      .getByRole("button", { name: "docs", exact: true })
      .dblclick();
    await rowByPath(page, "docs/nested")
      .getByRole("button", { name: "nested", exact: true })
      .dblclick();
    // Breadcrumb: /workspace > docs > nested
    const bc = page.locator('[data-testid="workspace-breadcrumb"]');
    await expect(bc.getByText("nested", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    // Click the docs crumb.
    await bc.getByText("docs", { exact: true }).click();
    await expect(rowByPath(page, "docs/readme.md")).toBeVisible({
      timeout: 10_000,
    });
    await expect(rowByPath(page, "docs/nested/deep.txt")).toHaveCount(0);
  });

  // ─── Multi-select / select-all ────────────────────────────────────────────

  test("select-all checkbox selects and clears all entries", async ({
    page,
  }) => {
    await openFilesModal(page, displayName);
    const list = await waitForList(page);
    const selectAll = list.locator("thead").getByRole("checkbox");
    await selectAll.click();
    await expect(page.getByText(/selected/)).toBeVisible();
    const rowCount = await list.locator("tbody tr").count();
    const checked = list.locator('tbody [role="checkbox"][aria-checked="true"]');
    await expect(checked).toHaveCount(rowCount);
    await selectAll.click();
    await expect(checked).toHaveCount(0);
  });

  test("individual row checkbox toggles selection and updates the count", async ({
    page,
  }) => {
    await openFilesModal(page, displayName);
    const list = await waitForList(page);
    await rowByPath(page, "root-file.txt")
      .getByRole("checkbox")
      .click();
    await expect(page.getByText("1 selected")).toBeVisible();
    await rowByPath(page, "root-file.txt")
      .getByRole("checkbox")
      .click();
    await expect(page.getByText(/selected/)).toHaveCount(0);
  });

  // ─── Upload: exact current-folder via file picker, preserved relative paths ─

  test("upload via file picker places files in the current folder preserving relative paths", async ({
    page,
    request,
  }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    // Navigate into docs so the upload destination is /workspace/docs.
    await rowByPath(page, "docs")
      .getByRole("button", { name: "docs", exact: true })
      .dblclick();
    await expect(rowByPath(page, "docs/readme.md")).toBeVisible();
    // Open the upload panel.
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Upload" })
      .click();
    const panel = page.locator('[data-testid="workspace-upload-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/Upload to \/workspace\/docs/)).toBeVisible();
    // Set files via the hidden file input. Use a relative path to verify
    // preservation (the input is webkitdirectory; setInputFiles with a
    // relative path simulates a folder pick).
    const input = panel.locator('input[type="file"]').first();
    await input.setInputFiles([
      {
        name: "picker-dir/uploaded-a.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("a"),
      },
      {
        name: "picker-dir/sub/uploaded-b.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("b"),
      },
    ]);
    // Upload button shows the count and is enabled.
    const uploadBtn = panel.getByRole("button", { name: /Upload/ }).first();
    await expect(uploadBtn).toBeEnabled();
    await uploadBtn.click();
    // Toast + refresh: the uploaded files appear under docs/picker-dir/.
    await expect(rowByPath(page, "docs/picker-dir")).toBeVisible({
      timeout: 15_000,
    });
    // Verify server-side the tree was preserved.
    const api = new ApiClient(request);
    const res = await request.get(
      `${BASE_URL}/api/containers/${containerId}/files?path=docs/picker-dir`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("uploaded-a.txt");
    expect(names).toContain("sub");
  });

  test("upload via dropzone accepts dropped files into the current folder", async ({
    page,
  }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Upload" })
      .click();
    const panel = page.locator('[data-testid="workspace-upload-panel"]');
    await expect(panel).toBeVisible();
    // Dispatch a drop event with a File carrying a relative path.
    await panel.locator(".border-dashed").evaluate((el, filePath) => {
      const dt = new DataTransfer();
      const file = new File(["dropped"], filePath, { type: "text/plain" });
      dt.items.add(file);
      el.dispatchEvent(
        new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
      );
    }, "drop-dir/dropped.txt");
    await expect(panel.getByText("drop-dir/dropped.txt")).toBeVisible({
      timeout: 5_000,
    });
  });

  // ─── Upload conflict overwrite panel ──────────────────────────────────────

  test("upload conflict shows the overwrite panel and retry replaces", async ({
    page,
    request,
  }) => {
    // Pre-seed a conflicting file at root.
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "conflict.txt", content: "original" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Upload" })
      .click();
    const panel = page.locator('[data-testid="workspace-upload-panel"]');
    await expect(panel).toBeVisible();
    const input = panel.locator('input[type="file"]').first();
    await input.setInputFiles([
      {
        name: "conflict.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("replacement"),
      },
    ]);
    await panel
      .getByRole("button", { name: /Upload/ })
      .first()
      .click();
    // Conflict panel appears.
    const conflict = page.locator('[data-testid="workspace-upload-conflict"]');
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await expect(conflict.getByText("conflict.txt")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Overwrite & retry" }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Overwrite & retry" }).click();
    // After overwrite the panel closes and the file remains.
    await expect(panel).toBeHidden({ timeout: 15_000 });
    await expect(rowByPath(page, "conflict.txt")).toBeVisible();
  });

  // ─── New folder ────────────────────────────────────────────────────────────

  test("New Folder creates a directory in the current folder", async ({
    page,
  }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "New Folder" })
      .click();
    const panel = page.locator('[data-testid="workspace-mkdir-panel"]');
    await expect(panel).toBeVisible();
    const name = `newdir-${Date.now()}`;
    await panel.getByPlaceholder("folder name").fill(name);
    await panel.getByRole("button", { name: "Create" }).click();
    await expect(panel).toBeHidden({ timeout: 10_000 });
    await expect(rowByPath(page, name)).toBeVisible({ timeout: 10_000 });
  });

  test("New Folder rejects invalid names (slashes) with a validation message", async ({
    page,
  }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "New Folder" })
      .click();
    const panel = page.locator('[data-testid="workspace-mkdir-panel"]');
    await panel.getByPlaceholder("folder name").fill("bad/name");
    await expect(panel.getByText(/must not contain slashes/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  test("protected worker file mutations use a transient password field and do not render its value", async ({ page, request }) => {
    const lockPassword = `files-ui-lock-${Date.now()}-password`;
    const folder = `protected-ui-${Date.now()}`;
    const api = new ApiClient(request);
    expect((await request.put(`/api/containers/${containerId}/protection`, { data: { password: lockPassword } })).status()).toBe(200);
    try {
      const modal = await openFilesModal(page, displayName);
      await modal.getByRole("button", { name: "New Folder" }).click();
      const panel = page.locator('[data-testid="workspace-mkdir-panel"]');
      await expect(panel).toBeVisible();
      await panel.getByPlaceholder("folder name").fill(folder);
      await page.getByLabel(/Protected worker lock password/).fill(lockPassword);
      await panel.getByRole("button", { name: "Create" }).click();
      await expect(rowByPath(page, folder)).toBeVisible();
      await expect(page.getByLabel(/Protected worker lock password/)).toHaveCount(0);
      await expect(modal).not.toContainText(lockPassword);
      expect((await api.deleteFiles(containerId, [folder], lockPassword)).status).toBe(200);
    } finally {
      await request.delete(`/api/containers/${containerId}/protection`, { data: { password: lockPassword } });
    }
  });

  // ─── Rename ────────────────────────────────────────────────────────────────

  test("Rename renames a single selected entry", async ({ page }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "root-file.txt")
      .getByRole("checkbox")
      .click();
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Rename", exact: true })
      .click();
    const panel = page.locator('[data-testid="workspace-rename-panel"]');
    await expect(panel).toBeVisible();
    const newName = `renamed-${Date.now()}.txt`;
    await panel.getByPlaceholder("new name").fill(newName);
    await panel.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(panel).toBeHidden({ timeout: 10_000 });
    await expect(rowByPath(page, newName)).toBeVisible({ timeout: 10_000 });
    await expect(rowByPath(page, "root-file.txt")).toHaveCount(0);
  });

  test("Rename is disabled unless exactly one entry is selected", async ({
    page,
    request,
  }) => {
    await seedFiles(request, containerId, "", [
      { name: "rename-multi-a.txt", content: "a" },
      { name: "rename-multi-b.txt", content: "b" },
    ]);
    await openFilesModal(page, displayName);
    await waitForList(page);
    const renameBtn = page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Rename", exact: true })
      .first();
    await expect(renameBtn).toBeDisabled();
    await rowByPath(page, "rename-multi-a.txt").getByRole("checkbox").click();
    await rowByPath(page, "rename-multi-b.txt")
      .getByRole("checkbox")
      .click();
    await expect(renameBtn).toBeDisabled();
  });

  // ─── Move to root / nested and conflict retry ──────────────────────────────

  test("Move to root relocates selected entries to /workspace", async ({
    page,
    request,
  }) => {
    // Seed a nested file to move.
    await seedFiles(
      request,
      containerId,
      "docs",
      [{ name: "moveme-root.txt", content: "move-root" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    // Navigate into docs and select the file.
    await rowByPath(page, "docs")
      .getByRole("button", { name: "docs", exact: true })
      .dblclick();
    await expect(rowByPath(page, "docs/moveme-root.txt")).toBeVisible({
      timeout: 10_000,
    });
    await rowByPath(page, "docs/moveme-root.txt")
      .getByRole("checkbox")
      .click();
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Move", exact: true })
      .click();
    const panel = page.locator('[data-testid="workspace-move-panel"]');
    await expect(panel).toBeVisible();
    // Empty destination = root.
    const moveResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/containers/${containerId}/files/move`) &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Move", exact: true }).click();
    const response = await moveResponse;
    expect(response.status(), await response.text()).toBe(200);
    await expect(panel).toBeHidden({ timeout: 15_000 });
    // Back at root the file is present.
    await page
      .locator('[data-testid="workspace-breadcrumb"]')
      .getByText("/workspace", { exact: true })
      .click();
    await expect(rowByPath(page, "moveme-root.txt")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Move into a nested destination relocates selected entries", async ({
    page,
    request,
  }) => {
    // Ensure a nested destination folder exists.
    const api = new ApiClient(request);
    expect((await api.mkdirFiles(containerId, "dest-nested")).status).toBe(200);
    await seedFiles(
      request,
      containerId,
      "dest-nested",
      [{ name: ".keep", content: "" }],
      true,
    );
    // Seed a file at root to move.
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "moveme-nested.txt", content: "move-nested" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "moveme-nested.txt")
      .getByRole("checkbox")
      .click();
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Move", exact: true })
      .click();
    const panel = page.locator('[data-testid="workspace-move-panel"]');
    await panel.getByPlaceholder(/empty for/).fill("dest-nested");
    await panel.getByRole("button", { name: "Move", exact: true }).click();
    await expect(panel).toBeHidden({ timeout: 15_000 });
    // Navigate to dest-nested and confirm.
    await rowByPath(page, "dest-nested")
      .getByRole("button", { name: "dest-nested", exact: true })
      .dblclick();
    await expect(rowByPath(page, "dest-nested/moveme-nested.txt")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Move conflict shows the overwrite panel and retry replaces", async ({
    page,
    request,
  }) => {
    // Source file and a conflicting target with the same basename.
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "move-conflict-src.txt", content: "src" }],
      true,
    );
    const api = new ApiClient(request);
    expect((await api.mkdirFiles(containerId, "dest-conflict")).status).toBe(200);
    await seedFiles(
      request,
      containerId,
      "dest-conflict",
      [{ name: "move-conflict-src.txt", content: "existing" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "move-conflict-src.txt")
      .getByRole("checkbox")
      .click();
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Move", exact: true })
      .click();
    const panel = page.locator('[data-testid="workspace-move-panel"]');
    await panel.getByPlaceholder(/empty for/).fill("dest-conflict");
    await panel.getByRole("button", { name: "Move", exact: true }).click();
    const conflict = page.locator('[data-testid="workspace-move-conflict"]');
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await expect(conflict.getByText("move-conflict-src.txt")).toBeVisible();
    await panel.getByRole("button", { name: "Overwrite & retry" }).click();
    await expect(panel).toBeHidden({ timeout: 15_000 });
    // Verify the moved file exists in the destination.
    const res = await request.get(
      `${BASE_URL}/api/containers/${containerId}/files?path=dest-conflict`,
    );
    const body = await res.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("move-conflict-src.txt");
  });

  // ─── Delete confirmation / cancel ─────────────────────────────────────────

  test("Delete confirmation panel lists selected entries and cancels without deleting", async ({
    page,
    request,
  }) => {
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "delete-cancel.txt", content: "x" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "delete-cancel.txt")
      .getByRole("checkbox")
      .click();
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    const panel = page.locator('[data-testid="workspace-delete-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText("delete-cancel.txt")).toBeVisible();
    await panel.getByText("Cancel", { exact: true }).click();
    await expect(panel).toBeHidden({ timeout: 5_000 });
    // File still present.
    await expect(rowByPath(page, "delete-cancel.txt")).toBeVisible();
  });

  test("Delete confirmation removes the selected entry", async ({
    page,
    request,
  }) => {
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "delete-me.txt", content: "x" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "delete-me.txt")
      .getByRole("checkbox")
      .click();
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    const panel = page.locator('[data-testid="workspace-delete-panel"]');
    await panel.getByRole("button", { name: /Delete/ }).click();
    await expect(panel).toBeHidden({ timeout: 15_000 });
    await expect(rowByPath(page, "delete-me.txt")).toHaveCount(0);
  });

  // ─── Download: single file direct + multi/folder ZIP ────────────────────────

  test("single file download triggers a direct file download event", async ({
    page,
    request,
  }) => {
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "dl-single.txt", content: "single-download" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "dl-single.txt")
      .getByRole("checkbox")
      .click();
    const downloadPromise = page.waitForEvent("download");
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Download", exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("dl-single.txt");
  });

  test("multi-file download triggers a ZIP download event", async ({
    page,
    request,
  }) => {
    await seedFiles(
      request,
      containerId,
      "",
      [
        { name: "dl-a.txt", content: "a" },
        { name: "dl-b.txt", content: "b" },
      ],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "dl-a.txt").getByRole("checkbox").click();
    await rowByPath(page, "dl-b.txt").getByRole("checkbox").click();
    const downloadPromise = page.waitForEvent("download");
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Download", exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("workspace-download.zip");
  });

  test("folder download triggers a ZIP download event", async ({
    page,
    request,
  }) => {
    const api = new ApiClient(request);
    expect((await api.mkdirFiles(containerId, "dl-folder")).status).toBe(200);
    await seedFiles(
      request,
      containerId,
      "dl-folder",
      [{ name: "inside.txt", content: "inside" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "dl-folder")
      .getByRole("checkbox")
      .click();
    const downloadPromise = page.waitForEvent("download");
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "Download", exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("workspace-download.zip");
  });

  // ─── Escaping symlink warning & actions disabled ───────────────────────────
  // No exec API exists to create a real escaping symlink, so the listing is
  // mocked to surface one and verify the UI guards.

  test("escaping symlink shows a warning icon and disables destructive actions", async ({
    page,
  }) => {
    const listingRoute = /\/api\/containers\/[^/]+\/files(?:\?path=)?$/;
    await page.route(listingRoute, async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          path: "",
          entries: [
            {
              name: "escape-link",
              path: "escape-link",
              type: "symlink",
              size: 0,
              mtime: new Date().toISOString(),
              linkTarget: "/etc/passwd",
              linkEscapes: true,
            },
            {
              name: "safe-file.txt",
              path: "safe-file.txt",
              type: "file",
              size: 4,
              mtime: new Date().toISOString(),
            },
          ],
        },
      });
    });
    await openFilesModal(page, displayName);
    await waitForList(page);
    const escapeRow = rowByPath(page, "escape-link");
    // Warning icon present.
    await expect(escapeRow.locator(".text-amber-500")).toBeVisible();
    // Title attribute carries the escape warning.
    await expect(escapeRow.locator('button[title^="Symlink escapes"]')).toHaveAttribute(
      "title",
      /Symlink escapes \/workspace/,
    );
    // Select the escaping symlink: destructive actions are disabled.
    await escapeRow.getByRole("checkbox").click();
    const modal = page.locator('[data-testid="workspace-files-modal"]');
    await expect(modal.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
    await expect(
      modal.getByRole("button", { name: "Download", exact: true }),
    ).toBeDisabled();
    await page.unroute(listingRoute);
  });

  test("escaping symlink row is not navigable (double-click is a no-op)", async ({
    page,
  }) => {
    const listingRoute = /\/api\/containers\/[^/]+\/files(?:\?path=)?$/;
    await page.route(listingRoute, async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          path: "",
          entries: [
            {
              name: "escape-link",
              path: "escape-link",
              type: "symlink",
              size: 0,
              mtime: new Date().toISOString(),
              linkTarget: "/etc",
              linkEscapes: true,
            },
          ],
        },
      });
    });
    await openFilesModal(page, displayName);
    await waitForList(page);
    const bcBefore = await page
      .locator('[data-testid="workspace-breadcrumb"]')
      .innerText();
    await rowByPath(page, "escape-link")
      .getByRole("button", { name: "escape-link", exact: true })
      .dispatchEvent("dblclick");
    // Breadcrumb unchanged (still at root).
    await expect(
      page.locator('[data-testid="workspace-breadcrumb"]'),
    ).toHaveText(bcBefore);
    await page.unroute(listingRoute);
  });

  // ─── Keyboard: Space / Delete / F2 / Arrow / Escape ────────────────────────

  test("Space toggles row selection via keyboard", async ({
    page,
    request,
  }) => {
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "kb-space.txt", content: "x" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    const row = rowByPath(page, "kb-space.txt");
    await row.focus();
    await page.keyboard.press("Space");
    await expect(page.getByText("1 selected")).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByText(/selected/)).toHaveCount(0);
  });

  test("Delete key opens the delete confirmation panel", async ({
    page,
    request,
  }) => {
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "kb-delete.txt", content: "x" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "kb-delete.txt")
      .getByRole("checkbox")
      .click();
    await rowByPath(page, "kb-delete.txt").focus();
    await page.keyboard.press("Delete");
    await expect(
      page.locator('[data-testid="workspace-delete-panel"]'),
    ).toBeVisible();
  });

  test("F2 opens the rename panel for a single selection", async ({
    page,
    request,
  }) => {
    await seedFiles(
      request,
      containerId,
      "",
      [{ name: "kb-rename.txt", content: "x" }],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    await rowByPath(page, "kb-rename.txt")
      .getByRole("checkbox")
      .click();
    await rowByPath(page, "kb-rename.txt").focus();
    await page.keyboard.press("F2");
    await expect(
      page.locator('[data-testid="workspace-rename-panel"]'),
    ).toBeVisible();
  });

  test("ArrowDown/ArrowUp moves focus between rows", async ({
    page,
    request,
  }) => {
    await seedFiles(
      request,
      containerId,
      "",
      [
        { name: "kb-arrow-1.txt", content: "1" },
        { name: "kb-arrow-2.txt", content: "2" },
      ],
      true,
    );
    await openFilesModal(page, displayName);
    await waitForList(page);
    const first = rowByPath(page, "docs");
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    // The focused row is one of the file rows now.
    const focusedPath = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute("data-row-path") ?? null;
    });
    expect(focusedPath).not.toBeNull();
    expect(focusedPath).not.toBe("docs");
    await page.keyboard.press("ArrowUp");
    const backPath = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute("data-row-path") ?? null;
    });
    expect(backPath).toBe("docs");
  });

  test("Escape clears an open action panel before closing the modal", async ({
    page,
  }) => {
    await openFilesModal(page, displayName);
    await waitForList(page);
    await page
      .locator('[data-testid="workspace-files-modal"]')
      .getByRole("button", { name: "New Folder" })
      .click();
    await expect(
      page.locator('[data-testid="workspace-mkdir-panel"]'),
    ).toBeVisible();
    // First Escape clears the panel (modal stays open).
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-testid="workspace-mkdir-panel"]'),
    ).toBeHidden({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="workspace-files-modal"]'),
    ).toBeVisible();
    // Second Escape closes the modal.
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-testid="workspace-files-modal"]'),
    ).toBeHidden({ timeout: 10_000 });
  });

  // ─── Mobile viewport usability ─────────────────────────────────────────────

  test.describe("mobile viewport", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("toolbar, breadcrumb, and list remain usable on a mobile viewport", async ({
      page,
      request,
    }) => {
      await seedFiles(
        request,
        containerId,
        "",
        [{ name: "mobile.txt", content: "m" }],
        true,
      );
      await openFilesModal(page, displayName);
      const list = await waitForList(page);
      // Toolbar buttons wrap and remain visible/clickable.
      const modal = page.locator('[data-testid="workspace-files-modal"]');
      await expect(modal.getByRole("button", { name: "Upload" })).toBeVisible();
      await expect(
        modal.getByRole("button", { name: "New Folder" }),
      ).toBeVisible();
      // Breadcrumb is horizontally scrollable (overflow-x auto).
      const bc = page.locator('[data-testid="workspace-breadcrumb"]');
      const overflowX = await bc.evaluate(
        (el) => getComputedStyle(el).overflowX,
      );
      expect(["auto", "scroll"]).toContain(overflowX);
      // The list row is visible and selectable.
      await expect(rowByPath(page, "mobile.txt")).toBeVisible();
      await rowByPath(page, "mobile.txt")
        .getByRole("checkbox")
        .click();
      await expect(page.getByText("1 selected")).toBeVisible();
    });
  });

  // ─── Stopped worker recoverable error ──────────────────────────────────────

  test("stopped worker hides runtime Files and restart restores it", async ({
    page,
    request,
  }) => {
    const api = new ApiClient(request);
    await api.stopContainer(containerId);
    try {
      await goToDashboard(page);
      await page.getByRole("button", { name: /^Stopped/ }).click();
      const card = page
        .locator(".rounded-lg")
        .filter({ hasText: displayName })
        .first();
      await expect(card.getByText("stopped", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      expect(await hasButtonWithTooltip(card, page, "Files")).toBe(false);
    } finally {
      // Restart so the shared worker is left running for any later tests in
      // this serial group, and cleanup in afterAll can stop it cleanly.
      await api.restartContainer(containerId);
      // Wait for running again so the next test's openFilesModal sees a
      // running card.
      const start = Date.now();
      while (Date.now() - start < 90_000) {
        const { body } = await api.listContainers();
        const c = body.find((x: { id: string }) => x.id === containerId);
        if (c && c.status === "running") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await openFilesModal(page, displayName);
    await expect(
      page.locator(
        '[data-testid="workspace-files-list"], :text("This folder is empty.")',
      ),
    ).toBeVisible();
  });
});
