import { test, expect, type Page } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { captureCommandOutput } from '../helpers/terminal-ws';

async function selectLegacyImport(page: Page) {
  await page.getByRole('combobox', { name: 'Import worker runtime' }).click();
  await page.getByRole('option', { name: 'Legacy runc (administrator)', exact: true }).click();
}

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
    await expect(dialog.getByRole('combobox', { name: 'Import worker runtime' })).toContainText('Kata / QEMU');
  });

  test('legacy import requires administrator acknowledgement and clears it after closing', async ({ page }) => {
    let submitted: URL | undefined;
    await page.route('**/api/containers/import**', async route => {
      submitted = new URL(route.request().url());
      await route.fulfill({ status: 400, json: { statusMessage: 'Fixture recorded import' } });
    });
    await goToDashboard(page);
    await page.getByRole('button', { name: 'Import worker', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const chooseFile = () => dialog.getByTestId('import-file').setInputFiles({
      name: 'fixture.tar', mimeType: 'application/x-tar', buffer: Buffer.from('fixture'),
    });
    await chooseFile();
    await selectLegacyImport(page);
    await expect(dialog.getByTestId('import-submit')).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /I authorize legacy runc/ }).check();
    await dialog.getByTestId('import-submit').click();
    await expect.poll(() => submitted?.searchParams.get('runtimeProfile')).toBe('legacy-runc');
    expect(submitted!.searchParams.get('acknowledgeHostPrivilege')).toBe('true');
    await expect(dialog.getByTestId('import-error')).toContainText('Fixture recorded import');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Import worker', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Import worker runtime' })).toContainText('Kata / QEMU');
    await chooseFile();
    await selectLegacyImport(page);
    await expect(dialog.getByRole('checkbox', { name: /I authorize legacy runc/ })).not.toBeChecked();
    await expect(dialog.getByTestId('import-submit')).toBeDisabled();
  });

  test('ordinary-user import exposes Kata only and sends no runtime override', async ({ page }) => {
    await page.route('**/api/auth/get-session**', async route => {
      const response = await route.fetch();
      const session = await response.json();
      await route.fulfill({ response, json: { ...session, user: { ...session.user, role: 'user' } } });
    });
    let submitted: URL | undefined;
    await page.route('**/api/containers/import**', async route => {
      submitted = new URL(route.request().url());
      await route.fulfill({ status: 400, json: { statusMessage: 'Fixture recorded import' } });
    });
    await goToDashboard(page);
    await page.getByRole('button', { name: 'Import worker', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Kata / QEMU');
    await expect(dialog.getByRole('combobox', { name: 'Import worker runtime' })).toHaveCount(0);
    await expect(dialog.getByRole('checkbox', { name: /I authorize legacy runc/ })).toHaveCount(0);
    await dialog.getByTestId('import-file').setInputFiles({ name: 'fixture.tar', mimeType: 'application/x-tar', buffer: Buffer.from('fixture') });
    await dialog.getByTestId('import-submit').click();
    await expect.poll(() => submitted?.pathname).toBe('/api/containers/import');
    expect(submitted!.searchParams.has('runtimeProfile')).toBe(false);
    expect(submitted!.searchParams.has('acknowledgeHostPrivilege')).toBe(false);
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
      // The isolated browser fixture has no Kata host: explicitly select the
      // authenticated administrator legacy path, independent of bundle metadata.
      await selectLegacyImport(page);
      await dialog.getByRole('checkbox', { name: /I authorize legacy runc/ }).check();
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
