import { test, expect } from '@playwright/test';
import { goToDashboard, selectSidebarTab, expectSidebarTabExists } from '../helpers/ui-helpers';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { ApiClient } from '../helpers/api-client';

test.describe('Stopped Workers Tab', () => {
  test('Stopped tab is visible in the sidebar', async ({ page }) => {
    await goToDashboard(page);
    await expectSidebarTabExists(page, 'Stopped');
  });

  test('Stopped tab is positioned before Archived', async ({ page }) => {
    await goToDashboard(page);
    // Both tabs render in the inline tab bar; Stopped must come first.
    const labels = page.locator('aside .sidebar-tab-bar > .sidebar-tab .sidebar-tab-label');
    const texts = await labels.allTextContents();
    const stoppedIdx = texts.findIndex((t) => t.trim() === 'Stopped');
    const archivedIdx = texts.findIndex((t) => t.trim() === 'Archived');
    expect(stoppedIdx).toBeGreaterThan(-1);
    expect(archivedIdx).toBeGreaterThan(-1);
    expect(stoppedIdx).toBeLessThan(archivedIdx);
  });

  test.describe.serial('With a stopped worker', () => {
    let containerId: string;
    let displayName: string;

    test.beforeAll(async ({ request }) => {
      displayName = `Stopped-${Date.now()}`;
      const container = await createWorker(request, { displayName });
      containerId = container.id;
      const api = new ApiClient(request);
      await api.stopContainer(containerId);
    });

    test.afterAll(async ({ request }) => {
      if (containerId) await cleanupWorker(request, containerId);
    });

    test('stopped worker appears in the Stopped tab, not the Workers tab', async ({ page }) => {
      await goToDashboard(page);

      // Workers tab lists non-stopped workers only — ours must be absent.
      await selectSidebarTab(page, 'Workers');
      await expect(page.locator('aside').locator(`h3:has-text("${displayName}")`)).toHaveCount(0, {
        timeout: 15_000,
      });

      // Stopped tab shows the card with a "stopped" status badge. Match the
      // badge exactly — the display name ("Stopped-…") also contains "stopped".
      await selectSidebarTab(page, 'Stopped');
      const card = page.locator('aside .rounded-lg').filter({ hasText: displayName }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByText('stopped', { exact: true })).toBeVisible();
    });

    test('restarting from the Stopped tab moves the worker back to Workers', async ({ page, request }) => {
      const api = new ApiClient(request);
      await api.restartContainer(containerId);

      await goToDashboard(page);
      // Now running — must show in Workers and not in Stopped.
      await selectSidebarTab(page, 'Workers');
      const card = page.locator('aside .rounded-lg').filter({ hasText: displayName }).first();
      await expect(card).toBeVisible({ timeout: 60_000 });

      await selectSidebarTab(page, 'Stopped');
      await expect(page.locator('aside').locator(`h3:has-text("${displayName}")`)).toHaveCount(0, {
        timeout: 15_000,
      });
    });
  });
});
