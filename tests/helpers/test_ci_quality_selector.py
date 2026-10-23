"""No Docker, npm or actual lockfile mutations: exercise real selector outputs."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('quality_selector', ROOT / 'tests/ci-quality/select-image.py')
SELECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SELECTOR)


class QualitySelectorTests(unittest.TestCase):
    def fixture(self, root):
        pin = {'schema': 1, 'image': 'ghcr.io/candlelightner/agentor-ci-quality@sha256:' + 'a' * 64,
               'nodeMajor': 22, 'nodeABI': '127', 'inputs': {}}
        for name in SELECTOR.INPUTS:
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'synthetic input')
            pin['inputs'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
        (root / SELECTOR.PIN).write_text(json.dumps(pin))
        return pin

    def test_exact_approved_inputs_choose_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); pin = self.fixture(root)
            self.assertEqual(SELECTOR.select(root)['mode'], 'image')
            self.assertEqual(SELECTOR.select(root)['image'], pin['image'])

    def test_image_route_writes_only_reviewed_digest_and_abi(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); pin = self.fixture(root); output = root / 'step-output'
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(SELECTOR.main(root), 0)
            self.assertEqual(output.read_text(), 'mode=image\nimage=' + pin['image'] + '\nnode-abi=127\n')

    def test_output_write_failure_stops_with_bounded_reason_and_outcome(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixture(root); errors = io.StringIO()
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(root)}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(errors):
                self.assertEqual(SELECTOR.main(root), 1)
            self.assertIn('Could not write the selected workflow route', errors.getvalue())
            self.assertIn('stopped before either quality path', errors.getvalue())

    def test_every_changed_or_missing_input_chooses_complete_baseline(self):
        for name in SELECTOR.INPUTS:
            for missing in (False, True):
                with self.subTest(name=name, missing=missing), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary); self.fixture(root)
                    if missing: (root / name).unlink()
                    else: (root / name).write_bytes(b'changed synthetic input')
                    choice = SELECTOR.select(root)
                    self.assertEqual(choice['mode'], 'baseline')
                    self.assertEqual(choice['image'], '')
                    self.assertIn(name, choice['reason'])
                    self.assertIn('all existing baseline checks', choice['reason'])

    def test_malformed_or_foreign_pin_fails_instead_of_hiding_error_with_baseline(self):
        for key, value in [('image', 'ghcr.io/candlelightner/agentor-ci-quality:latest'),
                           ('image', 'ghcr.io/foreign/runner@sha256:' + 'a' * 64),
                           ('image', 'ghcr.io/candlelightner/agentor-ci-quality@sha256:' + 'a' * 63),
                           ('image', 'ghcr.io/candlelightner/agentor-ci-quality@sha256:' + 'a' * 64 + '\nmode=baseline'),
                           ('nodeMajor', True), ('nodeABI', '999'), ('inputs', {})]:
            with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); pin = self.fixture(root); pin[key] = value
                (root / SELECTOR.PIN).write_text(json.dumps(pin))
                with self.assertRaises(SELECTOR.InvalidPin): SELECTOR.select(root)

    def test_missing_or_invalid_json_pin_stops_visibly(self):
        for content in (None, '{not-json'):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); self.fixture(root); path = root / SELECTOR.PIN
                if content is None: path.unlink()
                else: path.write_text(content)
                errors = io.StringIO()
                with contextlib.redirect_stderr(errors): self.assertEqual(SELECTOR.main(root), 1)
                self.assertIn('selection stopped before either quality path', errors.getvalue())

    def test_hosted_output_integration_routes_mismatch_without_editing_actual_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixture(root)
            (root / 'tests/package-lock.json').write_bytes(b'deliberate synthetic mismatch')
            output = root / 'step-output'; logs = io.StringIO()
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}), contextlib.redirect_stdout(logs):
                self.assertEqual(SELECTOR.main(root), 0)
            self.assertEqual(output.read_text(), 'mode=baseline\nimage=\nnode-abi=127\n')
            self.assertIn('image adoption deferred', logs.getvalue())

    def test_workflow_retains_baseline_gates_and_only_one_image_path(self):
        workflow = (ROOT / '.github/workflows/docker-build.yml').read_text()
        quality = workflow.split('\n  quality:\n', 1)[1].split('\n  docker_regression:', 1)[0]
        for name in ('Run no-server module and helper tests', 'Run root-owned archive metadata fixtures'):
            block = quality.split('      - name: ' + name + '\n', 1)[1].split('      - ', 1)[0]
            self.assertIn("if: steps.quality-runner.outputs.mode == 'baseline'", block)
        image_block = quality.split('      - name: Pull approved image anonymously and run full quality\n', 1)[1]
        self.assertIn("if: steps.quality-runner.outputs.mode == 'image'", image_block)
        self.assertIn('persist-credentials: false', quality)
        self.assertNotIn('--privileged', quality)
        container = quality.split('docker --config "$client" run', 1)[1]
        self.assertNotIn('/var/run/docker.sock', container)
        self.assertNotIn('$client', container)
        self.assertNotIn('docker/login', quality)
        self.assertIn('bash tests/ci-quality/run-quality.sh', quality)
        self.assertIn('needs: [changes, quality, docker_regression]', workflow)


if __name__ == '__main__':
    unittest.main()
