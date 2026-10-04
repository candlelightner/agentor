#!/usr/bin/env python3
"""Replace only the retained disposable acceptance Orchestrator, with rollback.

Run via the approved SSH relay as guest root. Never a production setup tool.
Credentials are copied through a temporary 0600 env file, never printed.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import tempfile


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


parser = argparse.ArgumentParser()
parser.add_argument("--image", required=True)
parser.add_argument("--worker-image", required=True)
parser.add_argument("--retain-as", required=True)
args = parser.parse_args()
if socket.gethostname() != "agentor-kata-preflight" or os.geteuid() != 0:
    raise SystemExit("Only the explicitly approved disposable guest is allowed")
if not re.fullmatch(r"agentor-phase\d+-orchestrator:[a-z0-9-]+", args.image):
    raise SystemExit("Invalid acceptance image")
if not re.fullmatch(r"agentor-worker-phase\d+-[a-z0-9-]+", args.worker_image):
    raise SystemExit("Invalid acceptance worker alias")
if not re.fullmatch(r"agentor-orchestrator-before-phase\d+", args.retain_as):
    raise SystemExit("Invalid retained fixture name")
old = json.loads(docker("inspect", "agentor-orchestrator"))[0]
old_id = old["Id"]
cfg, host = old["Config"], old["HostConfig"]
binds = host["Binds"] or []
data = next((bind.split(":")[0] for bind in binds if bind.endswith(":/data")), "")
if not re.fullmatch(r"/var/tmp/agentor-phase6-production\.[A-Za-z0-9]+/stack-data", data):
    raise SystemExit("Not the retained isolated acceptance data")
parent = os.path.dirname(data)
if set(binds) != {data + ":/data", parent + "/tls:/tls:ro", "/var/run/docker.sock:/var/run/docker.sock"}:
    raise SystemExit("Unexpected mounts; no runtime/control-plane authority added")
networks = old["NetworkSettings"]["Networks"]
if set(networks) != {"agentor-phase6-net", "agentor-management"}:
    raise SystemExit("Unexpected fixture topology")
ports = host["PortBindings"]
if ports != {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "38000"}, {"HostIp": "10.159.68.1", "HostPort": "38000"}]}:
    raise SystemExit("Unexpected fixture listener scope")
if docker("ps", "-a", "--filter", "name=^/" + args.retain_as + "$", "--format", "{{.ID}}"):
    raise SystemExit("Retained name already exists; never overwrite recovery")
docker("image", "inspect", args.image)  # Preflight before stopping anything.
environment = [line for line in cfg["Env"] if not line.startswith("INCUS_WORKER_IMAGE=")]
environment.append("INCUS_WORKER_IMAGE=" + args.worker_image)
if any("\n" in line or "\r" in line for line in environment):
    raise SystemExit("Environment cannot be represented safely in env-file")
created = None
disconnected = []
renamed = False
with tempfile.NamedTemporaryFile(mode="w", prefix="agentor-fixture-env-") as env:
    os.fchmod(env.fileno(), 0o600)
    env.write("\n".join(environment) + "\n")
    env.flush()
    try:
        docker("stop", "--time", "30", old_id)
        for name in networks:
            docker("network", "disconnect", name, old_id)
            disconnected.append(name)
        docker("rename", old_id, args.retain_as)
        renamed = True
        command = ["create", "--name", "agentor-orchestrator", "--network", "agentor-phase6-net",
                   "--ip", networks["agentor-phase6-net"]["IPAddress"], "--env-file", env.name,
                   "--label", "agentor.incus.acceptance=true"]
        for bind in binds:
            command += ["-v", bind]
        for binding in ports["3000/tcp"]:
            command += ["-p", binding["HostIp"] + ":" + binding["HostPort"] + ":3000"]
        created = docker(*command, args.image)
        docker("network", "connect", "--ip", networks["agentor-management"]["IPAddress"], "agentor-management", created)
        docker("start", created)
    except BaseException:
        # Remove only the just-created fixture container, never data/volumes.
        if created:
            docker("rm", "-f", created)
        if renamed:
            docker("rename", old_id, "agentor-orchestrator")
        for name in disconnected:
            docker("network", "connect", "--ip", networks[name]["IPAddress"], name, old_id)
        docker("start", old_id)
        raise
print("Acceptance Orchestrator replaced; previous exact container retained as " + args.retain_as)
