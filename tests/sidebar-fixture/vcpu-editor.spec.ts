import { test, expect } from '@playwright/test';

test('vCPU editor requires a stopped VM, validates input and shows actual saved count', async ({ page }) => {
  let state = { vcpuCount: 2, maxVcpuCount: 4, status: 'running', pending: false };
  const puts: any[] = [];
  await page.route('**/api/fixture-cpu', route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); puts.push(body);
      state = { ...state, vcpuCount: body.vcpuCount };
    }
    return route.fulfill({ json: state });
  });
  await page.goto('/?role=ordinary&vcpu');
  const editor = page.getByTestId('vcpu-editor'), input = editor.getByRole('spinbutton');
  await expect(editor).toContainText('Assigned: 2');
  await expect(input).toBeDisabled();
  await expect(editor).toContainText('Stop the VM, then refresh');
  state.status = 'stopped';
  await editor.getByRole('button', { name: 'Refresh vCPU count' }).click();
  await expect(input).toBeEnabled();
  for (const value of ['0', '1.5', '5']) {
    await input.fill(value);
    await editor.getByRole('button', { name: 'Save vCPU count' }).click();
    await expect(editor.getByRole('alert')).toBeVisible();
    expect(puts).toHaveLength(0);
  }
  await input.fill('3');
  await editor.getByRole('button', { name: 'Save vCPU count' }).click();
  await expect(editor).toContainText('Assigned: 3');
  await expect(editor).toContainText('vCPU count saved');
  expect(puts).toEqual([{ vcpuCount: 3, lockPassword: '' }]);
});

test('unknown changes require explicit reconciliation and protected updates request the lock password', async ({ page }) => {
  let state: any = { vcpuCount: 2, maxVcpuCount: 4, status: 'stopped', pending: true, pendingVcpuCount: 3 };
  const puts: any[] = [];
  await page.route('**/api/fixture-cpu', route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); puts.push(body);
      if (body.lockPassword !== 'fixture-password')
        return route.fulfill({ status: 423, json: { statusCode: 423, statusMessage: 'Worker is protected.' } });
      state = { ...state, vcpuCount: 3, pending: false, pendingVcpuCount: undefined };
    }
    return route.fulfill({ json: state });
  });
  await page.goto('/?role=ordinary&vcpu');
  const editor = page.getByTestId('vcpu-editor');
  await expect(editor.getByRole('spinbutton')).toBeDisabled();
  await editor.getByRole('button', { name: 'Reconcile pending CPU change' }).click();
  await expect(editor.getByRole('alert')).toHaveText('Worker is protected.');
  await editor.getByLabel('CPU change lock password').fill('fixture-password');
  await editor.getByRole('button', { name: 'Reconcile pending CPU change' }).click();
  await expect(editor).toContainText('Assigned: 3');
  await expect(editor.getByRole('button', { name: 'Reconcile pending CPU change' })).toHaveCount(0);
  expect(puts.map(body => body.vcpuCount)).toEqual([3, 3]);
});

test('platform CPU recovery remains reachable after a page reload when general status is fenced', async ({ page }) => {
  test.setTimeout(90_000);
  let pending = true;
  const puts: number[] = [];
  await page.route('**/api/admin/workspace', route => route.fulfill({ status: 503,
    json: { statusMessage: 'Administrative operation is not settled.' } }));
  await page.route('**/api/admin/workspace/cpu', route => {
    if (route.request().method() === 'PUT') { puts.push(route.request().postDataJSON().vcpuCount); pending = false; }
    return route.fulfill({ json: { vcpuCount: pending ? 2 : 3, maxVcpuCount: 4, status: 'stopped', pending,
      ...(pending ? { pendingVcpuCount: 3 } : {}) } });
  });
  await page.goto('/?adminCpu', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open administrative CPU recovery' }).click();
  await expect(page.getByTestId('vcpu-editor').getByRole('button', { name: 'Reconcile pending CPU change' })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open administrative CPU recovery' }).click();
  const editor = page.getByTestId('vcpu-editor');
  await expect(editor).toContainText('Assigned: 2');
  expect(puts).toEqual([]);
  await editor.getByRole('button', { name: 'Reconcile pending CPU change' }).click();
  await expect(editor).toContainText('Assigned: 3');
  expect(puts).toEqual([3]);
});
