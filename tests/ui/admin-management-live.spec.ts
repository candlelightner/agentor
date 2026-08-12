import { expect, test } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';

type Policy = { default: string; revision: number; groups: Record<string, { enabled: boolean }> };
type AdminWorkspace = { status: string; image: { name: string; promoted: boolean }; presentation: { banner: string; environmentMarker: string } };

test.describe.serial('Live administrative management dashboard', () => {
  test('renders the persisted fail-closed MCP policy without browser route mocks', async ({ page, request }) => {
    const response = await request.get('/api/admin/management-mcp/policy');
    expect(response.status()).toBe(200);
    const policy = await response.json() as Policy;
    await goToDashboard(page);
    await page.getByRole('button', { name: /management mcp/i }).click();
    const modal = page.getByTestId('management-mcp');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Internal only');
    await expect(modal).toContainText(`Default: ${policy.default}`);
    await expect(modal).toContainText(`revision ${policy.revision}`);
    for (const name of ['read-only-status', 'worker-lifecycle', 'networking']) {
      const control = modal.getByLabel(`Allow ${name}`);
      await expect(control).toBeVisible();
      if (policy.groups[name]?.enabled) await expect(control).toBeChecked();
      else await expect(control).not.toBeChecked();
    }
    await expect(modal.getByRole('alert')).toContainText('restricted to the administrative workspace');
    await expect(modal.getByRole('alert')).toContainText('Confirmation prompts are controlled by the invoking agent harness');
  });

  test('provisions the trusted workspace and opens a visibly administrative terminal tab', async ({ page, request }) => {
    const ensured = await request.post('/api/admin/workspace', { data: {} });
    expect([200, 201]).toContain(ensured.status());
    const workspace = await ensured.json() as AdminWorkspace;
    expect(workspace.image.promoted).toBe(true);
    await goToDashboard(page);
    await page.getByRole('button', { name: /admin workspace/i }).click();
    const modal = page.getByTestId('admin-workspace');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: workspace.presentation.banner })).toBeVisible();
    await expect(modal).toContainText(workspace.image.name);
    await expect(modal).toContainText(workspace.presentation.environmentMarker);
    await expect(modal).toContainText(workspace.status);
    await expect(modal.getByRole('button', { name: /terminal/i })).toBeEnabled();
    await modal.getByRole('button', { name: /terminal/i }).click();
    await expect(page.getByTestId('admin-service-marker')).toBeVisible();
    await expect(page.getByTestId('admin-service-marker')).toHaveText(/ADMIN \/ ORCHESTRATOR/);
    await expect(page).toHaveTitle(/ADMIN \/ ORCHESTRATOR/);
  });
});
