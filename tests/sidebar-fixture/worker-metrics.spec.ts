import { test, expect } from '@playwright/test';

const metric = () => ({ workerId: 'ordinary-fixture', containerName: 'fixture', displayName: 'Research worker',
  status: 'running', cpuCapacity: 'worker', cpuUtilization: 25, memoryAccounting: 'guest-htop',
  memoryUsedBytes: 1024 ** 3, memoryLimitBytes: 2 * 1024 ** 3, memoryUtilization: 50,
  diskUsedBytes: 0, netRxBytesPerSec: 0, netTxBytesPerSec: 0, blkReadBytesPerSec: 0, blkWriteBytesPerSec: 0,
  lastChecked: new Date().toISOString() });

test('guest RAM uses IEC units and expires during failed polling without showing fresh zero usage', async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  await page.route('**/api/worker-metrics', route => ++requests === 1
    ? route.fulfill({ json: { workers: [metric()] } }) : route.abort());
  await page.goto('/?role=ordinary&liveMetrics');
  const card = page.locator('.sidebar-worker-card').filter({ hasText: 'Research worker' });
  const metrics = card.getByTestId('worker-metrics');
  await expect(metrics).toContainText('1.0 GiB');
  await expect(metrics.locator('[title*="Guest RAM"]')).toHaveAttribute('title', /htop accounting.*2.0 GiB/);
  await expect(metrics).toContainText('25%');
  await page.clock.fastForward(31_000);
  await expect(card.getByTestId('worker-metrics-unavailable')).toHaveText('Metrics unavailable');
  await expect(metrics).not.toContainText('0 B');
});

test('unavailable VM telemetry is explicit while the worker remains running', async ({ page }) => {
  await page.route('**/api/worker-metrics', route => route.fulfill({ json: { workers: [
    { ...metric(), status: 'unknown', memoryUsedBytes: 0, memoryLimitBytes: 0, error: 'Guest metrics are unavailable.' },
  ] } }));
  await page.goto('/?role=ordinary&liveMetrics');
  const card = page.locator('.sidebar-worker-card').filter({ hasText: 'Research worker' });
  await expect(card.getByTestId('worker-metrics-unavailable')).toBeVisible();
  await expect(card.getByTestId('worker-metrics')).not.toContainText('0 B');
});
