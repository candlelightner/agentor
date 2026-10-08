"""Deterministic checker preflights only; not live host/setup acceptance."""
import contextlib
import copy
import io
import ipaddress
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/check-incus-host.sh"
CODE = SCRIPT.read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
CHECKER = types.ModuleType("checker_test")
with patch.object(sys, "argv", ["checker", str(SCRIPT)]):
    exec(compile(CODE, str(SCRIPT), "exec"), CHECKER.__dict__)


class CheckerTests(unittest.TestCase):
    def project(self):
        return {"name": "agentor-private", "config": {
            "restricted": "true", "features.images": "true", "features.storage.volumes": "true", "features.networks": "false",
            "restricted.devices.nic": "managed", "restricted.devices.disk": "allow",
            "restricted.networks.access": "workers", "restricted.devices.disk.paths": "/srv/agentor/users/account/credentials"}}

    def test_versions_require_fixed_lts_or_fixed_rolling_transport(self):
        for version in ("6.0.6", "6.0.7", "6.10", "7.0.0", "6.0.6-ubuntu1"):
            CHECKER.supported(version)
        for version in ("6.0.5", "6.1.0", "6.9", "unknown"):
            with self.assertRaises(ValueError):
                CHECKER.supported(version)

    def test_endpoint_disallows_wildcards_credentials_and_extra_authority(self):
        CHECKER.endpoint("https://incus.internal:8443")
        for value in ("http://incus", "https://0.0.0.0:8443", "https://[::]:8443", "https://user:secret@incus", "https://incus/1.0", "https://incus?project=default"):
            with self.assertRaises(ValueError):
                CHECKER.endpoint(value)

    def test_project_preserves_restrictions_and_exact_host_exports(self):
        CHECKER.project_policy(self.project(), "agentor-private", "workers")
        for field, value in (("restricted", "false"), ("features.images", "false"), ("features.networks", "true"),
                             ("restricted.devices.nic", "allow"), ("restricted.devices.pci", "allow"), ("restricted.devices.proxy", "allow"),
                             ("restricted.devices.disk.paths", "/"), ("restricted.devices.disk.paths", "/var/lib"),
                             ("restricted.devices.disk.paths", "/var/lib/incus/cache"), ("restricted.devices.disk.paths", "/etc")):
            project = self.project(); project["config"][field] = value
            with self.assertRaises(ValueError):
                CHECKER.project_policy(project, "agentor-private", "workers")

    def test_certificate_is_restricted_to_exact_single_project(self):
        CHECKER.restricted_certificate({"type": "client", "restricted": True, "projects": ["agentor-private"]}, "agentor-private")
        for record in ({"type": "client", "restricted": False, "projects": ["agentor-private"]},
                       {"type": "client", "restricted": True, "projects": ["agentor-private", "default"]}):
            with self.assertRaises(ValueError):
                CHECKER.restricted_certificate(record, "agentor-private")

    def test_private_keys_are_owned_regular_files_without_group_access(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "client.key"; key.write_text("PRIVATE-SENTINEL"); key.chmod(0o600)
            CHECKER.credential(str(key), True)
            key.chmod(0o644)
            with self.assertRaises(ValueError):
                CHECKER.credential(str(key), True)
            link = Path(directory) / "link"; link.symlink_to(key)
            with self.assertRaises(ValueError):
                CHECKER.credential(str(link), True)

    def test_https_uses_verified_mutual_tls_and_get_only(self):
        context = MagicMock(); connection = MagicMock(); response = connection.getresponse.return_value
        response.status = 200; response.read.return_value = b'{"type":"sync","status_code":200,"metadata":{"ready":true}}'
        with patch.object(CHECKER.ssl, "create_default_context", return_value=context) as tls, \
             patch.object(CHECKER.http.client, "HTTPSConnection", return_value=connection) as connect:
            self.assertEqual(CHECKER.https("https://incus.internal:8443", "/1.0?project=agentor-private", "cert", "key", "server"), {"ready": True})
            tls.assert_called_once_with(cafile="server"); context.load_cert_chain.assert_called_once_with("cert", "key")
            self.assertEqual(context.minimum_version, CHECKER.ssl.TLSVersion.TLSv1_2)
            connect.assert_called_once_with("incus.internal", 8443, context=context, timeout=10)
            connection.request.assert_called_once_with("GET", "/1.0?project=agentor-private")
            connection.close.assert_called_once()

    def test_exact_owned_nft_rule_is_not_a_blanket_source_nat_exception(self):
        install = "12345678-1234-1234-1234-123456789abc"
        expr = [
            {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "workers"}},
            {"match": {"op": "==", "left": {"meta": {"key": "oifname"}}, "right": "br-control"}},
            {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": {"prefix": {"addr": "10.25.0.0", "len": 24}}}},
            {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": "172.25.0.2"}},
            {"match": {"op": "==", "left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": 3000}},
            {"counter": {"packets": 4, "bytes": 32}}, {"snat": {"addr": {"payload": {"protocol": "ip", "field": "saddr"}}}},
        ]
        document = {"nftables": [{"chain": {"table": "agentor_source", "name": "postrouting", "type": "nat", "hook": "postrouting", "prio": 99}},
                    {"rule": {"family": "ip", "table": "agentor_source", "chain": "postrouting", "comment": "agentor-source-" + install, "expr": expr}}]}
        check = lambda value: CHECKER.nft_source_rule(value, "agentor_source", "workers", "br-control", ipaddress.IPv4Network("10.25.0.0/24"), "172.25.0.2", install)
        check(document)
        for change in ("owner", "destination", "broaden", "translate"):
            changed = copy.deepcopy(document); rule = changed["nftables"][1]["rule"]
            if change == "owner": rule["comment"] = "foreign-owner"
            if change == "destination": rule["expr"][3]["match"]["right"] = "172.25.0.3"
            if change == "broaden": del rule["expr"][4]
            if change == "translate": rule["expr"][-1] = {"snat": {"addr": "172.25.0.1"}}
            with self.assertRaises(ValueError): check(changed)

    def test_missing_configuration_is_actionable_and_never_prints_secrets(self):
        stdout = io.StringIO()
        with patch.object(sys, "argv", ["checker", "--endpoint", "https://user:PRIVATE-SENTINEL@incus"]), \
             patch.dict(CHECKER.os.environ, {}, clear=True), patch.object(CHECKER, "command", side_effect=OSError("RAW-SECRET")), contextlib.redirect_stdout(stdout):
            self.assertEqual(CHECKER.main(), 1)
        self.assertIn("FAIL operator configuration", stdout.getvalue())
        self.assertNotIn("PRIVATE-SENTINEL", stdout.getvalue()); self.assertNotIn("RAW-SECRET", stdout.getvalue())
        self.assertNotIn("PASS restricted", stdout.getvalue())

    def test_help_documents_same_runtime_inputs_without_host_calls(self):
        result = subprocess.run(["bash", str(SCRIPT), "--help"], capture_output=True, text=True, check=True)
        self.assertIn("INCUS_NETWORK_HOST_ENDPOINT", result.stdout); self.assertIn("AGENTOR_INSTALLATION_ID", result.stdout)
        self.assertIn("never installs, repairs or allocates", result.stdout)

    def test_missing_routing_stays_unknown_even_when_basic_prerequisites_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            cert = Path(directory) / "cert"; cert.write_text("PRIVATE-SENTINEL"); cert.chmod(0o600)
            argv = ["checker", "--endpoint", "https://incus.internal:8443", "--project", "agentor-private", "--network", "workers",
                    "--storage-pool", "workers", "--installation-id", "12345678-1234-1234-1234-123456789abc",
                    "--network-host-endpoint", "https://policy.internal:8444"]
            for flag in ("--client-cert-path", "--client-key-path", "--server-cert-path"): argv += [flag, str(cert)]
            def native(path):
                if path.startswith("/1.0/projects/"): return self.project()
                if path.startswith("/1.0/certificates/"): return {"type": "client", "restricted": True, "projects": ["agentor-private"]}
                if path.startswith("/1.0/networks/"): return {"name": "workers", "type": "bridge", "managed": True,
                    "config": {"ipv4.address": "10.25.0.1/24", "ipv4.nat": "true"}}
                return {"config": {"core.https_address": "127.0.0.1:8443"}}
            def https(_base, path, *_certs):
                if path.startswith("/v1/"): return {"ready": True, "installation": argv[argv.index("--installation-id") + 1], "project": "agentor-private", "primary": "workers"}
                if path.startswith("/1.0/networks/"): return {"name": "workers", "status": "Created"}
                if path.startswith("/1.0/storage-pools/"): return {"name": "workers", "status": "Created"}
                return {"auth": "trusted", "environment": {"server_version": "6.0.6"},
                    "api_extensions": ["projects", "projects_restrictions", "virtual-machines", "network_firewall_filtering"]}
            original_read = Path.read_text; original_stat = CHECKER.os.stat; original_access = CHECKER.os.access
            stdout = io.StringIO()
            with patch.object(sys, "argv", argv), patch.dict(CHECKER.os.environ, {}, clear=True), \
                 patch.object(Path, "read_text", lambda path, *a, **kw: 'ID=ubuntu\nVERSION_ID="24.04"\n' if str(path) == "/etc/os-release" else original_read(path, *a, **kw)), \
                 patch.object(CHECKER.os, "stat", lambda path, *a, **kw: types.SimpleNamespace(st_mode=stat.S_IFCHR) if str(path) == "/dev/kvm" else original_stat(path, *a, **kw)), \
                 patch.object(CHECKER.os, "access", lambda path, mode: True if str(path) == "/dev/kvm" else original_access(path, mode)), \
                 patch.object(CHECKER.shutil, "which", return_value="virtiofsd"), patch.object(CHECKER, "command", return_value="virtiofsd 1.13.0"), \
                 patch.object(CHECKER, "native", side_effect=native), patch.object(CHECKER, "https", side_effect=https), \
                 patch.object(CHECKER.ssl, "PEM_cert_to_DER_cert", return_value=b"fake DER"), contextlib.redirect_stdout(stdout):
                self.assertEqual(CHECKER.main(), 2)
            self.assertNotIn("FAIL ", stdout.getvalue()); self.assertIn("UNKNOWN routing", stdout.getvalue())
            self.assertIn("NOT READY", stdout.getvalue()); self.assertNotIn("PRIVATE-SENTINEL", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
