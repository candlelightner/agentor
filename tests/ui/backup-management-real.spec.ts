import { expect, test } from '@playwright/test';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { goToDashboard } from '../helpers/ui-helpers';

test('real browser configures fake provider, backs up, and starts restore', async ({ page, request }) => {
  test.setTimeout(240_000);
  const worker = await createWorker(request, { displayName: `Backup-real-${Date.now()}` });
  let restoredWorkerId = '';
  try {
    await goToDashboard(page);
    await page.getByRole('button', { name: /backup management/i }).click();
    const modal = page.locator('[data-testid="backup-management"]');
    await modal.getByLabel('Provider').selectOption('fake');
    await modal.getByRole('button', { name: 'Save schedule' }).click();
    await modal.getByRole('button', { name: 'Back up now' }).click();
    await expect(modal).toContainText('succeeded', { timeout: 120_000 });
    await expect(modal).toContainText('Integrity verified');
    await modal.getByRole('button', { name: 'Restore' }).first().click();
    await modal.getByLabel('New worker').check();
    await modal.getByRole('button', { name: 'Start restore' }).click();
    await expect(modal.locator('[data-testid="restore-backup"]')).toBeHidden();
    await expect.poll(async () => {
      const workers = await (await request.get('/api/containers')).json();
      restoredWorkerId = workers.find((candidate: any) => candidate.id !== worker.id && candidate.displayName?.includes(worker.displayName))?.id || '';
      return Boolean(restoredWorkerId);
    }, { timeout: 120_000 }).toBe(true);
  } finally {
    if (restoredWorkerId) await cleanupWorker(request, restoredWorkerId).catch(() => {});
    await cleanupWorker(request, worker.id);
  }
});
