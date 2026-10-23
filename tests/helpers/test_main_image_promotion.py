"""Exercise shared-tag promotion without registry credentials or publication."""
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/promote-main-image.sh'
OLD = '1' * 40
NEW = '2' * 40


class MainImagePromotionTests(unittest.TestCase):
    def test_reverse_completion_retains_both_sha_images(self):
        for image in ('agentor-orchestrator', 'agentor-worker'):
            with self.subTest(image=image), tempfile.TemporaryDirectory() as directory:
                temp = Path(directory)
                (temp / 'gh').write_text('#!/bin/sh\nprintf "%s\\n" "$MAIN_HEAD"\n')
                (temp / 'docker').write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
path = Path(os.environ['REGISTRY_STATE'])
state = json.loads(path.read_text())
args = sys.argv[1:]
assert args[:3] == ['buildx', 'imagetools', 'create'], args
source = args[-1]
assert source in state, source
for index, value in enumerate(args):
    if value == '--tag':
        state[args[index + 1]] = state[source]
path.write_text(json.dumps(state))
''')
                for name in ('gh', 'docker'):
                    (temp / name).chmod(0o755)
                image_ref = f'ghcr.io/example/{image}'
                state_file = temp / 'registry.json'
                immutable = {f'{image_ref}:sha-{sha}': f'manifest-{sha}' for sha in (OLD, NEW)}
                state_file.write_text(json.dumps(immutable))
                env = dict(os.environ, PATH=f'{temp}:{os.environ["PATH"]}',
                           GITHUB_REPOSITORY='example/project', GITHUB_REF='refs/heads/main',
                           IMAGE=image_ref, MAIN_HEAD=NEW, REGISTRY_STATE=str(state_file))
                for sha, outcome in ((NEW, 'promoted to main/latest'), (OLD, 'promotion skipped')):
                    result = subprocess.run(['bash', str(SCRIPT)], env=dict(env, GITHUB_SHA=sha),
                                            text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(outcome, result.stdout)
                    self.assertIn('SHA references retained', result.stdout)
                state = json.loads(state_file.read_text())
                for tag in ('main', 'latest'):
                    self.assertEqual(state[f'{image_ref}:{tag}'], f'manifest-{NEW}')
                self.assertEqual({key: state[key] for key in immutable}, immutable)

    def test_unreadable_main_stops_before_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            (temp / 'gh').write_text('#!/bin/sh\nexit 1\n')
            (temp / 'gh').chmod(0o755)
            result = subprocess.run(['bash', str(SCRIPT)], text=True, capture_output=True,
                                    env=dict(os.environ, PATH=f'{temp}:{os.environ["PATH"]}',
                                             GITHUB_REPOSITORY='example/project',
                                             GITHUB_REF='refs/heads/main', GITHUB_SHA=NEW,
                                             IMAGE='ghcr.io/example/agentor-worker'))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('promotion stopped', result.stderr)

    def test_workflow_keeps_immutable_merge_outside_promotion_lock(self):
        workflow = (ROOT / '.github/workflows/docker-build.yml').read_text()
        for component in ('orchestrator', 'worker'):
            # Read the whole job, excluding subsequent top-level job declarations.
            merge = re.split(r'\n  [a-z][a-z-]*:\n', workflow.split(f'  merge-{component}:\n', 1)[1])[0]
            self.assertNotIn('concurrency:', merge)
            self.assertIn('type=sha,format=long', merge)
            self.assertIn('type=semver,pattern={{version}}', merge)
            self.assertIn('type=semver,pattern={{major}}.{{minor}}', merge)
            self.assertIn("type=ref,event=branch,enable=${{ github.ref != 'refs/heads/main' }}", merge)
            self.assertNotIn('value=latest', merge)
        promotion = workflow.split('  promote-main:\n', 1)[1]
        self.assertIn('group: main-image-promotion-${{ github.repository }}-${{ matrix.image }}', promotion)
        self.assertIn('cancel-in-progress: false', promotion)
        self.assertIn("github.ref == 'refs/heads/main'", promotion)
        self.assertIn("github.event_name != 'pull_request'", promotion)
        self.assertIn('bash scripts/promote-main-image.sh', promotion)
        self.assertIn('needs.test_gate.result == \'success\'', workflow)


if __name__ == '__main__':
    unittest.main()
