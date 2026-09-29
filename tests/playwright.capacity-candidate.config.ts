import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: ['api/worker-runtime-capacity-candidate.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, timeout: 30_000, reporter: [['list']] });
