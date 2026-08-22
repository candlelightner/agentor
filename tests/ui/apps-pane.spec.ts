import { test, expect } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { ApiClient } from '../helpers/api-client';

test.describe.serial('Apps Pane — UI', () => {
  let containerId: string;
  let displayName: string;

  test.beforeAll(async ({ request }) => {
    displayName = `AppsPane-${Date.now()}`;
    const container = await createWorker(request, { displayName });
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    if (containerId) {
      await cleanupWorker(request, containerId);
    }
  });

  test('Apps button exists on running container card', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    // Apps is the 4th icon button (Terminal, Editor, Desktop, Apps, Upload, Download)
    const iconButtons = card.locator('button');
    await expect(iconButtons.nth(3)).toBeVisible();
  });

  test('clicking Apps button opens an Apps pane tab', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();

    // The pane tab bar should show "Apps" label in the main area
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('Apps pane opens the plugin catalog', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });
    await card.locator('button').nth(3).click();
    await page.locator('main [data-testid="manage-plugins"]').click();

    await expect(page.locator('[data-testid="plugin-catalog"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New definition' })).toBeVisible();
  });

  test('Apps pane exposes a ready installed plugin action directly and opens its sandboxed pane', async ({ page }) => {
    const definition = {
      id: 'plugin-ui-test', name: 'Plugin UI test', scope: 'owner', builtIn: false,
      manifest: { schemaVersion: 1, name: 'Plugin UI test', slug: 'plugin-ui-test', version: '1.0.0', description: 'Test plugin', lifecycle: { start: { argv: ['true'] } }, actions: [{ id: 'open', label: 'Open plugin', kind: 'private-ui', portId: 'ui', path: '/' }] },
    };
    const installation = { id: 'installation-ui-test', definitionId: definition.id, desiredEnabled: true, observed: { state: 'ready', ready: true } };
    // The pane scopes the catalog request with `?workerId=…`; Playwright glob
    // patterns match the complete URL, so an exact path glob would silently
    // miss this request and leave the action list dependent on live data.
    await page.route(/\/api\/plugins\/definitions(?:\?.*)?$/, route => route.fulfill({ json: [definition] }));
    await page.route('**/api/containers/*/plugins', route => route.fulfill({ json: [installation] }));
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });
    // Ready custom applications are also promoted to the worker card, below
    // its standard lifecycle/action row, without requiring Apps to be opened.
    const cardAction = card.getByTestId('worker-plugin-actions').getByRole('button', { name: /Plugin UI test.*Open plugin/ });
    await expect(cardAction).toBeVisible({ timeout: 15_000 });
    await card.locator('button').nth(3).click();
    const action = page.getByTestId('installed-plugin-actions').getByRole('button', { name: /Plugin UI test.*Open plugin/ });
    await expect(action).toBeVisible();
    await action.click();

    const frame = page.locator('[data-testid="plugin-application-frame"]');
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('sandbox', 'allow-forms allow-scripts');
    await expect(frame).toHaveAttribute('src', new RegExp(`/plugin-ui/${containerId}/installation-ui-test/open/`));
  });

  test('Apps pane shows Chromium app type', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });

    // Chromium app type card should be visible
    await expect(page.locator('main').getByText('Chromium', { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test('Apps pane shows SOCKS5 Proxy app type', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });

    // SOCKS5 Proxy app type card should be visible
    await expect(page.locator('main').getByText('SOCKS5 Proxy', { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test('multi-instance app types have a "+ New Instance" button (singletons use Start)', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });

    // Two multi-instance app types (chromium, socks5) → two "+ New Instance" buttons.
    const newInstanceButtons = page.locator('main').getByText('+ New Instance');
    await expect(newInstanceButtons).toHaveCount(2, { timeout: 10_000 });

    // Three singleton apps (vscode, vscode-desktop, ssh) → three "Start"
    // buttons while stopped.
    await expect(page.locator('main [data-testid="start-vscode"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('main [data-testid="start-vscode-desktop"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('main [data-testid="start-ssh"]')).toBeVisible({ timeout: 10_000 });
  });

  test('Apps pane lists VS Code Tunnel, Persistent VS Code, and SSH as singleton app types', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('main').getByText('VS Code Tunnel', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('main').getByText('Persistent VS Code', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('main').getByText('SSH Server', { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test('Apps pane shows app type descriptions', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });

    // Chromium description (bumped timeout — the /api/app-types call can
    // take longer under heavy concurrency in the dockerized runner)
    await expect(
      page.locator('main').getByText('Chromium browser with remote debugging (CDP)'),
    ).toBeVisible({ timeout: 30_000 });

    // SOCKS5 description
    await expect(
      page.locator('main').getByText('Lightweight SOCKS5 proxy via microsocks'),
    ).toBeVisible({ timeout: 30_000 });

    // Persistent VS Code description
    await expect(
      page.locator('main').getByText('Persistent code-server VS Code client in a noVNC-attached Chromium window'),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('pane tab label includes container name and "Apps"', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();

    // Tab label format is "{containerName} - Apps"
    const tabLabel = page.locator('main').getByText(`${displayName} - Apps`);
    await expect(tabLabel).toBeVisible({ timeout: 15_000 });
  });

  test('Apps pane shows the right empty-state label per app type', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });

    // Multi-instance apps show "No running instances".
    await expect(page.locator('main').getByText('No running instances').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('main').getByText('No running instances')).toHaveCount(2);

    // Singleton apps show "Not running".
    await expect(page.locator('main').getByText('Not running')).toHaveCount(3);
  });

  test('starting Persistent VS Code opens the Desktop pane', async ({ page, request }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });
    await card.locator('button').nth(3).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });

    try {
      const start = page.locator('main [data-testid="start-vscode-desktop"]');
      await expect(start).toBeVisible({ timeout: 10_000 });
      await start.click();
      await expect(page.locator('main').getByText(`${displayName} - Desktop`)).toBeVisible({ timeout: 30_000 });
    } finally {
      const api = new ApiClient(request);
      await api.stopApp(containerId, 'vscode-desktop', 'vscode-desktop').catch(() => {});
    }
  });

  test('VS Code tunnel Start surfaces a GitHub device code in the row within 60s', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    // Open the Apps pane.
    const iconButtons = card.locator('button');
    await iconButtons.nth(3).click();
    await expect(page.locator('main').getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 15_000 });

    // Click Start on the VS Code Tunnel singleton row.
    const startVscode = page.locator('main [data-testid="start-vscode"]');
    await expect(startVscode).toBeVisible({ timeout: 10_000 });
    await startVscode.click();

    // The auth block (with a real `XXXX-XXXX` code) must appear within ~60s —
    // `code tunnel` prints the prompt within a few seconds on a fresh tunnel,
    // and the Apps pane polls `/api/containers/:id/apps` every 5s. If the
    // underlying agent-data volume has cached auth, the tunnel jumps straight
    // to the Connected state and we accept that too (the user doesn't need
    // to re-auth in that case).
    const authCode = page.locator('main [data-testid="vscode-auth-code"]');
    const runningHint = page.locator('main', { hasText: 'Remote - Tunnels' });

    const deadline = Date.now() + 60_000;
    let seen: 'code' | 'connected' | null = null;
    while (Date.now() < deadline) {
      if (await authCode.first().isVisible().catch(() => false)) {
        seen = 'code';
        break;
      }
      if (await runningHint.first().isVisible().catch(() => false)) {
        seen = 'connected';
        break;
      }
      await page.waitForTimeout(2_000);
    }

    expect(seen).not.toBeNull();
    if (seen === 'code') {
      const codeText = await authCode.first().textContent();
      expect(codeText?.trim()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      // The clickable URL should also be there.
      await expect(page.locator('main a[href="https://github.com/login/device"]').first()).toBeVisible();
    }

    // Clean up: stop the tunnel so the next test isn't left with a running
    // instance (singleton apps return 409 on double-start).
    const stopBtn = page.locator('main button', { hasText: 'Stop' }).first();
    if (await stopBtn.isVisible().catch(() => false)) {
      await stopBtn.click();
    }
  });
});
