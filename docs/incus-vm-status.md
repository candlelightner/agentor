# Incus VM Implementation Status

## CURRENT HANDOFF

- Phase: **7 in progress**. Exact subtask: integrate verified binary-safe exec into unchanged terminal/files/apps/plugins paths. Phases 3–6 live gates accepted; Phase 7 transport primitive accepted, full Phase 7 not complete.
- Git: `feature/incus-vm-workers`, last accepted phase **`347c3dc` (Phase 6)**. Transport checkpoint follows it; use git log for current HEAD. Rebased onto main health-check fix `e38c2d4`; no repeat rebase.
- Evidence: latest complete modules **283 passed / six live-only skipped (27.8s)**, log `/tmp/agentor-phase6-atomic-modules.log`; final focused routing/network **40 passed / one skipped**, log `/tmp/agentor-phase6-final-focused.log`; typecheck passed. Enumeration **2231 tests / 226 files**. Fresh generation-3 image boot/provision/services/DNS/firewall **passed (1.4m)**, log `/tmp/agentor-phase6-final-image-boot.log`. Production full-stack editor/noVNC HTTP + noVNC WS, native Docker-published Traefik HTTP/TCP, worker-self, IPv4/MAC/IPv6 spoof-negative controls and forged-DHCP identity checks **passed (5.6m)**, log `/tmp/agentor-phase6-fullstack-mac-source.log`; exact workers cleaned.
- Accepted Phase 6 live gate: **passed (3.7m)**, `/tmp/agentor-phase6-atomic-fullstack.log`: real dashboard editor workbench and connected noVNC, editor/desktop HTTP and noVNC WS, Traefik HTTP/TCP to inner Docker, worker-self, IPv4/MAC/IPv6 filtering and forged-DHCP identity. Exact workers/environments cleaned. Real narrow Traefik diagnostic also proved empty exact service **503**, wildcard control **502**, without fallthrough. Periodic YAML publisher now uses same-directory atomic rename; deterministic old-open-reader regression **passed**, independent review/typecheck passed. Clean Orchestrator native build **passed**, `/tmp/agentor-phase6-atomic-stack-clean-build.log`.
- Phase 7 transport gate: **10 passed (1.0m)**, `/tmp/agentor-phase7-exec-fast-live.log`: UID1000 PTY input/resize/SIGTERM/exit42, binary non-PTY stdin/stdout/stderr/exit23, five immediate printf exits. Mock regressions cover partial handshakes, EOF, fast control/output completion and cancellation. Exact nonce-owned fixture cleaned; original fixtures untouched. Initial live failures established binary stdin framing and explicit PTY EOF closure. Non-PTY control connects before data; outputs have backpressure and operation-authoritative status. Focused client/runtime **39 passed / three gated skipped**, `/tmp/agentor-phase7-exec-focused-final.log`; typecheck and independent review passed. Enumeration **2241/227 files**. No running host-mutating test/build. Native dashboard terminal/files/plugins not wired yet.
- Image: alias `agentor-worker-phase6-candidate`, fingerprint `5a1fd6567a62c3d14714cba34af55174229f05862d9d6361106aa0b33641437f`; recipe `ec572c96a008f2f6df0c0a2e549ce646ba9f53e91afa9f14de48fde178d1d965`; OCI `sha256:4ddae0ac807ef1ece54882e26df9b8d0eecc73793f58a0bae05fa08262c15996`. Native sources/artifacts `/var/tmp/agentor-phase6-production.SSkg3hQz/artifacts-final`; no guest source injection.
- Disposable host: approved SSH relay only, Incus **6.0.6**, restricted mTLS project `agentor`, pool `default`, test bridge `incusbr0`. 96 GiB root, ~21 GiB free between tests (~7.7 with two workers). Preserve stopped fixtures `agentor-worker-beb4f151-408f-45d8-b93a-8637b1125162`, `agentor-worker-219dc5e4-486f-4ed3-b7ad-82724d5b3d2b`, their volumes, original images, daemon DB backup and old deleted-rootfs loop0 mount `/tmp/mnt2`.
- Retained isolated stack: `agentor-phase6-orchestrator:atomic` / `agentor-orchestrator` (`b4ad1af68044…`), Docker `agentor-phase6-net`, stack data `/var/tmp/agentor-phase6-production.SSkg3hQz/stack-data`; approved TLS read-only `/tls`, no Incus socket. Prior stopped/disconnected `agentor-orchestrator-before-atomic` retained for recovery. HTTP loopback + test gateway **38000**; API/HTTP forwards in tmux `incus-validation`. User chose retaining stack between phases; tests delete their exact worker/environment fixtures. Diagnostic probe container removed; configs remain `/var/tmp/agentor-route-probe.Pd6DLqqc`.
- Material networking finding: native Incus masquerades worker → Dockerized Orchestrator after DNAT. Narrow test-only NFT table `ip agentor_phase6_source` preserves source only on primary Incus bridge → exact Orchestrator IP/TCP3000. Fixture `/workspace/incus-phase6-wip.I5Xu2Q63/source-identity-fixture.nft`. **Phase 12 must deliver discovered persistent source preservation**, preferably original stable gateway/port matching across Docker IP changes; no test addresses as production defaults.
- Remaining known slices: ResourceMonitor still tries Docker stats on Incus handles (warnings only, no restarts); adapt observability in Phase 8. Phase 9 ownership repair must prune approved mount roots. Phase 12 user approved offering signed supported Incus LTS updates, without widening project permissions.
- Recovery: branch `recovery/incus-pre-healthcheck-rebase-c984f7d`; outside-repo snapshots `/workspace/incus-takeover-recovery.SuOkJjCL`, `/workspace/incus-phase5-wip.jeXEz2a0`, `/workspace/incus-phase5-checkpoint.hQdyFHMv`, `/workspace/incus-phase6-wip.I5Xu2Q63`. Intermediate ENOSPC candidate recovered by checksum-verified artifact copy; only its duplicate VM-side qcow2 and unused new cache entry removed, originals untouched.
- Next: add narrow identity/incarnation-fenced worker command/file adapter and `/run` environment wrapper, then terminal/tmux/apps/plugins integration and live full-stack gates; retain all Phases 8–13. Custom OCI runtime→derived-image mapping remains required by full acceptance. No architectural blocker or user action needed.
- Phase 7 focused review: reuse structural execCapture/getArchive/putArchive interfaces for existing file probes/ZIP; terminal keeps linked tmux but stores neutral stream/resize/close callbacks. Add binary-safe non-PTY three-data-WebSocket + control exec, with empty TEXT EOF, simultaneous stdout/stderr draining, authoritative operation exit and bounded partial/late-socket cleanup. Fence all commands/terminal cleanup against installation/worker/owner/captured UUID. Incus exec does not inherit service env: a narrow guest wrapper must apply existing account→environment→worker precedence from `/run` and HOME/PATH/cwd for plugins/apps. Isolated desktop RFB must not use PTY. Preserve shared plugin runner JSON framing, 9 MiB output bound, discarded stderr and cancellation; no duplicated plugin lifecycle.
## Roadmap & Phase Status

- **PHASE 0 — Baseline & impact map**: COMPLETE
- **PHASE 1 — Persisted runtime kind**: COMPLETE (`9ac86fd`, rebased from `29edb8b`)
- **PHASE 2 — Minimal Incus API client**: COMPLETE (`6edd2ef`, rebased from `c216cf9`)
- **PHASE 3 — Derived image pipeline**: COMPLETE (`3ed737c` + accepted correction `cab1776`; rebuilt-image live boot/provisioning/services gate passed)
- **PHASE 4 — Minimal Incus worker create/start**: COMPLETE (real ContainerManager create/start/provision/inventory/stop/delete gate passed; intentionally pending persistence/feature slices follow)
- **PHASE 5 — Persistent storage + Docker**: COMPLETE (fresh production-derived image, native Docker/core persistence, account sharing/reprovision, manager lifecycle/deletion-retry gates passed; full-stack parity remains Phase 13)
- **PHASE 6 — Routing and worker identity**: COMPLETE (fresh-image gate, production-manager address gate, browser/full-stack routing/identity/IPv4/MAC/IPv6/forged-DHCP gates passed)
- **PHASE 7 — Terminal/files/plugins**: IN PROGRESS (focused integration points reviewed; implementation next)
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
