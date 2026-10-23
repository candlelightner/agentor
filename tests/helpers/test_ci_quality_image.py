"""Preparation image contract/trust checks; no Docker daemon is needed."""
from pathlib import Path
import subprocess
import tempfile
import os
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class QualityImageTests(unittest.TestCase):
    def test_missing_and_stale_contract_fields_fail_closed(self):
        result = subprocess.run(['node', str(ROOT / 'tests/ci-quality/check-image.mjs'), '--self-test'],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('stale and missing', result.stdout)

    def test_candidate_has_no_publication_credentials_and_publisher_is_trusted_main_only(self):
        workflow = (ROOT / '.github/workflows/ci-quality-image.yml').read_text()
        candidate, publisher = workflow.split('\n  publish:\n', 1)
        self.assertNotIn('packages: write', candidate)
        self.assertNotIn('secrets.', candidate)
        self.assertIn('persist-credentials: false', candidate)
        self.assertNotIn('pull_request_target', workflow)
        self.assertIn("github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')", publisher)
        self.assertIn('needs: candidate', publisher)
        self.assertIn('tested-quality-image-${{ github.run_id }}-${{ github.run_attempt }}', publisher)
        self.assertIn('Artifact identity differs; publication refused.', publisher)
        self.assertIn('Loaded image differs; publication refused.', publisher)
        self.assertNotIn('actions/checkout', publisher)

    def test_real_javascript_regex_excludes_all_six_root_fixtures_only(self):
        run = (ROOT / 'tests/ci-quality/run-quality.sh').read_text()
        pattern = re.search(r"--grep-invert '([^']+)'", run).group(1)
        code = """const assert=require('node:assert/strict');const re=new RegExp(process.argv[1]);
          for(const name of ['incus-admin-restore','incus-derived-image','incus-docker-restore-archive',
            'incus-selected-restore','managed-kilo-parent','portable-pax-size'])
            assert.ok(re.test('api/'+name+'.spec.ts'), name+' must run only in the sudo split');
          for(const name of ['api/incus-client.spec.ts','ui/physical-gpu-isolated.spec.ts',
            'api/incus-admin-restoreXspecXts']) assert.equal(re.test(name),false,name);
        """
        result = subprocess.run(['node', '-e', code, pattern], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_failed_dependency_install_reports_reason_and_stops_before_tests(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'node').write_text('#!/bin/sh\nexit 0\n')
            (directory / 'npm').write_text('#!/bin/sh\necho synthetic-lock-install-failure >&2\nexit 7\n')
            for name in ('node', 'npm'):
                (directory / name).chmod(0o700)
            result = subprocess.run(['bash', str(ROOT / 'tests/ci-quality/run-quality.sh')], cwd=directory,
                                    env={**os.environ, 'PATH': str(directory) + ':/usr/bin:/bin'},
                                    capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 7)
        self.assertIn('installing checked-out orchestrator dependencies', result.stderr)
        self.assertIn('ineligible for publication', result.stderr)
        self.assertNotIn('Full candidate quality validation passed', result.stdout)

    def test_optional_fixture_tools_are_installed_and_observed_instead_of_silently_skipped(self):
        recipe = (ROOT / 'tests/ci-quality/Dockerfile').read_text()
        guard = (ROOT / 'tests/ci-quality/check-image.mjs').read_text()
        for tool, flag in (('jq', '--version'), ('tmux', '-V'), ('pigz', '--version')):
            self.assertRegex(recipe, r'\b' + tool + r'\b')
            self.assertIn("['" + tool + "', ['" + flag + "']]", guard)

    def test_quality_preserves_nonroot_and_explicit_sudo_split_without_daemon_or_install_fallback(self):
        recipe = (ROOT / 'tests/ci-quality/Dockerfile').read_text()
        run = (ROOT / 'tests/ci-quality/run-quality.sh').read_text()
        workflow = (ROOT / '.github/workflows/ci-quality-image.yml').read_text()
        self.assertIn('FROM ubuntu:24.04', recipe)
        self.assertIn('USER 1001:1001', recipe)
        self.assertIn('rm -rf /tmp/ci-quality', recipe)
        self.assertNotIn('dockerd', recipe)
        for forbidden in ('apt-get', 'playwright install', 'npm install'):
            self.assertNotIn(forbidden, run)
        self.assertIn('npm ci --prefix orchestrator', run)
        self.assertIn('npm ci --prefix tests', run)
        self.assertIn('sudo -- "$(command -v node)"', run)
        self.assertNotIn('--privileged', workflow)
        self.assertNotIn('/var/run/docker.sock', workflow)
        self.assertNotIn('test:docker', run)


if __name__ == '__main__':
    unittest.main()
