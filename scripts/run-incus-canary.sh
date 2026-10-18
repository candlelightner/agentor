#!/usr/bin/env bash
# Operator-run only. Uses the deployed adapter and current admin session;
# never carries credentials in command arguments or environment variables.
set -euo pipefail
exec python3 - "$@" <<'PY'
import argparse, os, re, stat, subprocess, sys

parser = argparse.ArgumentParser(description="Run the deployed, authenticated Incus rollout canary")
parser.add_argument("--orchestrator-container", default="agentor-orchestrator")
parser.add_argument("--input-file", required=True, help="Private JSON containing sessionCookie and optional dockerEnabled")
args = parser.parse_args()
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.orchestrator_container) or not os.path.isabs(args.input_file):
    parser.error("Explicit safe container name and absolute private input file required")
fd = os.open(args.input_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    info = os.fstat(fd)
    allowed = {0, os.getuid()}
    if os.environ.get("SUDO_UID", "").isdigit(): allowed.add(int(os.environ["SUDO_UID"]))
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in allowed or info.st_mode & 0o077 or not 0 < info.st_size <= 16384:
        parser.error("Input must be a bounded private owned regular file")
    data = os.read(fd, 16385)
    if len(data) > 16384: parser.error("Input exceeded its bound")
finally:
    os.close(fd)
environment = {key: value for key, value in os.environ.items()
               if key not in {"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}}
result = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock", "exec", "-i", args.orchestrator_container,
                         "node", "/app/.output/server/incus-canary.mjs"], input=data, env=environment)
sys.exit(result.returncode)
PY
