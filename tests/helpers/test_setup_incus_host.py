"""Installer preflights; external mutation commands are always mocked."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import select
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
    def test_installs_operator_recovery_and_existing_source_module_as_private_files(self):
        config=self.config();config.update(listen="172.25.0.1",policyPort=9444)
        library=Path("/usr/local/lib/agentor-incus")/INSTALLATION
        directory=Path("/etc/agentor/incus")/INSTALLATION
        with tempfile.TemporaryDirectory() as temporary, patch.object(SETUP,"SYSTEMD_SYSTEM",Path(temporary)), \
             patch.object(SETUP,"namespace"),patch.object(SETUP,"owned"), patch.object(SETUP,"verify_startup_order"), \
             patch.object(SETUP,"write_file") as write,patch.object(SETUP,"command"):
            SETUP.install_units(config,directory,library)
        for name in ("recover-incus-job.py","incus-host-mount-sources.py","incus-gpu-mdev.py","incus-admin-network-policy.py"):
            write.assert_any_call(library/name,(SCRIPT.parent/name).read_bytes(),0o600,True)
        units = [call.args[1] for call in write.call_args_list if str(call.args[0]).endswith("-policy.service")]
        self.assertEqual(len(units), 1)
        self.assertIn('"--admin-pool" "owned-pool"', units[0])
        self.assertIn('"--orchestrator-container" "agentor-orchestrator"', units[0])

    def test_owned_boot_gate_is_idempotent_preserves_operator_dropins_and_migrates_legacy_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); units=base/'systemd'; units.mkdir(); directory=base/'operator'; directory.mkdir(mode=0o700)
            library=base/'library'; config={**self.config(), 'listen':'172.25.0.1', 'policyPort':9444}
            (directory/'config.json').write_text(json.dumps(config)); (directory/'config.json').chmod(0o600)
            dropins=units/'docker.service.d'; dropins.mkdir(); operator=dropins/'10-operator.conf'; operator.write_text('[Service]\nEnvironment=KEEP_OPERATOR_VALUE=yes\n')
            with patch.object(SETUP,'SYSTEMD_SYSTEM',units), patch.object(SETUP,'command') as command, \
                 patch.object(SETUP,'verify_startup_order') as verify, contextlib.redirect_stdout(io.StringIO()):
                SETUP.install_units(config,directory,library)
                self.assertEqual(config['bridgeReadyTimeoutSeconds'],120)
                self.assertEqual(json.loads((directory/'config.json').read_text())['bridgeReadyTimeoutSeconds'],120)
                config['bridgeReadyTimeoutSeconds']=47
                (directory/'config.json').write_text(json.dumps(config))
                SETUP.install_units(config,directory,library)
            ready=(units/'agentor-incus-12345678-bridge-ready.service').read_text()
            dropin=(dropins/'50-agentor-incus-12345678-bridge.conf').read_text()
            self.assertIn('Wants=incus.service\nAfter=incus.service\nBefore=docker.service',ready)
            self.assertIn('RequiresMountsFor="/srv/agentor"',ready)
            self.assertIn('"--bridge-ready" "--config"',ready); self.assertIn('TimeoutStartSec=62\n',ready)
            self.assertNotIn('RemainAfterExit=yes',ready); self.assertNotIn('After=docker.service',ready)
            self.assertIn('Requires=agentor-incus-12345678-bridge-ready.service',dropin)
            self.assertIn('After=agentor-incus-12345678-bridge-ready.service',dropin)
            self.assertEqual(operator.read_text(),'[Service]\nEnvironment=KEEP_OPERATOR_VALUE=yes\n')
            self.assertEqual(verify.call_count,2)
            self.assertEqual(json.loads((directory/'config.json').read_text())['bridgeReadyTimeoutSeconds'],47)
            self.assertFalse(any(call.args[:2] in [('systemctl','start'),('systemctl','restart')] and 'docker' in ' '.join(call.args) for call in command.call_args_list))

    def test_boot_install_foreign_leaf_or_cycle_refusal_happens_before_any_installed_script_write(self):
        for case in ('foreign','symlink','fifo','writable','directory-symlink','directory-writable','cycle'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                units=Path(temporary); dropins=units/'docker.service.d'; dropins.mkdir()
                target=dropins/'50-agentor-incus-12345678-bridge.conf'
                if case=='foreign': target.write_text('operator-managed\n')
                elif case=='symlink': target.symlink_to(units/'absent')
                elif case=='fifo': os.mkfifo(target)
                elif case=='writable': target.write_text('# Agentor installation '+INSTALLATION+'\n'); target.chmod(0o666)
                elif case=='directory-symlink':
                    dropins.rmdir(); (units/'foreign-directory').mkdir(); dropins.symlink_to(units/'foreign-directory')
                elif case=='directory-writable': dropins.chmod(0o777)
                with patch.object(SETUP,'SYSTEMD_SYSTEM',units), patch.object(SETUP,'namespace') as namespace, \
                     patch.object(SETUP,'write_file') as write, patch.object(SETUP,'command') as command, \
                     patch.object(SETUP,'verify_startup_order',side_effect=SETUP.SetupFailure('cycle') if case=='cycle' else None) as verify:
                    with self.assertRaisesRegex(ValueError,'foreign|cycle|symlink|protected'):
                        SETUP.install_units({**self.config(),'listen':'172.25.0.1','policyPort':9444},units,units/'library')
                    namespace.assert_not_called(); write.assert_not_called(); command.assert_not_called()
                    if case!='cycle': verify.assert_not_called()

    def test_real_systemd_verifier_accepts_valid_order_and_refuses_direct_or_transitive_operator_cycles(self):
        for cycle in ('none','direct','transitive','boot-only','boot-warning'):
            with self.subTest(cycle=cycle), tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                for name in ('sysinit.target','basic.target','shutdown.target','network-online.target'):
                    (root/name).write_text('[Unit]\nDefaultDependencies=no\n')
                (root/'incus.service').write_text('[Unit]\nDefaultDependencies=no\n[Service]\nExecStart=/bin/true\n')
                (root/'docker.socket').write_text('[Unit]\nDefaultDependencies=no\nBefore=docker.service\n[Socket]\nListenStream=/run/fixture-docker.sock\n')
                (root/'incus.service.d').mkdir()
                if cycle not in ('none','boot-warning'):
                    (root/'incus.service.d/operator.conf').write_text('[Unit]\nAfter='+('docker.service' if cycle=='direct' else 'fixture-network.service')
                        + ('\nWants=fixture-network.service' if cycle=='transitive' else '')+'\n')
                (root/'fixture-network.service').write_text('[Unit]\nDefaultDependencies=no\nAfter=docker.service\n[Service]\nExecStart=/bin/true\n')
                (root/'default.target').write_text('[Unit]\nDefaultDependencies=no\nWants=docker.service fixture-network.service'+(' broken.service' if cycle=='boot-warning' else '')+'\n')
                (root/'broken.service').write_text('[Unit]\nDefaultDependencies=no\n[Service]\nExecStart=/fixture-nonexistent-executable\n')
                ready='[Unit]\nWants=incus.service\nAfter=incus.service\nBefore=docker.service\n[Service]\nType=oneshot\nExecStart=/bin/true\n'
                docker=b'[Unit]\nDefaultDependencies=no\nRequires=docker.socket\nAfter=docker.socket\n[Service]\nExecStart=/bin/true\n'
                dropin='[Unit]\nRequires=fixture-bridge-ready.service\nAfter=fixture-bridge-ready.service\n'
                original=SETUP.tempfile.TemporaryDirectory; staged=[]
                def staging(*args,**kwargs):
                    result=original(*args,**kwargs); staged.append(Path(result.name)); return result
                with patch.dict(os.environ,{'SYSTEMD_UNIT_PATH':temporary}), patch.object(SETUP,'command',return_value=docker), \
                     patch.object(SETUP.tempfile,'TemporaryDirectory',side_effect=staging), contextlib.redirect_stderr(io.StringIO()):
                    if cycle in ('none','boot-warning'): SETUP.verify_startup_order('fixture-bridge-ready.service',ready,dropin)
                    else:
                        with self.assertRaisesRegex(ValueError,'dependency validation failed'):
                            SETUP.verify_startup_order('fixture-bridge-ready.service',ready,dropin)
                self.assertTrue(staged); self.assertTrue(all(not path.exists() for path in staged))

    def test_systemd_late_empty_dependency_assignments_do_not_remove_owned_docker_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for name in ('sysinit.target','basic.target','shutdown.target'):
                (root/name).write_text('[Unit]\nDefaultDependencies=no\n')
            (root/'docker.service').write_text('[Unit]\nDefaultDependencies=no\n[Service]\nExecStart=/bin/true\n')
            (root/'docker.service.d').mkdir()
            (root/'docker.service.d/50-owned.conf').write_text('[Unit]\nRequires=fixture-gate.service\nAfter=fixture-gate.service\n')
            (root/'docker.service.d/90-operator.conf').write_text('[Unit]\nRequires=\nAfter=\n')
            (root/'fixture-gate.service').write_text('[Unit]\nDefaultDependencies=no\nWants=incus.service\nAfter=incus.service\n[Service]\nType=oneshot\nExecStart=/bin/true\n')
            (root/'incus.service').write_text('[Unit]\nDefaultDependencies=no\nAfter=docker.service\n[Service]\nExecStart=/bin/true\n')
            result=subprocess.run(['systemd-analyze','verify','--man=no','--generators=no',str(root/'docker.service')],
                capture_output=True,env={**os.environ,'SYSTEMD_UNIT_PATH':temporary,'LC_ALL':'C'},timeout=15)
            self.assertIn(b'ordering cycle',result.stderr.lower())

    def test_bridge_ready_installed_mode_never_dispatches_docker_setup_or_routing(self):
        config={**self.config(),'internalUrl':'http://10.25.0.1:3079','bridgeReadyTimeoutSeconds':47}
        path=Path('/etc/agentor/incus')/INSTALLATION/'config.json'
        info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_size=1024)
        with patch.object(sys,'argv',['installer','--bridge-ready','--config',str(path)]), \
             patch.object(SETUP.os,'geteuid',return_value=0), patch.object(SETUP.os,'umask'), \
             patch.object(SETUP.SOURCES,'directory_identity'), patch.object(Path,'lstat',return_value=info), \
             patch.object(Path,'read_text',return_value=json.dumps(config)), patch.object(SETUP,'bridge_ready') as ready, \
             patch.object(SETUP,'install_units') as install, patch.object(SETUP,'docker_context') as docker, \
             patch.object(SETUP,'resource_setup') as resources, patch.object(SETUP,'routing') as routing:
            SETUP.main()
            ready.assert_called_once_with(config)
            install.assert_not_called(); docker.assert_not_called(); resources.assert_not_called(); routing.assert_not_called()

    def test_bridge_gate_waits_for_real_predicates_without_docker_or_mutation_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); SETUP.namespace(base/INSTALLATION,INSTALLATION)
            config={**self.config(),'internalUrl':'http://10.25.0.1:3079','bridgeReadyTimeoutSeconds':1}
            network={'name':config['network'],'managed':True,'type':'bridge','config':{SETUP.MARKER:INSTALLATION,'ipv4.address':'10.25.0.1/24'}}
            link=[{'ifname':config['network'],'flags':['UP'],'addr_info':[{'family':'inet','local':'10.25.0.1','prefixlen':24}]}]
            clock=[0.0]; calls=[]; observations=[0,0]; output=io.StringIO()
            def command(*args,**kwargs):
                calls.append((args,kwargs['timeout'])); self.assertGreater(kwargs['timeout'],0); self.assertLessEqual(kwargs['timeout'],1-clock[0])
                if args[0]=='incus':
                    observations[0]+=1
                    if observations[0]==1: raise SETUP.SetupFailure('Fixture daemon not ready')
                    return json.dumps(network).encode()
                self.assertEqual(args,('ip','-j','-4','address','show','dev',config['network']))
                observations[1]+=1; return json.dumps([] if observations[1]==1 else link).encode()
            with patch.object(SETUP,'OPERATOR_ROOT',base), patch.object(SETUP,'installation_id',return_value=INSTALLATION), \
                 patch.object(SETUP,'command',side_effect=command), patch.object(SETUP.time,'monotonic',side_effect=lambda:clock[0]), \
                 patch.object(SETUP.time,'sleep',side_effect=lambda duration:clock.__setitem__(0,clock[0]+duration)), contextlib.redirect_stdout(output):
                SETUP.bridge_ready(config)
            self.assertEqual(observations,[3,2]); self.assertLess(clock[0],1)
            self.assertIn('Docker startup may proceed',output.getvalue()); self.assertNotIn(INSTALLATION,output.getvalue())
            self.assertTrue(all(args[0] in ('incus','ip') for args,_ in calls))

    def test_bridge_gate_rejects_ownership_binding_and_installation_changes_or_bounded_unready_observations(self):
        for case in ('owner','binding','installation','not-up','missing','late-read'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                base=Path(temporary); SETUP.namespace(base/INSTALLATION,INSTALLATION)
                config={**self.config(),'internalUrl':'http://10.25.0.1:3079','bridgeReadyTimeoutSeconds':1}
                network={'name':config['network'],'managed':True,'type':'bridge','config':{SETUP.MARKER:INSTALLATION,'ipv4.address':'10.25.0.1/24'}}
                if case=='owner': network['config'][SETUP.MARKER]='foreign'
                if case=='binding': config['internalUrl']='http://10.25.99.1:3079'
                clock=[0.0]; calls=[]; error=io.StringIO()
                def command(*args,**kwargs):
                    calls.append(args)
                    if args[0]=='incus': return json.dumps(network).encode()
                    self.assertEqual(args[0],'ip')
                    if case=='late-read': clock[0]=1.0
                    return json.dumps([] if case=='missing' else [{'ifname':config['network'],'flags':[] if case=='not-up' else ['UP'],
                        'addr_info':[{'family':'inet','local':'10.25.0.1','prefixlen':24}]}]).encode()
                with patch.object(SETUP,'OPERATOR_ROOT',base), patch.object(SETUP,'installation_id',return_value='foreign' if case=='installation' else INSTALLATION), \
                     patch.object(SETUP,'command',side_effect=command), patch.object(SETUP.time,'monotonic',side_effect=lambda:clock[0]), \
                     patch.object(SETUP.time,'sleep',side_effect=lambda duration:clock.__setitem__(0,clock[0]+duration)), \
                     contextlib.redirect_stderr(error), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(ValueError): SETUP.bridge_ready(config)
                self.assertIn('Docker startup remains blocked',error.getvalue())
                self.assertTrue(all(args[0] in ('incus','ip') for args in calls))
                if case in ('owner','binding','installation'): self.assertFalse(any(args[0]=='ip' for args in calls))

    def test_bridge_gate_budget_is_finite_validated_and_preserves_operator_choice(self):
        self.assertEqual(SETUP.bridge_ready_timeout({}),120)
        for budget in (1,47,3600): self.assertEqual(SETUP.bridge_ready_timeout({'bridgeReadyTimeoutSeconds':budget}),budget)
        for budget in (None,True,False,0,-1,1.5,3601,'120'):
            with self.subTest(budget=budget), self.assertRaisesRegex(ValueError,'startup policy was not changed'):
                SETUP.bridge_ready_timeout({'bridgeReadyTimeoutSeconds':budget})

    def test_context_rejects_missing_or_stale_controller_endpoint_before_any_mutation(self):
        network = {"Id": "a" * 64, "Driver": "bridge", "Internal": False, "Options": {},
            "IPAM": {"Config": [{"Subnet": "172.25.0.0/24", "Gateway": "172.25.0.1"}]}}
        container = {"State": {"Running": True}, "Mounts": [{"Destination": "/data", "Source": "/srv/agentor", "RW": True, "Type": "bind"}],
            "NetworkSettings": {"Networks": {"control": {"NetworkID": network["Id"], "EndpointID": "b" * 64, "IPAddress": "172.25.0.2"}}}}
        for key, value in ((None, None), ("NetworkID", ""), ("NetworkID", "c" * 64), ("EndpointID", ""), ("IPAddress", ""), ("running", False)):
            changed = copy.deepcopy(container)
            if key == "running": changed["State"]["Running"] = value
            elif key: changed["NetworkSettings"]["Networks"]["control"][key] = value
            with patch.object(SETUP, "command", side_effect=[json.dumps([changed]).encode(), json.dumps([network]).encode()]) as commands, \
                 patch.object(SETUP.SOURCES, "canonical", side_effect=lambda path: path), \
                 patch.object(SETUP.SOURCES, "directory_identity"), patch.object(SETUP, "incus") as mutation:
                if key is None:
                    self.assertEqual(SETUP.docker_context("agentor-orchestrator", "control", "/srv/agentor")[-1], "172.25.0.2")
                else:
                    with self.assertRaisesRegex(ValueError, "endpoint|IPv4 address|not running"):
                        SETUP.docker_context("agentor-orchestrator", "control", "/srv/agentor")
                mutation.assert_not_called()
                self.assertTrue(all(call.args[:2] in (("docker", "inspect"), ("docker", "network")) for call in commands.call_args_list))

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

    def test_update_policy_uses_installed_config_without_provisioning_or_conversion(self):
        config = {**self.config(), 'listen': '172.25.0.1', 'policyPort': 8444}
        path = Path('/etc/agentor/incus') / INSTALLATION / 'config.json'
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_size=1024)
        with patch.object(sys, 'argv', ['installer', '--update-policy', '--config', str(path)]), \
             patch.object(SETUP.os, 'geteuid', return_value=0), patch.object(SETUP.os, 'umask'), \
             patch.object(SETUP.SOURCES, 'directory_identity'), patch.object(Path, 'lstat', return_value=info), \
             patch.object(Path, 'read_text', return_value=json.dumps(config)), \
             patch.object(SETUP, 'installation_id', return_value=INSTALLATION), \
             patch.object(SETUP, 'install_units') as install, patch.object(SETUP, 'routing') as routing, \
             patch.object(SETUP, 'resource_setup') as resources, patch.object(SETUP, 'bootstrap_default_image') as images:
            SETUP.main()
            install.assert_called_once_with(config, path.parent, Path('/usr/local/lib/agentor-incus') / INSTALLATION)
            routing.assert_not_called(); resources.assert_not_called(); images.assert_not_called()
            with patch.object(SETUP, 'installation_id', return_value='foreign'):
                with self.assertRaisesRegex(ValueError, 'Installation identity changed'):
                    SETUP.main()
            self.assertEqual(install.call_count, 1)

    def test_help_is_available_without_root_or_host_mutation(self):
        result = subprocess.run(["bash", str(SCRIPT), "--help"], text=True, capture_output=True, check=True)
        self.assertIn("--install-lts", result.stdout); self.assertIn("never migrates", result.stdout)
        self.assertIn("--routing", result.stdout); self.assertIn("--enable-physical-gpu", result.stdout)
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

    def test_explicit_usb_enablement_preserves_other_restrictions_and_rejects_foreign_policy(self):
        config = self.config(); config["usbEnabled"] = True
        project = {"name": config["project"], "config": {SETUP.MARKER: INSTALLATION,
            "features.images": "true", "features.storage.volumes": "true", "features.networks": "false",
            "restricted": "true", "restricted.devices.nic": "managed", "restricted.devices.disk": "allow",
            "restricted.devices.usb": "block", "restricted.networks.access": config["network"],
            "restricted.devices.disk.paths": "/srv/approved"}}
        pool = {"name": config["pool"], "driver": "dir", "status": "Created", "config": {SETUP.MARKER: INSTALLATION}}
        network = {"name": config["network"], "managed": True, "type": "bridge", "config": {SETUP.MARKER: INSTALLATION,
            "ipv4.nat": "true", "ipv6.address": "none", "ipv4.address": "10.25.0.1/24"}}
        def resource(kind, name): return copy.deepcopy({"/1.0/projects": project, "/1.0/networks": network, "/1.0/storage-pools": pool}[kind])
        def enable(*args):
            self.assertEqual(args, ("project", "set", config["project"], "restricted.devices.usb=allow"))
            project["config"]["restricted.devices.usb"] = "allow"
        with patch.object(SETUP, "resource", side_effect=resource), patch.object(SETUP, "incus", side_effect=enable) as commands:
            SETUP.resource_setup(config, ["/srv/approved"]); self.assertEqual(commands.call_count, 1)
            SETUP.resource_setup(config, ["/srv/approved"]); self.assertEqual(commands.call_count, 1)
            project["config"]["restricted.devices.usb"] = "block"; project["config"]["restricted.devices.gpu"] = "allow"
            with self.assertRaisesRegex(ValueError, "restrictions differ"): SETUP.resource_setup(config, ["/srv/approved"])
            self.assertEqual(commands.call_count, 1)

    def test_explicit_gpu_profile_enables_only_gpu_and_binds_operator_profile(self):
        config = self.config(); config["gpuMdevProfile"] = "i915-GVTg_V5_4"
        project = {"name": config["project"], "config": {SETUP.MARKER: INSTALLATION,
            "features.images": "true", "features.storage.volumes": "true", "features.networks": "false",
            "restricted": "true", "restricted.devices.nic": "managed", "restricted.devices.disk": "allow",
            "restricted.networks.access": config["network"], "restricted.devices.disk.paths": "/srv/approved"}}
        pool = {"name": config["pool"], "driver": "dir", "status": "Created", "config": {SETUP.MARKER: INSTALLATION}}
        network = {"name": config["network"], "managed": True, "type": "bridge", "config": {SETUP.MARKER: INSTALLATION,
            "ipv4.nat": "true", "ipv6.address": "none", "ipv4.address": "10.25.0.1/24"}}
        def resource(kind, name): return copy.deepcopy({"/1.0/projects": project, "/1.0/networks": network, "/1.0/storage-pools": pool}[kind])
        def enable(*args):
            self.assertEqual(args, ("project", "set", config["project"], "restricted.devices.gpu=allow", "user.agentor.gpu-mdev-profile=i915-GVTg_V5_4"))
            project["config"].update({"restricted.devices.gpu": "allow", "user.agentor.gpu-mdev-profile": "i915-GVTg_V5_4"})
        with patch.object(SETUP, "resource", side_effect=resource), patch.object(SETUP, "incus", side_effect=enable) as commands:
            SETUP.resource_setup(config, ["/srv/approved"])
            SETUP.resource_setup(config, ["/srv/approved"])
            self.assertEqual(commands.call_count, 1)
            project["config"]["restricted.devices.pci"] = "allow"
            with self.assertRaisesRegex(ValueError, "restrictions differ"): SETUP.resource_setup(config, ["/srv/approved"])
            self.assertEqual(commands.call_count, 1)

    def test_physical_gpu_opt_in_is_idempotent_and_preserves_mdev_and_device_restrictions(self):
        for profile in ("", "i915-GVTg_V5_4"):
            config = {**self.config(), "gpuPhysicalEnabled": True, "gpuMdevProfile": profile}
            project = {"name": config["project"], "config": {SETUP.MARKER: INSTALLATION,
                "features.images": "true", "features.storage.volumes": "true", "features.networks": "false",
                "restricted": "true", "restricted.devices.nic": "managed", "restricted.devices.disk": "allow",
                "restricted.networks.access": config["network"], "restricted.devices.disk.paths": "/srv/approved"}}
            if profile:
                project["config"].update({"restricted.devices.gpu": "allow", "user.agentor.gpu-mdev-profile": profile})
            pool = {"name": config["pool"], "driver": "dir", "status": "Created", "config": {SETUP.MARKER: INSTALLATION}}
            network = {"name": config["network"], "managed": True, "type": "bridge", "config": {SETUP.MARKER: INSTALLATION,
                "ipv4.nat": "true", "ipv6.address": "none", "ipv4.address": "10.25.0.1/24"}}
            def resource(kind, name): return copy.deepcopy({"/1.0/projects": project, "/1.0/networks": network, "/1.0/storage-pools": pool}[kind])
            def enable(*args):
                self.assertEqual(args, ("project", "set", config["project"], "restricted.devices.gpu=allow", "user.agentor.gpu-physical=true"))
                project["config"].update({"restricted.devices.gpu": "allow", "user.agentor.gpu-physical": "true"})
            with self.subTest(profile=profile), patch.object(SETUP, "resource", side_effect=resource), patch.object(SETUP, "incus", side_effect=enable) as commands:
                SETUP.resource_setup(config, ["/srv/approved"])
                SETUP.resource_setup(config, ["/srv/approved"])
                self.assertEqual(commands.call_count, 1)
                for key, value in (("restricted.devices.pci", "allow"), ("restricted.devices.usb", "allow"),
                                   ("restricted.devices.unix-char", "allow"), ("restricted.devices.unix-block", "allow"),
                                   ("restricted.virtual-machines.lowlevel", "allow"), ("user.agentor.gpu-physical", "false")):
                    project["config"][key] = value
                    with self.assertRaises(ValueError): SETUP.resource_setup(config, ["/srv/approved"])
                    del project["config"][key]
                    project["config"]["user.agentor.gpu-physical"] = "true"
                with self.assertRaises(ValueError): SETUP.resource_setup({**config, "gpuPhysicalEnabled": False}, ["/srv/approved"])
                self.assertEqual(commands.call_count, 1)
                del project["config"]["user.agentor.gpu-physical"]
                if not profile:
                    with self.assertRaisesRegex(ValueError, "ambiguous"): SETUP.resource_setup(config, ["/srv/approved"])
                    self.assertEqual(commands.call_count, 1)

    def test_gpu_profile_admission_reads_real_shaped_sysfs_without_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); params = root / 'module/i915/parameters'; params.mkdir(parents=True)
            (params/'enable_gvt').write_text('N')
            pci = root / 'bus/pci/devices/0000:00:02.0'; pci.mkdir(parents=True)
            driver = root / 'bus/pci/drivers/i915'; driver.mkdir(parents=True)
            (pci/'driver').symlink_to(driver); (pci/'vendor').write_text('0x8086')
            path = pci / 'mdev_supported_types/i915-GVTg_V5_4'; path.mkdir(parents=True)
            (path/'device_api').write_text('vfio-pci'); (path/'available_instances').write_text('1')
            with self.assertRaisesRegex(ValueError, 'disabled'): SETUP.GPU_MDEV.require_profile('i915-GVTg_V5_4', root)
            (params/'enable_gvt').write_text('Y')
            before = {str(p): p.read_bytes() for p in root.rglob('*') if p.is_file()}
            self.assertEqual(SETUP.GPU_MDEV.require_profile('i915-GVTg_V5_4', root), ['0000:00:02.0'])
            self.assertEqual(before, {str(p): p.read_bytes() for p in root.rglob('*') if p.is_file()})
            for value in ['0', '-1', 'unknown']:
                (path/'available_instances').write_text(value)
                with self.assertRaisesRegex(ValueError, 'no available'): SETUP.GPU_MDEV.require_profile('i915-GVTg_V5_4', root)
            for value in ['', '../create', 'physical', 'i915-GVTg_V5_8']:
                with self.assertRaises(ValueError): SETUP.GPU_MDEV.require_profile(value, root)

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
        self.assertEqual(len(rules), 7)
        self.assertIn("--ctstate", rules[1]); self.assertIn("--ctstate", rules[4])
        self.assertEqual(rules[2][rules[2].index("--dport") + 1], "3000")
        self.assertEqual(rules[2][rules[2].index("-d") + 1], "172.25.0.2")
        peer = rules[-2]
        self.assertEqual(peer[peer.index("-i") + 1], "workers")
        self.assertEqual(peer[peer.index("-o") + 1], "workers")
        self.assertEqual(peer[peer.index("-s") + 1], "10.25.0.0/24")
        self.assertEqual(peer[peer.index("-d") + 1], "10.25.0.0/24")
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
            with self.assertRaisesRegex(ValueError, "foreign"): SETUP.routing_unlocked(config)
        self.assertEqual([item[0] for item in seen], ["ip", "iptables"])

    def test_real_two_process_routing_writers_serialize_whole_operation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); SETUP.namespace(base / INSTALLATION, INSTALLATION)
            events, release = base / "events", base / "release"
            child = r'''import sys,types,time
from pathlib import Path
script,base,ident,worker=sys.argv[1:];sys.argv=['installer',script]
m=types.ModuleType('routing_child');code=Path(script).read_text().split("<<'PY'\n",1)[1].rsplit('\nPY',1)[0];exec(compile(code,script,'exec'),m.__dict__)
m.OPERATOR_ROOT=Path(base);m.ROUTING_LOCK_WAIT_SECONDS=3
def operation(config):
 with open(Path(base)/'events','a') as f:f.write(worker+'-start\n')
 print('entered',flush=True)
 if worker=='A':
  deadline=time.monotonic()+3
  while not (Path(base)/'release').exists():
   if time.monotonic()>deadline:raise RuntimeError('test release deadline')
   time.sleep(.01)
 with open(Path(base)/'events','a') as f:f.write(worker+'-end\n')
m.routing_unlocked=operation
print('attempting',flush=True);m.routing({'installation':ident})
'''
            writers = []
            try:
                first = subprocess.Popen([sys.executable, "-c", child, str(SCRIPT), str(base), INSTALLATION, "A"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0); writers.append(first)
                for expected in ("attempting", "entered"):
                    self.assertTrue(select.select([first.stdout], [], [], 3)[0]); self.assertEqual(first.stdout.readline().decode().strip(), expected)
                second = subprocess.Popen([sys.executable, "-c", child, str(SCRIPT), str(base), INSTALLATION, "B"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0); writers.append(second)
                self.assertTrue(select.select([second.stdout], [], [], 3)[0]); self.assertEqual(second.stdout.readline().decode().strip(), "attempting")
                self.assertFalse(select.select([second.stdout], [], [], .1)[0]); self.assertEqual(events.read_text(), "A-start\n")
                release.touch()
                for writer in writers:
                    stdout, stderr = writer.communicate(timeout=5); self.assertEqual(writer.returncode, 0, stderr)
                self.assertEqual(events.read_text(), "A-start\nA-end\nB-start\nB-end\n")
                self.assertEqual(stat.S_IMODE((base / INSTALLATION / "routing.lock").stat().st_mode), 0o600)
            finally:
                for writer in writers:
                    if writer.poll() is None: writer.kill()
                    writer.communicate(timeout=5)

    def test_routing_lock_foreign_namespace_or_unsafe_leaf_never_dispatches(self):
        for case in ("owner", "mode", "contents", "symlink", "fifo", "uid"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary); directory = base / INSTALLATION; SETUP.namespace(directory, INSTALLATION); lock = directory / "routing.lock"
                if case == "owner": (directory / "owner").write_text("foreign-installation\n")
                if case in ("mode", "contents", "uid"):
                    lock.write_text("foreign" if case == "contents" else ""); lock.chmod(0o644 if case == "mode" else 0o600)
                if case == "symlink": lock.symlink_to(directory / "owner")
                if case == "fifo": os.mkfifo(lock, 0o600)
                original_fstat = os.fstat
                def fstat(fd):
                    value = original_fstat(fd)
                    return types.SimpleNamespace(st_mode=value.st_mode, st_uid=value.st_uid+1, st_size=value.st_size,
                                                 st_dev=value.st_dev, st_ino=value.st_ino) if case == "uid" else value
                with patch.object(SETUP, "OPERATOR_ROOT", base), patch.object(SETUP.os, "fstat", side_effect=fstat), patch.object(SETUP, "routing_unlocked") as operation:
                    with self.assertRaises((ValueError, OSError)): SETUP.routing(self.config())
                    operation.assert_not_called()

    def test_routing_lock_busy_wait_is_bounded_and_never_dispatches(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); directory = base / INSTALLATION; SETUP.namespace(directory, INSTALLATION)
            fd = os.open(directory / "routing.lock", os.O_RDWR | os.O_CREAT, 0o600)
            try:
                SETUP.fcntl.flock(fd, SETUP.fcntl.LOCK_EX | SETUP.fcntl.LOCK_NB)
                with patch.object(SETUP, "OPERATOR_ROOT", base), patch.object(SETUP, "ROUTING_LOCK_WAIT_SECONDS", .05), patch.object(SETUP, "routing_unlocked") as operation:
                    with self.assertRaisesRegex(ValueError, "routing is busy"): SETUP.routing(self.config())
                    operation.assert_not_called()
            finally: os.close(fd)

    def test_systemd_argument_does_not_expand_path_variables_or_specifiers(self):
        value = SETUP.unit_argument('/srv/a b/$secret%name"file')
        self.assertEqual(value, '"/srv/a b/$$secret%%name\\"file"')

    def test_generated_mount_dependency_resolves_literal_dollar_space_and_percent_data_path(self):
        data = '/srv/agentor $literal%data'
        self.assertEqual(SETUP.SOURCES.canonical(data), data)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); name = 'agentor-incus-12345678-bridge-ready.service'
            config = {**self.config(), 'dataDir': data, 'listen': '172.25.0.1', 'policyPort': 9444}
            with patch.object(SETUP, 'SYSTEMD_SYSTEM', root), patch.object(SETUP, 'namespace'), \
                 patch.object(SETUP, 'verify_startup_order'), patch.object(SETUP, 'command'), patch.object(SETUP, 'write_file') as write:
                SETUP.install_units(config, root / 'operator', root / 'library')
            body = next(call.args[1] for call in write.call_args_list if call.args[0] == root / name)
            self.assertIn('RequiresMountsFor="/srv/agentor $literal%%data"\n', body)
            (root / name).write_text(body)
            for target in ('sysinit.target', 'basic.target', 'shutdown.target'):
                (root / target).write_text('[Unit]\nDefaultDependencies=no\n')
            (root / 'incus.service').write_text('[Unit]\nDefaultDependencies=no\n[Service]\nExecStart=/bin/true\n')
            mount = subprocess.check_output(['systemd-escape', '--path', '--suffix=mount', data], text=True).strip()
            (root / mount).write_text('[Unit]\nDefaultDependencies=no\nAfter=' + name +
                                     '\n[Mount]\nWhat=tmpfs\nType=tmpfs\nWhere=/srv/agentor $literal%%data\n')
            # This reverse ordering must form a cycle only when the generated
            # gate actually depends on the exact DATA mount, including its '$'.
            result = subprocess.run(['systemd-analyze', 'verify', '--man=no', '--generators=no', str(root / name)],
                                    capture_output=True, timeout=15,
                                    env={**os.environ, 'SYSTEMD_UNIT_PATH': temporary, 'LC_ALL': 'C'})
            self.assertIn(b'ordering cycle', result.stderr.lower())

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
             patch.object(SETUP, "command", side_effect=command): SETUP.routing_unlocked(config)
        self.assertEqual(len(submitted), 2); self.assertEqual(submitted[0][0], ("nft", "--check", "-f", "-"))
        self.assertEqual(submitted[1][0], ("nft", "-f", "-")); self.assertEqual(submitted[0][1], submitted[1][1])
        self.assertTrue(submitted[0][1].endswith(b';\n }\n}\n')); self.assertNotIn(b"; } }", submitted[0][1])

    def test_duplicate_owned_nft_rules_remain_rejected_without_auto_repair(self):
        config = self.config(); mutations = []
        entries = [{"chain": {"name": "postrouting", "hook": "postrouting", "type": "nat", "prio": 99}},
                   {"rule": {"comment": "agentor-source-" + INSTALLATION}}, {"rule": {"comment": "agentor-source-" + INSTALLATION}}]
        def command(*args, **kwargs):
            if args[0] == "ip": return b'[{"dev":"eth0"}]'
            if args[:3] == ("iptables", "-w", "-S"): return b"-N DOCKER-USER\n"
            if args[:4] == ("nft", "-j", "list", "tables"):
                return json.dumps({"nftables": [{"table": {"family": "ip", "name": config["sourceTable"]}}]}).encode()
            if args[:4] == ("nft", "-j", "list", "table"): return json.dumps({"nftables": entries}).encode()
            if args[0] == "nft": mutations.append(args)
            return b""
        context = (config["dataDir"], "control", "br-control", "172.25.0.0/24", "172.25.0.1", "172.25.0.2")
        with patch.object(SETUP, "installation_id", return_value=INSTALLATION), patch.object(SETUP, "docker_context", return_value=context), \
             patch.object(SETUP, "native", return_value={"name": config["network"], "config": {SETUP.MARKER: INSTALLATION, "ipv4.address": "10.25.0.1/24"}}), \
             patch.object(SETUP, "command", side_effect=command):
            with self.assertRaisesRegex(ValueError, "source-NAT table is foreign/ambiguous"): SETUP.routing_unlocked(config)
        self.assertEqual(mutations, [])


if __name__ == "__main__": unittest.main()
