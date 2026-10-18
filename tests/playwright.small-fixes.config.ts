import { chromium, defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import modules from './playwright.modules.config';
export default defineConfig({ ...modules, timeout: 60_000, use: { launchOptions: !existsSync(chromium.executablePath()) && existsSync('/usr/bin/chromium')
  ? { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] } : undefined }, testMatch: [
  'api/terminal-copy.spec.ts', 'api/admin-workspace-resources.spec.ts', 'api/admin-workspace-store-transactions.spec.ts',
  'api/admin-native-runtime.spec.ts', 'api/admin-native-authority.spec.ts',
  'ui/terminal-copy-isolated.spec.ts', 'ui/admin-workspace-isolated.spec.ts',
] });
