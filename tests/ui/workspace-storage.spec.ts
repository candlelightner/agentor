import { test, expect, type Page } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';

const workspace = {
  id: 'workspace-ui-test',
  workerId: 'worker-ui-test',
  owner: 'owner-ui-test',
  workerName: 'Offline UI Worker',
  backend: 'volume',
  state: 'archived',
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-02-03T04:05:06.000Z',
  sizeBytes: 12_345,
  latestBackup: null,
  capabilities: { browse: true, backup: false, clone: false },
};

const rootEntries = [
  { name: 'docs', path: 'docs', type: 'directory', size: 0, mtime: '2026-02-01T00:00:00Z' },
  { name: 'root-file.txt', path: 'root-file.txt', type: 'file', size: 9, mtime: '2026-02-01T00:00:00Z' },
];
const docsEntries = [
  { name: 'readme.txt', path: 'docs/readme.txt', type: 'file', size: 21, mtime: '2026-02-02T00:00:00Z' },
  { name: 'binary.dat', path: 'docs/binary.dat', type: 'file', size: 4, mtime: '2026-02-02T00:00:00Z' },
];

async function mockWorkspaceApi(page: Page) {
  const storage = { disk: { freeBytes: 10_000_000, totalBytes: 100_000_000, warning: 'warning' }, workspaces: { count: 1, bytes: 12_345 }, docker: { imagesBytes: 4096, buildCacheBytes: 2048 }, staging: [{ id: 'tmp', label: 'Backup/export staging', bytes: 1024, cleanup: true }], helpers: { total: 2, stale: 1 } };
  await page.route('**/api/admin/storage/cleanup', (route) => route.fulfill({ json: { reclaimedBytes: 1024, actions: ['stale-staging'], inventory: storage } }));
  await page.route('**/api/admin/storage', (route) => route.fulfill({ json: storage }));
  await page.route('**/api/workspaces', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([workspace]),
  }));
  await page.route('**/api/workspaces/workspace-ui-test/files**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') || '';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ path, entries: path === 'docs' ? docsEntries : rootEntries }),
    });
  });
  await page.route('**/api/workspaces/workspace-ui-test/search**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ query: 'readme', path: 'docs', results: [docsEntries[0]], truncated: false }),
  }));
  await page.route('**/api/workspaces/workspace-ui-test/metadata**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    const entry = docsEntries.find((item) => item.path === path) || rootEntries.find((item) => item.path === path);
    return route.fulfill({ status: entry ? 200 : 404, contentType: 'application/json', body: JSON.stringify(entry || {}) });
  });
  await page.route('**/api/workspaces/workspace-ui-test/preview**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === 'docs/readme.txt') {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }, body: 'safe offline preview' });
    }
    return route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ statusMessage: 'File is not safe text or a supported image' }) });
  });
  await page.route('**/api/workspaces/workspace-ui-test/download**', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="readme.txt"',
      },
      body: 'safe offline preview',
    }),
  );
}

async function openInventory(page: Page) {
  await goToDashboard(page);
  await page.getByRole('button', { name: 'Workspace storage' }).click();
  await expect(page.locator('[data-testid="workspace-inventory"]')).toBeVisible();
}

async function openBrowser(page: Page) {
  await openInventory(page);
  await page.locator('[data-testid="workspace-inventory"]').getByRole('button', { name: 'Browse' }).click();
  const browser = page.locator('[data-testid="workspace-browser"]');
  await expect(browser).toBeVisible();
  return browser;
}

test.beforeEach(async ({ page }) => {
  await mockWorkspaceApi(page);
});

test('sidebar opens inventory and renders the storage contract with unavailable actions disabled', async ({ page }) => {
  await openInventory(page);
  const inventory = page.locator('[data-testid="workspace-inventory"]');
  await expect(inventory).toContainText('Offline UI Worker');
  await expect(inventory).toContainText('owner-ui-test');
  await expect(inventory).toContainText('volume');
  await expect(inventory).toContainText('archived');
  await expect(inventory).toContainText('12 KB');
  await expect(inventory.getByRole('button', { name: 'Back up' })).toBeDisabled();
  await expect(inventory.getByRole('button', { name: 'Clone' })).toBeDisabled();
});
test('administrator sees disk warning and conservative cleanup actions', async ({ page }) => {
  await openInventory(page); const panel = page.locator('[data-testid="storage-management"]');
  await expect(panel).toContainText('Disk space warning'); await expect(panel).toContainText('Docker images');
  await panel.getByRole('button', { name: 'Clean old staging' }).click(); await expect(panel).toContainText('Backup/export staging');
});

test('browse, search result names, clear, and breadcrumb navigation stay coherent', async ({ page }) => {
  const browser = await openBrowser(page);
  await expect(browser.getByRole('button', { name: 'docs', exact: true })).toBeVisible();
  await browser.getByRole('button', { name: 'docs', exact: true }).click();
  await expect(browser.getByRole('button', { name: 'readme.txt', exact: true })).toBeVisible();

  await browser.getByPlaceholder('Search this directory and descendants').fill('readme');
  await browser.getByRole('button', { name: 'Search' }).click();
  await expect(browser.getByRole('button', { name: 'readme.txt', exact: true })).toBeVisible();
  await browser.getByRole('button', { name: 'Clear' }).click();
  await expect(browser.getByRole('button', { name: 'readme.txt', exact: true })).toBeVisible();

  await browser.getByRole('button', { name: 'workspace', exact: true }).click();
  await expect(browser.getByRole('button', { name: 'root-file.txt', exact: true })).toBeVisible();
  await expect(browser.getByRole('button', { name: 'readme.txt', exact: true })).toHaveCount(0);
});

test('safe text preview is rendered as text with metadata', async ({ page }) => {
  const browser = await openBrowser(page);
  await browser.getByRole('button', { name: 'docs', exact: true }).click();
  await browser.getByRole('button', { name: 'readme.txt', exact: true }).click();
  await expect(browser).toContainText('safe offline preview');
  await expect(browser).toContainText('docs/readme.txt');
  await expect(browser).toContainText('file');
});

test('unsupported preview leaves metadata visible and explains the safe-preview refusal', async ({ page }) => {
  const browser = await openBrowser(page);
  await browser.getByRole('button', { name: 'docs', exact: true }).click();
  await browser.getByRole('button', { name: 'binary.dat', exact: true }).click();
  await expect(browser).toContainText('docs/binary.dat');
  await expect(browser).toContainText(/No safe preview|not safe text|unsupported/i);
});

test('download uses a native authenticated URL and never creates a Blob URL', async ({ page }) => {
  await page.addInitScript(() => {
    const original = URL.createObjectURL.bind(URL);
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    (window as any).__workspaceObjectUrls = 0;
    (window as any).__workspaceDownloadHref = '';
    URL.createObjectURL = (value: Blob | MediaSource) => {
      (window as any).__workspaceObjectUrls += 1;
      return original(value);
    };
    HTMLAnchorElement.prototype.click = function () {
      if (this.href.includes('/api/workspaces/') && this.href.includes('/download')) {
        (window as any).__workspaceDownloadHref = this.href;
      }
      return originalAnchorClick.call(this);
    };
  });
  const browser = await openBrowser(page);
  await browser.getByRole('button', { name: 'docs', exact: true }).click();
  await browser.getByRole('button', { name: 'readme.txt', exact: true }).click();

  const downloadPromise = page.waitForEvent('download');
  await browser.getByRole('button', { name: 'Download item' }).click();
  await downloadPromise;
  const href = await page.evaluate(() => (window as any).__workspaceDownloadHref);
  expect(new URL(href).searchParams.getAll('path')).toEqual(['docs/readme.txt']);
  expect(await page.evaluate(() => (window as any).__workspaceObjectUrls)).toBe(0);
});
