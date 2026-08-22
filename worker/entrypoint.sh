#!/bin/bash
set -e

# --- Timing helpers ---
# Uses millisecond-precision timestamps via /proc/uptime (no external deps)
_ms() {
    local up
    read -r up _ < /proc/uptime
    echo "${up/./}"
}
BOOT_MS=$(_ms)
_elapsed() {
    echo $(( $(_ms) - BOOT_MS ))
}
_log() {
    echo "[+$(_elapsed)ms] $*"
}

# --- Status display (event-based, rendered by loading-screen.sh) ---
# Events are appended to /tmp/worker-events. The loading screen script
# reads this file every frame and renders an animated status display.
STEP_START_MS=0
_boot() {
    echo "BOOT|$(_ms)" > /tmp/worker-events
}
_total() {
    echo "TOTAL|$1" >> /tmp/worker-events
}
_step() {
    STEP_START_MS=$(_ms)
    echo "$1|active|$2" >> /tmp/worker-events
}
_done() {
    local elapsed=$(( $(_ms) - STEP_START_MS ))
    echo "$1|done|$2|$elapsed" >> /tmp/worker-events
}
_skip() {
    echo "$1|skip|$2" >> /tmp/worker-events
}
_warn() {
    local elapsed=$(( $(_ms) - STEP_START_MS ))
    echo "$1|warn|$2|$elapsed" >> /tmp/worker-events
}
_ready() {
    echo "READY|" >> /tmp/worker-events
}

# Capture the server-provisioned runtime role before ENVIRONMENT.envVars or
# worker-local values are exported. Only these three internal values exist;
# missing or invalid values fail closed to the ordinary-worker role.
case "${AGENTOR_RUNTIME_ROLE:-worker}" in
    platform-admin|group-admin|worker)
        AGENTOR_TRUSTED_RUNTIME_ROLE="$AGENTOR_RUNTIME_ROLE"
        ;;
    *)
        AGENTOR_TRUSTED_RUNTIME_ROLE="worker"
        ;;
esac
readonly AGENTOR_TRUSTED_RUNTIME_ROLE

# --- Helper: wait for file/socket to appear ---
wait_for_file() {
    local path="$1" max_tries="${2:-100}"
    local i=0
    while [ ! -e "$path" ] && [ $i -lt $max_tries ]; do
        sleep 0.05
        i=$((i + 1))
    done
}

# --- Helper: wait for a TCP port to start listening ---
wait_for_port() {
    local port="$1" max_tries="${2:-100}"
    local i=0
    while ! netstat -tln 2>/dev/null | grep -q ":${port} " && [ $i -lt $max_tries ]; do
        sleep 0.05
        i=$((i + 1))
    done
    [ $i -lt $max_tries ]
}

# ==========================================================================
# Phase 0: Create tmux session with animated loading screen
# All phases run foreground and sequentially. The loading screen renders
# real-time progress with spinner animation. The pane is replaced with a
# clean shell + init script only after everything is fully ready.
# ==========================================================================
WINDOW_NAME="main"
_boot
_total 10
tmux new-session -d -s main -n "$WINDOW_NAME" -c /workspace \
    "bash /home/agent/loading-screen.sh"
tmux set -g mouse on
tmux set -g status off
tmux set -g extended-keys on
tmux set -s terminal-features 'xterm*:extkeys'
tmux bind-key -n S-Enter send-keys Escape '[13;2u'
tmux set-option -w -t "main:$WINDOW_NAME" automatic-rename off
_log "Tmux: ready"

# ==========================================================================
# Phase 0a: Persistent agent config (symlinks to .agent-data volume)
# The orchestrator mounts a persistent volume at ~/.agent-data. We symlink
# each agent's config directory so history, MCP servers, memory, plugins,
# etc. survive container restarts, rebuilds, and archive/unarchive cycles.
# ==========================================================================
AGENT_DATA=/home/agent/.agent-data
if [ -d "$AGENT_DATA" ]; then
    # Fix ownership (Docker may create subdirs as root for credential bind mounts)
    sudo chown -R agent:agent "$AGENT_DATA"

    # Ensure subdirectories exist in the per-worker volume. Kilo's config and
    # shared-data are overlaid by per-user bind mounts (config = global config,
    # shared-data = auth + sessions + history shared across this user's
    # workers). state/cache stay private to this worker.
    mkdir -p "$AGENT_DATA"/{.claude,.gemini,.codex,.agents,.vscode,.code-server}
    mkdir -p "$AGENT_DATA/.kilo"/{config,shared-data,state,cache}
    chmod 700 "$AGENT_DATA/.code-server" "$AGENT_DATA/.kilo" "$AGENT_DATA/.kilo"/{config,shared-data,state,cache}

    # Symlink agent config dirs to persistent volume
    for dir in .claude .gemini .codex .agents .vscode; do
        target="/home/agent/$dir"
        if [ -e "$target" ] && [ ! -L "$target" ]; then
            rm -rf "$target"
        fi
        ln -sfn "$AGENT_DATA/$dir" "$target"
    done

    # --- One-time migration of legacy per-worker `.kilo/data` into the shared
    # --- `.kilo/shared-data` bind. The first worker to start under a user
    # --- populates the shared auth + DB/history; later legacy workers only add
    # --- missing top-level entries to auth.json without overwriting what is
    # --- already shared. A marker records a completed migration so it does not
    # --- run again once shared-data is canonical. Guarded by a flock inside the
    # --- shared-data dir so concurrent worker starts do not race. Malformed
    # --- legacy JSON is left in place (no marker) so the next boot retries;
    # --- worker startup never aborts on it (the whole block is wrapped so any
    # --- unexpected error degrades to a warning, not a failed boot).
    KILO_SHARED="$AGENT_DATA/.kilo/shared-data"
    KILO_LEGACY="$AGENT_DATA/.kilo/data"
    KILO_WORKER_JSON="${WORKER:-}"
    [ -n "$KILO_WORKER_JSON" ] || KILO_WORKER_JSON='{}'
    KILO_WORKER_ID=$(printf '%s' "$KILO_WORKER_JSON" | jq -r '.id // "legacy"' 2>/dev/null || echo legacy)
    [[ "$KILO_WORKER_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || KILO_WORKER_ID=legacy
    KILO_MIGRATE_MARKER="$KILO_SHARED/.migrated-worker-$KILO_WORKER_ID"
    (
        set +e
        flock -x 9 || { echo "[kilo] WARNING: migration lock failed — skipping"; exit 0; }
        if [ -e "$KILO_MIGRATE_MARKER" ]; then
            : # this worker's legacy data was already migrated
        elif [ -d "$KILO_LEGACY" ]; then
            _log "Kilo: migrating per-worker .kilo/data into shared-data"
            # Copy DB/history/session files that are not auth.json verbatim.
            # These are preserved from the first migrating worker only; later
            # legacy workers may still carry them but shared-data already owns
            # them, so we do not overwrite.
            find "$KILO_LEGACY" -mindepth 1 -maxdepth 1 \
                ! -name auth.json ! -name .migrate.lock ! -name '.migrated-worker-*' -print0 2>/dev/null \
                | while IFS= read -r -d '' entry; do
                    name=$(basename "$entry")
                    if [ ! -e "$KILO_SHARED/$name" ]; then
                        cp -a "$entry" "$KILO_SHARED/$name" 2>/dev/null || true
                    fi
                done

            # Merge auth.json: take the shared file as the base and add any
            # top-level keys from the legacy file that are missing. Never
            # overwrite an existing shared entry. Returns 0 on success, 2 on
            # malformed JSON (legacy or shared). Safe against malformed JSON.
            merge_auth() {
                if [ ! -f "$KILO_LEGACY/auth.json" ]; then
                    return 0
                fi
                if [ ! -f "$KILO_SHARED/auth.json" ]; then
                    echo '{}' > "$KILO_SHARED/auth.json"
                    chmod 600 "$KILO_SHARED/auth.json"
                fi
                python3 - "$KILO_LEGACY/auth.json" "$KILO_SHARED/auth.json" <<'PY'
import json, sys, os
legacy_path, shared_path = sys.argv[1], sys.argv[2]
def load(p):
    try:
        with open(p, 'r', encoding='utf-8') as f:
            raw = f.read().strip()
        if not raw:
            return {}
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return None  # malformed — refuse to touch shared
legacy = load(legacy_path)
if legacy is None:
    sys.exit(2)  # malformed legacy — leave shared untouched
shared = load(shared_path)
if shared is None:
    sys.exit(2)  # malformed shared — do not overwrite
changed = False
for k, v in legacy.items():
    if k not in shared:
        shared[k] = v
        changed = True
if changed:
    tmp = shared_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(shared, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, shared_path)
PY
            }

            if merge_auth; then
                chmod 600 "$KILO_SHARED/auth.json" 2>/dev/null || true
                # Remove the legacy per-worker Kilo data so secret/export leakage
                # cannot happen via the leftover per-worker copy.
                rm -rf "$KILO_LEGACY" 2>/dev/null || true
                touch "$KILO_MIGRATE_MARKER"
                chmod 600 "$KILO_MIGRATE_MARKER" 2>/dev/null || true
                _log "Kilo: migration complete"
            else
                # Malformed JSON or another merge failure — leave the legacy
                # dir in place so secrets are not lost; do not set the marker
                # so the next boot retries. Shared auth is untouched.
                _log "Kilo: auth.json merge failed — legacy data preserved, will retry next boot"
            fi
        else
            touch "$KILO_MIGRATE_MARKER"
            chmod 600 "$KILO_MIGRATE_MARKER" 2>/dev/null || true
        fi
    ) 9>"$KILO_SHARED/.migrate.lock"
    chmod 600 "$KILO_SHARED/.migrate.lock" 2>/dev/null || true

    # Kilo follows XDG paths. config is overlaid by the shared global config
    # bind; shared-data carries auth + sessions + history (shared per user);
    # state/cache stay per-worker.
    for mapping in \
        ".config/kilo:config" \
        ".local/share/kilo:shared-data" \
        ".local/state/kilo:state" \
        ".cache/kilo:cache"; do
        target="/home/agent/${mapping%%:*}"
        kilo_dir="${mapping#*:}"
        mkdir -p "$(dirname "$target")"
        if [ -e "$target" ] && [ ! -L "$target" ]; then
            rm -rf "$target"
        fi
        ln -sfn "$AGENT_DATA/.kilo/$kilo_dir" "$target"
    done

    # ~/.claude.json (MCP servers, preferences — separate file outside ~/.claude/)
    # Tools doing atomic writes (temp+rename) replace the symlink with a regular file.
    # On restart, sync the regular file back to the volume before re-creating the symlink.
    # Only sync if the volume already has the file (skip on first start to avoid copying
    # the image's install-time file over the empty volume).
    if [ -f "$AGENT_DATA/.claude.json" ] && [ -e /home/agent/.claude.json ] && [ ! -L /home/agent/.claude.json ] && [ -s /home/agent/.claude.json ]; then
        cp /home/agent/.claude.json "$AGENT_DATA/.claude.json"
    fi
    if [ ! -f "$AGENT_DATA/.claude.json" ]; then
        echo '{}' > "$AGENT_DATA/.claude.json"
    fi
    if [ -e /home/agent/.claude.json ] && [ ! -L /home/agent/.claude.json ]; then
        rm -f /home/agent/.claude.json
    fi
    ln -sfn "$AGENT_DATA/.claude.json" /home/agent/.claude.json

    _log "Agent data: symlinks created"
fi

# ==========================================================================
# Phase 0b: Export env vars from structured JSON payloads
# EXPOSE_* flags are needed by capabilities at runtime; custom env vars from the
# environment config are exported so they're available in all subsequent phases.
# ==========================================================================
# An exposeApis flag defaults to true when the environment leaves it unset.
expose_flag() {
    echo "$ENVIRONMENT" | jq -r "if .exposeApis.$1 == null then true else .exposeApis.$1 end"
}
export EXPOSE_PORT_MAPPINGS=$(expose_flag portMappings)
export EXPOSE_DOMAIN_MAPPINGS=$(expose_flag domainMappings)
export EXPOSE_USAGE=$(expose_flag usage)
tmux set-environment -g EXPOSE_PORT_MAPPINGS "$EXPOSE_PORT_MAPPINGS"
tmux set-environment -g EXPOSE_DOMAIN_MAPPINGS "$EXPOSE_DOMAIN_MAPPINGS"
tmux set-environment -g EXPOSE_USAGE "$EXPOSE_USAGE"

# Export custom env vars from ENVIRONMENT.envVars
ENV_VARS=$(echo "$ENVIRONMENT" | jq -r '.envVars // ""')
while IFS= read -r line; do
    trimmed=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
    case "${trimmed%%=*}" in
        AGENTOR_RUNTIME_ROLE|AGENTOR_TRUSTED_RUNTIME_ROLE) continue ;;
    esac
    [[ "$trimmed" == *=* ]] && export "$trimmed" && tmux set-environment -g "${trimmed%%=*}" "${trimmed#*=}"
done <<< "$ENV_VARS"

# Worker-local values are baked into the container only on create/rebuild and
# intentionally applied after broader environment values, so the documented
# precedence is orchestrator < user < environment < worker. The payload is
# base64 JSON to preserve whitespace and '=' without shell parsing ambiguity.
if [[ -n "${WORKER_LOCAL_ENV:-}" ]]; then
    while IFS= read -r encoded; do
        key=$(printf '%s' "$encoded" | base64 -d | jq -r '.key')
        value=$(printf '%s' "$encoded" | base64 -d | jq -r '.value')
        case "$key" in
            AGENTOR_RUNTIME_ROLE|AGENTOR_TRUSTED_RUNTIME_ROLE) continue ;;
        esac
        export "$key=$value"
        tmux set-environment -g "$key" "$value"
    done < <(printf '%s' "$WORKER_LOCAL_ENV" | base64 -d | jq -r '.[] | @base64')
fi

# Secret-bearing workers fail closed until the orchestrator has delivered
# write-only values over Docker exec stdin and populated the tmpfs. The daemon
# restart policy is disabled for these workers, so this bounded wait is only
# entered during an orchestrator-controlled create/rebuild/restart.
if [[ "${WORKER_SECRET_HANDSHAKE:-}" == "1" ]]; then
    for _ in $(seq 1 300); do
        if [[ -f /run/agentor-secrets/.ready ]] \
          && [[ "$(stat -c '%u:%a' /run/agentor-secrets/.ready 2>/dev/null)" == "0:444" ]] \
          && [[ "$(cat /run/agentor-secrets/.ready 2>/dev/null)" == "agentor-secret-bootstrap-v1" ]]; then
            break
        fi
        sleep 0.1
    done
    if [[ ! -f /run/agentor-secrets/.ready ]] \
      || [[ "$(stat -c '%u:%a' /run/agentor-secrets/.ready 2>/dev/null)" != "0:444" ]] \
      || [[ "$(cat /run/agentor-secrets/.ready 2>/dev/null)" != "agentor-secret-bootstrap-v1" ]]; then
        echo "[agent] ERROR: worker secret bootstrap did not complete" >&2
        exit 70
    fi
fi

# ==========================================================================
# Phase 1: Agent setup
# Each setup script creates config files only if they don't exist yet.
# Once created, files are never overwritten — the user owns them.
# ==========================================================================
_step agents "Agent setup"
_log "Agent setup: start"
for setup_script in /home/agent/agents/*/setup.sh; do
    if [ -x "$setup_script" ]; then
        AGENT_NAME=$(basename "$(dirname "$setup_script")")
        "$setup_script" || echo "[agent] Warning: $AGENT_NAME setup failed, continuing"
    fi
done

# Role guidance is Agentor-owned and reconciled on every boot. This is
# intentionally separate from environment-selectable capabilities: only the
# current role is installed, stale cross-role files are removed, and all other
# skills remain untouched.
source /home/agent/agents/common.sh
reconcile_role_skill "$AGENTOR_TRUSTED_RUNTIME_ROLE" \
    || echo "[agent] Warning: runtime role skill setup failed, continuing"

reconcile_worker_self_mcp \
    || echo "[agent] Warning: worker-self MCP setup failed, continuing"

# The trusted administrative overlay is the only worker attached to the
# management network. Advertise its internal MCP to Codex through a stdio
# bridge which reads the current short-lived credential from tmpfs on every
# request. Preserve all user-owned Codex configuration and add only this
# generated section when it is absent.
if [[ "${AGENTOR_ADMIN_WORKSPACE:-}" == "1" ]]; then
    CODEX_CONFIG="/home/agent/.codex/config.toml"
    mkdir -p "$(dirname "$CODEX_CONFIG")"
    touch "$CODEX_CONFIG"
    if ! grep -q '^\[mcp_servers\.agentor-management\]$' "$CODEX_CONFIG"; then
        cat >> "$CODEX_CONFIG" <<'EOF'

# Generated for the trusted Agentor administrative workspace.
[mcp_servers.agentor-management]
command = "/usr/local/bin/agentor-management-mcp"
EOF
    fi
    tmux set-environment -g AGENTOR_MANAGEMENT_MCP_URL \
      "${AGENTOR_MANAGEMENT_MCP_URL:-http://agentor-orchestrator:3099/mcp}"
fi

_done agents "Agent setup"
_log "Agent setup: done"

# ==========================================================================
# Phase 2: Docker daemon (DinD, opt-in)
# ==========================================================================
DOCKER_ENABLED=$(echo "$ENVIRONMENT" | jq -r '.dockerEnabled // false')
if [ "$DOCKER_ENABLED" = "true" ]; then
    _step docker "Docker daemon"
    _log "DinD: starting dockerd..."
    sudo find /run /var/run -iname 'docker*.pid' -delete 2>/dev/null || true
    sudo find /run /var/run -path '*/containerd*' -delete 2>/dev/null || true
    sudo rm -rf /var/run/docker /var/run/docker.sock 2>/dev/null || true
    sudo mkdir -p /var/lib/docker /etc/docker
    sudo tee /etc/docker/daemon.json > /dev/null <<'DOCKERCONF'
{
    "storage-driver": "overlay2",
    "iptables": true,
    "ip-forward": true,
    "log-driver": "json-file",
    "log-opts": { "max-size": "10m", "max-file": "3" }
}
DOCKERCONF
    # Mirror dockerd output to both /tmp/dockerd.log (for in-container
    # debugging) and the container's stdout (so the orchestrator's log
    # collector captures it). The "[dockerd] " prefix tags entries so they
    # are distinguishable from other entrypoint output.
    ( sudo dockerd 2>&1 | stdbuf -oL -eL sed -u 's/^/[dockerd] /' | tee -a /tmp/dockerd.log ) &
    tries=300  # 300 * 0.1s = 30s (matches the "within 30s" warn message below)
    while [ ! -S /var/run/docker.sock ] && [ $tries -gt 0 ]; do
        sleep 0.1
        tries=$((tries - 1))
    done
    if [ -S /var/run/docker.sock ]; then
        if [ -n "$GITHUB_TOKEN" ]; then
            echo "$GITHUB_TOKEN" | docker login ghcr.io -u agent --password-stdin > /dev/null 2>&1 \
                || echo "[docker] Warning: GHCR login failed, continuing"
        fi
        _done docker "Docker daemon"
        _log "DinD: dockerd ready"
    else
        _warn docker "Docker daemon (failed to start)"
        _log "DinD: WARNING — dockerd failed to start within 30s"
    fi
else
    _skip docker "Docker daemon"
fi

# ==========================================================================
# Phase 3: Display stack (Xvfb + fluxbox + x11vnc + noVNC)
# ==========================================================================
_step display "Display stack"
_log "Display: starting..."
# Clean stale state from previous container runs (lock files persist across restarts)
sudo rm -f /tmp/.X99-lock
sudo rm -rf /tmp/.X11-unix
sudo mkdir -p /tmp/.X11-unix && sudo chmod 1777 /tmp/.X11-unix
pkill -f Xvfb 2>/dev/null || true
pkill -f x11vnc 2>/dev/null || true
pkill -f fluxbox 2>/dev/null || true
pkill -f websockify 2>/dev/null || true
Xvfb :99 -screen 0 1920x1080x24 -ac &
wait_for_file /tmp/.X11-unix/X99
xrdb -merge /home/agent/.Xresources 2>/dev/null || true
fluxbox &
x11vnc -display :99 -nopw -shared -forever -rfbport 5900 -cursor most -xkb -noxdamage &
wait_for_port 5900 || _log "Display: WARNING — x11vnc (5900) not listening"
websockify --web /usr/share/novnc/ 6080 localhost:5900 &
# Verify the browser-facing noVNC endpoint actually came up, not just x11vnc —
# if websockify died the desktop pane would be dead while the step showed ✓.
if wait_for_port 6080; then
    _done display "Display stack"
    _log "Display: ready"
else
    _warn display "Display stack (noVNC not ready)"
    _log "Display: WARNING — websockify (6080) failed to start"
fi

# ==========================================================================
# Phase 3b: Code editor (code-server)
# ==========================================================================
_step editor "Code editor"
_log "Code-server: starting..."
( code-server --auth none --bind-addr 0.0.0.0:8443 --disable-telemetry \
    --user-data-dir "$AGENT_DATA/.code-server" \
    --extensions-dir /home/agent/.local/share/code-server/extensions \
    /workspace 2>&1 | stdbuf -oL -eL sed -u 's/^/[code-server] /' | tee -a /tmp/code-server.log ) &
if wait_for_port 8443; then
    _done editor "Code editor"
    _log "Code-server: ready"
else
    _warn editor "Code editor (not ready)"
    _log "Code-server: WARNING — port 8443 not listening"
fi

# ==========================================================================
# Phase 4: Git identity + auth
# Sets global git user from the creating user's profile (name/email from
# the WORKER JSON). Credential helper requires GITHUB_TOKEN.
# ==========================================================================
GIT_USER_NAME=$(echo "$WORKER" | jq -r '.gitName // ""')
GIT_USER_EMAIL=$(echo "$WORKER" | jq -r '.gitEmail // ""')

if [ -n "$GIT_USER_NAME" ] || [ -n "$GIT_USER_EMAIL" ] || [ -n "$GITHUB_TOKEN" ]; then
    _step git "Git configuration"
    _log "Git config: start"
    if [ -n "$GIT_USER_NAME" ]; then
        git config --global user.name "$GIT_USER_NAME"
        _log "Git config: user.name=$GIT_USER_NAME"
    fi
    if [ -n "$GIT_USER_EMAIL" ]; then
        git config --global user.email "$GIT_USER_EMAIL"
        _log "Git config: user.email=$GIT_USER_EMAIL"
    fi
    if [ -n "$GITHUB_TOKEN" ]; then
        export GH_TOKEN="$GITHUB_TOKEN"
        git config --global credential.https://github.com.helper '!gh auth git-credential'
        git config --global url."https://github.com/".insteadOf "git@github.com:"
        _log "Git config: credential helper configured"
    fi
    _done git "Git configuration"
    _log "Git config: done"
else
    _skip git "Git configuration"
fi

# ==========================================================================
# Phase 5: Clone repos (parallel per repo, wait for all)
# ==========================================================================
clone_repo() {
    local PROVIDER="$1"
    local URL="$2"
    local BRANCH="$3"
    local REPO_NAME
    REPO_NAME=$(basename "$URL" .git)

    if [ -d "/workspace/$REPO_NAME" ]; then
        echo "Directory /workspace/$REPO_NAME already exists, skipping clone"
        return
    fi

    local CLONE_ARGS=()
    if [ -n "$BRANCH" ]; then
        CLONE_ARGS+=("--branch" "$BRANCH")
    fi

    case "$PROVIDER" in
        github)
            # Only forward `-- --branch X` to the underlying git clone when a
            # branch is set — a trailing bare `--` is fragile across gh versions.
            local gh_extra=()
            [ -n "$BRANCH" ] && gh_extra=(-- --branch "$BRANCH")
            # `return 1` on failure so the caller's `wait` sees a non-zero exit
            # and records the repo in FAILED_REPOS (otherwise the echo's exit 0
            # masks the failure and clones silently appear to succeed).
            gh repo clone "$URL" "/workspace/$REPO_NAME" "${gh_extra[@]}" 2>&1 || {
                echo "Failed to clone $URL via gh, skipping"
                return 1
            }
            ;;
        *)
            git clone "${CLONE_ARGS[@]}" "$URL" "/workspace/$REPO_NAME" 2>&1 || {
                echo "Failed to clone $URL, skipping"
                return 1
            }
            ;;
    esac
}

REPOS_JSON=$(echo "$WORKER" | jq -r '.repos // empty')
if [ -n "$REPOS_JSON" ] && [ "$REPOS_JSON" != "null" ] && [ "$(echo "$REPOS_JSON" | jq 'length')" -gt 0 ]; then
    _step repos "Cloning repositories"
    _log "Repo clone: start"
    CLONE_PIDS=()
    CLONE_URLS=()
    REPO_COUNT=0
    while IFS= read -r repo; do
        PROVIDER=$(echo "$repo" | jq -r '.provider // "github"')
        URL=$(echo "$repo" | jq -r '.url')
        BRANCH=$(echo "$repo" | jq -r '.branch // empty')
        clone_repo "$PROVIDER" "$URL" "$BRANCH" &
        CLONE_PIDS+=($!)
        CLONE_URLS+=("$URL")
        REPO_COUNT=$((REPO_COUNT + 1))
    done < <(echo "$REPOS_JSON" | jq -c '.[]')
    FAILED_REPOS=()
    for i in "${!CLONE_PIDS[@]}"; do
        if ! wait "${CLONE_PIDS[$i]}" 2>/dev/null; then
            FAILED_REPOS+=("${CLONE_URLS[$i]}")
        fi
    done
    if [ ${#FAILED_REPOS[@]} -gt 0 ]; then
        _warn repos "Cloned $REPO_COUNT repositories (${#FAILED_REPOS[@]} failed)"
        for failed_url in "${FAILED_REPOS[@]}"; do
            _log "Repo clone: FAILED — $failed_url"
        done
    else
        _done repos "Cloned $REPO_COUNT repositories"
    fi
    _log "Repo clone: done"
else
    _skip repos "Repository clone"
fi

# ==========================================================================
# Phase 6: Network Firewall (dnsmasq + ipset + iptables)
# Activates after all network operations are done.
# ==========================================================================
FIREWALL_MODE=$(echo "$ENVIRONMENT" | jq -r '.networkMode // "full"')

if [ "$FIREWALL_MODE" != "full" ]; then
    _step firewall "Network firewall"
    _log "Firewall: start ($FIREWALL_MODE)"

    sudo iptables -P OUTPUT DROP
    sudo iptables -A OUTPUT -o lo -j ACCEPT
    sudo iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
    sudo iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
    sudo iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
    sudo iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

    ALLOWED_DOMAINS=$(echo "$ENVIRONMENT" | jq -r '.allowedDomains // empty')

    if [ "$FIREWALL_MODE" = "block-all" ]; then
        _done firewall "Network firewall (block-all)"
        _log "Firewall: block-all — all outbound blocked"
    elif [ "$FIREWALL_MODE" = "block" ] && { [ -z "$ALLOWED_DOMAINS" ] || [ "$ALLOWED_DOMAINS" = "null" ] || [ "$(echo "$ALLOWED_DOMAINS" | jq 'length')" -eq 0 ]; }; then
        _done firewall "Network firewall (block)"
        _log "Firewall: block — all outbound blocked"
    else
        sudo ipset create allowed_ips hash:ip timeout 0 2>/dev/null || true

        DNSMASQ_CONF="/etc/dnsmasq.d/firewall.conf"
        sudo mkdir -p /etc/dnsmasq.d

        sudo tee "$DNSMASQ_CONF" > /dev/null <<'DNSCONF'
# Agentor network firewall — DNS-based filtering
no-resolv
listen-address=127.0.0.53
bind-interfaces
# Forward all DNS to Docker's internal DNS resolver
server=127.0.0.11
DNSCONF

        if [ -n "$ALLOWED_DOMAINS" ] && [ "$ALLOWED_DOMAINS" != "null" ]; then
            while IFS= read -r domain; do
                domain=$(echo "$domain" | sed 's/^\*\././')
                echo "ipset=/${domain}/allowed_ips" | sudo tee -a "$DNSMASQ_CONF" > /dev/null
            done < <(echo "$ALLOWED_DOMAINS" | jq -r '.[]')
        fi

        sudo systemctl stop dnsmasq 2>/dev/null || sudo killall dnsmasq 2>/dev/null || true
        sudo dnsmasq --conf-dir=/etc/dnsmasq.d --no-daemon --log-facility=/dev/null &

        DOMAIN_COUNT=$(echo "$ALLOWED_DOMAINS" | jq -r 'length' 2>/dev/null || echo 0)
        # Only point resolv.conf at dnsmasq once it has actually bound :53.
        # If it failed to start, rewriting resolv.conf to a dead resolver would
        # blackhole ALL DNS in the container — warn and leave DNS working instead.
        if wait_for_port 53; then
            echo "nameserver 127.0.0.53" | sudo tee /etc/resolv.conf > /dev/null
            sudo iptables -A OUTPUT -m set --match-set allowed_ips dst -j ACCEPT
            _done firewall "Network firewall ($DOMAIN_COUNT domains)"
            _log "Firewall: dnsmasq + ipset active — $DOMAIN_COUNT domains"
        else
            _warn firewall "Network firewall (dnsmasq failed — DNS left intact)"
            _log "Firewall: WARNING — dnsmasq failed to bind :53; skipping resolv.conf swap to avoid blackholing DNS"
        fi
    fi
else
    _skip firewall "Network firewall"
fi

# ==========================================================================
# Phase 7: User setup script
# Runs after firewall activation, before agent launch.
# ==========================================================================
SETUP_SCRIPT=$(echo "$ENVIRONMENT" | jq -r '.setupScript // ""')
if [ -n "$SETUP_SCRIPT" ]; then
    _step setup "Setup script"
    _log "Setup script: start"
    /home/agent/setup.sh 2>&1 || echo "[setup] Warning: setup script exited with error"
    _done setup "Setup script"
    _log "Setup script: done"
else
    _skip setup "Setup script"
fi

# ==========================================================================
# Phase 8: Launch — replace loading screen with clean shell + init script
# Everything is fully ready. Replace the loading indicator and hand over
# control to the user / agent. This is the last action in the entrypoint.
# ==========================================================================
_ready
sleep 0.6

# Configure pane persistence — respawn a clean shell on exit (never re-run init script)
tmux set-option -w -t "main:$WINDOW_NAME" remain-on-exit on
tmux set-hook -t main pane-died \
    "if-shell -F '#{==:#{window_name},main}' 'respawn-pane -k -c /workspace bash'"

# Replace loading screen with init.sh (runs init script or falls back to bash)
tmux respawn-pane -k -t "main:$WINDOW_NAME" -c /workspace "bash /home/agent/init.sh"

_log "Startup complete"

# Keep container alive
exec tail -f /dev/null
