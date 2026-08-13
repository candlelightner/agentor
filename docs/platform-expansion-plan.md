# Platform expansion implementation plan

This document tracks the implementation of the storage, export, image, backup,
worker-configuration, and administrative-management workstreams. A feature is
only marked complete when its API and UI are usable end to end, authorization
and persistence are covered, failure paths are tested, and the public
documentation is current.

## Baseline audit (2026-08-04)

| Workstream | Current classification | Evidence / immediate gap |
|---|---|---|
| Asynchronous export/import | Implemented; current-image focused verification pending | Durable owner jobs, progress/cancel/expiry/recovery, disk preflight, streamed artifacts, default workspace-only and advanced rootfs paths, stopped-worker round trips, and secret exclusions are implemented. |
| Custom image builder/catalog | Implemented; controlled-runtime verification pending | Approved-base constrained contexts, real controlled/fake async builders, immutable image IDs, selection/defaults, test/promotion/rollback/rebuild, logs, cancellation, and cleanup are wired through API and UI. |
| Backup/restore | Implemented; current-image focused verification pending | Multi-workspace encrypted bundles, exact-minute scheduling, retention tombstones, cancellation/retry/resume, local/fake/Google providers, integrity verification, archived backup, atomic new restore, and rollback-safe original restore are implemented. |
| Volume inventory/offline browsing | Implemented; dual-storage focused verification pending | Running/stopped/archived/deleted/orphan inventory, bounded size, latest backup, owner-scoped hardened browse/preview/search/metadata/streamed download, backup, and clone cover directory and named-volume abstractions. Orphans remain deliberately non-browsable until a separately audited adoption workflow exists. |
| Worker-local variables/secrets | Implemented; current-image focused verification pending | Worker create/settings, precedence preview, encrypted write-only secrets, tmpfs secret files, desired/applied rebuild semantics, clone/export/backup omission, and isolation are implemented. |
| Administrative workspace | Implemented; current-image focused verification pending | Trusted digest-pinned overlay, persistent storage, existing terminal/editor/desktop service registration, red identity, privileged confirmations, non-secret control representation, and hardened Docker runtime are integrated. |
| Internal management MCP | Implemented; current-image focused verification pending | Internal-only listener/network, short-lived workspace identity, live fail-closed groups, bounded owner-checked/redacted logs, sanitized usage/worker-metric snapshots, user-global plain-variable management, one-use private streaming worker-import handoffs, and complete invocation audit are implemented. Dashboard proposal review is optional; harness confirmation is not a platform boundary. |
| Git-backed image recovery | Implemented; current-image focused verification pending | Versioned format, public/private GitHub, encrypted PAT and GitHub App paths, conflict-safe direct/branch/PR sync, Actions dispatch, GHCR digest recovery, credential erasure, API/UI, and fake integration tests are implemented. |

## Delivery order and dependencies

1. **Durable job core and asynchronous export.** Persist owner-scoped job
   metadata atomically; recover interrupted jobs safely; expose create/status,
   cancel, and authenticated streaming-download endpoints; make workspace-only
   the default; expire artifacts; remove partial files; redact manifest secrets.
2. **Offline storage inventory and browsing.** Introduce an owner-checked
   storage reader for both directory and named-volume modes. Volume helpers must
   be read-only, non-root where possible, capability-free, networkless, and
   short-lived. Reuse path and archive-streaming protections.
3. **Worker-local configuration.** Add precedence resolution and source-aware
   preview, then encrypted variables/secrets/secret files. This must land before
   backup and image catalog integrations so their exclusion contracts are
   stable.
4. **Backup/restore.** Reuse the job and storage abstractions; add encrypted,
   integrity-checked archives and a fake provider first, then Google Drive OAuth
   and resumable uploads without requiring live test credentials.
5. **Controlled local image builder/catalog.** Add versioned definitions and
   immutable digests behind a narrow builder boundary, then test/promote,
   rollback, defaults, quotas, and cleanup.
6. **Administrative workspace and management MCP.** Create the trusted overlay
   and dedicated internal network/workload identity before exposing controlled
   tools. Mutations remain subject to Agentor ownership, secret, lock, and
   capability controls; a harness decides whether to request confirmation.
7. **Git-backed image recovery.** Build on completed image definitions and job
   execution, using a dedicated encrypted repository credential and
   conflict-preserving synchronization.

## Cross-cutting acceptance gates

- Every resource is owner scoped; administrative access is explicit and tested.
- Secrets never appear in logs, API/MCP responses, artifacts, fixtures, build
  contexts, image layers, or backups unless a separately designed encrypted
  opt-in exists.
- Persisted records have a versioned, backward-compatible migration path.
- Jobs cover failure, cancellation, retry, cleanup, expiry, and restart
  recovery; public errors are safe and internal diagnostics are redacted.
- Archive and file paths reject traversal, symlink escape, oversized input, and
  malformed metadata before mutating storage.
- Each vertical slice updates OpenAPI metadata, feature/test inventories,
  architecture/user documentation, focused API/UI tests, typecheck, and
  `git diff --check` before commit.

## Known baseline constraints

- The baseline orchestrator typecheck failed on pre-existing Vue click handlers
  inferred as returning `boolean`. Those handlers were normalized to return
  `void`; the current typecheck is clean.
- Docker is reachable in the development worker even though `DOCKER_ENABLED`
  is unset; the isolated Dockerized suite is the authoritative integration
  baseline.
