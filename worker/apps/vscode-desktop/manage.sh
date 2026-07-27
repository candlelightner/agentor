#!/bin/bash
# Persistent VS Code (code-server client in a noVNC-attached Chromium window) —
# called via docker exec.
# Usage: manage.sh start <id> <port>   (port is always 0; the app exposes none)
#        manage.sh stop <id>
#        manage.sh list
#
# Singleton app: id is always "vscode-desktop". It launches the image's existing
# Chromium under DISPLAY=:99 in app mode pointed at the local code-server
# (http://127.0.0.1:8443/?folder=/workspace), with a persistent per-worker
# browser profile under $AGENT_DATA. The Chromium client renders on the shared
# Xvfb display (:99), so it is visible through the noVNC desktop pane; closing
# the dashboard's noVNC iframe does NOT terminate it (it just stops mirroring
# the X server). Only an explicit app stop, the worker lifecycle, or closing
# the Chromium X window ends the process.
#
# Output is NDJSON. Failures exit non-zero and emit `{"status":"error",...}`.

source "$(dirname "$0")/../lib.sh"

PIDS_DIR="/home/agent/pids"
PID_FILE="$PIDS_DIR/vscode-desktop.pid"
AGENT_DATA="/home/agent/.agent-data"
PROFILE_DIR="$AGENT_DATA/.vscode-desktop-profile"
CODE_SERVER_PORT=8443
CODE_SERVER_URL="http://127.0.0.1:${CODE_SERVER_PORT}/?folder=/workspace"
mkdir -p "$PIDS_DIR" "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"

# Wait for the local code-server port to accept a TCP connection. Fails clearly
# (non-zero NDJSON error) if code-server is not up — the app is useless without
# it. Bounded so a missing editor does not hang the Apps API call.
wait_for_code_server() {
    local max_tries="${1:-200}"  # 200 * 0.1s = 20s
    local i=0
    while [ $i -lt $max_tries ]; do
        if (exec 3<>"/dev/tcp/127.0.0.1/${CODE_SERVER_PORT}") 2>/dev/null; then
            exec 3>&- 3<&-
            return 0
        fi
        sleep 0.1
        i=$((i + 1))
    done
    return 1
}

is_vscode_desktop_process() {
    local pid="$1" cmdline
    [ -r "/proc/$pid/cmdline" ] || return 1
    cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline")
    [[ "$cmdline" == *chromium* ]] && [[ "$cmdline" == *"--user-data-dir=$PROFILE_DIR"* ]]
}

case "$1" in
  start)
    ID="${2:-vscode-desktop}"
    # PORT=$3 is always 0 for this app — ignored.

    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null && is_vscode_desktop_process "$PID"; then
            emit_err "Persistent VS Code already running (pid $PID)"
        fi
        rm -f "$PID_FILE"
    fi

    if ! wait_for_code_server 200; then
        emit_err "local code-server (port ${CODE_SERVER_PORT}) is not available — start the worker's Code editor first"
    fi

    # Launch Chromium using the same proven lifecycle as the regular Chromium
    # app. Closing the noVNC viewer does not affect this X11 process. Output is
    # mirrored to PID 1 for the centralized log collector.
    DISPLAY=:99 chromium \
        --user-data-dir="$PROFILE_DIR" \
        --app="$CODE_SERVER_URL" \
        --no-first-run \
        --no-sandbox \
        --disable-dev-shm-usage \
        --disable-gpu \
        --disable-features=Translate \
        > >(stdbuf -oL -eL sed -u 's/^/[vscode-desktop] /' >> /proc/1/fd/1) 2>&1 &
    APP_PID=$!

    # Give it a moment to confirm the process did not exit immediately (e.g.
    # profile locked, X display down). The X-window close is the normal exit
    # path — it is fine if the process ends later; we only fail fast here.
    sleep 0.3
    if ! kill -0 "$APP_PID" 2>/dev/null; then
        emit_err "Chromium exited immediately (DISPLAY=:99 unavailable or profile locked)"
    fi

    if ! echo "$APP_PID" > "$PID_FILE"; then
        kill_pid_graceful "$APP_PID"
        emit_err "unable to persist Persistent VS Code process id"
    fi
    printf '{"id":"%s","port":0,"status":"running"}\n' "$ID"
    ;;

  stop)
    ID="${2:-vscode-desktop}"

    if [ ! -f "$PID_FILE" ]; then
        printf '{"id":"%s","status":"stopped"}\n' "$ID"
        exit 0
    fi

    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        if ! is_vscode_desktop_process "$PID"; then
            rm -f "$PID_FILE"
            emit_err "stale Persistent VS Code pid file; refusing to signal unrelated process $PID"
        fi
        kill_pid_graceful "$PID"
    fi

    rm -f "$PID_FILE"
    printf '{"id":"%s","status":"stopped"}\n' "$ID"
    ;;

  list)
    if [ ! -f "$PID_FILE" ]; then
        exit 0
    fi
    PID=$(cat "$PID_FILE")
    if ! kill -0 "$PID" 2>/dev/null || ! is_vscode_desktop_process "$PID"; then
        rm -f "$PID_FILE"
        exit 0
    fi
    printf '{"id":"vscode-desktop","port":0,"status":"running"}\n'
    ;;

  *)
    emit_err "usage: manage.sh {start|stop|list}"
    ;;
esac
