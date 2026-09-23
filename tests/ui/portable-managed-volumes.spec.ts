import { expect, test, type Locator } from '@playwright/test';
import { cleanupWorker, createWorker } from '../helpers/worker-lifecycle';
import { findButtonByTooltip, goToDashboard } from '../helpers/ui-helpers';

test.describe.serial('Portable managed-volume option UI', () => {
  let workerId = '';
  let displayName = '';

  test.beforeAll(async ({ request }) => {
    displayName = `Portable-UI-${Date.now()}`;
    workerId = (await createWorker(request, { displayName })).id;
  });

  test.afterAll(async ({ request }) => {
    if (workerId) await cleanupWorker(request, workerId).catch(() => {});
  });

  test('worker export defaults off, shows exact warnings, and sends explicit opt-in', async ({ page }) => {
    let requestedBody: unknown;
    await page.route('**/api/containers/*/export-jobs', async (route) => {
      requestedBody = route.request().postDataJSON();
      await route.fulfill({ status: 202, json: {
        id: 'ui-managed-export-job', workerId, includeRootfs: false,
        includeManagedVolumes: true, status: 'queued', phase: 'queued',
        progress: 0, bytesProcessed: 0, downloadReady: false,
      } });
    });
    await page.route('**/api/export-jobs/ui-managed-export-job', (route) =>
      route.fulfill({ status: 200, json: {
        id: 'ui-managed-export-job', workerId, includeRootfs: false,
        includeManagedVolumes: true, status: 'running', phase: 'managed-volumes',
        progress: 25, bytesProcessed: 1, downloadReady: false,
      } }),
    );

    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await (await findButtonByTooltip(card, page, 'Export worker')).click();
    const modal = page.getByTestId('export-worker-modal');
    const checkbox = modal.getByTestId('export-managed-volumes');
    await expect(checkbox).not.toBeChecked();
    await expectPortableWarnings(modal);
    await checkbox.check();
    await modal.getByTestId('export-start').click();
    expect(requestedBody).toEqual({ includeRootfs: false, includeManagedVolumes: true });
  });

  test('backup settings default off, show exact warnings, and persist manual opt-in', async ({ page }) => {
    let saved: any;
    let started: any;
    await page.route('**/api/backup-providers', (route) => route.fulfill({ json: [
      { id: 'fake', type: 'fake', connected: true },
    ] }));
    await page.route('**/api/admin/backup-providers/google-oauth', (route) => route.fulfill({
      json: { configured: false, source: 'none', clientSecretConfigured: false },
    }));
    await page.route('**/api/backup-settings', async (route) => {
      if (route.request().method() === 'PUT') {
        saved = await route.request().postDataJSON();
        return route.fulfill({ json: saved });
      }
      return route.fulfill({ json: {
        providerId: 'fake', enabled: false, selection: 'all', workspaceIds: [],
        selectedPathsByWorkspace: {}, includeManagedVolumes: false,
        intervalMinutes: 1440, retentionCount: 7, nextRunAt: null,
        lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0,
      } });
    });
    await page.route('**/api/backups', async (route) => {
      if (route.request().method() === 'POST') {
        started = await route.request().postDataJSON();
        return route.fulfill({ status: 202, json: {
          id: 'job-managed', includeManagedVolumes: true,
          status: 'queued', phase: 'queued', progress: 0,
        } });
      }
      return route.fulfill({ json: { backups: [{
        id: 'backup-managed', includeManagedVolumes: true, workspaceIds: [workerId],
        provider: 'fake', createdAt: '2026-01-01T00:00:00Z', sizeBytes: 42,
        integrityVerified: true,
      }], jobs: [] } });
    });
    await page.route('**/api/backups/recovery-key', (route) => route.fulfill({ json: { keys: [] } }));
    await page.route('**/api/backups/remote', (route) => route.fulfill({ json: [] }));

    await goToDashboard(page);
    await page.getByRole('button', { name: /backup management/i }).click();
    const modal = page.getByTestId('backup-management');
    const checkbox = modal.getByTestId('backup-managed-volumes');
    await expect(checkbox).not.toBeChecked();
    await expectPortableWarnings(modal.getByTestId('backup-managed-volume-settings'));
    await expect(modal).toContainText('Includes attached custom volumes');
    await checkbox.check();
    await modal.getByRole('button', { name: 'Back up now' }).click();
    await expect.poll(() => saved?.includeManagedVolumes).toBe(true);
    await expect.poll(() => started?.includeManagedVolumes).toBe(true);
  });
});

async function expectPortableWarnings(scope: Locator): Promise<void> {
  await expect(scope).toContainText('Only attached custom volumes are captured');
  await expect(scope).toContainText('detached volumes are excluded');
  await expect(scope).toContainText('running worker is best-effort');
  await expect(scope).toContainText('policies remain disabled');
}
