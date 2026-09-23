import { expect, test, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { captureCommandOutput } from '../helpers/terminal-ws';
import { cleanupWorker, createWorker, waitForWorkerRunning } from '../helpers/worker-lifecycle';
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

  test('real browser export opt-in restores custom volume data with fresh identity and disabled policies', async ({ page, request }) => {
    test.setTimeout(600_000);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const target = `/home/agent/portable-browser-${stamp}`;
    const marker = `PORTABLE_BROWSER_${stamp}`;
    const importedName = `Portable-browser-import-${stamp}`;
    const createdWorkerIds: string[] = [];
    const createdVolumeIds = new Set<string>();

    try {
      const source = await createWorker(request, { displayName: `Portable-browser-source-${stamp}` });
      createdWorkerIds.push(source.id);
      const add = await request.post(`/api/containers/${source.id}/storage`, {
        data: { action: 'add', target, name: 'Browser portable data', mode: 'recreate' },
      });
      expect(add.status(), await add.text()).toBe(200);
      const sourceVolume = await add.json();
      createdVolumeIds.add(sourceVolume.id);
      await expect.poll(async () => {
        const response = await request.get(`/api/volumes/${sourceVolume.id}`);
        expect(response.status()).toBe(200);
        return (await response.json()).operation?.stage;
      }, { timeout: 180_000, intervals: [500, 1000, 2000] }).toMatch(/complete|failed/);
      const completedVolume = await (await request.get(`/api/volumes/${sourceVolume.id}`)).json();
      expect(completedVolume.operation, JSON.stringify(completedVolume)).toMatchObject({ stage: 'complete' });
      await waitForWorkerRunning(request, source.id, 120_000);

      const policy = await request.post(`/api/containers/${source.id}/storage`, {
        data: { action: 'policy', policy: { selfService: true, allowSelfRecreate: true, allowLiveMount: true } },
      });
      expect(policy.status(), await policy.text()).toBe(200);
      expect(await captureCommandOutput(source.id, `printf '%s' '${marker}' > '${target}/marker.txt' && cat '${target}/marker.txt'`, 30_000)).toContain(marker);

      await goToDashboard(page);
      const card = page.locator('.rounded-lg').filter({ hasText: source.displayName as string }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await (await findButtonByTooltip(card, page, 'Export worker')).click();
      const exportModal = page.getByTestId('export-worker-modal');
      const checkbox = exportModal.getByTestId('export-managed-volumes');
      await expect(checkbox).not.toBeChecked();
      await checkbox.check();
      const exportResponsePromise = page.waitForResponse((response) =>
        response.url().includes(`/api/containers/${source.id}/export-jobs`) && response.request().method() === 'POST');
      await exportModal.getByTestId('export-start').click();
      const exportResponse = await exportResponsePromise;
      expect(exportResponse.status(), await exportResponse.text()).toBe(202);
      const exportJob = await exportResponse.json();
      expect(exportJob).toMatchObject({ workerId: source.id, includeRootfs: false, includeManagedVolumes: true });
      await expect.poll(async () => {
        const response = await request.get(`/api/export-jobs/${exportJob.id}`);
        expect(response.status()).toBe(200);
        return (await response.json()).status;
      }, { timeout: 180_000, intervals: [500, 1000, 2000] }).toMatch(/succeeded|failed|cancelled/);
      const finishedJob = await (await request.get(`/api/export-jobs/${exportJob.id}`)).json();
      expect(finishedJob.status, JSON.stringify(finishedJob)).toBe('succeeded');
      await expect(exportModal.getByTestId('export-download')).toBeVisible({ timeout: 30_000 });
      const downloadPromise = page.waitForEvent('download');
      await exportModal.getByTestId('export-download').click();
      const download = await downloadPromise;
      expect(await download.failure()).toBeNull();
      const bundle = await readFile(await download.path());
      expect(bundle.length).toBeGreaterThan(0);

      await exportModal.getByRole('button', { name: 'Close' }).click();
      await page.click('button[aria-label="Import worker"]');
      const importDialog = page.locator('[role="dialog"]');
      await importDialog.locator('[data-testid="import-file"]').setInputFiles({
        name: 'portable-browser-export.tar', mimeType: 'application/x-tar', buffer: bundle,
      });
      await importDialog.locator('[data-testid="import-name"]').fill(importedName);
      const importResponsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/api/containers/import' && response.request().method() === 'POST',
        { timeout: 300_000 });
      await importDialog.locator('[data-testid="import-submit"]').click();
      const importResponse = await importResponsePromise;
      expect(importResponse.status(), await importResponse.text()).toBe(201);
      const imported = await importResponse.json();
      createdWorkerIds.push(imported.id);
      await expect(importDialog).toBeHidden({ timeout: 120_000 });
      await expect(page.getByText(importedName, { exact: true })).toBeVisible({ timeout: 60_000 });
      await waitForWorkerRunning(request, imported.id, 120_000);

      const sourceStorageResponse = await request.get(`/api/containers/${source.id}/storage`);
      const importedStorageResponse = await request.get(`/api/containers/${imported.id}/storage`);
      expect(sourceStorageResponse.status()).toBe(200);
      expect(importedStorageResponse.status()).toBe(200);
      const sourceStorage = await sourceStorageResponse.json();
      const importedStorage = await importedStorageResponse.json();
      for (const volume of importedStorage.volumes) createdVolumeIds.add(volume.id);
      expect(imported.id).not.toBe(source.id);
      expect(sourceStorage.volumes).toEqual(expect.arrayContaining([expect.objectContaining({
        id: sourceVolume.id, target, attached: true, state: 'ready',
      })]));
      expect(importedStorage.volumes).toEqual([expect.objectContaining({
        target, name: 'Browser portable data', purpose: 'persistent-path', attached: true, state: 'ready',
      })]);
      expect(importedStorage.volumes[0].id).not.toBe(sourceVolume.id);
      expect(importedStorage.policy).toMatchObject({
        workerId: imported.id, selfService: false, allowSelfRecreate: false, allowLiveMount: false,
      });
      expect(sourceStorage.policy).toMatchObject({
        workerId: source.id, selfService: true, allowSelfRecreate: true, allowLiveMount: true,
      });
      expect(await captureCommandOutput(imported.id, `cat '${target}/marker.txt'`, 30_000)).toContain(marker);
      expect(await captureCommandOutput(source.id, `cat '${target}/marker.txt'`, 30_000)).toContain(marker);
    } finally {
      // Permanent worker removal detaches its custom volumes; only then can these test-created IDs be deleted.
      for (const id of [...createdWorkerIds].reverse()) {
        const response = await request.get(`/api/containers/${id}/storage`).catch(() => null);
        if (response?.ok()) {
          const storage = await response.json();
          for (const volume of storage.volumes || []) createdVolumeIds.add(volume.id);
        }
        await cleanupWorker(request, id).catch(() => {});
      }
      for (const id of createdVolumeIds) {
        await request.post(`/api/volumes/${id}`, { data: { action: 'delete', confirmed: true } }).catch(() => {});
      }
    }
  });
});

async function expectPortableWarnings(scope: Locator): Promise<void> {
  await expect(scope).toContainText('Only attached custom volumes are captured');
  await expect(scope).toContainText('detached volumes are excluded');
  await expect(scope).toContainText('running worker is best-effort');
  await expect(scope).toContainText('policies remain disabled');
}
