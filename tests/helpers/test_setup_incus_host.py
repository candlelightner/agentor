"""Installer preflights; external mutation commands are always mocked."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import tarfile
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

    def test_native_query_actual_argv_preserves_explicit_url_without_cli_project(self):
        path = "/1.0/images/" + "a" * 64 + "?project=owned"
        result = types.SimpleNamespace(returncode=0, stdout=b'{"fingerprint":"accepted"}', stderr=b"")
        with patch.object(SETUP.subprocess, "run", return_value=result) as process:
            self.assertEqual(SETUP.native(path), {"fingerprint": "accepted"})
            self.assertEqual(process.call_args.args[0], ("incus", "--force-local", "query", path))
            self.assertNotIn("--project", process.call_args.args[0])

    def test_hostname_must_have_positive_openssl_output_not_merely_success_status(self):
        config = {**self.config(), "tlsName": "incus.internal", "httpsPort": 8443}
        server = {"environment": {"certificate": "PUBLIC CERTIFICATE"}, "config": {"core.https_address": "unrelated:8443"}}
        for matched in (True, False):
            with self.subTest(matched=matched), patch.object(SETUP, "native", return_value=server), patch.object(SETUP, "write_file"), \
                 patch.object(SETUP, "command", return_value=("Hostname incus.internal does " + ("" if matched else "NOT ") + "match certificate\n").encode()) as commands, \
                 patch.object(SETUP, "incus") as mutation:
                with self.assertRaisesRegex(ValueError, "listener differs" if matched else "certificate does not match"):
                    SETUP.certificates(config, Path("/owned"), "172.25.0.1")
                commands.assert_called_once_with("openssl", "x509", "-in", "/owned/server.crt", "-noout", "-checkhost", "incus.internal")
                mutation.assert_not_called()

    def test_real_openssl_hostname_check_rejects_zero_exit_mismatch_on_python_without_match_hostname(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); key, cert = directory / "throwaway.key", directory / "throwaway.crt"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "ed25519", "-nodes", "-days", "1", "-subj", "/CN=unrelated",
                "-addext", "subjectAltName=DNS:incus.internal", "-keyout", str(key), "-out", str(cert)], capture_output=True, check=True)
            key.chmod(0o600)
            server = {"environment": {"certificate": cert.read_text()}, "config": {"core.https_address": "unrelated:8443"}}
            for name, matched in (("incus.internal", True), ("wrong.internal", False)):
                result = subprocess.run(["openssl", "x509", "-in", str(cert), "-noout", "-checkhost", name], capture_output=True)
                self.assertEqual(result.returncode, 0)  # Actual OpenSSL mismatch is not a process failure.
                config = {**self.config(), "tlsName": name, "httpsPort": 8443}
                with patch.object(SETUP, "native", return_value=server), patch.object(SETUP, "incus") as mutation:
                    with self.assertRaisesRegex(ValueError, "listener differs" if matched else "certificate does not match"):
                        SETUP.certificates(config, directory, "172.25.0.1")
                    mutation.assert_not_called()

    def test_certificate_registration_actual_argv_and_postregistration_project_restriction(self):
        config = {**self.config(), "tlsName": "incus.internal", "httpsPort": 8443}
        fingerprint = hashlib.sha256(b"fixture public DER").hexdigest()
        for case in ("accepted", "unrestricted", "wrong-project"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                for purpose in ("client", "policy"):
                    (directory / (purpose + ".key")).write_text("throwaway private fixture"); (directory / (purpose + ".key")).chmod(0o600)
                    (directory / (purpose + ".crt")).write_text("throwaway public fixture"); (directory / (purpose + ".crt")).chmod(0o644)
                calls = []; reads = []; original_stat = Path.lstat
                def lstat(path, *args, **kwargs):
                    info = original_stat(path, *args, **kwargs)
                    if path.name in ("client.key", "client.crt", "policy.key", "policy.crt"):
                        return types.SimpleNamespace(st_mode=info.st_mode, st_uid=0)
                    return info
                def command(*args, **kwargs):
                    calls.append(args)
                    if args[0] == "openssl": return b"Hostname incus.internal does match certificate\n"
                    self.assertEqual(args, ("incus", "--force-local", "--project", "default", "config", "trust", "add-certificate",
                        str(directory / "client.crt"), "--name=agentor-" + INSTALLATION, "--restricted", "--projects=owned"))
                    return b""
                def native(path):
                    reads.append(path)
                    if path == "/1.0": return {"environment": {"certificate": "public server fixture"}, "config": {"core.https_address": "172.25.0.1:8443"}}
                    self.assertEqual(path, "/1.0/certificates?recursion=1")
                    if not any(args[0] == "incus" for args in calls): return []
                    return [{"fingerprint": fingerprint, "restricted": case != "unrestricted", "projects": ["foreign" if case == "wrong-project" else "owned"], "type": "client"}]
                with patch.object(SETUP, "command", side_effect=command), patch.object(SETUP, "native", side_effect=native), \
                     patch.object(Path, "lstat", lstat), patch.object(SETUP.ssl, "SSLContext"), patch.object(SETUP.ssl, "PEM_cert_to_DER_cert", return_value=b"fixture public DER"):
                    if case == "accepted": SETUP.certificates(config, directory, "172.25.0.1")
                    else:
                        with self.assertRaisesRegex(ValueError, "restricted to exactly"): SETUP.certificates(config, directory, "172.25.0.1")
                self.assertEqual(reads.count("/1.0/certificates?recursion=1"), 2)
                self.assertEqual(len([args for args in calls if args[0] == "incus"]), 1)

    def test_help_is_available_without_root_or_host_mutation(self):
        result = subprocess.run(["bash", str(SCRIPT), "--help"], text=True, capture_output=True, check=True)
        self.assertIn("--install-lts", result.stdout); self.assertIn("never migrates", result.stdout)
        self.assertIn("--routing", result.stdout)
        self.assertIn("--trusted-worker-image", result.stdout); self.assertIn("NEVER choose", result.stdout)

    def test_command_space_failure_is_actionable_without_raw_secret_diagnostics(self):
        with patch.object(SETUP.subprocess, "run", return_value=types.SimpleNamespace(returncode=1, stdout=b"", stderr=b"PRIVATE-SENTINEL: No space left on device")):
            with self.assertRaisesRegex(ValueError, "ENOSPC") as result: SETUP.command("bash", "trusted-builder")
            self.assertNotIn("PRIVATE-SENTINEL", str(result.exception))

    def test_portainer_output_keeps_api_and_worker_gateways_distinct_and_emits_only_file_paths(self):
        config = {**self.config(), "listen": "172.25.0.1", "tlsName": "incus.internal", "httpsPort": 8443, "policyPort": 8444,
                  "internalUrl": "http://10.25.0.1:3079"}
        directory = Path("/etc/agentor/incus") / INSTALLATION
        with patch.object(SETUP, "command") as commands:
            values = SETUP.portainer_environment(config, directory, SETUP.ipaddress.IPv4Interface("10.25.0.1/24"),
                                                {"alias": "owned-default", "fingerprint": "a" * 64})
            commands.assert_not_called()
        self.assertEqual(values["INCUS_API_HOST_ADDRESS"], "172.25.0.1"); self.assertEqual(values["INCUS_WORKER_GATEWAY"], "10.25.0.1")
        self.assertEqual(values["INCUS_TLS_NAME"], "incus.internal"); self.assertEqual(values["INCUS_INTERNAL_PORT"], "3079")
        for name, file in (("CLIENT_CERT", "client.crt"), ("CLIENT_KEY", "client.key"), ("SERVER_CERT", "server.crt"), ("POLICY_CERT", "policy.crt")):
            self.assertEqual(values["INCUS_" + name + "_SOURCE"], str(directory / file))
        self.assertEqual(values["INCUS_WORKER_IMAGE"], "owned-default"); self.assertEqual(values["INCUS_CONVERTER_SEED_FINGERPRINT"], "a" * 64)
        self.assertNotIn("AGENTOR_INCUS_ORCHESTRATOR_IMAGE", values)

    @contextlib.contextmanager
    def default_fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / INSTALLATION; SETUP.namespace(directory, INSTALLATION)
            config = {**self.config(), "imageWorkDir": str(directory / "scratch")}
            source, fingerprint = "sha256:" + "a" * 64, "b" * 64
            recipe = SETUP.default_recipe(source); alias = "agentor-12345678-" + recipe[:16]
            registry = {"aliases": [], "image": {"fingerprint": fingerprint, "type": "virtual-machine", "architecture": "x86_64",
                "properties": {"source_image_id": source, "recipe_id": recipe, "source_architecture": "amd64", "bootstrap_generation": "3", "converter_version": "v0.4.0"}}}
            calls = []; phases = []
            def native(path):
                self.assertIn("?project=owned", path)
                if path.startswith("/1.0/images/aliases?"): return copy.deepcopy(registry["aliases"])
                if path.startswith("/1.0/images/aliases/"): return copy.deepcopy(registry["aliases"][0])
                self.assertTrue(path.startswith("/1.0/images/" + fingerprint + "?")); return copy.deepcopy(registry["image"])
            def command(*args, **kwargs):
                calls.append((args, kwargs))
                if args[:2] == ("docker", "inspect"):
                    return json.dumps([{"Config": {"Env": ["WORKER_IMAGE_PREFIX=operator/", "WORKER_IMAGE=default:stable", "GITHUB_TOKEN=PRIVATE-SENTINEL"]}}]).encode()
                if args[:3] == ("docker", "image", "inspect"):
                    self.assertEqual(args[-1], "operator/default:stable")
                    return json.dumps([{"Id": source, "Architecture": "amd64", "Size": 2500 * 1024**2}]).encode()
                phases.append(json.loads((directory / "config.json").read_text())["defaultImage"]["phase"])
                if args[0] == "bash":
                    self.assertEqual(args[args.index("--source-image") + 1], source); self.assertEqual(args[args.index("--expected-source-id") + 1], source)
                    self.assertEqual(args[args.index("--expected-recipe-id") + 1], recipe); self.assertEqual(args[args.index("--size") + 1], "10G")
                    self.assertIn("--no-import", args); self.assertNotIn("--force", args); self.assertNotIn("--alias", args)
                    self.assertEqual(kwargs["timeout"], 2700); return b"Trusted conversion complete"
                self.assertEqual(args[:4], ("incus", "--force-local", "--project", "owned"))
                if args[4:6] == ("image", "import"): return ("Image imported with fingerprint: " + fingerprint).encode()
                self.assertEqual(args[4:], ("image", "alias", "create", alias, fingerprint))
                registry["aliases"] = [{"name": alias, "target": fingerprint, "type": "virtual-machine"}]; return b""
            with patch.object(SETUP, "command", side_effect=command) as commands, patch.object(SETUP, "native", side_effect=native), \
                 patch.object(SETUP, "pinned_d2vm", return_value=directory / "tools") as converter, \
                 patch.object(SETUP.shutil, "disk_usage", return_value=types.SimpleNamespace(free=100 * 1024**3)), \
                 patch.object(SETUP.shutil, "which", return_value="/usr/bin/tool"):
                yield directory, config, registry, commands, converter, calls, phases

    def test_default_bootstrap_pins_source_recipe_and_ack_before_reuse(self):
        with self.default_fixture() as (directory, config, registry, commands, converter, calls, phases):
            result = SETUP.bootstrap_default_image(config, directory, "operator/default:stable")
            self.assertEqual(result["phase"], "ready"); self.assertEqual(result["fingerprint"], registry["image"]["fingerprint"])
            self.assertEqual(phases, ["converting", "import-pending", "alias-pending"])
            self.assertEqual(json.loads((directory / "config.json").read_text())["defaultImage"], result)
            before = copy.deepcopy(config); old_calls = len(calls)
            self.assertEqual(SETUP.bootstrap_default_image(config, directory), result); self.assertEqual(config, before)
            self.assertTrue(all(call[0][0] == "docker" for call in calls[old_calls:])); converter.assert_called_once()

    def test_default_recipe_matches_the_existing_builder_hash_expression(self):
        source = "sha256:" + "a" * 64
        expression = next(line for line in (SETUP.ROOT / "build-incus-worker-image.sh").read_text().splitlines() if line.startswith("RECIPE_ID="))
        shell = 'set -euo pipefail; SOURCE_IMAGE_ID="$1"; REPO_ROOT="$2"; SOURCE_ARCH=amd64; BOOTSTRAP_GENERATION=3; D2VM_VERSION=v0.4.0; DISK_SIZE=10G; '
        result = subprocess.run(["bash", "-c", shell + expression + '; printf "%s" "$RECIPE_ID"', "recipe-test", source, str(SETUP.ROOT.parent)],
                                capture_output=True, text=True, check=True, env={**os.environ, "LC_ALL": "C"})
        self.assertEqual(result.stdout, SETUP.default_recipe(source))

    def test_default_collision_or_current_source_choice_never_runs_conversion(self):
        for case in ("alias-collision", "different-source"):
            with self.subTest(case=case), self.default_fixture() as (directory, config, registry, commands, converter, calls, phases):
                if case == "alias-collision": registry["aliases"] = [{"name": "agentor-12345678-" + SETUP.default_recipe("sha256:" + "a" * 64)[:16], "target": "c" * 64}]
                with self.assertRaises(ValueError): SETUP.bootstrap_default_image(config, directory, "catalog/untrusted:latest" if case == "different-source" else "")
                converter.assert_not_called(); self.assertNotIn("defaultImage", config); self.assertEqual(phases, [])

    def test_missing_default_or_scratch_space_or_tools_fails_before_dispatch(self):
        for case in ("source-missing", "space", "tools", "size"):
            with self.subTest(case=case), self.default_fixture() as (directory, config, registry, commands, converter, calls, phases):
                original = commands.side_effect
                def command(*args, **kwargs):
                    if args[:3] == ("docker", "image", "inspect"):
                        if case == "source-missing": raise SETUP.SetupFailure("image absent")
                        if case == "size": return json.dumps([{"Id": "sha256:" + "a" * 64, "Architecture": "amd64", "Size": True}]).encode()
                    return original(*args, **kwargs)
                commands.side_effect = command
                with patch.object(SETUP.shutil, "disk_usage", return_value=types.SimpleNamespace(free=0 if case == "space" else 100 * 1024**3)), \
                     patch.object(SETUP.shutil, "which", return_value=None if case == "tools" else "/usr/bin/tool"):
                    with self.assertRaises(ValueError): SETUP.bootstrap_default_image(config, directory)
                converter.assert_not_called(); self.assertNotIn("defaultImage", config); self.assertEqual(phases, [])

    def test_import_lost_ack_or_bad_metadata_stays_pending_without_alias_or_replay(self):
        for case in ("lost-ack", "no-fingerprint", "wrong-type", "wrong-recipe"):
            with self.subTest(case=case), self.default_fixture() as (directory, config, registry, commands, converter, calls, phases):
                original = commands.side_effect
                def command(*args, **kwargs):
                    if args[4:6] == ("image", "import"):
                        if case == "lost-ack": raise SETUP.SetupFailure("lost import response")
                        if case == "no-fingerprint": return b"unexpected success-looking response"
                    return original(*args, **kwargs)
                commands.side_effect = command
                if case == "wrong-type": registry["image"]["type"] = "container"
                if case == "wrong-recipe": registry["image"]["properties"]["recipe_id"] = "c" * 64
                with self.assertRaises(ValueError): SETUP.bootstrap_default_image(config, directory)
                self.assertEqual(config["defaultImage"]["phase"], "import-pending"); self.assertEqual(registry["aliases"], [])
                count = len(calls)
                with self.assertRaisesRegex(ValueError, "never replay"): SETUP.bootstrap_default_image(config, directory)
                self.assertTrue(all(call[0][0] == "docker" for call in calls[count:]))

    def test_ready_record_native_identity_change_fails_without_mutation(self):
        with self.default_fixture() as (directory, config, registry, commands, converter, calls, phases):
            SETUP.bootstrap_default_image(config, directory); before = copy.deepcopy(config); count = len(calls)
            registry["aliases"][0]["target"] = "c" * 64
            with self.assertRaisesRegex(ValueError, "alias changed"): SETUP.bootstrap_default_image(config, directory)
            self.assertEqual(config, before); self.assertTrue(all(call[0][0] == "docker" for call in calls[count:]))

    def test_alias_lost_ack_retains_known_fingerprint_and_never_replays(self):
        with self.default_fixture() as (directory, config, registry, commands, converter, calls, phases):
            original = commands.side_effect
            def command(*args, **kwargs):
                result = original(*args, **kwargs)
                if args[4:7] == ("image", "alias", "create"): raise SETUP.SetupFailure("alias response lost")
                return result
            commands.side_effect = command
            with self.assertRaises(ValueError): SETUP.bootstrap_default_image(config, directory)
            self.assertEqual(config["defaultImage"]["phase"], "alias-pending")
            self.assertEqual(config["defaultImage"]["fingerprint"], registry["image"]["fingerprint"])
            count = len(calls)
            with self.assertRaisesRegex(ValueError, "never replay"): SETUP.bootstrap_default_image(config, directory)
            self.assertTrue(all(call[0][0] == "docker" for call in calls[count:]))

    def test_pinned_converter_hashes_are_verified_before_write_or_execute(self):
        body = b"fixed official executable test fixture"; buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as packed:
            member = tarfile.TarInfo("d2vm"); member.size = len(body); packed.addfile(member, io.BytesIO(body))
        archive = buffer.getvalue()
        for case in ("accepted", "archive-changed", "binary-changed", "version-changed"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary) / INSTALLATION; SETUP.namespace(directory, INSTALLATION)
                response = MagicMock(); response.url = "https://release-assets.githubusercontent.com/pinned"; response.read.return_value = archive
                with patch.object(SETUP, "urlopen") as download, patch.object(SETUP, "D2VM_ARCHIVE_SHA", "0" * 64 if case == "archive-changed" else hashlib.sha256(archive).hexdigest()), \
                     patch.object(SETUP, "D2VM_BINARY_SHA", "0" * 64 if case == "binary-changed" else hashlib.sha256(body).hexdigest()), \
                     patch.object(SETUP, "command", return_value=b"d2vm version " + (b"v0.4.1" if case == "version-changed" else b"v0.4.0")) as execute:
                    download.return_value.__enter__.return_value = response
                    if case == "accepted":
                        self.assertEqual(SETUP.pinned_d2vm(directory), directory / "converter-tools")
                        self.assertEqual((directory / "converter-tools/d2vm").read_bytes(), body)
                    else:
                        with self.assertRaises(ValueError): SETUP.pinned_d2vm(directory)
                    download.assert_called_once_with(SETUP.D2VM_URL, timeout=30)
                    if case in ("archive-changed", "binary-changed"): execute.assert_not_called(); self.assertFalse((directory / "converter-tools/d2vm").exists())

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
