#!/usr/bin/env python3
"""Guarded one-time setup of new Incus state on the existing SSD mount."""
import json
import os
from pathlib import Path
import shutil
import subprocess

base = Path(__file__).resolve().parent
assert os.geteuid() == 0, 'Run as root'
gate = json.loads(subprocess.check_output(['python3', str(base / 'monitor-backup.py'), '--require-complete']))
assert gate['upgradePrerequisitePassed']
ssd = Path('/mnt/agentor-vm-ssd')
uuid = '17b446d6-0931-49a9-84a9-f5edac5a723f'
assert subprocess.check_output(['findmnt', '-n', '-o', 'UUID', '--mountpoint', str(ssd)], text=True).strip() == uuid
assert ssd.resolve() == ssd
source, destination = ssd / 'incus-production', Path('/var/lib/incus')
assert not source.exists(), 'New Incus source already exists; inspect before retrying'
assert not destination.is_symlink()
assert not destination.exists() or (destination.is_dir() and not any(destination.iterdir())), 'Existing Incus state must be preserved'
assert subprocess.run(['systemctl', 'is-active', '--quiet', 'incus.service']).returncode != 0
assert not Path('/var/lib/incus/unix.socket').exists()
fstab = Path('/etc/fstab')
original = fstab.read_text()
assert not any(line.strip() and not line.lstrip().startswith('#') and len(line.split()) > 1 and line.split()[1] == str(destination) for line in original.splitlines())
assert not (base / 'fstab.before-incus').exists(), 'Original fstab evidence already exists; inspect before retrying'
shutil.copy2(fstab, base / 'fstab.before-incus')
(base / 'fstab.before-incus').chmod(0o600)
source.mkdir(mode=0o711)
destination.mkdir(mode=0o711, exist_ok=True)
source_unit = subprocess.check_output(['systemd-escape', '--path', '--suffix=mount', str(ssd)], text=True).strip()
mount_unit = 'var-lib-incus.mount'
dropins = {
    mount_unit: f'[Unit]\nBindsTo={source_unit}\nAfter={source_unit}\n',
}
guard = f'[Unit]\nRequiresMountsFor={destination}\nBindsTo={mount_unit}\nAfter={mount_unit}\nAssertPathIsMountPoint={destination}\n'
for unit in ('incus.service', 'incus.socket', 'incus-startup.service'):
    dropins[unit] = guard
for unit, body in dropins.items():
    directory = Path('/etc/systemd/system') / (unit + '.d')
    directory.mkdir(mode=0o755, exist_ok=True)
    target = directory / 'agentor-production-ssd.conf'
    assert not target.exists(), 'Unreviewed storage drop-in already exists'
    target.write_text('# Agentor production Incus storage dependency\n' + body)
    target.chmod(0o644)
entry = f'{source} {destination} none bind,nofail,x-systemd.requires-mounts-for={ssd} 0 0\n'
temporary = Path('/etc/fstab.agentor-incus-tmp')
with temporary.open('x') as stream:
    stream.write(original.rstrip() + '\n' + entry)
temporary.chmod(0o644)
temporary.replace(fstab)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['mount', str(destination)], check=True)
assert subprocess.check_output(['findmnt', '-n', '-o', 'UUID', '--mountpoint', str(destination)], text=True).strip() == uuid
assert source.stat().st_ino == destination.stat().st_ino
data = Path('/var/lib/docker/volumes/agentor-data/_data')
material = ssd / 'agentor-recovery-material-20261017'
material.mkdir(mode=0o700)
preserved = []
for name in ('backup-keyring.json', 'worker-config.key', 'auth.secret', 'backup-installation-id'):
    path = data / name
    assert path.is_file() and not path.is_symlink(), f'Required recovery material missing: {name}'
    target = material / name
    shutil.copyfile(path, target)
    target.chmod(0o600)
    preserved.append(name)
(base / 'backup-prerequisite-passed.json').write_text(json.dumps(gate, indent=2) + '\n')
receipt = {'status': 'prepared', 'source': str(source), 'mount': str(destination), 'ssdUuid': uuid,
           'fstabBackup': str(base / 'fstab.before-incus'), 'guardedUnits': list(dropins),
           'recoveryMaterialDirectory': str(material), 'preservedFiles': preserved}
(base / 'incus-storage-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
