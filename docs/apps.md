# Modular App System

Apps run inside worker containers and are managed via `orchestrator/server/utils/apps.ts` (`APP_REGISTRY`). Each app type has a `manage.sh` script in `worker/apps/<id>/` that implements a small shell interface — `start <id> <port> [extraArgs…]`, `stop <id>`, `list` — and emits NDJSON on stdout. The orchestrator reads that output via `docker exec` and the generic `/api/containers/:id/apps/*` endpoints.

## `AppType` fields

Every entry in `APP_REGISTRY` has:

- **`id`**, **`displayName`**, **`description`** — registry identity.
- **`ports: AppPort[]`** — zero or more port-range definitions. Entry `0` drives the port selector / label in the UI. For apps with `fixedInternalPort` the range is collapsed to a single port.
- **`maxInstances`** — upper bound for non-singleton apps (e.g. chromium caps at 10). Ignored when `singleton: true`.
- **`manageScript`** — path relative to `/home/agent/apps/` inside the worker.
- **`singleton?: boolean`** — only one instance can run; the instance id is always the app-type id (`'vscode'`, `'vscode-desktop'`, `'ssh'`) so restarts reuse the same row + port mapping. Starting while one is running returns HTTP **409**.
- **`fixedInternalPort?: number`** — when set, the orchestrator skips the port-range scan and always passes this port to `manage.sh start`. Used by the SSH app (internal port is hard-coded to 22).
- **`autoPortMapping?: { type, externalPortStart, externalPortEnd }`** — when set, starting the app also allocates a port mapping in `[externalPortStart, externalPortEnd]` and writes it to the port-mapping store with `appType` + `instanceId`. If the store already has a matching `(containerName, appType, instanceId)` mapping, it is reused — external port stays stable across stop/start/restart/rebuild.

## `manage.sh` interface

Every script must implement the same CLI. Stdout is NDJSON (one JSON object per line); a non-zero exit code plus an `{"status":"error","message":"…"}` line signal failure.

```
manage.sh start <id> <port> [extra args…]   # emit {"id","port","status":"running", …}
manage.sh stop  <id>                        # emit {"id","status":"stopped"} (idempotent)
manage.sh list                              # emit zero or more {"id","port","status", …} lines
```

Optional per-app fields on `list`:

- `machineName` (vscode) — the Microsoft tunnel machine name once connected.
- `authUrl`, `authCode` (vscode) — shown while the tunnel is in `auth_required` state.
- `externalPort` (populated server-side from the port-mapping store, not by manage.sh).

## Current Apps

| id | Kind | Internal port | Auto port mapping | Extra args |
|----|------|---------------|-------------------|------------|
| `chromium` | multi (max 10) | 9222–9322 | — | — |
| `socks5`   | multi (max 10) | 1080–1180 | — | — |
| `vscode`   | singleton      | — (`0`)   | — | Microsoft tunnel name (userId-prefixed, ≤ 20 chars) |
| `ssh`      | singleton      | 22 (fixed) | ext 22000–22999 (`type: external`) | — |
| `vscode-desktop` | singleton | — (`0`) | — | — |

The VS Code tunnel and SSH apps used to be separate features with dedicated UI and API routes; they are now regular apps rendered in the Apps pane via specialised row components (`VsCodeAppRow.vue`, `SshAppRow.vue`).

## Plugins in the Apps area

Plugins are not `APP_REGISTRY` entries: they are separately versioned,
scope-aware definitions installed into a specific worker. The Apps area opens a
plugin catalog and per-worker plugin pane for definition management and the
installation lifecycle. A definition declares bounded argv lifecycle commands,
resources, named environment/secret references, optional agent guidance, and
optional private UI actions; it cannot declare a public port mapping.

The worker image ships the constrained plugin runner as part of its build, so
updating the runner requires the normal worker-image update and worker rebuild
to reach existing workers. Desired installations reconcile after worker
create/start/restart/rebuild and are tied to the current container generation.
Private actions open only through the authenticated sandboxed plugin UI proxy
to their declared worker port/path. See [Plugins](plugins.md) for the full
security, lifecycle, backup-path, and portability model.

## Adding a New App

1. Add an entry to `APP_REGISTRY` in `orchestrator/server/utils/apps.ts`.
2. Create `worker/apps/<id>/manage.sh` implementing the NDJSON interface above.
3. Install any binaries in `worker/Dockerfile`.
4. (Optional) Add a specialised row component in `orchestrator/app/components/` and dispatch it from `AppsPane.vue` (`rowComponentFor`).
5. (Optional) Register the app's outbound domains in `orchestrator/server/utils/agent-config.ts` so the network firewall allowlist covers them in restricted modes.

## SSH app details

- Uses `openssh-server` with `StrictModes no` (bind-mount file ownership is irrelevant) and `PubkeyAuthentication yes`, `PasswordAuthentication no`. Only the `agent` user is allowed in.
- The authorized_keys file comes from the worker owner's **Account → SSH Access** textarea. The key is NOT an env var — it is managed via the dedicated `GET`/`PUT /api/account/ssh-key` endpoint pair (backed by `StorageManager.readSshAuthorizedKeys`/`writeSshAuthorizedKeys`), which writes it to `<DATA_DIR>/users/<userId>/ssh/authorized_keys` (its only home). Every worker bind-mounts that file read-only at `/home/agent/.ssh/authorized_keys` — so updating the key in the dashboard is visible to every running SSH instance immediately.
- Port mapping is created on Start (type `external`, external port in `22000–22999`) and kept across stop/start/rebuild/archive/unarchive. It is only removed when the worker is permanently deleted.

## Persistent VS Code app details

- A singleton app (`vscode-desktop`) that launches a Chromium **app-mode** client pointed at the local code-server (already running on port 8443) under the existing Xvfb/noVNC display stack. It exposes **no container or external port** — it is only reachable by opening the **Desktop** pane.
- It uses a persistent browser profile stored in the agent-data volume so browser cookies/preferences survive restarts; code-server extension/UI state persists separately in its per-worker user-data directory.
- It reuses code-server + the existing Chromium — **no Kilo source is patched and no desktop VS Code package is installed**.
- **Disconnecting the viewer is non-destructive:** closing the external browser tab or the noVNC Desktop pane only disconnects the *viewer* — the Chromium client, the in-browser VS Code client, the Kilo panel, and any active Kilo agent work all keep running. This is the key difference from the regular Editor iframe pane, where by Kilo's design **disposing/closing Kilo's VS Code panel can abort active Kilo sessions**.
- **What stops the persistent client:** an explicit app **Stop**, closing its X window on the desktop, worker stop/rebuild/archive/delete, a client crash, or a VPS restart.
- It is **not auto-started** — the operator starts it explicitly from the Apps pane (singleton `Start` button shown when no instance is running, Stop lives on the row once running). A successful Start automatically opens the worker's Desktop pane; failures are shown as a dashboard toast.
- Persistent VS Code continues to use noVNC and now benefits from the keyboard-transparent clipboard paste bridge: because a successful Start auto-opens the Desktop pane (which loads `agentor.html`), host-clipboard images/text reach the in-desktop VS Code via the same X11 CLIPBOARD sync + paste-key replay. See `docs/ui.md` → **Keyboard-transparent clipboard paste**.
