#!/usr/bin/env python3
"""Plan backup acceptance; execution is blocked pending a safe runner.

Rootful DinD on the production host has no validated device-isolation boundary.
--execute fails before any subprocess, resource creation, or cleanup. The full
workspace and instance suites remain in the plan for a future reviewed runner.
"""
import argparse
from contextlib import contextmanager
import os
import json
import pathlib
import re
import subprocess
import tarfile
import tempfile
import uuid
import sys

SUITES = {
    "workspace": ["api/backups.spec.ts", "api/instance-backups-api.spec.ts",
                  "ui/backup-management.spec.ts", "ui/instance-backup-management.spec.ts",
                  "ui/backup-management-real.spec.ts", "--workers=1", "--retries=0"],
    "instance": ["api/instance-backup-docker-live.spec.ts", "--project=api", "--workers=1", "--retries=0"],
}


BLOCK_CODE = "BACKUP_RUNNER_DEVICE_ISOLATION_UNVERIFIED"
BLOCK_REASON = (
    "Rootful nested Docker has no validated outer device-isolation boundary. "
    "Privileged runners expose host devices; SYS_ADMIN/BPF and writable cgroup "
    "delegation require a separate isolation design. No Docker operation was run. "
    "See docs/backup-integration-acceptance.md."
)


def validate_outer_service(service, source, volumes):
    """Reject unsafe generated/resolved outer services without contacting Docker.

    This is a configuration check, not proof of kernel/device-cgroup isolation.
    In particular it cannot authorize execution or enable any added capability.
    """
    if not isinstance(service, dict) or service.get("privileged") is not False:
        raise ValueError("Outer runner must explicitly disable privileged mode")
    if service.get("cgroup") != "private" or service.get("ipc") != "private":
        raise ValueError("Outer cgroup and IPC namespaces must be private")
    allowed = {"build", "image", "container_name", "privileged", "cgroup", "ipc", "cap_drop",
               "security_opt", "shm_size", "volumes", "environment"}
    if set(service) - allowed:
        raise ValueError("Outer runner has unsupported configuration fields")
    name = service.get("container_name", "")
    if not re.fullmatch(r"agentor-backup-[a-z0-9][a-z0-9-]{1,30}-runner", name):
        raise ValueError("Outer runner requires its exact isolated name")
    prefix = name.removesuffix("-runner")
    if service.get("image") != "agentor-test-runner:" + prefix:
        raise ValueError("Outer runner requires an isolated image tag")
    if service.get("build") != str(pathlib.Path(source) / "tests/docker"):
        raise ValueError("Outer runner build must use only the tracked snapshot")
    # Omitting PID/network/UTS modes retains private defaults. The allowlist also
    # forbids devices, device-cgroup rules, host binds outside the exact mounts,
    # added capabilities, namespace sharing, hooks and alternate runtimes.
    if service.get("cap_drop") != ["ALL"] or service.get("security_opt") != ["no-new-privileges:true"]:
        raise ValueError("Outer runner must retain the blocked plan's capability/security limits")
    expected = source_mounts(source) + [
        "test-runner-docker:/var/lib/docker",
        "orchestrator-test-node-modules:/work/node_modules",
        "backup-test-node-modules:/work/tests/node_modules",
    ]
    if service.get("volumes") != expected:
        raise ValueError("Outer runner accepts only the exact tracked snapshot and fresh volumes")
    if set(volumes) != {"test-runner-docker", "orchestrator-test-node-modules", "backup-test-node-modules"}:
        raise ValueError("Unexpected outer volume declaration")
    for key, suffix in (("test-runner-docker", "docker"),
                        ("orchestrator-test-node-modules", "orchestrator-deps"),
                        ("backup-test-node-modules", "test-deps")):
        if volumes[key] != {"name": prefix + "-" + suffix}:
            raise ValueError("Outer volumes must have exact isolated names and no driver options")


def source_mounts(source):
    return [str(pathlib.Path(source) / path) + ":" + target for path, target in [
        ("orchestrator", "/src/orchestrator:ro"), ("orchestrator", "/work/orchestrator:ro"),
        ("worker", "/src/worker:ro"), ("scripts", "/src/scripts:ro"),
        (".dockerignore", "/src/.dockerignore:ro"), ("tests", "/work/tests"),
    ]]


def plan(suite, run_id, source):
    if suite not in SUITES or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", run_id):
        raise ValueError("Invalid suite or isolated run ID")
    prefix = "agentor-backup-" + run_id
    volumes = {"test-runner-docker": prefix + "-docker",
               "orchestrator-test-node-modules": prefix + "-orchestrator-deps",
               "backup-test-node-modules": prefix + "-test-deps"}
    # Standalone Compose document: never merge with the privileged generic runner.
    override = {
        "services": {"test-runner": {
            "build": str(pathlib.Path(source) / "tests/docker"),
            "image": "agentor-test-runner:" + prefix,
            "container_name": prefix + "-runner",
            "privileged": False, "cgroup": "private", "ipc": "private",
            "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
            "shm_size": "2gb",
            "volumes": source_mounts(source) + ["test-runner-docker:/var/lib/docker",
                        "orchestrator-test-node-modules:/work/node_modules",
                        "backup-test-node-modules:/work/tests/node_modules"],
            "environment": {"INSTANCE_DOCKER_BACKUP_TEST": "true" if suite == "instance" else "false",
                            "BASE_URL": "http://localhost:3000", "NODE_TLS_REJECT_UNAUTHORIZED": "0",
                            "TEST_WORKERS": "1", "RUN_REFERENCE_WORKFLOW": ""},
        }},
        "volumes": {key: {"name": value} for key, value in volumes.items()},
    }
    validate_outer_service(override["services"]["test-runner"], source, override["volumes"])
    compose = ["docker", "--host", "unix:///var/run/docker.sock", "compose", "--project-directory", str(source),
               "--project-name", prefix, "-f", "<override.json>"]
    return {"suite": suite, "prefix": prefix, "volumes": list(volumes.values()), "override": override,
            "execution": {"status": "blocked", "code": BLOCK_CODE, "reason": BLOCK_REASON},
            "build": compose + ["build", "test-runner"],
            "run": compose + ["run", "--rm", "--name", prefix + "-runner", "test-runner"] + SUITES[suite],
            "cleanup": compose + ["down", "--volumes", "--remove-orphans"]}


def archive_source(repo, destination):
    archive = destination.parent / "source.tar"
    with archive.open("wb") as output:
        subprocess.run(["git", "-C", str(repo), "archive", "HEAD"], stdout=output, check=True)
    destination.mkdir(mode=0o700)
    with tarfile.open(archive) as source:
        # Git paths are repository controlled, but reject escaping links too.
        source.extractall(destination, filter="data")
    archive.unlink()


@contextmanager
def exclusive_run(prefix, directory=None):
    lock = pathlib.Path(directory or tempfile.gettempdir()) / (prefix + ".lock")
    descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        yield
    finally:
        os.close(descriptor)
        lock.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=SUITES, default="workspace")
    parser.add_argument("--run-id", default=uuid.uuid4().hex[:12])
    parser.add_argument("--execute", action="store_true", help="Currently refused: safe outer device isolation has not been validated")
    args = parser.parse_args(argv)
    proposed = plan(args.suite, args.run_id, "<tracked-source-snapshot>")
    if not args.execute:
        print(json.dumps(proposed, indent=2))
        return 0
    # No environment flag, receipt, root UID, or weaker suite can bypass this.
    # A new runner must be implemented and reviewed before execution is restored.
    print(BLOCK_CODE + ": " + BLOCK_REASON, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
