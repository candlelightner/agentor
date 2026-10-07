import type Docker from 'dockerode';
import { constants } from 'node:fs';
import { open, lstat, mkdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './config';
import { IncusClient, IncusRequestRejected, type IncusInstance, type IncusInstanceCreateSpec } from './incus-client';
import { assertSafeUserId } from './user-id';

/** Private acknowledgement in the EXISTING ImageBuild, never portable image
 * metadata or a second operation store. Pending authority survives uncertainty. */
export interface IncusImageConverterReceipt {
  version: 1; name: string; installationId: string; ownerId: string; sourceImageId: string;
  seedFingerprint: string; project: string; recipeId: string; incarnation?: string;
  pending?: { kind: 'create' | 'start' | 'stop' | 'delete'; operation?: string };
  removed?: true;
}
export interface IncusImageConversionInput {
  jobId: string; ownerId: string; installationId: string; sourceImageId: string; seedFingerprint: string;
  validateAuthority: () => Promise<void>;
  acknowledge: (receipt: Readonly<IncusImageConverterReceipt>) => Promise<void>;
  signal?: AbortSignal;
}
export interface CanonicalIncusBootstrapFile { name: string; mode: number; size: number; sha256: string; bytes: Buffer }
export interface IncusConvertedRaw {
  rawPath: string; rawBytes: number; rawIdentity: { dev: number; ino: number; size: number };
  sourceImageId: string; recipeId: string;
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const ASSETS = ['scripts/build-incus-worker-image.sh', 'worker/entrypoint.sh',
  ...['99-incus-agent.rules', 'Dockerfile.vm', 'agentor-dnsmasq.service', 'agentor-docker-storage.service',
    'agentor-docker-storage.sh', 'agentor-network.sh', 'agentor-private-storage.sh', 'agentor-worker.service',
    'incus-agent-setup', 'incus-agent.service'].map(name => 'worker/vm/' + name).sort()];
export const INCUS_CONVERSION_RAW_BYTES = 10 * 1024 ** 3 + 1024 ** 2;
// One bounded admission observation, not a reservation or capacity ledger.
// The isolated root can consume its full grant even when guest df has room.
export const INCUS_CONVERTER_POOL_HEADROOM_BYTES = (32 + 4) * 1024 ** 3;

/** Same canonical bytes/order used by build-incus-worker-image.sh; no guest
 * report, mutable tag, image property, or imported recipe grants authority. */
export function incusConversionRecipeId(sourceImageId: string, files: ReadonlyArray<Pick<CanonicalIncusBootstrapFile, 'name' | 'sha256'>>): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceImageId) || !isDeepStrictEqual(files.map(file => file.name), ASSETS) ||
      files.some(file => !HEX.test(file.sha256))) throw new Error('Invalid canonical Incus conversion inputs');
  return createHash('sha256').update(`${sourceImageId}\namd64\n3\nv0.4.0\n10G\n` +
    files.map(file => `${file.sha256}  ${file.name}\n`).join('')).digest('hex');
}

export async function readCanonicalIncusBootstrap(directory: string): Promise<CanonicalIncusBootstrapFile[]> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Canonical bootstrap package is not a safe directory');
  for (const name of ['scripts', 'worker', 'worker/vm']) {
    const nested = await lstat(join(directory, name));
    if (!nested.isDirectory() || nested.isSymbolicLink()) throw new Error('Canonical bootstrap asset directory is not confined');
  }
  const manifest = await open(join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let input: { version: number; files: Array<Omit<CanonicalIncusBootstrapFile, 'bytes'>> };
  try {
    const stat = await manifest.stat();
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('Canonical bootstrap manifest is invalid');
    input = JSON.parse(await manifest.readFile('utf8'));
  } finally { await manifest.close(); }
  if (input.version !== 1 || !Array.isArray(input.files) || !isDeepStrictEqual(input.files.map(file => file.name), ASSETS))
    throw new Error('Canonical bootstrap manifest does not identify the fixed asset set');
  const files: CanonicalIncusBootstrapFile[] = [];
  for (const expected of input.files) {
    if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > 1024 ** 2 ||
        !Number.isSafeInteger(expected.mode) || expected.mode < 0 || expected.mode > 0o777 || !HEX.test(expected.sha256))
      throw new Error('Canonical bootstrap asset identity is invalid');
    const file = await open(join(directory, expected.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== expected.size || (stat.mode & 0o777) !== expected.mode)
        throw new Error('Canonical bootstrap asset changed');
      const bytes = await file.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Canonical bootstrap asset hash changed');
      files.push({ ...expected, bytes });
    } finally { await file.close(); }
  }
  return files;
}

// Pinned release/archive AND measured executable identity, verified only in
// the disposable guest. No source/guest-selected downloader or installer.
const PREPARE_GUEST = String.raw`
set -euo pipefail
test ! -e /run/agentor/provisioned; test ! -e /run/agentor/worker.env
systemctl mask --runtime agentor-worker.service agentor-docker-storage.service
systemctl stop agentor-worker.service docker.service docker.socket containerd.service agentor-docker-storage.service
# Reuse the accepted VM networking primitive; never inherit Docker's embedded
# resolver in an unprovisioned converter or create a worker-ready marker.
/usr/lib/agentor/agentor-network.sh full '[]'
mkdir -p /run/systemd/system/docker.service.d
install -d -m 0700 /run/agentor-converter-tools
printf '{"features":{"containerd-snapshotter":true},"iptables":true,"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}\n' > /run/agentor-converter-tools/docker-daemon.json
chmod 0600 /run/agentor-converter-tools/docker-daemon.json
dockerd --validate --config-file=/run/agentor-converter-tools/docker-daemon.json
printf '[Unit]\nConditionPathExists=\nRequires=\n[Service]\nExecStartPre=\nExecStart=\nExecStart=/usr/bin/dockerd --config-file=/run/agentor-converter-tools/docker-daemon.json -H fd:// --containerd=/run/containerd/containerd.sock\n' > /run/systemd/system/docker.service.d/zz-agentor-converter.conf
systemctl daemon-reload
systemctl unmask --runtime docker.service docker.socket containerd.service
docker_diagnostics() {
 systemctl --no-pager show docker.service docker.socket containerd.service -p LoadState -p ActiveState -p SubState -p Result >&2 || true
 journalctl --boot --no-pager --lines=40 -u docker.service -u containerd.service >&2 || true
}
if ! systemctl start containerd.service docker.socket docker.service; then docker_diagnostics; exit 1; fi
if ! timeout 30 docker info >/dev/null; then docker_diagnostics; exit 1; fi
if ! docker info --format '{{json .DriverStatus}}' | python3 -c 'import json,sys; assert ["driver-type","io.containerd.snapshotter.v1"] in json.load(sys.stdin), "Converter requires native containerd image store for immutable source transfer"'; then docker_diagnostics; exit 1; fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends qemu-utils gdisk grub-efi-amd64-bin curl ca-certificates coreutils util-linux xz-utils dosfstools cloud-guest-utils e2fsprogs
# This guest has only its disposable 32GiB root disk. Resolve the currently
# mounted ext4 root via kernel identity, never an unused-device candidate.
python3 - <<'PY'
import json,os,stat,subprocess
def command(args):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 if p.returncode or len(p.stdout)>65536:
  raise ValueError('Converter root topology '+args[0]+' failed (exit '+str(p.returncode)+'): '+p.stderr[-2048:].decode(errors='replace'))
 return p.stdout.decode().strip()
def proof():
 source=command(['findmnt','--evaluate','-n','-o','SOURCE','--target','/'])
 if command(['findmnt','-n','-o','FSTYPE','--target','/'])!='ext4': raise ValueError('Converter root must be mounted ext4')
 device=os.path.realpath(source);st=os.stat(device)
 if not stat.S_ISBLK(st.st_mode) or os.stat('/').st_dev!=st.st_rdev: raise ValueError('Converter root block identity is ambiguous')
 sys=os.path.realpath('/sys/dev/block/'+str(os.major(st.st_rdev))+':'+str(os.minor(st.st_rdev)))
 with open(sys+'/partition') as f: number=int(f.read())
 parent_sys=os.path.dirname(sys);parent='/dev/'+os.path.basename(parent_sys);ps=os.stat(parent)
 with open(parent_sys+'/dev') as f: major,minor=map(int,f.read().strip().split(':'))
 if number<1 or not stat.S_ISBLK(ps.st_mode) or ps.st_rdev!=os.makedev(major,minor): raise ValueError('Converter root parent is ambiguous')
 disks=json.loads(command(['lsblk','--json','--bytes','--nodeps','-o','NAME,TYPE,SIZE']))['blockdevices']
 disks=[d for d in disks if d['type']=='disk']
 if len(disks)!=1 or disks[0]['name']!=os.path.basename(parent) or int(disks[0]['size'])!=32*1024**3:
  raise ValueError('Converter requires exactly its declared 32GiB root disk and no data disks')
 if command(['blkid','-p','-s','TYPE','-o','value',device])!='ext4': raise ValueError('Converter root signature is not ext4')
 uuid=command(['blkid','-p','-s','UUID','-o','value',device])
 with open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()
 with open(sys+'/start') as f: start=int(f.read())
 with open(sys+'/size') as f: size=int(f.read())
 with open(parent_sys+'/size') as f: sectors=int(f.read())
 return device,parent,number,st.st_rdev,ps.st_rdev,uuid,boot,start,size,sectors
before=proof()
p=subprocess.run(['growpart',before[1],str(before[2])],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
after=proof()
if before[:8]!=after[:8]: raise ValueError('Converter mounted-root identity changed during growth')
if p.returncode!=0 and not (p.returncode==1 and p.stdout.startswith(b'NOCHANGE:') and 0<=after[9]-after[7]-after[8]<=2048):
 raise ValueError('Converter growpart failed (exit '+str(p.returncode)+'): '+p.stderr[-2048:].decode(errors='replace'))
subprocess.run(['resize2fs',after[0]],check=True,timeout=120)
if proof()[:8]!=after[:8]: raise ValueError('Converter root identity changed during filesystem growth')
PY
install -d -m 0700 /run/agentor-converter-tools
curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 300 \
 -o /run/agentor-converter-tools/d2vm.tar.gz https://github.com/linka-cloud/d2vm/releases/download/v0.4.0/d2vm_v0.4.0_linux_amd64.tar.gz
printf '9f2096bc7850367d063cbcf2da8ded6c5a23e70a9b0ecfdde150b2fbc9b8bd2f  /run/agentor-converter-tools/d2vm.tar.gz\n' | sha256sum -c -
tar -xzf /run/agentor-converter-tools/d2vm.tar.gz -C /run/agentor-converter-tools d2vm
printf '12a749cb96cada5a00bed759c120364ed92d1f38de67b557bb85ac67abd96ed8  /run/agentor-converter-tools/d2vm\n' | sha256sum -c -
install -m 0755 /run/agentor-converter-tools/d2vm /usr/local/bin/d2vm
test "$(d2vm --version)" = 'd2vm version v0.4.0'
install -d -m 0700 /root/agentor-convert/scripts /root/agentor-convert/worker/vm /root/agentor-convert/output
`;

/** One isolated disposable converter, not a worker and never a host command
 * executor. Guest-controlled output is only opaque bounded RAW; normalization,
 * metadata construction/import/publication remain trusted parent operations. */
export class IncusImageConverter {
  constructor(private config: Pick<Config, 'dataDir' | 'incusStoragePool' | 'incusConverterStoragePool' | 'incusNetwork'>,
    private client: IncusClient, private docker: Pick<Docker, 'getImage'>, private bootstrapDirectory: string) {}

  async convert(input: IncusImageConversionInput): Promise<IncusConvertedRaw> {
    const request = { ...input };
    const pool = this.config.incusConverterStoragePool || this.config.incusStoragePool;
    if (!UUID.test(request.jobId) || !UUID.test(request.installationId) || !HEX.test(request.seedFingerprint) ||
        !/^sha256:[a-f0-9]{64}$/.test(request.sourceImageId) || assertSafeUserId(request.ownerId).length > 128 ||
        !this.config.dataDir || !this.config.incusStoragePool || !this.config.incusNetwork || this.client.project === 'default')
      throw new Error('Isolated Incus conversion requires a fixed authorized job/source/project');
    const active = async () => { request.signal?.throwIfAborted(); await request.validateAuthority(); request.signal?.throwIfAborted(); };
    await active();
    const files = await readCanonicalIncusBootstrap(this.bootstrapDirectory);
    const recipeId = incusConversionRecipeId(request.sourceImageId, files);
    const source = this.docker.getImage(request.sourceImageId), sourceInfo = await source.inspect();
    if (sourceInfo.Id !== request.sourceImageId || sourceInfo.Architecture !== 'amd64' || !Number.isSafeInteger(sourceInfo.Size) || sourceInfo.Size <= 0)
      throw new Error('Authorized converter source OCI identity/architecture changed');
    const required = INCUS_CONVERSION_RAW_BYTES + 2 * sourceInfo.Size + 1024 ** 3;
    if (!Number.isSafeInteger(required) || required <= 0) throw new Error('Converter required guest capacity is invalid');
    const seed = await this.client.getImage(request.seedFingerprint);
    if (seed.fingerprint !== request.seedFingerprint || seed.type !== 'virtual-machine') throw new Error('Trusted converter seed is unavailable');
    const resources = await this.client.request<{ space?: { total?: number; used?: number } }>('GET',
      '/1.0/storage-pools/' + encodeURIComponent(pool) + '/resources');
    const total = resources?.space?.total, used = resources?.space?.used;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(used) || total! <= 0 || used! < 0 || used! > total!)
      throw new Error('Incus converter pool capacity is unavailable or invalid; host readiness must be checked');
    const available = total! - used!;
    if (available < INCUS_CONVERTER_POOL_HEADROOM_BYTES)
      throw new Error(`Incus converter pool has ${available} bytes free; at least ${INCUS_CONVERTER_POOL_HEADROOM_BYTES} bytes are required before allocation. Add disposable scratch capacity or remove verified redundant artifacts.`);
    await active();
    let receipt: IncusImageConverterReceipt = { version: 1, name: 'aic-' + request.jobId,
      installationId: request.installationId, ownerId: request.ownerId, sourceImageId: request.sourceImageId,
      seedFingerprint: request.seedFingerprint, project: this.client.project, recipeId };
    const persist = async (value: IncusImageConverterReceipt) => { receipt = value; await request.acknowledge(structuredClone(value)); };
    const spec: IncusInstanceCreateSpec = { name: receipt.name, type: 'virtual-machine', profiles: [],
      source: { type: 'image', fingerprint: request.seedFingerprint },
      config: { 'user.agentor.installation': request.installationId, 'user.agentor.owner': request.ownerId,
        'user.agentor.helper': 'image-converter', 'user.agentor.operation': request.jobId,
        'user.agentor.source-image': request.sourceImageId, 'user.agentor.seed-image': request.seedFingerprint,
        'security.secureboot': 'false', 'boot.autostart': 'false', 'limits.cpu': '2', 'limits.memory': '4GiB' },
      devices: { root: { type: 'disk', path: '/', pool, size: '32GiB' },
        eth0: { type: 'nic', name: 'eth0', network: this.config.incusNetwork,
          'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' } } };
    const check = async (requireActive = true) => {
      if (requireActive) await active();
      if (!receipt.incarnation) throw new Error('Converter incarnation was not acknowledged; retain private job');
      const instance = await this.client.getInstance(receipt.name);
      const configMatches = (values: Record<string, string>) => Object.entries(spec.config!).every(([key, value]) => values[key] === value) &&
        Object.keys(values).every(key => key in spec.config! || key.startsWith('image.') || key.startsWith('volatile.')) &&
        values['volatile.uuid'] === receipt.incarnation && values['volatile.base_image'] === request.seedFingerprint;
      if (instance.name !== receipt.name || instance.type !== 'virtual-machine' || instance.profiles.length ||
          !isDeepStrictEqual(instance.devices, spec.devices) || !isDeepStrictEqual(instance.expanded_devices ?? instance.devices, spec.devices) ||
          !configMatches(instance.config) || !configMatches(instance.expanded_config ?? instance.config))
        throw new Error('Converter isolation/identity changed; retain private job');
      return instance;
    };
    const submit = async (kind: NonNullable<IncusImageConverterReceipt['pending']>['kind'],
      operation: (acknowledged: (path?: string) => Promise<void>) => Promise<unknown>) => {
      await persist({ ...receipt, pending: { kind } });
      try {
        await operation(async path => {
          if (path !== undefined && !/^\/1\.0\/operations\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path))
            throw new Error('Converter operation acknowledgement is invalid');
          await persist({ ...receipt, pending: path ? { kind, operation: path } : { kind } });
        });
      } catch (error) {
        if (error instanceof IncusRequestRejected && error.statusCode >= 400 && error.statusCode < 500 && error.errorCode === error.statusCode)
          await persist({ ...receipt, pending: undefined });
        throw error;
      }
      await persist({ ...receipt, pending: undefined });
    };
    const removeConverter = async () => {
      const current = await check(false);
      if (current.status === 'Running') await submit('stop', accepted => this.client.stopInstance(receipt.name, { force: true, timeout: 30 }, accepted));
      if ((await check(false)).status !== 'Stopped') throw new Error('Converter shutdown is not confirmed');
      await submit('delete', accepted => this.client.deleteInstance(receipt.name, accepted));
      try { await this.client.getInstance(receipt.name); throw new Error('Converter removal is not confirmed'); }
      catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      await persist({ ...receipt, removed: true });
    };
    const execute = async (phase: 'agent-ready' | 'guest-tools' | 'guest-space' | 'OCI-load' | 'OCI-identity' | 'raw-convert', command: string[], stream?: NodeJS.ReadableStream) => {
      await check();
      const session = await this.client.execStream(receipt.name, command, { command: [], user: 0, group: 0,
        cwd: '/', environment: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
        signal: request.signal, timeoutMs: 45 * 60_000 });
      session.stdout.resume(); let stderr = Buffer.alloc(0);
      session.stderr.on('data', (chunk: Buffer) => { stderr = chunk.length >= 8192 ? Buffer.from(chunk.subarray(-8192))
        : Buffer.concat([stderr, chunk]).subarray(-8192); });
      const exit = (code: number) => {
        if (code !== 0) throw new Error(`Isolated converter ${phase} failed (exit ${code}): ${stderr.toString('utf8')}`);
      };
      try {
        if (stream) await Promise.all([pipeline(stream, session.stdin, { signal: request.signal }), session.result.then(exit)]);
        else { session.stdin.end(); exit(await session.result); }
        await check();
      } finally { session.close(); }
    };
    const directory = join(this.config.dataDir, 'tmp', 'incus-image-' + request.jobId), rawPath = join(directory, 'disk.raw');
    const temporaryRoot = join(this.config.dataDir, 'tmp');
    await mkdir(temporaryRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const temporary = await lstat(temporaryRoot);
    if (!temporary.isDirectory() || temporary.isSymbolicLink() || temporary.uid !== process.getuid?.() || (temporary.mode & 0o077) !== 0)
      throw new Error('Converter temporary root is not a private owned real directory');
    await mkdir(directory, { mode: 0o700 });
    let raw: FileHandle | undefined;
    try {
      let created: IncusInstance | undefined;
      await submit('create', async accepted => {
        created = await this.client.createInstance(spec, accepted);
        const uuid = created.config['volatile.uuid'];
        if (!UUID.test(uuid ?? '')) throw new Error('Converter create omitted native incarnation');
        await persist({ ...receipt, incarnation: uuid });
      });
      await check(); await submit('start', accepted => this.client.startInstance(receipt.name, accepted));
      const deadline = Date.now() + 120_000; let ready = false;
      while (Date.now() < deadline) {
        const current = await check(); if (current.status !== 'Running') throw new Error('Converter is not running');
        try { await execute('agent-ready', ['true']); ready = true; break; } catch { await active(); }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error('Converter guest agent did not become ready');
      await execute('guest-tools', ['/bin/bash', '-ec', PREPARE_GUEST]);
      for (const file of files) {
        await check(); await this.client.pushFile(receipt.name, '/root/agentor-convert/' + file.name, file.bytes,
          { uid: 0, gid: 0, mode: file.mode }); await check();
      }
      // Root device enlargement alone does not grow the guest partition/FS.
      // A small conservative preflight is not permission to resize anything.
      await execute('guest-space', ['/bin/bash', '-ec', String.raw`
available=$(df -B1 --output=avail / | tail -n 1 | tr -d ' ')
case "$available" in ''|*[!0-9]*) echo 'Converter root free-space observation is invalid' >&2; exit 1;; esac
if [ "$available" -lt "$1" ]; then
 printf 'Converter guest root filesystem has %s bytes available; %s bytes required. Increasing the Incus root device alone does not grow the guest filesystem.\n' "$available" "$1" >&2
 exit 1
fi`, 'agentor-converter-space', String(required)]);
      await check();
      const exported = await source.get();
      try { await execute('OCI-load', ['/usr/bin/docker', 'load'], exported); }
      finally { if (exported instanceof Readable) exported.destroy(); }
      await execute('OCI-identity', ['/bin/bash', '-ec', String.raw`
diagnose_source() {
 docker info --format '{{json .DriverStatus}}' >&2 || true
 docker image ls --quiet --no-trunc | head -n 32 >&2 || true
}
if ! actual=$(docker image inspect --format '{{.Id}}' "$1"); then diagnose_source; exit 1; fi
if [ "$actual" != "$1" ]; then echo 'Loaded source OCI identity does not match the authorized immutable source' >&2; diagnose_source; exit 1; fi
`, 'agentor-converter-source', request.sourceImageId]);
      await execute('raw-convert', ['/bin/bash', '/root/agentor-convert/scripts/build-incus-worker-image.sh',
        '--source-image', request.sourceImageId, '--expected-source-id', request.sourceImageId, '--expected-recipe-id', recipeId,
        '--size', '10G', '--raw-only', '--output-dir', '/root/agentor-convert/output']);
      await check();
      raw = await open(rawPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const session = await this.client.execStream(receipt.name, ['/usr/bin/cat', '/root/agentor-convert/output/disk.raw'],
        { command: [], user: 0, group: 0, cwd: '/', signal: request.signal, timeoutMs: 30 * 60_000 });
      session.stdin.end(); session.stderr.resume();
      const dd = spawn('dd', ['bs=65536', 'iflag=fullblock', 'conv=sparse', 'status=none'], { stdio: ['pipe', raw.fd, 'pipe'] });
      dd.stderr?.resume();
      const written = new Promise<void>((resolve, reject) => { dd.on('error', reject);
        dd.on('exit', code => code === 0 ? resolve() : reject(new Error('Opaque RAW sparse reception failed'))); });
      void written.catch(() => {});
      let bytes = 0;
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length; callback(bytes > INCUS_CONVERSION_RAW_BYTES ? new Error('Converter RAW exceeds fixed bound') : null, chunk);
      } });
      try {
        await Promise.all([pipeline(session.stdout, bounded, dd.stdin!, { signal: request.signal }), written,
          session.result.then(code => { if (code !== 0) throw new Error('Converter RAW execution did not succeed'); })]);
      } finally { session.close(); if (dd.exitCode === null) dd.kill('SIGKILL'); await written.catch(() => {}); }
      await raw.sync(); const stat = await raw.stat();
      if (bytes !== INCUS_CONVERSION_RAW_BYTES || stat.size !== bytes) throw new Error('Converter RAW size is not the fixed conversion artifact');
      await check();
      await removeConverter(); await active();
      return { rawPath, rawBytes: bytes, rawIdentity: { dev: stat.dev, ino: stat.ino, size: stat.size }, sourceImageId: request.sourceImageId, recipeId };
    } catch (error) {
      // Known exec/stream failure can stop/remove only the captured isolated
      // guest. Unknown accepted native mutations/UUIDs remain quarantined.
      if (receipt.incarnation && !receipt.pending && !receipt.removed) {
        try { await removeConverter(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Isolated converter cleanup is unconfirmed; retain private ImageBuild', { cause: error }); }
      }
      throw error;
    } finally { await raw?.close(); }
  }
}
