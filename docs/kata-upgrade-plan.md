# Kata + QEMU worker runtime upgrade plan

Status: implementation and review in progress, not ready to deploy. Runtime policy, operator attestation, explicit legacy authorization, migration transactions, host setup fixtures, and backup destination policy have local implementations and module coverage. UI/API integration and acceptance remain subject to final review. An operator-provisioned disposable VM has passed a basic Kata boot and produced directly correlated shim/QEMU evidence; this is not production-host, DinD, or Agentor lifecycle acceptance. No production or outer-host setup is authorized by this plan.

## Resumed implementation decisions (2026-09-28)

- Subagent dispatch and two-way messaging were verified before assigning disjoint implementation/review work; no prior subagents remained active.
- Kata Docker-in-Docker is blocked with `KATA_DIND_NOT_VALIDATED`. Docker `Privileged` enumerates host devices even when selecting Kata; no guessed capability/device configuration is enabled.
- `KATA_HOST_VALIDATED=true` is a destination operator attestation, required in addition to Docker runtime registration. It is not host-validation evidence and does not enable DinD.
- Kata live volume mounting is rejected before pausing a worker or invoking the privileged helper. Deferred/recreation paths remain separate.
- The operator explicitly selected preservation of the stopped container's writable root filesystem as an image snapshot, plus copied persistent-volume data for rollback. Shared account credentials/Kilo bindings retain their current identity; rolling shared state back would erase sibling-worker updates, so it is outside worker-local point-in-time rollback.
- Whole-instance restore holds workers for destination administrator approval, strips incoming legacy privilege grants, and omits source-host migration journals containing container IDs and rollback bindings. Profiles, including missing historical values, remain descriptive until approval. Portable metadata is descriptive only; explicit legacy import authority is passed separately from bundle contents through a live administrator callback. A serialized job can require reauthorization but cannot supply it.
- The worker-local runc DinD probe started an `overlay2` daemon and pulled an image on an ext filesystem named volume. Nested execution failed on read-only private cgroups. No Kata runtime was available, and no host cgroups, devices, modules, storage or namespaces were changed. See [local evidence](kata-dind-local-evidence.md).
- Outer-host access/root, production deployment, and network isolation remain outside this work. Worker-local DinD tests are permitted. The operator subsequently authorized publishing this unfinished work to a clearly marked draft feature branch using `AGENTOR_GH_TOKEN`; this does not authorize a main-branch push, image publication, or deployment.
- The operator later provisioned a disposable Ubuntu 24.04 VM and authorized dedicated pinned-key SSH access with guest-only sudo for autonomous tests. Its successful Ubuntu canary correlated an exact container ID with Kata 4.2.0, QEMU 11.0.1, KVM acceleration, and guest kernel 6.18.35. Rootfs uses virtiofs and container cgroup2 is read-only. Shim/QEMU run as VM-local root, and guest seccomp is disabled in the selected defaults; these facts are not a security certification. No validation flag or DinD gate has been enabled.
- The real non-DinD worker initially failed explicit-user exec after Docker's combined restart on Docker29/containerd snapshotter. Separate stop/start on the same daemon subsequently passed the standard standalone worker's READY/services and volume markers over restart/replacement, without changing user/runtime/privilege. Agentor now uses awaited stop/start for running Kata workers inside its lifecycle fence; legacy combined restart and stopped-worker start remain unchanged. See [VM evidence](kata-worker-vm-evidence.md). This is not yet authenticated API/UI lifecycle acceptance.
- Migration now reads DinD from the inspected structured `ENVIRONMENT`, not a runtime-derived shell variable absent from Docker metadata. Missing/ambiguous/override inputs fail closed before mutation. Public migration submission is additionally blocked while trusted capacity admission is unimplemented; preflight, existing-journal recovery, and finalization remain available.
- An isolated private-daemon comparison reproduced the combined-restart/user-resolution failure with the containerd image store but passed the minimal Ubuntu test with classic `overlay2`. Full worker acceptance on classic storage remains outstanding; do not switch an existing daemon in place. Both canaries default to explicit `stop-start`, expose a diagnostic `docker` restart method without fallback, and require UID/GID 1000 exec. Diagnostic setup exposed Docker's `--bridge none` side effect; the disposable VM bridge was restored and later probes require their own network namespace. See the evidence document for the recovery and exact limits.

## Approved scope

Add Kata Containers with the QEMU hypervisor as the runtime for ordinary workers, including workers that run Docker-in-Docker. Ordinary workers should use Kata by default after the feature is implemented and the host has passed its runtime checks.

The persisted runtime profile is `kata-qemu` or `legacy-runc`. Docker's runtime alias for the Kata profile is `agentor-kata-qemu`. The alias is an implementation name; the profile is the durable Agentor choice.

Existing workers must retain their current runtime and behavior until an administrator explicitly migrates them. A worker's runtime choice must not be inferred afresh from a mutable environment setting on every rebuild. Legacy `runc` remains available only through an explicit platform-admin choice. Failure to create or start a Kata worker must fail closed with a useful error; it must never retry as a privileged `runc` worker.

This upgrade does not change worker network isolation, firewalling, routing, egress controls, or network policy. Network security work is explicitly out of scope.

Custom Kata guest profiles and GPU/P40 support are later work. Do not add assumptions or interfaces for those features to the first implementation.

## Runtime and authority rules

- Persist the effective profile on each worker as durable worker state. Keep the existing environment-level Docker capability separate from runtime authority.
- New ordinary workers select `kata-qemu` when the platform reports the alias ready. If it is not ready, creation fails with a preflight/runtime error; there is no privileged fallback.
- Keep pre-existing privileged workers on their current profile. Do not migrate them during upgrade, restart, restore, environment edit, or rebuild.
- Expose `legacy-runc` only as an explicit platform-admin selection. A user environment, imported bundle, restore manifest, or worker request cannot grant that choice.
- Treat backup runtime metadata as descriptive input subject to current platform policy. Metadata must never grant the caller admin authority or silently select legacy privileged execution. Legacy/missing metadata must resolve under an explicit safe restore policy.
- Maintain existing Docker API/orchestration behavior and the worker's workspace, agent data, Docker data, selected persistent paths, identity, plugins, desktop, and editor behavior.

## Migration and data-preservation acceptance

Migration is an explicit platform-admin operation with a preflight, a visible downtime warning, progress/result reporting, validation, and rollback. Preflight must confirm the source worker and desired profile, target alias readiness, every persistent mount, Docker-in-Docker state, and any unsupported settings before stopping the source.

Before replacing a worker, retain the original container/root filesystem and durable volume references until the Kata replacement has passed validation. On any failed create, start, or validation step, leave persistent data intact and restore the previous worker as the active worker. Never delete the rollback source or its data as part of an unsuccessful migration.

The implemented preservation method stops the source, commits its writable root filesystem to a per-worker image, and copies supported worker-owned persistent mounts to separately labeled rollback volumes before starting the replacement. The replacement uses that image and preserves the inspected mount sources and access modes. Rootfs snapshots do not include mounted data; the volume copies supply that separate part of rollback. These transaction boundaries have mocked failure-injection coverage; physical Kata execution and real data recovery still need canary validation.

Shared account credentials and Kilo directory bindings preserve their identity and remain shared. Their contents are **not rewound** on rollback, because doing so could erase sibling-worker updates. Read-only mounts remain read-only. Unsupported writable mounts, shared worker-owned volumes, unsupported storage drivers/options, device passthrough, and shared host/container namespaces are rejected by preflight.

The source container, snapshot image, and volume copies remain available after failure; incomplete rollback remains journaled and blocks conflicting lifecycle work. An ambiguous Docker timeout requires an operator to establish that outstanding daemon mutations have settled before explicit recovery. Terminal rollback evidence is removed only by a separate confirmed finalization operation; the committed rootfs image remains the active worker image. No unsuccessful migration should delete its rollback source or canonical persistent data.

## Docker-in-Docker storage investigation

The existing worker starts `dockerd` with `overlay2` and mounts a per-worker Docker data volume at `/var/lib/docker`. The Kata guest boundary changes the filesystem and block-device path beneath that volume. Keep `overlay2` only if an end-to-end test demonstrates that the inner daemon sees a supported backing filesystem and can create, run, and remove nested containers reliably.

Investigate a loop-backed ext4 filesystem as a candidate for the inner Docker data root if the Kata guest's mounted volume does not provide a compatible filesystem for nested `overlay2`. A bounded disposable-VM probe formatted a new 64 MiB regular file in a fresh named volume, attached it only to a guest-created loop node, and passed one tiny ext4-backed overlay copy-up in a private Kata guest mount namespace. This establishes a narrow storage prerequisite, **not** an approved or verified DinD design; no inner daemon ran. The earlier direct virtiofs-overlay attempt failed, while the guest tmpfs-overlay attempt passed. See [local evidence](kata-dind-local-evidence.md) for the separate probes and exact artifacts. Record evidence for persistence across worker stop/recreate and host restart, disk accounting/limits, recovery after interrupted initialization, and behavior when the image or volume is restored on a different compatible host. Guest test writes may use only fresh diagnostic volumes; do not directly format, mount, or alter VM-host filesystems or block devices. Outer-host and production storage remain outside this investigation.

Acceptance still requires a repeatable isolated test showing Docker build/pull, run, nested volume use, daemon restart, and worker recreation with expected data retention. If a loop-backed ext4 design is selected, test first-boot initialization, reuse of an existing filesystem, corruption/partial initialization handling, capacity exhaustion, and migration/rollback. The implementation must fail with a clear diagnostic if its storage prerequisites are absent; it must not silently switch to a different storage driver or runtime. The successful guest-only mount/copy-up does not clear these gates or `KATA_DIND_NOT_VALIDATED`.

## Host setup and operator boundary

Host changes are operator-only. Agentor code and ordinary workers must not install packages, load host modules, alter the host Docker daemon, change cgroups, create loop devices/filesystems, or modify host storage. A host setup workflow may be implemented only as an explicit operator-run step with compatibility checks, pinned and tested Kata/QEMU components, preservation of existing Docker configuration, restart consent, and post-install verification.

Host OS, kernel, Docker/containerd versions, virtualization support, QEMU availability, nested virtualization behavior, and storage configuration are currently unknown. Document and test a supported matrix before enabling the feature. An operator must verify the host before enabling Kata for worker creation. Tests in this repository cannot substitute for a physical-host canary.

## Implementation phases and acceptance status

1. **Define the persisted profile and policy.** Add the worker runtime profile to the durable record and public/runtime projection. Define normalization for old records, environment defaults for new workers, admin-only legacy selection, and safe handling of imported/backup metadata. This contract is a dependency for lifecycle, restore, and UI/API/MCP work.
2. **Implement host readiness reporting.** Add read-only detection/reporting for `agentor-kata-qemu` and the supported host prerequisites. Keep installation and all host mutation outside ordinary worker lifecycle. Runtime selection consumes this readiness result.
3. **Thread runtime choice through worker lifecycle.** Apply the selected profile consistently to create, rebuild, unarchive, restart/recovery, clone, import, and replacement flows. Preserve existing worker profiles and ensure all Kata failures fail closed. Use shared runtime selection rather than scattered conditionals.
4. **Prove storage behavior.** Run the isolated DinD storage tests and settle the `/var/lib/docker` backing design with evidence. This gates enabling Kata for Docker-enabled workers.
5. **Add explicit migration.** Build preflight, data/rootfs protection, journaled replacement, validation, and rollback using the durable runtime profile. Existing workers remain untouched absent this operation.
6. **Integrate export, backup, and restore.** Carry profile as informational metadata where useful, preserve worker records in instance backups, and enforce destination policy independently of bundle contents. Legacy/missing metadata needs explicit safe behavior.
7. **Expose consistent operator controls.** Add the admin setting and migration flow, REST API, and management MCP action through the same authorization/service layer. Keep ordinary environment editing from granting `legacy-runc`.
8. **Gate rollout.** Complete local isolated tests, then a separately approved physical-host canary on a disposable worker with backups and operator rollback available. Only after canary evidence should Kata become the default for new ordinary workers on that host.

## Repository ownership map

Current integration points; module coverage does not establish physical-host compatibility.

| Concern | Current files |
| --- | --- |
| Worker record and public projection | `orchestrator/server/utils/worker-store.ts`, `orchestrator/shared/types.ts`, `orchestrator/server/utils/container.ts` (`containerInfoToWorkerRecord`) |
| Docker container options and worker `/var/lib/docker` bind | `orchestrator/server/utils/docker.ts`, `orchestrator/server/utils/storage.ts` |
| Worker-side dockerd startup | `worker/entrypoint.sh` |
| Create/rebuild/unarchive/recovery and storage recreation | `orchestrator/server/utils/container.ts` (`applyManagedStorageUnlocked`), `orchestrator/server/utils/managed-volume-manager.ts`, `orchestrator/server/utils/managed-volume-runtime.ts` |
| Live managed-volume helper | `orchestrator/volume-mount-helper.py`; Kata compatibility must be proven or the live path must be rejected in favor of recreation |
| Portable worker export/import and manifest | `orchestrator/server/utils/worker-export.ts`, `orchestrator/server/utils/container.ts` (`exportWorker*`, `importWorker*`) |
| Normal worker backups/restores | `orchestrator/server/utils/backup-manager.ts` |
| Full instance backup/restore | `orchestrator/server/utils/instance-backup-manager.ts` |
| Runtime authorization and policy | `orchestrator/server/utils/worker-runtime-policy.ts`, `orchestrator/server/utils/worker-runtime-admin.ts` |
| Explicit migration and durable rollback | `orchestrator/server/utils/worker-runtime-migration.ts`, `orchestrator/server/utils/container.ts` |
| Restore destination authority | `orchestrator/instance-restore-helper.mjs`, `orchestrator/server/utils/worker-export.ts`, `orchestrator/server/utils/backup-manager.ts` |
| Environment settings UI/API and MCP catalog | `orchestrator/app/components/EnvironmentEditor.vue`, `orchestrator/app/components/EnvironmentsModal.vue`, `orchestrator/server/api/environments/`, `orchestrator/server/utils/management-configuration-catalog-domain.ts` |
| Existing persistence UI/API/MCP extension points | `orchestrator/app/components/WorkerStoragePanel.vue`, `orchestrator/server/api/containers/[id]/storage.post.ts`, managed-volume API routes, `orchestrator/server/utils/management-volume-domain.ts`, `orchestrator/server/utils/management-mcp-store.ts` |

## Local test inventory

The following are no-server module suites selected by `tests/playwright.modules.config.ts`. They use fake Docker/service boundaries and temporary local state, not a Kata host:

- `worker-runtime-policy.spec.ts`: new-worker selection, explicit legacy privilege, attestation/alias gates, DinD/device rejection before Docker mutation, and inspected-runtime mismatches.
- `worker-runtime-admin.spec.ts`: administrator acknowledgement, live revocation checks, ephemeral restore authority, old-archive grants, restored-Kata approval, and snapshot/lifecycle fences.
- `worker-runtime-backup.spec.ts`: stored legacy selection cannot authorize retry; original-worker restore cannot change runtime; revoked destination authority fails admission.
- `worker-runtime-migration.spec.ts`: stopped rootfs snapshot, worker-owned volume copies, unchanged shared binds, validation-before-commit, create/start/validation/persistence failure rollback, interrupted recovery, failed-copy retention, unsupported mount/DinD rejection, uncertain Docker outcomes, finalization, and corrupt-owner quarantine.
- `kata-managed-volume-runtime.spec.ts`: reject Kata live mounting before pausing, journaling, volume mutation, or privileged helper creation.
- `container-store-quarantine.spec.ts`: preservation of pre-profile privilege inspection across failures, restore holds, runtime mismatch quarantine, inventory/lifecycle race protection, fenced Kata stop/start ordering, stop/start timeout/failure quarantine, and unchanged stopped/privileged-legacy behavior.
- `worker-export-format.spec.ts` and `instance-restore-helper.spec.ts`: old/missing runtime metadata remains compatible; portable grants are stripped; whole-instance workers are held; source migration journals are omitted; malformed stores reject before destination shutdown.
- `backup-restore-safety.spec.ts`: preserved lifecycle and rollback assertions now run against authorized legacy fixtures using real runtime guards; cancellation fixtures isolate dependency lookup from the live catalog.

`bash tests/kata-host-fixtures.sh` runs only offline configuration, archive-safety, installer no-op/restart, and cleanup fixtures, including `tests/kata-archive-fixtures.py`. It never installs Kata or accesses host Docker. `scripts/probe-worker-local-dind.sh` is a separate opt-in worker-local experiment; its partial result is documented in [kata-dind-local-evidence.md](kata-dind-local-evidence.md). The test inventory and reproducible commands are in [tests/TESTS.md](../tests/TESTS.md).

The latest local module run passed 384 tests in 34 files; discovery lists 2293
tests in 223 files (1655 API, 638 UI). The latter is not a whole-suite pass.
Offline smoke coverage has 21 scenarios; the standalone worker harness has 11
fake-Docker cases. These checks cannot establish VM isolation or API/UI acceptance.

## Remaining acceptance checklist

The following end-to-end checks remain required; their appearance here is not a claim that they ran or passed.

- Implement sound disk-capacity admission using operator-provided measurements for the actual snapshot/image destinations; helper/worker `df` cannot prove image-store capacity. The current preflight reports this as unimplemented and the public migration path fails closed with `WORKER_RUNTIME_MIGRATION_CAPACITY_UNVERIFIED` before journal or Docker access.
- Initial pure capacity accounting now handles shared allocation budgets, independent byte/inode limits, outstanding reservations, quota-only zero floors and uint64 overflow, with 79 focused tests. A separate request/evidence consistency module has 110 focused tests for exact identity/nonce/state/time/replay bindings. Neither authenticates measurements, durably consumes replay state, reserves capacity or connects to migration admission.
- The operator approved designing for an operator-installed disk-measurement service, a maintenance window excluding unrelated writers, and operator-provisioned filesystem quotas. The independently reviewed [capacity contract](kata-migration-capacity-design.md) now proposes an unvalidated dedicated XFS/classic-overlay2 candidate, authenticated per-domain evidence, bounded source sizing, durable reservations, stopped-source rechecks and guarded recovery. Service/quota installation and actual host changes are not authorized. Concrete storage support and maintenance enforcement still need implementation and validation. Source-host capacity grants must not survive as destination authority in backups.
- Broaden disposable API/UI acceptance, including regular-owner fixture provisioning on a runc-only CI daemon without giving ordinary users runtime authority. A fresh recovery-mode stack passed real non-DinD API create/restart/rebuild/archive/unarchive followed by real browser login/runtime display/stop/restart/archive/unarchive, with UID1000/services, markers and strict baseline preservation. A separate two-worker sharing/reset and real regular-user denial run passed its operation checks but failed its final transient baseline comparison; it is not an overall pass. Worker grants stayed unchanged. See [API evidence](kata-api-lifecycle-evidence.md). Normal-startup reconciliation and the full API/UI suite remain unverified.
- Exercise the documented separate encrypted snapshot-image transfer on the destination host. Instance manifests now record exact snapshot image identities and destination preflight blocks missing/mismatched images; layers are not embedded in instance backups.
- Portable cryptographic image-config identity handles classic/config-ID versus containerd/manifest-ID changes. Authenticated restore dependencies are retained as durable worker expectations; recreation revalidates and creates by immutable destination ID with a pre-start check. Migration journals its commit ID. Legacy active backfill needs exact managed-container evidence; unproved archived snapshots remain blocked. Real synthetic snapshot transfer/resolver checks pass, but full instance cross-store restore and real Agentor lifecycle acceptance are still required. See [snapshot evidence](kata-snapshot-portability-evidence.md).

- `tests/api/containers.spec.ts`: new-worker default profile, explicit admin-only legacy profile, Kata runtime options, no `Privileged` fallback when alias is missing or Kata start fails.
- `tests/api/worker-settings.spec.ts` and `tests/api/environments.spec.ts`: changing an environment does not rewrite existing workers' runtime profile; ordinary environment edits cannot grant legacy runtime.
- `tests/api/managed-volumes.spec.ts`, `tests/api/rebuild-persistence-reconciliation.spec.ts`, and `tests/api/managed-volume-helper.spec.ts`: data survives recreation; explicitly test or reject live mounting for Kata; protect volume data on failure.
- `tests/api/worker-export-import.spec.ts`, `tests/api/portable-managed-volumes.spec.ts`, and `tests/api/backup-restore-safety.spec.ts`: export/import and restore cannot elevate runtime from manifest data; old/missing profile metadata is handled under policy.
- `tests/api/instance-backup-manager.spec.ts` and `tests/api/instance-backup-bundle.spec.ts`: durable per-worker profile round-trips, while restore policy remains authoritative.
- Extend mocked migration coverage with real disposable Docker/Kata acceptance for downtime/report state, workspace/agent/Docker/managed-volume data, writable-rootfs preservation, failed replacement rollback, validation success, and no automatic migration.
- Before claiming crash durability, replace migration journal write/rename-only persistence with file and directory synchronization, durable clears and conservative quarantine on uncertain writes. Review found that the current Docker wrapper can retry its completion-journal callback after that callback itself fails; journal uncertainty must prevent further Docker writes or automatic rollback. Worker-record commit/restore persistence also needs separate durability review. Existing process-interruption mocks do not prove power-loss durability.
- Complete isolated DinD acceptance after settling guest permissions/cgroups and storage. Run host compatibility and Kata/QEMU execution as an operator-approved physical-host canary; do not present local tests as host verification.

## Operator handoff

1. Complete code/UI/API review and relevant local checks. Preserve existing workers and the explicit administrator-controlled legacy option; do not automatically migrate them.
2. Separately authorize a disposable physical-host canary with backups and rollback available. Record the exact OS/kernel, architecture, Docker/containerd, Kata/QEMU, virtualization and storage versions. The Ubuntu/architecture/version list in [kata-host.md](kata-host.md) is a candidate matrix, not validated support.
3. Prove actual VM isolation and normal non-DinD worker behavior before setting `KATA_HOST_VALIDATED=true`. The flag is operator attestation, not evidence; alias presence and kernel-release comparison are insufficient.
4. Keep Kata DinD blocked until guest capabilities, default-device exposure, writable private cgroups and storage support pass pull/build/run/volume/restart/recreate plus recovery and cross-host restore tests. No loop-backed storage design is selected, and no privileged-runc fallback is allowed.
5. Exercise migration/rootfs and volume rollback on disposable workers, including interrupted Docker operations, before rollout. Review the explicit shared-account-state exception; shared mounts are preserved but not rewound. Finalize retained evidence only after the operator accepts the result.

Network isolation, outer-host mutation/access, and production deployment remain
out of scope. Explicitly authorized disposable-VM work is recorded separately;
it does not authorize production rollout or replace the remaining acceptance gates.
