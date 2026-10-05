#!/bin/bash
set -euo pipefail
# Never repair ownership through an account share or a symlink. The account
# directories are prepared on the host; only private worker storage is ours.
mountpoint -q /workspace
mountpoint -q /home/agent/.agent-data
# Restored numeric ownership/capabilities are canonical data. Only the control
# plane's tmpfs marker selects this mode; never consume worker runtime env.
ownership_marker=/run/agentor/preserve-storage-ownership
if [ -e "$ownership_marker" ] || [ -L "$ownership_marker" ]; then
    test -f "$ownership_marker"
    test ! -L "$ownership_marker"
    test "$(stat -c '%u:%g:%a:%h:%s' "$ownership_marker")" = '0:0:600:1:38'
    test "$(cat "$ownership_marker")" = agentor-preserve-storage-ownership-v1
    exit 0
fi
prune=( -path /home/agent/.agent-data/.kilo/config
        -o -path /home/agent/.agent-data/.kilo/shared-data
        -o -path /home/agent/.agent-data/.claude/.credentials.json
        -o -path /home/agent/.agent-data/.codex/auth.json
        -o -path /home/agent/.agent-data/.gemini/oauth_creds.json )
# -xdev prevents descent but still evaluates the mounted directory itself.
# Repairing that inode would chown an authorized host share's root. Capture
# nested mountpoints once from the kernel; never spawn a probe for every file.
while read -r _ _ _ _ target _; do
    printf -v target '%b' "$target"
    case "$target" in
        /workspace/*|/home/agent/.agent-data/*)
            # find -path uses glob syntax; keep kernel paths literal, including
            # spaces and metacharacters in legitimate approved mount targets.
            literal=${target//\\/\\\\}
            literal=${literal//\*/\\*}
            literal=${literal//\?/\\?}
            literal=${literal//\[/\\[}
            prune+=( -o -path "$literal" );;
    esac
done < /proc/self/mountinfo
find /workspace /home/agent/.agent-data -xdev \
    \( "${prune[@]}" \) -prune \
    -o \( ! -uid 1000 -o ! -gid 1000 \) -exec chown -h agent:agent {} +
