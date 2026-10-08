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
from pathlib import Path
import re
from urllib.parse import quote


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCES = sibling("incus-host-mount-sources")
NETWORK = sibling("incus-managed-network-policy")
OWNED_ROOTS = "user.agentor.host-mount-roots"


class HostMountPolicy:
    def __init__(self, data_dir, installation, project, incus_dir, protected_paths, request, docker_list,
                 mountinfo=lambda: Path("/proc/self/mountinfo").read_text()):
        self.data_dir = SOURCES.canonical(data_dir)
        self.installation, self.project = installation, project
        self.incus_dir = SOURCES.canonical(incus_dir)
        self.protected_paths = [SOURCES.canonical(path) for path in protected_paths]
        self.request, self.docker_list, self.mountinfo = request, docker_list, mountinfo
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
