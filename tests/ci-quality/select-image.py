#!/usr/bin/env python3
"""Choose compatible immutable quality image or the complete existing baseline."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

INPUTS = ('tests/package-lock.json', 'tests/ci-quality/Dockerfile', 'tests/ci-quality/check-image.mjs')
PIN = 'tests/ci-quality/approved-image.json'


class InvalidPin(ValueError):
    pass


def select(root):
    try:
        pin = json.loads((root / PIN).read_text())
    except (OSError, ValueError):
        raise InvalidPin('Approved image pin is missing or invalid JSON') from None
    valid = (isinstance(pin, dict) and type(pin.get('schema')) is int and pin['schema'] == 1
             and type(pin.get('nodeMajor')) is int and pin['nodeMajor'] == 22 and pin.get('nodeABI') == '127'
             and isinstance(pin.get('image'), str)
             and re.fullmatch(r'ghcr\.io/candlelightner/agentor-ci-quality@sha256:[a-f0-9]{64}', pin['image'])
             and isinstance(pin.get('inputs'), dict) and set(pin['inputs']) == set(INPUTS)
             and all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in pin['inputs'].values()))
    if not valid:
        raise InvalidPin('Approved image pin must name the canonical immutable digest, Node22 ABI127 and all three input hashes')
    changed = []
    for name in INPUTS:
        try:
            matches = hashlib.sha256((root / name).read_bytes()).hexdigest() == pin['inputs'][name]
        except OSError:
            matches = False
        if not matches:
            changed.append(name)
    if changed:
        return {'mode': 'baseline', 'image': '', 'nodeABI': '127',
                'reason': 'Approved image inputs changed or are unavailable (' + ', '.join(changed) + '); running all existing baseline checks; image adoption deferred'}
    return {'mode': 'image', 'image': pin['image'], 'nodeABI': pin['nodeABI'],
            'reason': 'Approved lock, recipe and guard match; running pinned image quality; image pull, guard or test failures remain CI failures'}


def main(root=None):
    try:
        choice = select(root or Path(__file__).resolve().parents[2])
    except InvalidPin as error:
        print('[quality-selection] ' + str(error) + '; selection stopped before either quality path. Correct the reviewed pin before retrying.', file=sys.stderr)
        return 1
    print('[quality-selection] ' + choice['reason'] + '.')
    if os.environ.get('GITHUB_OUTPUT'):
        try:
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write('mode=' + choice['mode'] + '\nimage=' + choice['image'] + '\nnode-abi=' + choice['nodeABI'] + '\n')
        except OSError:
            print('[quality-selection] Could not write the selected workflow route; selection stopped before either quality path. Check runner output permissions.', file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
