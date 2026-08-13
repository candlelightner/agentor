import { expect, test } from '@playwright/test';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { goToDashboard } from '../helpers/ui-helpers';

test('real settings persist worker-local variable and write-only secret without rendering its value', async ({ page, request }) => {
  const displayName = `Config-real-${Date.now()}`;
  const worker = await createWorker(request, { displayName });
  const secret = `REAL_UI_SECRET_${Date.now()}_DO_NOT_RENDER`;
  try {
    await goToDashboard(page);
    await page.getByText(displayName, { exact: true }).click();
    const dialog = page.getByRole('dialog');
    const editor = dialog.locator('[data-testid="worker-configuration-editor"]');
    await expect(editor).toBeVisible();
    await editor.getByPlaceholder('# comments allowed').fill('REAL_UI_VARIABLE=visible-value');
    await editor.getByRole('button', { name: 'Add masked secret' }).click();
    await editor.getByPlaceholder('SECRET_NAME').fill('REAL_UI_TOKEN');
    await editor.getByPlaceholder('write-only value').fill(secret);
    await editor.getByRole('button', { name: 'Save worker configuration' }).click();
    await expect(editor).toContainText('Saved. Rebuild the worker to apply these changes.');
    await expect(page.locator('body')).not.toContainText(secret);

    const response = await request.get(`/api/containers/${worker.id}/configuration`);
    expect(response.status()).toBe(200);
    const configuration = await response.json();
    expect(configuration.local.secrets).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'REAL_UI_TOKEN', configured: true })]));
    expect(JSON.stringify(configuration)).not.toContain(secret);
    expect(configuration.local.variables).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'REAL_UI_VARIABLE', value: 'visible-value' })]));
  } finally {
    await cleanupWorker(request, worker.id);
  }
});
