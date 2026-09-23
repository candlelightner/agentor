import { chromium, defineConfig } from '@playwright/test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, symlinkSync } from 'node:fs';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const nuxtDir = join(fixtureDir, 'nuxt');
const moduleLink = join(nuxtDir, 'node_modules');
if (!existsSync(moduleLink)) symlinkSync('../../../orchestrator/node_modules', moduleLink, 'dir');
const bundledBrowser = chromium.executablePath();
const launchOptions = existsSync(bundledBrowser)
  ? undefined
  : existsSync('/usr/bin/chromium')
    ? { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] }
    : undefined;

export default defineConfig({
  testDir: '.',
  testMatch: 'sidebar.spec.ts',
  reporter: [['list']],
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4180',
    viewport: { width: 1200, height: 1100 },
    browserName: 'chromium',
    launchOptions,
  },
  webServer: {
    command: `${resolve(fixtureDir, '../../orchestrator/node_modules/.bin/nuxt')} dev . --host 127.0.0.1 --port 4180`,
    cwd: nuxtDir,
    url: 'http://127.0.0.1:4180',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
