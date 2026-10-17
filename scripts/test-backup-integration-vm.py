#!/usr/bin/env python3
"""Plan by default; run the unchanged backup suites inside a fresh disposable VM."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('backup_suites', REPO / 'scripts/test-backup-integration.py')
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
GIB = 1024 ** 3
VM_RECORD = Path('/etc/agentor-backup-vm.json')
GUEST_SOURCE = Path('/opt/agentor-backup-source')
GUEST_RESULTS = Path('/var/log/agentor-backup-tests')
CLEAN_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
             'COMPOSE_DISABLE_ENV_FILE': '1', 'DOCKER_HOST': 'unix:///var/run/docker.sock'}


def plan(root, base, checksum, port, nonce, suite='both'):
    root, base = Path(root), Path(base)
    if not root.is_absolute() or not base.is_absolute() or root == root.parent:
        raise ValueError('VM paths must be absolute, distinct private files')
    if root == base or root in base.parents or not 1024 <= port <= 65535:
        raise ValueError('Invalid base-image placement or loopback SSH port')
    if str(uuid.UUID(nonce)) != nonce or len(checksum) != 64 or any(c not in '0123456789abcdef' for c in checksum):
        raise ValueError('Expected a fresh UUID and pinned SHA256')
    selected = list(legacy.SUITES) if suite == 'both' else [suite]
    if any(value not in legacy.SUITES for value in selected):
        raise ValueError('Unknown full backup suite')
    block = {'driver': 'qcow2', 'node-name': 'root',
             'file': {'driver': 'file', 'filename': str(root / 'root.qcow2')},
             'backing': {'driver': 'qcow2', 'read-only': True,
                         'file': {'driver': 'file', 'filename': str(root / 'base.qcow2'), 'read-only': True}}}
    seed = {'driver': 'raw', 'node-name': 'seed', 'read-only': True,
            'file': {'driver': 'file', 'filename': str(root / 'seed.img'), 'read-only': True}}
    qemu = ['qemu-system-x86_64', '-no-user-config', '-nodefaults', '-machine', 'q35,accel=kvm',
            '-cpu', 'host', '-smp', '4', '-m', '8192', '-uuid', nonce,
            '-name', 'agentor-backup-' + nonce, '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
            '-blockdev', json.dumps(block), '-device', 'virtio-blk-pci,drive=root',
            '-blockdev', json.dumps(seed), '-device', 'virtio-blk-pci,drive=seed',
            '-netdev', f'user,id=net,ipv6=off,hostfwd=tcp:127.0.0.1:{port}-:22',
            '-device', 'virtio-net-pci,netdev=net']
    return {'kind': 'agentor-disposable-backup-vm', 'nonce': nonce, 'root': str(root), 'base': str(base),
            'sha256': checksum, 'sshPort': port, 'resources': {'cpus': 4, 'memoryGiB': 8, 'diskGiB': 80},
            'suites': {name: legacy.SUITES[name] for name in selected}, 'qemu': qemu,
            'network': 'QEMU user NAT for dependencies; only inbound forward is loopback SSH',
            'execution': 'Explicit --execute is required after review; this document is a plan, not runtime authority'}


def cloud_config(nonce, public_key, host_private, host_public):
    return '#cloud-config\n' + json.dumps({
        'hostname': 'agentor-backup-' + nonce[:8], 'manage_etc_hosts': True,
        'ssh_pwauth': False, 'disable_root': True,
        'users': [{'name': 'backup-test', 'lock_passwd': True, 'shell': '/bin/bash',
                   'sudo': ['ALL=(ALL) NOPASSWD:ALL'], 'ssh_authorized_keys': [public_key]}],
        'ssh_keys': {'ed25519_private': host_private, 'ed25519_public': host_public},
        'package_update': True, 'packages': ['docker.io', 'docker-compose-v2', 'python3', 'ca-certificates'],
        'write_files': [{'path': str(VM_RECORD), 'permissions': '0400',
                         'content': json.dumps({'kind': 'agentor-disposable-backup-vm', 'nonce': nonce})}],
        'runcmd': [['systemctl', 'enable', '--now', 'docker']],
    }) + '\n'


def assert_guest(nonce, record_path=VM_RECORD, uuid_path=Path('/sys/class/dmi/id/product_uuid')):
    if str(uuid.UUID(nonce)) != nonce:
        raise RuntimeError('Invalid test VM nonce')
    metadata = record_path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077 or metadata.st_size > 1024:
        raise RuntimeError('Test VM metadata is not private root-owned authority')
    record = json.loads(record_path.read_text())
    if (record != {'kind': 'agentor-disposable-backup-vm', 'nonce': nonce} or
            uuid_path.read_text().strip().lower() != nonce or os.geteuid() != 0):
        raise RuntimeError('This command only runs in its exact freshly provisioned test VM')


def guest_plan(suite, nonce):
    proposed = legacy.plan(suite, nonce[:12] + '-' + suite, GUEST_SOURCE)
    service = proposed['override']['services']['test-runner']
    # Privilege is permitted only behind the fresh VM guard, never on the host.
    service['privileged'] = True
    service.pop('cap_drop'); service.pop('security_opt')
    service['labels'] = {'agentor.backup-vm.nonce': nonce}
    proposed['cleanup'].remove('--remove-orphans')
    for volume in proposed['override']['volumes'].values():
        volume['labels'] = {'agentor.backup-vm.nonce': nonce}
    return proposed


def inside_guest(nonce, suite):
    assert_guest(nonce)  # Before any Docker command, even inspection.
    GUEST_RESULTS.mkdir(mode=0o700, exist_ok=False)
    daemon = ['docker', '--host', 'unix:///var/run/docker.sock']
    identity = subprocess.check_output(daemon + ['info', '--format', '{{.ID}}'], env=CLEAN_ENV, text=True).strip()
    if not identity:
        raise RuntimeError('Fresh guest Docker identity is unavailable')
    result = 0
    for name in (list(legacy.SUITES) if suite == 'both' else [suite]):
        assert_guest(nonce)
        if subprocess.check_output(daemon + ['info', '--format', '{{.ID}}'], env=CLEAN_ENV, text=True).strip() != identity:
            raise RuntimeError('Guest Docker daemon identity changed')
        proposed = guest_plan(name, nonce)
        directory = GUEST_RESULTS / name; directory.mkdir(mode=0o700)
        override = directory / 'compose.json'; override.write_text(json.dumps(proposed['override']))
        for key in ('build', 'run', 'cleanup'):
            proposed[key] = [str(override) if value == '<override.json>' else value for value in proposed[key]]
        # Every selected resource must be new; never adopt an earlier stack.
        for kind, target in [('container', proposed['prefix'] + '-runner')] + [('volume', value) for value in proposed['volumes']]:
            check = subprocess.run(daemon + [kind, 'inspect', target], env=CLEAN_ENV, capture_output=True)
            if check.returncode == 0:
                raise RuntimeError('Guest test resource already exists: ' + target)
        code = 1
        try:
            with (directory / 'runner.log').open('wb') as log:
                subprocess.run(proposed['build'], env=CLEAN_ENV, stdout=log, stderr=subprocess.STDOUT, check=True)
                code = subprocess.run(proposed['run'], env=CLEAN_ENV, stdout=log, stderr=subprocess.STDOUT).returncode
        except subprocess.CalledProcessError as error:
            code = error.returncode
        finally:
            try:
                for artifact in ('test-results', 'playwright-report'):
                    source = GUEST_SOURCE / 'tests' / artifact
                    if source.is_dir():
                        shutil.copytree(source, directory / artifact)
            finally:
                assert_guest(nonce)
                if subprocess.check_output(daemon + ['info', '--format', '{{.ID}}'], env=CLEAN_ENV, text=True).strip() != identity:
                    raise RuntimeError('Guest Docker identity changed; cleanup refused')
                subprocess.run(proposed['cleanup'], env=CLEAN_ENV, check=True)
        (directory / 'result.json').write_text(json.dumps({'suite': name, 'exitCode': code, 'daemonId': identity, 'nonce': nonce}))
        result = result or code
    return result


def copy_log(stream, destination, limit=64 * 1024 * 1024):
    size = 0
    with destination.open('wb') as output:
        while chunk := stream.read(65536):
            if size < limit:
                output.write(chunk[:limit - size])
            size += len(chunk)
        if size > limit:
            output.write(b'\n[remaining process output omitted after log limit]\n')


def command(args, **kwargs):
    return subprocess.run(args, check=True, timeout=120, **kwargs)


def validate_base_header(path):
    # Reject external references before any QEMU tool can open the image format.
    with Path(path).open('rb') as image:
        header = image.read(104)
    if len(header) < 72 or header[:4] != b'QFI\xfb':
        raise RuntimeError('Expected a complete ordinary qcow2 header')
    version = struct.unpack_from('>I', header, 4)[0]
    backing, backing_size = struct.unpack_from('>QI', header, 8)
    size, encryption = struct.unpack_from('>QI', header, 24)
    if version not in (2, 3) or backing or backing_size or encryption or not 0 < size <= 80 * GIB:
        raise RuntimeError('Only a standalone unencrypted bounded qcow2 image is accepted')
    if version == 3 and (len(header) < 104 or struct.unpack_from('>Q', header, 72)[0] & 4):
        raise RuntimeError('External qcow2 data files or truncated headers are forbidden')


def execute(proposed):
    root, base = Path(proposed['root']), Path(proposed['base']).resolve(strict=True)
    for tool in ('qemu-system-x86_64', 'qemu-img', 'cloud-localds', 'ssh', 'ssh-keygen', 'git'):
        if not shutil.which(tool):
            raise RuntimeError('Missing host tool: ' + tool)
    if not stat.S_ISREG(base.stat().st_mode) or base.stat().st_size > GIB:
        raise RuntimeError('Base must be an ordinary bounded cloud-image file, never a block device')
    if root.exists() or root.is_symlink():
        raise RuntimeError('Run directory already exists; it will not be adopted or removed')
    if shutil.disk_usage(root.parent).free < 90 * GIB:
        raise RuntimeError('At least 90 GiB free is required for the bounded 80 GiB VM and artifacts')
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        raise RuntimeError('KVM access is required; no host permissions will be changed')
    command(['git', '-C', str(REPO), 'diff', '--quiet', 'HEAD', '--'])
    commit = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip()
    # Reserve the exact address first. QEMU must acquire it itself or fail closed.
    reservation = socket.socket(); reservation.bind(('127.0.0.1', proposed['sshPort']))
    os.umask(0o077); root.mkdir(mode=0o700)
    owned = root.stat()
    process = None
    log_thread = None
    spawning = False
    cancelled = None
    previous_handlers = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    def cancel(number, _frame):
        nonlocal cancelled
        if cancelled is not None:
            return
        cancelled = number
        # Capture the child handle before unwinding a signal during Popen.
        if not spawning:
            raise SystemExit(128 + number)
    for number in previous_handlers:
        signal.signal(number, cancel)
    try:
        (root / 'plan.json').write_text(json.dumps({**proposed, 'commit': commit}, indent=2))
        digest = hashlib.sha256()
        with base.open('rb') as source, (root / 'base.qcow2').open('xb') as output:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk); output.write(chunk)
        if digest.hexdigest() != proposed['sha256']:
            raise RuntimeError('Cloud image SHA256 does not match the reviewed base')
        os.chmod(root / 'base.qcow2', 0o400)
        validate_base_header(root / 'base.qcow2')
        info = json.loads(subprocess.check_output(['qemu-img', 'info', '--output=json', str(root / 'base.qcow2')]))
        if info.get('format') != 'qcow2' or info.get('backing-filename') or info.get('encrypted') or info.get('virtual-size', 0) > 80 * GIB or info.get('format-specific', {}).get('data', {}).get('data-file'):
            raise RuntimeError('Only a standalone ordinary qcow2 cloud image is accepted')
        command(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(root / 'base.qcow2'), str(root / 'root.qcow2'), '80G'], stdout=subprocess.DEVNULL)
        for name in ('client-key', 'host-key'):
            command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / name)])
        host_key = (root / 'host-key.pub').read_text().split()
        (root / 'known_hosts').write_text(f"[127.0.0.1]:{proposed['sshPort']} {host_key[0]} {host_key[1]}\n")
        (root / 'user-data').write_text(cloud_config(proposed['nonce'], (root / 'client-key.pub').read_text().strip(),
                                                   (root / 'host-key').read_text(), (root / 'host-key.pub').read_text().strip()))
        (root / 'meta-data').write_text(json.dumps({'instance-id': proposed['nonce']}))
        command(['cloud-localds', str(root / 'seed.img'), str(root / 'user-data'), str(root / 'meta-data')])
        with (root / 'source.tar').open('xb') as archive:
            command(['git', '-C', str(REPO), 'archive', commit], stdout=archive)
        if (root / 'source.tar').stat().st_size > GIB:
            raise RuntimeError('Committed source archive exceeds 1 GiB')
        # Validate tracked links/paths before the same archive reaches guest tar.
        with tempfile.TemporaryDirectory(dir=root, prefix='source-check-') as scratch:
            with tarfile.open(root / 'source.tar') as archive:
                archive.extractall(scratch, filter='data')
        reservation.close()
        spawning = True
        try:
            process = subprocess.Popen(proposed['qemu'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        finally:
            spawning = False
        if cancelled is not None:
            raise SystemExit(128 + cancelled)
        log_thread = threading.Thread(target=copy_log, args=(process.stdout, root / 'console.log'), daemon=True); log_thread.start()
        ssh = ['ssh', '-F', '/dev/null', '-T', '-p', str(proposed['sshPort']), '-i', str(root / 'client-key'),
               '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
               '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(root / 'known_hosts'),
               '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1',
               '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', 'backup-test@127.0.0.1']
        ready = time.monotonic() + 900
        with (root / 'bootstrap.log').open('wb') as log:
            while True:
                if process.poll() is not None:
                    raise RuntimeError('QEMU exited before guest readiness; inspect console.log')
                try:
                    probe = subprocess.run(ssh + ['sudo -n cloud-init status --wait'], stdout=log, stderr=log, timeout=30)
                    if probe.returncode == 0:
                        break
                except subprocess.TimeoutExpired:
                    pass
                if time.monotonic() >= ready:
                    raise RuntimeError('Guest provisioning did not finish within 15 minutes')
                time.sleep(2)
        command(ssh + ['sudo -n install -d -m 0755 ' + str(GUEST_SOURCE)])
        with (root / 'source.tar').open('rb') as archive:
            command(ssh + ['sudo -n tar -xpf - --no-same-owner -C ' + str(GUEST_SOURCE)], stdin=archive)
        remote = f'sudo -n env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root python3 {GUEST_SOURCE}/scripts/test-backup-integration-vm.py --inside-guest {proposed["nonce"]} --suite ' + ('both' if len(proposed['suites']) == 2 else next(iter(proposed['suites'])))
        code = 1
        try:
            with (root / 'run.log').open('wb') as log:
                code = subprocess.run(ssh + [remote], stdout=log, stderr=log, timeout=4 * 3600).returncode
        finally:
            with (root / 'reports.tar').open('wb') as report:
                # Bound report storage separately from the 80 GiB virtual disk.
                import resource
                def report_limit():
                    resource.setrlimit(resource.RLIMIT_FSIZE, (GIB, GIB))
                command(ssh + [f'sudo -n tar -cf - -C {GUEST_RESULTS} .'], stdout=report, preexec_fn=report_limit)
            (root / 'reports').mkdir(mode=0o700)
            with tarfile.open(root / 'reports.tar') as report:
                members, size = [], 0
                for member in report:
                    size += member.size
                    if len(members) >= 100_000 or size > GIB:
                        raise RuntimeError('Guest report archive exceeds its file/byte limit')
                    members.append(member)
                report.extractall(root / 'reports', members=members, filter='data')
        (root / 'result.json').write_text(json.dumps({'exitCode': code, 'commit': commit, 'nonce': proposed['nonce']}))
        return code
    finally:
        # Repeated cancellation must not interrupt confirmed-exit/key cleanup.
        for number in previous_handlers:
            signal.signal(number, signal.SIG_IGN)
        try:
            reservation.close()
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
            if log_thread and log_thread.is_alive():
                log_thread.join(timeout=5)
            # No PID-file lookup, name search, Docker prune or ancestor-directory deletion.
            if root.stat().st_ino != owned.st_ino or root.stat().st_dev != owned.st_dev:
                raise RuntimeError('Run directory identity changed; file cleanup refused')
            for name in ('root.qcow2', 'base.qcow2', 'seed.img', 'client-key', 'host-key', 'user-data', 'source.tar', 'reports.tar'):
                (root / name).unlink(missing_ok=True)
            print('Backup VM stopped; logs and reports retained at ' + str(root), flush=True)
        finally:
            for number, handler in previous_handlers.items():
                signal.signal(number, handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=['both', *legacy.SUITES], default='both')
    parser.add_argument('--inside-guest', help=argparse.SUPPRESS)
    parser.add_argument('--base-image', type=Path)
    parser.add_argument('--base-sha256')
    parser.add_argument('--run-directory', type=Path)
    parser.add_argument('--ssh-port', type=int)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args(argv)
    if args.inside_guest:
        return inside_guest(args.inside_guest, args.suite)
    if not all((args.base_image, args.base_sha256, args.run_directory, args.ssh_port)):
        parser.error('base image, pinned SHA256, fresh run directory and loopback SSH port are required')
    proposed = plan(args.run_directory, args.base_image, args.base_sha256, args.ssh_port, str(uuid.uuid4()), args.suite)
    if not args.execute:
        print(json.dumps(proposed, indent=2)); return 0
    return execute(proposed)


if __name__ == '__main__':
    raise SystemExit(main())
