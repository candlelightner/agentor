# Management MCP parity matrix

The management MCP is an administrative workspace's internal control surface.
It is not a public HTTP API and it is not a Docker socket. The administrative
Codex bridge receives a short-lived, workspace-bound credential; every call is
checked against the current capability policy. A platform administrator has the
existing platform-wide authority. A group administrative workspace carries an
additional group principal: every discovery result and invocation is filtered
against the group's current same-owner descendant subtree. Parent admins may
manage descendants and their admin workspaces; child admins cannot inspect
ancestors, siblings, or unrelated branches. The dashboard and MCP share
the underlying manager/store layer where an equivalent exists.

Explicit `ownerId`/`userId` selectors preserve administrative cross-user
operation, but must identify a real Better Auth user and use Agentor's
path-safe historical ID alphabet. User-scoped stores assert that boundary again
before filesystem access and quarantine persisted records whose embedded owner
does not match their directory partition.

This matrix is an inventory of the current implementation, not a promise that
every dashboard widget can be mechanically replayed through MCP. `Tested` means
the listed focused automated evidence exists; it does not turn a mocked provider
or an interactive third-party login into a live-account verification.

For a group principal, the MCP equivalents below are further reduced to
member-targetable worker inspection/metrics, lifecycle, configuration/locks,
console/logs, files/workspaces (excluding clone), exports, backups, apps, and
mapping creation with an explicit member ID. It may create an evaluation
worker, but the owner/group are derived from its workload identity and the
worker is enrolled and network-reconciled before it is returned. Platform/global tools—including
group mutation, worker clone, imports, images/catalogs, managed
networks, global configuration/policy, and mapping list/delete—are omitted.

| User capability | Dashboard/API implementation | MCP equivalent | Tested evidence / limitation |
| --- | --- | --- | --- |
| System and worker inspection | Dashboard worker cards; `/api/containers`, worker status | `status.system`, `workers.list`, `workers.inspect` | `admin-management-mcp.spec.ts`; worker lifecycle tests; `workers.list` includes active and archived records so unarchive targets are discoverable |
| Worker create, settings, restart, rebuild, archive, unarchive, delete | Worker dialogs; container lifecycle API | `workers.create`, `workers.update`, `workers.restart`, `workers.rebuild`, `workers.archive`, `workers.unarchive`, `workers.delete` | MCP domain tests plus lifecycle/lock API tests; lock password applies where required |
| Clone worker/workspace | Worker clone API and storage UI | `workers.clone`, `workspaces.clone` | Workspace adapter and worker-domain coverage; secret values are not copied and names can be reported |
| Running-worker console | Terminal panes/WebSocket | `console.open`, `console.read`, `console.write`, `console.interrupt`, `console.close` | `admin-management-mcp.spec.ts`; targets worker tmux, never host shell |
| Worker logs | Dashboard log viewer | `logs.read` | `management-logs-domain.spec.ts` and `worker-output-redaction.spec.ts`; owner-checked Docker-log tail (1–1000 lines, at most 256 KiB) redacts exact managed literals from worker-local secrets/secret files and sensitive-named local, user-global, and environment variables. It does not expose arbitrary host paths or unbounded terminal output. |
| Worker-local variables, secrets, secret files | Worker Settings / configuration API | `configuration.get`, `configuration.set` | MCP security and worker-configuration tests; existing secret values are never returned |
| User environments, capabilities, instructions, init scripts | Sidebar catalog dialogs and catalog APIs | `catalog.{environments,capabilities,instructions,init-scripts}.{list,get,create,update,delete}` | Catalog adapter tests; built-ins stay immutable and owner is explicit |
| Recursive worker groups and administrative startup scripts | Nested Worker Groups UI; `/api/worker-groups`, `/assignment`, and `/validation`; group workspace lifecycle and `/startup-script` at `/api/worker-groups/:id/admin-workspace`; platform workspace `/api/admin/workspace/startup-script` | Platform principal: `groups.list/create/update/assign-worker/delete`, admin-workspace lifecycle, identity-bound `admin-workspace.startup-script.get/set`, and any provisioned group via `groups.admin-workspace.startup-script.get/set`; group principal: self script without a target ID plus lifecycle/script management for authorized descendants | Hierarchy/API/UI tests cover legacy roots, arbitrary depth, cycle/cross-owner rejection, overlap diagnostics, atomic moves, recursive network reconciliation/rollback, live ancestor authority, sibling/parent denial, descendant enrollment, non-disruptive desired/applied script revisions, every-start execution, failure status, and volume persistence |
| Protection locks | Worker Settings; `/api/containers/:id/protection` | `locks.get`, `locks.set`, `locks.remove` | `worker-protection-lock.spec.ts`; verifier/password is write-only, and `admin-management-mcp.spec.ts` verifies every legacy lifecycle/configuration, app, and exposure-mapping mutation alias requires it |
| Workspace inventory and offline browse | Storage inventory/browser; `/api/workspaces/*` | `workspaces.list`, `workspaces.files`, `workspaces.preview`, `workspaces.download`, `workspaces.clone` | `management-mcp-workspace-adapter.spec.ts`, `management-download-domain.spec.ts`, `management-download-handoff.spec.ts`, and storage API/UI tests; offline access remains read-only |
| Running-worker file management | Worker Files modal; `/api/containers/:id/files/*` | `files.list`, `files.upload`, `files.mkdir`, `files.rename`, `files.move`, `files.delete` | Existing hardened container file manager is reused; upload is one base64 file capped at 1 MiB, mutations honor worker protection locks |
| File and directory downloads | Authenticated streaming workspace endpoints | `workspaces.download` returns a private one-use streaming handoff | No session cookie or public route is required. The normalized path selection and owner are fixed at preparation, ownership is rechecked at redemption, directory ZIPs and files stream with backpressure, and disconnects destroy the offline helper source. |
| Worker export/import | Export modal/jobs; export/import APIs | `exports.create`, `exports.status`, `exports.cancel`, `exports.download`, `imports.prepare` | Export-job, download-handoff, workspace-adapter, and import-domain coverage. `exports.download` and `imports.prepare` return short-lived, one-use, workspace-bound private handoffs using the current management credential. Neither direction base64-buffers an archive in MCP JSON. |
| Image catalog and controlled builds | Image Catalog UI/API | `images.list/get/create/validate/delete/delete-version/usage/build/build-status/build-logs/build-cancel/promote/rollback/default/cleanup/git-status/git-sync` | Image catalog/Git catalog tests and MCP image adapter; logs and Git sync responses are sanitized |
| Image test worker / image selection | Image Catalog test-worker/default/worker creation controls | `images.test-worker`; catalog-aware `workers.create` | Both paths resolve the same immutable digest/runtime image through the shared catalog model |
| Backups, restore, provider status/settings | Backup UI/API | `backups.list/providers/settings/create/status/cancel/retry/delete/restore` | Backup, Google OAuth installation, and MCP image/backup tests. Original-worker API/UI restore verifies a protected source's transient password before job creation; MCP restore creates a new worker and therefore does not mutate the source. Provider credentials/tokens are intentionally non-retrievable; Google login remains human/external boundary |
| Managed worker networks | Managed Networks UI/API | `networks.list/inspect/create/update/reconcile/delete` | Managed-network API/UI and MCP topology tests; management network is not a selectable managed network |
| Port mappings and domain mappings | Mapping panels; `/api/port-mappings`, `/api/domain-mappings` | `port-mappings.list/create/delete`, `domain-mappings.list/create/delete` | `admin-management-mcp.spec.ts`, port/domain API suites. Create/delete resolve the affected worker and require its write-only lock password when protected. Dashboard has no mapping-update route, so MCP deliberately has none. Domain basic-auth password is never returned |
| Worker apps | Apps pane; `/api/containers/:id/apps/*` | `apps.types`, `apps.list`, `apps.start`, `apps.stop` | Mutations require a protected worker's write-only lock password; `admin-management-mcp.spec.ts` covers no/wrong/correct credentials plus app API/type suites |
| Storage visibility and conservative cleanup | Storage modal; `/api/admin/storage` | `storage.status`, `storage.cleanup` | Storage visibility API/UI tests; cleanup is intentionally restricted to named conservative actions |
| MCP policy, tool discovery, audit | Management MCP modal/admin APIs | Policy is administered by dashboard APIs; agent sees only enabled tools through MCP discovery | `management-mcp.spec.ts`, `admin-management-mcp.spec.ts`; disabled groups are absent and calls fail closed |
| Account profile, password, passkeys, SSH key, agent-credential reset | Account modal; `/api/account/*` and auth routes | No MCP equivalent | Deliberate current exclusion: these are personal identity/account-credential controls rather than administrative worker management; secret values remain non-retrievable |
| User administration | Users modal; `/api/auth/admin/*` | No MCP equivalent | Deliberate current exclusion pending a dedicated user-administration authority model |
| GitHub repository discovery/create/branches | Repository picker; `/api/github/*` | No MCP equivalent | Deliberate current exclusion; Git provider credentials are not exposed to the MCP |
| Usage and per-worker metrics | Usage cards; `/api/usage/*`, `/api/worker-metrics/*` | `usage.get`, `workers.metrics`, `workers.metrics.get` | `management-status-domain.spec.ts`, `management-owner-validation.spec.ts`, and `admin-management-mcp.spec.ts`; read-only, owner-filtered snapshots sanitize provider/Docker errors, explicit owners must be real and path-safe, and valid cross-user administration remains supported. The MCP deliberately has no provider-refresh action. |
| User-global plain variables | Account environment-variable UI/API | `configuration.global.list`, `configuration.global.effective-safe`, `configuration.global.set`, `configuration.global.delete` | `management-global-configuration-domain.spec.ts`; this pre-existing scope stores plain variables, not encrypted managed secrets. Sensitive-looking names are masked on reads; true write-only secrets remain worker-local configuration. |
| Orchestrator image updates | System UI; `/api/updates/*` | No MCP equivalent | Deliberate current exclusion: update/apply is an installation-level operation |
| Clipboard and tmux pane management | Worker UI; clipboard and `/api/containers/:id/panes/*` | No MCP equivalent | Current limitation: MCP console exposes the selected worker's existing tmux session only |

## Deliberate boundaries and remaining gaps

- **A group administrative workspace is not a delegated platform
  administrator.** Its scope is re-evaluated from live membership for every
  tool call, queued group/network/image mutation, and private handoff redemption. Removing a member revokes existing
  console sessions and one-use tokens; group deletion or workspace retirement
  revokes its credential and all associated sessions/tokens. No cached target
  list, direct UUID, alias, or token can bypass this check.
- **Every parsed MCP request settles with its original JSON-RPC id.** The
  private HTTP transport correlates authentication, authorization, validation,
  and tool failures. The stdio proxy independently bounds upstream I/O and
  converts non-success HTTP responses, empty/malformed JSON, mismatched ids,
  connection failures, and timeouts into one safe structured error.
- **Every tool call is a complete `CallToolResult`.** Successful calls include
  `isError: false`; application and authorization failures return correlated,
  sanitized `isError: true` results with object-shaped `structuredContent`.
  This preserves ordinary MCP semantics and compatibility with clients such as
  Hermes that access `isError` unconditionally.
- **Group principals administer only their live subtree.** They may create and
  reparent descendants, move workers already in that subtree, manage descendant
  administrative workspaces and group-scoped networks, and manage descendant
  image categories. They cannot move or delete their authority root, ungroup or
  import workers, reach parent/sibling branches, mutate global images/defaults,
  or use owner-wide network scopes. Central authorization rechecks these bounds
  at the serialized mutation boundary rather than relying on discovery alone.

- **No raw Docker or host command tool.** Console operations are scoped to the
  selected worker's tmux session. Managed networking and image operations go
  through Agentor's controlled services.
- **No secret retrieval.** Configuration, backup providers, Git catalogs, and
  basic-auth mappings accept replacements/configuration where supported, but
  do not disclose stored secret values, tokens, verifiers, or passwords.
- **No automatic human OAuth.** Google Drive, GitHub, Codex-LB/OmniRoute, Tavily,
  and other providers may require an account holder to complete external login.
  See [the routed-agent reference workflow](reference-agent-workflow.md).
- **Streaming/binary boundaries.** `workspaces.download`, `exports.download`,
  and `imports.prepare` return opaque private-management-listener paths rather
  than browser/session URLs or binary JSON. Each path is short-lived, one-use,
  bound to the administrative workspace and exact owner/resource, requires the
  current rotating management bearer credential, and rechecks its live
  capability at redemption. File, ZIP, tar download, and tar upload bodies
  preserve stream backpressure; client disconnects tear down their sources.
  The credential itself is never placed in the URL.
- **Logs are deliberately bounded.** `logs.read` is restricted to the selected
  owner's worker Docker logs, a 1–1000-line/256-KiB ceiling, and literal
  redaction of managed worker-local secrets/secret files plus sensitive-named
  local, user-global, and environment variables. Console reads apply the same
  boundary-safe redaction across incremental offsets. Encoded, transformed, or
  sub-four-character values cannot be recognized reliably. This is not a
  generic host-log or terminal-history reader.
- **Network connectivity probes and every UI-only convenience action are not
  separate MCP tools.** The agent can inspect/reconcile managed topology and
  use a target worker console, but it cannot request an unrestricted network or
  host probe.
- **Account identity, user administration, GitHub discovery, installation
  updates, clipboard, and tmux-pane conveniences have no MCP equivalents
  today.** They are listed above so absence is explicit rather than mistaken
  for parity. Usage and worker metrics are available as sanitized read-only
  MCP snapshots.

## Capability policy and harness confirmation

Capability groups include read-only status, logs, storage, running files, worker lifecycle,
console, configuration, groups, locks, images, networking, apps, backups, and
catalogs. New mutating groups default disabled. A disabled group is removed
from tool discovery and denied at invocation; aliases registered in that group
do not bypass it.

The MCP annotations distinguish read-only, mutating, and destructive operations
so a harness such as Codex can ask for confirmation. Agentor does not require a
dashboard approval click for every authorized mutation. Platform boundaries
(identity, ownership, secret non-disclosure, locks, controlled build/network
services, and capability policy) remain enforced independently of a harness.
