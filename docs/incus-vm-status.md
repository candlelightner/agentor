# Incus/QEMU VM Worker Migration Status

## CURRENT HANDOFF

- Goal: authoritative Phase 0–13 contract; user resumed `/goal`. No production-host mutation, main push/merge, automatic migration, architecture restart, or network-policy expansion.
- Current phase: **Phase 6 in progress**. Phase 5 remains accepted. Host-authoritative lease/MAC/UUID routing and worker-self identity implemented and reviewed; HTTP/WS/plugin proxy and Traefik wiring are intentional uncommitted work.
- Git: `feature/incus-vm-workers` rebased onto main health-check fix `e38c2d4`. HEAD `b74719d`; latest completed phase commit **`5314c06` (Phase 5)**; preceding commits `b50c7d1` (Phase 4), `cab1776` (Phase 3 correction), `3ed737c` (initial Phase 3), `6edd2ef` (Phase 2), `9ac86fd` (Phase 1). Explicit WIP checkpoint `c3db054` retained. Original history/WIP in `recovery/incus-pre-healthcheck-rebase-c984f7d` plus outside-repo snapshots. Intentionally dirty Phase 6, no reset/cleanup/rebase repetition.
- Current evidence: Phase 6 full selected modules **282 passed / six live-only skipped**, log `/tmp/agentor-phase6-final-module-selection.log`; latest typecheck passed. Focused Traefik/DNS modules eight passed / full-stack gated skipped. Enumeration **2230 tests / 226 files** (1599 API / 161 + 631 UI / 65). Latest real production-manager/address gate passed (2.1m), `/tmp/agentor-phase6-address-long-create.log`. Full API/UI/live routing acceptance remains outstanding.
- Live image: `agentor-worker-phase5-accepted` fingerprint `075a3e63f544434d4ffc865d04dfb16ce797c22669901d247ea26a83bb376baa`, recipe `a03829907bc97b31422b0ff2e4faf8a08160abb36887b184e3f482752defc9cd`, artifacts `/var/tmp/agentor-phase5-accepted.hjbvf8Ae`. No guest source injection. Boot/provision/services passed (1.3m); native Docker reboot/fresh-root/disable-reenable persistence passed (5.2m); real two-worker credential/Kilo sharing and replacement/reprovision passed (4.3m).
- Final Phase 5 gate: manager lifecycle/deletion retry passed (2.9m), log `/tmp/agentor-phase5-manager-final.log`, artifacts `/tmp/agentor-phase5-manager-final-artifacts`; focused final modules 21 passed / three gated skipped. Previous combined manager failure was an incomplete test logger, corrected without runtime/image change. No live test/build is currently active.
- Disposable host: approved SSH relay only; Incus 6.0.6 supported signed LTS, restricted project `agentor`, exact-account path grants, pool `default`, bridge `incusbr0` (test-only). 96 GiB root, 34 GiB free at resume. API forward in `incus-validation:incus-api`. Retained stopped old manager VM `agentor-worker-beb4f151-408f-45d8-b93a-8637b1125162` and original images/recovery state; inspect before cleanup. Database backup `/var/tmp/agentor-incus-lts-upgrade-recovery/database-6.0.0.tar.gz` retained.
- Security: exact identified Docker serial, metadata ownership/type/sole-attachment validation, no ambiguous formatting; canonical nofollow/single-link credential I/O; stale credential binds detach via kernel mount metadata before stat, no force/lazy unmount; source checks independently fail under bash -e. No raw.idmap/lowlevel widening. Phase 9 must extend private ownership pruning for authorized mount roots.
- Operator decision: Phase 12 setup should offer signed supported Incus LTS installation; compatible Rust virtiofsd/br_netfilter checks required. Narrow account allowlist synchronization is setup authority, not runtime project-admin authority.
- Working tree: Phase 6 tracked binary patch, staged patch, status listing and both untracked implementation files preserved outside repository at `/workspace/incus-phase6-wip.I5Xu2Q63`. No build/live test running; API SSH forward retained. Disposable root has 28 GiB free. Timed-out create fixture `agentor-worker-219dc5e4-486f-4ed3-b7ad-82724d5b3d2b` is stopped with its owned volumes retained; accepted create completed after timeout. Create-only operation wait is now bounded at 300s without resubmission.
- Active build: final native candidate `agentor-worker-phase6-candidate` at `/var/tmp/agentor-phase6-production.SSkg3hQz`, output `artifacts-final`, log `/tmp/agentor-phase6-final-image-build.log`, exec **22478**. First import succeeded but review caught resolved's additional .54 listener; fixed listener is .55 with actual DNS response readiness, original JSON newline rejection, and inherited vendor dnsmasq disabled. Intermediate corrected build hit ENOSPC; failed d2vm scratch cleaned itself. The new first candidate qcow2/metadata were copied and checksum-verified outside the VM at `/workspace/incus-phase6-wip.I5Xu2Q63/artifacts` (qcow2 SHA256 `f76b2c9ab49f3b246085ab1a162cfe67af188653443aeed1c6322d2c57d34e63`). Removed only its duplicate VM-side qcow2 and new unused Incus fingerprint `58e8fb38b8400e1cc7bef826e571836ad0be34719f6c631e003d55caaeb8cc4c`; recoverable from the copy. 26 GiB free before final build. Original images/recovery fixtures untouched. Generation 3 requires a derived-image rebuild; no guest source injection for acceptance.
- Full-stack fixture: updated `agentor-phase6-orchestrator:trial` running as `agentor-orchestrator` (`59f892cc95ce…`) on test-only `agentor-phase6-net`; data `/var/tmp/agentor-phase6-production.SSkg3hQz/stack-data`, approved restricted mTLS files root-owned 0600 mounted read-only at `/tls`. HTTP bound to loopback + test bridge gateway port 38000, SSH forward in `incus-validation:phase6-http`. No Incus Unix socket mount. Unchanged Admin Workspace behavior created test Docker `agentor-admin-workspace`. User selected retaining isolated stack between phases; API test cleans its exact worker/environment fixtures. No full-stack worker test has run yet.
- Exact next action: finish both builds safely, run fresh image boot/service/DNS/firewall gate, then full-stack HTTP/WS/Traefik/worker-self/spoof/forged-DHCP tests. Independent proxy review found router-fallthrough and disabled-new-creation refresh gaps; both fixed. Unavailable mapped routers retain empty backend pools, preserving precedence over overlapping routes. Native restricted bridge config is redacted; host filtered leases remain authority and IPv6 filtering is mandatory when config is unknown. Do not claim DHCP chaddr forgery is blocked merely by Ethernet MAC filtering. Preserve full Phase 6–13 scope below.

## Roadmap & Phase Status

- **PHASE 0 — Baseline & impact map**: COMPLETE
- **PHASE 1 — Persisted runtime kind**: COMPLETE (commit `29edb8b` - `feat(runtime): persist worker runtime kind`)
- **PHASE 2 — Minimal Incus API client**: COMPLETE (commit `c216cf9` - `feat(incus): add restricted TLS client`)
- **PHASE 3 — Derived image pipeline**: COMPLETE (corrective pipeline and rebuilt-image live boot/provisioning/services gate passed; follow-up milestone follows `979124d`)
- **PHASE 4 — Minimal Incus worker create/start**: COMPLETE (real ContainerManager create/start/provision/inventory/stop/delete gate passed; intentionally pending persistence/feature slices follow)
- **PHASE 5 — Persistent storage + Docker**: COMPLETE (fresh production-derived image, native Docker/core persistence, account sharing/reprovision, manager lifecycle/deletion-retry gates passed; full-stack parity remains Phase 13)
- **PHASE 6 — Routing and worker identity**: IN PROGRESS (authoritative host address/identity live manager gate passed; full-stack routing and spoof gates outstanding)
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
- Follow CURRENT HANDOFF for active Phase 6. Phase 5 tasks and live gates above are complete; do not repeat them except focused regression validation of changed behavior.
