import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/test-backup-integration-vm.py'
spec = importlib.util.spec_from_file_location('backup_vm', SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
NONCE = '01234567-89ab-4cde-8fab-0123456789ab'
SHA = 'a' * 64


class BackupVmLauncherTests(unittest.TestCase):
    def proposal(self, root='/tmp/new-backup-vm', base='/tmp/reviewed-base.qcow2'):
        return runner.plan(root, base, SHA, 22941, NONCE)

    def test_plan_preserves_both_full_suites_and_only_fresh_virtual_disks(self):
        proposed = self.proposal()
        self.assertEqual(proposed['suites'], runner.legacy.SUITES)
        self.assertEqual(proposed['resources'], {'cpus': 4, 'memoryGiB': 8, 'diskGiB': 80})
        qemu = proposed['qemu']
        self.assertIn('user,id=net,ipv6=off,hostfwd=tcp:127.0.0.1:22941-:22', qemu)
        self.assertIn('q35,accel=kvm', qemu)
        for forbidden in ['-virtfs', '-fsdev', '-object', '-chardev', '-qmp', '-vnc', '-daemonize', '-pidfile',
                          '-nic', '-net', '-incoming', '-enable-kvm', 'vfio-pci', '/dev/sda', '/var/run/docker.sock']:
            self.assertNotIn(forbidden, qemu)
        blocks = [json.loads(qemu[index + 1]) for index, value in enumerate(qemu) if value == '-blockdev']
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]['file']['filename'], '/tmp/new-backup-vm/root.qcow2')
        self.assertTrue(blocks[0]['backing']['read-only'])
        self.assertTrue(blocks[0]['backing']['file']['read-only'])
        self.assertEqual(blocks[0]['backing']['file']['filename'], '/tmp/new-backup-vm/base.qcow2')
        self.assertTrue(blocks[1]['read-only'])
        self.assertEqual(blocks[1]['file']['filename'], '/tmp/new-backup-vm/seed.img')

    def test_default_cli_is_a_side_effect_free_plan_even_without_host_tools(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--base-image', '/tmp/base.qcow2',
                                 '--base-sha256', SHA, '--run-directory', '/tmp/new-vm', '--ssh-port', '22941'],
                                env={'PATH': '/nonexistent', 'DOCKER_HOST': 'tcp://production:2375'},
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['suites'], runner.legacy.SUITES)
        self.assertEqual(result.stderr, '')

    def test_plan_rejects_unsafe_paths_ports_hashes_and_unknown_suites(self):
        for root, base, checksum, port, nonce, suite in [
            ('relative', '/tmp/base', SHA, 22941, NONCE, 'both'),
            ('/', '/tmp/base', SHA, 22941, NONCE, 'both'),
            ('/tmp/run', '/tmp/run/base', SHA, 22941, NONCE, 'both'),
            ('/tmp/run', '/tmp/base', SHA, 22, NONCE, 'both'),
            ('/tmp/run', '/tmp/base', SHA, 65536, NONCE, 'both'),
            ('/tmp/run', '/tmp/base', 'wrong', 22941, NONCE, 'both'),
            ('/tmp/run', '/tmp/base', SHA, 22941, 'wrong', 'both'),
            ('/tmp/run', '/tmp/base', SHA, 22941, NONCE, 'reduced'),
        ]:
            with self.subTest(root=root, suite=suite), self.assertRaises(ValueError):
                runner.plan(root, base, checksum, port, nonce, suite)

    def test_cloud_init_uses_only_fresh_keys_guest_packages_and_exact_nonce(self):
        config = json.loads(runner.cloud_config(NONCE, 'ssh-ed25519 client-fresh', 'fresh-host-private', 'ssh-ed25519 host-fresh').split('\n', 1)[1])
        self.assertFalse(config['ssh_pwauth'])
        self.assertTrue(config['disable_root'])
        self.assertEqual(config['users'][0]['ssh_authorized_keys'], ['ssh-ed25519 client-fresh'])
        self.assertEqual(config['ssh_keys']['ed25519_private'], 'fresh-host-private')
        self.assertEqual(json.loads(config['write_files'][0]['content'])['nonce'], NONCE)
        self.assertIn('docker.io', config['packages'])
        self.assertIn('docker-compose-v2', config['packages'])
        self.assertEqual(config['runcmd'], [['systemctl', 'enable', '--now', 'docker']])

    def test_guest_entry_refuses_host_before_any_docker_operation(self):
        with mock.patch.object(runner, 'VM_RECORD', Path('/nonexistent/agentor-backup-vm.json')), \
             mock.patch.object(runner.subprocess, 'run') as run, \
             mock.patch.object(runner.subprocess, 'check_output') as output, \
             self.assertRaises((FileNotFoundError, RuntimeError)):
            runner.inside_guest(NONCE, 'both')
        run.assert_not_called(); output.assert_not_called()

    def test_guest_guard_requires_private_root_metadata_and_matching_dmi_uuid(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / 'record'; dmi = Path(directory) / 'dmi'
            record.write_text(json.dumps({'kind': 'agentor-disposable-backup-vm', 'nonce': NONCE}))
            dmi.write_text(NONCE.upper())
            metadata = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o400, st_uid=0, st_size=100)
            with mock.patch.object(Path, 'lstat', return_value=metadata), mock.patch.object(runner.os, 'geteuid', return_value=0):
                runner.assert_guest(NONCE, record, dmi)
                dmi.write_text('ffffffff-ffff-ffff-ffff-ffffffffffff')
                with self.assertRaises(RuntimeError): runner.assert_guest(NONCE, record, dmi)
                dmi.write_text(NONCE)
                for field, value in [('st_uid', 1000), ('st_mode', stat.S_IFLNK | 0o400), ('st_mode', stat.S_IFREG | 0o644), ('st_size', 2048)]:
                    changed = copy.copy(metadata); setattr(changed, field, value)
                    with self.subTest(field=field), mock.patch.object(Path, 'lstat', return_value=changed), self.assertRaises(RuntimeError):
                        runner.assert_guest(NONCE, record, dmi)

    def test_guest_plans_have_distinct_resources_and_keep_exact_suite_arrays(self):
        workspace = runner.guest_plan('workspace', NONCE); instance = runner.guest_plan('instance', NONCE)
        self.assertNotEqual(workspace['prefix'], instance['prefix'])
        self.assertFalse(set(workspace['volumes']) & set(instance['volumes']))
        for name, proposed in [('workspace', workspace), ('instance', instance)]:
            self.assertEqual(proposed['run'][-len(runner.legacy.SUITES[name]):], runner.legacy.SUITES[name])
            service = proposed['override']['services']['test-runner']
            self.assertTrue(service['privileged'])
            self.assertEqual(service['cgroup'], 'private')
            self.assertEqual(service['labels'], {'agentor.backup-vm.nonce': NONCE})
        self.assertEqual(runner.legacy.plan('workspace', 'host-still-blocked', '/source')['execution']['status'], 'blocked')

    def test_failing_workspace_still_runs_complete_instance_suite(self):
        with tempfile.TemporaryDirectory() as directory:
            source, results = Path(directory) / 'source', Path(directory) / 'results'
            source.mkdir()
            commands = []
            def run(command, **kwargs):
                commands.append(command)
                if 'inspect' in command: return types.SimpleNamespace(returncode=1)
                return types.SimpleNamespace(returncode=7 if 'ui/backup-management-real.spec.ts' in command else 0)
            with mock.patch.object(runner, 'assert_guest'), \
                 mock.patch.object(runner, 'GUEST_SOURCE', source), mock.patch.object(runner, 'GUEST_RESULTS', results), \
                 mock.patch.object(runner.subprocess, 'check_output', return_value='fresh-guest-daemon\n'), \
                 mock.patch.object(runner.subprocess, 'run', side_effect=run):
                self.assertEqual(runner.inside_guest(NONCE, 'both'), 7)
            for name, array in runner.legacy.SUITES.items():
                self.assertTrue(any(command[-len(array):] == array for command in commands))
                result = json.loads((results / name / 'result.json').read_text())
                self.assertEqual(result['nonce'], NONCE)
                self.assertEqual(result['exitCode'], 7 if name == 'workspace' else 0)
            self.assertEqual(sum('down' in command for command in commands), 2)

    def test_execute_never_adopts_existing_run_or_block_device_and_low_space_has_no_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'run'; base = Path(directory) / 'base'; base.write_bytes(b'base')
            proposed = self.proposal(str(root), str(base))
            with mock.patch.object(runner.shutil, 'which', return_value='/tool'), \
                 mock.patch.object(runner.subprocess, 'run') as run, \
                 mock.patch.object(runner.subprocess, 'check_output') as output, \
                 mock.patch.object(runner.subprocess, 'Popen') as process:
                root.mkdir()
                with self.assertRaisesRegex(RuntimeError, 'already exists'): runner.execute(proposed)
                root.rmdir()
                proposed['base'] = '/dev/null'
                with self.assertRaisesRegex(RuntimeError, 'never a block device'): runner.execute(proposed)
                proposed['base'] = str(base)
                with mock.patch.object(runner.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=89 * runner.GIB)):
                    with self.assertRaisesRegex(RuntimeError, '90 GiB'): runner.execute(proposed)
                run.assert_not_called(); output.assert_not_called(); process.assert_not_called()
                self.assertFalse(root.exists())

    def test_vm_console_capture_is_bounded_but_drains_process_output(self):
        with tempfile.TemporaryDirectory() as directory:
            stream = io.BytesIO(b'a' * 10000); target = Path(directory) / 'console.log'
            runner.copy_log(stream, target, 1024)
            self.assertEqual(stream.tell(), 10000)
            self.assertTrue(target.read_bytes().startswith(b'a' * 1024))
            self.assertLess(target.stat().st_size, 1200)


if __name__ == '__main__':
    unittest.main()
