# Runtime migration disk-capacity admission: proposed contract

Status: protocol design with isolated accounting groundwork; no capacity
admission implementation or deployment approval. The operator
has chosen an operator-installed disk-measurement service and a maintenance
window that excludes unrelated disk writers, and has approved designing around
operator-provisioned filesystem quotas. These are design decisions, not
installation or deployment approval. This document does not install a
service, stop workers, grant host access to Agentor workers, or authorize a
production migration. Until the contract is implemented and tested, public
migration remains closed by `WORKER_RUNTIME_MIGRATION_CAPACITY_UNVERIFIED`.

The initial `worker-runtime-capacity-accounting.ts` module provides only pure
bounded arithmetic: canonical uint64 byte/inode quantities, one budget per
allocation constraint, additive demands and outstanding reservations, and
nonzero physical-filesystem/pool safety floors. Quota-only floors may be zero;
zero available quota still means no allocation headroom. Shared filesystem
aliases cannot multiply free space; separate quota/pool constraints also consume
their mapped demands. Its focused tests cover malformed input, limits,
exhaustion, quota-floor semantics, precision and overflow.
It performs no measurement, authentication, I/O or durable reservation and is
not connected to migration admission. Concrete supported layouts, enforced
write bounds, maintenance fencing, broker transport and phase integration
remain unfinished. A successful calculation is not a capacity ticket.

## Existing transaction and trust boundary

`worker-runtime-capacity.ts` currently throws before the public migration path
builds its input, journal, or performs Docker access. Read-only preflight and
recovery/finalization of existing journals remain available. The migration
engine then journals intent, suppresses source restart and stops the source,
commits its writable rootfs as an image, creates and fills labeled rollback
volumes, renames the original container, creates and validates the replacement,
and retains the original container, image, and copies until explicit
finalization. Failed or uncertain Docker operations can leave those artifacts
and a `recovery-required` journal. The capacity gate must not be replaced by a
caller acknowledgement or a worker/copy-helper `df` check.

The operator service, not an administrator request or restored record, is the
authority for host storage layout, free bytes/inodes, maintenance fencing, and
reservations. Agentor may ask it to measure and reserve a specific migration;
it must never accept client-supplied filesystem paths, counts, grants, service
keys, or a `capacityVerified` flag. Administrator authorization still governs
*whether* to migrate, but cannot manufacture host-capacity authority.

## Operator service and measurements

The service is installed and controlled by the host operator, outside an
ordinary worker. Its dedicated authenticated channel to the orchestrator must
not expose a broad host mount, Docker socket, or service credential to workers
or API clients. The implementation must define credential provisioning,
rotation, service identity, process isolation, audit logs, and rejection on
unavailable/stale service state. A signed response or mutually authenticated
channel proves who measured; neither alone prevents another process consuming
space. The maintenance fence below is a separate requirement.

For the exact Docker daemon and operation, the service must discover the
*effective* allocation destinations, not infer them from an in-container
`df` or Docker's summary `DockerRootDir` alone. These include the daemon's
container writable-layer and commit path, image/content/layer/snapshot stores
and temporary extraction/commit locations, the local-volume creation parent
and each existing worker-owned source, and any supported worker-owned bind
source. Docker 29's containerd snapshotter and classic image store may use
different locations. The service must resolve actual mountpoints and backing
allocation domains through host-side, read-only inspection, with explicit
support for the selected Docker/containerd/storage-driver layout. It must not
silently follow unexpected symlinks, relocated paths, remote volumes, thin
pools, or quota boundaries.

For each allocation domain report a stable host/service identity, daemon ID
and storage-layout generation, filesystem/superblock and quota-domain identity,
resolved store roles and paths, total/free/available bytes and free inodes,
operator safety floor, measurement time and sequence, and applicable
reservations. Bind aliases and multiple paths on the same allocation domain
must share **one** free-space/inode budget; summing their `df` values is
invalid. Different quota or underlying pool limits must be represented as
additional constraints, not hidden by a filesystem UUID. If any destination
cannot be mapped unambiguously, reject admission.

Evidence and reservation tickets must be bound to the host, daemon and layout
generation, maintenance epoch, operation ID, worker/owner/source container ID,
target runtime, exact mount inventory, requested byte/inode envelope per
allocation domain, issue/expiry times, and a monotonic one-use sequence or
nonce. Reject replay, changed source identity, changed mount/layout generation,
expired evidence, and a ticket from another host or operation. Expiry prevents
new work; it does **not** release an existing reservation.

## Conservative demand envelope

Admission needs both bytes and inodes for peak *additional* allocations, not
merely the current logical size of volumes. The service must measure source
objects through supported, read-only host interfaces and return a defensible
upper envelope for:

| Artifact or phase | Required bound |
| --- | --- |
| Stopped rootfs commit | Writable-layer file content, sparse-file expansion risk, whiteouts, hardlinks, metadata/xattrs/ACLs, Docker temporary data, committed blob/layer and any simultaneously materialized snapshot. Count the original container and its image layers as retained, not freed. |
| Replacement | New writable/snapshot layer, container metadata, startup/bootstrap and bounded validation writes while the old container remains. Source base layers may be shared only where verified by the selected store; otherwise count a second materialization. |
| Worker-owned mounts | Every labeled rollback-volume creation and `cp -a --preserve=all` copy, including apparent file bytes if sparse preservation is not guaranteed, directory entries, hardlinks, xattrs and inode needs. A source mounted at two targets may require two copies. Include supported bind sources and resolve each backup volume's destination domain. |
| Recovery | Peak rollback copy back to canonical volumes after a replacement may have written them, helper/container metadata, filesystem journal/COW overhead, retained snapshot image and backup copies, and room to restart/validate the original. Do not assume deletion frees space before recovery succeeds. |

The envelope must use checked arithmetic, explicit units and versioned,
layout-specific amplification rules backed by tests of the exact supported
Docker/containerd/filesystem combination. Docker `SizeRw`, compressed image
size, `du`, or a volume's apparent size alone is not a safe complete bound.
Include inodes and a nonzero operator safety floor on every physical allocation
domain. Quota-only constraints need the separate floor semantics described
below; they do not create physical storage. Reject uncountable special files,
unreadable trees, source mutations
during measurement, unsupported copy semantics, or an unknown store mapping.
The service also needs fixed time, tree-entry, depth and memory budgets for
measurement, with cancellation and a clear incomplete-scan result. A timeout,
limit hit, permission denial or changing tree fails admission; partial counts
must never be promoted to a size bound. Do not invent a universal multiplier
and label it precise.

Arbitrary replacement startup or validation can write without a finite bound.
The selected design therefore requires kernel-enforced hard byte and inode
quotas for every workload-writable allocation destination. Polling free space,
soft limits, quota grace periods and stopping a worker after a threshold is
crossed do not provide this bound. Quotas bound allocation; they do not prove
that a worker will start, that an application handles `EDQUOT` correctly, or
that a filesystem has enough physical space. Those are separate checks.
Source growth between initial measurement and stop must obey the same hard
limits. A stopped-source measurement remains mandatory.

## Proposed quota implementation and initial candidate matrix

The first implementation target is deliberately a **candidate, unvalidated**
layout, not support for the current disposable VM or arbitrary existing Docker
installations. Use a dedicated, rootful Docker Engine 29.1.3 daemon with the
classic `overlay2` image store, on Ubuntu 24.04 with kernel 6.8.0-142-generic and
XFS formatted with `ftype=1`, `reflink=0` and project-quota enforcement enabled.
Pin the exact Engine/containerd package builds and XFS tooling in the acceptance
manifest before testing; the VM's previously recorded containerd 2.2.1 is a
candidate version, not proof of this different layout. Test Kata 4.2.0/QEMU
11.0.1 against that exact configuration. Begin with non-DinD workers and one
thick-provisioned XFS allocation domain for the daemon stores and managed data.
Keep the broker ledger and orchestrator control journal on separately protected
storage inaccessible to workers. This proposal requires fresh operator-provided
test storage; it does not authorize reformatting or switching the current VM's
Docker store in place.

Version one rejects the containerd image-store mode, Docker's own per-container
`overlay2.size` quota management, rootless Docker, remote volume drivers,
arbitrary bind sources, nested backing mounts, sparse/thin backing devices,
reflink/COW layouts and unvalidated encryption layers. Reject existing workers
whose complete writable paths have not been enrolled by the operator. Support
for separate image/volume filesystems is a later adapter with its own tests;
the accounting module can represent it but does not establish that support.
Encrypted backup transport is independent of this exclusion on host block
storage layouts.

Use an operator-owned project-ID registry; identify each quota by filesystem
identity **and** project ID. Project quotas are not hierarchical: a child
directory assigned a different project does not also consume its parent's
project quota. Every project consumes the common filesystem budget, and any
alias of that project consumes the same quota budget. No project limit or free
count may be added twice. The adapter must verify inheritance, enforcement and
actual project membership, not merely the configured mount option or a Docker
volume label.

Reject disabled enforcement, accounting-only mode and zero/unlimited hard-limit
sentinels when producing trusted measurements. Interpret raw kernel/tool quota
fields using the pinned adapter's documented units and semantics: zero remaining
headroom is not an unlimited quota, and a zero hard-limit sentinel must never be
turned into a finite enforced bound.

| Allocation role | Proposed hard-limit and ownership rule |
| --- | --- |
| Source and replacement writable rootfs | Separate enrolled XFS projects for each actual `overlay2` upper/work allocation set. Verify Kata's actual writable path belongs to the expected project; never derive this solely from container ID. Source is already constrained before admission. Replacement directories are mapped and assigned before any worker code executes. |
| Canonical worker volumes | One enrolled project per distinct physical worker-owned volume, with both byte and inode hard limits. Mount aliases share this quota; multiple rollback copies remain distinct additional allocations. Preserve volume identity and mount access mode. |
| Shared account writable binds | Permit only the existing account credential/Kilo paths that have explicit operator-owned mappings and hard limits. Fence all other writers sharing those projects. Preserve their shared identity and contents on rollback; never rewind them with the worker-owned copies. Unknown writable binds reject admission. |
| Committed image/content, layer, extraction, helper and daemon metadata | Map every effective write destination to a bounded daemon-store project or an explicitly enumerated project. The common project bounds daemon allocations during the maintenance epoch; do not claim per-container upper quotas cover these writes. Protect unused recovery quota separately from the forward phase. |
| Rollback-copy volume data | Create only journaled, labeled empty volumes under the bounded daemon-store parent. Before copying, verify exact Docker volume identity, no consumers and empty contents, then enroll its data directory into a separate rollback project. Set inheritance and hard limits before helper start. Existing source/canonical directories must never be recursively reassigned as part of migration. |
| Broker ledger, migration journal and audit metadata | Protected control storage with its own finite operation/log budgets and reserved bytes/inodes. Worker, guest and copy-helper writes must not consume this recovery/control budget. Journal exhaustion fails admission; logging must not erase recovery state. |

Docker container/volume creation can allocate metadata before its new project
is assigned. That bounded setup phase must already be reserved against the
daemon-store project and physical filesystem; post-create quota assignment is
not a substitute for pre-create admission. The adapter must demonstrate that
Docker does not reassign, clear or reuse broker-owned project IDs during
create/commit/remove/restart, and that no open writable handle exists during
new-project enrollment. If this cannot be proven for the candidate version,
reject that adapter instead of racing Docker or changing live source project
membership. No daemon patch or storage-layout support is assumed by this design.

Hard quota accounting must include host allocation by Kata/virtiofs and by the
copy helper, including hardlinks, open-but-unlinked files and delayed allocation.
Test both UID1000 and container-root attempts to change project IDs, inheritance
or limits through filesystem ioctls/xattrs, and to allocate through every bind
alias. Worker-visible privilege must not become authority to bypass host quota
enforcement. Unsupported inode accounting, unexpected project membership,
cross-project hardlink/copy behavior, or a destination escaping quota coverage
fails preflight. Guest-visible `df` and guest-only quotas are not sufficient.

## Quota phases and reserved recovery headroom

Provision a current hard byte/inode ceiling for forward work and a maximum
recovery ceiling per relevant project in the operator policy, with a nonzero
physical-filesystem safety floor outside all workload allowances. The broker
may request only
policy-bounded transitions through an operator-installed enforcement adapter;
an API caller cannot pick limits, project IDs or paths. The installation must
explicitly configure that adapter's authority. Merely approving this design
does not grant an existing measurement-only service quota-write permissions.

Physical and quota budgets are separate constraints. Before stopping the source,
reserve the complete worst-case future source/forward growth, backup copies,
recovery-copy peak and bounded original-worker restart/validation allocations.
In particular, recovery-only room is excluded from the hard ceiling reachable
by the replacement during startup. Available filesystem bytes alone cannot
protect recovery when a canonical project's quota is already exhausted.

For quota-only constraints, account the kernel-reported hard limit minus actual
usage with a zero additional quota floor when the workload can consume that
entire limit. A positive quota floor cannot be promised merely by reserving it:
the kernel's hard ceiling must enforce any intended workload margin. Never add
fictitious available quota above the currently enforced limit. Future recovery
limit increases are separate conditional phase entitlements backed by an
already durable **physical** reservation; re-read the applied kernel limit and
usage before admitting recovery writes. Physical safety floors stay nonzero.
The isolated arithmetic module implements this floor distinction: only quota
constraints may use zero floors, and every destination still requires a mapped
filesystem with positive byte/inode floors. It performs no raw quota discovery
or enforcement validation; the trusted adapter must reject unlimited/disabled
quota sentinels before constructing these inputs. Future recovery ceilings
must not be fed into currently available quota to force arithmetic success.

1. **Pre-stop:** verify the running source's enrolled hard limits and reserve
   its maximum remaining allocation up to those limits, including shutdown
   writes. This covers the measurement-to-stop interval without assuming a
   stable running tree. Do not lower limits below current usage or change
   existing source project ownership as part of admission. An unenrolled source
   needs separate operator preparation and is rejected before any stop.
2. **Stopped measurement and forward work:** after quiescence, scan the stopped
   rootfs and owned mounts, resolve outstanding writes and recompute the full
   envelope. Complete any reservation increase before commit/copy. Enroll and
   verify fresh rollback/replacement projects before their producers start.
   Every forward phase stays within its configured hard ceilings; hitting a
   quota is a failure, never permission to increase a limit automatically.
3. **Replacement startup/validation:** keep finite ceilings on its writable
   rootfs, canonical volumes and shared-account binds, plus the daemon's
   metadata/log paths. The envelope includes all their maximum additional
   allocations, including output/logging outside the upper layer. Validation
   has a deadline, but time bounds alone do not replace disk/inode limits.
4. **Rollback:** first prove that replacement execution and in-flight mutations
   are settled, the maintenance fence is valid and affected destinations still
   match. Persist the recovery transition and obtain quota/physical admission
   before destructive canonical-volume copyback. Only then may the enforcement
   adapter expose the separately reserved recovery ceiling on those projects.
   A running or ambiguous replacement must never receive that extra room. If a
   quota failure prevents proving quiescence, retain `recovery-required` and do
   not lift the ceiling or begin copyback. Recovery must not depend on deletion
   freeing space or assume `cp -a` has a bounded peak without the tested rules.
5. **Original restart:** restore data first, then use a separately bounded
   restart/validation allowance. Keep the failed replacement stopped and the
   rollback copies retained. Repeated retries must reserve any additional peak;
   they cannot repeatedly reuse an already consumed allowance. Failure to
   validate may leave the original stopped with retained evidence.
6. **Finalization:** identity-check and remove only explicitly finalized retained
   artifacts. Reconcile project usage and remaining future reservation after
   deletion has actually settled, including open handles and delayed frees.
   Retire a project ID only after no artifacts or in-flight operations reference
   it. Keep active canonical projects and snapshot images, retain applicable
   hard limits, and do not lower a limit below live usage to reclaim a ticket.

Persist desired quota transitions in the broker's durable ledger before asking
the enforcement adapter to apply them; after a crash, query actual kernel state
and reconcile idempotently. A transition with an unknown outcome retains the
larger physical reservation and prevents new phases. No ticket expiry, journal
terminal state or backup restore removes a quota, restores an old project ID,
or releases recovery capacity.

## Maintenance fence and durable reservation

Before admission the operator establishes a maintenance epoch that excludes
unrelated writers to **every** affected allocation domain. This is more than
stopping the selected worker: it must account for other Agentor workers,
image pulls/builds, backups/restores, daemon garbage collection, host jobs and
any non-Agentor process that can consume the same budgets. The implementation
must attest enforceable fencing and document allowed daemon bookkeeping. If the
service cannot attest that the fence is active and remains active, it refuses
new reservations and migration pauses before the next storage mutation.
This design does not itself stop unrelated workers or authorize global
downtime.

For the initial dedicated-daemon candidate, implement one host-wide maintenance
lock owned by the operator service, with a generation and a durable owner/epoch.
Every orchestrator instance sharing that daemon must drain existing storage
jobs and acquire this lock for create/start/rebuild, pulls/builds, backup/restore,
managed-volume writes and destructive cleanup. Read-only status can continue.
Lock acquisition refuses active conflicting jobs; it does not stop unrelated
workers or cancel an unknown Docker request. The operator's maintenance-window
procedure must quiesce unrelated workers, shared-account writers and host jobs
before activation. That procedure requires separate scheduling and authority
at installation/test time; this design issues no shutdown commands.

An application mutex alone is insufficient. The dedicated daemon's mutation
endpoint must be accessible only to the orchestrator and the service's enrolled
operation adapter during the window; local root remains an operator trust
boundary. Operator preparation must remove other clients and resolve existing
connections/file descriptors, not merely chmod the socket. The service attests
the allowed process/daemon inventory, project registry, active hard limits and
quiescent operations at epoch creation. Background daemon GC, logging, container
exits and bounded cleanup are explicitly mapped and charged; disable or drain
unbounded background work in the operator's test configuration. An unaccounted
writer or inability to establish this inventory prevents activating the epoch.
This is local storage/daemon access control, not worker network-policy work.

The lease permits the next phase; it is not the durable reservation itself.
Daemon restart, store remount, unrecognized quota enforcement change,
unexpected process-inventory change or service recovery invalidates phase
permission. Expected process/quota transitions must match the journaled operation
and advance the service's generation before the next phase. Already-running
worker writes remain bounded by kernel hard quotas while the orchestrator
holds further mutation and reconciles state. A watchdog may report an invalid
epoch, but does not itself prove exclusion. After a crash, default to no new
work until the operator/service has re-established the fence; preserve the
quota registry, reservations and journals throughout.

The service owns a host-global, crash-durable reservation ledger, serialized
across all Agentor instances and operations sharing the domains. Admission is
an atomic compare-and-reserve against freshly measured available bytes/inodes
minus the safety floor and *all* other outstanding reservations. Persist and
fsync the ledger before returning a ticket. The orchestrator uses an
idempotent operation ID, records the ticket in its migration journal before
any Docker mutation, and checks that the live ticket still matches before each
allocation phase. A service reservation whose journal write fails is an
orphan requiring explicit reconciliation; it is not automatically freed.

The reservation protects future headroom, not bytes already materialized in
the measured free-space count. The service may reduce that future component
only after identity-checked artifacts and their current usage are reconciled
atomically; conservative over-reservation is preferable to double-crediting.
Maintenance lease expiry, orchestrator restart, service restart, ticket TTL,
terminal journal phase, or an administrator clicking retry must never silently
release capacity. Loss of service/ledger/maintenance state blocks new work
and requires operator reconciliation.

## Required sequence and recovery

1. Administrator authorization and existing migration preflight identify the
   exact source, mounts and target. The service validates current layout and
   maintenance epoch, computes the envelope, and atomically reserves all
   affected domains. No Docker mutation occurs on failure. Read-only source
   inspection for sizing may precede admission; it is not authority to stop.
2. Agentor persists the operation ID, service/host/layout identity, ticket and
   demand envelope with the migration journal **before** suppressing restart or
   stopping the source. There is no cross-system transaction, so orphan ticket
   and orphan journal reconciliation must be idempotent and conservative.
3. After the source is confirmed stopped, the service remeasures its actual
   writable layer and owned mounts and rechecks filesystem free bytes/inodes,
   layout, maintenance fence and ticket. It must cover any growth since the
   first measurement. If the actual envelope exceeds the reservation, an
   atomic increase must succeed before `docker commit` or any copy; otherwise
   abort without beginning snapshots. Restart the original worker only after
   the broker verifies its destination mapping, maintenance exclusion and
   reserved restart/recovery headroom. If those checks cannot be established,
   leave the original stopped with its journal intact for operator recovery;
   do not turn a failed admission into unreserved restart writes. Source
   shutdown is not evidence that unrelated writers are excluded.
4. Verify the actual image/content destinations after commit and each new
   volume's mountpoint/allocation domain before the next copy or replacement.
   A changed layout, exhausted bound, expired fence or unverified store stops
   further mutation and retains the journal/artifacts for reconciliation.
   Safe read-only inspection and durable error recording may continue, but
   automatic rollback is **not** safe merely because the Docker error is
   definitive: the current rollback can delete canonical volume contents,
   copy data back and restart a worker. Before any such write, the broker must
   re-establish destination mapping, maintenance exclusion and sufficient
   recovery bytes/inodes. Otherwise hold `recovery-required` for the operator.
   Never retry with an alternate storage driver, runtime, or unreserved
   filesystem.
5. On timeout, process crash, daemon restart, ambiguous Docker result or
   incomplete rollback, keep the reservation and maintenance/recovery hold.
   Resolve in-flight operations, exact container/image/volume identities and
   actual allocated usage before any retry. Recovery may need additional
   capacity; if it cannot be obtained, keep the journal and artifacts intact
   and escalate to the operator. A stale lease is not permission to release.
6. On committed migration or completed rollback, retained source/image/copy
   artifacts still consume space. Only explicit identity-checked finalization
   and host-service reconciliation may retire the corresponding reservation.
   Canonical active worker data and the committed active snapshot image remain
   protected; cleanup must not count their deletion as available capacity.

Whole-instance backup/restore must omit source-host reservations, tickets,
maintenance leases, broker credentials and capacity-derived grants, just as it
already omits source-host migration journals. Restored workers remain held for
destination administrator runtime approval. A destination host must establish
its own service identity, measurement, maintenance epoch and reservation; an
authenticated source backup is not destination capacity authority. Old
backups without these fields retain their safe restore behavior.

## Unresolved support and acceptance

The supported matrix must name Docker Engine/containerd version and image
store mode, graph/snapshot driver, filesystem and quota mode for image and
volume paths, bind-path policy, rootless/rootful mode, encryption/thin-pool
behavior, and expected backup/restore layout. Local-volume-only preflight does
not by itself prove that the volume and image stores share a filesystem.
Unknown, remote, overlay-on-overlay, reflink/COW, thin-provisioned or
unvalidated quota configurations fail closed until a validated accounting and
hard-limit rule exists. The quota and maintenance approach above now supplies
the design direction; it is not evidence that the candidate adapter works.

Before lifting the gate, test measurement spoofing/replay, aliased paths,
separate image/volume filesystems, bytes and inode exhaustion, concurrent
reservations, source growth before stop, layout change, failed journal write,
service/restart recovery, lease expiry, Docker timeouts, partial copy/commit,
failed rollback and explicit finalization. Then run a disposable host/VM
migration with real retained data and recovery evidence. Tests must verify that
all admission failures leave existing workers intact and that no restored
source-host ticket can enable a destination migration. The isolated arithmetic
tests cover some malformed/insufficient accounting cases; none establishes the
host-service or migration acceptance described here.

## Service boundaries and actionable implementation sequence

Use a dedicated operator-provisioned Unix socket mounted only into the
orchestrator, with mutual TLS identity verification over that socket. Pin a
host-specific service identity and dedicated client trust root; never reuse
worker, application-login or repository credentials. Operator installation
provisions certificates, socket ownership and the narrow socket bind. Rotate
certificates through an explicit overlapping trust interval with generation
tracking; removal/revocation ends permission for new phases but preserves
reservations. No broker key, socket configuration, ticket or project grant is
part of an instance backup or a worker environment.

Separate the measurement/ledger process from the narrowly privileged local
quota-enforcement adapter. Its operations are enrolled identity lookup,
verified fresh-project enrollment and policy-bounded quota transitions. It
must reject arbitrary paths, filesystem creation/reformatting, mounts,
device access, shell commands and caller-selected project IDs. Operator-owned path handles and
registry mappings resolve destinations; use no-follow/identity checks at each
access, and fail on changed mount/layout generation. The host installer must
specify process isolation, its minimal filesystem/ioctl privileges and bounded
audit storage. Do not advertise a read-only measurement service if its bundled
adapter can write quotas; review that installation authority explicitly.

Implement and independently review in this order while keeping public admission
closed:

1. Define versioned RPC and persisted ledger schemas: host/layout/epoch,
   operation and mount identities, authenticated sequence/nonce, complete
   scan result, envelope, project limits, desired/applied quota transitions and
   conservative reservation state. Add strict size/time limits, authentication,
   replay rejection and fake-service tests before any real host adapter exists.
2. Implement a crash-durable, serialized ledger with atomic compare/reserve,
   idempotent operation lookup, explicit reconciliation and no TTL release.
   Fsync state and its containing directory before acknowledging a transition.
   Exercise concurrent orchestrators, torn/failed writes, service restarts,
   orphan tickets and journal-write failures without Docker access.
3. Implement the candidate mapper and bounded scanner behind an explicit
   unsupported-layout default. Build offline fixtures from exact store/mount
   metadata; include aliasing, project inheritance, special files, sparse
   allocation, copy expansion, inode exhaustion, delayed frees and every image
   destination. A complete scan cannot synthesize quota enforcement evidence.
4. Implement quota enrollment/transitions and maintenance fencing using a
   separately provisioned disposable host/storage test harness. Prove kernel
   `EDQUOT` for both blocks and inodes, unchanged limits after worker/daemon
   restart, root/UID1000 non-bypass, create-before-start enrollment ordering,
   interruption between intent and application, and recovery-only limit
   isolation. Reconcile real quota usage against measured physical allocation.
5. Add migration integration behind the still-closed public gate: durable
   ticket before source stop, post-stop remeasurement, validation before every
   allocation phase and guarded rollback/restart/finalization. Existing journals
   without capacity state must not manufacture a ticket; define an explicit
   service-assisted recovery enrollment path that inspects retained artifacts
   before permitting writes. Preserve old-format backup readability while
   stripping host capacity/quota authority on restore.
6. Run reviewed disposable end-to-end migration success, failed replacement,
   quota exhaustion, process interruption, rollback retry and explicit
   finalization with real retained rootfs/volume markers. Then run encrypted
   cross-host restore into separately enrolled destination storage. Only after
   all required evidence and a reviewed rollout change may public admission
   consume this protocol. DinD remains a separate gate and support extension.

The remaining operator work is concrete host provisioning and scheduling, not
another choice of whether to use a capacity service, maintenance window or
filesystem quotas. Before live quota acceptance, the operator must provide an
isolated test host/storage matching the candidate (or explicitly select another
adapter), approve installation of the measurement/enforcement service with its
declared privileges, assign hard ceilings/recovery maxima/control-storage
floors and a maintenance window, and supply the expected backup destination
layout. Exact package/filesystem compatibility, quota non-bypass and the
envelope's allocation rules are implementation/test questions, not facts an
administrator checkbox can attest away. This document neither requests nor
performs those host changes, and nothing here is ready to deploy.
