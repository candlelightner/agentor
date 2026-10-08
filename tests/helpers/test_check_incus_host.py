"""Deterministic checker preflights only; not live host/setup acceptance."""
import contextlib
import copy
import io
import ipaddress
import json
from pathlib import Path
import shlex
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

    def test_bridge_netfilter_readiness_is_read_only_and_rejects_missing_or_disabled_prerequisites(self):
        with patch.object(Path, "is_dir", return_value=False), patch.object(CHECKER, "command") as commands:
            with self.assertRaisesRegex(ValueError, "not loaded"): CHECKER.bridge_netfilter()
            commands.assert_not_called()
        for disabled in ("iptables", "ip6tables", None):
            with patch.object(Path, "is_dir", return_value=True), patch.object(CHECKER, "command") as commands, \
                 patch.object(Path, "read_text", new=lambda path: "0\n" if str(path).endswith("-" + str(disabled)) else "1\n"):
                if disabled:
                    with self.assertRaisesRegex(ValueError, "disabled"): CHECKER.bridge_netfilter()
                else: CHECKER.bridge_netfilter()
                commands.assert_not_called()

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

    def test_gui_loopback_coexists_with_exact_internal_publish_but_wildcards_do_not(self):
        internal = {"HostIp": "10.25.0.1", "HostPort": "3079"}; gui = {"HostIp": "127.0.0.1", "HostPort": "3000"}
        CHECKER.internal_publication([gui, internal], "10.25.0.1", 3079)
        for published in ([gui], [internal, internal], [internal, {"HostIp": "0.0.0.0", "HostPort": "3000"}],
                          [internal, {"HostIp": "10.25.0.1", "HostPort": "9999"}]):
            with self.assertRaises(ValueError): CHECKER.internal_publication(published, "10.25.0.1", 3079)

    def test_exact_account_exception_never_grants_the_docker_data_parent(self):
        root = "/var/lib/docker/volumes/platform/_data/users/account/credentials"
        project = self.project(); project["config"]["restricted.devices.disk.paths"] = root
        CHECKER.project_policy(project, "agentor-private", "workers", [root])
        project["config"]["restricted.devices.disk.paths"] = "/var/lib/docker/volumes/platform/_data/users"
        with self.assertRaises(ValueError): CHECKER.project_policy(project, "agentor-private", "workers", [root])

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

    def forwarding_rows(self):
        installation = "12345678-1234-1234-1234-123456789abc"; chain = "AGINCUS_12345678"
        comment = "-m comment --comment agentor-forward-" + installation
        rows = ["-N DOCKER-USER", "-N " + chain, "-A DOCKER-USER " + comment + " -j " + chain]
        for rule in (
            "-i br-control -o workers -s 172.25.0.0/24 -d 10.25.0.0/24",
            "-i workers -o br-control -s 10.25.0.0/24 -d 172.25.0.0/24 -m conntrack --ctstate ESTABLISHED,RELATED",
            "-i workers -o br-control -s 10.25.0.0/24 -d 172.25.0.2 -p tcp --dport 3000",
            "-i workers -o eth0 -s 10.25.0.0/24",
            "-i eth0 -o workers -d 10.25.0.0/24 -m conntrack --ctstate ESTABLISHED,RELATED",
        ): rows.append("-A " + chain + " " + rule + " " + comment + " -j ACCEPT")
        rows.append("-A " + chain + " " + comment + " -j RETURN")
        return installation, rows

    def check_forwarding(self, rows, routes=None):
        installation, _ = self.forwarding_rows(); calls = []
        def command(*args):
            calls.append(args)
            if args == ("ip", "-j", "-4", "route", "show", "default"):
                return json.dumps(routes if routes is not None else [{"dev": "eth0"}])
            if args == ("iptables", "-w", "-S"): return "\n".join(rows)
            self.assertEqual(args[:4], ("iptables", "-w", "-C", "AGINCUS_12345678"))
            if ["-A", args[3], *args[4:]] not in [shlex.split(row) for row in rows]:
                raise subprocess.CalledProcessError(1, "read-only rule check")
            return ""
        with patch.object(CHECKER, "command", side_effect=command):
            CHECKER.forwarding_policy("workers", "br-control", ipaddress.IPv4Network("172.25.0.0/24"),
                                      ipaddress.IPv4Network("10.25.0.0/24"), "172.25.0.2", installation)
        return calls

    def test_owned_forwarding_six_checks_are_read_only_and_leave_unrelated_rules_alone(self):
        _, rows = self.forwarding_rows()
        rows += ["-A DOCKER-USER -s 192.168.10.0/24 -j RETURN", "-N FOREIGN", "-A FOREIGN -j DROP"]
        calls = self.check_forwarding(rows)
        self.assertEqual(len(calls), 8); self.assertTrue(all(call[0] == "ip" or call[2] in ("-S", "-C") for call in calls))
        tcp = calls[4]; self.assertIn("--dport", tcp); self.assertEqual(tcp[tcp.index("--dport") + 1], "3000")
        self.assertEqual(tcp[tcp.index("-d") + 1], "172.25.0.2")

    def test_missing_extra_foreign_or_broadened_owned_forwarding_fails_closed(self):
        _, baseline = self.forwarding_rows()
        for case in ("missing", "extra", "foreign", "wrong-ip", "broadened", "wrong-uplink", "wrong-return"):
            with self.subTest(case=case):
                rows = list(baseline)
                if case == "missing": rows.pop()
                if case == "extra": rows.append(rows[-1])
                if case == "foreign": rows[3] = rows[3].replace("agentor-forward-", "foreign-forward-")
                if case == "wrong-ip": rows[5] = rows[5].replace("172.25.0.2", "172.25.0.3")
                if case == "broadened": rows[5] = rows[5].replace(" --dport 3000", "")
                if case == "wrong-uplink": rows[6] = rows[6].replace("eth0", "eth1")
                if case == "wrong-return": rows[-1] = rows[-1].replace("RETURN", "ACCEPT")
                with self.assertRaises((ValueError, subprocess.CalledProcessError)): self.check_forwarding(rows)

    def test_owned_jump_must_be_unique_first_and_have_exact_installation_authority(self):
        _, baseline = self.forwarding_rows()
        for case in ("absent", "later", "duplicate", "foreign", "extra-reference", "extra-goto"):
            with self.subTest(case=case):
                rows = list(baseline)
                if case == "absent": rows.pop(2)
                if case == "later": rows.insert(2, "-A DOCKER-USER -j RETURN")
                if case == "duplicate": rows.append(rows[2])
                if case == "foreign": rows[2] = rows[2].replace("agentor-forward-", "foreign-forward-")
                if case == "extra-reference": rows.append("-A FORWARD -j AGINCUS_12345678")
                if case == "extra-goto": rows.append("-A FORWARD -g AGINCUS_12345678")
                with self.assertRaises(ValueError): self.check_forwarding(rows)

    def test_owned_return_before_required_grants_never_reports_ready(self):
        _, rows = self.forwarding_rows(); rows.insert(3, rows.pop())
        with self.assertRaisesRegex(ValueError, "RETURN must be final"): self.check_forwarding(rows)

    def test_default_uplink_must_be_observed_unique_and_distinct_from_worker_bridges(self):
        _, rows = self.forwarding_rows()
        self.check_forwarding(rows, [{"dev": "eth0"}, {"dev": "eth0"}])
        for routes in ([], [{}], [{"dev": "eth0"}, {"dev": "eth1"}], [{"dev": "workers"}], [{"dev": "br-control"}], [{"dev": "*"}]):
            with self.subTest(routes=routes), self.assertRaises(ValueError): self.check_forwarding(rows, routes)

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

    def run_ready_configuration(self, complete=False, forwarding_error=None):
        with tempfile.TemporaryDirectory() as directory:
            cert = Path(directory) / "cert"; cert.write_text("PRIVATE-SENTINEL"); cert.chmod(0o600)
            argv = ["checker", "--endpoint", "https://incus.internal:8443", "--project", "agentor-private", "--network", "workers",
                    "--storage-pool", "workers", "--installation-id", "12345678-1234-1234-1234-123456789abc",
                    "--network-host-endpoint", "https://policy.internal:8444"]
            for flag in ("--client-cert-path", "--client-key-path", "--server-cert-path"): argv += [flag, str(cert)]
            if complete: argv += ["--docker-network", "control", "--orchestrator-container", "controller", "--source-nat-table", "agentor_source",
                                  "--internal-gateway-url", "http://10.25.0.1:3079"]
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
            calls = []
            def command(*args):
                calls.append(args)
                if args[:3] == ("docker", "network", "inspect"):
                    return json.dumps([{"Id": "a" * 64, "Driver": "bridge", "Internal": False,
                        "Options": {"com.docker.network.bridge.name": "br-control"},
                        "IPAM": {"Config": [{"Subnet": "172.25.0.0/24", "Gateway": "172.25.0.1"}]}}])
                if args[:2] == ("docker", "inspect"):
                    return json.dumps([{"Mounts": [{"Destination": "/data", "Source": directory, "RW": True}],
                        "NetworkSettings": {"Networks": {"control": {"IPAddress": "172.25.0.2"}},
                        "Ports": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}, {"HostIp": "10.25.0.1", "HostPort": "3079"}]}}}])
                if args[:2] == ("nft", "-j"): return '{"nftables":[]}'
                return "virtiofsd 1.13.0"
            with patch.object(sys, "argv", argv), patch.dict(CHECKER.os.environ, {}, clear=True), \
                 patch.object(Path, "read_text", lambda path, *a, **kw: 'ID=ubuntu\nVERSION_ID="24.04"\n' if str(path) == "/etc/os-release" else "1\n" if str(path).startswith("/proc/sys/net/") else original_read(path, *a, **kw)), \
                 patch.object(Path, "is_dir", return_value=True), \
                 patch.object(CHECKER.os, "stat", lambda path, *a, **kw: types.SimpleNamespace(st_mode=stat.S_IFCHR) if str(path) == "/dev/kvm" else original_stat(path, *a, **kw)), \
                 patch.object(CHECKER.os, "access", lambda path, mode: True if str(path) == "/dev/kvm" else original_access(path, mode)), \
                 patch.object(CHECKER.shutil, "which", return_value="virtiofsd"), patch.object(CHECKER, "command", side_effect=command), \
                 patch.object(CHECKER, "native", side_effect=native), patch.object(CHECKER, "https", side_effect=https), \
                 patch.object(CHECKER, "nft_source_rule"), patch.object(CHECKER, "forwarding_policy", side_effect=forwarding_error) as forward, \
                 patch.object(CHECKER.ssl, "PEM_cert_to_DER_cert", return_value=b"fake DER"), contextlib.redirect_stdout(stdout):
                status = CHECKER.main()
            if complete:
                forward.assert_called_once_with("workers", "br-control", ipaddress.IPv4Network("172.25.0.0/24"),
                    ipaddress.IPv4Network("10.25.0.0/24"), "172.25.0.2", "12345678-1234-1234-1234-123456789abc")
            else: forward.assert_not_called()
            self.assertNotIn("PRIVATE-SENTINEL", stdout.getvalue())
            self.assertTrue(all(call[0] not in ("iptables-restore", "sysctl", "systemctl") for call in calls))
            return status, stdout.getvalue()

    def test_missing_routing_stays_unknown_even_when_basic_prerequisites_pass(self):
        status, output = self.run_ready_configuration()
        self.assertEqual(status, 2); self.assertNotIn("FAIL ", output); self.assertIn("UNKNOWN routing", output); self.assertIn("NOT READY", output)

    def test_configured_topology_clears_forwarding_unknown_only_after_its_checks_pass(self):
        status, output = self.run_ready_configuration(complete=True)
        self.assertEqual(status, 0); self.assertIn("PASS setup-owned directional forwarding", output); self.assertNotIn("UNKNOWN forwarding", output)
        self.assertIn("real VM anti-spoofing/source-identity canary is still required", output)
        status, output = self.run_ready_configuration(complete=True, forwarding_error=ValueError("PRIVATE-SENTINEL"))
        self.assertEqual(status, 1); self.assertIn("FAIL setup-owned directional forwarding", output); self.assertIn("NOT READY", output)


if __name__ == "__main__":
    unittest.main()
