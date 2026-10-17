#!/usr/bin/env python3
"""Offline, one-job failed-abandonment after a proven cold Incus-host reboot.

No native mutations, successful result, image publication, receipt adoption or
source-data writes. Uses the existing catalog/archive/sizing cleanup fences.
"""
import argparse
import copy
import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import tempfile
from urllib.parse import quote

SPEC = importlib.util.spec_from_file_location("host_sources", Path(__file__).with_name("incus-host-mount-sources.py"))
SOURCES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOURCES)
UUID = re.compile(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
LIMIT = 8 * 1024 * 1024
OPERATOR_UID = 0
CONFIG_ROOT = Path("/etc/agentor/incus")


class RecoveryError(ValueError):
    """Only fixed, secret-free operator instructions are exposed by the CLI."""


def require(value, message):
    if not value: raise RecoveryError(message)


def digest(raw): return hashlib.sha256(raw).hexdigest()
def packed(value): return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def read_file(path, private=False):
    SOURCES.directory_identity(str(path.parent))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= LIMIT
                and not info.st_mode & 0o022 and (not private or info.st_uid == OPERATOR_UID and not info.st_mode & 0o077),
                "Record must be bounded, owned/protected, regular and unlinked elsewhere")
        raw = os.read(fd, LIMIT + 1)
        require(len(raw) == info.st_size, "Record changed while reading")
        return raw, info
    finally: os.close(fd)


def exclusive(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try: os.write(fd, raw); os.fsync(fd)
    finally: os.close(fd)
    sync_directory(path.parent)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def command(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=True)
    require(len(result.stdout) <= LIMIT, "Diagnostic response exceeds its bound")
    return result.stdout.decode()


def native(path, absent=False):
    # Operator-only local access. This socket is never mounted into Orchestrator.
    connection = http.client.HTTPConnection("localhost", timeout=15)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(15); connection.sock.connect("/var/lib/incus/unix.socket")
    try:
        connection.request("GET", path); response = connection.getresponse(); raw = response.read(LIMIT + 1)
        require(len(raw) <= LIMIT, "Native response exceeds its bound")
        if absent:
            require(response.status == 404, "Disposable resource still exists or absence is unverified; retain quarantine")
            return
        require(response.status == 200, "Native authority/source unavailable; retain quarantine")
        result = json.loads(raw)
        require(result.get("type") == "sync", "Native result is not authoritative")
        return result["metadata"]
    finally: connection.close()


def host_identity():
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    machine = Path("/etc/machine-id").read_text().strip()
    require(UUID.fullmatch(boot) and re.fullmatch(r"[a-f0-9]{32}", machine), "Trusted host identity unavailable")
    return {"boot": boot, "machine": digest(machine.encode())}


def offline_controller(config):
    rows = json.loads(command("docker", "--host", "unix:///var/run/docker.sock", "container", "inspect", config["container"]))
    require(len(rows) == 1, "Exact configured controller unavailable")
    controller = rows[0]
    environment = dict(item.split("=", 1) for item in controller["Config"].get("Env", []) if "=" in item)
    require(environment.get("INCUS_STORAGE_POOL", config["pool"]) == config["pool"]
            and environment.get("INCUS_CONVERTER_STORAGE_POOL", config["pool"]) == config.get("converterPool", config["pool"]),
            "Controller pool selection differs from operator configuration")
    mounts = [m for m in controller["Mounts"] if m["Destination"] == "/data"]
    require(len(mounts) == 1 and mounts[0]["RW"] and mounts[0]["Source"] == config["dataDir"], "Controller DATA differs from operator configuration")
    ids = command("docker", "--host", "unix:///var/run/docker.sock", "ps", "-aq").split()
    require(len(ids) <= 512, "Controller inventory exceeds this bounded recovery workflow")
    all_rows = json.loads(command("docker", "--host", "unix:///var/run/docker.sock", "container", "inspect", *ids)) if ids else []
    for row in all_rows:
        if any(m.get("RW") and SOURCES.overlaps(m["Source"], config["dataDir"]) for m in row.get("Mounts", [])):
            require(not row["State"]["Running"] and row["State"]["Pid"] == 0
                    and row["HostConfig"]["RestartPolicy"]["Name"] in ("", "no"),
                    "A DATA writer is running or may auto-restart; explicitly stop/disable it before inspection")
    return {"id": controller["Id"], "created": controller["Created"], "image": controller["Image"],
            "configuration": digest(packed({"config": controller["Config"], "mounts": sorted(controller["Mounts"], key=lambda m: m["Destination"])}))}


def job_document(data, kind, job):
    if kind == "archive":
        path = data / "incus-backup-helpers" / (job + ".json")
    elif kind == "converter": path = data / "image-catalog" / "image-catalog.json"
    else: path = data / "system-state" / "users" / "volume-sizing" / "volume-size-jobs.v1.json"
    raw, info = read_file(path); document = json.loads(raw)
    rows = [document] if kind == "archive" else document["builds"] if kind == "converter" else document
    require(isinstance(rows, list), "Existing job store is malformed")
    matches = [r for r in rows if r.get("id") == job]
    require(len(matches) == 1, "Exact existing job is unavailable/ambiguous")
    if kind == "converter":
        require(not any(b.get("buildId") == job for b in document.get("nativeBindings", {}).values()), "A published image binding must never be abandoned")
    return path, raw, info, document, matches[0]


def layout(config, kind, job, record):
    installation = config["installation"]
    pool = config["pool"]
    copies, sources = [], []
    if kind == "converter":
        derivation = record.get("nativeDerivation", {}); receipt = derivation.get("converter", {})
        context = derivation.get("context", {})
        require(record.get("status") == "failed" and "imageImport" not in derivation and receipt.get("version") == 1
                and not receipt.get("removed") and receipt.get("installationId") == installation
                and context.get("installationId") == installation and receipt.get("project") == config["project"]
                and context.get("project") == config["project"], "Only failed pre-import converter jobs of this installation are supported")
        require(receipt.get("sourceImageId") == context.get("sourceImageId") == record.get("digest")
                and re.fullmatch(r"sha256:[a-f0-9]{64}", receipt.get("sourceImageId", "")), "Immutable converter source differs")
        require(json.loads(command("docker", "--host", "unix:///var/run/docker.sock", "image", "inspect", receipt["sourceImageId"]))[0]["Id"] == receipt["sourceImageId"], "Authorized local OCI source is unavailable")
        name, incarnation = receipt.get("name"), receipt.get("incarnation")
        require(name == "aic-" + job, "Converter job name differs")
        pool = config.get("converterPool") or pool
    elif kind == "archive":
        receipt = record
        require(receipt.get("version") == 1 and receipt.get("installation") == installation,
                "Archive installation differs")
        source = receipt.get("sources", {})
        require(set(source) in ({"workspace", "agents"}, {"managed"}, {"docker", "copy"})
                and "writerSettled" not in receipt, "Workspace writers/unknown archive layouts require separate recovery")
        owner = receipt.get("owner", {})
        require(UUID.fullmatch(owner.get("id", "")) and NAME.fullmatch(owner.get("userId", "")), "Archive owner authority is malformed")
        if "copy" in source: require(isinstance(source["copy"], bool), "Docker source copy capability is malformed")
        sources = [source[key] for key in ("workspace", "agents", "managed", "docker") if key in source]
        name, incarnation = "abk-" + job, receipt.get("instance")
        if source.get("copy"):
            require(receipt.get("copy", {}).get("created_at") and receipt["copy"].get("config"), "Docker copy acknowledgement is missing")
            copies = ["adb-" + job]
    else:
        receipt = record.get("incusHelper", {})
        require(record.get("userId") == "volume-sizing" and record.get("status") in ("failed", "cancelled")
                and receipt.get("installation") == installation and not record.get("measurement"), "Only failed/cancelled Incus size jobs are supported")
        name, incarnation = "asz-" + job, receipt.get("instance")
        if receipt.get("copy"):
            require(receipt.get("copyCreatedAt"), "Sizing copy acknowledgement is missing")
            copies = ["agentor-size-" + job]
        volumes = native("/1.0/storage-pools/" + quote(pool) + "/volumes/custom?recursion=1&project=" + quote(config["project"]))
        require(isinstance(volumes, list) and len(volumes) <= 1024, "Source inventory unavailable/too large")
        candidates = [v["name"] for v in volumes if v.get("config", {}).get("user.agentor.volume-id") == record.get("volumeId")
            or "builtin-" + digest(v["name"].encode())[:24] == record.get("volumeId")]
        require(len(candidates) == 1, "Exact sizing source is unavailable/ambiguous")
        sources = candidates
    require(UUID.fullmatch(incarnation or ""), "Captured helper UUID is missing; do not adopt from name lookup")
    require(receipt.get("pending") and receipt["pending"].get("kind") in ("create", "start", "stop", "delete", "copy", "delete-copy"), "No supported pending-operation fence exists")
    require(all(isinstance(value, str) and NAME.fullmatch(value) for value in [pool, name, *copies, *sources]), "Native target identity is malformed")
    return pool, name, incarnation, copies, sources


def observations(config, kind, job, record):
    pool, name, incarnation, copies, sources = layout(config, kind, job, record)
    project = quote(config["project"]); base = "/1.0/storage-pools/" + quote(pool)
    storage = native(base)
    require(storage.get("status") == "Created" and storage.get("driver") == "dir", "Supported mounted directory pool is unavailable")
    source = storage.get("config", {}).get("source", "")
    SOURCES.directory_identity(source)
    mounted = Path("/var/lib/incus/storage-pools") / pool
    SOURCES.directory_identity(str(mounted))
    a, b = os.stat(source), mounted.stat()
    require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino), "Pool source is not the active mount")
    mount_uuid = command("findmnt", "-n", "-o", "UUID", "--target", str(mounted)).strip()
    require(UUID.fullmatch(mount_uuid), "Pool backing filesystem identity is unavailable")
    native("/1.0/instances/" + quote(name) + "?project=" + project, absent=True)
    native(base + "/volumes/virtual-machine/" + quote(name) + "?project=" + project, absent=True)
    # Native absence must not conceal an orphan root directory.
    require(not os.path.lexists(mounted / "virtual-machines" / (config["project"] + "_" + name)), "Orphan compute remains; use identity-fenced quarantine first")
    for copy_name in copies:
        native(base + "/volumes/custom/" + quote(copy_name) + "?project=" + project, absent=True)
        require(not os.path.lexists(mounted / "custom" / (config["project"] + "_" + copy_name)),
                "Orphan helper copy remains; retain quarantine")
    observed = []
    for source_name in sources:
        volume = native(base + "/volumes/custom/" + quote(source_name) + "?project=" + project)
        require(volume.get("name") == source_name and volume.get("project") == config["project"]
                and volume.get("type") == "custom" and volume.get("config", {}).get("user.agentor.installation") == config["installation"]
                and volume.get("created_at") and isinstance(volume.get("used_by"), list), "Canonical source ownership is unavailable")
        require(not any(name in ref for ref in volume["used_by"]), "Retired helper still references canonical data")
        # Incus dir-volume /state returns usage=null even with no backing data.
        # Metadata alone cannot prove the original source survived an unmount.
        backing = mounted / "custom" / (config["project"] + "_" + source_name)
        SOURCES.directory_identity(str(backing))
        backing_info = backing.stat()
        require(backing_info.st_dev == a.st_dev, "Canonical source is on an unexpected filesystem")
        physical = {"inode": backing_info.st_ino}
        require(volume.get("content_type") in ("filesystem", "block"), "Unsupported canonical source type")
        if volume["content_type"] == "block":
            fd = os.open(backing / "root.img", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                block = os.fstat(fd)
                require(stat.S_ISREG(block.st_mode) and block.st_nlink == 1 and block.st_size > 0
                        and block.st_dev == a.st_dev, "Canonical block backing is unavailable")
                physical.update(blockInode=block.st_ino, bytes=block.st_size)
            finally: os.close(fd)
        observed.append({"volume": volume, "backing": physical})
    return {"pool": pool, "source": source, "mountUuid": mount_uuid,
            "sourceInode": a.st_ino, "helper": name, "incarnation": incarnation, "copies": copies, "sources": observed}


def replacement(kind, document, job):
    result = copy.deepcopy(document)
    if kind == "archive": return None
    record = next(r for r in result["builds"] if r["id"] == job) if kind == "converter" else next(r for r in result if r["id"] == job)
    if kind == "converter":
        # Existing admission requires failed job + removed converter, never a
        # successful native binding/import. All other catalog state stays intact.
        receipt = record["nativeDerivation"]["converter"]
        receipt.pop("pending", None); receipt["removed"] = True
    else: record.pop("incusHelper")
    record["status"] = "failed"; record["phase"] = "failed"
    record["error"] = "Operator-abandoned after verified cold-host restart; no successful result was recovered."
    return packed(result) + b"\n"


def run(config_path, kind, job, apply=False):
    require(os.geteuid() == OPERATOR_UID, "Host operator root is required")
    require(UUID.fullmatch(job) and kind in ("archive", "converter", "sizing"), "One exact supported job required")
    require(config_path.name == "config.json" and config_path.parent.parent == CONFIG_ROOT
            and UUID.fullmatch(config_path.parent.name), "Use exact installed operator config")
    raw_config, _ = read_file(config_path, private=True); config = json.loads(raw_config)
    require(UUID.fullmatch(config.get("installation", "")) and config_path.parent.name == config["installation"]
            and NAME.fullmatch(config.get("project", "")) and config["project"] != "default", "Operator namespace identity differs")
    data = Path(SOURCES.canonical(config["dataDir"])); SOURCES.directory_identity(str(data))
    identity, _ = read_file(data / "backup-installation-id")
    require(identity.decode().strip() == config["installation"], "DATA installation differs")
    evidence = config_path.parent / ("native-job-" + kind + "-" + job)
    lock = os.open(config_path.parent / "native-job-recovery.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path, raw, info, document, record = job_document(data, kind, job)
        current = {"version": 1, "kind": kind, "job": job, "config": digest(raw_config), "record": digest(raw),
                   "file": {"inode": info.st_ino, "uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode)},
                   "host": host_identity(), "controller": offline_controller(config), "native": observations(config, kind, job, record)}
        if not apply:
            evidence.mkdir(mode=0o700)
            exclusive(evidence / "original", raw); exclusive(evidence / "inspection.json", packed(current))
            print("Inspection saved. Keep submitters disabled; perform a FULL Incus-host reboot, then run --apply for this exact job.")
            return
        evidence_info = evidence.lstat()
        require(stat.S_ISDIR(evidence_info.st_mode) and evidence_info.st_uid == OPERATOR_UID and not evidence_info.st_mode & 0o077, "Evidence must be root-owned/private")
        before_raw, _ = read_file(evidence / "inspection.json", private=True); before = json.loads(before_raw)
        original, _ = read_file(evidence / "original", private=True)
        require(digest(original) == current["record"] == before["record"], "Original job store changed; retain evidence")
        require(before["host"]["machine"] == current["host"]["machine"] and before["host"]["boot"] != current["host"]["boot"], "A full same-host reboot AFTER inspection is required; daemon restart/404 is insufficient")
        expected = copy.deepcopy(current); expected["host"] = before["host"]
        require(before == expected, "Controller/config/source/incarnation/evidence changed; retain quarantine")
        changed = replacement(kind, document, job)
        # Preserve both original bytes and intended replacement before touching
        # the active fence. A crash/ack loss fails closed on hash mismatch.
        exclusive(evidence / "replacement", changed or b"archive receipt retired as failed; no result recovered\n")
        again, now = read_file(path)
        require(again == raw and now.st_ino == info.st_ino, "Job record changed before retirement")
        require(offline_controller(config) == current["controller"] and observations(config, kind, job, record) == current["native"], "Authority changed before retirement")
        if changed is None: path.unlink()
        else:
            fd, temporary = tempfile.mkstemp(prefix=path.name + ".operator-", dir=path.parent)
            try:
                os.fchmod(fd, stat.S_IMODE(info.st_mode)); os.fchown(fd, info.st_uid, info.st_gid)
                with os.fdopen(fd, "wb", closefd=False) as stream: stream.write(changed); stream.flush(); os.fsync(fd)
                os.replace(temporary, path)
            finally: os.close(fd)
        sync_directory(path.parent)
        exclusive(evidence / "completed.json", packed({"job": job, "kind": kind, "status": "failed-abandoned", "boot": current["host"]["boot"]}))
        print("One job retired as FAILED/ABANDONED. Original evidence retained; no native resource/source data/image binding was changed.")
    finally: os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--kind", required=True, choices=("archive", "converter", "sizing"))
    parser.add_argument("--job", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-submitters-offline", action="store_true", required=True,
                        help="Operator confirms no external/host submitters are active; DATA containers are checked too")
    args = parser.parse_args(); run(args.config, args.kind, args.job, args.apply)


if __name__ == "__main__":
    try: main()
    except RecoveryError as error:
        raise SystemExit("STOP: " + str(error) + ". Keep original evidence/quarantine; do not force-clear or replay.")
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError, subprocess.SubprocessError, http.client.HTTPException):
        raise SystemExit("STOP: recovery proof/authority is incomplete or changed. Keep original evidence/quarantine; inspect privately, do not force-clear or replay.")
