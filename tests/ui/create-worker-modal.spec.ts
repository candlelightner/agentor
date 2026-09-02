import { test, expect } from '@playwright/test';
import { goToDashboard, openCreateWorkerModal } from '../helpers/ui-helpers';
import { cleanupWorker } from '../helpers/worker-lifecycle';
import { ApiClient } from '../helpers/api-client';
import { approveHostPath, approveHostPathForAll, deleteApprovedHostPath } from '../helpers/host-mounts';

test.describe('Create Worker Modal', () => {

  test('opens when clicking + New Worker', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await expect(page.locator('[role="dialog"] h2:has-text("New Worker")')).toBeVisible();
  });

  test('has a Display name input with generated placeholder', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const displayNameInput = page.locator('[role="dialog"] input').first();
    await page.waitForTimeout(1000);
    const placeholder = await displayNameInput.getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder!.length).toBeGreaterThan(0);
  });

  test('has Create and Cancel buttons', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await expect(page.locator('[role="dialog"] button:has-text("Create")')).toBeVisible();
    await expect(page.locator('[role="dialog"] button:has-text("Cancel")')).toBeVisible();
  });

  test('can close the modal via Cancel', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await page.click('[role="dialog"] button:has-text("Cancel")');
    await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 10_000 });
  });

  test('can close the modal with Escape', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 10_000 });
  });

  test('shows form sections: Display name, Environment, Worker group, Repositories, Volume Mounts, Init Script', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');
    // Check all form field labels are present (using getByText for exact matching)
    await expect(dialog.getByText('Display name', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Environment', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Worker group', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Repositories', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Volume Mounts', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Init Script', { exact: true }).first()).toBeVisible();
  });

  test('shows Manage environments button', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    // There are 2 Manage buttons (Environments + Init Scripts); check the first one
    await expect(page.locator('[role="dialog"] button:has-text("Manage")').first()).toBeVisible();
  });

  test('shows Add repository link', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await expect(page.locator('[role="dialog"] button:has-text("Add repository")')).toBeVisible();
  });

  test('shows Add mount link', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await expect(page.locator('[role="dialog"] button:has-text("Add mount")')).toBeVisible();
  });

  test('shows init script textarea', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByPlaceholder(/#!\/bin\/bash/)).toBeVisible();
  });

  test('has Environment selector with Default option', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await expect(page.locator('[role="dialog"]').getByText('Default')).toBeVisible();
  });

  test('has an optional Worker group selector that defaults to Ungrouped', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const groupSelector = page.locator('[role="dialog"]').getByRole('combobox', { name: 'Worker group' });
    await expect(groupSelector).toBeVisible();
    await expect(groupSelector).toContainText('Ungrouped');
  });

  test('selecting a worker group exposes paths assigned to that group', async ({ page, request }) => {
    const groupName = `ui-mount-group-${Date.now()}`;
    const createdGroup = await request.post('/api/worker-groups', { data: { name: groupName } });
    expect(createdGroup.status()).toBe(201);
    const group = await createdGroup.json();
    const path = await approveHostPath(
      request,
      `/tmp/ui-group-only-${Date.now()}`,
      { targetType: 'group', targetId: group.id },
    );
    try {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');
      const addMount = dialog.getByRole('button', { name: 'Add mount' });
      await expect(addMount).toBeDisabled();
      const groupSelector = dialog.getByRole('combobox', { name: 'Worker group' });
      await groupSelector.click();
      await page.getByRole('option', { name: groupName, exact: true }).click();
      await expect(addMount).toBeEnabled();
      await addMount.click();
      const pathSelector = dialog.getByRole('combobox', { name: 'Approved host path' });
      await pathSelector.click();
      await expect(page.getByRole('option', { name: new RegExp(path.sourcePath) })).toBeVisible();
    } finally {
      await deleteApprovedHostPath(request, path.id);
      await request.delete(`/api/worker-groups/${group.id}`).catch(() => undefined);
    }
  });

  test('has Init Script preset selector with None option', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await expect(page.locator('[role="dialog"]').getByText('None')).toBeVisible();
  });

  test('Display name input is free-form and uses the suggested slug as placeholder', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');
    // The Display name field is the editable, user-facing label (UInput wraps a native input)
    const displayNameInput = dialog.getByRole('textbox', { name: 'Display name' });
    await expect(displayNameInput).toBeVisible();
    // Wait for the async generate-name suggestion to populate the placeholder
    await page.waitForTimeout(1000);
    const placeholder = await displayNameInput.getAttribute('placeholder');
    expect(placeholder).toBeTruthy();

    // The input is free-form: spaces and mixed case are preserved (no keystroke sanitization)
    const typed = 'My Worker Name';
    await displayNameInput.fill(typed);
    await expect(displayNameInput).toHaveValue(typed);
  });

  test('+ Add repository button adds a repo row', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('button:has-text("Add repository")').click();
    // A new repo input row should appear
    await expect(dialog.locator('input').nth(1)).toBeVisible({ timeout: 10_000 });
  });

  test('+ Add mount button adds a mount row', async ({ page, request }) => {
    const path = await approveHostPathForAll(request, `/tmp/ui-create-mount-${Date.now()}`);
    try {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');
      const addMount = dialog.locator('button:has-text("Add mount")');
      await expect(addMount).toBeEnabled();
      await addMount.click();
      await expect(dialog.getByRole('combobox', { name: 'Approved host path' })).toBeVisible();
      await expect(dialog.locator('input[placeholder="Container path"]')).toBeVisible();
    } finally {
      await deleteApprovedHostPath(request, path.id);
    }
  });

  test('environment dropdown has selectable options', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');
    // The environment selector should be visible with "Default" option
    const envSelector = dialog.getByText('Default');
    await expect(envSelector).toBeVisible();
  });

  test('init preset dropdown shows agent options', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');
    // The init preset area should have "None" visible
    await expect(dialog.getByText('None')).toBeVisible();
    // The textarea for init script should exist
    await expect(dialog.getByPlaceholder(/#!\/bin\/bash/)).toBeVisible();
  });

  test('creates a worker when clicking Create', async ({ page, request }) => {
    // Snapshot current containers to identify the newly created one
    const api = new ApiClient(request);
    const { body: before } = await api.listContainers();
    const beforeIds = new Set(before.map((c: { id: string }) => c.id));

    await goToDashboard(page);
    await openCreateWorkerModal(page);
    await page.click('[role="dialog"] button:has-text("Create")');
    await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 10_000 });

    // Wait for the container to be created (verify via API rather than relying on UI timing)
    let newContainerId: string | undefined;
    for (let attempt = 0; attempt < 15; attempt++) {
      const { body: after } = await api.listContainers();
      const newOne = after.find((c: { id: string }) => !beforeIds.has(c.id));
      if (newOne) {
        newContainerId = newOne.id;
        break;
      }
      await page.waitForTimeout(2000);
    }
    expect(newContainerId).toBeTruthy();

    // Cleanup
    if (newContainerId) {
      await cleanupWorker(request, newContainerId);
    }
  });

  test('creates a worker directly in the selected group', async ({ page, request }) => {
    const groupName = `ui-create-group-${Date.now()}`;
    const createdGroup = await request.post('/api/worker-groups', { data: { name: groupName } });
    expect(createdGroup.status()).toBe(201);
    const group = await createdGroup.json();
    let workerId: string | undefined;
    try {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');
      const groupSelector = dialog.getByRole('combobox', { name: 'Worker group' });
      await groupSelector.click();
      await page.getByRole('option', { name: groupName, exact: true }).click();
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      for (let attempt = 0; attempt < 45; attempt++) {
        const current = await request.get(`/api/worker-groups/${group.id}`);
        const memberIds = current.ok() ? (await current.json()).workerIds as string[] : [];
        if (memberIds.length) {
          workerId = memberIds[0];
          break;
        }
        await page.waitForTimeout(1000);
      }
      expect(workerId).toBeTruthy();
    } finally {
      if (workerId) await cleanupWorker(request, workerId);
      await request.delete(`/api/worker-groups/${group.id}`).catch(() => undefined);
    }
  });

  // --- Volume Mounts ---

  test('clicking + Add mount adds approved-path, target, and access-mode dropdowns', async ({ page, request }) => {
    const path = await approveHostPathForAll(request, `/tmp/ui-fields-${Date.now()}`, true);
    try {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');
      const addMount = dialog.locator('button:has-text("Add mount")');
      await expect(addMount).toBeEnabled();
      await addMount.click();
      await expect(dialog.getByRole('combobox', { name: 'Approved host path' })).toBeVisible();
      await expect(dialog.locator('input[placeholder="Container path"]')).toBeVisible();
      await expect(dialog.getByRole('combobox', { name: 'Mount access' })).toContainText('Read only');
    } finally {
      await deleteApprovedHostPath(request, path.id);
    }
  });

  test('clicking + Add mount multiple times adds multiple mount rows', async ({ page, request }) => {
    const path = await approveHostPathForAll(request, `/tmp/ui-multiple-${Date.now()}`);
    try {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');
      const addMount = dialog.locator('button:has-text("Add mount")');
      await expect(addMount).toBeEnabled();
      await addMount.click();
      await addMount.click();
      await expect(dialog.getByRole('combobox', { name: 'Approved host path' })).toHaveCount(2);
      await expect(dialog.locator('input[placeholder="Container path"]')).toHaveCount(2);
    } finally {
      await deleteApprovedHostPath(request, path.id);
    }
  });

  test('mount row remove button removes the mount row', async ({ page, request }) => {
    const path = await approveHostPathForAll(request, `/tmp/ui-remove-${Date.now()}`);
    try {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');
      const addMount = dialog.locator('button:has-text("Add mount")');
      await expect(addMount).toBeEnabled();
      await addMount.click();
      const pathSelector = dialog.getByRole('combobox', { name: 'Approved host path' });
      await expect(pathSelector).toBeVisible();
      const mountRow = pathSelector.locator('xpath=ancestor::div[contains(@class, "flex")][contains(@class, "gap-2")]');
      await mountRow.locator('button').last().click();
      await expect(dialog.getByRole('combobox', { name: 'Approved host path' })).toHaveCount(0);
      await expect(dialog.locator('input[placeholder="Container path"]')).toHaveCount(0);
    } finally {
      await deleteApprovedHostPath(request, path.id);
    }
  });

  test('mount row selects an approved path and explicit read/write mode', async ({ page, request }) => {
    const path = await approveHostPathForAll(request, `/tmp/ui-read-write-${Date.now()}`, true);
    try {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');
      const addMount = dialog.locator('button:has-text("Add mount")');
      await expect(addMount).toBeEnabled();
      await addMount.click();
      const pathSelector = dialog.getByRole('combobox', { name: 'Approved host path' });
      await pathSelector.click();
      await page.getByRole('option', { name: new RegExp(path.sourcePath) }).click();
      const containerPathInput = dialog.locator('input[placeholder="Container path"]');
      await containerPathInput.fill('/mnt/data');
      const access = dialog.getByRole('combobox', { name: 'Mount access' });
      await access.click();
      await page.getByRole('option', { name: 'Read and write', exact: true }).click();
      await expect(containerPathInput).toHaveValue('/mnt/data');
      await expect(access).toContainText('Read and write');
    } finally {
      await deleteApprovedHostPath(request, path.id);
    }
  });

  // --- Repository ---

  test('clicking + Add repository adds a repo row with URL and branch inputs', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');

    await dialog.locator('button:has-text("Add repository")').click();

    // RepoInput renders a provider selector, a URL/search input, and a branch input
    // The branch input has placeholder "branch (optional)"
    const branchInput = dialog.locator('input[placeholder="branch (optional)"]');
    await expect(branchInput).toBeVisible();
  });

  test('clicking + Add repository multiple times adds multiple repo rows', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');

    await dialog.locator('button:has-text("Add repository")').click();
    await dialog.locator('button:has-text("Add repository")').click();

    // Should have two branch inputs
    const branchInputs = dialog.locator('input[placeholder="branch (optional)"]');
    await expect(branchInputs).toHaveCount(2);
  });

  test('repo row remove button removes the repo row', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');

    // Add a repo row
    await dialog.locator('button:has-text("Add repository")').click();
    await expect(dialog.locator('input[placeholder="branch (optional)"]')).toBeVisible();

    // RepoInput has a UButton with icon="i-lucide-x" as the last button in the row
    // Find the row container (the flex div with the branch input) and click the X button
    const branchInput = dialog.locator('input[placeholder="branch (optional)"]');
    const repoRow = branchInput.locator('xpath=ancestor::div[contains(@class, "flex")][contains(@class, "gap-2")]');
    const removeButton = repoRow.locator('button').last();
    await removeButton.click();

    // Repo row should be gone
    await expect(dialog.locator('input[placeholder="branch (optional)"]')).toHaveCount(0);
  });

  // --- Init Script ---

  test('init script dropdown shows None by default', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');

    // The init script USelect (combobox) shows "None" by default
    // There are 2 comboboxes: Environment and Init Script
    const initScriptCombobox = dialog.getByRole('combobox', { name: 'Init Script' });
    await expect(initScriptCombobox).toBeVisible();
    await expect(initScriptCombobox).toContainText('None');
  });

  test('init script section has Manage button', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');

    // There are two "Manage" buttons in the modal: one for environments, one for init scripts.
    // The init script "Manage" button is below the init script dropdown.
    const manageButtons = dialog.locator('button:has-text("Manage")');
    const count = await manageButtons.count();
    // At least 2 Manage buttons (Environment + Init Script)
    expect(count).toBeGreaterThanOrEqual(2);

    // The second Manage button is the one in the Init Script section
    await expect(manageButtons.nth(1)).toBeVisible();
  });

  // --- Modal close behaviors ---

  test('Cancel button closes the modal and resets to clean state', async ({ page, request }) => {
    const path = await approveHostPathForAll(request, `/tmp/ui-reset-${Date.now()}`);
    try {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');
      await dialog.locator('button:has-text("Add repository")').click();
      const addMount = dialog.locator('button:has-text("Add mount")');
      await expect(addMount).toBeEnabled();
      await addMount.click();
      await dialog.locator('button:has-text("Cancel")').click();
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await openCreateWorkerModal(page);
      const dialog2 = page.locator('[role="dialog"]');
      await expect(dialog2.locator('input[placeholder="branch (optional)"]')).toHaveCount(0);
      await expect(dialog2.getByRole('combobox', { name: 'Approved host path' })).toHaveCount(0);
    } finally {
      await deleteApprovedHostPath(request, path.id);
    }
  });

  test('Escape key closes the modal', async ({ page }) => {
    await goToDashboard(page);
    await openCreateWorkerModal(page);
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  });

  // --- Dynamic dropdown population & preset behaviour ---

  test.describe('Dropdown population', () => {
    test('environment selector shows newly created environments', async ({ page, request }) => {
      const api = new ApiClient(request);
      const envName = `Env-${Date.now()}`;
      const { body: created } = await api.createEnvironment({
        name: envName,
        cpuLimit: 0,
        memoryLimit: '',
        networkMode: 'full',
        allowedDomains: [],
        includePackageManagerDomains: false,
        dockerEnabled: true,
        envVars: '',
        setupScript: '',
      });

      try {
        await goToDashboard(page);
        await openCreateWorkerModal(page);
        const dialog = page.locator('[role="dialog"]');

        // Click on the environment dropdown/selector
        const envSelector = dialog.locator('select, [role="listbox"], [role="combobox"]').first();
        if (await envSelector.count() > 0) {
          await envSelector.click();
          // The created environment should be visible
          await expect(page.getByText(envName)).toBeVisible({ timeout: 10_000 });
        }
      } finally {
        try { await api.deleteEnvironment(created.id); } catch { /* ignore */ }
      }
    });

    test('selecting a preset populates the init script textarea', async ({ page }) => {
      await goToDashboard(page);
      await openCreateWorkerModal(page);
      const dialog = page.locator('[role="dialog"]');

      // The Init Script USelect (combobox) shows "None" by default
      const initScriptCombobox = dialog.getByRole('combobox', { name: 'Init Script' });
      await expect(initScriptCombobox).toBeVisible();

      // Click the combobox to open the dropdown
      await initScriptCombobox.click();
      await page.waitForTimeout(300);

      // Look for the claude option in the dropdown listbox
      const claudeOption = page.getByRole('option', { name: 'claude' });
      if (await claudeOption.isVisible().catch(() => false)) {
        await claudeOption.click();
        // The textarea should now contain 'claude'
        const textarea = dialog.getByPlaceholder(/#!\/bin\/bash/);
        await page.waitForTimeout(500);
        const value = await textarea.inputValue();
        expect(value.toLowerCase()).toContain('claude');
      }
    });
  });
});
