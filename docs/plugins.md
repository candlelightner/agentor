# Worker plugins

Agentor plugins are declarative, versioned additions that can run inside a
worker without giving the plugin author access to the orchestrator Docker
socket or its credentials. A plugin definition declares the executable
commands it needs, limited resources, the names of environment values it may
reference, and optional private UI actions. Installing a definition creates a
separate per-worker installation record.

## Definitions and scope

Definitions use manifest schema version `1` and can be scoped to the platform,
an owner, a worker group, or one worker:

| Scope | Who can create it | Where it is visible |
| --- | --- | --- |
| `platform` | Platform administrators | All workers |
| `owner` | The owning user | That user's workers |
| `group` | The group owner | Workers in that group and its descendant groups |
| `worker` | The worker owner | Only that worker |

Definitions are exposed at `/api/plugins/definitions`. Platform definitions
are administrator-only. A group definition is inherited down the group
hierarchy but never into siblings or ancestors. A worker cannot install a
definition outside its visible scope, even if a caller knows its ID.

Each manifest has a name, stable slug, version, description, lifecycle
commands, and optional resources, environment references, private actions,
documentation, and a sanitized SVG icon. Commands are argument arrays rather
than shell snippets. The manifest validator rejects unexpected fields,
unnormalized working directories, invalid resource declarations, unsafe SVG,
and text that resembles literal secret material. Runtime values must be named
references rather than embedded in a manifest.

## Installation lifecycle

Use `GET` and `POST /api/containers/:id/plugins` to list definitions available
to a worker and create installations. The installation request may only name
environment or secret keys declared in the definition; undeclared references
are rejected. Installations can be enabled or disabled through
`PUT /api/containers/:id/plugins/:installationId/enabled`, and removed through
`DELETE /api/containers/:id/plugins/:installationId`.

The runtime reconciles the desired state: it runs optional install/start/stop
and cleanup commands, applies readiness checks, records status and bounded
output, and releases allocated resources when stopped or removed. A plugin
cannot choose an arbitrary host port: it must declare a port ID and protocol,
then receives an allocation from its declared fixed value or range. Display
use is similarly declared as none, shared, or a bounded dedicated display.

The worker image includes the small `plugin-runner` at build time. Lifecycle
requests reach it through the orchestrator's Docker-exec boundary as a bounded
newline-delimited control document. The runner accepts argv commands only,
uses a minimal child environment, resolves only the declared key names already
available in that worker, and persists background-process bookkeeping under
agent data. It never receives the Docker socket, orchestrator credentials, or
secret values from a definition.

Reconciliation is serialized per worker and tied to the live Docker container
ID. A restart or rebuild therefore cannot reuse a ready observation from a
destroyed container: desired enabled installations are provisioned again and
desired disabled installations are stopped. Install/enable reserves resources,
runs install then start, and verifies readiness; disable runs stop; uninstall
runs stop and cleanup before releasing resources and deleting the installation.

## Environment and private UI

A manifest declares ordinary `envKeys` and write-only `secretKeys` by name.
An installation selects from those declarations; secret values continue to be
managed by Agentor and are never returned in plugin responses, logs, or
definition exports.

Private UI actions are restricted to a declared plugin port and path. They are
served through the authenticated plugin UI proxy and open in a sandboxed
dashboard pane; a plugin does not receive a public Traefik mapping simply by
declaring an action. Actions may use `openMode: "desktop"` for a noVNC-backed
application: after the same installation/action authorization, Agentor routes
the pane to `/desktop/:workerId/agentor.html`, preserving the authenticated
clipboard-aware desktop proxy instead of forwarding raw port 6080.

## Worker-self MCP

Ordinary workers and trusted administrative workspaces can use the narrow
JSON-RPC endpoint `POST /api/worker-self/mcp` to discover and operate plugins
installed on *that exact runtime*. The endpoint implements MCP initialization
and `tools/list` / `tools/call`; it has no browser-session or externally
exposed management transport.

The server derives identity from the caller's live Docker source IP and the
authoritative runtime registration, never from MCP arguments or environment
variables. Ordinary workers are resolved only on the worker bridge. A platform
admin or group-admin is additionally accepted only for this plugin endpoint
when it is the currently running, labeled and registered trusted administrative
workspace on its expected management network. That exception does **not** add
admin workspaces to generic worker-self endpoints such as ports, domains,
usage, or worker information.

Self-created definitions are always worker/workspace scoped. A platform admin
may use platform definitions and definitions scoped to its own administrative
workspace. A group admin may use platform definitions, definitions inherited
from its bound group or ancestors, and definitions scoped to its own workspace;
it cannot use owner-wide, sibling, descendant-only, other-admin, or unrelated
group definitions. Neither kind can choose another target worker or workspace
through this MCP. Management MCP authorization remains the boundary for
managing other authorized workers.

Tool errors are sanitized: inaccessible resources resolve as `Resource not
found`, authorization failures do not disclose details, and responses contain
only bounded safe error text. This endpoint is intended for a plugin-aware
agent running in its own runtime, not as a substitute for the management MCP
or dashboard authorization.

### Availability after upgrades

The self-plugin client and `plugin-runner` are image/overlay components. New
ordinary workers based on a current Agentor worker image receive them. An
existing custom image version is immutable: rebuilding a worker on that same
version does not add newly released worker-image files. Build and promote a
new custom-image version from a current, digest-pinned Agentor base, then
rebuild the worker. Trusted global and group administrative workspaces receive
the self-plugin client through their current administrative overlay; apply an
orchestrator update and rebuild/start the relevant admin workspace to refresh
that overlay. Existing installations and user-owned files are preserved.

## Backup path selection

Backups retain their portable workspace and agent-data defaults. When a backup
needs additional material, the dashboard's path picker queries
`GET /api/containers/:id/backup-paths?path=/absolute/path` and sends the
explicit selections with the backup request. Paths must be absolute POSIX
paths; duplicate and descendant selections are normalized so a selected parent
is backed up once. The picker can browse readable worker directories outside
`/workspace`, which is intentional: that broader copy is an explicit choice
and should be reviewed carefully before creating the backup.

The picker returns metadata only. It does not make a path public, relax normal
worker ownership checks, or expose the chosen data until it is included in an
authorized backup and restored or downloaded through the existing backup
workflow.

## Export, clone, import, and Git portability

When a worker has plugins, its export/clone snapshot may include
`plugins.json`. It carries the referenced definitions and desired installation
state, including environment and secret *names*. It deliberately excludes
secret values, observed status, output, process state, and port/display
allocations. Import restores definitions as worker-scoped copies, mints fresh
installation IDs and allocations, and reports missing secret names for the
destination to supply. A missing secret records plugin lifecycle failure
without making the otherwise valid worker import fail.

The Git plugin format likewise transports versioned definition content
(manifest, lifecycle scripts, documentation, and sanitized icon), not worker
runtime state or credentials. It is a portability/recovery format and is not a
workspace backup.
