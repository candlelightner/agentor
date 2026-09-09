import { expect, test } from '@playwright/test';
import { goToDashboard, openCreateWorkerModal } from '../helpers/ui-helpers';

test('hardware UI approves, entitles, assigns, and offers a discovered device to workers', async ({ page, request }) => {
  let deviceId = '';
  try {
    await goToDashboard(page); await page.getByRole('button', { name: 'Hardware', exact: true }).click();
    const modal = page.getByTestId('hardware-device-management'); await expect(modal).toBeVisible(); await expect(modal.getByText('Hardware access is security-sensitive')).toBeVisible();
    const catalog = modal.locator('section').filter({ hasText: 'Platform device catalog' });
    await catalog.getByRole('combobox').click(); await page.getByRole('option', { name: /Agentor test USB device/ }).click(); await catalog.getByPlaceholder('Optional display name').fill('UI test device'); await catalog.getByRole('button', { name: 'Approve device' }).click();
    const state = await (await request.get('/api/hardware-devices')).json(); deviceId = state.catalog.find((item: any) => item.name === 'UI test device').id;
    const entitlement = modal.locator('section').filter({ hasText: 'Account entitlements' }).locator('label').filter({ hasText: 'UI test device' }); await entitlement.getByRole('checkbox').click();
    const assignments = modal.locator('section').filter({ hasText: 'Assignments' }); await assignments.getByRole('button', { name: 'Assign' }).click(); await expect(assignments.getByText(/UI test device.*All workers/)).toBeVisible();
    await modal.getByRole('button', { name: 'Close' }).click(); await openCreateWorkerModal(page);
    const create = page.getByRole('dialog'); await create.getByRole('button', { name: 'Add hardware device' }).click(); await create.getByRole('combobox', { name: 'Assigned hardware device' }).click(); await expect(page.getByRole('option', { name: /UI test device/ })).toBeVisible(); await page.keyboard.press('Escape'); await create.getByRole('button', { name: 'Cancel' }).click();
  } finally { if (deviceId) await request.delete(`/api/hardware-devices/${deviceId}`).catch(() => undefined); }
});
