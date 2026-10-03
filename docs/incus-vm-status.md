# Incus/QEMU VM Worker Migration Status

## CURRENT HANDOFF

- Goal: finish the authoritative implementation contract through Phase 13; user explicitly resumed and requested rebase onto main. No production-host mutation, main push/merge, automatic legacy migration, or architecture restart.
- Resume checkpoint: Phase 5 WIP preserved; checkpoint it before rebasing onto fetched main `e38c2d4` (preserve running workers on observability failures). Account diagnostic (3.3m, failed) confirmed `Stale file handle` and `incus_cred[/codex.json//deleted]`: target validation precedes unmount. No binder correction applied yet. Disposable host idle, no active Incus operations/test/build; old manager fixture `agentor-worker-beb4f151-408f-45d8-b93a-8637b1125162` stopped and retained. Signed LTS setup option retained.
- Current phase: **Phase 5 in progress**. Phases 3–4 are committed and live accepted.
- Exact subtask: fresh OCI-derived image built/imported successfully: `agentor-worker-phase5-accepted` fingerprint `075a3e63f544434d4ffc865d04dfb16ce797c22669901d247ea26a83bb376baa`, recipe `a03829907bc97b31422b0ff2e4faf8a08160abb36887b184e3f482752defc9cd`, artifacts `/var/tmp/agentor-phase5-accepted.hjbvf8Ae`. Original four-gate runner is authoritatively absent (no test process/tmux/exit file); log proves fresh boot passed (1.3m), native Docker persistence passed (5.2m), account sharing failed, manager gate has no result. Account-only diagnostic rerun active; API forward recreated in `incus-validation:incus-api`. No guest source injection.
- Latest completed commit: `4c5775b` (Phase 4); `9f395d9` (Phase 3 correction/live acceptance following initial pipeline `979124d`), `29edb8b` / `c216cf9` (Phases 1–2).
- Working tree: intentional Phase 5 WIP: core volumes wired into create/start/delete, safe identified Docker initializer and generation-2 image gate, mount checks, narrow account share/guest-file-bind implementation, nofollow canonical credential I/O + usage refresh. Additional snapshot at `/workspace/incus-phase5-wip.jeXEz2a0` preserves WIP before these corrections.
- Verification: Phase 4 public-manager live gate passed (1.6 minutes): create, installation metadata, guest provisioning, editor/noVNC, authoritative inventory, public stop, start/SSH/marker reprovision, public delete/WorkerRecord cleanup, no Docker fallback. Account authorization is mocked for this bounded module acceptance; full HTTP/UI/account persistence is not yet claimed. Full module suite 229 passed / two gated tests skipped (231 total); both gated tests separately passed. Typecheck passed. Full API/UI and Phase 13 acceptance remain outstanding.
- Verification added: rebuilt-image live gate passed (1.2 minutes): unattended EFI/systemd/agent/sudo; worker/Docker/socket/containerd inactive before provisioning; UID 1000 reads ephemeral config; configured tmux/Xvfb/fluxbox/x11vnc/editor 302/noVNC 200. Client focused suite passed 12/12 before moving URL-origin coverage into it. Typecheck, shell syntax, diff checks passed.
- Phase 5 evidence: generation-2 boot/provisioning gate passed; production-manager lifecycle passed (1.5m); native Docker pull/run/build/Compose/inner privilege, workspace/agent/Docker after reboot/root replacement and disable/re-enable passed (4.1m). Full modules 243 passed/four gated tests skipped before two additional security tests; focused security/runtime 17 passed/three skipped afterwards. Serial `incus_docker`, ext4, overlay2 verified. Shared-account live startup exposed recursive chown crossing virtiofs mounts; fix confines ownership repair to private filesystems, final image rebuilding. Phase 5 is NOT closed yet.
- Current pending gate: fresh image including private helper plus complete same-account/Docker/manager acceptance. Incus 6.0.0 ownership defect fixed by supported LTS patch upgrade, with no wider host grants. Private ownership helper explicitly prunes account overlays (find -xdev alone was insufficient). Production creation/start now require patched Incus >=6.0.5; regression passed. Focused modules 20 passed/three gated skipped; typecheck passed. Disposable `br_netfilter` and compatible Rust virtiofsd remain setup/check requirements.
- Cache corrections required by contract: immutable OCI, bootstrap generation, pinned d2vm v0.4.0, detected architecture, recipe contents; same-host lock and import-before-atomic-alias-update. No image-proof or scheduler subsystem.
- Disposable host: disk now 100 GiB / root ext4 96 GiB. Rebuilt image `agentor-worker-takeover` = `b88c1d5a35220e52d568fe1ef7bebb0bb644d6cd8201f27b88c57bf3f74be714`; artifacts `/var/tmp/agentor-takeover-final.0eW5WC7z`. Original image, old logs, deleted previous root disk mounted at `/tmp/mnt2`, guest recovery backup, local image backup, and scratch raw output preserved. Details below.
- Exact next action: inspect tmux runner/process/log/exit status; do not restart a live gate. If all four pass, final diff review and commit Phase5, then Phase6. Full reviewed modules 249 passed/four gated skipped (253), typecheck passed; enumerated2197 tests/222 files (1566API/157 +631UI/65). Existing start now rejects missing canonical volumes without allocations; manager live gate injects permanent-delete cleanup failure and tests archived retry. Version floor distinguishes LTS6.0>=.5 from older still-defective rolling6.1–6.9; rolling>=6.10 accepted. Three interrupted VMs/seven private volumes removed only after validation; dummy files preserved `/var/tmp/agentor-account-diagnostic-preserved.mi381QMg`. Original images/artifacts and stopped DB backup untouched. Narrow account allowlist synchronization remains Phase12, not runtime mTLS authority. Phase6 must use host lease+MAC identity (guest /state.network is untrusted), reject routed-subnet bypass/ambiguity, use VM incarnation/cache invalidation. Continue Phases5–13.
- Remaining contract gates: full persisted-data inventory/sharing; safe identified ext4/overlay2 Docker and enable/disable persistence; authoritative addresses/routing/worker-self; exec/PTY/files/plugins; lifecycle/self-reboot/orphans; existing managed volumes/networks/authorized mounts; runtime-safe new backup/import plus old→legacy compatibility; small explicit admin migration/rollback retaining source; idempotent operator bootstrap/check/Portainer; automated complete acceptance. Hardware passthrough and new network policy remain out of scope.
- Operator decision: Phase 12 setup should offer the signed supported Incus LTS package source (explicit user choice); checking only stock Ubuntu 6.0.0 is insufficient. Do not apply this to production automatically.

## Roadmap & Phase Status

- **PHASE 0 — Baseline & impact map**: COMPLETE
- **PHASE 1 — Persisted runtime kind**: COMPLETE (commit `29edb8b` - `feat(runtime): persist worker runtime kind`)
- **PHASE 2 — Minimal Incus API client**: COMPLETE (commit `c216cf9` - `feat(incus): add restricted TLS client`)
- **PHASE 3 — Derived image pipeline**: COMPLETE (corrective pipeline and rebuilt-image live boot/provisioning/services gate passed; follow-up milestone follows `979124d`)
- **PHASE 4 — Minimal Incus worker create/start**: COMPLETE (real ContainerManager create/start/provision/inventory/stop/delete gate passed; intentionally pending persistence/feature slices follow)
- **PHASE 5 — Persistent storage + Docker**: IN PROGRESS
- **PHASE 6 — Routing and worker identity**: PENDING
- **PHASE 7 — Terminal/files/plugins**: PENDING
- **PHASE 8 — Full lifecycle/reconciliation**: PENDING
- **PHASE 9 — Managed volumes/networks/host mounts**: PENDING
- **PHASE 10 — Backup/export/import**: PENDING
- **PHASE 11 — Legacy migration**: PENDING
- **PHASE 12 — Host bootstrap + Portainer**: PENDING
- **PHASE 13 — Full automated acceptance**: PENDING

---

## Authoritative Scope Decisions & Invariants

1. **Backwards Compatibility & Backup Restoration**:
   - Old / pre-Incus backups do NOT restore directly as Incus workers.
   - WorkerRecords without runtime metadata restore as `legacy-docker`, preserving existing behavior.
   - Conversion to `incus-vm` happens ONLY through the explicit Phase 11 migration path. Do not duplicate migration logic inside backup restore.
   - Admin workspaces remain Docker containers and are not migrated.

2. **Worker Identity & VM IP Addressing**:
   - VM IP addresses are runtime state, NOT durable `WorkerRecord` configuration.
   - The `WorkerRecord` is the durable identity.
   - Current addresses are queried authoritatively from Incus and cached in memory. Correctness must tolerate IP changes across restarts/leases.

3. **Phase 9 Managed Networks Scope**:
   - Only preserves existing Agentor Managed Network semantics.
   - Map managed networks to Incus networks/NICs and enforce required IP/MAC anti-spoofing (`security.ipv4_filtering: true`, `security.mac_filtering: true`).
   - Do NOT expand this into a new worker-to-worker isolation or egress-policy subsystem; that remains explicitly out of scope.

4. **Phase 11 Legacy Migration Scope**:
   - Must remain a small, bounded migration mechanism.
   - Flow: Stop the legacy source worker and leave its container and source volumes untouched. Create destination persistent state, copy data, create and validate the Incus VM, and only then commit the runtime switch.
   - On failure: discard/clean incomplete destination resources and restart the untouched legacy source.
   - Use only a small bounded per-worker migration state for crash recovery.
   - Do NOT introduce generic snapshot frameworks, global transaction journals, capacity ledgers, image-proof systems, or other generalized migration infrastructure.

5. **Security & Control-Plane Invariants**:
   - Mutual TLS HTTPS API for Incus with restricted project `agentor` (no unix socket mounted in orchestrator container).
   - Mandatory anti-spoofing on worker NICs (`security.ipv4_filtering: true`, `security.mac_filtering: true`).
   - Ephemeral runtime config passed in `/run/agentor/worker.env` via guest agent file push.
   - Native Docker in VM runs on guest ext4 block volume (`/var/lib/docker`) on dedicated Incus custom block volume.
   - Never fall back to privileged Docker if Incus operations fail.

---

## Current Status Details

### Prior Feasibility Evidence (not current Phase 3 acceptance)
- Validated end-to-end on live QEMU/KVM on disposable host `agentor-kata-preflight` (`172.19.0.1:22375`).
- `worker/vm/Dockerfile.vm`: Layered on base worker image with kernel (`linux-image-virtual`), systemd init, bootloader (`grub-efi`), `dbus`, `netplan.io`, `udev`, `agentor-worker.service`, `agentor-docker-storage.service`, and `systemd-networkd`.
- `worker/vm/agentor-docker-storage.sh`: Auto-formats and mounts `/dev/disk/by-id/*incus_docker*` to `/var/lib/docker`.
- `worker/entrypoint.sh`: Sourced `/run/agentor/worker.env` and supports systemd native Docker.
- `scripts/build-incus-worker-image.sh`: Builds VM image, converts via `d2vm --raw`, converts to GPT with ESP partition (`sgdisk -g`), installs UEFI GRUB (`grub-install --target=x86_64-efi --removable`), compresses with `qemu-img convert -c`, and imports into Incus with alias `agentor-worker-vm`.
- Empirical validation: VM launched, booted in ~3 seconds, acquired DHCP IP, code-server (:8443) and noVNC (:6080) responsive, `incus-agent` working, native Docker verified (`docker run --rm busybox echo 'NATIVE DOCKER IN VM WORKS!'`).

### Takeover reconciliation (2026-10-03)
- Local branch `feature/incus-vm-workers`, HEAD `979124df19f8e3247ae10dbf35e4cf55fbf804ed`; clean at takeover, no tracking upstream. Local main/cached origin/main remain `007aded`; no fetch/pull performed.
- Phases 1–3 are committed. Previous Phase 3 completion claims above await independent takeover verification; no phases have been restarted.
- Disposable host: restricted project `agentor`, shared images/network (`features.images=false`, `features.networks=false`), empty project default profile, `incusbr0` (`10.159.68.1/24`), directory storage pool `default`.
- Retained image: alias `agentor-worker`, fingerprint `af19645106d36daf14320901b22b5b93d6210de2556663bd7355ea79b12ce6d4`; no current instances or custom volumes. Prior VM logs retained. No conversion/build/QEMU process running; stale console operation for removed `test-vm` remains.
- Guest checkout `/home/ubuntu/agentor`: detached at `007aded`, nine modified tracked files and twelve untracked implementation files. Preserved binary diffs and all 21 implementation files at `/home/ubuntu/incus-takeover-recovery.SuOkJjCL`, copied and checksum-verified at `/workspace/incus-takeover-recovery.SuOkJjCL` outside the local repository.
- Committed builder includes GPT/ESP, removable GRUB, and `startup.nsh`; guest builder is older and lacks finalization. Secure Boot disabling is not yet implemented in worker lifecycle code.
- Existing SSH forward on local port 18443 is disposable-test infrastructure only.
- Disposable VM disk expanded by operator's host agent: guest sees 100 GiB `/dev/vda`, root ext4 already grown to 96 GiB, 68 GiB free at verification. No additional resize needed.
- Retained original image metadata/rootfs also copied to `/workspace/incus-takeover-recovery.SuOkJjCL/phase3-original-image.tar`. Original imported image remains in Incus.
- Removed only takeover-created `takeover-phase3` and failed-test custom block volume `test-vol-1791036797434`; no persistent user data. Prior artifacts remain.
- Additional retained artifact discovered: loop0 backs deleted previous `test-vm/root.img`, mounted at `/tmp/mnt2`. Left untouched; do not detach/delete until its useful state is reconciled.
- Corrected Phase 3 boot order locally: worker unit requires `/run/agentor/worker.env`, worker/Docker/socket are not automatically enabled, one shell parser, no persistent `/etc/agentor` fallback. Builder keys cache by OCI plus recipe, includes current entrypoint, explicitly requests split FAT boot partition, and cleans mounts/loop devices on failure.
- Scratch conversion at `/workspace/incus-build-scratch.WHz5YWNJ` produced raw disk but failed d2vm final root chown through SFTP. Preserved output. Native conversion now running on expanded guest disk, with separate alias `agentor-worker-takeover`. Scratch SSH/SFTP is disposable-test infrastructure only.
- Current verification: module suite 225 passed / one explicitly gated production-path live test skipped (226 total); typecheck zero errors. Initial baseline run 219 passed / one live timeout; isolated Incus rerun 11/11 passed, later full run passed its live client test.
- Phase 4 currently rejects Docker/shared credentials/host mounts/custom OCI mappings pending subsequent integrations. Imported pre-Incus bundles explicitly stay legacy; Incus handles use a non-Docker identifier to prevent accidental backend calls. No fallback.
- Roadmap remains Phase 0 through Phase 13; Phases 4–13 are outstanding.
- Corrected native pipeline completed at `/var/tmp/agentor-takeover-final.0eW5WC7z` (2.6 GiB qcow2, pinned source OCI). Atomic alias PUT verified with an explicit project query; `incus query --project` is unsupported despite showing the global flag. Initial timeout/failed-launch fixtures removed after inspecting their completed state; original image and recovery data untouched.
- Phase 4 bounded review findings fixed: installation ownership on every mutation/inventory, start capability guards, SSH→env→marker ordering, cleared stale readiness/active-service polls, and verified production TLS on every client operation. No test network/storage defaults in runtime configuration. Test mTLS certificate fingerprint `4e8ac5555412…` now grants only `agentor`; live default-project access denied. Normal account/shared-storage integration remains Phase 5.

### Phase 5 persistent-state inventory

| State | Existing canonical source | Incus requirement |
|---|---|---|
| Workspace | Per-user workspace directory or `<worker>-workspace` Docker volume | Private UID/GID 1000 filesystem volume; retain on rebuild/archive |
| Agent/editor state | Per-user agents directory or `<worker>-agents` volume | Private filesystem volume, including Kilo state/cache |
| Docker | `<worker>-docker` volume | Identified, private ext4 block volume; retain on disable/rebuild/archive |
| Claude/Codex/Gemini credentials | `/data/users/<owner>/credentials/{claude,codex,gemini}.json` | Preserve live shared writes and existing account status/reset API |
| Kilo config/data | `/data/users/<owner>/kilo/{config,data}` | Live same-owner directory sharing, including atomic rename/SQLite |
| SSH public keys | `/data/users/<owner>/ssh/authorized_keys` | Read-only access; account updates propagate to running workers |
| Selected persistent paths | `agentor-persist-<worker>-<path hash>` | Preserve current selections; integrate managed storage/backup semantics |
| Managed volumes | Durable owner/attachment store, `agentor-persist-<volume UUID>` | Retain until explicitly deleted; worker deletion must not destroy them |
| Authorized host mounts | Exact approved HostMountStore source/grant | Only granted sources/modes; Phase 9 |
| Runtime config/secrets | Newly provisioned `/run` files | Ephemeral; regenerate every boot; never canonical root-disk data |

Boot-only credential copies are not equivalent to current sharing. Use only narrow server-controlled account directories under platform data, with explicit restricted-project allowlisting; no worker-controlled raw sources and no whole-user/control-plane metadata mount. Keep workspace/agent/Docker custom volumes independent of VM lifetime.

### Next Exact Task
- Complete Phase 5 runtime wiring: worker-owned filesystem volumes; exact source/metadata checks before Docker initialization; preserve/reuse Docker on disable/re-enable; cleanup only detached core volumes.
- Preserve canonical shared-account credential/Kilo directories through narrow server-owned disk sources; boot-only copies are insufficient. SSH public keys may be pushed, but account changes must propagate immediately.
- Rebuild under a fresh output/alias; run boot gate and live Docker run/build/compose/privileged plus restart/rebuild persistence. Independent bounded review is running. Do not mark acceptance complete from module tests.
