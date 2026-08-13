import { expect, test } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';

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
    await modal.getByPlaceholder('RUN apt-get update…').fill('RUN printf agentor-image-proof > /etc/agentor-image-proof');
    await modal.getByRole('button', { name: 'Create definition' }).click();
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
    await article.getByRole('button', { name: 'Promote' }).click();
    await expect(article).toContainText('promoted');

    const definitions = await (await request.get('/api/image-catalog/definitions')).json();
    definitionId = definitions.find((candidate: any) => candidate.name === name)?.id || '';
  } finally {
    if (testWorkerId) await request.delete(`/api/containers/${testWorkerId}`).catch(() => {});
    if (definitionId) await request.delete(`/api/image-catalog/definitions/${definitionId}`).catch(() => {});
  }
});
