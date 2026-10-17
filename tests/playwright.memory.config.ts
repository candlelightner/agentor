import { defineConfig } from '@playwright/test';
import modules from './playwright.modules.config';

/** Isolated native allocation/API/editor acceptance; no Docker or Incus state. */
export default defineConfig({
  ...modules,
  testMatch: ['api/worker-memory-policy.spec.ts', 'api/incus-worker-runtime.spec.ts', 'ui/environment-memory-isolated.spec.ts'],
});
