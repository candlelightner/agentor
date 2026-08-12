# Management MCP parity matrix

The management MCP is the administrative workspace's internal control surface.
It is not a public HTTP API and it is not a Docker socket. The administrative
Codex bridge receives a short-lived, workspace-bound credential; every call is
checked against the current capability policy. The dashboard and MCP share the
underlying manager/store layer where an equivalent exists.

This matrix is an inventory of the current implementation, not a promise that
every dashboard widget can be mechanically replayed through MCP. `Tested` means
the listed focused automated evidence exists; it does not turn a mocked provider
or an interactive third-party login into a live-account verification.

| User capability | Dashboard/API implementation | MCP equivalent | Tested evidence / limitation |
| --- | --- | --- | --- |
| System and worker inspection | Dashboard worker cards; `/api/containers`, worker status | `status.system`, `workers.list`, `workers.inspect` | `admin-management-mcp.spec.ts`; worker lifecycle tests |
| Worker create, settings, restart, rebuild, archive, unarchive, delete | Worker dialogs; container lifecycle API | `workers.create`, `workers.update`, `workers.restart`, `workers.rebuild`, `workers.archive`, `workers.unarchive`, `workers.delete` | MCP domain tests plus lifecycle/lock API tests; lock password applies where required |
| Clone worker/workspace | Worker clone API and storage UI | `workers.clone`, `workspaces.clone` | Workspace adapter and worker-domain coverage; secret values are not copied and names can be reported |
| Running-worker console | Terminal panes/WebSocket | `console.open`, `console.read`, `console.write`, `console.interrupt`, `console.close` | `admin-management-mcp.spec.ts`; targets worker tmux, never host shell |
| Worker logs | Dashboard log viewer | `logs.read` metadata only | Intentional exclusion: unbounded attacker-controlled logs could contain bare secret values; MCP reports omission rather than log bytes |
| Worker-local variables, secrets, secret files | Worker Settings / configuration API | `configuration.get`, `configuration.set` | MCP security and worker-configuration tests; existing secret values are never returned |
| User environments, capabilities, instructions, init scripts | Sidebar catalog dialogs and catalog APIs | `catalog.{environments,capabilities,instructions,init-scripts}.{list,get,create,update,delete}` | Catalog adapter tests; built-ins stay immutable and owner is explicit |
| Worker groups | Worker Groups UI; `/api/worker-groups` | `groups.list`, `groups.create`, `groups.update`, `groups.delete` | `worker-groups.spec.ts` and worker-domain tests |
| Protection locks | Worker Settings; `/api/containers/:id/protection` | `locks.get`, `locks.set`, `locks.remove` | `worker-protection-lock.spec.ts`; verifier/password is write-only |
| Workspace inventory and offline browse | Storage inventory/browser; `/api/workspaces/*` | `workspaces.list`, `workspaces.files`, `workspaces.preview`, `workspaces.download`, `workspaces.clone` | `management-mcp-workspace-adapter.spec.ts`, storage API/UI tests; offline access remains read-only |
| File and directory downloads | Authenticated streaming workspace endpoints | Small regular files via `workspaces.download`; larger files/directories return authenticated download location | Intentional transport limit: MCP never buffers directory archives or files above 256 KiB |
| Worker export/import | Export modal/jobs; export/import APIs | `exports.create`, `exports.status`, `exports.cancel`, `exports.download` | Export-job and workspace-adapter tests; download is intentionally authenticated streaming, not embedded archive bytes. **Binary worker import has no MCP tool yet.** |
| Image catalog and controlled builds | Image Catalog UI/API | `images.list/get/create/validate/delete/build/build-status/build-logs/build-cancel/promote/rollback/default/cleanup/git-status/git-sync` | Image catalog/Git catalog tests and MCP image adapter; logs are sanitized |
| Image test worker / image selection | Image Catalog test-worker/default/worker creation controls | Use `images.*` versions/defaults with `workers.create`/`workers.update` | Shared catalog/worker model; explicit one-call `images.test-worker` convenience tool is not registered |
| Backups, restore, provider status/settings | Backup UI/API | `backups.list/providers/settings/create/status/cancel/retry/delete/restore` | Backup, Google OAuth installation, and MCP image/backup tests. Provider credentials/tokens are intentionally non-retrievable; Google login remains human/external boundary |
| Managed worker networks | Managed Networks UI/API | `networks.list/inspect/create/update/reconcile/delete` | Managed-network API/UI and MCP topology tests; management network is not a selectable managed network |
| Port mappings and domain mappings | Mapping panels; `/api/port-mappings`, `/api/domain-mappings` | `port-mappings.list/create/delete`, `domain-mappings.list/create/delete` | `admin-management-mcp.spec.ts`, port/domain API suites. Dashboard has no mapping-update route, so MCP deliberately has none. Domain basic-auth password is never returned |
| Worker apps | Apps pane; `/api/containers/:id/apps/*` | `apps.types`, `apps.list`, `apps.start`, `apps.stop` | `admin-management-mcp.spec.ts` plus app API/type suites |
| Storage visibility and conservative cleanup | Storage modal; `/api/admin/storage` | `storage.status`, `storage.cleanup` | Storage visibility API/UI tests; cleanup is intentionally restricted to named conservative actions |
| MCP policy, tool discovery, audit | Management MCP modal/admin APIs | Policy is administered by dashboard APIs; agent sees only enabled tools through MCP discovery | `management-mcp.spec.ts`, `admin-management-mcp.spec.ts`; disabled groups are absent and calls fail closed |

## Deliberate boundaries and remaining gaps

- **No raw Docker or host command tool.** Console operations are scoped to the
  selected worker's tmux session. Managed networking and image operations go
  through Agentor's controlled services.
- **No secret retrieval.** Configuration, backup providers, Git catalogs, and
  basic-auth mappings accept replacements/configuration where supported, but
  do not disclose stored secret values, tokens, verifiers, or passwords.
- **No automatic human OAuth.** Google Drive, GitHub, Codex-LB/OmniRoute, Tavily,
  and other providers may require an account holder to complete external login.
  See [the routed-agent reference workflow](reference-agent-workflow.md).
- **Streaming/binary boundaries.** Browser-authenticated download endpoints are
  used for large files, directory archives, and export artifacts. There is no
  MCP worker-import tool for uploading a binary bundle.
- **Logs are intentionally metadata-only** through MCP until a safe bounded
  redaction design exists for arbitrary terminal output.
- **Network connectivity probes and every UI-only convenience action are not
  separate MCP tools.** The agent can inspect/reconcile managed topology and
  use a target worker console, but it cannot request an unrestricted network or
  host probe.

## Capability policy and harness confirmation

Capability groups include read-only status, logs, storage, worker lifecycle,
console, configuration, groups, locks, images, networking, apps, backups, and
catalogs. New mutating groups default disabled. A disabled group is removed
from tool discovery and denied at invocation; aliases registered in that group
do not bypass it.

The MCP annotations distinguish read-only, mutating, and destructive operations
so a harness such as Codex can ask for confirmation. Agentor does not require a
dashboard approval click for every authorized mutation. Platform boundaries
(identity, ownership, secret non-disclosure, locks, controlled build/network
services, and capability policy) remain enforced independently of a harness.
