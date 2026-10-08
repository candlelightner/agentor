import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import hashlib
import http.client
import ssl
import subprocess
import threading
import unittest
import uuid
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("incus_host_mount_policy",
    Path(__file__).resolve().parents[2] / "scripts/incus-host-mount-policy.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="incus-host-policy-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.data = self.root / "data"; (self.data / "admin").mkdir(parents=True)
        for name in ["native", "share", "credentials", "pool", "other"]:
            (self.root / name).mkdir()
        self.installation, self.path_id = str(uuid.uuid4()), str(uuid.uuid4())
        (self.data / "backup-installation-id").write_text(self.installation)
        self.catalog = [{"schemaVersion": 1, "id": self.path_id, "sourcePath": str(self.root / "share"), "allowWrite": False}]
        self.persist()
        self.project = {"name": "agentor", "description": "keep description", "config": {
            "restricted": "true", "restricted.devices.disk": "allow", "restricted.devices.disk.paths": str(self.root / "credentials"),
            "restricted.devices.nic": "managed", "restricted.networks.access": "workers", "restricted.devices.pci": "block"}}
        self.native, self.legacy, self.calls = [], [], []
        self.pools = [{"name": "default", "driver": "dir", "config": {"source": str(self.root / "pool")}}]
        self.project_reads, self.on_project_read, self.etag = 0, lambda _: None, "project-etag"

        def request(method, path, body=None, etag=None):
            self.calls.append((method, path, body, etag))
            if path == "/1.0/projects/agentor":
                if method == "GET":
                    self.project_reads += 1; self.on_project_read(self.project_reads)
                if method == "PUT":
                    self.assertEqual(etag, self.etag); self.project.update(copy.deepcopy(body))
                return copy.deepcopy(self.project), self.etag
            if path == "/1.0/instances?recursion=1&all-projects=true":
                return copy.deepcopy(self.native), None
            if path == "/1.0/storage-pools?recursion=1":
                return copy.deepcopy(self.pools), None
            raise AssertionError("Unexpected native endpoint " + path)

        self.docker_root, self.volumes = str(self.root / "docker-state"), []
        self.policy = MODULE.HostMountPolicy(str(self.data), self.installation, "agentor", str(self.root / "native"),
            [str(self.root / "credentials")], request, lambda: {"root": self.docker_root,
                "containers": copy.deepcopy(self.legacy), "volumes": copy.deepcopy(self.volumes)},
            lambda: "1 0 8:1 / / rw - ext4 /dev/vda1 rw\n")
        self.payload = {"pathId": self.path_id}
        self.owner, self.worker_id = "account", str(uuid.uuid4())
        self.account_payload = {"userId": self.owner, "workerId": self.worker_id}
        self.account_paths = [self.data / "users" / self.owner / role for role in ("credentials", "kilo/config", "kilo/data")]
        for path in self.account_paths: path.mkdir(parents=True)
        self.worker_file = self.data / "users" / self.owner / "workers.json"
        self.worker = {"id": self.worker_id, "userId": self.owner, "runtimeKind": "incus-vm", "status": "active",
                       "displayName": "Ordinary account fixture", "createdAt": "2026-10-08T00:00:00Z", "updatedAt": "2026-10-08T00:00:00Z"}
        self.worker_file.write_text(json.dumps([self.worker]))

    def persist(self):
        (self.data / "admin" / "host-mount-paths.v1.json").write_text(json.dumps(self.catalog))

    def mutations(self):
        return [call for call in self.calls if call[0] != "GET"]

    def test_idempotent_exact_allowlist_preserves_accounts_and_unrelated_restrictions(self):
        original = copy.deepcopy(self.project)
        result = self.policy.ensure(self.payload)
        self.assertEqual(result, {"installation": self.installation, "project": "agentor", "pathId": self.path_id,
            "sourcePath": str(self.root / "share"), "allowWrite": False, "sourceIdentity": result["sourceIdentity"]})
        self.assertRegex(result["sourceIdentity"], r"^[0-9a-f]{64}$")
        self.assertEqual(self.policy.ensure(self.payload), result)
        self.assertEqual(self.policy.inspect(self.payload), result)
        self.assertEqual(len(self.mutations()), 1)
        self.assertEqual(self.project["description"], original["description"])
        for key, value in original["config"].items():
            if key != "restricted.devices.disk.paths": self.assertEqual(self.project["config"][key], value)
        self.assertEqual(set(self.project["config"]["restricted.devices.disk.paths"].split(",")),
                         {str(self.root / "credentials"), str(self.root / "share")})

    def test_read_only_inspect_never_regrants_missing_export(self):
        with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.inspect(self.payload)
        self.assertEqual(self.mutations(), [])

    def test_only_known_catalog_id_can_request_export(self):
        for payload in [{}, {"pathId": "../foreign"}, {"pathId": self.path_id, "source": "/etc"},
                        {"pathId": self.path_id, "project": "default"}, {"pathId": self.path_id, "allowWrite": True},
                        {"pathId": str(uuid.uuid4())}]:
            with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure(payload)
        self.assertEqual(self.mutations(), [])

    def test_actual_storage_credentials_and_symlink_alias_are_denied(self):
        (self.root / "alias").symlink_to(self.root / "other", target_is_directory=True)
        for source in [str(self.root / "pool"), str(self.root / "credentials"), str(self.root / "alias"), str(self.data)]:
            self.catalog[0]["sourcePath"] = source; self.persist()
            with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])

    def test_stale_native_legacy_and_pending_allowlist_ancestors_are_denied(self):
        nested = self.root / "share" / "nested"; nested.mkdir()
        self.catalog[0]["sourcePath"] = str(nested); self.persist()
        for kind in ["native", "legacy", "pending"]:
            with self.subTest(kind=kind):
                self.native, self.legacy = [], []
                self.project["config"]["restricted.devices.disk.paths"] = str(self.root / "credentials")
                if kind == "native": self.native = [{"expanded_devices": {"stale": {"type": "disk", "source": str(nested.parent)}}}]
                if kind == "legacy": self.legacy = [{"Mounts": [{"Type": "bind", "Source": str(nested.parent)}]}]
                if kind == "pending": self.project["config"]["restricted.devices.disk.paths"] += "," + str(nested.parent)
                with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])

    def test_deleted_catalog_export_root_stays_reserved_without_inventory_proving_request_settlement(self):
        self.policy.ensure(self.payload)
        nested = self.root / "share" / "nested"; nested.mkdir()
        self.catalog = [{**self.catalog[0], "id": str(uuid.uuid4()), "sourcePath": str(nested)}]; self.persist()
        # Even operator removal from disk.paths is not proof that a prior
        # accepted create/export has settled. Keep the owned collision root.
        self.project["config"]["restricted.devices.disk.paths"] = str(self.root / "credentials")
        with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure({"pathId": self.catalog[0]["id"]})
        self.assertEqual(len(self.mutations()), 1)

    def test_existing_export_symlink_alias_cannot_authorize_a_descendant(self):
        nested = self.root / "share" / "nested"; nested.mkdir()
        alias = self.root / "alias"; alias.symlink_to(nested.parent, target_is_directory=True)
        self.catalog[0]["sourcePath"] = str(nested); self.persist()
        for kind in ["native", "legacy"]:
            self.native, self.legacy = [], []
            if kind == "native": self.native = [{"expanded_devices": {"disk": {"type": "disk", "source": str(alias)}}}]
            else: self.legacy = [{"Mounts": [{"Type": "bind", "Source": str(alias)}]}]
            with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])

    def test_custom_docker_root_and_bind_backed_named_volume_are_protected(self):
        self.docker_root = str(self.root / "share")
        with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure(self.payload)
        self.docker_root = str(self.root / "docker-state")
        nested = self.root / "share" / "nested"; nested.mkdir()
        self.catalog[0]["sourcePath"] = str(nested); self.persist()
        self.volumes = [{"Driver": "local", "Options": {"type": "none", "o": "bind", "device": str(nested.parent)}}]
        with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])

    def test_second_snapshot_revalidates_source_identity_and_preserves_new_operator_settings(self):
        def replace(read):
            if read == 2:
                source = self.root / "share"; source.rename(self.root / "previous-share"); source.mkdir()
        self.on_project_read = replace
        with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])
        self.project_reads = 0
        def update(read):
            if read == 2:
                self.project["config"]["restricted.networks.access"] = "workers,operator-bridge"; self.etag = "updated-etag"
        self.on_project_read = update
        self.policy.ensure(self.payload)
        self.assertEqual(self.project["config"]["restricted.networks.access"], "workers,operator-bridge")

    def test_unavailable_exports_etag_or_foreign_owned_policy_never_become_empty_authority(self):
        for kind in ["native", "legacy", "pools", "etag", "owner"]:
            with self.subTest(kind=kind):
                self.native, self.legacy, self.etag = [], [], "project-etag"
                self.pools = [{"name": "default", "driver": "dir", "config": {"source": str(self.root / "pool")}}]
                self.project["config"].pop(MODULE.OWNED_ROOTS, None)
                if kind == "native": self.native = [{"devices": {}}]
                if kind == "legacy": self.legacy = [{}]
                if kind == "pools": self.pools = None
                if kind == "etag": self.etag = None
                if kind == "owner": self.project["config"][MODULE.OWNED_ROOTS] = json.dumps({"installation": str(uuid.uuid4()), "sources": []})
                with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])

    def test_account_shares_are_exact_idempotent_and_do_not_modify_canonical_data_or_other_policy(self):
        roots = {"installation": self.installation, "sources": [str(self.root / "share")]}
        self.project["config"][MODULE.OWNED_ROOTS] = json.dumps(roots)
        original = copy.deepcopy(self.project)
        secret = self.account_paths[0] / "secret"; secret.write_text("SECRET-NOT-READ")
        before = {str(path): (path.stat().st_mtime_ns, path.stat().st_mode, path.stat().st_uid) for path in self.data.rglob("*")}
        with patch.object(MODULE.NETWORK, "read_bounded", wraps=MODULE.NETWORK.read_bounded) as reads:
            result = self.policy.ensure_account_shares(self.account_payload)
        self.assertTrue(all(call.args[1] in (["backup-installation-id"], ["users", self.owner, "workers.json"]) for call in reads.call_args_list))
        self.assertEqual(result, {"installation": self.installation, "project": "agentor", **self.account_payload,
                                  "sourcePaths": list(map(str, self.account_paths))})
        self.assertNotIn("SECRET-NOT-READ", json.dumps(result))
        self.assertEqual(self.policy.ensure_account_shares(self.account_payload), result)
        self.assertEqual(len(self.mutations()), 1)
        self.assertEqual(self.project["description"], original["description"])
        for key, value in original["config"].items():
            if key != "restricted.devices.disk.paths": self.assertEqual(self.project["config"][key], value)
        self.assertEqual(set(self.project["config"]["restricted.devices.disk.paths"].split(",")),
                         {str(self.root / "credentials"), *map(str, self.account_paths)})
        self.assertNotIn(str(self.data / "users"), self.project["config"]["restricted.devices.disk.paths"].split(","))
        self.assertEqual(before, {str(path): (path.stat().st_mtime_ns, path.stat().st_mode, path.stat().st_uid) for path in self.data.rglob("*")})

    def test_account_shares_accept_recognized_ordinary_legacy_and_archived_records_without_migration(self):
        for runtime in (None, "legacy-docker", "incus-vm"):
            record = {**self.worker, "status": "archived"}
            if runtime is None: del record["runtimeKind"]
            else: record["runtimeKind"] = runtime
            self.worker_file.write_text(json.dumps([record]))
            self.policy.ensure_account_shares(self.account_payload)
            self.assertEqual(json.loads(self.worker_file.read_text()), [record])
        initial_import = {**self.worker, "incusRecreation": {"nonce": str(uuid.uuid4()), "initialCreate": True, "importIncomplete": True}}
        self.worker_file.write_text(json.dumps([initial_import]))
        self.policy.ensure_account_shares(self.account_payload)
        self.assertEqual(json.loads(self.worker_file.read_text()), [initial_import])

    def test_account_requests_never_accept_caller_paths_project_devices_or_extra_authority(self):
        for payload in ({}, [], {**self.account_payload, "source": "/etc"}, {**self.account_payload, "project": "default"},
                        {**self.account_payload, "devices": {}}, {**self.account_payload, "userId": "../other"},
                        {**self.account_payload, "workerId": "../worker"}):
            with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure_account_shares(payload)
        self.assertEqual(self.calls, [])

    def test_account_worker_must_be_present_unambiguous_owned_and_not_admin_or_deleting(self):
        for records in ([], [self.worker, self.worker], [{**self.worker, "userId": "foreign"}],
                        [{**self.worker, "kind": "administrative"}], [{**self.worker, "deletionPending": True}],
                        [{**self.worker, "runtimeKind": "foreign"}], [{**self.worker, "status": "unknown"}]):
            self.worker_file.write_text(json.dumps(records))
            with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure_account_shares(self.account_payload)
        self.assertEqual(self.mutations(), [])

    def test_account_directories_must_exist_without_symlink_components_or_secret_file_reads(self):
        source = self.account_paths[0]; source.rmdir()
        with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure_account_shares(self.account_payload)
        self.assertFalse(source.exists())
        source.symlink_to(self.root / "credentials", target_is_directory=True)
        with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure_account_shares(self.account_payload)
        self.assertEqual(self.mutations(), [])

    def test_second_account_etag_snapshot_rechecks_worker_installation_source_and_preserves_operator_change(self):
        for drift in ("worker", "installation", "source"):
            self.project_reads = 0
            def change(read):
                if read != 2: return
                if drift == "worker": self.worker_file.write_text(json.dumps([{**self.worker, "deletionPending": True}]))
                if drift == "installation": (self.data / "backup-installation-id").write_text(str(uuid.uuid4()))
                if drift == "source": self.account_paths[1].rename(self.account_paths[1].with_name("previous")); self.account_paths[1].mkdir()
            self.on_project_read = change
            with self.assertRaises(MODULE.SOURCES.SourceRejected): self.policy.ensure_account_shares(self.account_payload)
            self.worker_file.write_text(json.dumps([self.worker])); (self.data / "backup-installation-id").write_text(self.installation)
        self.assertEqual(self.mutations(), [])
        self.project_reads = 0
        def update(read):
            if read == 2: self.etag = "latest-etag"; self.project["config"]["restricted.networks.access"] = "workers,approved-other"
        self.on_project_read = update
        self.policy.ensure_account_shares(self.account_payload)
        self.assertEqual(self.mutations()[0][3], "latest-etag")
        self.assertEqual(self.project["config"]["restricted.networks.access"], "workers,approved-other")


@unittest.skipUnless(os.environ.get("INCUS_HOST_MOUNT_POLICY_TEST") == "true",
                     "Explicit serial disposable host policy gate")
class HostPolicyLiveTests(unittest.TestCase):
    def test_native_catalog_allowlist_pinned_mtls_and_exact_restoration(self):
        self.assertEqual(os.geteuid(), 0)
        service = MODULE.sibling("agentor-incus-network-service")
        scratch = Path(tempfile.mkdtemp(prefix="agentor-native-host-mount-"))
        data = scratch / "data"; (data / "admin").mkdir(parents=True)
        export = scratch / "export"; export.mkdir()
        installation, path_id = str(uuid.uuid4()), str(uuid.uuid4())
        (data / "backup-installation-id").write_text(installation)
        catalog_file = data / "admin" / "host-mount-paths.v1.json"
        record = {"schemaVersion": 1, "id": path_id, "sourcePath": str(export), "allowWrite": False}
        catalog_file.write_text(json.dumps([record]))
        request = service.incus_request("/var/lib/incus/unix.socket")
        project = os.environ["INCUS_HOST_PROJECT"]
        original, _ = request("GET", "/1.0/projects/" + project)
        selected, completed, server, thread = None, False, None, None
        print("Exact host mount policy fixture:", scratch, installation, path_id, flush=True)
        try:
            for identity in ["server", "client"]:
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(data / (identity + ".key")), "-out", str(data / (identity + ".crt")),
                    "-days", "1", "-subj", "/CN=" + ("localhost" if identity == "server" else identity),
                    "-addext", "subjectAltName=DNS:localhost"], check=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                (data / (identity + ".key")).chmod(0o600)
            network_policy = service.POLICY.ManagedNetworkPolicy(str(data), installation, project,
                os.environ["INCUS_HOST_PRIMARY"], request)
            mounts = MODULE.HostMountPolicy(str(data), installation, project, "/var/lib/incus",
                [str(data / "server.key"), str(data / "client.key")], request,
                service.docker_inventory("/var/run/docker.sock"))
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(data / "server.crt", data / "server.key")
            tls.load_verify_locations(cafile=data / "client.crt"); tls.verify_mode = ssl.CERT_REQUIRED
            fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert((data / "client.crt").read_text())).hexdigest()
            server = service.TlsPolicyServer(("127.0.0.1", 0), service.handler(network_policy, fingerprint, mounts), tls)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True); thread.start()
            client_tls = ssl.create_default_context(cafile=data / "server.crt")
            client_tls.load_cert_chain(data / "client.crt", data / "client.key")

            def call(endpoint, payload, expected=200):
                connection = http.client.HTTPSConnection("localhost", server.server_address[1], timeout=45, context=client_tls)
                try:
                    connection.request("POST", "/v1/host-mounts/" + endpoint, json.dumps(payload))
                    response = connection.getresponse(); result = json.loads(response.read())
                    self.assertEqual(response.status, expected, result)
                    return result["metadata"]
                finally: connection.close()

            payload = {"pathId": path_id}
            call("inspect", payload, 409)
            selected = call("ensure", payload)
            self.assertEqual(selected["sourcePath"], str(export)); self.assertFalse(selected["allowWrite"])
            self.assertEqual(call("ensure", payload), selected)
            self.assertEqual(call("inspect", payload), selected)
            current, _ = request("GET", "/1.0/projects/" + project)
            for key, value in original["config"].items():
                if key not in ["restricted.devices.disk.paths", MODULE.OWNED_ROOTS]: self.assertEqual(current["config"][key], value)
            self.assertEqual(set(current["config"]["restricted.devices.disk.paths"].split(",")),
                {*original["config"]["restricted.devices.disk.paths"].split(","), str(export)})
            for payload in [{"pathId": path_id, "source": "/etc"}, {"pathId": path_id, "allowWrite": True},
                            {"pathId": str(uuid.uuid4())}]: call("ensure", payload, 409)
            catalog_file.write_text(json.dumps([{**record, "sourcePath": "/var/lib/incus"}]))
            call("ensure", {"pathId": path_id}, 409)
            catalog_file.write_text(json.dumps([record]))
            self.assertEqual(call("inspect", {"pathId": path_id}), selected)
            after, _ = request("GET", "/1.0/projects/" + project)
            self.assertEqual(after["config"], current["config"])
            completed = True
        finally:
            if server: server.shutdown(); server.server_close()
            if thread: thread.join(2)
            if completed:
                # All fixture requests acknowledged; no VM/create is submitted.
                # Restore only our exact policy fields on a current ETag, never
                # overwrite unrelated operator changes or unknown request state.
                latest, etag = request("GET", "/1.0/projects/" + project)
                self.assertEqual(latest["config"]["restricted.devices.disk.paths"], current["config"]["restricted.devices.disk.paths"])
                self.assertEqual(latest["config"][MODULE.OWNED_ROOTS], current["config"][MODULE.OWNED_ROOTS])
                config = dict(latest["config"])
                for key in ["restricted.devices.disk.paths", MODULE.OWNED_ROOTS]:
                    if key in original["config"]: config[key] = original["config"][key]
                    else: config.pop(key, None)
                request("PUT", "/1.0/projects/" + project, {"config": config, "description": latest.get("description", "")}, etag)
                restored, _ = request("GET", "/1.0/projects/" + project)
                self.assertEqual(restored["config"], config)
                import shutil
                shutil.rmtree(scratch)
                print("Exact host export policy restored; fixture removed", flush=True)
            else:
                print("Host export policy failure authority retained:", scratch, installation, path_id, flush=True)


if __name__ == "__main__": unittest.main()
