# Production Systems

## Update Mechanism

Automatic image update detection and per-image or bulk updates for production deployments. Active when `WORKER_IMAGE_PREFIX` is set (GHCR images) and/or `BASE_DOMAINS` is set (Traefik). Tracks three images: orchestrator, worker (GHCR), and traefik (Docker Hub).

**Architecture:**
- `UpdateChecker` (`update-checker.ts`): Registry-agnostic digest checker. Parses image references (`parseImageRef`) to handle GHCR (`ghcr.io/org/repo:tag`), Docker Hub user images (`user/repo:tag`), and official images (`traefik:v3` → `library/traefik`). Token acquisition (`getRegistryToken`) handles GHCR (Basic auth + Bearer) and Docker Hub (anonymous token) separately. Polls every 5 minutes.
- `UpdateNotification.vue`: Sidebar component showing per-image status with individual "Update" buttons and a bulk "Update All" button
- `useUpdates.ts`: composable for update status polling (60s), `applyUpdates()` for bulk, `applyImage(key)` for per-image updates

**Update flow:**
1. Worker: pull new image → workers use new image on next create (existing workers keep the previous image until rebuilt)
2. Traefik: pull new image → recreate Traefik container (via `TraefikManager.forceRecreate()`) → TLS certs persist on named volume
3. Orchestrator: pull new image → create replacement container with temp name (`-next`) → spawn a one-shot swapper container (`-swapper`, `AutoRemove: true`) that uses the Docker socket to stop→remove→rename→start the replacement → UI polls `/api/health` until server returns. The swapper is needed because stopping the orchestrator's own container kills the Node.js process, so the remaining steps (remove, create, start) can't run in-process.

**Per-image updates:** The apply endpoint accepts an optional `{ images: UpdatableImage[] }` body to pull only specific images. The `UpdatableImage` type (`'orchestrator' | 'worker' | 'traefik'`) is defined in `shared/types.ts`.

**No version numbers** — only image digest hashes (sha256) are compared and displayed. Workers are NOT automatically restarted; they pick up the new image when next created or unarchived.

## Agent Usage Monitoring

Polls agent usage APIs to show each user's remaining capacity in the sidebar. Works for OAuth-authenticated agents (per-user credential files at `<DATA_DIR>/users/<userId>/credentials/{claude,codex,gemini}.json` for the three polled agents, or the per-user `CLAUDE_CODE_OAUTH_TOKEN` set in the Account modal). API key auth has no usage endpoints. **Kilo is a fourth Account credential/reset row** (its shared per-user auth now lives at `<DATA_DIR>/users/<userId>/kilo/data/auth.json`, directory-bound into every worker because Kilo atomically temp+renames `auth.json`), but it has **no usage-monitoring endpoint** and is not polled by `UsageChecker` — usage monitoring covers only Claude, Codex, and Gemini.

**Architecture:**
- `UsageChecker` (`usage-checker.ts`): Singleton + 5min polling. State is per-user — `Map<userId, Map<agentId, AgentState>>` — persisted to `usage.json` in the data directory. Each user's agents track their own fetch time and backoff independently. On restart, serves persisted results immediately; only re-fetches agents whose data is stale. Reads each user's credential files via `UserCredentialManager`, detects auth type per agent (OAuth > API key > none) per-user, fetches usage in parallel.
- `/api/usage` and `/api/usage/refresh` are auth-gated. Each call returns only `requireAuth(event).user.id`'s state — users never see one another's usage.
- `UsagePanel.vue`: Sidebar component showing per-agent auth badge + progress bars per usage window + "Fetched Xm ago" relative timestamp (for the signed-in user only)
- `useUsage.ts`: composable for 5min polling of `/api/usage`

**Supported agents:**

| Agent | Endpoint | Auth | Token Refresh |
|-------|----------|------|---------------|
| Claude | `GET https://api.anthropic.com/api/oauth/usage` | Bearer + `anthropic-beta: oauth-2025-04-20` | Not needed (CLI handles it). Supports per-user `claude.json` OAuth or per-user `CLAUDE_CODE_OAUTH_TOKEN` from Account env vars |
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` | Bearer (+ optional `ChatGPT-Account-Id`) | Hardcoded client_id, refreshes when `last_refresh` > 8 days. Refreshed token is written back to that user's `codex.json`. |
| Gemini | `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | Bearer | Not implemented (CLI client_id/secret not available in orchestrator); reports error if token expired |

**Normalized output:** All APIs are mapped to a common `UsageWindow` type with `label`, `utilization` (0-100%), and `resetsAt` (ISO 8601). Claude shows Session/Weekly/Sonnet windows, Codex shows Session/Weekly (+ Reserve when credits available), Gemini shows per-model-family windows (Pro/Flash). Progress bars use green (<50%), amber (50-79%), red (>=80%) coloring.

## Resource Monitoring

Live **per-worker** CPU / RAM / disk / network metrics, shown on each worker card. There is intentionally **no host/system metrics** — whole-host CPU/RAM/disk are OS- and runtime-dependent (host `/proc` parsing, `statfs` over virtiofs on Docker Desktop, etc.), so the feature is scoped to per-worker metrics that are derived entirely through the Docker API and behave identically everywhere. Independent of agent usage monitoring.

**Architecture:**
- `ResourceMonitor` (`resource-monitor.ts`): singleton poller, structurally mirrors `UsageChecker` but holds **no persistence** — metrics are ephemeral, kept in memory only. Started in the services plugin after `reconcileWorkers()`. Two cadences, each with an overlap guard so a slow sample never stacks the next tick: a fast 3s poll for cpu/mem/net and a slow 60s poll for disk.
- **cpu / memory / network** come from dockerode `container.stats({ stream: false })` for each running worker (no compose change — the Docker socket is already mounted). CPU% is the cgroup `cpu_stats`/`precpu_stats` delta as a fraction of total host capacity; memory subtracts `inactive_file` to match `docker stats`; network rates derive from the previous sample (kept per `containerName`).
- **disk** is sampled on the slower 60s cadence as the container's writable-layer size (Docker `SizeRw` via `inspect({ size: true })`, which excludes the read-only base image — this captures files the worker writes anywhere in its own fs) plus a `du` of its `/workspace` + agent-data volumes (storage-mode-agnostic). It is kept in a separate map and overlaid onto each `WorkerMetrics` on read. The DinD image store (`/var/lib/docker`) is excluded. The manual refresh bypasses both interval guards so a just-created worker is reliably sampled.

**Normalized type** (`shared/types.ts`): `WorkerMetrics` (per-worker cpu/mem/disk/net/blkio). The UI reuses the usage progress-bar color scheme (green <50, amber 50-79, red ≥80).

**Endpoints:** `GET /api/worker-metrics` (caller-owned workers; admins see all), `POST /api/worker-metrics/refresh` (force a sample), `GET /api/containers/:id/metrics` (single worker, ownership-checked). All auth-gated. Composable: `useWorkerMetrics` (sidebar → per-card `metric` prop, 10s poll).

## Offline Workspace Storage

The **Workspace storage** sidebar action lists durable workspaces without requiring their worker container to run. Running, stopped, and archived records can be browsed read-only; ownership is enforced before a helper is created. Administrators can see orphan metadata, but orphan contents are fail-closed until an explicit adoption flow can establish ownership.

Every access mounts the directory or named volume read-only into a one-shot helper resolved from the approved worker tag to an immutable image ID. The helper runs as uid 1000 with no network, ports, credentials, capabilities, or logs, a read-only root filesystem, no-new-privileges, and CPU/memory/PID/time limits. Startup removes crash-left helpers. Text/image previews, filename search, and path counts are bounded; symlinks are reported but never followed outside the workspace. File and directory downloads stream directly, carry `Cache-Control: private, no-store`, and do not expose the backing volume or host path.

## Disk visibility and conservative cleanup

Administrators can open **Workspace storage** to see a practical installation disk summary: filesystem free-space warning, workspace count/size where available, Docker image/build-cache totals, export/backup staging sizes, and stale helper count. Cleanup deliberately targets only dangling Docker images, dangling build cache, exited Agentor storage/restore helpers, and Agentor `backup-*`/`export-*` staging directories older than two hours. It does not remove referenced images, active jobs, completed export artifacts before their retention expiry, workspace volumes, or backup objects.

## Worker-local Secrets

Worker-local variables, masked secrets, and secret files are desired configuration: save marks the worker for rebuild, while create/rebuild applies it. A plain restart preserves the last-applied revision. The persisted `worker-configurations.json` contains plaintext only for entries explicitly classified as variables; secrets and files are AES-256-GCM ciphertext. Set `WORKER_CONFIG_ENCRYPTION_KEY` to an externally managed base64 32-byte key, or Agentor creates `<DATA_DIR>/worker-config.key` mode 0600. Preserve exactly one of those keys in protected disaster-recovery storage, separate from ordinary workspace backups, and never distribute it to workers. Losing it makes configured secret values unrecoverable; the UI still identifies names that must be re-entered. Key rotation is not automatic in this schema version: decrypt/re-enter values under the new key during a controlled migration.

Secret files are decrypted into a private 16 MiB tmpfs at `/run/agentor-secrets`; every path component is opened without following symlinks. Masked environment secrets and file bytes arrive only over Docker exec stdin and never enter Docker image/container configuration, `/workspace`, agent data, build contexts, image layers, exports, clones, or backup archives. Secret-bearing workers disable daemon-only automatic restart because only the orchestrator can repopulate tmpfs safely; orchestrator-controlled create/rebuild/restart uses a bounded pre-user-code handshake. API responses, centralized logs, jobs, and manifests never return values.

## Worker Export / Import

Download a complete, portable snapshot of a worker and restore it as a brand-new worker — on the same or another machine.

**Export** is a durable asynchronous workflow. `POST /api/containers/:id/export-jobs` returns `202` with an owner-scoped job ID; `GET /api/export-jobs/:jobId` reports status, phase, progress, bytes and timestamps; `DELETE` cancels it; and `/download` streams a completed artifact without buffering it in browser memory. Job metadata survives reloads/restarts (interrupted work is reported failed), successful artifacts expire after 24 hours, failed/cancelled records after one hour, and partial/orphan artifacts are cleaned automatically. A bounded queue, per-worker deduplication, temporary-storage preflight, artifact limits, and abortable archive pipelines prevent unbounded export work. The legacy synchronous `GET /api/containers/:id/export` remains for compatibility and now also defaults to workspace-only.

The generated `.tar` contains:
- `manifest.json` — the worker's own config + the embedded non-secret environment definition + its port/domain mappings. Environment variable values and domain basic-auth credentials are excluded.
- `workspace.tar.gz`, `agents.tar.gz` — the two persistent volumes (per-user OAuth credential files, the shared Kilo config directory, the shared Kilo data directory, and the legacy `.kilo/data/auth.json` inside the agents dir are **stripped** so an export never leaks account-level secrets, Kilo sessions/history, or configuration).
- `rootfs.tar` — the uncompressed `docker export` tar of the container filesystem (captures non-volume changes). v2 preserves Docker's tar stream rather than compressing it, avoiding the historical long compression/decompression path for large root filesystems. This is an explicit advanced option because it can be very large and consumes more temporary/artifact storage; workspace-only is the default. Import remains compatible with legacy v1 bundles containing `rootfs.tar.gz`.

**Import** (`POST /api/containers/import`, raw `.tar` body streamed to disk, `ContainerManager.importWorker`): admits one import per user, rejects oversized bodies while streaming, preflights temporary space, strictly validates the outer manifest/tar, and scans compressed inner volume tars plus either the v2 uncompressed rootfs tar or legacy v1 compressed rootfs tar for expanded-size, entry-count, and traversal limits before any Docker mutation. It then mints a fresh UUID worker, resolves/recreates the environment, `docker import`s the rootfs into a per-worker image (`agentor-import-<id>`, replicating the standard image's entrypoint/env so it boots — falls back to the standard image on any failure), creates the container **stopped**, restores the volumes via `putArchive`, starts it, then recreates the mappings (skipping conflicts / base domains not configured locally). The per-worker image link (`importedImage` on the `WorkerRecord`) survives rebuild/unarchive and is removed on permanent delete.

## Backup key and Google Drive configuration

Backups are encrypted before leaving the orchestrator. Set a high-entropy `BACKUP_ENCRYPTION_KEY`, or preserve the generated `<DATA_DIR>/backup.key` (0600, regular non-symlink file). Provider objects and workspace data are insufficient for recovery without this exact key. Keep it in protected infrastructure backup/secret storage; do not put it in a Git catalog, worker, build context, or the same Google Drive folder. There is no automatic key rotation in archive schema v1.

Google backup linking uses a separate OAuth client and is unrelated to Agentor login. An administrator can configure the client ID, client secret, and exact registered redirect URI ending in `/api/backup-providers/google/oauth/callback` in **Backup management**, then start the link flow without editing the orchestrator environment. The client secret is write-only and AES-GCM encrypted at rest; status never returns it. Existing `GOOGLE_BACKUP_CLIENT_ID`, `GOOGLE_BACKUP_CLIENT_SECRET`, and `GOOGLE_BACKUP_REDIRECT_URI` remain a backward-compatible fallback when no dashboard configuration exists; `GOOGLE_BACKUP_FOLDER_ID` remains optional. OAuth state is one-time and expires after ten minutes. Tokens are AES-GCM encrypted at rest and refreshed by the provider. Tests use the explicitly gated fake provider and never require a real Google account.

The scheduler stores exact minutes and a durable next-run timestamp. `all` resolves durable worker records, including archived workspaces. Archived reads use a read-only networkless helper. Retention keeps deletion-pending metadata when a provider delete fails so cleanup can be retried instead of silently forgetting a remote object.

## Controlled image builds and Git recovery

Controlled builds run only from approved aliases. `agentor-worker:approved-latest` maps to the configured official worker image; additional aliases come from `AGENTOR_APPROVED_IMAGE_BASES` JSON and should use immutable trusted references. Contexts and Dockerfile fragments are bounded and policy checked. The orchestrator is the sole Docker API consumer; workers, the admin workspace, contexts, and build steps receive no Docker socket or account credentials. Production UI builds select the controlled builder; fake builders/providers require explicit test-only gates.

For Git recovery, optionally set `GIT_IMAGE_CATALOG_ENCRYPTION_KEY` or preserve the generated 0600 key file. GitHub App mode also requires a server-mounted PEM at `GITHUB_APP_PRIVATE_KEY_FILE`; the PEM never enters persistent workspace storage. Fine-grained PATs should be scoped to one selected repository. Public no-token repositories, direct/branch/pull-request sync, existing-workflow Actions dispatch, optional GHCR digest metadata, and disconnect/credential erasure are supported. Catalog recovery restores image metadata and digest-pinned GHCR references only—it is not a workspace backup.

## Administrative boundary

The orchestrator generates and pins the trusted administrative overlay (`AGENTOR_ADMIN_WORKER_IMAGE` controls only its server-side name). Its only Docker network is the internal `agentor-management` network; the orchestrator proxies the existing terminal/editor/desktop services from that network. The MCP address has no published port or Traefik route, and ordinary workers never join the management network. The admin container has no Docker socket, host bind, privilege, or public port. Codex discovers the MCP through a preconfigured stdio bridge that reads the rotating tmpfs-only workload identity for each request, so no universal bearer token is persisted in the workspace.

Mutating MCP groups default off. Every invocation rechecks current policy and creates a sanitized audit record. Configuration application uses immutable proposals; dashboard review is available, while confirmation policy belongs to the invoking harness. Worker log bodies are intentionally omitted from MCP responses because generic log text cannot be proven free of bare secrets. Console output redaction is best effort for exact managed worker-local secret values only, not a guarantee for transformed output or account/environment values; console access remains privileged.
