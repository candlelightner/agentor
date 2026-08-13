import { test, expect } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { captureCommandOutput } from '../helpers/terminal-ws';

test.describe('Import worker modal', () => {
  test('opens from the sidebar Import button with file + name inputs', async ({ page }) => {
    await goToDashboard(page);
    await page.click('button[aria-label="Import worker"]');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText('Import Worker');
    await expect(dialog.locator('[data-testid="import-file"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="import-name"]')).toBeVisible();

    // Import is disabled until a bundle is chosen.
    await expect(dialog.locator('[data-testid="import-submit"]')).toBeDisabled();
  });

  test('choosing a bundle file enables Import', async ({ page }) => {
    await goToDashboard(page);
    await page.click('button[aria-label="Import worker"]');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await dialog.locator('[data-testid="import-file"]').setInputFiles({
      name: 'worker-export.tar',
      mimeType: 'application/x-tar',
      buffer: Buffer.from('dummy-bundle-contents'),
    });

    await expect(dialog.locator('[data-testid="import-submit"]')).toBeEnabled();
    await expect(dialog).toContainText('worker-export.tar');
  });

  test('real browser imports a completed workspace export into a new worker', async ({ page, request }) => {
    test.setTimeout(240_000);
    const source = await createWorker(request, { displayName: `Import-source-${Date.now()}` });
    const importedName = `Import-browser-${Date.now()}`;
    const marker = `IMPORT_BROWSER_${Date.now()}`;
    let importedId = '';
    try {
      await captureCommandOutput(source.id, `printf %s ${marker} > /workspace/import-browser-marker`, 30_000);
      const api = new ApiClient(request);
      const created = await api.createExportJob(source.id, false);
      expect(created.status).toBe(202);
      let status: any;
      await expect.poll(async () => (status = (await api.getExportJob(created.body.id)).body).status,
        { timeout: 120_000 }).toBe('succeeded');
      const artifact = await request.get(`/api/export-jobs/${created.body.id}/download`);
      expect(artifact.status()).toBe(200);

      await goToDashboard(page);
      await page.click('button[aria-label="Import worker"]');
      const dialog = page.locator('[role="dialog"]');
      await dialog.locator('[data-testid="import-file"]').setInputFiles({
        name: 'worker-export.tar', mimeType: 'application/x-tar', buffer: await artifact.body(),
      });
      await dialog.locator('[data-testid="import-name"]').fill(importedName);
      await dialog.locator('[data-testid="import-submit"]').click();
      await expect(dialog).toBeHidden({ timeout: 120_000 });
      await expect(page.getByText(importedName, { exact: true })).toBeVisible({ timeout: 60_000 });
      const workers = await (await request.get('/api/containers')).json();
      importedId = workers.find((worker: any) => worker.displayName === importedName)?.id || '';
      expect(importedId).toBeTruthy();
      expect(await captureCommandOutput(importedId, 'cat /workspace/import-browser-marker', 30_000)).toContain(marker);
    } finally {
      if (importedId) await cleanupWorker(request, importedId).catch(() => {});
      await cleanupWorker(request, source.id);
    }
  });
});
