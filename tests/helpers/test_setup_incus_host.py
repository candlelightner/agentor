"""Installer preflights; external mutation commands are always mocked."""
import copy
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/setup-incus-host.sh"
CODE = SCRIPT.read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
SETUP = types.ModuleType("installer_test")
with patch.object(sys, "argv", ["installer", str(SCRIPT)]): exec(compile(CODE, str(SCRIPT), "exec"), SETUP.__dict__)
INSTALLATION = "12345678-1234-1234-1234-123456789abc"


class InstallerTests(unittest.TestCase):
    def config(self):
        return {"installation": INSTALLATION, "project": "owned", "network": "ag12345678", "pool": "owned-pool",
                "dataDir": "/srv/agentor", "container": "agentor-orchestrator", "dockerNetwork": "control", "internalPort": 3079,
                "sourceTable": "agentor_source_12345678"}

    def test_help_is_available_without_root_or_host_mutation(self):
        result = subprocess.run(["bash", str(SCRIPT), "--help"], text=True, capture_output=True, check=True)
        self.assertIn("--install-lts", result.stdout); self.assertIn("never migrates", result.stdout)
        self.assertIn("--routing", result.stdout)

    def test_namespace_never_adopts_foreign_or_symlink_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); foreign = base / "foreign"; foreign.mkdir(mode=0o700); (foreign / "unrelated").write_text("intact")
            with self.assertRaises(OSError): SETUP.namespace(foreign, INSTALLATION)
            self.assertEqual((foreign / "unrelated").read_text(), "intact")
            link = base / "link"; link.symlink_to(foreign, target_is_directory=True)
            with self.assertRaises(ValueError): SETUP.namespace(link, INSTALLATION)
            owned = base / "owned"; SETUP.namespace(owned, INSTALLATION); SETUP.namespace(owned, INSTALLATION)
            self.assertEqual((owned / "owner").read_text().strip(), INSTALLATION)

    def test_atomic_public_and_private_files_are_idempotent_under_private_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            original = os.umask(0o077)
            try:
                for mode in (0o600, 0o644):
                    path = Path(directory) / str(mode); SETUP.write_file(path, "known", mode); SETUP.write_file(path, "known", mode)
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode)
                    with self.assertRaises(ValueError): SETUP.write_file(path, "foreign", mode)
                    self.assertEqual(path.read_text(), "known")
            finally: os.umask(original)

    def test_installation_and_account_inventory_do_not_modify_canonical_data(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); marker = base / "backup-installation-id"; marker.write_text(INSTALLATION + "\n")
            roots = [base / "users/account" / role for role in ("credentials", "kilo/config", "kilo/data")]
            for root in roots: root.mkdir(parents=True, exist_ok=True)
            before = {str(path.relative_to(base)): path.stat().st_mtime_ns for path in base.rglob("*")}
            self.assertEqual(SETUP.installation_id(directory), INSTALLATION)
            self.assertEqual(SETUP.initial_account_paths(directory), sorted(map(str, roots)))
            self.assertEqual(before, {str(path.relative_to(base)): path.stat().st_mtime_ns for path in base.rglob("*")})
            marker.unlink()
            with self.assertRaisesRegex(ValueError, "backup first"): SETUP.installation_id(directory)

    def test_account_inventory_rejects_symlinks_instead_of_granting_parents(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); user = base / "users/account"; user.mkdir(parents=True)
            (user / "credentials").symlink_to(base, target_is_directory=True)
            with self.assertRaises(ValueError): SETUP.initial_account_paths(directory)

    def test_stock_or_missing_incus_needs_explicit_signed_lts_opt_in(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(SETUP.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout=b"ii ")), \
             patch.object(SETUP.shutil, "which", return_value=None), patch.object(SETUP, "command") as commands, patch.object(SETUP, "urlopen") as download:
            with self.assertRaisesRegex(ValueError, "--install-lts"): SETUP.install_packages(False, directory)
            commands.assert_not_called(); download.assert_not_called()

    def test_changed_vendor_key_is_rejected_before_apt_trust_or_install(self):
        response = MagicMock(); response.url = "https://pkgs.zabbly.com/key.asc"; response.read.return_value = b"untrusted-public-key"
        with tempfile.TemporaryDirectory() as directory, patch.object(SETUP.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout=b"ii ")), \
             patch.object(SETUP.shutil, "which", return_value=None), patch.object(SETUP, "urlopen") as download, \
             patch.object(SETUP, "command", return_value=b"fpr:::::::::WRONG:\n") as commands, patch.object(SETUP, "write_file") as writes:
            download.return_value.__enter__.return_value = response
            with self.assertRaisesRegex(ValueError, "fingerprint changed"): SETUP.install_packages(True, directory)
            writes.assert_not_called(); self.assertEqual(commands.call_count, 1)
            self.assertEqual(commands.call_args.args[0], "gpg")

    def test_second_primary_is_rejected_before_apt_trust_or_install(self):
        response = MagicMock(); response.url = "https://pkgs.zabbly.com/key.asc"; response.read.return_value = b"public-key-bundle"
        shown = "pub:::::::::\nfpr:::::::::" + SETUP.ZABBLY_FINGERPRINT + ":\nsub:::::::::\nfpr:::::::::" + "A" * 40 + ":\n"
        shown += "pub:::::::::\nfpr:::::::::" + "B" * 40 + ":\n"
        with tempfile.TemporaryDirectory() as directory, patch.object(SETUP.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout=b"ii ")), \
             patch.object(SETUP.shutil, "which", return_value=None), patch.object(SETUP, "urlopen") as download, \
             patch.object(SETUP, "command", return_value=shown.encode()) as commands, patch.object(SETUP, "write_file") as writes:
            download.return_value.__enter__.return_value = response
            with self.assertRaisesRegex(ValueError, "additional primary"): SETUP.install_packages(True, directory)
            writes.assert_not_called(); self.assertEqual(commands.call_count, 1); self.assertEqual(commands.call_args.args[0], "gpg")

    def test_single_expected_primary_with_subkey_and_immediate_fingerprint_is_accepted(self):
        shown = "pub:::::::::\nfpr:::::::::" + SETUP.ZABBLY_FINGERPRINT + ":\nuid:::::::::Official key:\nsub:::::::::\nfpr:::::::::" + "A" * 40 + ":\n"
        SETUP.verify_package_key(shown)
        with self.assertRaisesRegex(ValueError, "malformed"): SETUP.verify_package_key(shown.replace("pub:::::::::\n", "pub:::::::::\nuid:::::::::Not immediate:\n"))
        with self.assertRaisesRegex(ValueError, "trust review"): SETUP.verify_package_key(shown + ("sub:::::::::\nfpr:::::::::" + "A" * 40 + ":\n") * 16)

    def test_owned_empty_share_survives_account_creation_and_rerun_without_data_writes(self):
        records = {"/1.0/storage-pools": [], "/1.0/networks": [], "/1.0/projects": []}; writes = []
        def cli(*args):
            writes.append(args); kind, operation, name = args[:3]
            if operation == "set":
                self.assertEqual(kind, "project"); key, value = args[3].split("=", 1); records["/1.0/projects"][0]["config"][key] = value; return
            self.assertEqual(operation, "create")
            config = {}
            for argument in args[3:]:
                if "=" in argument: key, value = argument.split("=", 1); config[key] = value
            if kind == "storage": records["/1.0/storage-pools"].append({"name": name, "driver": "dir", "status": "Created", "config": config})
            if kind == "network":
                config["ipv4.address"] = "10.25.0.1/24"; records["/1.0/networks"].append({"name": name, "managed": True, "type": "bridge", "config": config})
            if kind == "project": records["/1.0/projects"].append({"name": name, "config": config})
        config = self.config()
        with tempfile.TemporaryDirectory() as directory, patch.object(SETUP, "EMPTY_SHARE_ROOT", Path(directory) / "operator"), \
             patch.object(SETUP, "native", side_effect=lambda path: copy.deepcopy(records[path.split("?")[0]])), patch.object(SETUP, "incus", side_effect=cli):
            data = Path(directory) / "DATA"; data.mkdir(); (data / "backup-installation-id").write_text(INSTALLATION + "\n")
            first_paths = SETUP.initial_share_paths(str(data), INSTALLATION); self.assertEqual(len(first_paths), 1)
            SETUP.resource_setup(config, first_paths)
            account = data / "users/account/credentials"; account.mkdir(parents=True); (account / "credential").write_text("unchanged")
            before = {str(path.relative_to(data)): (path.stat().st_mtime_ns, path.read_bytes() if path.is_file() else None) for path in data.rglob("*")}
            second_paths = SETUP.initial_share_paths(str(data), INSTALLATION); self.assertEqual(second_paths, sorted([*first_paths, str(account)]))
            SETUP.resource_setup(config, second_paths); updated = copy.deepcopy(records)
            SETUP.resource_setup(config, SETUP.initial_share_paths(str(data), INSTALLATION))
            self.assertEqual(records, updated)
            self.assertEqual(before, {str(path.relative_to(data)): (path.stat().st_mtime_ns, path.read_bytes() if path.is_file() else None) for path in data.rglob("*")})
        self.assertEqual(len(writes), 4); self.assertEqual(config["internalUrl"], "http://10.25.0.1:3079")
        self.assertEqual(records["/1.0/projects"][0]["config"]["restricted.devices.nic"], "managed")
        self.assertEqual(records["/1.0/projects"][0]["config"]["restricted.devices.pci"], "block")

    def test_foreign_pool_never_gets_marked_adopted_or_recreated(self):
        record = {"name": "owned-pool", "driver": "dir", "config": {SETUP.MARKER: "foreign"}}
        with patch.object(SETUP, "native", return_value=[record]), patch.object(SETUP, "incus") as commands:
            with self.assertRaisesRegex(ValueError, "foreign"): SETUP.resource_setup(self.config(), [])
            commands.assert_not_called(); self.assertEqual(record["config"][SETUP.MARKER], "foreign")

    def test_bridge_netfilter_loads_and_persists_only_its_owned_module_and_sysctls(self):
        writes = []; commands = []
        header = "# Agentor installation " + INSTALLATION + "\n"
        with patch.object(SETUP, "command", side_effect=lambda *args: commands.append(args)), \
             patch.object(SETUP, "write_file", side_effect=lambda *args: writes.append(args)), \
             patch.object(Path, "is_dir", return_value=True), patch.object(Path, "exists", return_value=True), \
             patch.object(Path, "read_text", new=lambda path: header + "net.ipv4.ip_forward=1\n" if str(path).startswith("/etc/sysctl.d/") else "1\n"):
            SETUP.bridge_netfilter(INSTALLATION)
        self.assertEqual(commands, [("modprobe", "br_netfilter"), ("sysctl", "-w", "net.bridge.bridge-nf-call-iptables=1"),
                                    ("sysctl", "-w", "net.bridge.bridge-nf-call-ip6tables=1")])
        self.assertEqual(str(writes[0][0]), "/etc/modules-load.d/90-agentor-incus-12345678.conf")
        self.assertEqual(writes[0][1], header + "br_netfilter\n")
        self.assertEqual(str(writes[1][0]), "/etc/sysctl.d/90-agentor-incus-12345678.conf")
        self.assertEqual(writes[1][1], header + "net.ipv4.ip_forward=1\nnet.bridge.bridge-nf-call-iptables=1\nnet.bridge.bridge-nf-call-ip6tables=1\n")

    def test_unavailable_module_or_unrelated_sysctl_configuration_fails_closed(self):
        with patch.object(SETUP, "command"), patch.object(SETUP, "write_file") as writes, patch.object(Path, "is_dir", return_value=False):
            with self.assertRaisesRegex(ValueError, "unavailable"): SETUP.bridge_netfilter(INSTALLATION)
            writes.assert_not_called()
        with patch.object(SETUP, "command") as commands, patch.object(SETUP, "write_file") as writes, \
             patch.object(Path, "is_dir", return_value=True), patch.object(Path, "exists", return_value=True), \
             patch.object(Path, "read_text", return_value="unrelated administrator settings\n"):
            with self.assertRaisesRegex(ValueError, "unrelated configuration"): SETUP.bridge_netfilter(INSTALLATION)
            self.assertEqual(writes.call_count, 1); self.assertTrue(str(writes.call_args.args[0]).startswith("/etc/modules-load.d/"))
            commands.assert_called_once_with("modprobe", "br_netfilter")

    def test_route_rules_are_directional_and_source_identity_is_port_specific(self):
        rules = SETUP.route_rules("workers", "br-control", "172.25.0.0/24", "10.25.0.0/24", "172.25.0.2", "eth0", "owned")
        self.assertEqual(len(rules), 6)
        self.assertIn("--ctstate", rules[1]); self.assertIn("--ctstate", rules[4])
        self.assertEqual(rules[2][rules[2].index("--dport") + 1], "3000")
        self.assertEqual(rules[2][rules[2].index("-d") + 1], "172.25.0.2")
        self.assertTrue(all("-m" in rule and "--comment" in rule for rule in rules))
        self.assertEqual(rules[-1][-1], "RETURN")

    def test_foreign_forward_chain_is_not_flushed(self):
        config = self.config(); seen = []
        def command(*args, **kwargs):
            seen.append(args)
            if args[0] == "ip": return b'[{"dev":"eth0"}]'
            if args[0] == "iptables": return b"-N DOCKER-USER\n-N AGINCUS_12345678\n-A AGINCUS_12345678 -j ACCEPT\n"
            self.fail("Unexpected mutation command")
        context = (config["dataDir"], "control", "br-control", "172.25.0.0/24", "172.25.0.1", "172.25.0.2")
        with patch.object(SETUP, "installation_id", return_value=INSTALLATION), patch.object(SETUP, "docker_context", return_value=context), \
             patch.object(SETUP, "native", return_value={"name": config["network"], "config": {SETUP.MARKER: INSTALLATION, "ipv4.address": "10.25.0.1/24"}}), \
             patch.object(SETUP, "command", side_effect=command):
            with self.assertRaisesRegex(ValueError, "foreign"): SETUP.routing(config)
        self.assertEqual([item[0] for item in seen], ["ip", "iptables"])

    def test_systemd_argument_does_not_expand_path_variables_or_specifiers(self):
        value = SETUP.unit_argument('/srv/a b/$secret%name"file')
        self.assertEqual(value, '"/srv/a b/$$secret%%name\\"file"')

    def test_generated_nft_check_and_install_use_separate_chain_table_closing_lines(self):
        config = self.config(); submitted = []
        def command(*args, **kwargs):
            if args[0] == "ip": return b'[{"dev":"eth0"}]'
            if args[:3] == ("iptables", "-w", "-S"): return b"-N DOCKER-USER\n"
            if args[:4] == ("nft", "-j", "list", "tables"): return b'{"nftables":[]}'
            if args[0] == "nft" and "-f" in args: submitted.append((args, kwargs["data"]))
            return b""
        context = (config["dataDir"], "control", "br-control", "172.25.0.0/24", "172.25.0.1", "172.25.0.2")
        with patch.object(SETUP, "installation_id", return_value=INSTALLATION), patch.object(SETUP, "docker_context", return_value=context), \
             patch.object(SETUP, "native", return_value={"name": config["network"], "config": {SETUP.MARKER: INSTALLATION, "ipv4.address": "10.25.0.1/24"}}), \
             patch.object(SETUP, "command", side_effect=command): SETUP.routing(config)
        self.assertEqual(len(submitted), 2); self.assertEqual(submitted[0][0], ("nft", "--check", "-f", "-"))
        self.assertEqual(submitted[1][0], ("nft", "-f", "-")); self.assertEqual(submitted[0][1], submitted[1][1])
        self.assertTrue(submitted[0][1].endswith(b';\n }\n}\n')); self.assertNotIn(b"; } }", submitted[0][1])


if __name__ == "__main__": unittest.main()
