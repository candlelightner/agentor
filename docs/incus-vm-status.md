# Incus/QEMU VM Worker Migration Status

- Current Phase: Phase 1 (Persisted runtime kind complete) -> Phase 2 (Minimal Incus API client)
- Completed Commits:
  - `feat(runtime): persist worker runtime kind`
- Baseline Tests Passed:
  - 209 module tests passed (`npm run test:modules` in `tests/`)
  - Typecheck passed (0 errors in `orchestrator`)
- Tests Failing: None
- Discovered Constraints & Key Invariants:
  - Disposable VM `agentor-kata-preflight` reachable via SSH on 172.19.0.1:22375 as `kata-test` (sudo authorized).
  - Incus 6.0.0 installed on disposable VM with `default` storage pool and `incusbr0` (10.159.68.1/24).
  - `d2vm v0.4.0` installed at `/usr/local/bin/d2vm` on disposable host.
  - Runtime kind is durable state on `WorkerRecord` (`legacy-docker` | `incus-vm`). Default for missing is `legacy-docker`.
  - Admin workspace is not migrated.
  - Ephemeral runtime config in `/run/agentor/` in guest.
  - Anti-spoofing mandatory on worker NICs.
  - No Incus Unix socket mounted in Orchestrator; mutual TLS HTTPS API with restricted `agentor` project.
- Next Exact Task: Phase 2 — Minimal Incus API client (mutual TLS, restricted project selection, readiness, instances, exec, websockets, files, storage).
