# Agentor Platform Guide

## What is Agentor?

Agentor is a platform for running AI coding agents in isolated Docker containers called **workers**. A human operator uses the Agentor web dashboard to create workers, configure their environments, and monitor their activity. You — the AI agent — run inside one of these workers.

## Architecture overview

There are three components in the platform:

- **Orchestrator** — The central server. It provides the web dashboard, manages all workers, and exposes a REST API. It runs as a Docker container (`agentor-orchestrator`) on the same network as your worker.
- **Workers** — Isolated Ubuntu containers where agents run. Each worker has its own filesystem, network stack, and persistent workspace. You are running inside a worker right now.
- **Traefik** — A single reverse proxy container managed by the orchestrator that handles both (a) TCP port mappings from host ports to internal worker ports (one dedicated entrypoint per mapping), and (b) domain-name routing to worker ports with automatic TLS. It is created automatically when the first port or domain mapping is configured. This is how services running inside workers (dev servers, APIs, etc.) become accessible from outside, either by port or by domain name.

You can interact with the orchestrator's API from inside your worker to manage port mappings, domain mappings, and check usage quotas — if these capabilities have been enabled for your environment. Skills for these APIs may be available to you.

### Talking to the orchestrator

All worker-facing API endpoints live under `$ORCHESTRATOR_URL/api/worker-self/*` and **do not require any session cookie or API key**. The orchestrator identifies your worker automatically by its source IP on the `agentor-net` Docker bridge network, so a plain `curl` is enough — no auth headers, no tokens. The first time you call one, sanity-check it with:

```bash
curl "$ORCHESTRATOR_URL/api/worker-self/info"
```

That returns `{ workerId, containerName, userId, status, displayName }` for *this* worker.

The orchestrator also exposes session-authenticated routes under `$ORCHESTRATOR_URL/api/...` (port mappings, domain mappings, etc.) for the dashboard UI — those need a logged-in browser session and are not usable from inside a worker. Always reach for the `/api/worker-self/*` variants when scripting from here.

## Your worker environment

### System

- **OS:** Ubuntu 24.04 LTS
- **User:** `agent` (uid 1000) with passwordless sudo
- **Shell:** bash
- **Workspace:** `/workspace` — this is your main working directory. It is stored on a persistent Docker volume that survives container restarts and even archiving/unarchiving of the worker. Always work here.
- **Home:** `/home/agent`
- **Hostname:** the short Docker container id (e.g. `16b082a7681b`) — visible in the shell prompt. It is not a friendly name; read your editable display name from the `WORKER` env var with `jq -r .displayName <<< "$WORKER"`.

### Installed tools

- **Languages:** Node.js 22 LTS (npm, npx), Python 3 (pip), build-essential (gcc, make)
- **Editors:** neovim, vim, nano, plus VS Code in the browser (code-server, with the Kilo Code extension `kilocode.kilo-code@7.4.16` preinstalled in the image-level extension directory) and a VS Code Tunnel app for connecting from a local VS Code via Microsoft's Remote - Tunnels
- **VCS:** git (pre-configured with the operator's name and email — agent-authored commits add a `Co-authored-by` trailer), gh (GitHub CLI)
- **Search:** ripgrep (rg), fd-find (fd)
- **Terminal:** tmux (your session is named `main` — you're already inside it)
- **Utilities:** jq, curl, wget, tree, less, htop, btop, rsync, strace, file, man-db
- **Network:** openssh-client/server, dnsutils, net-tools, iputils-ping
- **MCP servers:** Playwright MCP (`@playwright/mcp@latest`) and Chrome DevTools MCP (`chrome-devtools-mcp@latest`) are pre-configured for Claude, Codex, and Gemini

### Display, browsers, and remote access

A virtual display is running (Xvfb on `:99` with fluxbox). Set `DISPLAY=:99` to launch graphical applications. Chromium and Playwright (with bundled Chromium and Firefox) are available for browser automation.

Apps you can start from the dashboard's Apps pane (operator-controlled, but you can refer the user to them):
- **Chromium with CDP** (multi-instance) — debug-port Chromium for puppeteer/playwright
- **SOCKS5 proxy** (multi-instance) — `microsocks` for tunnelling traffic through this worker
- **VS Code Tunnel** (singleton) — opens a Microsoft Remote - Tunnels session so the operator can attach a local VS Code to this worker
- **SSH server** (singleton) — `sshd` on internal port 22, exposed via an auto-allocated external host port in `22000–22999`. Public-key auth only; the public key comes from the operator's **Account → SSH Access** field

A browser-based VS Code editor (code-server, port 8443) and a noVNC desktop view (port 6080) are always running for the dashboard's Editor / Desktop tabs. The Desktop iframe loads an Agentor-built `agentor.html` page (a sibling of the upstream noVNC `vnc.html`) that wires a keyboard-transparent clipboard bridge: Ctrl/Cmd+V in the desktop reads the host browser clipboard, syncs it to this worker's X11 CLIPBOARD via `xclip`, then replays the paste key so GUI apps (and Codex) paste the synced image/text. The same bridge works in the dashboard Terminal for Codex/GUI paste. No clipboard contents are logged. (Requires an HTTPS secure context + a modern Chromium/Firefox Clipboard API; unsupported/denied falls back to prior behaviour. The bridge needs the worker-image update + rebuild and the orchestrator update.)

The operator can also manage `/workspace` files from the dashboard via the per-worker **Files** popup (the Files button on a running worker card) — browse, upload, download (single file or true ZIP), mkdir, rename, move, and confirmed delete — all running as you (uid 1000) inside this container with symlink-escape protection. The quick Upload/Download/Export card actions remain.

### Docker-in-Docker

If Docker is enabled for this environment (`DOCKER_ENABLED=true`), a Docker daemon runs inside this container. The `agent` user is in the `docker` group — no sudo needed. Docker Compose, BuildKit, and all standard Docker features work natively. Docker data persists across container restarts.

### Optional host mounts

Any extra host directory visible in this worker was explicitly approved through
Agentor's central host-mount policy. A worker, agent, setup script, custom image,
or group-administrative workspace cannot choose a raw host source path. Platform
administrators maintain the raw-path catalog and account entitlements; the
account owner assigns entitled paths to all workers, a direct worker group, or
one worker. Group administrators may only pass an existing grant downward in
their own subtree through the management MCP.

Mount access defaults to read-only. **Read and write** is possible only when the
platform catalog explicitly permits it. If you need a host directory that is
not present, ask the operator/account owner to use **Host mount permissions** in
the dashboard; do not try to work around the policy with a custom image. A
revoked bind stops the worker and requires a rebuild before restart so Docker
cannot retain the old mount.

### Network access

Network access depends on your environment's configuration. Some environments allow full internet access, others restrict outbound connections to specific domains using a DNS-based firewall (modes: `full`, `block`, `block-all`, `package-managers`, `custom`). Regardless of the firewall mode, the orchestrator and other containers on the Docker network are always reachable, and agent API domains plus configured git provider clone domains are always allowed.

### Persistence guarantees

Three things survive container restarts, rebuilds, and archive/unarchive cycles:
- Your `/workspace` directory
- Your agent configuration (under `~/.claude`, `~/.codex`, `~/.gemini`, `~/.agents`, `~/.claude.json`, `~/.vscode`, and the Kilo XDG paths `~/.config/kilo`, `~/.local/share/kilo`, `~/.local/state/kilo`, `~/.cache/kilo` — symlinked from a persistent volume)
- DinD data (when Docker is enabled)

OAuth credential files for Claude / Codex / Gemini are bind-mounted from the operator's per-user host storage — logging in once with any agent CLI propagates the token to every worker that user owns. Kilo's global config (`~/.config/kilo`) is also shared per user across all that user's workers (bind-mounted from `<DATA_DIR>/users/<userId>/kilo/config`); Kilo's **complete** `~/.local/share/kilo` data directory (login, provider API keys configured through Kilo's VS Code UI, and Kilo SQLite sessions/history) is likewise shared per user — directory-bound from `<DATA_DIR>/users/<userId>/kilo/data` at `.agent-data/.kilo/shared-data`. A directory bind (rather than a file bind on `auth.json`) is required because Kilo atomically temp+renames `auth.json`, which would break a file-level bind. Kilo **state** and **cache**, plus code-server user/UI state, stay per-worker in `.agent-data` and are not shared across workers.

A permanent `delete` (not `archive`) wipes `/workspace` and the agent config volume. Archive keeps both intact for unarchiving later.

### Key environment variables

- `ORCHESTRATOR_URL` — Base URL of the orchestrator API (e.g. `http://agentor-orchestrator:3000`). Use this for all `/api/worker-self/*` calls.
- `WORKER_CONTAINER_NAME` — This worker's globally unique Docker container name (`<containerPrefix>-<id>`, e.g. `agentor-worker-<uuid>`, where `<id>` is your worker UUID). You almost never need to send it explicitly any more — `/api/worker-self/*` resolves your identity from your source IP — but it's still set for diagnostics and tools that need a stable identifier.
- `DOCKER_ENABLED` — `true` if Docker-in-Docker is available
- `DISPLAY` — X11 display (`:99`)
- `EXPOSE_PORT_MAPPINGS`, `EXPOSE_DOMAIN_MAPPINGS`, `EXPOSE_USAGE` — `true`/`false` flags reflecting which worker-facing API capabilities the operator enabled for this environment. The corresponding skills are only injected when these are `true`.
- Plus any agent API keys, `GITHUB_TOKEN`, and custom env vars the operator configured in their Account settings.
