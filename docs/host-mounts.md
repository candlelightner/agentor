# Host mount permissions

Agentor treats a Docker bind mount as host authority, not as an ordinary worker
setting. A worker can read everything beneath a read-only bind and can change
host data beneath a writable bind. Custom images, setup scripts, workers, and
group-administrative workspaces therefore cannot supply arbitrary host source
paths.

The secure default is an empty catalog. A new installation exposes no optional
host directory to any worker.

## Authorization model

A mount becomes usable only after all of these independent decisions exist:

1. A **platform administrator** adds the canonical absolute source directory to
   the global catalog. This is the only operation that accepts a raw host path.
2. A platform administrator **entitles an account** to that catalog entry.
3. The **account owner** assigns the entitled entry to all workers, one direct
   worker group, or one worker.
4. A worker selects that entry by its opaque `pathId`, chooses a container
   target, and chooses **Read only** or **Read and write**. Writable access is
   possible only when the catalog entry explicitly has `allowWrite` enabled.

Platform administrators can perform the owner steps for another account from
the same dashboard. Ordinary workspace administrators cannot approve paths,
entitle accounts, or create account-wide assignments.

A grant to a worker group applies to direct members of that group. Its group
administrator may delegate that exact grant to a descendant group or a worker
within the administrative subtree. Delegation cannot widen the source catalog,
cross to a sibling subtree, cross accounts, or upgrade a read-only catalog path
to writable.

The worker-creation dialog lets the account owner choose the worker's direct
group before selecting mounts. The available path list is recalculated for that
group, and selections that are no longer authorized are removed. A group-scoped
management MCP always derives the target group from its signed workload
identity; it cannot override `workerGroupId`.

## Platform path checks

Catalog entries must be canonical absolute POSIX paths. Agentor rejects the
host root, traversal aliases, NUL/backslash/colon characters, system and
authority surfaces such as `/proc`, `/sys`, `/dev`, `/run`, `/etc`, and `/root`,
Docker/containerd storage, and the actual Agentor data directory. Parent or
child overlap with a protected path is rejected as well. Source paths are
immutable; create a new catalog entry to change one.

These checks are a guardrail around a trusted platform-administrator decision,
not a substitute for host filesystem administration. Approve dedicated data
directories whose path components are controlled by the host administrator;
do not approve symlink aliases or directories whose parent can be replaced by
an untrusted host user. Prefer read-only access and enable `allowWrite` only for
data that worker code is intentionally allowed to modify.

Agentor resolves the authoritative source from `pathId` on every create,
settings update, rebuild, unarchive, clone, and import/restore path. A forged
client `source` is ignored. New-worker and import paths repeat authorization
after the provisional worker identity is durable and immediately before Docker
creation, so a concurrent revocation either prevents creation or is guaranteed
to find and stop the worker. Legacy source-only worker records remain usable
only when the exact source is now present in the catalog and effectively
assigned to that worker.

Custom-image provisioning does not change this boundary. Safe or Advanced
provisioning runs inside the controlled build environment; neither mode can add
host binds, choose a raw Docker socket, or turn a custom image definition into
host authority.

## Revocation

Deleting a catalog path, removing an account entitlement or assignment,
disabling `allowWrite` for a writable use, or moving a worker outside its
authorized group triggers the same reconciliation used by GUI, REST, and MCP.

For every affected running worker Agentor:

1. removes the unauthorized mount from durable desired configuration;
2. sets `hostMountsRevoked` and `pendingRebuild`;
3. stops the existing container immediately, because Docker cannot detach a
   bind mount from a live container;
4. rejects restart until a rebuild replaces the container; and
5. clears the guard only after that rebuild has created a container without the
   revoked bind.

The guard is persisted. Startup reconciliation retries a stop that previously
failed because Docker was unavailable. Archived workers have no live container;
their invalid desired mounts are removed and unarchive re-resolves the remaining
configuration.

## Dashboard and REST API

The sidebar's **Host mount permissions** dialog is the central interface. It
shows the platform catalog, per-account entitlements, and all/group/worker
assignments. Non-platform account owners see only their entitled catalog paths
and assignments. Worker creation and Worker Settings use a catalog dropdown, a
container target, and an access dropdown with **Read only** as the default.

The authenticated REST resources are:

- `GET /api/host-mounts`
- `POST /api/host-mounts` (platform admin; raw source path)
- `PATCH|DELETE /api/host-mounts/:id` (platform admin)
- `PUT /api/host-mounts/entitlements` (platform admin)
- `POST /api/host-mounts/grants` (account owner or platform admin)
- `DELETE /api/host-mounts/grants/:id`

`GET /api/host-mounts` accepts `ownerId` for a platform administrator and an
optional `groupId` or `workerId` to return the effective path identities for
that target. Worker create accepts optional `workerGroupId`; mount requests are
`{ pathId, target, readOnly }` even though read responses also include the
server-resolved `source` for transparency and legacy compatibility.

## Management MCP parity

Platform management MCP exposes:

- `host-mounts.catalog.list|create|update|delete`
- `host-mounts.entitlements.list|set`
- `host-mounts.grants.list|create|delete`
- `workers.create` with optional `workerGroupId`
- `workers.create` and `workers.update` mount items with only `pathId`, `target`,
  and `readOnly`

Group-administrative MCP exposes only:

- `host-mounts.delegations.list`
- `host-mounts.delegations.create`
- `host-mounts.delegations.delete`

The group tools derive account and administrative group from the live workload
identity and validate every target as a descendant group or in-subtree worker.
They intentionally have no raw `sourcePath`, entitlement, or catalog operation.
The list response separates `availablePaths`, which may be used for in-scope
worker create/update operations, from `delegablePaths`, which have the explicit
grant to that administrative group required for further delegation. Both are
safe identity/name/access projections and omit the host source path.
Revocation responses include the affected/stopped worker identities; failures
state that desired access was durably revoked even when Docker could not stop a
container immediately.

## Persistence

The versioned catalog is stored at `admin/host-mount-paths.v1.json`. Per-account
entitlements, assignments, and delegation ancestry are stored at
`users/<userId>/host-mount-grants.json`. Existing worker records do not require
a destructive migration. Legacy source-only mounts fail closed until an exact
catalog entry and effective grant exist.
