# Agentor: Agent Orchestrator

[![Build and Push Docker Images](https://github.com/candlelightner/agentor/actions/workflows/docker-build.yml/badge.svg?branch=main)](https://github.com/candlelightner/agentor/actions/workflows/docker-build.yml)

Self-hosted alternative to Claude Code Web, Codex in the Cloud, and similar managed agent environments. Spawns isolated AI coding agent workers in Docker containers, each with a live terminal, VS Code editor (browser + native tunnel), virtual desktop, TCP port + domain mapping, and GitHub integration, all managed through a web dashboard. Full control over the runtime environment.

![Agentor Dashboard](docs/screenshot.png)

## Pre-installed Agents

All agents are installed in a single unified worker image. Start any agent via init script presets or manually in the terminal. **Credentials are scoped per user** — each user logs in (or sets their own API key) once, and that account's tokens are shared across all of their workers.

| Agent | | OAuth Login (per user, inside any worker) | Or set as API key (per user, in Account modal) |
|-------|---|-------------------------------------------|------------------------------------------------|
| **Claude** | [anthropics/claude-code](https://github.com/anthropics/claude-code) | `claude` → `/login` | `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) |
| **Codex** | [openai/codex](https://github.com/openai/codex) | `codex login --device-auth` | `OPENAI_API_KEY` |
| **Gemini** | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | `gemini` → `/auth` | `GEMINI_API_KEY` |

## Features

- **User authentication & RBAC** — email/password/passkey login powered by [better-auth](https://www.better-auth.com/) with admin and user roles; admins create and manage other users, each user sees only their own workers/mappings/environments/etc. First-run setup creates the initial admin.
- **Live terminal** — xterm.js WebSocket terminal with tmux session management
- **VS Code editor** — code-server per worker with Kilo Code preinstalled and per-user config, provider keys, login, and Kilo sessions shared across that user's workers
- **Virtual desktop** — Xvfb + fluxbox + noVNC, accessible in-browser, with a keyboard-transparent Ctrl/Cmd+V clipboard bridge (host-clipboard images/text synced to the worker's X11 CLIPBOARD, then the paste key is replayed so GUI apps and Codex paste the synced content)
- **Workspace file manager** — an optional Files popup on each running worker card to browse `/workspace`, upload/download (single file or true ZIP), mkdir, rename, move, and delete with symlink-escape protection (the quick Upload/Download/Export card actions remain)
- **Multi-repo cloning** — clone one or more git repos into each worker at startup
- **App system** — launch Chromium (with CDP), Persistent VS Code (a noVNC-hosted client that stays alive when the viewer disconnects), SOCKS5 proxy, VS Code Tunnel (native VS Code client via Microsoft's relay), or OpenSSH server from the Apps pane
- **Port & domain mapping** — unified Traefik reverse proxy handling both TCP port forwarding (localhost- or network-bound) and subdomain-based HTTP/HTTPS/TCP routing with TLS (Let's Encrypt HTTP-01/DNS-01 or self-signed CA), optional HTTP basic auth
- **Auto-updates** — per-image or bulk image updates in production mode with registry-agnostic digest comparison (GHCR + Docker Hub), orchestrator self-replaces
- **Resource limits** — per-environment CPU and memory constraints applied to every worker on that environment (plus a global default)
- **Volume mounts** — bind-mount host directories into workers
- **Persistent workspaces** — workspace data survives container stops, restarts, and archiving via named Docker volumes
- **Worker archiving** — archive workers to free resources while preserving workspace data; unarchive to restore
- **File upload/download** — upload files/folders to running workers or during creation, download workspace as `.tar.gz`
- **Docker-in-Docker** — opt-in per-environment, full Docker daemon inside workers (build, run, compose)
- **Usage monitoring** — real-time usage/rate limit indicators for OAuth-authenticated agents (Claude, Codex, Gemini)
- **Per-worker resource monitoring** — live CPU / RAM / disk / network metrics on each worker card, sourced entirely from the Docker API (OS-independent)
- **Worker export/import** — download a worker as a portable `.tar` bundle (settings, environment, mappings, workspace + agent data, and an optional `docker export` of the filesystem) and restore it as a new worker, even on another machine
- **Centralized logging** — collects logs from all containers (orchestrator, workers, traefik) with NDJSON storage, log rotation, and a live-streaming log viewer in the dashboard
- **Theme toggle** — switch between system default, light, and dark mode
- **API docs** — auto-generated OpenAPI 3.1.0 spec with interactive Scalar UI at `/api/docs`

---

## Quick Start

No need to clone the repo — all images are pulled from GHCR.

```bash
curl -fsSL https://raw.githubusercontent.com/candlelightner/agentor/main/install.sh | bash
```

This downloads `docker-compose.yml` and `.env` into the current directory. Then:

1. `docker compose up -d`
2. Open **http://localhost:3000** and create your admin account
3. Click your name in the sidebar footer → **Account** → fill in API keys / GitHub token, or follow the [Agent login (per user)](#agent-login-per-user) section to sign in via OAuth

`.env` only contains orchestrator-wide settings (logging, Traefik, dashboard auth). All agent API keys, the GitHub token, and any custom env vars are configured per user from the dashboard.

---

## Getting Started (from source)

### Prerequisites

- Docker Engine 24+ with Compose v2

### Configure

1. Copy the example file:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` if you want to override any orchestrator-wide settings (everything works out of the box). All user-scoped secrets — agent API keys, GitHub token, custom env vars — are configured per user from the **Account** modal in the dashboard, not via `.env`.

---

### Development

Development mode mounts the orchestrator source code into the container with hot reload.

1. **Build the worker image locally** (Traefik is pulled from Docker Hub automatically):

   ```bash
   docker build -t agentor-worker:latest ./worker
   ```

2. **Start the dev server:**

   ```bash
   docker compose -f docker-compose.dev.yml up
   ```

3. Open **http://localhost:3000** — you'll be redirected to `/setup` to create the first admin account on a fresh install.

---

### Production

Production mode uses pre-built images from GHCR — no local builds needed.

```bash
docker compose -f docker-compose.prod.yml up -d
```

Open **http://localhost:3000**

> [!NOTE]
> The production compose file sets `WORKER_IMAGE_PREFIX=ghcr.io/candlelightner/` so the orchestrator pulls this fork's worker image from GHCR automatically. Docker will pull images on first container creation.

> [!NOTE]
> The Traefik reverse proxy (`agentor-traefik`) is managed automatically by the orchestrator and handles both port mappings and domain mappings on the same container. It is created when the first port/domain mapping is added (or the dashboard subdomain is configured) and removed when all of those are gone. Mapped ports are arbitrary — no fixed ranges — but `80`/`443` are reserved when domain routing is active.

---

## Agent login (per user)

Each user signs in to their own agent subscriptions and stores their own API keys. There is no shared credential pool — what you log in to is yours, and the same tokens are reused across all of your workers.

### Subscription / OAuth login

Log in once inside any of your workers — the agent CLI writes its OAuth token into your account, and every other worker you create (or restart) inherits it automatically.

| Agent | Command |
|-------|---------|
| **Claude** (Pro/Max) | `claude` → `/login` |
| **Codex** (ChatGPT) | `codex login --device-auth` |
| **Gemini** (Code Assist) | `gemini` → `/auth` |

> [!IMPORTANT]
> OAuth refresh tokens rotate on use. **Always** log in inside a worker — never copy tokens from your local machine, or both copies will desync and break authentication on both sides.

Tokens live at `<DATA_DIR>/users/<your-user-id>/credentials/{claude,codex,gemini}.json` (and Kilo's shared auth at `<DATA_DIR>/users/<your-user-id>/kilo/data/auth.json`). To force a fresh login, click **Reset** next to the agent in **Account → Agent OAuth credentials**. (Kilo is a fourth Account credential row; it has no usage monitoring and no separately installed Kilo CLI — the Kilo Code experience is delivered via the `kilocode.kilo-code@7.4.16` code-server extension preinstalled in the worker image. Kilo's complete `~/.local/share/kilo` data directory — login, provider API keys configured through Kilo's VS Code UI, and Kilo SQLite sessions/history — is shared per user across that user's workers via a directory bind, which is required because Kilo atomically temp+renames `auth.json`.)

### API keys

Open the sidebar footer, click your name, then **Account → API keys & tokens**. Set any of:

- `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `GITHUB_TOKEN` (used for cloning private repos and `gh` inside your workers)

You can also add arbitrary `KEY=value` pairs in **Custom environment variables** — these get exported into every worker you create.

### Custom OpenAI-compatible Codex endpoint

Codex can use a self-hosted gateway, proxy, or load balancer that implements the OpenAI **Responses API**. Codex's user-level `~/.codex/config.toml` is per-worker, so use a custom Environment setup script to distribute the same provider configuration while keeping the API key in the owning user's Account variables.

1. Open **Environments**, click **New** (the built-in Default environment is read-only), and give the environment a name.
2. Paste the script below into **Setup Script**. Replace only `CODEX_MODEL`, `CODEX_BASE_URL`, and optionally `CODEX_API_KEY_ENV`.
3. Under **Account → API keys & tokens**, add the variable named by `CODEX_API_KEY_ENV` with the secret as its value.
4. Select the custom Environment when creating a worker. For an existing worker, assign the Environment and rebuild it.

```bash
#!/bin/bash
set -euo pipefail

CODEX_MODEL="your-model-id-or-stable-alias"
CODEX_BASE_URL="https://api.example.com/v1"
CODEX_API_KEY_ENV="CUSTOM_CODEX_API_KEY"

install -d -m 700 "$HOME/.codex"

tmp_file=$(mktemp "$HOME/.codex/config.toml.XXXXXX")
trap 'rm -f "$tmp_file"' EXIT

cat > "$tmp_file" <<EOF
model = "$CODEX_MODEL"
model_provider = "custom_endpoint"

# Enable only when the endpoint supports the Responses API hosted web-search tool.
web_search = "disabled"

[model_providers.custom_endpoint]
name = "Custom OpenAI-compatible endpoint"
base_url = "$CODEX_BASE_URL"
env_key = "$CODEX_API_KEY_ENV"
wire_api = "responses"
request_max_retries = 4
stream_idle_timeout_ms = 300000

[projects."/workspace"]
trust_level = "trusted"

[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest"]

[mcp_servers.chrome-devtools]
command = "npx"
args = ["-y", "chrome-devtools-mcp@latest"]
EOF

chmod 600 "$tmp_file"
mv "$tmp_file" "$HOME/.codex/config.toml"
trap - EXIT
```

The endpoint must support `/v1/responses`, streaming response events, and tool calls; a Chat-Completions-only endpoint is not sufficient. Custom providers authenticated through `env_key` are not automatically populated from `/v1/models`, so configure a stable model ID or gateway alias. Set `web_search = "live"` only when the endpoint implements the hosted web-search tool; otherwise add a search MCP such as Tavily. For restricted-network Environments, add the endpoint hostname (and any MCP API hostname) to the allowed domains.

> [!NOTE]
> The setup script intentionally manages the complete Codex config on every worker start and retains Agentor's workspace trust plus Playwright and Chrome DevTools MCP defaults. Account variable changes require rebuilding existing workers because container environment variables are fixed at creation time.

---

## Storage

By default, all persistent data lives in `./data/` on the host — easy to browse, back up, and migrate. To use a Docker named volume instead, change the `/data` mount in your compose file:

```yaml
# Directory mode (default):
- ./data:/data

# Volume mode:
- agentor-data:/data
```

The storage mode is auto-detected from the mount type — no env var changes needed. In directory mode, each worker's workspace lives at `./data/users/<userId>/workspaces/<workerId>/` and can be accessed directly from the host.

## Ports

| Port | Binding | Purpose |
|------|---------|---------|
| `3000` | `127.0.0.1` | Web dashboard (includes proxied desktop and editor access) |
| `80`, `443` | `0.0.0.0` | Traefik reverse proxy for domain routing (only when `BASE_DOMAINS` is set) |
| _user-defined_ | `127.0.0.1` or `0.0.0.0` | Traefik TCP port mappings (localhost or external type, one entrypoint per mapping) |

## License

MIT
