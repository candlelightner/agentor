#!/usr/bin/env python3
"""Guest-root-only, read-only Docker inventory and bounded volume-sample proof.
Input: {version:1,expectedIncarnation,inventory,samples}. No full-tree claim.
The host caller separately proves owner/installation/current rebuild authority.
"""
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

MAX_FILE, MAX_INPUT, MAX_OUTPUT = 8 * 1024**2, 2 * 1024**2, 4 * 1024**2
UUID = r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
VOLUME = r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}'
ROOT = '/var/lib/docker'
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME

class Refused(Exception):
    pass

def require(value, code):
    if not value:
        raise Refused(code)

def integer(value, maximum):
    return type(value) is int and 0 <= value <= maximum

def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None

def identities(values, pattern):
    require(isinstance(values, list) and len(values) <= 10000 and all(matches(pattern, v) for v in values)
            and len(values) == len(set(values)), 'INVALID_INVENTORY')
    return set(values)

def safe_path(path):
    return isinstance(path, str) and 0 < len(path.encode()) <= 4096 and not re.search(r'[\x00-\x1f\x7f]', path) and all(p not in ('', '.', '..') for p in path.split('/'))

def parse_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'DUPLICATE_JSON_KEY'); result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique)

def request(value):
    require(isinstance(value, dict) and type(value.get('version')) is int and value.get('version') == 1 and matches(UUID, value.get('expectedIncarnation')), 'INVALID_REQUEST')
    inventory, samples = value.get('inventory'), value.get('samples')
    require(isinstance(inventory, dict) and isinstance(samples, dict), 'INVALID_REQUEST')
    require(matches(UUID, inventory.get('workerId')) and matches(r'[a-f0-9]{64}', inventory.get('sourceContainerId'))
            and matches(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', inventory.get('sourceCreated'))
            and inventory.get('driver') == 'overlay2', 'INVALID_SOURCE')
    expected = {key: identities(inventory.get(key), pattern) for key, pattern in
                [('images', r'sha256:[a-f0-9]{64}'), ('containers', r'[a-f0-9]{64}'), ('volumes', VOLUME)]}
    require(samples.get('workerId') == inventory['workerId'] and samples.get('sourceContainerId') == inventory['sourceContainerId']
            and samples.get('samplingIsNotFullTreeVerification') is True, 'SAMPLE_AUTHORITY_MISMATCH')
    volumes = samples.get('volumes'); require(isinstance(volumes, dict) and len(volumes) <= 256, 'INVALID_SAMPLES')
    total, count = 0, 0
    for name, volume in volumes.items():
        require(name in expected['volumes'] and isinstance(volume, dict), 'INVALID_SAMPLES')
        files = volume.get('files'); require(isinstance(files, list) and len(files) <= 16, 'INVALID_SAMPLES')
        seen = set()
        for item in files:
            require(isinstance(item, dict), 'INVALID_SAMPLE')
            path = item.get('path')
            require(safe_path(path) and path not in seen, 'UNSAFE_SAMPLE_PATH')
            seen.add(path)
            require(integer(item.get('size'), MAX_FILE) and matches(r'[a-f0-9]{64}', item.get('sha256')), 'INVALID_SAMPLE')
            for key, maximum in [('uid', 2**32-1), ('gid', 2**32-1), ('mode', 0o7777), ('mtimeNs', 2**63-1)]:
                require(key not in item or integer(item[key], maximum), 'INVALID_SAMPLE_METADATA')
            total += item['size']; count += 1
    require(total <= 64 * 1024**2 and count <= 128, 'SAMPLE_LIMIT')
    return inventory, volumes, expected

def docker(args):
    allowed = [['info', '--format', '{{json .}}'], ['image', 'ls', '--no-trunc', '--quiet'],
               ['container', 'ls', '--all', '--no-trunc', '--quiet'], ['volume', 'ls', '--quiet']]
    require(args in allowed or args[:2] == ['volume', 'inspect'] and len(args) > 2
            and all(matches(VOLUME, name) for name in args[2:]), 'INVALID_DOCKER_COMMAND')
    with subprocess.Popen(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent',
                          'DOCKER_CONFIG': '/nonexistent', 'LC_ALL': 'C'}) as process:
        output, deadline = bytearray(), time.monotonic() + 30
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                while True:
                    require(time.monotonic() < deadline, 'DOCKER_TIMEOUT')
                    if not ready.select(min(1, max(0, deadline-time.monotonic()))):
                        continue
                    chunk = os.read(process.stdout.fileno(), min(65536, MAX_OUTPUT + 1-len(output)))
                    if not chunk:
                        break
                    output.extend(chunk); require(len(output) <= MAX_OUTPUT, 'DOCKER_OUTPUT_LIMIT')
            require(process.wait(timeout=max(.01, deadline-time.monotonic())) == 0, 'DOCKER_READ_FAILED')
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
        return output.decode('utf-8', errors='strict').strip()

def stable(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def sample(name, item):
    require(matches(VOLUME, name) and safe_path(item.get('path')), 'UNSAFE_SAMPLE_PATH')
    # Start at / and use dirfds+NOFOLLOW for EVERY component, including the
    # fixed Docker root. NONBLOCK prevents a replaced FIFO/device from hanging.
    descriptors, ancestry = [], []
    try:
        parent = os.open('/', DIR); descriptors.append(parent)
        parts = ['var', 'lib', 'docker', 'volumes', name, '_data', *item['path'].split('/')]
        for part in parts[:-1]:
            child = os.open(part, DIR, dir_fd=parent); descriptors.append(child)
            ancestry.append((parent, part, os.fstat(child))); parent = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOATIME, dir_fd=parent)
        descriptors.append(fd); before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= MAX_FILE, 'UNSAFE_SAMPLE_TYPE')
        digest, size = hashlib.sha256(), 0
        while True:
            chunk = os.read(fd, min(65536, MAX_FILE + 1-size))
            if not chunk:
                break
            size += len(chunk); require(size <= MAX_FILE, 'SAMPLE_LIMIT'); digest.update(chunk)
        require(stable(before) == stable(os.fstat(fd)) == stable(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)), 'SAMPLE_CHANGED')
        for ancestor, part, original in ancestry:
            current = os.stat(part, dir_fd=ancestor, follow_symlinks=False)
            require((current.st_dev, current.st_ino, current.st_mode) == (original.st_dev, original.st_ino, original.st_mode), 'SAMPLE_PATH_CHANGED')
        result = {'size': size, 'sha256': digest.hexdigest(), 'uid': before.st_uid, 'gid': before.st_gid,
                  'mode': stat.S_IMODE(before.st_mode), 'mtimeNs': before.st_mtime_ns}
        require(all(result[key] == value for key, value in item.items() if key in result), 'SAMPLE_MISMATCH')
        return {'volume': name, 'path': item['path'], **result}
    finally:
        for fd in reversed(descriptors):
            os.close(fd)

def guest_uuid():
    with open('/sys/class/dmi/id/product_uuid', 'r', encoding='ascii') as source:
        return source.read(128).strip().lower()

def filesystem():
    directory = os.open('/', DIR)
    try:
        for part in ['var', 'lib', 'docker']:
            child = os.open(part, DIR, dir_fd=directory); os.close(directory); directory = child
        space = os.fstatvfs(directory)
    finally:
        os.close(directory)
    return space

def verify(value, identity=guest_uuid, command=docker, read_sample=sample, read_space=filesystem):
    require(os.geteuid() == 0, 'GUEST_ROOT_REQUIRED')
    inventory, volumes, expected = request(value)
    # Incus passes volatile.uuid to QEMU -uuid. Do not use generation UUID or
    # permit absent/mismatched DMI before any Docker, sample or filesystem read.
    require(identity() == value['expectedIncarnation'], 'GUEST_INCARNATION_MISMATCH')
    info = parse_json(command(['info', '--format', '{{json .}}']))
    require(isinstance(info, dict) and info.get('Driver') == 'overlay2' and info.get('DockerRootDir') == ROOT, 'DOCKER_LAYOUT_MISMATCH')
    observed = {}
    for key, args, pattern in [('images', ['image', 'ls', '--no-trunc', '--quiet'], r'sha256:[a-f0-9]{64}'),
        ('containers', ['container', 'ls', '--all', '--no-trunc', '--quiet'], r'[a-f0-9]{64}'), ('volumes', ['volume', 'ls', '--quiet'], VOLUME)]:
        rows = command(args).splitlines()
        require(len(rows) <= 10000 and all(matches(pattern, row) for row in rows), 'MALFORMED_DOCKER_INVENTORY')
        observed[key] = set(rows); require(expected[key] <= observed[key], 'DOCKER_INVENTORY_MISSING')
    if volumes:
        inspected = parse_json(command(['volume', 'inspect', *sorted(volumes)]))
        require(isinstance(inspected, list) and len(inspected) == len(volumes), 'INVALID_VOLUME_INSPECTION')
        require(all(isinstance(v, dict) and matches(VOLUME, v.get('Name')) for v in inspected), 'INVALID_VOLUME_INSPECTION')
        require({v['Name'] for v in inspected} == set(volumes), 'INVALID_VOLUME_INSPECTION')
        for volume in inspected:
            require(volume.get('Driver') == 'local' and volume.get('Scope') == 'local' and volume.get('Options') in (None, {}) and
                    volume.get('Mountpoint') == ROOT + '/volumes/' + volume['Name'] + '/_data', 'UNSAFE_VOLUME_LAYOUT')
    results = [read_sample(name, item) for name, volume in sorted(volumes.items()) for item in volume['files']]
    space = read_space()
    return {'ok': True, 'incarnation': value['expectedIncarnation'], 'workerId': inventory['workerId'],
        'sourceContainerId': inventory['sourceContainerId'], 'samplingIsNotFullTreeVerification': True,
        'counts': {**{key: len(rows) for key, rows in observed.items()}, 'samples': len(results), 'sampleBytes': sum(row['size'] for row in results)},
        'filesystem': {'freeBytes': space.f_bavail * space.f_frsize, 'freeInodes': space.f_favail}, 'samples': results}

def main():
    signal.signal(signal.SIGALRM, lambda _s, _f: require(False, 'VERIFICATION_TIMEOUT')); signal.alarm(300)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1); require(len(raw) <= MAX_INPUT, 'INPUT_LIMIT')
        result = verify(parse_json(raw))
    except (Refused, OSError, ValueError, KeyError, TypeError, RecursionError, subprocess.SubprocessError) as error:
        result = {'ok': False, 'code': str(error) if isinstance(error, Refused) else 'VERIFICATION_READ_FAILED'}
    finally:
        signal.alarm(0)
    print(json.dumps(result, sort_keys=True)); return 0 if result['ok'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
