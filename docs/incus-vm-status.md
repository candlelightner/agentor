# Incus/QEMU VM Worker Migration Status

## CURRENT HANDOFF

- Goal: authoritative Phase 0–13 contract; user resumed `/goal`. No production-host mutation, main push/merge, automatic migration, architecture restart, or network-policy expansion.
- Current phase: **Phase 5 accepted; Phase 6 next**. Account credential stale-bind correction implemented, independently reviewed, and live verified.
- Git: `feature/incus-vm-workers` rebased onto main health-check fix `e38c2d4`. HEAD `c3db054` is an explicitly incomplete Phase 5 WIP checkpoint; latest completed phase commit `b50c7d1` (Phase 4), `cab1776` (Phase 3 correction). Original history/WIP retained in `recovery/incus-pre-healthcheck-rebase-c984f7d` plus outside-repo recovery snapshots. Intentionally dirty: binder/test/docs corrections.
- Current evidence: 256 modules passed / four gated skipped (260 total), including main observability regressions; typecheck passed. Enumeration: 2202 tests / 222 files (1571 API / 157 + 631 UI / 65). Full API/UI acceptance remains outstanding.
- Live image: `agentor-worker-phase5-accepted` fingerprint `075a3e63f544434d4ffc865d04dfb16ce797c22669901d247ea26a83bb376baa`, recipe `a03829907bc97b31422b0ff2e4faf8a08160abb36887b184e3f482752defc9cd`, artifacts `/var/tmp/agentor-phase5-accepted.hjbvf8Ae`. No guest source injection. Boot/provision/services passed (1.3m); native Docker reboot/fresh-root/disable-reenable persistence passed (5.2m); real two-worker credential/Kilo sharing and replacement/reprovision passed (4.3m).
- Final Phase 5 gate: manager lifecycle/deletion retry passed (2.9m), log `/tmp/agentor-phase5-manager-final.log`, artifacts `/tmp/agentor-phase5-manager-final-artifacts`; focused final modules 21 passed / three gated skipped. Previous combined manager failure was an incomplete test logger, corrected without runtime/image change. No live test/build is currently active.
- Disposable host: approved SSH relay only; Incus 6.0.6 supported signed LTS, restricted project `agentor`, exact-account path grants, pool `default`, bridge `incusbr0` (test-only). 96 GiB root, 34 GiB free at resume. API forward in `incus-validation:incus-api`. Retained stopped old manager VM `agentor-worker-beb4f151-408f-45d8-b93a-8637b1125162` and original images/recovery state; inspect before cleanup. Database backup `/var/tmp/agentor-incus-lts-upgrade-recovery/database-6.0.0.tar.gz` retained.
- Security: exact identified Docker serial, metadata ownership/type/sole-attachment validation, no ambiguous formatting; canonical nofollow/single-link credential I/O; stale credential binds detach via kernel mount metadata before stat, no force/lazy unmount; source checks independently fail under bash -e. No raw.idmap/lowlevel widening. Phase 9 must extend private ownership pruning for authorized mount roots.
- Operator decision: Phase 12 setup should offer signed supported Incus LTS installation; compatible Rust virtiofsd/br_netfilter checks required. Narrow account allowlist synchronization is setup authority, not runtime project-admin authority.
- Exact next action: finish manager rerun, review/fix any concrete failure, commit accepted Phase 5, then Phase 6 host DHCP lease+MAC authoritative routing/identity (never guest state.network). Validate UUID incarnation, current owner/record, filters, no routes/ambiguous MAC/IP. Preserve full Phase 6–13 scope below.

## Roadmap & Phase Status

- **PHASE 0 — Baseline & impact map**: COMPLETE
- **PHASE 1 — Persisted runtime kind**: COMPLETE (commit `29edb8b` - `feat(runtime): persist worker runtime kind`)
- **PHASE 2 — Minimal Incus API client**: COMPLETE (commit `c216cf9` - `feat(incus): add restricted TLS client`)
- **PHASE 3 — Derived image pipeline**: COMPLETE (corrective pipeline and rebuilt-image live boot/provisioning/services gate passed; follow-up milestone follows `979124d`)
- **PHASE 4 — Minimal Incus worker create/start**: COMPLETE (real ContainerManager create/start/provision/inventory/stop/delete gate passed; intentionally pending persistence/feature slices follow)
- **PHASE 5 — Persistent storage + Docker**: COMPLETE (fresh production-derived image, native Docker/core persistence, account sharing/reprovision, manager lifecycle/deletion-retry gates passed; full-stack parity remains Phase 13)
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
