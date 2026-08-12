# API Reference

## API Documentation

Auto-generated OpenAPI 3.1.0 docs powered by Nitro's built-in OpenAPI support. Zero external dependencies.

**Endpoints:**
- `/api/docs` — Scalar UI (interactive API explorer, deepSpace theme)
- `/api/docs/openapi.json` — Raw OpenAPI 3.1.0 spec

**How it works:** Each route file has a top-level `defineRouteMeta()` call (auto-imported Nitro macro) that enriches the generated spec with tags, summaries, schemas, parameters, and request/response bodies. Nitro auto-discovers all file-based routes and merges the metadata into a single OpenAPI spec.

**Tag groups:** Containers (incl. async worker export creation/import + per-worker metrics, **workspace file manager** `/files/*` with `FileEntry`/`FileListing`/mutation schemas, and **worker clipboard**), Workspaces (runtime-independent inventory and read-only browsing), Export Jobs (status, cancellation, authenticated streaming download), Backups, Image catalog, Admin workspace, Management MCP, **Managed networks**, **Worker groups**, **Worker Protection**, **Storage**, Tmux, Apps, Port Mappings, Domain Mappings, Environments, Capabilities, Instructions, Archived Workers, Logs, Updates, GitHub, Usage, Metrics (per-worker resource metrics, via the Docker API — no host metrics), Config, Health, Worker Self — plus an "Internal" tag for proxy/WebSocket relay routes.

The **Workspace file manager** (`/api/containers/:id/files/*`) and **worker clipboard** (`POST /api/containers/:id/clipboard`) endpoints are part of the Containers tag. They are session-authenticated, owner-scoped, running-worker only, never touch host paths (every op runs through Docker exec/getArchive/putArchive against the running container), execute as uid 1000 (`agent`), and enforce lexical + in-container realpath/lstat containment so a symlink can never redirect an operation outside `/workspace`. Upload is capped at 100 MiB / 1000 entries; clipboard payloads at 16 MiB image / 1 MiB text (`image/png` + UTF-8 `text/plain` only, validated server-side; auth/ownership/running checked before the body is read).

The **Workspaces** API (`GET /api/workspaces`, `/api/workspaces/:id/{files,metadata,preview,search,download}`) is independent of worker runtime. It exposes no storage reference or host path. Regular users can only access their own records; admins may inventory all records and see orphan metadata, but orphan contents remain inaccessible until an ownership-adoption workflow exists. Named volumes and directory storage are mounted read-only into a one-shot, immutable-image helper with no network, capabilities, credentials, logs, or published ports. Preview and search are bounded; downloads stream with `private, no-store` responses. Both JSON `POST` and browser-native `GET` download forms are available.

The **Worker Configuration** routes under `/api/containers/:id/configuration` are owner/admin scoped. `GET` returns local entries plus the effective source/precedence view; `PUT` accepts `{variables,secrets,secretFiles,envFile}` and returns no secret value; `/import` accepts bounded dotenv text. Secret/file entries are write-only and reported as configured/masked/encrypted. Configuration changes require rebuild. `POST /api/containers/:id/clone` copies the workspace and non-secret local variables and reports omitted secret names.

The **Backups** API uses `/api/backups`, `/api/backup-jobs`, `/api/backup-settings`, and `/api/backup-providers`. It supports owner-scoped manual/scheduled multi-workspace jobs, cancel/retry/status, restore, retention deletion, provider status, independently linked Google OAuth, and gated fake-provider diagnostics. Administrators configure installation Google OAuth material through `/api/admin/backup-providers/google-oauth`; the client secret is write-only and encrypted at rest. Responses expose safe progress/errors and encrypted-token status, never token values, client secrets, or archive keys.

The **Image catalog** API uses `/api/image-catalog`, `/api/image-builds`, and `/api/image-builder`. It covers constrained validation, asynchronous controlled builds/logs/cancel, immutable versions, promotion/rollback/defaults/test workers/cleanup, plus optional `/api/image-catalog/git/*` connection/sync/recovery. Git credentials are write-only. Fake build/Git diagnostics are test-gated.

The **Admin workspace** and **Management MCP** APIs are administrator-only. Workspace lifecycle uses dedicated routes so ordinary container lifecycle endpoints cannot mutate the trusted runtime. MCP policy, audit, and optional proposal-review routes expose sanitized records; diagnostic identity/invocation/network routes return 404 unless explicitly enabled for tests or diagnostics. The MCP transport itself has no public HTTP/Traefik route. Enabled tools include harness annotations, disabled capability groups are omitted from discovery, and worker console sessions target linked tmux sessions inside the selected worker rather than a host shell.

The administrator-only **storage** API at `/api/admin/storage` reports bounded installation disk visibility and `/api/admin/storage/cleanup` performs only conservative cleanup of dangling images/build cache, exited Agentor helpers, and old Agentor staging directories. It never selects referenced images, active jobs, workspaces, or retained artifacts for deletion.

The **Worker Self** group contains the unauthenticated, source-IP-identified routes mounted at `/api/worker-self/*` for use from inside worker containers (port mappings, domain mappings, usage, info). See `docs/environments.md` for details on how `requireWorkerSelf()` resolves the calling worker.

**Shared schemas:** Defined via `$global.components.schemas` in anchor files (typically the "list" endpoint for each group). Other routes in the same group reference these via `$ref`. Schemas: `ContainerInfo`, `RepoConfig`, `MountConfig`, `TmuxWindow`, `AppInstanceInfo`, `PortMapping`, `DomainMapping`, `Environment`, `Capability`, `Instruction`, `ArchivedWorker`, `ImageUpdateInfo`, `ErrorResponse`, `SuccessResponse`, plus the workspace file-manager schemas (`FileEntry`, `FileListing`, `MkdirRequest`, `RenameRequest`, `MoveRequest`, `MoveConflict`, `MoveConflictResponse`, `MoveResult`, `DeleteFilesRequest`, `DeleteFilesResult`, `DownloadFilesRequest`, `UploadFilesResult`) defined in the `files` list route.

### Adding Docs to a New Route

1. Add `defineRouteMeta({ openAPI: { ... } })` as the very first statement in the route file (before imports)
2. Include `tags`, `summary`, `operationId`, `parameters` (for path/query params), `requestBody` (for POST/PUT), and `responses`
3. For new entity types, define the schema in `$global.components.schemas` in the "list" route and reference via `$ref` elsewhere
4. The Scalar UI at `/api/docs` updates automatically — no rebuild needed in dev

**Configuration** in `orchestrator/nuxt.config.ts` under `nitro.openAPI`:
- `production: 'runtime'` — spec available in production builds
- `route: '/api/docs/openapi.json'` — spec URL
- `ui.scalar.route: '/api/docs'` — Scalar UI URL
- `ui.scalar.theme: 'deepSpace'` — dark theme matching the dashboard

## All API Routes

All API routes return JSON. Full interactive reference at `/api/docs` (Scalar UI) and raw spec at `/api/docs/openapi.json`.
