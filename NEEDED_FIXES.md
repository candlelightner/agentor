# Needed Fixes — Platform Expansion Sprint

Historical findings and remaining open verification work from the
platform-expansion sprint. Sections explicitly marked resolved document the
original gap and its evidence; they are not open fixes. Sections explicitly
marked as requiring review or verification remain open. Per `CLAUDE.md`,
end-to-end Playwright verification (API + UI, real worker where applicable) is
required before any open feature item is considered done.

## 1. Google Drive backup account linking — historical record, configuration gap resolved

**Original symptom (now resolved):** The operator could not configure the installation's Google OAuth client from the dashboard before linking a Google Drive backup account.

**Original root cause (at the time):**
- The account-link UI *existed*: `BackupManagementModal.vue` rendered a "Link Google
  Drive" button (shown when a `google-drive` provider is present and not
  connected) and a "Disconnect Google Drive" button. The provider list returned
  by `GET /api/backup-providers` included a `google-drive` entry, so the button
  appeared.
- The gap was **configuration**: the OAuth start route
  (`server/api/backup-providers/google/oauth/start.post.ts`) required the
  orchestrator env vars `GOOGLE_BACKUP_CLIENT_ID` and
  `GOOGLE_BACKUP_REDIRECT_URI` (and the callback needed the client secret). When
  these were unset (the default, and in production where the fake provider was
  disabled), clicking "Link Google Drive" returned **503 "Google Drive backup
  OAuth is not configured"** — and there was **no dashboard UI to enter these
  credentials**. An operator had to edit env vars and restart the orchestrator
  to configure Google OAuth, which contradicted "doable from within the GUI".

**Resolution evidence:** Backup Management now exposes the administrator-only installation configuration flow. `GET`/`PUT` `/api/admin/backup-providers/google-oauth` report redacted status and accept the client ID, redirect URI, and write-only encrypted client secret; environment variables remain a backward-compatible fallback. The focused `tests/api/google-backup-oauth-installation.spec.ts` covers authorization, non-disclosure, and a mocked authorization challenge.

This does **not** establish a live-provider result: the account holder must still complete Google consent and have appropriate Drive permissions. A real link → consent → callback → token storage → backup → restore round trip remains an external-provider verification task, not a product configuration gap.

Relevant files: `orchestrator/app/components/BackupManagementModal.vue`,
`orchestrator/app/composables/useBackups.ts`,
`orchestrator/server/api/backup-providers/google/oauth/start.post.ts`,
`orchestrator/server/api/backup-providers/google/oauth/callback.get.ts`,
`orchestrator/server/utils/backup-manager.ts`, `orchestrator/server/utils/backup-provider.ts`.

## 2. UI/visual issues requiring visual inspection (operator-reported)

The operator observed additional UI issues in the new feature surfaces that
**require vision (screenshots) to diagnose** and are **not yet fixed**. They were
not described in detail here.

**Action for the next agent:** Do a **visual UI review** of every new
platform-expansion modal/flow — capture screenshots (Playwright `page.screenshot()`
or the noVNC desktop) and walk each end-to-end:
- Worker export (`ExportWorkerModal.vue`) and import (`ImportWorkerModal.vue`)
- Offline storage inventory & browser (`WorkspaceInventoryModal.vue`,
  `WorkspaceBrowserModal.vue`)
- Worker-local configuration & secrets (`WorkerConfigurationEditor.vue`)
- Backup management (`BackupManagementModal.vue`)
- Custom image builder & catalog (`ImageCatalogModal.vue`)
- Admin workspace (`AdminWorkspaceModal.vue`)
- Management MCP (`ManagementMcpModal.vue`)
- Sidebar entry points (`AppSidebar.vue`) and the worker card/detail actions

File the concrete defects found as follow-ups and fix them with UI specs.
Known concrete suspects to check: layout/overflow on the new modals, missing or
non-discoverable action buttons (see item 1), state/error feedback that hangs or
shows an indefinite spinner, and any flow that dead-ends without a clear
message.

## 3. Retroactive end-to-end verification requirement (process, already in CLAUDE.md)

Recorded for traceability: every feature of this sprint must be verified by an
end-to-end Playwright run (API + UI, real worker round-trips where the feature
touches worker lifecycle) before being claimed complete. The current test suite
covers the API layer green for all eight workstreams; the **UI-layer end-to-end
walks of each feature** (beyond the per-modal UI specs that exist) and the
**visual review** (item 2) are the remaining verification work.

## Pre-existing, non-sprint flakes (not "needed fixes", for awareness)

Not regressions from the sprint; do not block feature completion:
- `tests/api/clipboard.spec.ts:36` — `xclip -t image/png -o` readback returns
  null in the Dockerized test env (clipboard POST itself succeeds with correct
  metadata). Environment-sensitive.
- `tests/api/containers.spec.ts:577` — worker-create 500 under full-suite
  concurrency (resource-sensitive).
- `tests/api/export-jobs.spec.ts:164` — rootfs export/import round-trip 3-min
  timeout under full-suite concurrency; passes in focused runs.
