import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import struct
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


    def test_log_append_preserves_one_cap_and_drains_every_readiness_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bootstrap.log'
            for index in range(3):
                stream = io.BytesIO(b'x' * 10000)
                runner.copy_log(stream, target, 1024, append=True)
                self.assertEqual(stream.tell(), 10000)
                if index == 0: first = target.read_bytes()
                else: self.assertEqual(target.read_bytes(), first)
            self.assertLess(target.stat().st_size, 1200)

    def test_execute_caps_ssh_logs_and_reaps_ssh_on_timeout_or_spawn_cancellation(self):
        import signal
        import tarfile
        real_popen, real_thread = subprocess.Popen, runner.threading.Thread
        for outcome in ('overlimit', 'observed-failure', 'timeout', 'cancel', 'suite-cancel', 'drain-timeout', 'suite-drain-timeout'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                base, root = Path(directory)/'base.qcow2', Path(directory)/'run'
                header = bytearray(104); header[:4] = b'QFI\xfb'
                struct.pack_into('>I', header, 4, 3); struct.pack_into('>Q', header, 24, 1024*1024)
                base.write_bytes(header)
                proposed = runner.plan(root, base, hashlib.sha256(header).hexdigest(), 22941, NONCE)
                children, events = [], []
                class VM:
                    stdout = io.BytesIO()
                    stopped = False
                    def poll(self): return 0 if self.stopped else None
                    def terminate(self): events.append('terminate')
                    def wait(self, timeout): self.stopped = True; events.append('wait'); return 0
                vm = VM()
                def command(args, **kwargs):
                    if args[0] == 'qemu-img': Path(args[-2]).write_bytes(b'owned disk')
                    elif args[0] == 'ssh-keygen':
                        Path(args[-1]).write_text('private key'); Path(args[-1]+'.pub').write_text('ssh-ed25519 public key')
                    elif args[0] == 'cloud-localds': Path(args[1]).write_bytes(b'owned seed')
                    elif args[0] == 'git' and 'archive' in args:
                        with tarfile.open(fileobj=kwargs['stdout'], mode='w'): pass
                    elif args[0] == 'ssh' and 'tar -cf' in args[-1]:
                        events.append('reports')
                        with tarfile.open(fileobj=kwargs['stdout'], mode='w'): pass
                    return types.SimpleNamespace(returncode=0)
                def popen(args, **kwargs):
                    if args[0] == 'qemu-system-x86_64': return vm
                    self.assertEqual(args[0], 'ssh')
                    suite = '--inside-guest' in args[-1]
                    if outcome == 'overlimit':
                        # Two verbose readiness attempts share the same cap;
                        # the complete suite still drains a third full stream.
                        script = "import sys; [sys.stdout.buffer.write(b'x'*(1024*1024)) for _ in range(65)]"
                        if not children: script += '; sys.exit(1)'
                    elif outcome == 'observed-failure':
                        script = "import sys; print('observed exit'); sys.exit(" + ('7' if suite else '0') + ')'
                    else:
                        waiting = outcome == 'cancel' or suite and outcome in ('timeout', 'suite-cancel')
                        script = "import time; print('fixture',flush=True); time.sleep(60)" if waiting else "print('ready')"
                    child = real_popen([sys.executable, '-c', script], **kwargs); children.append(child)
                    if outcome == 'timeout' and suite:
                        wait = child.wait
                        child.wait = lambda timeout=None: wait(timeout=0.05 if timeout == 4*3600 else timeout)
                    if outcome == 'cancel' or outcome == 'suite-cancel' and suite: os.kill(os.getpid(), signal.SIGTERM)
                    return child
                def thread(*args, **kwargs):
                    if outcome == 'drain-timeout' and children or outcome == 'suite-drain-timeout' and len(children) >= 2:
                        return types.SimpleNamespace(start=lambda: None, is_alive=lambda: True, join=lambda timeout: None)
                    return real_thread(*args, **kwargs)
                try:
                    with mock.patch.object(runner.shutil, 'which', return_value='/stub'), \
                         mock.patch.object(runner.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=100*runner.GIB)), \
                         mock.patch.object(runner.os, 'access', return_value=True), mock.patch.object(runner.socket, 'socket'), \
                         mock.patch.object(runner, 'command', side_effect=command), \
                         mock.patch.object(runner.subprocess, 'check_output', side_effect=lambda args, **kwargs: 'a'*40 if args[0] == 'git' else json.dumps({'format':'qcow2','virtual-size':1024*1024})), \
                         mock.patch.object(runner.subprocess, 'Popen', side_effect=popen), mock.patch.object(runner.threading, 'Thread', side_effect=thread):
                        if outcome == 'overlimit':
                            self.assertEqual(runner.execute(proposed), 0)
                            self.assertEqual(len(children), 3)
                            for name in ('bootstrap.log', 'run.log'):
                                self.assertGreater((root/name).stat().st_size, 64*1024*1024)
                                self.assertLess((root/name).stat().st_size, 64*1024*1024+128)
                        elif outcome == 'observed-failure':
                            self.assertEqual(runner.execute(proposed), 7)
                            self.assertEqual(json.loads((root/'result.json').read_text())['exitCode'], 7)
                        elif outcome == 'timeout':
                            with self.assertRaises(subprocess.TimeoutExpired): runner.execute(proposed)
                        elif outcome in ('drain-timeout', 'suite-drain-timeout'):
                            with self.assertRaisesRegex(RuntimeError, 'further attempts refused'): runner.execute(proposed)
                            self.assertEqual(len(children), 1 if outcome == 'drain-timeout' else 2)
                        else:
                            with self.assertRaises(SystemExit) as stopped: runner.execute(proposed)
                            self.assertEqual(stopped.exception.code, 128+signal.SIGTERM)
                    expected = ['reports', 'terminate', 'wait'] if outcome in ('overlimit', 'observed-failure') else ['terminate', 'wait']
                    self.assertEqual(events, expected)
                    self.assertTrue(all(child.poll() is not None for child in children))
                    for name in ('root.qcow2', 'base.qcow2', 'seed.img', 'client-key', 'host-key', 'user-data', 'source.tar'):
                        self.assertFalse((root/name).exists(), name)
                    self.assertEqual(base.read_bytes(), header)
                finally:
                    for child in children:
                        if child.poll() is None: child.kill(); child.wait(timeout=5)
                        child.stdout.close()

    def test_base_header_rejects_external_data_before_qemu_opens_the_format(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / 'base.qcow2'
            header = bytearray(104); header[:4] = b'QFI\xfb'
            struct.pack_into('>I', header, 4, 3)
            struct.pack_into('>Q', header, 24, 1024 * 1024)
            struct.pack_into('>I', header, 100, 104)
            image.write_bytes(header); runner.validate_base_header(image)
            # Qcow2 v3 incompatible feature bit 2 authorizes an external file.
            for offset, encoding, value in [(72, '>Q', 4), (8, '>Q', 104),
                                             (16, '>I', 10), (32, '>I', 2), (24, '>Q', 81 * runner.GIB)]:
                changed = header.copy(); struct.pack_into(encoding, changed, offset, value)
                image.write_bytes(changed)
                with self.subTest(offset=offset), self.assertRaises(RuntimeError):
                    runner.validate_base_header(image)
            for value in [b'', header[:71], header[:103], b'not-qcow' + header[8:]]:
                image.write_bytes(value)
                with self.assertRaises(RuntimeError): runner.validate_base_header(image)
            struct.pack_into('>I', header, 4, 2)
            image.write_bytes(header[:72]); runner.validate_base_header(image)

    def test_execute_rejects_external_header_before_any_qemu_tool(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)/'base.qcow2'; root = Path(directory)/'run'
            header = bytearray(104); header[:4] = b'QFI\xfb'
            struct.pack_into('>I', header, 4, 3); struct.pack_into('>Q', header, 24, 1024*1024)
            struct.pack_into('>Q', header, 72, 4); base.write_bytes(header)
            proposed = runner.plan(root, base, hashlib.sha256(header).hexdigest(), 22941, NONCE)
            with mock.patch.object(runner.shutil, 'which', return_value='/stub'), \
                 mock.patch.object(runner.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=100*runner.GIB)), \
                 mock.patch.object(runner.os, 'access', return_value=True), mock.patch.object(runner.socket, 'socket'), \
                 mock.patch.object(runner, 'command') as command, \
                 mock.patch.object(runner.subprocess, 'check_output', return_value='a'*40) as output, \
                 mock.patch.object(runner.subprocess, 'Popen') as launch:
                with self.assertRaisesRegex(RuntimeError, 'External qcow2'):
                    runner.execute(proposed)
                command.assert_called_once_with(['git', '-C', str(runner.REPO), 'diff', '--quiet', 'HEAD', '--'])
                output.assert_called_once_with(['git', '-C', str(runner.REPO), 'rev-parse', 'HEAD'], text=True)
                launch.assert_not_called()
            self.assertEqual(base.read_bytes(), header)
            self.assertFalse((root/'base.qcow2').exists())

    def test_catchable_termination_cleans_captured_vm_and_keys_after_confirmed_exit(self):
        # A real Python child receives real signals; all VM/tools/socket calls
        # are stubs and every file belongs to this test's temporary directory.
        script = r'''import hashlib, importlib.util, io, json, os, signal, struct, sys, tarfile, types
from pathlib import Path
module, directory, number, trigger, force = sys.argv[1:]
number = int(number); force = force == 'true'; directory = Path(directory)
spec = importlib.util.spec_from_file_location('runner', module)
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
base = directory/'original.qcow2'; root = directory/'run'; trace = directory/'trace'
header = bytearray(104); header[:4] = b'QFI\xfb'; struct.pack_into('>I', header, 4, 3)
struct.pack_into('>Q', header, 24, 1024*1024); struct.pack_into('>I', header, 100, 104)
base.write_bytes(header)
proposed = r.plan(root, base, hashlib.sha256(header).hexdigest(), 22941, '01234567-89ab-4cde-8fab-0123456789ab')
r.shutil.which = lambda tool: '/stub'
r.shutil.disk_usage = lambda path: types.SimpleNamespace(free=100*r.GIB)
r.os.access = lambda *args: True
class Socket:
    def bind(self, address): pass
    def close(self): pass
r.socket.socket = Socket

def command(args, **kwargs):
    if args[0] == 'qemu-img': Path(args[-2]).write_bytes(b'owned disk')
    elif args[0] == 'ssh-keygen':
        Path(args[-1]).write_text('private key'); Path(args[-1]+'.pub').write_text('ssh-ed25519 public key')
    elif args[0] == 'cloud-localds': Path(args[1]).write_bytes(b'owned seed')
    elif args[0] == 'git' and 'archive' in args:
        with tarfile.open(fileobj=kwargs['stdout'], mode='w'): pass
    return types.SimpleNamespace(returncode=0)
r.command = command
r.subprocess.check_output = lambda args, **kwargs: 'a'*40 if args[0] == 'git' else json.dumps({'format':'qcow2','virtual-size':1024*1024})
class VM:
    def __init__(self, *args, **kwargs):
        self.stdout = io.BytesIO(); self.sent = False; self.stopped = False; self.waits = 0
        if trigger == 'spawn': os.kill(os.getpid(), number)
    def poll(self):
        if trigger == 'poll' and not self.sent:
            self.sent = True; os.kill(os.getpid(), number)
        return 0 if self.stopped else None
    def event(self, name):
        assert (root/'root.qcow2').exists() and (root/'client-key').exists()
        with trace.open('a') as output: output.write(name+'\n')
    def terminate(self):
        self.event('terminate')
        # A repeated cancellation cannot interrupt the cleanup boundary.
        os.kill(os.getpid(), number)
    def wait(self, timeout):
        self.event('wait'); self.waits += 1
        if force and self.waits == 1: raise r.subprocess.TimeoutExpired('owned stub', timeout)
        self.stopped = True; return 0
    def kill(self): self.event('kill')
r.subprocess.Popen = VM
if trigger == 'thread':
    class InterruptedThread(r.threading.Thread):
        def start(self): os.kill(os.getpid(), number)
    r.threading.Thread = InterruptedThread
r.execute(proposed)
'''
        import signal
        for number, trigger, force in [(signal.SIGTERM, 'spawn', False), (signal.SIGHUP, 'poll', False),
                                        (signal.SIGTERM, 'poll', True), (signal.SIGINT, 'spawn', False),
                                        (signal.SIGTERM, 'thread', False)]:
            with self.subTest(number=number, trigger=trigger, force=force), tempfile.TemporaryDirectory() as directory:
                result = subprocess.run([sys.executable, '-c', script, str(SCRIPT), directory, str(number), trigger,
                                         str(force).lower()], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 128 + number, result.stderr)
                root = Path(directory)/'run'
                self.assertEqual((Path(directory)/'trace').read_text().splitlines(),
                                 ['terminate', 'wait', 'kill', 'wait'] if force else ['terminate', 'wait'])
                self.assertTrue((Path(directory)/'original.qcow2').exists())
                self.assertTrue((root/'plan.json').exists())
                for name in ['root.qcow2', 'base.qcow2', 'seed.img', 'client-key', 'host-key', 'user-data', 'source.tar']:
                    self.assertFalse((root/name).exists(), name)



if __name__ == '__main__':
    unittest.main()
