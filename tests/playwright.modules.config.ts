import { defineConfig } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Module lifecycle tests also exercise real metadata cleanup (e.g. workspace
// tombstones). Scope service singletons before imports; never touch developer
// /data just because no installation stack is running.
if (!process.env.DATA_DIR) {
  const fixtureData = mkdtempSync(join(tmpdir(), "agentor-incus-acceptance-"));
  process.env.DATA_DIR = fixtureData;
  // Managed-storage tests retain bounded recovery records on ambiguity. Never
  // erase their service store automatically when failed fixture cleanup leaves
  // Incus resources for operator diagnosis; successful tests clean exact state.
  if (process.env.INCUS_MANAGED_VOLUME_TEST !== 'true')
    process.once("exit", () => rmSync(fixtureData, { recursive: true, force: true }));
}

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
    "api/resource-monitor-lifecycle.spec.ts",
    "api/worker-self-access-policy.spec.ts",
    "api/ws-relay-origin.spec.ts",
    "api/worker-runtime-kind.spec.ts",
    "api/worker-lifecycle-coordinator.spec.ts",
    "api/incus-client.spec.ts",
    "api/incus-exec-transport.spec.ts",
    "api/incus-worker-commands.spec.ts",
    "api/incus-worker-experience.spec.ts",
    "api/incus-derived-image.spec.ts",
    "api/incus-worker-runtime.spec.ts",
    "api/incus-worker-lifecycle.spec.ts",
    "api/incus-applied-bootstrap.spec.ts",
    "api/incus-worker-observability.spec.ts",
    "api/incus-worker-network.spec.ts",
    "api/incus-traefik-routing.spec.ts",
    "api/incus-guest-network.spec.ts",
    "api/incus-full-stack.spec.ts",
    "api/incus-worker-storage.spec.ts",
    "api/incus-managed-volume.spec.ts",
    "api/incus-managed-volume-runtime.spec.ts",
    "api/incus-account-sharing.spec.ts",
    "api/incus-private-storage.spec.ts",
    "api/workspace-download-cancellation.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
});
