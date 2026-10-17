import importlib.util
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/test-backup-integration.py'
spec = importlib.util.spec_from_file_location('backup_integration', SCRIPT)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class BackupIntegrationLauncherTests(unittest.TestCase):
    def test_plan_uses_only_unique_project_volume_and_image_names(self):
        p = launcher.plan('instance', 'unit-case', '/tracked-source')
        self.assertTrue(all(name.startswith('agentor-backup-unit-case-') for name in p['volumes']))
        service = p['override']['services']['test-runner']
        self.assertEqual(service['image'], 'agentor-test-runner:agentor-backup-unit-case')
        self.assertNotIn('ports', service)
        self.assertNotIn('network_mode', service)
        self.assertNotIn('/var/run/docker.sock', json.dumps(service))
        self.assertIn('backup-test-node-modules:/work/tests/node_modules', service['volumes'])
        self.assertIs(service['privileged'], False)
        self.assertEqual(service['cgroup'], 'private')
        self.assertEqual(service['ipc'], 'private')
        self.assertEqual(service['cap_drop'], ['ALL'])
        self.assertEqual(p['execution']['status'], 'blocked')
        self.assertNotIn('docker-compose.tests.yml', ' '.join(p['run']))
        self.assertIn('api/instance-backup-docker-live.spec.ts', p['run'])
        self.assertIn('--retries=0', p['run'])

    def test_workspace_suite_never_enables_destructive_instance_gate(self):
        p = launcher.plan('workspace', 'unit-case', '/tracked-source')
        self.assertEqual(p['override']['services']['test-runner']['environment']['INSTANCE_DOCKER_BACKUP_TEST'], 'false')
        self.assertIn('ui/backup-management-real.spec.ts', p['run'])

    def test_resource_names_reject_shell_fragments_paths_and_empty_ids(self):
        for value in ['', '../production', 'UPPER', 'name;docker rm', 'a' * 32, 'a\n']:
            with self.assertRaises(ValueError):
                launcher.plan('instance', value, '/tracked-source')

    def test_default_invocation_only_prints_plan_without_docker_or_git(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--suite', 'instance', '--run-id', 'unit-dry-run'],
                                env={'PATH': '/nonexistent'}, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['suite'], 'instance')

    def test_run_lease_refuses_concurrent_same_id_without_removing_other_lease(self):
        with tempfile.TemporaryDirectory() as root:
            lock = Path(root) / 'agentor-backup-unit.lock'
            with launcher.exclusive_run('agentor-backup-unit', root):
                self.assertTrue(lock.is_file())
                with self.assertRaises(FileExistsError):
                    with launcher.exclusive_run('agentor-backup-unit', root):
                        self.fail('concurrent lease admitted')
                self.assertTrue(lock.is_file())
            self.assertFalse(lock.exists())

    def test_execute_fails_before_any_process_or_cleanup_for_both_full_suites(self):
        for suite in launcher.SUITES:
            with self.subTest(suite=suite), mock.patch.object(launcher.subprocess, 'run') as run, \
                    mock.patch.object(launcher.subprocess, 'check_output') as output, \
                    mock.patch.object(launcher, 'exclusive_run') as lease, \
                    mock.patch.object(launcher, 'archive_source') as archive:
                self.assertEqual(launcher.main(['--suite', suite, '--run-id', 'blocked', '--execute']), 2)
                run.assert_not_called(); output.assert_not_called()
                lease.assert_not_called(); archive.assert_not_called()

    def test_explicit_execute_fails_without_docker_git_or_privileged_bypass(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--execute'],
                                env={'PATH': '/nonexistent', 'DOCKER_HOST': 'tcp://production:2375',
                                     'AGENTOR_ALLOW_PRIVILEGED': 'true'}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn(launcher.BLOCK_CODE, result.stderr)
        self.assertEqual(result.stdout, '')

    def test_outer_guard_rejects_host_devices_privilege_namespace_and_mount_overrides(self):
        p = launcher.plan('workspace', 'guard-case', '/tracked-source')
        service = p['override']['services']['test-runner']
        unsafe = [
            ('privileged', True), ('privileged', 'false'), ('cgroup', 'host'), ('ipc', 'host'),
            ('pid', 'host'), ('pid', 'container:production'), ('network_mode', 'host'),
            ('network_mode', 'container:production'), ('uts', 'host'), ('userns_mode', 'host'),
            ('cgroup_parent', '/system.slice'), ('devices', ['/dev/sda:/dev/sda']),
            ('device_cgroup_rules', ['b *:* rwm']), ('gpus', 'all'), ('cap_add', ['SYS_ADMIN']),
            ('cap_add', ['BPF']), ('cap_add', ['ALL']), ('cap_drop', []),
            ('security_opt', ['seccomp=unconfined']), ('security_opt', ['apparmor=unconfined']),
            ('ports', ['3000:3000']), ('volumes_from', ['production']), ('runtime', 'unsafe'),
            ('use_api_socket', True), ('post_start', [{'command': 'mount /dev/sda /data'}]),
            ('build', {'context': '/tracked-source/tests/docker', 'privileged': True}),
        ]
        for field, value in unsafe:
            changed = copy.deepcopy(service); changed[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                launcher.validate_outer_service(changed, '/tracked-source', p['override']['volumes'])
        for mount in ['/dev:/dev', '/sys/fs/cgroup:/sys/fs/cgroup', '/proc:/proc',
                      '/var/run/docker.sock:/var/run/docker.sock', '/production:/data',
                      '/tracked-source/tests:/work/tests:rshared']:
            changed = copy.deepcopy(service); changed['volumes'].append(mount)
            with self.subTest(mount=mount), self.assertRaises(ValueError):
                launcher.validate_outer_service(changed, '/tracked-source', p['override']['volumes'])

    def test_outer_guard_rejects_device_backed_external_and_reused_named_volumes(self):
        p = launcher.plan('workspace', 'guard-case', '/tracked-source')
        for unsafe in [{'name': 'production'}, {'name': p['volumes'][0], 'external': True},
                       {'name': p['volumes'][0], 'driver_opts': {'type': 'ext4', 'device': '/dev/sda'}},
                       {'name': p['volumes'][0], 'driver_opts': {'type': 'none', 'o': 'bind', 'device': '/production'}}]:
            changed = copy.deepcopy(p['override']['volumes']); changed['test-runner-docker'] = unsafe
            with self.subTest(volume=unsafe), self.assertRaises(ValueError):
                launcher.validate_outer_service(p['override']['services']['test-runner'], '/tracked-source', changed)

    def test_both_suite_test_arrays_are_preserved_exactly(self):
        self.assertEqual(launcher.SUITES, {
            'workspace': ['api/backups.spec.ts', 'api/instance-backups-api.spec.ts',
                          'ui/backup-management.spec.ts', 'ui/instance-backup-management.spec.ts',
                          'ui/backup-management-real.spec.ts', '--workers=1', '--retries=0'],
            'instance': ['api/instance-backup-docker-live.spec.ts', '--project=api', '--workers=1', '--retries=0'],
        })

    def test_git_archive_excludes_untracked_and_ignored_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'source'; source.mkdir()
            subprocess.run(['git', 'init', '-q', str(source)], check=True)
            (source / 'tracked.txt').write_text('reviewed source')
            (source / '.gitignore').write_text('.env\n')
            subprocess.run(['git', '-C', str(source), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(source), '-c', 'user.email=fixture@invalid', '-c', 'user.name=Fixture',
                            'commit', '-qm', 'fixture'], check=True)
            (source / '.env').write_text('untracked fixture credential')
            (source / 'private.key').write_text('untracked fixture key')
            destination = Path(root) / 'snapshot'
            launcher.archive_source(source, destination)
            self.assertTrue((destination / 'tracked.txt').is_file())
            self.assertFalse((destination / '.env').exists())
            self.assertFalse((destination / 'private.key').exists())
            self.assertFalse((destination / '.git').exists())


if __name__ == '__main__':
    unittest.main()
