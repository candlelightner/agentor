import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts/incus-managed-network-policy.py"
SPEC = importlib.util.spec_from_file_location("incus_network_policy", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Missing(Exception):
    status_code = 404


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="incus-network-policy-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.installation, self.network_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.owner = "historical-owner_123"
        (self.root / "backup-installation-id").write_text(self.installation)
        directory = self.root / "users" / self.owner
        directory.mkdir(parents=True)
        self.records = directory / "managed-networks.json"
        self.records.write_text(json.dumps([{"id": self.network_id, "userId": self.owner,
                                           "dockerName": f"agentor-managed-{self.network_id}"}]))
        self.project = {"name": "agentor", "description": "keep description", "config": {
            "restricted": "true", "features.networks": "false", "restricted.devices.nic": "managed",
            "restricted.networks.access": "approved,workers", "restricted.devices.pci": "block",
            "restricted.devices.disk.paths": "/srv/approved-account"}}
        self.network = None
        self.calls, self.ports = [], []

        def request(method, path, body=None, etag=None):
            self.calls.append((method, path, body, etag))
            if path.startswith("/1.0/projects/"):
                if method == "PUT":
                    self.assertEqual(etag, "project-etag")
                    self.project.update(body)
                return json.loads(json.dumps(self.project)), "project-etag"
            if path == "/1.0/networks" and method == "POST":
                self.network = {**body, "managed": True, "used_by": []}
                self.network["config"]["ipv4.address"] = "10.200.30.1/24"
                return {}, None
            if self.network is None:
                raise Missing()
            if method == "PUT":
                self.assertEqual(etag, "network-etag")
                self.network.update(body)
            if method == "DELETE":
                self.network = None
                return {}, None
            return json.loads(json.dumps(self.network)), "network-etag"

        self.policy = MODULE.ManagedNetworkPolicy(str(self.root), self.installation,
                                                   "agentor", "workers", request, lambda _: self.ports)
        self.payload = {"userId": self.owner, "networkId": self.network_id}

    def test_ensure_and_remove_are_bounded_idempotent_and_preserve_unrelated_restrictions(self):
        original = dict(self.project["config"])
        result = self.policy.ensure(self.payload)
        self.assertEqual(result["subnet"], "10.200.30.0/24")
        self.assertEqual(result["dockerRange"], "10.200.30.0/26")
        self.assertEqual(result["gateway"], "10.200.30.1")
        self.assertLessEqual(len(result["name"]), 15)
        self.assertEqual(self.network["config"]["ipv4.dhcp.ranges"], "10.200.30.128-10.200.30.254")
        self.assertEqual(self.policy.ensure(self.payload), result)
        self.assertEqual(len([call for call in self.calls if call[0] == "POST"]), 1)
        for key, value in original.items():
            if key != "restricted.networks.access":
                self.assertEqual(self.project["config"][key], value)
        self.records.unlink()  # exact resource metadata remains deletion authority
        self.policy.remove(self.payload)
        self.assertIsNone(self.network)
        self.assertEqual(self.project["config"], original)
        self.policy.remove(self.payload)

    def test_caller_cannot_choose_host_paths_projects_config_or_names(self):
        for extra in ["path", "project", "name", "config", "cidr", "source"]:
            with self.assertRaises(MODULE.PolicyError):
                self.policy.ensure({**self.payload, extra: "/etc"})
        for owner in ["../root", "owner.name", "a/b", "a,b", "", 1]:
            with self.assertRaises(MODULE.PolicyError):
                self.policy.ensure({**self.payload, "userId": owner})
        self.assertEqual(self.calls, [])

    def test_platform_record_or_installation_corruption_fails_closed(self):
        for records in [{}, [{"id": self.network_id, "userId": "foreign"}],
                        [{"id": self.network_id, "userId": self.owner, "dockerName": "foreign"}]]:
            self.records.write_text(json.dumps(records))
            with self.assertRaises(MODULE.PolicyError):
                self.policy.ensure(self.payload)
        (self.root / "backup-installation-id").write_text(str(uuid.uuid4()))
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])

    def test_no_follow_bounded_platform_authority_reads(self):
        self.records.unlink()
        os.mkfifo(self.records)
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)
        self.records.unlink()
        self.records.symlink_to(self.root / "backup-installation-id")
        with self.assertRaises(OSError):
            self.policy.ensure(self.payload)
        self.records.unlink()
        self.records.write_bytes(b"x" * (1024 * 1024 + 1))
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)
        self.records.unlink()
        self.records.parent.rmdir()
        self.records.parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])

    def test_foreign_native_metadata_and_unrestricted_projects_are_never_adopted(self):
        self.policy.ensure(self.payload)
        self.network["config"]["user.agentor.owner"] = "foreign"
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)
        with self.assertRaises(MODULE.PolicyError):
            self.policy.remove(self.payload)
        self.assertFalse(any(call[0] == "DELETE" for call in self.calls))
        self.project["config"]["restricted"] = "false"
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)

    def test_native_references_and_kernel_ports_prevent_deletion(self):
        self.policy.ensure(self.payload)
        self.network["used_by"] = ["/1.0/instances/worker?project=agentor"]
        with self.assertRaises(MODULE.PolicyError):
            self.policy.remove(self.payload)
        self.network["used_by"] = []
        self.ports.append("docker-veth")
        with self.assertRaises(MODULE.PolicyError):
            self.policy.remove(self.payload)
        self.assertFalse(any(call[0] == "DELETE" for call in self.calls))

    def test_current_snapshot_cannot_replace_owned_preflight_before_network_put(self):
        original = self.policy.request
        for scenario in ("foreign", "referenced", "ports", "subnet", "no-etag"):
            self.network = None
            self.calls.clear()
            reads = 0

            def replacement(method, path, body=None, etag=None):
                nonlocal reads
                metadata, returned_etag = original(method, path, body, etag)
                if method == "GET" and path.startswith("/1.0/networks/"):
                    reads += 1
                    if reads == 2:
                        if scenario == "foreign":
                            metadata["config"]["user.agentor.owner"] = "foreign"
                        if scenario == "referenced":
                            metadata["used_by"] = ["/1.0/instances/foreign"]
                        if scenario == "ports":
                            self.ports.append("new-port")
                        if scenario == "subnet":
                            metadata["config"]["ipv4.address"] = "10.201.30.1/24"
                        if scenario == "no-etag":
                            returned_etag = None
                return metadata, returned_etag

            self.policy.request = replacement
            with self.assertRaises(MODULE.PolicyError):
                self.policy.ensure(self.payload)
            self.assertFalse(any(call[0] == "PUT" for call in self.calls))
            self.ports.clear()
        self.policy.request = original

    def test_owned_metadata_cannot_bless_raw_routes_or_other_native_privileged_config(self):
        self.policy.ensure(self.payload)
        for key, value in [("raw.dnsmasq", "conf-file=/etc/private"), ("bridge.driver", "openvswitch"),
                           ("ipv4.routes", "0.0.0.0/0"), ("bridge.external_interfaces", "enp0s1")]:
            self.network["config"][key] = value
            with self.assertRaises(MODULE.PolicyError):
                self.policy.ensure(self.payload)
            with self.assertRaises(MODULE.PolicyError):
                self.policy.remove(self.payload)
            del self.network["config"][key]


if __name__ == "__main__":
    unittest.main()
