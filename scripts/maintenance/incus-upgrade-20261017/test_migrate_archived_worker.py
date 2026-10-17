import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('archived_migration', Path(__file__).with_name('migrate-archived-worker.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
WORKER = '2eb7b5c5-5df6-412d-81cd-a88e7a9a92a5'
IMAGE = 'sha256:' + 'a' * 64
CID = 'c' * 64


def record():
    return {'id': WORKER, 'userId': m.OWNER, 'status': 'archived',
            'environmentId': m.DEFAULT_ENV, 'createdAt': '2026-01-01', 'displayName': 'fixture'}


class FakeMigration(m.Migration):
    """The only lifecycle effects are temporary JSON fixture updates."""
    def __init__(self, root, fail=None):
        super().__init__(WORKER, base=root, data=root / 'data')
        self.owner_dir.mkdir(parents=True)
        self.current = record()
        self.save()
        self.calls, self.fail = [], fail
        self.samples = {}
        self.source = {'Id': CID, 'Created': '2026-10-17T00:00:00Z', 'Image': IMAGE,
                       'Mounts': [], 'State': {'Running': False}, 'HostConfig': {},
                       'Config': {'Labels': {'agentor.id': WORKER}}}
        for role, target in [('workspace', '/workspace'), ('agents', '/home/agent/.agent-data')]:
            directory = root / role
            directory.mkdir()
            (directory / 'user-document.txt').write_text(role)
            self.source['Mounts'].append({'Destination': target, 'Type': 'volume',
                                         'Name': role, 'Source': str(directory)})

    def save(self):
        (self.owner_dir / 'workers.json').write_text(json.dumps([self.current]))

    def api(self, method, path, body=None, **kwargs):
        if method == 'GET':
            return {'kind': 'incus-vm', 'phase': 'retained', 'sourceRetained': True, 'recoveryRequired': False}
        self.calls.append(path)
        if path.endswith('/' + str(self.fail)):
            raise m.Refusal('Injected ambiguous response')
        if path.endswith('/unarchive'):
            self.current.update(status='active', desiredRuntimeStatus='running')
            result = {'id': WORKER, 'userId': m.OWNER, 'containerId': CID}
        elif method == 'PATCH':
            self.current.update(body)
            result = {}
        elif path.endswith('/stop'):
            self.current['desiredRuntimeStatus'] = 'stopped'
            result = {'ok': True}
        elif path.endswith('/incus-migration'):
            self.current.update(runtimeKind='incus-vm', incusMigration={'phase': 'retained',
                'source': {'containerId': CID, 'createdAt': self.source['Created'], 'imageId': IMAGE, 'wasRunning': False}})
            result = {'kind': 'incus-vm', 'phase': 'retained', 'sourceRetained': True, 'recoveryRequired': False}
        elif path.endswith('/rebuild'):
            self.current.update(desiredRuntimeStatus='running', pendingRebuild=False)
            result = {}
        elif path.endswith('/archive'):
            self.current.update(status='archived', desiredRuntimeStatus='stopped')
            result = {'ok': True}
        else:
            raise AssertionError(path)
        self.save()
        return result

    def host_json(self, args):
        if args[:2] == ['docker', 'inspect']:
            self.assert_source_id(args[2])
            return [self.source]
        if args[:3] == ['docker', 'image', 'inspect']:
            return [{'Id': IMAGE}]
        if args[:3] == ['docker', 'volume', 'inspect']:
            return [{'Mountpoint': str(self.base / args[3]), 'Driver': 'local'}]
        raise AssertionError(args)

    @staticmethod
    def assert_source_id(cid):
        assert cid == CID

    def verify_native(self, before):
        return {'guest': {'sharedVolumeExecution': True}}

    def canonical(self, role):
        return {'used_by': []}, self.base / role

    def assert_no_compute(self):
        assert self.current['status'] == 'archived'


class MigrationTests(unittest.TestCase):
    def test_record_allows_absent_legacy_stopped_intent(self):
        m.validate_record(record(), WORKER)
        for field, value in [('desiredRuntimeStatus', 'running'), ('hardwareDeviceIds', ['device']),
                             ('runtimeKind', 'incus-vm'), ('incusMigration', {'phase': 'retained'}),
                             ('trusted', True), ('mounts', [{'source': '/host'}])]:
            with self.subTest(field=field), self.assertRaises(m.Refusal):
                m.validate_record({**record(), field: value}, WORKER)

    def test_custom_images_require_exact_reviewed_selection(self):
        for worker, (definition, version, digest) in m.CUSTOM.items():
            value = {**record(), 'id': worker, 'imageDefinitionId': definition, 'imageVersion': version,
                     'imageDigest': digest, 'imageRuntimeReference': digest}
            m.validate_record(value, worker)
            with self.assertRaises(m.Refusal):
                m.validate_record({**value, 'imageRuntimeReference': 'latest'}, worker)

    def test_clone_compares_behavior_including_private_values_without_rendering(self):
        old = {'id': m.DEFAULT_ENV, 'memoryLimit': '', 'envVars': [{'key': 'X', 'value': 'fixture'}], 'dockerEnabled': True}
        clone = {**old, 'id': m.ENV_CLONES[m.DEFAULT_ENV], 'memoryLimit': '4g', 'userId': m.OWNER, 'builtIn': False}
        m.validate_clone(old, clone)
        for changed in ({'memoryLimit': '0'}, {'dockerEnabled': False}, {'envVars': []}):
            with self.assertRaises(m.Refusal):
                m.validate_clone(old, {**clone, **changed})

    def test_default_normalization_preserves_semantics_but_detects_settings_changes(self):
        self.assertEqual(m.stable_record(record()), m.stable_record({**record(), 'runtimeKind': 'incus-vm', 'mounts': [], 'initScript': ''}))
        self.assertNotEqual(m.stable_record(record()), m.stable_record({**record(), 'initScript': 'changed'}))

    def test_legacy_managed_name_refused_until_explicit_source_fix_is_deployed(self):
        value = {'id': 'd13882a7-6e91-4540-aefe-466020528e7f', 'userId': m.OWNER,
                 'state': 'ready', 'seeded': True, 'purpose': 'legacy-backup-path',
                 'dockerName': 'agentor-persist-a05a29a7-fb5c-487a-8202-a13af60e7836-638231aeca40be7a'}
        with self.assertRaisesRegex(m.Refusal, 'Legacy persistent-path'):
            m.validate_managed([value])
        m.validate_managed([{**value, 'purpose': 'persistent-path', 'dockerName': 'agentor-persist-' + value['id']}])

    def test_native_acceptance_checks_image_memory_devices_and_guest_script(self):
        with tempfile.TemporaryDirectory() as root:
            migration = m.Migration(WORKER, base=Path(root), data=Path(root) / 'data')
            instance = {'type': 'virtual-machine', 'config': {'user.agentor.id': WORKER,
                'user.agentor.owner': m.OWNER, 'user.agentor.installation': m.INSTALLATION,
                'image.source_image': IMAGE, 'limits.memory': '4294967296'}, 'devices': {
                    role: {'type': 'disk', 'pool': m.POOL, 'source': migration.name + '-' + role, 'path': target}
                    for role, target in [('workspace', '/workspace'), ('agents', '/home/agent/.agent-data')]}}
            guest = {'packages': [], 'guestKernel': '7.0.0-generic', 'sharedVolumeExecution': True,
                     'workerSession': True, 'desktopRfb': True}
            with patch.object(migration, 'incus', return_value=instance), patch.object(migration, 'managed', return_value=[]), \
                 patch.object(migration, 'guest', side_effect=[b'', json.dumps(guest).encode()]) as invoke, \
                 patch.object(migration, 'api', return_value={'status': 200}):
                self.assertEqual(migration.verify_native(self.before(migration))['guest'], guest)
                self.assertIn('Run as agent', invoke.call_args_list[1].args[0])
            for field, value in [('image.source_image', 'sha256:' + 'b' * 64), ('limits.memory', '1073741824')]:
                wrong = {**instance, 'config': {**instance['config'], field: value}}
                with patch.object(migration, 'incus', return_value=wrong), self.assertRaises(m.Refusal):
                    migration.verify_native(self.before(migration))

    def test_private_receipts_are_exclusive_and_not_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'receipt.json'
            m.private_write(path, {'value': 'retained'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                m.private_write(path, {'value': 'replacement'})
            self.assertEqual(json.loads(path.read_text())['value'], 'retained')

    def test_existing_receipts_refuse_before_reading_live_inventory(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            (path / f'migration-{WORKER}.before.private.json').write_text('{}')
            with patch.object(m, 'command', side_effect=AssertionError('must not execute')):
                with self.assertRaisesRegex(m.Refusal, 'Existing receipt'):
                    m.Migration(WORKER, base=path, data=path / 'absent').preflight()

    def test_sampling_omits_credentials_runtime_data_and_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            (path / 'document').write_text('retained')
            (path / 'auth.json').write_text('fixture')
            (path / '.codex').mkdir()
            (path / '.codex' / 'session').write_text('mutable')
            (path / 'link').symlink_to('/etc/passwd')
            result = m.sample_files(path)
            self.assertEqual([item['path'] for item in result['files']], ['document'])
            with self.assertRaises(OSError):
                m.hash_regular(path, 'link')
            with self.assertRaises(m.Refusal):
                m.hash_regular(path, '../outside')

    def before(self, migration):
        return {'record': record(), 'sourceDockerImage': IMAGE, 'managed': [],
                'environmentClone': {'id': m.ENV_CLONES[m.DEFAULT_ENV]}}

    def test_complete_mocked_lifecycle_retains_source_and_rearchives(self):
        with tempfile.TemporaryDirectory() as root:
            migration = FakeMigration(Path(root))
            with patch.object(m, 'command_json', side_effect=migration.host_json):
                migration.execute(self.before(migration))
            self.assertEqual([path.split('/')[-1] for path in migration.calls],
                             ['unarchive', WORKER, 'stop', 'incus-migration', 'rebuild', 'archive'])
            complete = json.loads((Path(root) / f'migration-{WORKER}.complete.private.json').read_text())
            self.assertEqual(complete['record']['status'], 'archived')
            self.assertEqual(complete['retainedDocker']['Id'], CID)
            self.assertEqual(complete['canonical']['agents']['sampleCount'], 1)
            self.assertFalse(any('finalize' in path or 'delete' in path for path in migration.calls))

    def test_ambiguous_migration_stops_without_rebuild_archive_or_retry(self):
        with tempfile.TemporaryDirectory() as root:
            migration = FakeMigration(Path(root), fail='incus-migration')
            with patch.object(m, 'command_json', side_effect=migration.host_json):
                with self.assertRaises(m.Refusal):
                    migration.execute(self.before(migration))
            self.assertEqual(len(migration.calls), 4)
            self.assertTrue(list(Path(root).glob('*-ambiguous.private.json')))
            self.assertEqual(migration.current['desiredRuntimeStatus'], 'stopped')
            with self.assertRaisesRegex(m.Refusal, 'Existing receipt'):
                migration.execute(self.before(migration))

    def test_source_changes_stop_before_cutover(self):
        with tempfile.TemporaryDirectory() as root:
            migration = FakeMigration(Path(root))
            snapshot = m.source_identity(migration.source)
            migration.source['State']['Running'] = True
            with patch.object(m, 'command_json', side_effect=migration.host_json):
                with self.assertRaises(m.Refusal):
                    migration.docker_retained(snapshot)

    def test_editor_redirects_are_bounded_and_same_worker_only(self):
        class Reply:
            def __init__(self, status, location=''):
                self.status, self.location = status, location
            def read(self, _): return b'fixture'
            def getheader(self, _name, _default): return self.location
        class Connection:
            replies = []
            def __init__(self, *args, **kwargs): pass
            def request(self, *args, **kwargs): pass
            def getresponse(self): return self.replies.pop(0)
            def close(self): pass
        migration = m.Migration(WORKER)
        migration.host, migration.origin, migration.cookie = 'example.invalid', 'https://example.invalid', 'fixture'
        with patch.object(m.http.client, 'HTTPConnection', Connection):
            Connection.replies = [Reply(302, f'/editor/{WORKER}/?folder=/workspace'), Reply(200)]
            self.assertEqual(migration.api('GET', f'/editor/{WORKER}/', html=True)['redirects'], 1)
            for target in ('https://other.invalid/', '/login', '//other.invalid/editor/'):
                Connection.replies = [Reply(302, target)]
                with self.assertRaises(m.Refusal):
                    migration.api('GET', f'/editor/{WORKER}/', html=True)


if __name__ == '__main__':
    unittest.main()
