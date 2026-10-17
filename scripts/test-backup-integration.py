#!/usr/bin/env python3
"""Plan (default) or run backup acceptance in a fresh private DinD namespace.

Only a committed git archive is mounted. No checkout .env, keys, volumes,
Docker socket, credentials, or published ports enter the outer runner.
"""
import argparse
from contextlib import contextmanager
import os
import json
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import uuid

SUITES = {
    "workspace": ["api/backups.spec.ts", "api/instance-backups-api.spec.ts",
                  "ui/backup-management.spec.ts", "ui/instance-backup-management.spec.ts",
                  "ui/backup-management-real.spec.ts", "--workers=1", "--retries=0"],
    "instance": ["api/instance-backup-docker-live.spec.ts", "--project=api", "--workers=1", "--retries=0"],
}


def plan(suite, run_id, source):
    if suite not in SUITES or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", run_id):
        raise ValueError("Invalid suite or isolated run ID")
    prefix = "agentor-backup-" + run_id
    volumes = {"test-runner-docker": prefix + "-docker",
               "orchestrator-test-node-modules": prefix + "-orchestrator-deps",
               "backup-test-node-modules": prefix + "-test-deps"}
    override = {
        "services": {"test-runner": {
            "image": "agentor-test-runner:" + prefix,
            "container_name": prefix + "-runner",
            "volumes": ["backup-test-node-modules:/work/tests/node_modules"],
            "environment": {"INSTANCE_DOCKER_BACKUP_TEST": "true" if suite == "instance" else "false",
                            "TEST_WORKERS": "1", "RUN_REFERENCE_WORKFLOW": ""},
        }},
        "volumes": {key: {"name": value} for key, value in volumes.items()},
    }
    compose = ["docker", "--host", "unix:///var/run/docker.sock", "compose", "--project-directory", str(source),
               "--project-name", prefix, "-f", str(pathlib.Path(source) / "docker-compose.tests.yml"),
               "-f", "<override.json>"]
    return {"suite": suite, "prefix": prefix, "volumes": list(volumes.values()), "override": override,
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
    parser.add_argument("--execute", action="store_true", help="Actually build/run the private stack; default only prints a plan")
    args = parser.parse_args(argv)
    repo = pathlib.Path(__file__).resolve().parents[1]
    proposed = plan(args.suite, args.run_id, "<tracked-source-snapshot>")
    if not args.execute:
        print(json.dumps(proposed, indent=2))
        return 0
    env = dict(os.environ)
    for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
                "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_ENV_FILES", "COMPOSE_PROFILES"):
        env.pop(key, None)
    env["COMPOSE_DISABLE_ENV_FILE"] = "1"
    subprocess.run(["git", "-C", str(repo), "diff", "--quiet", "HEAD", "--"], check=True)
    commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    with exclusive_run(proposed["prefix"]):
        return execute(repo, args, proposed, env, commit)


def execute(repo, args, proposed, env, commit):
    docker = ["docker", "--host", "unix:///var/run/docker.sock"]
    # A requested run ID must never adopt or clean someone else's resources.
    for kind, name in [("container", proposed["prefix"] + "-runner")] + [("volume", name) for name in proposed["volumes"]]:
        if subprocess.run(docker + [kind, "inspect", name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            raise RuntimeError("Isolated test resource already exists; choose a fresh run ID: " + name)
    reports = pathlib.Path(tempfile.mkdtemp(prefix=proposed["prefix"] + "-results-"))
    (reports / "source.json").write_text(json.dumps({"commit": commit, "suite": args.suite, "runId": args.run_id}))
    print("Private backup acceptance reports:", reports, flush=True)
    print("Testing committed source:", commit, flush=True)
    with tempfile.TemporaryDirectory(prefix=proposed["prefix"] + "-source-") as scratch:
        snapshot = pathlib.Path(scratch) / "repository"
        archive_source(repo, snapshot)
        actual = plan(args.suite, args.run_id, snapshot)
        override = pathlib.Path(scratch) / "override.json"
        override.write_text(json.dumps(actual["override"]))
        for key in ("build", "run", "cleanup"):
            actual[key] = [str(override) if value == "<override.json>" else value for value in actual[key]]
        exit_code = 1
        try:
            subprocess.run(actual["build"], env=env, check=True)
            with (reports / "runner.log").open("w") as log:
                result = subprocess.run(actual["run"], env=env, stdout=log, stderr=subprocess.STDOUT)
                exit_code = result.returncode
        finally:
            # A cancelled CLI can leave its one-off runner alive. Stop this
            # exact newly reserved name before removing its daemon volume.
            subprocess.run(docker + ["container", "rm", "--force", proposed["prefix"] + "-runner"],
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for name in ("test-results", "playwright-report"):
                    path = snapshot / "tests" / name
                    if path.exists():
                        shutil.copytree(path, reports / name)
            finally:
                # Report-copy failures cannot bypass scoped resource cleanup.
                subprocess.run(actual["cleanup"], env=env, check=True)
        print("Private backup acceptance reports:", reports)
        print("Exit code:", exit_code)
        return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
