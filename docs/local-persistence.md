# Local persistent paths and managed volumes

Agentor-managed local persistence is available through worker settings, the
volume inventory, administrative MCP, and opt-in add-only worker self-service.

## Resource model

Local persistence is independent of backup selection. A worker attachment maps
an absolute application directory to an Agentor-created, local Docker volume.
The owner-facing volume ID is opaque; Docker names, host paths and volume driver
options are not client inputs. Directories already under persistent storage
need no additional volume. Individual files are not volume mount targets.

Volume records and per-worker policies are stored in owner-partitioned files
`managed-volumes.v1.json` and `persistence-policies.v1.json`. Durable records track
copy completion separately from attachment intent and operation state. A missing
previously populated volume is an error, never an invitation to create an empty
replacement. Retry must not overwrite an established volume.

## Applying an attachment

- **Deferred:** record the attachment for the next explicit application or rebuild.
- **Recreate:** stop the worker, preserve directory contents, and create a
  replacement using its current immutable image and runtime configuration.
- **Live:** freeze the worker, copy its directory and mount through a temporary
  privileged Agentor helper. This does not enable privileged mode on the worker.

Live mounting is a Linux amd64/arm64 feature requiring modern mount syscalls and
namespace access. Unsupported runtimes return an actionable error; recreation
is an explicit alternative, never a silent fallback. Open files, mapped files,
working directories, nested mounts, sockets and special devices can make a path
unsuitable for live mounting. Stop the affected application or choose recreation.

The live helper comes from the running orchestrator's immutable image, not the
worker's image. It receives one volume and the selected worker's PID namespace.
It receives no Docker socket, host-root mount, host PID namespace or orchestrator
credentials. It resolves target components without following symlinks and uses
pinned descriptors for mount operations. It never executes worker-provided code.
Live scans/copies are bounded (100,000 entries, 20 GiB, 120 seconds).

A live mount is not a change to Docker's container configuration. Durable intent
must therefore drive a declared mount on subsequent recreation. Transiently
mounted workers must not auto-start after daemon restart over stale underlying
directories. Recovery and operator visibility are required parts of the feature.

## Self-service and authority

Self-service is disabled by default. When enabled, a worker can inspect and add
its own persistent paths. It cannot remove, retarget or delete persistence,
select another worker's volume, change its policy, or authorize privileged or
disruptive operations. Self-service recreation and live-helper permission are
separate owner/admin choices, both disabled by default.

Worker-self identity comes from the existing source-IP authorization; clients
cannot provide an owner or target worker ID. Protection locks and live policy
checks also apply. GUI and delegated admin MCP operations use the same service
layer. Removal must distinguish detach (retain data) from confirmed deletion.

## Backup compatibility

Existing backup-created volumes are adopted without renaming or recopying.
After adoption, changing backup coverage does not remove local persistence, and
an old backup selection cannot reattach or overwrite a detached volume.

Local persistence is not a backup. Inventory must distinguish backed-up paths
from local-only data. Instance recovery and portable export explicitly describe
coverage rather than silently including or excluding custom volumes. Worker
export and backup settings expose a strict `includeManagedVolumes` boolean that
defaults false. Opt-in captures eligible attached custom volumes only; detached
volumes are excluded, and capture from a running worker is best-effort. Restore
allocates fresh local volume identities at the same target and keeps self-service,
live-mount, and recreation policies false.

## Operator workflow

Open **Worker settings → Persistent paths** to enter an absolute directory and
optional name. Select save-for-rebuild, explicit recreation, or live application.
The live option displays a privileged-helper warning and requires acknowledgement
unless previously authorized in the worker policy. All modes retain the worker's
existing privilege level. Protection-locked workers require their password.

Open **Workspace storage → Volumes** for custom volumes and built-in workspace,
agent-data, DinD, admin-workspace and proxy-certificate storage. Directory-backed
workspaces stay in the Workspaces tab. Inner DinD volumes are represented by their
outer Docker storage. Docker usage metadata is shown when available; unknown
size is explicitly “Not calculated”, not zero. Built-ins cannot be individually
deleted here. Deleted-account volumes with retained management records are visible
only to platform administrators for review and confirmed deletion. Unattributed
labeled volumes lacking records have deletion disabled.

Detach requires confirmation and retains data. Applying detachment recreates the
worker and exposes its underlying directory. Reattach uses the original worker
and path; retargeting and cross-worker sharing are unsupported. Delete is a
separate permanent action requiring confirmation and no desired, live or Docker
references. Worker deletion retains custom volumes. This feature adds no automatic
deletion of retained volumes on account deletion. Their management records move
to `retained-storage/` outside the removed account directory, so administrator
review and confirmed deletion remain available across orchestrator restarts.

## REST and MCP contracts

Session-authenticated routes:

- `GET /api/containers/:id/storage`: policy, desired attachments, operation state.
- `POST /api/containers/:id/storage`: `action` = `add`, `apply`, `detach`,
  `reattach`, `policy`, `rename` or `delete`.
- `GET /api/volumes`: owner/admin-scoped inventory.
- `GET /api/volumes/:id`: safe custom-volume details.
- `POST /api/volumes/:id`: rename or confirmed deletion.

Add accepts `target`, optional `name`, `mode` (`deferred`, `recreate`, `live`),
and `acknowledgePrivileged`. Mutations accept a write-only `lockPassword` for
protected workers. Application is asynchronous: poll volume inspection until
`operation.stage` is `complete` or `failed`. A worker can have at most 32 desired
paths. Repeating the same attached target is idempotent. Already persistent paths,
symlink components, overlapping mounts and protected runtime/system paths fail
with actionable errors before allocation.

Worker-self uses `GET /api/worker-self/storage` and `POST /api/worker-self/storage`
with only `target` and optional `name`. Its identity is never supplied by clients.
The existing worker MCP offers `storage.inspect` and `storage.add` only while
self-service is enabled. Repeating a failed add retries according to current
owner policy. It accepts no worker ID, mode, acknowledgement, lock password,
deletion action or permission change. Without live/recreation authorization,
requests remain pending. The existing worker-self API access policy also applies.

Administrative MCP capability group `storage-maintenance` provides
`volumes.inventory`, `volumes.inspect`, `volumes.rename`, `volumes.delete`, and
`workers.storage.{inspect,add,apply,detach,reattach,policy}`. Existing `volumes.list`
retains its workspace-file semantics. Group admins are confined to their current
subtree, rechecked inside queued mutations. Foreign and unknown IDs both return
404. Protection locks and capability revocation apply normally.

## Backup and upgrade details

The setting `persistSelectedDirectories` separates backup selection from creation
of new persistence. An omitted value preserves legacy behavior; new GUI settings
default it off. Disabling it does not detach already adopted volumes.

Portable rootfs exports do not include custom mounted data automatically.
Default v5 exports retain optional `localPersistence` coverage metadata, which
never authorizes mounts during import. An explicit custom-volume opt-in emits a
v6 bundle with a strict bounded payload for eligible attached volumes. Imported
Docker names, IDs, host paths, and policy fields are never trusted; fresh
destination identities are allocated only after target and image-ancestor
validation. Explicit path backups remain distinct from mounted-volume capture.
Whole-instance snapshots inventory managed custom volumes, including detached
data, and reject concurrent storage operations.

This requires an orchestrator-image update, not a worker-image rebuild. Live
mounting needs Linux amd64/arm64, namespace access, and modern mount syscalls.
Transiently mounted containers have Docker restart policy `no` until Agentor
recreates them with declared mounts. Use Agentor lifecycle controls rather than
manually starting them with Docker. Ambiguous failures can intentionally retain
a paused/stopped worker until recovery proves safety.

Storage-only recreation retains the actual immutable image, privilege level,
existing mounts (including anonymous volumes), custom hostname and dynamic network
attachments. Explicit static-IP reservations currently cause a pre-stop error;
use live mounting or remove the reservation first. Pending unrelated settings
are not applied. Archive copying is bounded to 20 GiB and 150 seconds. Neither
method is a database backup: stop applications requiring their own consistency
protocol before migrating their data.

Keep control-plane journals with instance backups. Do not manually remove or
rename managed volumes. Missing populated storage fails closed; restore it before
retrying application or restart. Recovery quarantine is per worker, so unrelated
workers remain available. This feature does not add an OS sandbox or reduce an
already privileged/DinD worker's authority.

## Verification and limitations

The isolated Docker acceptance/regression suite passes 89 API, integration and
browser tests, covering lifecycle recovery, protection locks, account retention,
owner/group authorization, self-service and backup compatibility. The helper also
has Python unit tests; orchestrator typechecking is part of local verification.

Named-volume sizes are calculated only by explicit asynchronous requests—never
during inventory reads—using a 60-second/1,000,000-entry read-only helper and a
15-minute incarnation-bound cache. Results report allocated blocks separately
from hardlink-deduplicated logical file bytes; live mounts are explicitly approximate.
