import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, mock_open

spec = importlib.util.spec_from_file_location('guest_verify', Path(__file__).with_name('verify-native-docker-guest.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
INCARNATION = '11111111-1111-4111-8111-111111111111'
WORKER = '22222222-2222-4222-8222-222222222222'
IMAGE = 'sha256:' + 'b' * 64


def request():
    return {'version': 1, 'expectedIncarnation': INCARNATION,
        'inventory': {'workerId': WORKER, 'sourceContainerId': 'a' * 64, 'sourceCreated': '2026-10-17T00:00:00.123456789Z',
                      'driver': 'overlay2', 'images': [IMAGE], 'containers': [], 'volumes': ['fixture']},
        'samples': {'workerId': WORKER, 'sourceContainerId': 'a' * 64, 'samplingIsNotFullTreeVerification': True,
                    'volumes': {'fixture': {'files': [{'path': 'dir/data', 'size': 4, 'sha256': hashlib.sha256(b'data').hexdigest()}],
                                          'scanLimitReached': True}}}}


def command(args):
    if args[0] == 'info': return json.dumps({'Driver': 'overlay2', 'DockerRootDir': '/var/lib/docker'})
    if args[0] == 'image': return IMAGE + '\n' + IMAGE  # Real CLI can list the same ID under multiple tags.
    if args[0] == 'container': return 'c' * 64
    if args[:2] == ['volume', 'ls']: return 'fixture\nextra'
    return json.dumps([{'Name': 'fixture', 'Driver': 'local', 'Scope': 'local', 'Options': None,
                        'Mountpoint': '/var/lib/docker/volumes/fixture/_data'}])


class GuestDockerVerificationTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.data = Path(self.root.name) / 'var/lib/docker/volumes/fixture/_data/dir/data'
        self.data.parent.mkdir(parents=True); self.data.write_bytes(b'data'); self.data.chmod(0o640)
        os.utime(self.data, ns=(1700000000123456789, 1700000000987654321))
        original_open = os.open
        # Remap ONLY the fixed filesystem root to an owned temporary tree. All
        # actual dirfd traversal, NOFOLLOW, fstat and hashing still run unchanged.
        self.open_patch = patch.object(verify.os, 'open', side_effect=lambda path, *args, **kwargs:
            original_open(self.root.name if path == '/' and 'dir_fd' not in kwargs else path, *args, **kwargs))
        self.open_patch.start()
        self.root_patch = patch.object(verify.os, 'geteuid', return_value=0); self.root_patch.start()

    def tearDown(self):
        self.root_patch.stop(); self.open_patch.stop(); self.root.cleanup()

    def run_verify(self, value=None, **changes):
        return verify.verify(value or request(), identity=lambda: INCARNATION, command=command, **changes)

    def test_exact_content_metadata_inventory_subset_and_space_are_reported_without_full_tree_claim(self):
        value = request(); info = self.data.stat()
        value['samples']['volumes']['fixture']['files'][0].update(uid=info.st_uid, gid=info.st_gid,
            mode=stat.S_IMODE(info.st_mode), mtimeNs=info.st_mtime_ns)
        before = self.data.stat(); result = self.run_verify(value)
        self.assertTrue(result['ok']); self.assertTrue(result['samplingIsNotFullTreeVerification'])
        self.assertEqual(result['counts'], {'images': 1, 'containers': 1, 'volumes': 2, 'samples': 1, 'sampleBytes': 4})
        self.assertGreater(result['filesystem']['freeBytes'], 0)
        self.assertEqual(result['samples'][0]['mtimeNs'], info.st_mtime_ns)
        self.assertEqual((self.data.stat().st_mtime_ns, self.data.stat().st_atime_ns), (before.st_mtime_ns, before.st_atime_ns))

    def test_wrong_or_absent_incarnation_refuses_before_docker_sample_or_space(self):
        for expected in [None, '', 'malformed', '33333333-3333-4333-8333-333333333333']:
            value = request(); value['expectedIncarnation'] = expected
            calls = []
            trap = lambda *args: calls.append(args) or self.fail('Identity gate was bypassed')
            with self.assertRaises(verify.Refused):
                verify.verify(value, identity=lambda: INCARNATION, command=trap, read_sample=trap, read_space=trap)
            self.assertEqual(calls, [])

    def test_nonroot_refuses_before_even_reading_dmi(self):
        with patch.object(verify.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(verify.Refused, 'GUEST_ROOT_REQUIRED'):
                verify.verify(request(), identity=lambda: self.fail('DMI must not be read'))

    def test_order_is_identity_then_readonly_commands_then_samples_then_space(self):
        events = []
        def identity(): events.append('identity'); return INCARNATION
        def docker(args): events.append(args); return command(args)
        def sample(*args): events.append('sample'); return {'size': 4}
        def space(): events.append('space'); return SimpleNamespace(f_bavail=1, f_frsize=4096, f_favail=2)
        verify.verify(request(), identity=identity, command=docker, read_sample=sample, read_space=space)
        self.assertEqual(events[0], 'identity'); self.assertEqual(events[-2:], ['sample', 'space'])
        self.assertEqual([e[0] for e in events[1:-2]], ['info', 'image', 'container', 'volume', 'volume'])

    def test_source_authority_inventory_and_sample_bounds_are_validated(self):
        mutations = [lambda v: v['samples'].update(workerId=INCARNATION), lambda v: v['samples'].update(sourceContainerId='f'*64),
            lambda v: v['inventory'].update(images=['short']), lambda v: v['inventory'].update(volumes=['../escape']),
            lambda v: v['inventory'].update(containers=['sha256:'+'a'*64]), lambda v: v.update(version=True),
            lambda v: v['samples'].update(samplingIsNotFullTreeVerification=False)]
        for mutate in mutations:
            value = request(); mutate(value)
            with self.assertRaises(verify.Refused): verify.request(value)
        for changes in [{'size': verify.MAX_FILE+1}, {'size': True}, {'uid': -1}, {'mode': 0o100644}, {'mtimeNs': '123'}, {'sha256': 'BAD'}]:
            value = request(); value['samples']['volumes']['fixture']['files'][0].update(changes)
            with self.assertRaises(verify.Refused): verify.request(value)
        value = request(); value['samples']['volumes']['fixture']['files'] *= 17
        with self.assertRaises(verify.Refused): verify.request(value)

    def test_path_traversal_absolute_empty_control_aliases_and_bad_volume_names_refuse(self):
        for path in ['/etc/passwd', '../data', 'dir/../data', './dir/data', 'dir//data', 'dir/data/', '', 'dir/da\x00ta', 'dir/da\nta']:
            value = request(); value['samples']['volumes']['fixture']['files'][0]['path'] = path
            with self.assertRaises(verify.Refused): verify.request(value)
            with self.assertRaises(verify.Refused): verify.sample('fixture', {'path': path})
        for name in ['../fixture', '/fixture', '--help', '.', 'fixture/dir']:
            with self.assertRaises(verify.Refused): verify.sample(name, {'path': 'dir/data'})

    def test_every_directory_and_terminal_symlink_refuses_without_following(self):
        for part in ['var', 'lib', 'docker', 'volumes', 'fixture', '_data', 'dir']:
            with self.subTest(part=part):
                current = next(p for p in self.data.parents if p.name == part)
                moved = current.with_name(current.name + '-held'); current.rename(moved); current.symlink_to(moved, target_is_directory=True)
                try:
                    with self.assertRaises(OSError): verify.sample('fixture', request()['samples']['volumes']['fixture']['files'][0])
                finally: current.unlink(); moved.rename(current)
        self.data.rename(self.data.with_name('held')); self.data.symlink_to(self.data.with_name('held'))
        with self.assertRaises(OSError): self.run_verify()

    def test_fifo_directory_and_oversized_regular_files_refuse_before_read(self):
        self.data.unlink(); os.mkfifo(self.data)
        with self.assertRaisesRegex(verify.Refused, 'UNSAFE_SAMPLE_TYPE'): self.run_verify()
        self.data.unlink(); self.data.mkdir()
        with self.assertRaisesRegex(verify.Refused, 'UNSAFE_SAMPLE_TYPE'): self.run_verify()
        self.data.rmdir()
        with self.data.open('wb') as source: source.truncate(verify.MAX_FILE+1)
        with self.assertRaisesRegex(verify.Refused, 'UNSAFE_SAMPLE_TYPE'): self.run_verify()

    def test_content_and_every_optional_metadata_mismatch_refuse(self):
        for changes in [{'sha256': '0'*64}, {'size': 3}, {'uid': self.data.stat().st_uid+1}, {'gid': self.data.stat().st_gid+1},
                        {'mode': 0o600}, {'mtimeNs': self.data.stat().st_mtime_ns+1}]:
            value = request(); value['samples']['volumes']['fixture']['files'][0].update(changes)
            with self.assertRaisesRegex(verify.Refused, 'SAMPLE_MISMATCH'): self.run_verify(value)

    def test_file_or_named_parent_replacement_during_read_refuses(self):
        original_read = os.read
        for replace_parent in [False, True]:
            triggered = False
            def read(fd, size):
                nonlocal triggered
                result = original_read(fd, size)
                if not triggered:
                    triggered = True
                    if replace_parent:
                        parent = self.data.parent; parent.rename(parent.with_name('old-dir')); parent.mkdir(); (parent/'data').write_bytes(b'data')
                    else:
                        self.data.rename(self.data.with_name('old-data')); self.data.write_bytes(b'data')
                return result
            with patch.object(verify.os, 'read', side_effect=read):
                with self.assertRaisesRegex(verify.Refused, 'SAMPLE_(PATH_)?CHANGED'): self.run_verify()

    def test_malformed_or_missing_docker_inventory_and_nonlocal_volume_layout_refuse(self):
        mutations = [(['info'], json.dumps({'Driver': 'btrfs', 'DockerRootDir': '/var/lib/docker'})),
            (['info'], json.dumps({'Driver': 'overlay2', 'DockerRootDir': '/other'})),
            (['image'], 'short'), (['container'], 'bad'), (['volume','ls'], '../escape'), (['image'], '')]
        for prefix, replacement in mutations:
            with self.assertRaises(verify.Refused):
                verify.verify(request(), identity=lambda: INCARNATION,
                    command=lambda args: replacement if args[:len(prefix)] == prefix else command(args))
        for change in [{'Driver': 'nfs'}, {'Scope': 'global'}, {'Options': []}, {'Options': {'device': '/host'}},
                       {'Mountpoint': '/etc'}, {'Name': 'foreign'}]:
            def docker(args):
                if args[:2] == ['volume','inspect']:
                    info = json.loads(command(args)); info[0].update(change); return json.dumps(info)
                return command(args)
            with self.assertRaises(verify.Refused): verify.verify(request(), identity=lambda: INCARNATION, command=docker)

    def test_duplicate_json_and_malformed_docker_structures_refuse(self):
        with self.assertRaisesRegex(verify.Refused, 'DUPLICATE_JSON_KEY'):
            verify.parse_json('{"version":1,"version":1}')
        for body in ['null', '[]', '{bad}']:
            with self.assertRaises((verify.Refused, ValueError)):
                verify.verify(request(), identity=lambda: INCARNATION, command=lambda args: body)
        with patch('builtins.open', mock_open(read_data=INCARNATION.upper()+'\n')):
            self.assertEqual(verify.guest_uuid(), INCARNATION)

    def test_docker_fixed_socket_minimal_environment_bounded_output_and_child_cleanup(self):
        original = subprocess.Popen
        children, calls = [], []
        def launch(script):
            def factory(argv, **kwargs):
                calls.append((argv, kwargs))
                child = original([sys.executable, '-c', script], **kwargs); children.append(child); return child
            return factory
        args = ['info', '--format', '{{json .}}']
        with patch.object(verify.subprocess, 'Popen', side_effect=launch("print('fixture-output')")):
            self.assertEqual(verify.docker(args), 'fixture-output')
        self.assertEqual(calls[-1][0], ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args])
        self.assertEqual(calls[-1][1]['env']['DOCKER_CONFIG'], '/nonexistent')
        self.assertNotIn('DOCKER_CONTEXT', calls[-1][1]['env'])
        with patch.object(verify, 'MAX_OUTPUT', 32), patch.object(verify.subprocess, 'Popen',
                side_effect=launch("import sys,time;sys.stdout.write('x'*33);sys.stdout.flush();time.sleep(60)")):
            with self.assertRaisesRegex(verify.Refused, 'DOCKER_OUTPUT_LIMIT'): verify.docker(args)
        self.assertIsNotNone(children[-1].poll())
        with patch.object(verify.subprocess, 'Popen', side_effect=launch('import sys;sys.exit(2)')):
            with self.assertRaisesRegex(verify.Refused, 'DOCKER_READ_FAILED'): verify.docker(args)
        with patch.object(verify.subprocess, 'Popen', side_effect=launch('import time;time.sleep(60)')), \
                patch.object(verify.time, 'monotonic', side_effect=[0, 31]):
            with self.assertRaisesRegex(verify.Refused, 'DOCKER_TIMEOUT'): verify.docker(args)
        self.assertIsNotNone(children[-1].poll())

    def test_docker_mutating_arguments_refuse_before_subprocess(self):
        with patch.object(verify.subprocess, 'Popen', side_effect=AssertionError('No process expected')):
            for args in [['run'], ['image','rm',IMAGE], ['volume','rm','fixture'], ['volume','inspect','--help']]:
                with self.assertRaises(verify.Refused): verify.docker(args)


if __name__ == '__main__':
    unittest.main()
