import { defineConfig } from '@playwright/test';
import modules from './playwright.modules.config';

/** Isolated server/terminal diagnostics including actual Chromium components.
 * The general modules suite remains browser-free. No live stack/session needed. */
export default defineConfig({
  ...modules,
  testMatch: [
    'api/management-logs-domain.spec.ts',
    'api/management-mcp-transport.spec.ts',
    'api/server-log-read.spec.ts',
    'api/server-log-listeners.spec.ts',
    'api/terminal-copy.spec.ts',
    'ui/server-log-download-isolated.spec.ts',
    'ui/terminal-copy-isolated.spec.ts',
  ],
});
