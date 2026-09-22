import { test, expect } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';

test('persistent path controls show explicit live warning, independent self-service, and global inventory', async ({ page, request }) => {
  const worker = await createWorker(request, { displayName: `Volume UI ${Date.now()}` });
  let volumeId: string | undefined;
  try {
    await goToDashboard(page);
    await page.locator('h3').filter({ hasText: String(worker.displayName) }).first().click();
    const panel = page.getByTestId('worker-persistent-storage');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Persistent directory path').fill('/home/agent/ui-cache');
    await panel.getByLabel('Volume display name', { exact: true }).fill('UI cache');
    await panel.getByLabel('Persistence application method').click();
    await page.getByRole('option', { name: 'Apply live — privileged Agentor helper' }).click();
    await expect(panel.getByText('This runs a temporary privileged Agentor helper', { exact: false })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Add persistent path' })).toBeDisabled();
    await panel.getByLabel('I acknowledge this privileged helper operation').check();
    await expect(panel.getByRole('button', { name: 'Add persistent path' })).toBeEnabled();
    await panel.getByLabel('Persistence application method').click();
    await page.getByRole('option', { name: 'Save for next rebuild' }).click();
    await panel.getByRole('button', { name: 'Add persistent path' }).click();
    await expect(panel.getByText('/home/agent/ui-cache', { exact: true })).toBeVisible();
    await panel.locator('summary').click();
    await panel.getByLabel('Allow this worker to add persistent paths for itself').check();
    await panel.getByRole('button', { name: 'Save persistence permissions' }).click();
    await expect.poll(async () => (await (await request.get(`/api/containers/${worker.id}/storage`)).json()).policy).toMatchObject({ selfService: true, allowLiveMount: false, allowSelfRecreate: false });
    const storage = await (await request.get(`/api/containers/${worker.id}/storage`)).json();
    volumeId = storage.volumes[0].id;
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Workspace storage', exact: true }).click();
    await page.getByRole('tab', { name: 'Volumes', exact: true }).click();
    const inventory = page.getByTestId('managed-volume-inventory');
    await expect(inventory).toBeVisible();
    await inventory.getByLabel('Filter managed volumes').fill('UI cache');
    await expect(inventory.getByText('/home/agent/ui-cache', { exact: true })).toBeVisible();
    await expect(inventory.getByText('Not backed up', { exact: true })).toBeVisible();
    await inventory.getByLabel('Filter managed volumes').fill('workspace');
    const workspaceRow = inventory.locator('tbody tr').filter({ hasText: worker.displayName }).filter({ hasText: 'workspace' }).first();
    await expect(workspaceRow.getByRole('button', { name: 'Calculate size' })).toBeVisible();
    await workspaceRow.getByRole('button', { name: 'Calculate size' }).click();
    await expect(workspaceRow.getByText(/allocated|Volume size scan failed/)).toBeVisible({ timeout: 90_000 });
    await expect(workspaceRow.getByText('allocated', { exact: false })).toBeVisible();
    await expect(workspaceRow.getByText(/known|approximate live traversal/)).toBeVisible();
    await expect(workspaceRow.getByText('Size scan completed.', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/managed-volumes-ui.png', fullPage: true });
  } finally {
    await cleanupWorker(request, worker.id);
    if (volumeId) await request.post(`/api/volumes/${volumeId}`, { data: { action: 'delete', confirmed: true } });
  }
});

test('size polling preserves terminal feedback and action errors across stale overlapping inventory replies', async ({ page }) => {
  const stamp = '2026-01-01T00:00:00.000Z';
  const sizeJob = (status: 'queued' | 'running' | 'failed' | 'cancelled', id = 'cancel-job', error?: string) => ({
    id, volumeId: id === 'cancel-job' ? 'cancel-volume' : 'failed-volume', status,
    phase: status === 'queued' ? 'queued' : status === 'running' ? 'scanning' : status,
    progress: status === 'running' ? 35 : 0, entriesScanned: 0,
    createdAt: stamp, updatedAt: stamp, ...(error ? { error } : {}),
  });
  const runningJob = sizeJob('running');
  const cancelledJob = sizeJob('cancelled');
  const inventoryVolume = (id: string, name: string, size: any, sizeJobValue?: any) => ({
    id, name, userId: 'owner-1', purpose: 'workspace', workerId: `worker-${id}`,
    workerName: name, target: '/workspace', desired: true, observed: 'mounted', state: 'built-in',
    sizeBytes: size.allocatedBytes, logicalSizeBytes: size.logicalBytes, size,
    ...(sizeJobValue ? { sizeJob: sizeJobValue } : {}), canMeasureSize: true,
    backupCoverage: 'selected', managed: false, canDelete: false,
  });
  const unknown = { state: 'unknown', allocatedBytes: null, logicalBytes: null, reason: 'not-measured' };
  const stale = { state: 'stale', allocatedBytes: 4096, logicalBytes: 1024, measuredAt: stamp,
    source: 'bounded-read-only-scan', consistency: 'offline-read-only', reason: 'stale' };
  let inventoryCalls = 0;
  let releasePoll!: () => void, pollStarted!: () => void, pollDelivered!: () => void;
  const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
  const pollRequestStarted = new Promise<void>((resolve) => { pollStarted = resolve; });
  const pollResponseDelivered = new Promise<void>((resolve) => { pollDelivered = resolve; });

  await page.route('**/api/volumes', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const call = ++inventoryCalls;
    if (call === 3) { pollStarted(); await pollGate; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dockerAvailable: true, volumes: [
      inventoryVolume('cancel-volume', 'Cancel volume', unknown, call === 1 ? undefined : runningJob),
      inventoryVolume('stale-volume', 'Stale volume', stale),
      inventoryVolume('failed-volume', 'Failed volume', unknown, sizeJob('failed', 'failed-job', 'Bounded scan failed safely.')),
    ] }) });
    if (call === 3) pollDelivered();
  });
  await page.route('**/api/volumes/*/size-jobs', async (route) => {
    const body = route.request().postDataJSON();
    if (new URL(route.request().url()).pathname.includes('/cancel-volume/')) {
      expect(body).toEqual({ force: false });
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(sizeJob('queued')) });
      return;
    }
    expect(body).toEqual({ force: true });
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ statusCode: 409, statusMessage: 'Deliberate sizing rejection' }) });
  });
  await page.route('**/api/volume-size-jobs/*', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cancelledJob) });
  });

  await goToDashboard(page);
  await page.getByRole('button', { name: 'Workspace storage', exact: true }).click();
  await page.getByRole('tab', { name: 'Volumes', exact: true }).click();
  const inventory = page.getByTestId('managed-volume-inventory');
  const cancelRow = inventory.locator('tbody tr').filter({ hasText: 'Cancel volume' });
  const staleRow = inventory.locator('tbody tr').filter({ hasText: 'Stale volume' });
  const failedRow = inventory.locator('tbody tr').filter({ hasText: 'Failed volume' });
  await expect(staleRow.getByText(/^stale ·/)).toBeVisible();
  await expect(staleRow.getByRole('button', { name: 'Refresh size' })).toBeVisible();
  await expect(failedRow.getByText('Bounded scan failed safely.', { exact: true })).toBeVisible();

  await cancelRow.getByRole('button', { name: 'Calculate size' }).click();
  await pollRequestStarted;
  await cancelRow.getByRole('button', { name: 'Cancel size scan' }).click();
  await expect(cancelRow.getByText('Cancellation requested. Scanner cleanup may still be finishing.', { exact: true })).toBeVisible();
  releasePoll();
  await pollResponseDelivered;
  await expect(cancelRow.getByText('Cancellation requested. Scanner cleanup may still be finishing.', { exact: true })).toBeVisible();
  await expect(cancelRow.getByRole('button', { name: 'Cancel size scan' })).toHaveCount(0);

  await staleRow.getByRole('button', { name: 'Refresh size' }).click();
  await expect(inventory.getByRole('alert')).toHaveText('Deliberate sizing rejection');
  await inventory.getByRole('button', { name: 'Refresh volumes' }).click();
  await expect(inventory.getByRole('alert')).toHaveText('Deliberate sizing rejection');
  await expect(cancelRow.getByText('Cancellation requested. Scanner cleanup may still be finishing.', { exact: true })).toBeVisible();
});
