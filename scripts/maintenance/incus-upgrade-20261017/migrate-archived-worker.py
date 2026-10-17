#!/usr/bin/env python3
"""One reviewed archived-worker migration. Default is read-only preflight.

This is installation-specific operational code, not a general migration API.
Never retries a mutation, finalizes migration, or deletes retained source data.
"""
import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
from urllib.parse import urlsplit

BASE = Path('/home/emil/agentor-vm-upgrade-preparation-20261017')
DATA = Path('/var/lib/docker/volumes/agentor-data/_data')
OWNER = 'b84d9539-d160-42e9-9eb6-f343cb430bb0'
INSTALLATION = '3ccdf904-dbbf-4d7f-998f-78a6666bcb5c'
PROJECT, POOL = 'agentor', 'ag3ccdf904'
ALLOW = frozenset(('834db661-cff3-402b-8daa-b0ba4738abeb',
    '2eb7b5c5-5df6-412d-81cd-a88e7a9a92a5', '2ecd0b20-faf9-422f-95a1-1db08c812669',
    'b71d012c-4d77-4a7a-8e8b-4626d11ed5d8', 'a9812e5e-7316-4de6-9c6b-bf3ec11dcee2',
    'a05a29a7-fb5c-487a-8202-a13af60e7836'))
DEFAULT_ENV = '62159997-f273-5cdc-8381-f91f5c7747b3'
ENV_CLONES = {'5b6ac7d3-0513-46ec-92f0-2b2f5ef446e3': 'efccef38-5aa3-42e9-9e36-8170a920fe29',
    DEFAULT_ENV: '04519015-0228-46ff-a417-ca6010b79c18'}
CUSTOM = {
    'b71d012c-4d77-4a7a-8e8b-4626d11ed5d8': ('3f3a36aa-d288-4ffb-a21b-5ccc3d7a3704', 'v2',
        'sha256:664cc5b5df3ee53120a9ced225561bea0d508af0373ccbac3ee8f31d4f617cd4'),
    'a9812e5e-7316-4de6-9c6b-bf3ec11dcee2': ('39c12621-41df-4be8-95f9-b5d35bbbe1e4', 'v1',
        'sha256:d2387eda075b11c41a417762eaf9dea292251bc83e13aea8ff1cecee249a09bb'),
}
IMAGE_FIELDS = ('imageDefinitionId', 'imageVersion', 'imageDigest', 'imageRuntimeReference', 'importedImage')
ENV_METADATA = frozenset(('id', 'name', 'userId', 'builtIn', 'createdAt', 'updatedAt', 'memoryLimit'))
MUTABLE_RECORD = frozenset(('updatedAt', 'status', 'desiredRuntimeStatus', 'archivedAt',
    'runtimeKind', 'incusMigration', 'incusRecreation', 'pendingRebuild', 'environmentId'))


class Refusal(RuntimeError):
    """Messages must never contain private source values or command output."""


def require(condition, message):
    if not condition:
        raise Refusal(message)


def read_json(path):
    return json.loads(Path(path).read_text())


def command(args, *, payload=None, timeout=90):
    result = subprocess.run(args, input=payload, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False)
    require(result.returncode == 0, 'Host/guest command failed; inspect resources manually')
    return result.stdout


def command_json(args):
    return json.loads(command(args))


def private_write(path, value):
    # Exclusive, no-follow, fsynced receipts survive process/host interruption.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, indent=2, sort_keys=True)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def validate_record(record, worker_id):
    require(worker_id in ALLOW and record.get('id') == worker_id and record.get('userId') == OWNER,
            'Worker is outside the exact migration allowlist/owner')
    require(record.get('status') == 'archived' and record.get('desiredRuntimeStatus') in (None, 'stopped'),
            'Expected an archived worker with stopped intent')
    require(record.get('runtimeKind') in (None, 'legacy-docker') and not record.get('incusMigration')
            and not record.get('incusRecreation') and not record.get('deletionPending'),
            'Worker already has native/recovery/deletion authority')
    require(not record.get('hardwareDeviceIds') and not record.get('hardwareDevicesRevoked')
            and not record.get('mounts') and not record.get('hostMountsRevoked'),
            'Hardware or explicit host-mount changes require separate review')
    require(not record.get('trusted') and record.get('kind') not in ('administrative', 'admin')
            and not record.get('importedImage'), 'Administrative/imported worker is not allowed')
    if worker_id in CUSTOM:
        definition, version, digest = CUSTOM[worker_id]
        require(tuple(record.get(k) for k in IMAGE_FIELDS[:4]) == (definition, version, digest, digest),
                'Custom image selection differs from the reviewed immutable source')
    else:
        require(not any(record.get(k) for k in IMAGE_FIELDS), 'Unexpected custom image selection')


def validate_clone(original, clone):
    require(original.get('memoryLimit') in ('', None, '0') and clone.get('memoryLimit') == '4g',
            'Environment memory policy differs from the reviewed uncapped-to-4g change')
    require(clone.get('userId') == OWNER and clone.get('builtIn') is False,
            'Clone ownership/type differs')
    require({k: v for k, v in original.items() if k not in ENV_METADATA} ==
            {k: v for k, v in clone.items() if k not in ENV_METADATA},
            'Environment clone changes fields other than metadata and memory')


def validate_managed(managed):
    require(all(v.get('userId') == OWNER and v.get('state') in ('ready', 'detached') and v.get('seeded') is True
                and not v.get('operation') and not v.get('liveContainerId') for v in managed),
            'Managed volume recovery is pending')
    require(all(v.get('purpose') == 'persistent-path' and v.get('dockerName') == 'agentor-persist-' + v['id']
                for v in managed), 'Legacy persistent-path naming is unsupported by the deployed native migration; separate review required')


def stable_record(record):
    value = {k: v for k, v in record.items() if k not in MUTABLE_RECORD}
    # Supported unarchive normalizes absent legacy defaults into explicit values.
    for field in ('mounts', 'hardwareDeviceIds', 'repos', 'excludedGlobalEnvVarKeys', 'excludedGroupEnvVarKeys'):
        value[field] = value.get(field) or []
    value['initScript'] = value.get('initScript') or ''
    for field in ('hostMountsRevoked', 'hardwareDevicesRevoked', 'deletionPending'):
        value[field] = value.get(field, False)
    return value


def source_identity(info):
    return {k: info[k] for k in ('Id', 'Created', 'Image', 'Mounts')}


def hash_regular(root, relative):
    parts = Path(relative).parts
    require(parts and not Path(relative).is_absolute() and all(p not in ('', '.', '..') for p in parts),
            'Unsafe sample path')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(leaf, 'rb') as source:
            before = os.fstat(source.fileno())
            require(stat.S_ISREG(before.st_mode) and before.st_size <= 8 * 1024**2,
                    'Sample is no longer a bounded regular file')
            digest = hashlib.sha256(source.read(8 * 1024**2 + 1)).hexdigest()
            after = os.fstat(source.fileno())
            require((before.st_ino, before.st_size, before.st_mtime_ns) ==
                    (after.st_ino, after.st_size, after.st_mtime_ns), 'Sample changed while reading')
            return {'path': relative, 'size': before.st_size, 'sha256': digest}
    finally:
        os.close(fd)


def sample_files(root):
    # Small evidence samples, never a full data-fidelity claim. No symlink follows.
    excluded = re.compile(r'(^\.agentor|^\.incus-migration|auth|credential|secret|token|^\.ssh$|^\.aws$|'
                          r'^\.codex$|^\.claude|^\.gemini$|^\.kilo$|^\.cache$|^\.vscode|^logs?$|^sessions?$|'
                          r'^\.config$|code-server|\.log$|\.sqlite|\.db$)', re.I)
    samples, visited = [], 0
    for directory, names, files in os.walk(root, followlinks=False):
        visited += 1
        if visited > 2000:
            return {'files': samples, 'scanLimitReached': True}
        names[:] = sorted(n for n in names if not excluded.search(n)
                          and not Path(directory, n).is_symlink())
        for name in sorted(files):
            visited += 1
            if visited > 2000:
                return {'files': samples, 'scanLimitReached': True}
            path = Path(directory, name)
            if excluded.search(name) or path.is_symlink():
                continue
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_size <= 8 * 1024**2:
                samples.append(hash_regular(root, str(path.relative_to(root))))
                if len(samples) == 8:
                    return {'files': samples, 'scanLimitReached': False}
    return {'files': samples, 'scanLimitReached': False}


class Migration:
    def __init__(self, worker_id, *, base=BASE, data=DATA):
        require(worker_id in ALLOW, 'Worker is not allowlisted')
        self.id, self.base, self.data = worker_id, Path(base), Path(data)
        self.owner_dir = self.data / 'users' / OWNER
        self.name = 'agentor-worker-' + worker_id
        self.cookie = None
        self.executing = False
        self.step = 0

    def record(self):
        records = [r for r in read_json(self.owner_dir / 'workers.json') if r.get('id') == self.id]
        require(len(records) == 1, 'Raw worker identity is absent or duplicated')
        return records[0]

    def managed(self):
        path = self.owner_dir / 'managed-volumes.v1.json'
        return [v for v in read_json(path) if v.get('workerId') == self.id] if path.exists() else []

    def receipt(self, phase, value):
        private_write(self.base / f'migration-{self.id}.{phase}.private.json',
                      {'workerId': self.id, 'at': time.time(), **value})

    def api(self, method, path, body=None, *, html=False):
        require(path.startswith('/') and not path.startswith('//'), 'Invalid local API path')
        headers = {'Host': self.host, 'Origin': self.origin, 'Cookie': self.cookie,
                   'Accept': 'text/html' if html else 'application/json'}
        payload = None if body is None else json.dumps(body)
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        redirects = 0
        while True:
            connection = http.client.HTTPConnection('127.0.0.1', 3000, timeout=1800)
            try:
                connection.request(method, path, body=payload, headers=headers)
                response = connection.getresponse()
                raw = response.read(16 * 1024**2 + 1)
                require(len(raw) <= 16 * 1024**2, 'API reply exceeded bounded response size')
                if html and method == 'GET' and path.startswith(f'/editor/{self.id}/') and response.status in (301, 302, 303, 307, 308):
                    target = urlsplit(response.getheader('Location', ''))
                    require(redirects < 5 and not target.username and not target.password and not target.fragment
                            and (not target.netloc or target.netloc == self.host and target.scheme == urlsplit(self.origin).scheme)
                            and target.path.startswith(f'/editor/{self.id}/'), 'Editor redirect left the exact same-origin worker path')
                    path = target.path + ('?' + target.query if target.query else '')
                    redirects += 1
                    continue
                require(response.status == 200, f'API returned HTTP {response.status}; no automatic retry')
                return {'status': response.status, 'bytes': len(raw), 'redirects': redirects} if html else json.loads(raw)
            finally:
                connection.close()

    def mutate(self, label, method, path, body):
        require(self.executing, 'Mutations require explicit --execute')
        self.step += 1
        prefix = f'{self.step:02d}-{label}'
        self.receipt(prefix + '-request', {'method': method, 'path': path, 'body': body,
                                        'record': self.record()})
        try:
            result = self.api(method, path, body)
        except BaseException as error:
            self.receipt(prefix + '-ambiguous', {'errorType': type(error).__name__,
                         'outcome': 'unknown; inspect raw record and runtimes before any manual recovery'})
            raise
        self.receipt(prefix + '-response', {'response': result, 'record': self.record()})
        return result

    def incus(self, path):
        return command_json(['incus', '--force-local', 'query', path + ('&' if '?' in path else '?') + 'project=' + PROJECT])

    def instances(self):
        return command_json(['incus', '--force-local', 'list', '--project', PROJECT, '--format', 'json'])

    def assert_no_compute(self):
        require(not any(v.get('name') == self.name or v.get('config', {}).get('user.agentor.id') == self.id
                        for v in self.instances()), 'Native compute already exists')

    def preflight(self):
        require(not list(self.base.glob(f'migration-{self.id}.*')), 'Existing receipt makes rerun ambiguous')
        original = self.record()
        validate_record(original, self.id)
        plan = read_json(self.base / 'worker-migration-plan.private.json')['workers']
        approved = [w for w in plan if w.get('id') == self.id]
        require(len(approved) == 1 and approved[0].get('status') == 'archived'
                and approved[0].get('sourceImageAvailable') is True, 'Migration plan does not confirm this source')
        inspect = command_json(['docker', 'inspect', 'agentor-orchestrator'])[0]
        env = dict(entry.split('=', 1) for entry in inspect['Config']['Env'])
        require(env.get('INCUS_PROJECT') == PROJECT and env.get('INCUS_STORAGE_POOL') == POOL
                and env.get('CONTAINER_PREFIX', 'agentor-worker') == 'agentor-worker', 'Installation configuration drift')
        require(any(m.get('Destination') == '/data' and m.get('Source') == str(self.data) for m in inspect['Mounts']),
                'Orchestrator data mount differs')
        origin = env.get('BETTER_AUTH_URL', '')
        parsed = urlsplit(origin)
        require(parsed.scheme in ('http', 'https') and parsed.netloc and not parsed.username
                and not parsed.password and parsed.path in ('', '/') and not parsed.query and not parsed.fragment,
                'BETTER_AUTH_URL is not an unambiguous origin')
        self.host, self.origin = parsed.netloc, origin.rstrip('/')
        auth_path = self.base / 'canary-input.private.json'
        auth_info = auth_path.lstat()
        require(stat.S_ISREG(auth_info.st_mode) and auth_info.st_uid == 0 and auth_info.st_mode & 0o077 == 0,
                'Session input must be a root-private regular file')
        self.cookie = read_json(auth_path)['sessionCookie']
        require(isinstance(self.cookie, str) and self.cookie and '\n' not in self.cookie and '\r' not in self.cookie,
                'Invalid session cookie')
        require(self.api('GET', f'/api/admin/workers/{self.id}/incus-migration') == {
            'kind': 'legacy-docker', 'phase': 'none', 'recoveryRequired': False, 'sourceRetained': False},
            'Migration API disagrees with raw preflight state')
        self.assert_no_compute()
        require(not command(['docker', 'ps', '-aq', '--filter', f'label=agentor.id={self.id}']).strip(),
                'Archived worker still has Docker compute')
        old_id = original.get('environmentId') or DEFAULT_ENV
        require(old_id in ENV_CLONES, 'Worker environment was not reviewed')
        environments = read_json(self.owner_dir / 'environments.json') + read_json(self.data / 'defaults/environments.json')
        def environment(identity):
            found = [e for e in environments if e.get('id') == identity]
            require(len(found) == 1, 'Environment identity is absent or duplicated')
            return found[0]
        old, clone = environment(old_id), environment(ENV_CLONES[old_id])
        validate_clone(old, clone)
        reference = original.get('imageRuntimeReference') or env.get('WORKER_IMAGE_PREFIX', '') + env.get('WORKER_IMAGE', 'agentor-worker:latest')
        image = command_json(['docker', 'image', 'inspect', reference])[0]
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', image['Id']) and image.get('Architecture') == 'amd64',
                'Original source image is unavailable or incompatible')
        if self.id in CUSTOM:
            require(image['Id'] == CUSTOM[self.id][2], 'Custom image content changed')
        managed = self.managed()
        validate_managed(managed)
        pool = self.incus('/1.0/storage-pools/' + POOL)
        require(pool.get('driver') == 'dir' and pool.get('config', {}).get('user.agentor.installation') == INSTALLATION
                and pool['config'].get('source') == '/var/lib/incus/storage-pools/' + POOL,
                'Canonical volume sampling requires the exact reviewed dir pool')
        return {'record': original, 'environmentOriginal': old, 'environmentClone': clone,
                'sourceDockerImage': image['Id'], 'managed': managed}

    def preserved(self, before, *, archived=False):
        current = self.record()
        require(stable_record(current) == stable_record(before['record']), 'Worker settings changed outside lifecycle/environment fields')
        require(current.get('environmentId') == before['environmentClone']['id'], 'Environment clone was not preserved')
        if archived:
            require(current.get('status') == 'archived' and current.get('desiredRuntimeStatus') == 'stopped',
                    'Final archived/stopped intent was not persisted')
        require(current.get('runtimeKind') == 'incus-vm' and not current.get('incusRecreation')
                and not current.get('pendingRebuild'), 'Native worker has unfinished recreation/configuration')
        require(self.api('GET', f'/api/admin/workers/{self.id}/incus-migration') == {
            'kind': 'incus-vm', 'phase': 'retained', 'sourceRetained': True, 'recoveryRequired': False},
            'Migration retained-source status is incomplete')

    def docker_retained(self, snapshot):
        actual = command_json(['docker', 'inspect', snapshot['Id']])[0]
        require(source_identity(actual) == snapshot and actual['State'].get('Running') is False
                and not actual['State'].get('Paused') and not actual['State'].get('Restarting'),
                'Retained Docker identity, mounts, or stopped state changed')
        command_json(['docker', 'image', 'inspect', snapshot['Image']])
        for mount in snapshot['Mounts']:
            if mount.get('Type') == 'volume':
                command_json(['docker', 'volume', 'inspect', mount['Name']])

    def canonical(self, role):
        name = self.name + '-' + role
        volume = self.incus(f'/1.0/storage-pools/{POOL}/volumes/custom/{name}')
        config = volume['config']
        require(volume.get('name') == name and volume.get('type') == 'custom'
                and volume.get('content_type') == 'filesystem' and config.get('user.agentor.id') == self.id
                and config.get('user.agentor.owner') == OWNER and config.get('user.agentor.installation') == INSTALLATION
                and config.get('user.agentor.storage-role') == role, 'Canonical volume ownership changed')
        path = Path('/var/lib/incus/storage-pools') / POOL / 'custom' / (PROJECT + '_' + name)
        require(path.is_dir() and not path.is_symlink(), 'Canonical directory is unavailable')
        return volume, path

    def compare_samples(self, samples):
        checked = {}
        for role, sample in samples.items():
            volume, root = self.canonical(role)
            for expected in sample['files']:
                require(hash_regular(root, expected['path']) == expected, 'Canonical file sample differs from stopped Docker source')
            checked[role] = {'sampleCount': len(sample['files']), 'volume': volume}
        return checked

    def guest(self, script, *, timeout=180):
        return command(['incus', '--force-local', 'exec', self.name, '--project', PROJECT, '--user', '1000', '--group', '1000',
                        '--cwd', '/home/agent', '--env', 'HOME=/home/agent', '--mode', 'non-interactive', '--',
                        'python3', '-'], payload=script.encode(), timeout=timeout)

    def verify_native(self, before):
        instance = self.incus('/1.0/instances/' + self.name)
        config, devices = instance['config'], instance.get('expanded_devices', instance['devices'])
        require(instance.get('type') == 'virtual-machine' and config.get('user.agentor.id') == self.id
                and config.get('user.agentor.owner') == OWNER and config.get('user.agentor.installation') == INSTALLATION,
                'Native instance identity differs')
        require(config.get('image.source_image') == before['sourceDockerImage']
                and config.get('limits.memory') in ('4294967296', '4GiB'), 'Native image or 4 GiB allocation differs')
        require(all(d.get('type') in ('disk', 'nic') for d in devices.values()), 'Unexpected native hardware/device type')
        for role, target in [('workspace', '/workspace'), ('agents', '/home/agent/.agent-data')]:
            require(devices.get(role) == {'type': 'disk', 'pool': POOL, 'source': self.name + '-' + role, 'path': target},
                    'Native canonical device differs')
        managed = self.managed()
        require({(v['id'], v['target'], v['attached']) for v in managed} ==
                {(v['id'], v['target'], v['attached']) for v in before['managed']}, 'Managed path selection changed')
        expected_targets = {'/workspace', '/home/agent/.agent-data', '/', '/run/agentor/account-credentials',
                            '/home/agent/.agent-data/.kilo/config', '/home/agent/.agent-data/.kilo/shared-data'}
        for volume in managed:
            require(volume.get('storageRuntimeKind') == 'incus-vm', 'Managed volume backend did not migrate')
            if volume['attached']:
                expected = {'type': 'disk', 'pool': POOL, 'source': volume['dockerName'], 'path': volume['target']}
                require(expected in devices.values(), 'Managed volume mount missing')
                expected_targets.add(volume['target'])
        # Account shares are allowed only from this owner's exact persisted directories.
        shares = {'/run/agentor/account-credentials': 'credentials',
                  '/home/agent/.agent-data/.kilo/config': 'kilo/config',
                  '/home/agent/.agent-data/.kilo/shared-data': 'kilo/data'}
        inherited = {m['Destination']: m for m in before.get('sourceHostMounts', [])
                     if m['Destination'].startswith('/workspace/.agentor/') and m['Source'].startswith('/srv/agentor/shared-skills/')}
        expected_targets.update(inherited)
        for device in devices.values():
            if device.get('type') != 'disk':
                continue
            require(device.get('path') in expected_targets or device.get('path') is None and device.get('pool') == POOL,
                    'Unreviewed native host mount')
            if device.get('path') in shares:
                require(device.get('source') == str(self.owner_dir / shares[device['path']]) and not device.get('pool'),
                        'Account share source differs')
            elif device.get('path') in inherited:
                source = inherited[device['path']]
                require(device.get('source') == source['Source'] and not device.get('pool')
                        and device.get('readonly', 'false') == ('false' if source['RW'] else 'true'),
                        'Inherited shared-skills mount differs from captured source')
        deadline = time.monotonic() + 600
        readiness = "import pathlib,subprocess; assert not pathlib.Path('/home/agent/.agent-data/.incus-migration-home/manifest.json').exists(); mem=int(next(x.split()[1] for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemTotal:'))); assert 3500000 <= mem <= 4194304; subprocess.run(['systemctl','is-active','--quiet','agentor-worker'],check=True)"
        while True:
            try:
                self.guest(readiness, timeout=30)
                break
            except (Refusal, subprocess.TimeoutExpired):
                require(time.monotonic() < deadline, 'Guest agent/service did not become ready within ten minutes')
                time.sleep(5)
        self.receipt('guest-verification-request', {'uid': 1000, 'script': 'verify-worker-guest.py'})
        result = json.loads(self.guest(Path(__file__).with_name('verify-worker-guest.py').read_text(), timeout=300))
        require(not result.get('homeRestore') and result.get('packages') == [] and not result['guestKernel'].startswith('6.8.')
                and re.match(r'^(?:6\.(?:1[1-9]|[2-9][0-9])|[7-9]\.)', result['guestKernel']),
                'Unexpected home restoration/packages or pre-HWE kernel')
        self.receipt('guest-verification-response', {'result': result, 'instance': instance})
        proxies = {}
        for path in (f'/editor/{self.id}/?folder=/workspace', f'/desktop/{self.id}/agentor.html'):
            proxies[path] = self.api('GET', path, html=True)
        return {'instance': instance, 'guest': result, 'proxies': proxies}

    def execute(self, before):
        require(not list(self.base.glob(f'migration-{self.id}.*')), 'Existing receipt makes rerun ambiguous')
        self.receipt('before', before)
        self.executing = True
        try:
            require(self.record() == before['record'], 'Worker changed since preflight')
            result = self.mutate('unarchive', 'POST', f'/api/archived/{self.id}/unarchive', {})
            cid = result.get('containerId', '')
            require(re.fullmatch(r'[a-f0-9]{64}', cid), 'Unarchive did not return an exact Docker ID')
            require(result.get('id') == self.id and result.get('userId') == OWNER, 'Unarchive returned another worker')
            created = command_json(['docker', 'inspect', cid])[0]
            require(created['Config']['Labels'].get('agentor.id') == self.id and created['Image'] == before['sourceDockerImage'],
                    'Unarchived Docker source identity/image differs')
            require(not created['HostConfig'].get('Devices') and not created['HostConfig'].get('DeviceRequests'),
                    'Unexpected Docker hardware assignment')
            self.mutate('environment', 'PATCH', f'/api/containers/{self.id}', {'environmentId': before['environmentClone']['id']})
            self.mutate('stop-source', 'POST', f'/api/containers/{self.id}/stop', {})
            stopped = command_json(['docker', 'inspect', cid])[0]
            snapshot = source_identity(stopped)
            self.docker_retained(snapshot)
            samples = {}
            for role, target in [('workspace', '/workspace'), ('agents', '/home/agent/.agent-data')]:
                mounts = [m for m in stopped['Mounts'] if m.get('Destination') == target]
                require(len(mounts) == 1 and mounts[0]['Type'] == 'volume', 'Expected exact Docker canonical named volume')
                mount = mounts[0]
                volume = command_json(['docker', 'volume', 'inspect', mount['Name']])[0]
                require(volume['Mountpoint'] == mount['Source'] and volume['Driver'] == 'local'
                        and not volume.get('Options'), 'Docker canonical volume differs')
                samples[role] = sample_files(Path(mount['Source']))
            # Every user host mount must have appeared in the reviewed Docker
            # source; account shares are compared separately after migration.
            before['sourceHostMounts'] = [m for m in stopped['Mounts'] if m.get('Type') == 'bind']
            self.receipt('source-stopped', {'docker': snapshot, 'samples': samples, 'record': self.record()})
            migrated = self.mutate('migrate', 'POST', f'/api/admin/workers/{self.id}/incus-migration', {})
            require(migrated == {'kind': 'incus-vm', 'phase': 'retained', 'sourceRetained': True, 'recoveryRequired': False},
                    'Migration did not reach retained state')
            self.docker_retained(snapshot)
            require(self.record()['incusMigration']['source'] == {'containerId': cid, 'createdAt': snapshot['Created'],
                    'imageId': snapshot['Image'], 'wasRunning': False}, 'Migration source receipt differs')
            self.mutate('rebuild', 'POST', f'/api/containers/{self.id}/rebuild', {})
            self.preserved(before)
            verification = self.verify_native(before)
            verification['samples'] = self.compare_samples(samples)
            self.docker_retained(snapshot)
            self.receipt('verified-before-archive', verification)
            self.mutate('archive', 'POST', f'/api/containers/{self.id}/archive', {})
            self.preserved(before, archived=True)
            self.assert_no_compute()
            self.docker_retained(snapshot)
            evidence = self.compare_samples(samples)
            for item in evidence.values():
                require(item['volume'].get('used_by') == [], 'Archived canonical volume is still attached')
            for v in self.managed():
                volume = self.incus(f'/1.0/storage-pools/{POOL}/volumes/custom/{v["dockerName"]}')
                require(volume.get('config', {}).get('user.agentor.volume-id') == v['id'] and volume.get('used_by') == [],
                        'Archived managed volume retention is ambiguous')
            self.receipt('complete', {'record': self.record(), 'canonical': evidence, 'retainedDocker': snapshot,
                                     'status': 'archived-native-source-retained', 'samplingIsNotFullVerification': True})
        except BaseException as error:
            self.receipt('error', {'errorType': type(error).__name__,
                         'reason': str(error) if isinstance(error, Refusal) else 'Unexpected failure; inspect private receipts and resource state',
                         'automaticRecovery': False})
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', required=True, choices=sorted(ALLOW))
    parser.add_argument('--execute', action='store_true', help='Perform the reviewed single-worker lifecycle; otherwise preflight only')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Run as root to read exact inventory and write root-private receipts')
    # One operator invocation at a time. This does not claim to fence external administrators.
    lock = os.open(BASE / '.archived-migration.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        migration = Migration(args.worker)
        before = migration.preflight()
        if args.execute:
            migration.execute(before)
        print(json.dumps({'workerId': args.worker, 'status': 'complete' if args.execute else 'preflight-only',
                          'mutationsPerformed': args.execute}))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'status': 'stopped', 'errorType': type(error).__name__,
                          'reason': str(error) if isinstance(error, Refusal) else 'Inspect private receipts; no automatic retry'}))
        raise SystemExit(1)
