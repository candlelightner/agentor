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
import uuid


def docker(*args):
    env = {key: value for key, value in os.environ.items()
           if key not in {"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}}
    return subprocess.check_output(["docker", "--host", "unix:///var/run/docker.sock", *args],
                                   text=True, env=env, timeout=60).strip()


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
if data != "/var/tmp/agentor-phase6-production.SSkg3hQz/stack-data":
    raise SystemExit("Not the retained isolated acceptance data")
parent = os.path.dirname(data)
if set(binds) != {data + ":/data", parent + "/tls:/tls:ro", "/var/run/docker.sock:/var/run/docker.sock"}:
    raise SystemExit("Unexpected mounts; no runtime/control-plane authority added")
networks = old["NetworkSettings"]["Networks"]
if set(networks) != {"agentor-phase6-net", "agentor-management"}:
    raise SystemExit("Unexpected fixture topology")
if any(networks[name].get("IPAddress") != address for name, address in
       {"agentor-phase6-net": "172.22.0.2", "agentor-management": "172.20.0.2"}.items()):
    raise SystemExit("Fixture IP changed; reconcile exact source-preserving routing first")
ports = host["PortBindings"]
if ports != {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "38000"}, {"HostIp": "10.159.68.1", "HostPort": "38000"}]}:
    raise SystemExit("Unexpected fixture listener scope")
incus_hosts = ["agentor-kata-preflight:host-gateway"]
if "INCUS_ENDPOINT=https://agentor-kata-preflight:8443" not in cfg["Env"]:
    raise SystemExit("Unexpected fixture Incus endpoint")
if (host.get("ExtraHosts") or []) != incus_hosts:
    # Repair only our own earlier helper replacement, which omitted the
    # original Incus hostname mapping. Never widen an unrelated source.
    if host.get("ExtraHosts") or (cfg.get("Labels") or {}).get("agentor.incus.acceptance") != "true":
        raise SystemExit("Unexpected fixture Incus hostname mapping")
if docker("ps", "-a", "--filter", "name=^/" + args.retain_as + "$", "--format", "{{.ID}}"):
    raise SystemExit("Retained name already exists; never overwrite recovery")
docker("image", "inspect", args.image)  # Preflight before stopping anything.
environment = [line for line in cfg["Env"] if not line.startswith("INCUS_WORKER_IMAGE=")]
environment.append("INCUS_WORKER_IMAGE=" + args.worker_image)
if any("\n" in line or "\r" in line for line in environment):
    raise SystemExit("Environment cannot be represented safely in env-file")
created = None
attempt = str(uuid.uuid4())
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
                   "--label", "agentor.incus.acceptance=true",
                   "--label", "agentor.incus.acceptance.attempt=" + attempt]
        for entry in incus_hosts:
            command += ["--add-host", entry]
        for bind in binds:
            command += ["-v", bind]
        for binding in ports["3000/tcp"]:
            command += ["-p", binding["HostIp"] + ":" + binding["HostPort"] + ":3000"]
        created = docker(*command, args.image)
        docker("network", "connect", "--ip", networks["agentor-management"]["IPAddress"], "agentor-management", created)
        docker("start", created)
    except BaseException as primary:
        # Remove only the just-created fixture container, never data/volumes.
        failures = []
        def recover(label, *command):
            try:
                docker(*command)
                return True
            except BaseException:
                failures.append(label)
                return False
        if created is None:
            try:
                candidates = docker("ps", "-a", "--filter", "label=agentor.incus.acceptance.attempt=" + attempt,
                                    "--format", "{{.ID}}")
                if "\n" in candidates:
                    raise RuntimeError("Ambiguous attempt ownership")
                created = candidates or None
            except BaseException:
                failures.append("replacement ownership check")
        destination_absent = not failures and (created is None or recover("replacement removal", "rm", "-f", created))
        # Never run two writers against the same DATA_DIR. An ambiguous failed
        # destination is retained for explicit recovery with source stopped.
        if destination_absent:
            if renamed:
                recover("source name restoration", "rename", old_id, "agentor-orchestrator")
            for name in disconnected:
                recover("source network restoration: " + name, "network", "connect", "--ip",
                        networks[name]["IPAddress"], name, old_id)
            recover("source restart", "start", old_id)
        if failures:
            raise RuntimeError("Fixture rollback incomplete; retained source " + old_id + ": " + ", ".join(failures)) from primary
        raise
print("Acceptance Orchestrator replaced; previous exact container retained as " + args.retain_as)
