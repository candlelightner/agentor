#!/bin/bash
set -euo pipefail
# Never repair ownership through an account share or a symlink. The account
# directories are prepared on the host; only private worker storage is ours.
mountpoint -q /workspace
mountpoint -q /home/agent/.agent-data
find /workspace /home/agent/.agent-data -xdev \
    \( -path /home/agent/.agent-data/.kilo/config \
       -o -path /home/agent/.agent-data/.kilo/shared-data \
       -o -path /home/agent/.agent-data/.claude/.credentials.json \
       -o -path /home/agent/.agent-data/.codex/auth.json \
       -o -path /home/agent/.agent-data/.gemini/oauth_creds.json \) -prune \
    -o \( ! -uid 1000 -o ! -gid 1000 \) -exec chown -h agent:agent {} +
