# Runtime migration disk-capacity admission: proposed contract

Status: design only, not implemented or approved for deployment. The operator
has chosen an operator-installed disk-measurement service and a maintenance
window that excludes unrelated disk writers. This document does not install a
service, stop workers, grant host access to Agentor workers, or authorize a
production migration. Until the contract is implemented and tested, public
migration remains closed by `WORKER_RUNTIME_MIGRATION_CAPACITY_UNVERIFIED`.

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
Include inodes and a nonzero operator safety floor on every constrained
domain. Reject uncountable special files, unreadable trees, source mutations
during measurement, unsupported copy semantics, or an unknown store mapping.
The service also needs fixed time, tree-entry, depth and memory budgets for
measurement, with cancellation and a clear incomplete-scan result. A timeout,
limit hit, permission denial or changing tree fails admission; partial counts
must never be promoted to a size bound. Do not invent a universal multiplier
and label it precise.

Most importantly, arbitrary replacement startup or validation can write
without a finite bound. Admission cannot promise rollback headroom for such a
worker unless an independently enforced per-domain write limit (or an equally
sound workload-specific bound) is present and included. Monitoring free space
after the fact is not a hard limit. No quota policy is implicitly authorized
here; until the operator selects and validates one, general migration remains
blocked. The same applies where source growth between initial measurement and
stop cannot be bounded. A stopped-source measurement is mandatory even when a
pre-stop upper estimate exists.

## Maintenance fence and durable reservation

Before admission the operator establishes a maintenance epoch that excludes
unrelated writers to **every** affected allocation domain. This is more than
stopping the selected worker: it must account for other Agentor workers,
image pulls/builds, backups/restores, daemon garbage collection, host jobs and
any non-Agentor process that can consume the same budgets. The operator must
choose enforceable fencing and document allowed daemon bookkeeping. If the
service cannot attest that the fence is active and remains active, it refuses
new reservations and migration pauses before the next storage mutation.
This design does not itself stop unrelated workers or authorize global
downtime.

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
filesystem-quota configurations fail closed until a validated accounting and
hard-limit rule exists. Per-workload write bounds and a maintenance-fence
mechanism remain operator design decisions.

Before lifting the gate, test measurement spoofing/replay, aliased paths,
separate image/volume filesystems, bytes and inode exhaustion, concurrent
reservations, source growth before stop, layout change, failed journal write,
service/restart recovery, lease expiry, Docker timeouts, partial copy/commit,
failed rollback and explicit finalization. Then run a disposable host/VM
migration with real retained data and recovery evidence. Tests must verify that
all admission failures leave existing workers intact and that no restored
source-host ticket can enable a destination migration. None of those checks
has been completed by this design document.
