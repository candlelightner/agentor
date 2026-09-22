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
    await page.screenshot({ path: 'test-results/managed-volumes-ui.png', fullPage: true });
  } finally {
    await cleanupWorker(request, worker.id);
    if (volumeId) await request.post(`/api/volumes/${volumeId}`, { data: { action: 'delete', confirmed: true } });
  }
});
