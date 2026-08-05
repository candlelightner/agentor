# Agent Orchestrator (Agentor)

Docker orchestrator that spawns isolated AI coding agent workers, each in its own container with terminal access via a web dashboard. All agent CLIs (Claude, Codex, Gemini) are pre-installed in a single unified worker image. The worker image also preinstalls the Kilo Code code-server extension (`kilocode.kilo-code`) pinned at **7.4.16** into the image-level code-server extension directory — no per-worker manual install is needed, and existing workers only pick it up after the worker image is updated and they are rebuilt. Includes a modular app system (Chromium, SOCKS5 proxy, VS Code Tunnel, SSH server), a unified Traefik reverse proxy for both TCP port mappings and HTTP/HTTPS/TCP domain routing, a VS Code editor (code-server), live per-worker resource monitoring (CPU/RAM/disk/network via the Docker API), worker export/import (portable `.tar` bundles incl. an optional `docker export` of the filesystem), and an automatic update mechanism for production deployments.

## Architecture

```
Worker (curl)            <--HTTP/JSON--> Orchestrator (/api/worker-self/*, identified by Docker source IP)
Browser (Vue 3/Nuxt UI) <--HTTP/JSON--> Orchestrator (Nuxt 3/Nitro) <--dockerode exec--> Worker (tmux/agent)
Browser (xterm.js)       <--WebSocket--> Nitro (crossws)             <--docker stream--> Worker (tmux)
Browser (noVNC iframe)   <--HTTP/WS----> Nitro (proxy)               <--HTTP/WS-------> Worker (websockify <--> x11vnc <--> Xvfb)  [Desktop iframe loads /desktop/<id>/agentor.html — an Agentor sibling of upstream vnc.html that injects a Ctrl/Cmd+V clipboard bridge]
Browser (code-server)    <--HTTP/WS----> Nitro (proxy)               <--HTTP/WS-------> Worker (code-server on port 8443)
Local VS Code            <--tunnel-----> Microsoft Relay              <--tunnel--------> Worker (vscode app → code tunnel)
Local ssh client         <--TCP--------> Traefik (ext :22xxx)         <--TCP-----------> Worker (ssh app → sshd :22)
Orchestrator             <--docker exec-> apps/*/manage.sh (start/stop/list app instances in worker)
Orchestrator (TraefikManager) <--dockerode--> Traefik container (unified reverse proxy: port mappings + domain routing, TLS)
```

Two additive, opt-in bridges run over the existing proxied terminal/desktop channels (no new topology):
- **Workspace file manager** — `/api/containers/:id/files/*` (list/upload/download/mkdir/rename/move/delete). Session-auth + owner-scoped, running-worker only, no host-path access (every op runs through Docker exec/getArchive/putArchive as uid 1000), with lexical + in-container realpath/lstat containment, traversal/intermediate-symlink escape protection, root delete blocked, 100 MiB / 1000-entry upload caps. Backs the optional **Files** popup on a running worker card (`WorkspaceFilesModal.vue`); the quick Upload/Download/Export card actions remain.
- **Offline workspace storage** — `/api/workspaces/*` inventories persistent storage and read-only browses running, stopped, or archived workspaces. Access is owner-scoped; admins can inventory all records, while physical orphans remain metadata-only. Directory and named-volume storage use an immutable-image one-shot helper with a read-only mount, no network/credentials/capabilities/ports/logs, and strict resource/path/preview/search bounds. The Workspace storage sidebar action opens `WorkspaceInventoryModal.vue` and `WorkspaceBrowserModal.vue`; downloads use native browser streaming.
- **Worker-local configuration** — `/api/containers/:id/configuration` stores variables separately from AES-256-GCM encrypted, write-only secrets and secret files. Precedence is orchestrator → user → environment → worker; desired changes set `pendingRebuild`, and only create/rebuild applies them. Secret files are materialized into `/run/agentor-secrets` tmpfs and omitted from workspace/export/clone artifacts. The dedicated `worker-config.key` is 0600 under `<DATA_DIR>` and must be retained to decrypt configured secrets.
- **Keyboard-transparent clipboard paste** — `POST /api/containers/:id/clipboard` sets the worker's X11 CLIPBOARD via `xclip`. The terminal (`useClipboardPasteBridge`) and the noVNC desktop (`agentor.html` + `agentor-clipboard.js`) intercept Ctrl/Cmd+V, POST the host-clipboard payload (image/png or UTF-8 text/plain; 16 MiB / 1 MiB caps), then replay the paste key so the agent/GUI app reads the synced X selection. No clipboard contents are logged or persisted. Requires an HTTPS secure context + a modern Chromium/Firefox async Clipboard API; unsupported/denied falls back to prior behaviour. Needs a worker-image update + rebuild (installs `xclip`, `worker/clipboard/set.sh`, builds `agentor.html` + injects `agentor-clipboard.js`) AND an orchestrator update (route + UI). Kilo/Codex are not patched.

Three managed containers:
- **Orchestrator**: Nuxt 3 app (SPA mode) with Nitro server, serving dashboard + managing workers and the Traefik container via Docker socket
- **Traefik**: Unified reverse proxy container handling both TCP port mappings (one dedicated entrypoint per mapping) and HTTP/HTTPS/TCP domain routing with Let's Encrypt or self-signed TLS. Managed by the orchestrator — created when any port/domain mapping or dashboard subdomain is configured, removed when empty. Port mappings work without `BASE_DOMAINS`; domain mappings require it. The reconcile is **misconfig-safe**: a mapping whose host port can't be bound (occupied, or the reserved 80/443 while domain routing is active) is rejected with 409 and rolled back out of the store, and a failed (re)create rolls Traefik back to its last-good config — so a bad mapping never wedges Traefik or locks the operator out of the dashboard (see @docs/networking.md → Reconcile Robustness).
- **Workers**: Single unified Docker image (`agentor-worker`, Ubuntu 24.04) with all agent CLIs pre-installed, running in tmux, plus an integrated display stack (Xvfb + fluxbox + x11vnc + noVNC on port 6080), code-server (VS Code on port 8443) with the Kilo Code extension (`kilocode.kilo-code@7.4.16`) preinstalled in its image-level extension directory, Chromium, and apps — Chromium with CDP, SOCKS5 proxy, VS Code Tunnel (native VS Code client via Microsoft relay), and OpenSSH server (port 22). Each worker is a single container with all agents available. Three persistent volumes per worker: workspace (`/workspace`), agent config data (`/home/agent/.agent-data` — symlinked to `~/.claude`, `~/.gemini`, `~/.codex`, `~/.agents`, `~/.claude.json`, and the Kilo XDG paths `~/.config/kilo`, `~/.local/share/kilo`, `~/.local/state/kilo`, `~/.cache/kilo`), and optionally DinD (`/var/lib/docker`). Worker identity is a stable UUID `id` (server-minted UUID v4 — the WorkerStore key and the `agentor.id` label, stable across rebuild/unarchive); the Docker container id (`containerId`) changes on every rebuild and is resolved from `id` on demand. The derived `containerName = agentor-worker-<id>` is the Docker container name, the prefix for per-worker volume names, and the DNS name Traefik routes to. No custom `Hostname` is set, so the in-container shell prompt shows the docker short container id, not the UUID. The image reference is `imageName` (+ `imageId`). A separate editable `displayName` is the user-facing label shown in the dashboard (free-form, not required to be unique). All worker settings are editable post-creation via `PATCH /api/containers/:id` from the **Worker Settings modal** (the Settings pencil / card title): `displayName` is applied to the running worker immediately (no rebuild needed), while `environmentId`, `repos`, `mounts`, and `initScript` are baked into the container at create time, so editing them updates the stored config and flags the worker `pendingRebuild` until the next rebuild (which re-resolves from the stored config and clears the flag). Environment-specific settings (CPU/memory, network, Docker, capabilities, instructions, setup script, env vars) are edited in the Environments modal, not the worker modal. The persisted `WorkerRecord` (workers.json) is **minimal**: it stores only what cannot be discovered from Docker at runtime — the worker's own settings (`displayName`, `status`, `repos`, `mounts`, `initScript`, `pendingRebuild`), foreign keys (`userId`, `environmentId`), and base fields (`id`/`createdAt`/`updatedAt`/`archivedAt`). Everything describing the live Docker container — `containerId`, `containerName` (`agentor-worker-<id>`), `imageName`, `imageId`, and the running/stopped state — is **not** persisted; it is resolved at runtime in `ContainerManager.sync()` by matching the `agentor.id` label (and, for archived workers with no container, derived from the id). The one image-related exception is `importedImage`: a worker restored from an export that captured the source filesystem persists the per-worker `agentor-import-<id>` image reference (a config choice, not a discoverable label) so the captured rootfs survives rebuild/unarchive; it is removed on permanent delete. The runtime `ContainerInfo` returned by the API is the record merged with that discovered Docker data, so it still carries those fields. The environment config and the git identity (name/email) are likewise resolved live at build time from the `EnvironmentStore` / the owning user, never copied onto the worker. There is no per-worker resource-limit override; limits come from the environment. **Resource metrics** are **per-worker only** (no host/system metrics — those are OS/runtime-dependent), served by an in-memory `ResourceMonitor` singleton entirely via the Docker API: cpu/mem/net from `container.stats`, disk from the writable layer (`SizeRw`) + a `du` of the worker's volumes (`GET /api/worker-metrics`, `POST /api/worker-metrics/refresh`, `GET /api/containers/:id/metrics`). No host bind mounts needed. **Worker export/import** uses durable asynchronous export jobs (`POST /api/containers/:id/export-jobs`, status/cancel/streaming download under `/api/export-jobs/:jobId`) with workspace-only default and explicit rootfs capture; `POST /api/containers/import` restores the portable bundle as a fresh worker. **Platform expansion:** offline inventory covers running/stopped/archived/deleted/orphan metadata; worker-local write-only secrets apply on rebuild; encrypted multi-workspace backups support local/fake/Google providers; controlled custom images and optional GitHub recovery remain digest pinned; and a trusted red administrative workspace reaches an internal, short-lived-identity management MCP with live policy, sanitized audit, and dashboard-only proposal approval. See @docs/production.md and @docs/architecture.md.

## Detailed Documentation

| Topic | File | Contents |
|-------|------|----------|
| Architecture | @docs/architecture.md | Storage modes (volume vs directory), worker state & persistence, WorkerStore, Docker labels |
| Worker System | @docs/worker.md | Unified worker image, init scripts, agents, per-user git identity, DinD, host bind mounts, startup sequence |
| Networking | @docs/networking.md | Unified Traefik proxy (port mappings + domain mappings), TLS challenges, self-signed certs, config drift detection |
| UI | @docs/ui.md | Split pane layout, tmux tab integration, theme system, VS Code editor, UI state persistence |
| Environments | @docs/environments.md | Environment system, network firewall, capabilities, instructions, worker API exposure |
| Logging | @docs/logging.md | Centralized logging, log collection, rotation, WebSocket streaming, log pane UI |
| Production | @docs/production.md | Update mechanism, agent usage monitoring |
| Apps | @docs/apps.md | Modular app system, adding new apps |
| API | @docs/api.md | API documentation (OpenAPI), adding docs to routes |
| Key Files | @docs/key-files.md | Complete file listing (server, client, worker, tests) |
| Testing | @docs/testing.md | Running tests, writing tests, conventions, maintaining FEATURES.md and TESTS.md |
| Authentication | @docs/authentication.md | better-auth integration, users, roles, resource ownership |
| Feature Inventory | @tests/FEATURES.md | Canonical list of all user-facing features, drives test coverage |
| Test Suite Index | @tests/TESTS.md | Test counts, structure, and design decisions |

## Tech Stack

- Framework: Nuxt 3 (SPA mode), Nitro server, Vue 3
- UI: Nuxt UI v3, Tailwind CSS v4
- Terminal: xterm.js 5 (@xterm/xterm + @xterm/addon-fit)
- Auth: better-auth 1.6 + admin plugin (user management, RBAC) + @better-auth/passkey (WebAuthn passwordless), better-sqlite3 (SQLite database for users/sessions/passkeys)
- Backend: dockerode 4, nanoid 5, crossws (WebSocket, bundled with Nitro), ws (WebSocket client for noVNC proxy), tar-stream (archive packing)
- Workers: Ubuntu 24.04, agent CLI (varies), tmux, git, Docker CE (opt-in DinD), Xvfb, fluxbox, x11vnc, noVNC (port 6080, with an Agentor `agentor.html` clipboard-bridge sibling of upstream `vnc.html`), xclip (X11 CLIPBOARD), code-server (port 8443), VS Code CLI (tunnel), Chromium, microsocks, dnsmasq, ipset, iptables

## Dev Commands

The orchestrator always runs inside Docker (both dev and production).

```bash
# Build worker image locally (Traefik uses the upstream image from Docker Hub)
docker build -t agentor-worker:latest ./worker

# Development (hot reload via mounted source)
docker compose -f docker-compose.dev.yml up

# Production (uses GHCR images via WORKER_IMAGE_PREFIX)
docker compose -f docker-compose.prod.yml up -d

# Build orchestrator image locally
cd orchestrator && docker build -t agentor-orchestrator:latest .

# Typecheck (run from orchestrator/)
cd orchestrator && npx nuxi prepare && npx vue-tsc --noEmit -p .nuxt/tsconfig.json
```

## Testing

```bash
# Integration tests (requires running orchestrator at localhost:3000)
cd tests && npm test            # All tests (API + UI)
cd tests && npm run test:api    # API only (headless, fast)
cd tests && npm run test:ui     # UI only (Chromium)
cd tests && npm run test:headed # UI with visible browser
cd tests && npx playwright test api/health.spec.ts  # Single file

# Testing workflow: run the full suite once, save output, then fix individual files
cd tests && npm test 2>&1 | tee /tmp/test-results.txt  # Full run, save output
cd tests && npx playwright test ui/container-card.spec.ts  # Re-run single file
```

**Dockerized tests** (recommended — runs against a fresh isolated agentor stack so the developer's local instance on `localhost:3000` is never touched):

```bash
cd tests && npm run test:docker                              # All tests
cd tests && npm run test:docker:api                          # API only
cd tests && npm run test:docker:ui                           # UI only
cd tests && npm run test:docker -- api/health.spec.ts        # Single file (note the `--`)
cd tests && npm run test:docker -- --project=api -g "health" # Pass-through any playwright flags
cd tests && npm run test:docker:clean                        # Wipe cached dockerd volume
```

The runner is a single privileged container (`docker-compose.tests.yml`) that starts its own `dockerd` (DinD), builds the agentor images, boots a fresh stack on `https://dash.docker.localhost` (Traefik with self-signed certs on `docker.localhost` + `docker2.localhost`), runs playwright, and tears the stack down on exit. No host ports are exposed, so it coexists with a local agentor on `localhost:3000`. The persistent `agentor-test-runner-docker` volume caches the inner dockerd between runs (subsequent runs skip image builds); `test:docker:clean` wipes it for a fully cold rebuild. Triple-nested DinD (host → worker → test-runner → inner orchestrator → inner workers) works because every level uses `overlay2` on a volume.

**Approach**: Do not repeatedly run the entire test suite. Run it once, save the output, then re-run only the individual failing test files to iterate on fixes.

**Requirements**:
- Every new feature or behavior change **must** include tests. Add API tests (`tests/api/`) for new endpoints and UI tests (`tests/ui/`) for new UI interactions. Follow existing patterns in the test suite.
- Always **run the affected tests** after adding or modifying them (`cd tests && npx playwright test <file>`) to verify they pass before committing.
- Always **update `tests/FEATURES.md`** whenever a feature is added, changed, or removed. This is the canonical feature inventory that drives test coverage — keep it in sync with the actual product.
- Always **update `tests/TESTS.md`** whenever tests are added, removed, or changed. Update the per-file test counts, file totals, and overview numbers to stay accurate.

See @docs/testing.md for full details (writing tests, conventions, helpers, debugging).

## Gotchas

- **crossws `peer.ctx` is undefined** in Nitro's bundled crossws — store per-connection state in a `Map<string, Context>` keyed by `peer.id`, not on `peer.ctx`
- **crossws `close` event does not fire reliably** in Nitro's dev mode — detect disconnected peers via `peer.send()` failure in the data handler instead of relying on the `close` callback
- **Iframes and xterm steal mouse events** during split pane / tab drag — apply `pointer-events: none` via a body class (`body.tab-dragging iframe, body.tab-dragging .xterm`)
- **`<ClientOnly>` is unnecessary** in SPA mode (`ssr: false`) and can cause layout issues — all code already runs client-only
- **Claude Code CLI exits immediately** (code 0) under QEMU emulation (amd64 on ARM host) — always build the worker image for native arch, never use `--platform=linux/amd64`
- **Regenerate `package-lock.json`** after modifying `package.json` dependencies (`rm package-lock.json && npm install`) or `npm ci` in the Dockerfile will fail
- **`useEventListener` is VueUse**, not a Nuxt built-in — use manual `addEventListener`/`removeEventListener` in lifecycle hooks
- **Reka UI tooltip hover in tests** — `locator.hover()` does not reliably trigger Reka UI tooltips; use `page.mouse.move(x, y)` with exact bounding box coordinates instead. Also `getByRole('tooltip', { name })` fails to match accessible names — check `[role="tooltip"]` text content directly
- **Nuxt 4 compatibility mode** (`future.compatibilityVersion: 4`) makes `app/` the source root — pages, components, composables, and assets go under `app/`, not the project root
- **Nitro `[...path]` catch-all doesn't match empty path** — `/editor/{id}/` needs a separate `index.ts` handler; the catch-all only matches when there's at least one path segment
- **tmux `respawn-pane -k` without explicit command** re-runs the original pane start command — always pass `bash` (or the desired command) as the last argument
- **h3 combined HTTP+WS handlers** — use `defineEventHandler({ handler, websocket })` when both HTTP and WebSocket must be served on the same route (e.g., code-server proxy)

## Environment Variables

See @.env.example for full list. `.env` only holds orchestrator-wide settings (logging, Traefik, dashboard auth, ACME providers). All user-scoped env vars are stored per user via the dashboard's Account modal (`PUT /api/account/env-vars`) as a single **uniform key/value list** persisted in `<DATA_DIR>/users/<userId>/env-vars.json` (shape `{ userId, createdAt, updatedAt, envVars: [{ key, value }] }`). There are no hardcoded fields — every env var, predefined (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) and custom alike, is one `{ key, value }` pair keyed by the actual env var NAME. Keys are validated `[A-Z_][A-Z0-9_]*`, must not collide with reserved names (`ENVIRONMENT`, `WORKER`, `ORCHESTRATOR_URL`, etc.), and must be unique; a `PUT` replaces the whole list. The **SSH public key is NOT an env var** — it lives only at `<DATA_DIR>/users/<userId>/ssh/authorized_keys` (1:1 with the Account → SSH Access field) and is managed by its own endpoint pair (`GET`/`PUT /api/account/ssh-key`), bind-mounted read-only into every worker the user owns for the SSH app. OAuth/subscription credentials are also per-user — log in once inside any of your workers and the cred files are written to `<DATA_DIR>/users/<userId>/credentials/{claude,codex,gemini}.json` and bind-mounted into every other worker that user owns. Kilo is a fourth Account credential/reset row alongside Claude/Codex/Gemini, but unlike those three it has no usage-monitoring endpoint and no separately installed Kilo CLI — the orchestrator only manages its shared config/auth/data files. Kilo has a per-user **config** directory at `<DATA_DIR>/users/<userId>/kilo/config`, bind-mounted into every one of that user's workers so the Kilo global config (`~/.config/kilo`) is shared per user across all their workers/new workers; Kilo's **complete** per-user **data** directory at `<DATA_DIR>/users/<userId>/kilo/data` is **directory**-bound into every one of that user's workers at `.agent-data/.kilo/shared-data` (surfaces at `~/.local/share/kilo`), so login (`auth.json`), provider API keys configured through Kilo's VS Code UI, and Kilo SQLite sessions/history are shared per user across that user's workers. A directory bind (rather than a file bind on `auth.json`) is required because Kilo atomically temp+renames `auth.json`, which would break a file-level bind. Legacy `credentials/kilo.json` and per-worker `.kilo/data` migrate into the shared dir on the next worker start/rebuild (missing auth providers merge without overwriting shared entries; first available DB/history wins); Account **Reset** targets the live shared auth. Kilo state/cache (`~/.local/state/kilo`, `~/.cache/kilo`) and code-server user/UI state remain per-worker. Every other user-scoped resource (workers, port/domain mappings, custom environments/capabilities/instructions/init-scripts, usage state) lives under the same `<DATA_DIR>/users/<userId>/` tree; built-in, platform-seeded entries for the four split stores are re-seeded on every startup to `<DATA_DIR>/defaults/`.
