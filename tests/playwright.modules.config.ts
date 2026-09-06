import { defineConfig } from "@playwright/test";

/** Fast server-module tests that import utility code directly and therefore do
 * not require a running Agentor installation or authenticated global setup. */
export default defineConfig({
  testDir: ".",
  testMatch: [
    "api/admin-workspace-store-transactions.spec.ts",
    "api/container-store-quarantine.spec.ts",
    "api/instance-backup-*.spec.ts",
    "api/instance-restore-helper.spec.ts",
    "api/management-image-backup-domain.spec.ts",
    "api/workspace-download-cancellation.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
});
