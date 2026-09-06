import { test, expect } from '@playwright/test';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { goToDashboard, hasButtonWithTooltip, findButtonByTooltip, selectSidebarTab } from '../helpers/ui-helpers';
import { ApiClient } from '../helpers/api-client';

test.describe('Worker card actions', () => {
  let workerId: string;
  let displayName: string;

  test.beforeAll(async ({ request }) => {
    displayName = `Card-${Date.now()}`;
    const w = await createWorker(request, { displayName });
    workerId = w.id;
  });

  test.afterAll(async ({ request }) => {
    if (workerId) await cleanupWorker(request, workerId);
  });

  test('a running card exposes the Export button (in the workspace group)', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    expect(await hasButtonWithTooltip(card, page, 'Export worker')).toBe(true);
  });

  test('Export modal defaults to workspace-only, polls progress, and streams the download', async ({ page }) => {
    let requestedBody: unknown;
    let statusPolls = 0;
    await page.route('**/api/containers/*/export-jobs', async (route) => {
      requestedBody = route.request().postDataJSON();
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({
        id: 'ui-export-job', workerId, includeRootfs: false, status: 'queued', phase: 'queued',
        progress: 0, bytesProcessed: 0, downloadReady: false,
      }) });
    });
    await page.route(/\/api\/export-jobs\/ui-export-job(?:\?.*)?$/, async (route) => {
      statusPolls++;
      const done = statusPolls > 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'ui-export-job', workerId, includeRootfs: false,
        status: done ? 'succeeded' : 'running', phase: done ? 'complete' : 'workspace',
        progress: done ? 100 : 40, bytesProcessed: done ? 2048 : 1024, downloadReady: done,
      }) });
    });
    await page.route('**/api/export-jobs/ui-export-job/download', async (route) => {
      await route.fulfill({ status: 200, headers: {
        'content-type': 'application/x-tar',
        'content-disposition': 'attachment; filename="card-worker-export.tar"',
      }, body: 'streamed-tar' });
    });

    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const exportBtn = await findButtonByTooltip(card, page, 'Export worker');
    await exportBtn.click();
    const modal = page.locator('[data-testid="export-worker-modal"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Workspace-only is the recommended default');
    await expect(modal.locator('[data-testid="export-rootfs"]')).not.toBeChecked();
    await modal.locator('[data-testid="export-start"]').click();
    expect(requestedBody).toEqual({ includeRootfs: false });
    await expect(modal).toContainText('workspace');
    await expect(modal).toContainText('succeeded', { timeout: 5_000 });

    const downloadPromise = page.waitForEvent('download');
    await modal.locator('[data-testid="export-download"]').click();
    await downloadPromise;
    expect(statusPolls).toBeGreaterThan(1);
  });

  test('real browser export reaches the durable API and downloads its artifact', async ({ page }) => {
    test.setTimeout(180_000);
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    const exportBtn = await findButtonByTooltip(card, page, 'Export worker');
    await exportBtn.click();
    const modal = page.locator('[data-testid="export-worker-modal"]');
    await modal.locator('[data-testid="export-start"]').click();
    await expect(modal).toContainText('succeeded', { timeout: 120_000 });
    const downloadPromise = page.waitForEvent('download');
    await modal.locator('[data-testid="export-download"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/worker-export\.tar$/);
    expect((await download.createReadStream())).toBeTruthy();
  });

  test('the action row is horizontally scrollable (no wrap)', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const actions = card.locator('.card-actions');
    await expect(actions).toBeVisible();
    const overflowX = await actions.evaluate((el) => getComputedStyle(el).overflowX);
    expect(overflowX).toBe('auto');
  });

  test('per-worker live metrics render on the card', async ({ page }) => {
    await page.route('**/api/worker-metrics', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workers: [{
            workerId,
            containerName: `agentor-worker-${workerId}`,
            displayName,
            status: 'running',
            cpuUtilization: 42,
            memoryUsedBytes: 1024 ** 3,
            memoryLimitBytes: 4 * 1024 ** 3,
            memoryUtilization: 25,
            diskUsedBytes: 2 * 1024 ** 3,
            netRxBytesPerSec: 1024,
            netTxBytesPerSec: 2048,
            blkReadBytesPerSec: 0,
            blkWriteBytesPerSec: 0,
            lastChecked: new Date().toISOString(),
          }],
        }),
      });
    });

    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const metrics = card.locator('[data-testid="worker-metrics"]');
    await expect(metrics).toBeVisible({ timeout: 10_000 });
    // CPU as a percentage; memory + disk as used byte sizes (no percentage).
    await expect(metrics).toContainText('42%');
    await expect(metrics).toContainText('1.0 GB'); // memory used
    await expect(metrics).toContainText('2.0 GB'); // disk used
  });

  test('a stopped worker can open the export modal', async ({ page, request }) => {
    const stoppedName = `Stopped-export-${Date.now()}`;
    const stopped = await createWorker(request, { displayName: stoppedName });
    try {
      expect((await new ApiClient(request).stopContainer(stopped.id)).status).toBe(200);
      await goToDashboard(page);
      await selectSidebarTab(page, 'Stopped');
      const card = page.locator('aside .rounded-lg').filter({ hasText: stoppedName }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      const exportBtn = await findButtonByTooltip(card, page, 'Export worker');
      await exportBtn.click();
      await expect(page.locator('[data-testid="export-worker-modal"]')).toBeVisible();
    } finally {
      await cleanupWorker(request, stopped.id);
    }
  });
});

test('an unverifiable runtime is labelled unknown and offers managed recovery', async ({ page }) => {
  const workerId = '00000000-0000-4000-8000-000000000321';
  const displayName = 'Runtime recovery test';
  let recoveryCalls = 0;
  const worker = {
    id: workerId,
    userId: 'ui-owner',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:01.000Z',
    containerId: 'docker-runtime-test',
    containerName: `agentor-worker-${workerId}`,
    displayName,
    imageName: 'agentor-worker:latest',
    imageId: 'sha256:' + '1'.repeat(64),
    status: 'unknown',
    desiredRuntimeStatus: 'running',
    runtimeDiagnostic: {
      code: 'DOCKER_OPERATION_TIMEOUT',
      operation: 'Docker worker task probe',
      message: 'Agentor could not verify the Docker task. Persistent volumes were not changed.',
      retryable: true,
      observedAt: '2026-09-05T00:00:01.000Z',
    },
  };
  await page.route(/\/api\/containers(?:\?.*)?$/, async route => {
    await route.fulfill({ status: 200, json: [worker] });
  });
  await page.route(`**/api/containers/${workerId}/recover`, async route => {
    recoveryCalls++;
    await route.fulfill({ status: 200, json: { ...worker, status: 'running', runtimeDiagnostic: undefined } });
  });

  await goToDashboard(page);
  const card = page.locator('aside .rounded-lg').filter({ hasText: displayName }).first();
  await expect(card.getByText('unknown', { exact: true })).toBeVisible();
  await expect(card.getByLabel('Runtime state could not be verified')).toBeVisible();
  await expect(card.getByLabel('Recover worker')).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('No workspace or volume is deleted');
    await dialog.accept();
  });
  await card.getByLabel('Recover worker').click();
  await expect.poll(() => recoveryCalls).toBe(1);
});
