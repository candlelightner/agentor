"""Catalog-ID-only host export allowlisting for the restricted Agentor project.

Old exact export roots remain reserved against overlapping future exports. An
empty instance list cannot prove an accepted create will never publish an old
root. This is a small project policy field, not a filesystem/operation journal.
Account shares use a separate fixed owner/worker-ID operation. Unrelated
operator restrictions and approved host-mount roots are never rewritten.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import quote


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCES = sibling("incus-host-mount-sources")
NETWORK = sibling("incus-managed-network-policy")
OWNED_ROOTS = "user.agentor.host-mount-roots"


def unmount_export(path, namespace="/proc/1/ns/mnt"):
    try:
        result = subprocess.run(["nsenter", "--mount=" + namespace, "--", "umount", "--internal-only", "--no-canonicalize", "--", str(path)],
                                capture_output=True, timeout=15)
    except subprocess.TimeoutExpired as error:
        raise SOURCES.SourceRejected("Host export cleanup timed out; VM remains stopped, source data retained") from error
    if result.returncode:
        raise SOURCES.SourceRejected("Host export is still busy; VM remains stopped, source data retained")


class HostMountPolicy:
    def __init__(self, data_dir, installation, project, incus_dir, protected_paths, request, docker_list,
                 mountinfo=lambda: Path("/proc/self/mountinfo").read_text(), unmount=unmount_export,
                 host_mountinfo=lambda: Path("/proc/1/mountinfo").read_text()):
        self.data_dir = SOURCES.canonical(data_dir)
        self.installation, self.project = installation, project
        self.incus_dir = SOURCES.canonical(incus_dir)
        self.protected_paths = [SOURCES.canonical(path) for path in protected_paths]
        self.request, self.docker_list, self.mountinfo = request, docker_list, mountinfo
        self.unmount, self.host_mountinfo = unmount, host_mountinfo
        if not SOURCES.UUID.fullmatch(installation) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,63}", project) or project == "default":
            raise SOURCES.SourceRejected("Pinned installation and dedicated project required")

    def identity(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"pathId"} or \
                not isinstance(payload["pathId"], str) or not SOURCES.UUID.fullmatch(payload["pathId"]):
            raise SOURCES.SourceRejected("Only a platform catalog path ID is accepted")
        if self.read_authority(["backup-installation-id"], 128).strip() != self.installation:
            raise SOURCES.SourceRejected("Installation identity changed")
        return payload["pathId"]

    def read_authority(self, parts, limit=1024 * 1024):
        try:
            return NETWORK.read_bounded(self.data_dir, parts, limit)
        except NETWORK.PolicyError as error:
            raise SOURCES.SourceRejected("Platform host export authority is unavailable") from error

    def project_policy(self):
        project, etag = self.request("GET", "/1.0/projects/" + quote(self.project))
        config = project.get("config", {})
        if project.get("name") != self.project or config.get("restricted") != "true" or \
                config.get("restricted.devices.disk") != "allow" or not etag:
            raise SOURCES.SourceRejected("Restricted project with exact disk export policy required")
        paths = [SOURCES.canonical(path) for path in config.get("restricted.devices.disk.paths", "").split(",") if path]
        roots = []
        if OWNED_ROOTS in config:
            value = json.loads(config[OWNED_ROOTS])
            if not isinstance(value, dict) or set(value) != {"installation", "sources"} or \
                    value["installation"] != self.installation or not isinstance(value["sources"], list) or len(value["sources"]) > 4096:
                raise SOURCES.SourceRejected("Owned export policy belongs to another installation or is ambiguous")
            roots = [SOURCES.canonical(path) for path in value["sources"]]
            if len(set(roots)) != len(roots):
                raise SOURCES.SourceRejected("Duplicate owned export roots")
        return project, etag, paths, roots

    def current_exports(self):
        # Include foreign/stopped native instances and legacy containers: they
        # are collision evidence, never resources this policy adopts/manages.
        native, _ = self.request("GET", "/1.0/instances?recursion=1&all-projects=true")
        legacy_authority = self.docker_list()
        if not isinstance(legacy_authority, dict) or not isinstance(legacy_authority.get("volumes"), list):
            raise SOURCES.SourceRejected("Legacy storage authority is unavailable")
        docker_root = SOURCES.canonical(legacy_authority.get("root"))
        legacy = legacy_authority.get("containers")
        if not isinstance(native, list) or not isinstance(legacy, list) or len(native) + len(legacy) > 4096:
            raise SOURCES.SourceRejected("Current host export authority is unavailable")
        exports = []
        for instance in native:
            if not isinstance(instance, dict) or not isinstance(instance.get("expanded_devices"), dict):
                raise SOURCES.SourceRejected("Expanded native export authority is unavailable")
            for device in instance["expanded_devices"].values():
                if not isinstance(device, dict):
                    raise SOURCES.SourceRejected("Native export authority is malformed")
                source = device.get("source")
                if device.get("type") == "disk" and isinstance(source, str) and source.startswith("/"):
                    exports.append(source)
        for container in legacy:
            if not isinstance(container, dict) or not isinstance(container.get("Mounts"), list):
                raise SOURCES.SourceRejected("Legacy export authority is unavailable")
            for mount in container["Mounts"]:
                if not isinstance(mount, dict) or not isinstance(mount.get("Type"), str):
                    raise SOURCES.SourceRejected("Legacy export authority is malformed")
                # Host backup readers commonly bind '/' read-only. That mount
                # cannot rename a catalog root or its parent through the bind,
                # and must never become authority to export '/' to a worker.
                # Require Docker's explicit boolean; unknown/writable roots
                # still fail canonical validation below. Other exports retain
                # the existing conservative collision checks.
                if mount["Type"] == "bind" and mount.get("Source") == "/" and mount.get("RW") is False:
                    continue
                if mount["Type"] in ("bind", "volume"):
                    exports.append(SOURCES.canonical(mount.get("Source")))
        # Local bind-backed named volumes expose their device tree too, despite
        # the container summary showing only DockerRootDir/volumes/.../_data.
        for volume in legacy_authority["volumes"]:
            if not isinstance(volume, dict) or not isinstance(volume.get("Driver"), str):
                raise SOURCES.SourceRejected("Legacy volume authority is malformed")
            options = volume.get("Options")
            if options is None:
                options = {}
            if not isinstance(options, dict):
                raise SOURCES.SourceRejected("Legacy volume options are unavailable")
            device = options.get("device")
            if isinstance(device, str) and device.startswith("/"):
                exports.append(SOURCES.canonical(device))
        return exports, docker_root

    def validated(self, path_id, paths, roots):
        pools, _ = self.request("GET", "/1.0/storage-pools?recursion=1")
        if not isinstance(pools, list) or len(pools) > 4096:
            raise SOURCES.SourceRejected("Native storage authority is unavailable")
        protected = list(self.protected_paths)
        for pool in pools:
            if not isinstance(pool, dict) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,63}", pool.get("name", "")) or \
                    not isinstance(pool.get("config"), dict):
                raise SOURCES.SourceRejected("Native storage authority is malformed")
            protected.append(str(Path(self.incus_dir) / "storage-pools" / pool["name"]))
            source = pool["config"].get("source", "")
            if isinstance(source, str) and source.startswith("/"):
                protected.append(source)
            elif pool.get("driver") == "dir":
                raise SOURCES.SourceRejected("Directory pool source is not authoritative")
        catalog = json.loads(self.read_authority(["admin", "host-mount-paths.v1.json"]))
        exports, docker_root = self.current_exports()
        sources = SOURCES.validate_sources(catalog, data_path=self.data_dir, incus_path=self.incus_dir,
            protected_paths=[*protected, docker_root], existing_exports=[*paths, *roots, *exports], mountinfo=self.mountinfo())
        selected = [record for record in sources if record["id"] == path_id]
        if len(selected) != 1:
            raise SOURCES.SourceRejected("Platform catalog path is missing or ambiguous")
        return selected[0]

    def result(self, selected):
        identity = hashlib.sha256(f'{selected["identity"][0]}:{selected["identity"][1]}'.encode()).hexdigest()
        return {"installation": self.installation, "project": self.project, "pathId": selected["id"],
                "sourcePath": selected["sourcePath"], "allowWrite": selected["allowWrite"], "sourceIdentity": identity}

    def ensure(self, payload):
        path_id = self.identity(payload)
        _, _, paths, roots = self.project_policy()
        selected = self.validated(path_id, paths, roots)
        # Recheck on the ETag snapshot actually submitted; preserve all unrelated
        # network/device/account policy and reject a changed source/catalog.
        project, etag, paths, roots = self.project_policy()
        if self.validated(self.identity(payload), paths, roots) != selected:
            raise SOURCES.SourceRejected("Catalog source or authority changed before allowlisting")
        source = selected["sourcePath"]
        updated_roots = sorted(set([*roots, source]))
        if len(updated_roots) > 4096:
            raise SOURCES.SourceRejected("Exact export reservation bound exceeded; operator review required")
        config = dict(project["config"])
        config["restricted.devices.disk.paths"] = ",".join(sorted(set([*paths, source])))
        config[OWNED_ROOTS] = json.dumps({"installation": self.installation, "sources": updated_roots}, separators=(",", ":"))
        if config != project["config"]:
            self.request("PUT", "/1.0/projects/" + quote(self.project),
                         {"config": config, "description": project.get("description", "")}, etag)
        return self.result(selected)

    def inspect(self, payload):
        path_id = self.identity(payload)
        _, _, paths, roots = self.project_policy()
        selected = self.validated(path_id, paths, roots)
        if selected["sourcePath"] not in paths or selected["sourcePath"] not in roots:
            raise SOURCES.SourceRejected("Catalog export is not allowlisted by this installation")
        return self.result(selected)

    def cleanup_worker_exports(self, payload):
        """Retry failed Incus stop cleanup, never detach a live/foreign export."""
        if not isinstance(payload, dict) or set(payload) != {"userId", "workerId", "incarnation"} or \
                not isinstance(payload["userId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", payload["userId"]) or \
                any(not isinstance(payload[k], str) or not SOURCES.UUID.fullmatch(payload[k]) for k in ("workerId", "incarnation")):
            raise SOURCES.SourceRejected("Exact ordinary worker identity and incarnation required for export cleanup")
        owner, worker_id, incarnation = (payload[k] for k in ("userId", "workerId", "incarnation"))
        if self.read_authority(["backup-installation-id"], 128).strip() != self.installation:
            raise SOURCES.SourceRejected("Installation identity changed; cleanup refused")
        records = json.loads(self.read_authority(["users", owner, "workers.json"]))
        workers = [w for w in records if isinstance(w, dict) and w.get("id") == worker_id] if isinstance(records, list) else []
        if len(workers) != 1 or len(records) > 4096 or workers[0].get("userId") != owner or \
                workers[0].get("runtimeKind") not in ("incus-vm", "legacy-docker") or \
                workers[0].get("status") not in ("active", "archived") or \
                any(k in workers[0] for k in ("kind", "administrativeKind")):
            raise SOURCES.SourceRejected("Current ordinary worker authority required; cleanup refused")
        instances, _ = self.request("GET", "/1.0/instances?recursion=1&project=" + quote(self.project))
        if not isinstance(instances, list) or len(instances) > 4096 or any(not isinstance(v, dict) or not isinstance(v.get("config"), dict) for v in instances):
            raise SOURCES.SourceRejected("Native worker inventory is unavailable; cleanup refused")
        matches = [v for v in instances if v["config"].get("user.agentor.id") == worker_id]
        if len(matches) != 1:
            raise SOURCES.SourceRejected("Native worker identity is missing or ambiguous; cleanup refused")
        baseline = matches[0]
        if workers[0]["runtimeKind"] == "legacy-docker":
            migration = workers[0].get("incusMigration", {})
            if not isinstance(migration, dict) or migration.get("destinationIncarnation") != incarnation or \
                    not isinstance(migration.get("nonce"), str) or not SOURCES.UUID.fullmatch(migration["nonce"]) or \
                    baseline["config"].get("user.agentor.recreation") != migration["nonce"]:
                raise SOURCES.SourceRejected("Staged migration destination is not authorized; cleanup refused")
        name = baseline.get("name", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,63}", name):
            raise SOURCES.SourceRejected("Native worker name is invalid; cleanup refused")
        endpoint = "/1.0/instances/" + quote(name) + "?project=" + quote(self.project)

        def stopped():
            current, _ = self.request("GET", endpoint)
            config = current.get("config", {})
            state, _ = self.request("GET", "/1.0/instances/" + quote(name) + "/state?project=" + quote(self.project))
            if current != baseline or current.get("type") != "virtual-machine" or current.get("profiles") != [] or \
                    config.get("user.agentor.installation") != self.installation or config.get("user.agentor.owner") != owner or \
                    config.get("volatile.uuid") != incarnation or config.get("user.agentor.administrative") or \
                    current.get("status") != "Stopped" or state.get("status") != "Stopped" or state.get("pid", 0) != 0:
                raise SOURCES.SourceRejected("VM is live, replaced or changed; cleanup refused and source data retained")

        stopped()
        devices = baseline.get("devices", {})
        expanded = baseline.get("expanded_devices", devices)
        if not isinstance(devices, dict) or not isinstance(expanded, dict) or any(not isinstance(v, dict) for v in expanded.values()):
            raise SOURCES.SourceRejected("Native device authority is malformed; cleanup refused")
        identities = json.loads(baseline["config"].get("user.agentor.host-mounts", "[]"))
        keys = {k for k in expanded if k.startswith("hm")}
        if not isinstance(identities, list) or len(identities) > 4096 or len(identities) != len(keys) or \
                any(not isinstance(i, dict) or set(i) != {"key", "pathId", "sourceIdentity"} or \
                    not all(isinstance(i[k], str) for k in ("key", "pathId", "sourceIdentity")) or \
                    not re.fullmatch(r"[0-9a-f]{64}", i["sourceIdentity"]) for i in identities) or \
                {i["key"] for i in identities} != keys:
            raise SOURCES.SourceRejected("Applied host export identities are ambiguous; cleanup refused")
        _, _, _, roots = self.project_policy()
        planned = []
        for identity in identities:
            key, path_id = identity["key"], identity["pathId"]
            if not isinstance(key, str) or not re.fullmatch(r"hm[0-9a-f]{6}", key) or \
                    not isinstance(path_id, str) or not SOURCES.UUID.fullmatch(path_id) or devices.get(key) != expanded[key]:
                raise SOURCES.SourceRejected("Applied host export key is invalid; cleanup refused")
            device = devices[key]
            target = device.get("path", "")
            if device.get("type") != "disk" or not isinstance(target, str) or not target.startswith("/") or \
                    target == "/" or os.path.normpath(target) != target or any(x in target for x in ("\0", "\\")):
                raise SOURCES.SourceRejected("Applied host export target is invalid; cleanup refused")
            expected_key = "hm" + hashlib.sha256(f"{path_id}:{target}".encode()).hexdigest()[:6]
            # Reservations survive catalog/grant removal. Cleanup revokes an
            # already-applied export; it must never regrant a removed source.
            if key != expected_key or SOURCES.canonical(device.get("source")) not in roots:
                raise SOURCES.SourceRejected("Applied host export source changed; cleanup refused")
            encoded = ("disk." + key + "." + target[1:]).replace("-", "--").replace("/", "-")
            stage = Path(self.incus_dir) / "devices" / (self.project + "_" + name) / encoded
            planned.append((stage, identity["sourceIdentity"]))

        def mounts():
            # The hardened service has a private mount namespace; inspect and
            # detach in the host namespace where Incus created the export.
            text = self.host_mountinfo()
            SOURCES.alias_mounts(text)  # Validate the bounded, complete mount table.
            return [re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), row.split()[4]) for row in text.splitlines()]

        cleaned = 0
        deadline = time.monotonic() + 10
        for stage, expected in planned:
            if time.monotonic() >= deadline:
                raise SOURCES.SourceRejected("Export cleanup exceeded its 10-second work budget; cleanup unconfirmed, source data retained")
            current_mounts = mounts()
            if str(stage) not in current_mounts:
                continue
            if current_mounts.count(str(stage)) != 1 or any(p.startswith(str(stage) + "/") for p in current_mounts) or \
                    hashlib.sha256(":".join(map(str, SOURCES.directory_identity(str(stage)))).encode()).hexdigest() != expected:
                raise SOURCES.SourceRejected("Stale export identity or nested mounts are ambiguous; cleanup refused")
            stopped()
            self.unmount(stage)
            stopped()
            if str(stage) in mounts():
                raise SOURCES.SourceRejected("Host export cleanup is unconfirmed; source data retained")
            cleaned += 1
        return {"installation": self.installation, "project": self.project, "userId": owner,
                "workerId": worker_id, "incarnation": incarnation, "cleaned": cleaned, "cleanupConfirmed": True}

    def account_sources(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"userId", "workerId"} or \
                not isinstance(payload["userId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", payload["userId"]) or \
                not isinstance(payload["workerId"], str) or not SOURCES.UUID.fullmatch(payload["workerId"]):
            raise SOURCES.SourceRejected("Only safe account and ordinary worker IDs are accepted")
        owner, worker_id = payload["userId"], payload["workerId"]
        if self.read_authority(["backup-installation-id"], 128).strip() != self.installation:
            raise SOURCES.SourceRejected("Installation identity changed")
        records = json.loads(self.read_authority(["users", owner, "workers.json"]))
        if not isinstance(records, list) or len(records) > 4096 or any(not isinstance(record, dict) for record in records):
            raise SOURCES.SourceRejected("Ordinary worker authority is unavailable")
        selected = [record for record in records if record.get("id") == worker_id]
        if len(selected) != 1:
            raise SOURCES.SourceRejected("Ordinary worker identity is missing or ambiguous")
        worker = selected[0]
        if worker.get("userId") != owner or worker.get("status") not in ("active", "archived") or \
                worker.get("runtimeKind") not in (None, "legacy-docker", "incus-vm") or \
                worker.get("deletionPending", False) is not False or "kind" in worker:
            raise SOURCES.SourceRejected("Account shares require a current owned ordinary worker")
        # These exact leaves are intentionally inside canonical account DATA,
        # unlike user catalog exports. Never share DATA/users or read secrets.
        sources = [str(Path(self.data_dir) / "users" / owner / role)
                   for role in ("credentials", "kilo/config", "kilo/data")]
        identities = [SOURCES.directory_identity(source) for source in sources]
        if len(set(identities)) != 3:
            raise SOURCES.SourceRejected("Fixed account directory identities are ambiguous")
        return worker, sources, identities

    def ensure_account_shares(self, payload):
        selected = self.account_sources(payload)
        self.project_policy()
        # Repeat authority and no-follow source proofs on the ETag actually
        # submitted. Existing host-mount reservations/network policy survive.
        project, etag, paths, _roots = self.project_policy()
        if self.account_sources(payload) != selected:
            raise SOURCES.SourceRejected("Account worker or source identity changed before allowlisting")
        updated = sorted(set([*paths, *selected[1]]))
        if len(updated) > 4096:
            raise SOURCES.SourceRejected("Exact account export bound exceeded; operator review required")
        config = dict(project["config"])
        config["restricted.devices.disk.paths"] = ",".join(updated)
        if config != project["config"]:
            self.request("PUT", "/1.0/projects/" + quote(self.project),
                         {"config": config, "description": project.get("description", "")}, etag)
        return {"installation": self.installation, "project": self.project, "userId": payload["userId"],
                "workerId": payload["workerId"], "sourcePaths": selected[1]}
