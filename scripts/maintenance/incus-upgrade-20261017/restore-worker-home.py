#!/usr/bin/env python3
"""One-time home preservation and repeatable package setup for this migration.

Run as agent inside the migrated guest, from its canonical agent-data volume.
Private archives and manifests are runtime data and must never be committed.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile


ALLOWED = {'.local', '.config', '.fluxbox', '.docker', '.texlive2023',
           '.gitconfig', '.bashrc', '.profile', '.fehbg', '.claude.json'}


def validate_archive(path, top):
    if top not in ALLOWED:
        raise ValueError('Unexpected home path')
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        links = set()
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != top:
                raise ValueError('Archive path escapes its selected home entry')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Unsupported archive entry')
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() and not str(target).startswith('/home/agent/'):
                    raise ValueError('Unexpected absolute symlink')
                if not target.is_absolute():
                    depth = len(name.parts) - 1
                    for part in target.parts:
                        depth += -1 if part == '..' else 0 if part == '.' else 1
                        if depth < 0:
                            raise ValueError('Symlink escapes the restore directory')
                links.add(name)
            if member.islnk():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or '..' in target.parts or not target.parts or target.parts[0] != top:
                    raise ValueError('Hardlink escapes its selected home entry')
        for member in members:
            if any(parent in links for parent in PurePosixPath(member.name).parents):
                raise ValueError('Archive writes through a symlink')


def main():
    if os.geteuid() == 0 or Path.home() != Path('/home/agent'):
        raise SystemExit('Run as agent inside its worker guest')
    root = Path(__file__).resolve().parent
    expected = Path('/home/agent/.agent-data/.incus-migration-home')
    if root != expected or root.is_symlink():
        raise SystemExit('Unexpected preservation directory')
    manifest = json.loads((root / 'manifest.json').read_text())
    restored = root / 'restored'
    if not (root / 'restored.json').exists():
        if restored.exists():
            raise SystemExit('Incomplete previous restoration requires inspection')
        staging = root / 'restoring'
        staging.mkdir(mode=0o700)
        for entry in manifest['archives']:
            top = entry['top']
            if top not in ALLOWED:
                raise ValueError('Unexpected home entry')
            archive = root / 'archives' / (top + '.tar')
            with archive.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != entry['sha256']:
                raise ValueError('Home archive digest mismatch')
            validate_archive(archive, top)
            subprocess.run(['tar', '--extract', '--file', str(archive), '--directory', str(staging),
                            '--no-same-owner', '--no-overwrite-dir'], check=True)
        staging.rename(restored)
        # Claude's atomic writes can leave the newest preferences outside its
        # canonical volume. Reconcile that one file before relinking it.
        claude = restored / '.claude.json'
        if claude.is_file():
            json.loads(claude.read_text())
            canonical = root.parent / '.claude.json'
            backup = root / 'claude-before-migration.json'
            if canonical.exists() and not backup.exists():
                shutil.copy2(canonical, backup)
            shutil.copy2(claude, canonical)
        (root / 'restored.json').write_text(json.dumps({'workerId': manifest['workerId']}))
    for entry in manifest['archives']:
        top = entry['top']
        if top == '.claude.json':
            continue
        if top not in ALLOWED:
            raise ValueError('Unexpected home entry')
        target = Path('/home/agent') / top
        source = restored / top
        if target.is_symlink() and target.resolve() == source.resolve():
            continue
        if os.path.lexists(target):
            target.rename(target.with_name(top + '.before-incus-migration-20261017'))
        target.symlink_to(source, target_is_directory=source.is_dir())
    missing = []
    for package in manifest['packages']:
        if not package or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789+-.' for c in package):
            raise ValueError('Invalid package name')
        result = subprocess.run(['dpkg-query', '-W', '-f=${Status}', package], text=True, capture_output=True)
        if result.returncode or result.stdout != 'install ok installed':
            missing.append(package)
    if missing:
        env = dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l')
        subprocess.run(['sudo', '-n', '--preserve-env=DEBIAN_FRONTEND,NEEDRESTART_MODE',
                        'apt-get', 'update'], env=env, check=True)
        subprocess.run(['sudo', '-n', '--preserve-env=DEBIAN_FRONTEND,NEEDRESTART_MODE',
                        'apt-get', 'install', '-y', '--no-install-recommends', *missing], env=env, check=True)
    (root / 'ready.json').write_text(json.dumps({'workerId': manifest['workerId'], 'packages': manifest['packages']}))
    print('Preserved home and additional packages ready:', manifest['workerId'])


if __name__ == '__main__':
    main()
