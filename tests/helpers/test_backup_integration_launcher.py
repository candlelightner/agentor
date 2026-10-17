import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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
        self.assertEqual(service['volumes'], ['backup-test-node-modules:/work/tests/node_modules'])
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
