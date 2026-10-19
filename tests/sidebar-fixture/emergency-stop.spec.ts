import { test, expect } from '@playwright/test';

test('unknown worker: named warning and cancellation send no stop request', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/emergency-stop')) requests.push(request.url());
  });
  await page.goto('/?role=ordinary&workerStatus=unknown');
  const card = page.locator('.sidebar-worker-card').filter({ hasText: 'Research worker' });
  await card.getByRole('button', { name: 'Emergency stop', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Emergency stop Research worker?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('ordinary-fixture');
  await expect(dialog).toContainText('no graceful shutdown or grace period');
  await expect(dialog).toContainText('unsaved work may be lost');
  await expect(dialog.getByRole('button', { name: 'Emergency stop now', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(requests).toEqual([]);
  await expect(card).toContainText('unknown');
});

for (const theme of ['light', 'dark']) {
  test(`${theme}: confirmed stop sends once and refreshes worker status`, async ({ page }) => {
    let requests = 0;
    let stopped = false;
    let release!: () => void;
    const responseReady = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/fixture-worker-status', (route) => route.fulfill({ json: stopped ? { 'ordinary-fixture': 'stopped' } : {} }));
    await page.route('**/api/containers/ordinary-fixture/emergency-stop', async (route) => {
      requests++;
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({ confirmed: true });
      await responseReady;
      stopped = true;
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(`/?role=ordinary&theme=${theme}&workerStatus=error`);
    const card = page.locator('.sidebar-worker-card').filter({ hasText: 'Research worker' });
    await card.getByRole('button', { name: 'Emergency stop', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Emergency stop Research worker?' });
    const confirm = dialog.getByRole('button', { name: 'Emergency stop now', exact: true });
    await confirm.click();
    await expect.poll(() => requests).toBe(1);
    await expect(confirm).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    release();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('Research worker was stopped immediately.', { exact: true })).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.locator('aside [data-tab-id="stopped"]').click();
    await expect(card).toContainText('stopped');
    expect(requests).toBe(1);
  });
}

test('pending lifecycle rejection stays visible without retrying or claiming success', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/containers/ordinary-fixture/emergency-stop', (route) => {
    requests++;
    return route.fulfill({ status: 409, json: { statusCode: 409, statusMessage: 'Another worker operation is pending. Refresh status before retrying.' } });
  });
  await page.goto('/?role=ordinary&workerStatus=unknown');
  await page.locator('.sidebar-worker-card').filter({ hasText: 'Research worker' }).getByRole('button', { name: 'Emergency stop', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Emergency stop Research worker?' });
  await dialog.getByRole('button', { name: 'Emergency stop now', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Another worker operation is pending');
  await expect(dialog.getByRole('button', { name: 'Emergency stop now', exact: true })).toBeEnabled();
  await expect(page.getByText('Research worker was stopped immediately.', { exact: true })).toHaveCount(0);
  expect(requests).toBe(1);
});

test('failed stop refreshes an unknown outcome without automatically retrying', async ({ page }) => {
  let failed = false;
  let requests = 0;
  await page.route('**/api/fixture-worker-status', (route) => route.fulfill({ json: failed ? { 'ordinary-fixture': 'unknown' } : {} }));
  await page.route('**/api/containers/ordinary-fixture/emergency-stop', (route) => {
    requests++;
    failed = true;
    return route.fulfill({ status: 504, json: { statusCode: 504, statusMessage: 'Stop outcome is unconfirmed. Refresh status before retrying.' } });
  });
  await page.goto('/?role=ordinary');
  const card = page.locator('.sidebar-worker-card').filter({ hasText: 'Research worker' });
  await card.getByRole('button', { name: 'Emergency stop', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Emergency stop Research worker?' });
  await dialog.getByRole('button', { name: 'Emergency stop now', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Stop outcome is unconfirmed');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card).toContainText('unknown');
  expect(requests).toBe(1);
});

test('protected worker requires an explicit second confirmation with its lock password', async ({ page }) => {
  const bodies: unknown[] = [];
  await page.route('**/api/containers/ordinary-fixture/emergency-stop', (route) => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1
      ? route.fulfill({ status: 423, json: { statusCode: 423, statusMessage: 'Worker is protected' } })
      : route.fulfill({ json: { ok: true } });
  });
  await page.goto('/?role=ordinary');
  await page.locator('.sidebar-worker-card').filter({ hasText: 'Research worker' }).getByRole('button', { name: 'Emergency stop', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Emergency stop Research worker?' });
  await dialog.getByRole('button', { name: 'Emergency stop now', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('worker lock password');
  await expect(dialog.getByRole('button', { name: 'Emergency stop now', exact: true })).toBeDisabled();
  await dialog.getByLabel('Worker lock password', { exact: true }).fill('synthetic-lock-password');
  expect(bodies).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Emergency stop now', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(bodies).toEqual([{ confirmed: true }, { confirmed: true, lockPassword: 'synthetic-lock-password' }]);
});

for (const [name, id] of [['Nested worker', 'nested-fixture'], ['Platform admin', 'platform-fixture'], ['Group admin', 'group-admin-fixture']]) {
  test(`${name}: emergency stop is available and targets the selected worker`, async ({ page }) => {
    const bodies: unknown[] = [];
    await page.route(`**/api/containers/${id}/emergency-stop`, (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/?role=admin&groupAdmin=1');
    await page.locator('.sidebar-worker-card').filter({ hasText: name }).getByRole('button', { name: 'Emergency stop', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Emergency stop ${name}?` });
    if (id !== 'nested-fixture') await expect(dialog).toContainText('privileged administrative workspace');
    await dialog.getByRole('button', { name: 'Emergency stop now', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(bodies).toEqual([{ confirmed: true }]);
  });
}
