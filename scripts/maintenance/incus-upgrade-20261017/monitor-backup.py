#!/usr/bin/env python3
"""Read-only backup status and a fail-closed deployment prerequisite."""
import argparse
import base64
import json
import os
from pathlib import Path
import stat
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--require-complete', action='store_true')
args = parser.parse_args()
root = Path('/var/lib/docker/volumes/agentor-data/_data')
job_id = 'fd9ff548-9a79-4b7c-979c-7906f0a0cf10'
state = json.loads((root / 'admin/instance-backups.v1.json').read_text())
job = next(j for j in state['jobs'] if j['id'] == job_id)
report = {k: job.get(k) for k in ('id', 'status', 'phase', 'progress', 'updatedAt', 'error', 'artifactId')}
report['observedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
pid = int(subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Pid}}', 'agentor-orchestrator']))
report['orchestratorPid'] = pid
report['orchestratorLive'] = pid > 0 and Path(f'/proc/{pid}/cmdline').exists()
stage = root / 'instance-restore-staging' / job_id
report['stagingCleaned'] = not stage.exists()
manifest_path = stage / 'verification/manifest.json'
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
report['streams'] = []
if report['orchestratorLive']:
    for descriptor in Path(f'/proc/{pid}/fd').iterdir():
        try:
            target = os.readlink(descriptor)
            if job_id not in target or descriptor.is_dir():
                continue
            position = int(next(line.split()[1] for line in Path(f'/proc/{pid}/fdinfo/{descriptor.name}').read_text().splitlines() if line.startswith('pos:')))
            size = descriptor.stat().st_size
            name = Path(target).name
            volume_name, number = None, None
            if name.startswith('volume-') and name.endswith('.tar.gz'):
                encoded = name[7:-7]
                volume_name = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode()
                number = next((i + 1 for i, v in enumerate(manifest.get('volumes', [])) if (v.get('name') or v.get('volumeName')) == volume_name), None)
            report['streams'].append({'file': name, 'volume': volume_name, 'number': number, 'positionBytes': position, 'sizeBytes': size, 'percent': round(position / size * 100, 2) if size else None})
        except (OSError, StopIteration):
            pass
artifact = next((a for a in state['artifacts'] if a['id'] == job.get('artifactId')), None)
report['artifact'] = None
verified = False
if artifact:
    path = root / 'instance-backup-artifacts' / (artifact['id'] + '.backup')
    info = path.lstat()
    verified = artifact.get('integrityStatus') == 'verified' and stat.S_ISREG(info.st_mode) and info.st_size == artifact['size'] and info.st_size > 0
    report['artifact'] = {k: artifact.get(k) for k in ('id', 'provider', 'integrityStatus', 'size', 'sha256')}
    report['artifact']['localFileMatchesSize'] = verified
report['upgradePrerequisitePassed'] = job['status'] == 'succeeded' and verified and report['stagingCleaned']
for path in ('/', '/mnt/agentor-vm-ssd'):
    info = os.statvfs(path)
    report.setdefault('freeGiB', {})[path] = round(info.f_bavail * info.f_frsize / 2**30, 1)
print(json.dumps(report, indent=2))
if args.require_complete and not report['upgradePrerequisitePassed']:
    raise SystemExit(2)
