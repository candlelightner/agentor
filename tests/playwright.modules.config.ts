import { defineConfig } from "@playwright/test";

/** Fast server-module tests that import utility code directly and therefore do
 * not require a running Agentor installation or authenticated global setup. */
export default defineConfig({
  testDir: ".",
  testMatch: [
    "api/plugin-core.spec.ts",
    "api/plugin-desktop-core.spec.ts",
    "api/portable-managed-volume-format.spec.ts",
    "api/portable-managed-volume-archive.spec.ts",
    "api/portable-managed-volume-plan.spec.ts",
    "api/portable-managed-volume-journal.spec.ts",
    "api/portable-managed-volume-runtime.spec.ts",
    "api/admin-workspace-store-transactions.spec.ts",
    "api/container-store-quarantine.spec.ts",
    "api/instance-backup-*.spec.ts",
    "api/instance-restore-helper.spec.ts",
    "api/managed-volume-store.spec.ts",
    "api/managed-volume-sizing-control.spec.ts",
    "api/managed-volume-sizing-mcp-authority.spec.ts",
    "api/managed-volume-sizing.spec.ts",
    "api/management-image-backup-domain.spec.ts",
    "api/management-worker-domain.spec.ts",
    "api/provider-http.spec.ts",
    "api/worker-self-access-policy.spec.ts",
    "api/workspace-download-cancellation.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
});
