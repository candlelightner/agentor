import { expect, test } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';
import { captureCommandOutput } from '../helpers/terminal-ws';

test('real browser creates, builds, and promotes an approved-base image', async ({ page, request }) => {
  test.setTimeout(300_000);
  const name = `Image-real-${Date.now()}`;
  let definitionId = '';
  let testWorkerId = '';
  try {
    await goToDashboard(page);
    await page.getByRole('button', { name: /image catalog/i }).click();
    const modal = page.locator('[data-testid="image-catalog"]');
    await modal.getByPlaceholder('Definition name').fill(name);
    await modal.getByPlaceholder('Description').fill('Real browser controlled-build proof');
    await modal.getByPlaceholder('Optional shell setup command').fill('printf agentor-image-proof > /etc/agentor-image-proof');
    const createResponse = page.waitForResponse(response => response.url().endsWith('/api/image-catalog/definitions') && response.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Create definition' }).click();
    const created = await createResponse;
    expect(created.ok(), await created.text()).toBe(true);
    definitionId = (await created.json()).id;
    const article = modal.locator('article').filter({ hasText: name });
    await expect(article).toBeVisible();
    await article.getByRole('button', { name: 'Build', exact: true }).click();
    const build = modal.locator('[data-testid="image-build"]').last();
    await expect(build).toContainText('succeeded', { timeout: 240_000 });
    await expect(article.locator('code')).toContainText('sha256:');
    const testWorkerResponse = page.waitForResponse(response => response.url().includes('/test-worker') && response.request().method() === 'POST');
    await article.getByRole('button', { name: 'Create test worker' }).click();
    testWorkerId = (await (await testWorkerResponse).json()).workerId;
    expect(testWorkerId).toBeTruthy();
    await expect.poll(async () => (await request.get(`/api/containers/${testWorkerId}`)).status(), { timeout: 60_000 }).toBe(200);
    expect(await captureCommandOutput(testWorkerId, 'cat /etc/agentor-image-proof', 30_000)).toContain('agentor-image-proof');
    await article.getByRole('button', { name: 'Promote' }).click();
    await expect(article).toContainText('promoted');

  } finally {
    if (testWorkerId) {
      const deleted = await request.delete(`/api/containers/${testWorkerId}`);
      expect(deleted.ok()).toBe(true);
    }
    if (definitionId) {
      const deleted = await request.delete(`/api/image-catalog/definitions/${definitionId}`);
      expect(deleted.status()).toBe(204);
    }
  }
});
