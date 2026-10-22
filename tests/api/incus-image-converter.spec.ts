import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { IncusClient, IncusError, type IncusInstance, type IncusInstanceCreateSpec } from '../../orchestrator/server/utils/incus-client';
import { IncusImageConverter, readCanonicalIncusBootstrap, incusConversionRecipeId,
  type IncusImageConverterReceipt, type IncusImageConversionInput } from '../../orchestrator/server/utils/incus-image-converter';

const sourceId = 'sha256:' + 'a'.repeat(64), seed = 'b'.repeat(64);
type ConverterDocker = ConstructorParameters<typeof IncusImageConverter>[2];
const names = ['scripts/build-incus-worker-image.sh', 'worker/entrypoint.sh',
  ...['99-incus-agent.rules', 'Dockerfile.vm', 'agentor-dnsmasq.service', 'agentor-docker-storage.service',
    'agentor-docker-storage.sh', 'agentor-network.sh', 'agentor-private-storage.sh', 'agentor-worker.service',
    'incus-agent-setup', 'incus-agent.service'].map(name => 'worker/vm/' + name).sort()];
const repo = fileURLToPath(new URL('../../', import.meta.url));
async function packageAssets(directory: string) {
  await mkdir(join(directory, 'scripts'), { recursive: true }); await mkdir(join(directory, 'worker/vm'), { recursive: true });
  const files = [];
  for (const name of names) {
    const bytes = await readFile(join(repo, name)), stat = await lstat(join(repo, name)), mode = stat.mode & 0o777;
    await writeFile(join(directory, name), bytes, { mode });
    files.push({ name, size: bytes.length, mode, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, files }));
}

async function fixture(run: (f: {
  converter: IncusImageConverter; input: IncusImageConversionInput; directory: string; assets: string;
  events: string[]; receipts: IncusImageConverterReceipt[]; commands: string[][];
  client: IncusClient; execTimeouts: Array<number | undefined>;
  fail: (at: string) => void; revoke: () => void;
}) => Promise<void>, converterPool?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-isolated-converter-')), assets = join(directory, 'assets');
  await packageAssets(assets);
  const jobId = randomUUID(), installationId = randomUUID(), incarnation = randomUUID();
  const events: string[] = [], receipts: IncusImageConverterReceipt[] = [], commands: string[][] = [];
  const execTimeouts: Array<number | undefined> = [];
  let instance: IncusInstance | undefined, failure: string | undefined, revoked = false;
  const expectedPool = converterPool || 'images';
  const client = new IncusClient({ endpoint: 'https://fixture.invalid', project: 'agentor-images' });
  client.getImage = async fingerprint => {
    events.push('seed'); return { fingerprint, type: 'virtual-machine', architecture: 'x86_64', size: 1024, aliases: [] };
  };
  client.request = async <T>(method: string, path: string): Promise<T> => {
    expect(method).toBe('GET'); expect(path).toBe('/1.0/storage-pools/' + encodeURIComponent(expectedPool) + '/resources');
    events.push('capacity');
    const space = failure === 'capacity-small' ? { total: 100 * 1024 ** 3, used: 84 * 1024 ** 3 }
      : failure === 'capacity-64-root' ? { total: 100 * 1024 ** 3, used: 40 * 1024 ** 3 }
      : failure === 'capacity-invalid' ? { total: 100, used: 101 }
      : failure === 'capacity-missing' ? undefined
      : { total: 100 * 1024 ** 3, used: 0 };
    return { space } as T;
  };
  client.createInstance = async (spec: IncusInstanceCreateSpec, accepted) => {
    events.push('create'); expect(receipts.at(-1)?.pending?.kind).toBe('create');
    expect(spec.profiles).toEqual([]); expect(Object.keys(spec.devices!)).toEqual(['root', 'eth0']);
    expect(spec.devices!.root).toEqual({ type: 'disk', path: '/', pool: expectedPool, size: '64GiB' });
    expect(spec.devices!.eth0).toMatchObject({ 'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' });
    expect(spec.config!['user.agentor.helper']).toBe('image-converter');
    expect(spec.config!['user.agentor.id']).toBeUndefined(); expect(spec.config!['user.agentor.worker']).toBeUndefined();
    expect(JSON.stringify(spec)).not.toMatch(/credentials|socket|account|environment|dataDir/);
    await accepted?.('/1.0/operations/' + randomUUID());
    instance = { name: spec.name, description: '', type: 'virtual-machine', status: 'Stopped', status_code: 102,
      architecture: 'x86_64', ephemeral: false, profiles: [], devices: structuredClone(spec.devices!),
      config: { ...spec.config!, 'volatile.uuid': incarnation, 'volatile.base_image': seed } };
    if (failure === 'create-observer') throw new IncusError('Lost accepted create observation');
    return structuredClone(instance);
  };
  client.startInstance = async (_name, accepted) => {
    events.push('start'); expect(receipts.at(-1)?.incarnation).toBe(incarnation); expect(receipts.at(-1)?.pending?.kind).toBe('start');
    await accepted?.('/1.0/operations/' + randomUUID());
    if (failure === 'start-observer') throw new IncusError('Lost accepted start observation');
    instance!.status = 'Running';
  };
  client.getInstance = async () => {
    events.push('inspect');
    if (!instance) throw new IncusError('Missing', 404);
    if (failure === 'foreign-uuid') instance.config['volatile.uuid'] = randomUUID();
    return structuredClone(instance);
  };
  client.stopInstance = async (_name, _options, accepted) => {
    events.push('stop'); await accepted?.('/1.0/operations/' + randomUUID());
    if (failure === 'stop-observer') throw new IncusError('Lost accepted stop observation');
    instance!.status = 'Stopped';
  };
  client.deleteInstance = async (_name, accepted) => {
    events.push('delete'); await accepted?.('/1.0/operations/' + randomUUID()); instance = undefined;
  };
  client.pushFile = async (_name, path, bytes, options) => {
    events.push('asset'); expect(path.startsWith('/root/agentor-convert/')).toBe(true);
    expect(Buffer.isBuffer(bytes)).toBe(true); expect(options).toMatchObject({ uid: 0, gid: 0 });
  };
  client.execStream = async (_name, command, options) => {
    execTimeouts.push(options?.timeoutMs);
    commands.push(command); expect(options?.environment && Object.keys(options.environment)).toEqual(command[0] === '/usr/bin/cat' ? undefined : ['PATH', 'LC_ALL']);
    if (command[0] === '/usr/bin/docker' && failure?.startsWith('stdin-')) {
      const stdout = new PassThrough(), stderr = new PassThrough(); stdout.resume();
      let resolve!: (code: number) => void, reject!: (error: Error) => void;
      const result = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
      const stdin = new Writable({ write(_chunk, _encoding, callback) {
        events.push('input-closed'); callback(new IncusError('Incus exec stdin closed', 502));
        if (failure === 'stdin-never') return;
        setTimeout(() => {
          stderr.end('docker load: guest diagnostic'); stdout.end(); events.push('guest-result');
          if (failure === 'stdin-transport') reject(new IncusError('Incus exec channel failed', 502));
          else resolve(failure === 'stdin-zero' ? 0 : 1);
        }, 25);
      } });
      return { stdin, stdout, stderr, operationId: randomUUID(), sendSignal() {}, result,
        close() { events.push('exec-close'); reject(new Error('Session closed before guest observation')); stdout.destroy(); stderr.destroy(); } };
    }
    const stdin = new PassThrough(); stdin.resume(); const stdout = new PassThrough(), stderr = new PassThrough();
    stdout.end(command[0] === '/usr/bin/cat' ? Buffer.alloc(65536) : Buffer.alloc(0));
    const identityFailure = command[2]?.includes('actual=$(docker image inspect') && failure === 'OCI-identity';
    stderr.end(command[0] === '/usr/bin/docker' && failure === 'docker-load' ? Buffer.alloc(20_000, 65)
      : identityFailure ? Buffer.from('Loaded immutable source ID is missing') : Buffer.alloc(0));
    if (command[0] === '/usr/bin/docker' && failure === 'revoke') revoked = true;
    return { stdin, stdout, stderr, operationId: randomUUID(), sendSignal() {}, close() {},
      result: Promise.resolve(identityFailure || command[0] === '/usr/bin/docker' && failure === 'docker-load' ? 1 : 0) };
  };
  const docker = { getImage: (id: string) => {
    expect(id).toBe(sourceId);
    return { inspect: async () => ({ Id: failure === 'source-id' ? 'sha256:' + 'c'.repeat(64) : sourceId,
      Architecture: 'amd64', Size: failure === 'source-size' ? Number.NaN : failure === 'source-budget' ? Number.MAX_SAFE_INTEGER : 1024 ** 2 }), get: async () => { events.push('export'); return Readable.from([Buffer.from('opaque OCI archive')]); } } as unknown as ReturnType<ConverterDocker['getImage']>;
  } } as ConverterDocker;
  const input: IncusImageConversionInput = { jobId, ownerId: 'converter-owner', installationId, sourceImageId: sourceId, seedFingerprint: seed,
    validateAuthority: async () => { if (revoked) throw new Error('Source permission revoked'); },
    acknowledge: async receipt => {
      receipts.push(structuredClone(receipt)); events.push('ack:' + (receipt.pending?.kind ?? (receipt.removed ? 'removed' : 'settled')));
    } };
  const converter = new IncusImageConverter({ dataDir: directory, incusStoragePool: 'images',
    incusConverterStoragePool: converterPool, incusNetwork: 'image-network' }, client, docker, assets);
  try { await run({ converter, input, directory, assets, events, receipts, commands, client, execTimeouts,
    fail: at => { failure = at; }, revoke: () => { revoked = true; } }); }
  finally { client.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test('operator-selected converter pool affects only disposable root and capacity checks, not canonical worker storage', async () => {
  await fixture(async f => {
    f.fail('docker-load');
    await expect(f.converter.convert(f.input)).rejects.toThrow('OCI-load');
    expect(f.events).toContain('capacity'); expect(f.events).toContain('create');
    expect(f.receipts.at(-1)?.removed).toBe(true);
  }, 'scratch-images');
});

test('canonical packaged assets and recipe use exact immutable source/hash/order and reject traversal or changed bytes before VM allocation', async () => {
  await fixture(async f => {
    const files = await readCanonicalIncusBootstrap(f.assets);
    expect(files.map(file => file.name)).toEqual(names);
    const expected = createHash('sha256').update(sourceId + '\namd64\n3\nv0.4.0\n10G\n' +
      files.map(file => file.sha256 + '  ' + file.name + '\n').join('')).digest('hex');
    expect(incusConversionRecipeId(sourceId, files)).toBe(expected);
    await writeFile(join(f.assets, 'worker/entrypoint.sh'), 'changed canonical asset');
    await expect(f.converter.convert(f.input)).rejects.toThrow('asset changed'); expect(f.events).toEqual([]);
  });
  await fixture(async f => {
    const manifest = JSON.parse(await readFile(join(f.assets, 'manifest.json'), 'utf8'));
    manifest.files[0].name = '../outside'; await writeFile(join(f.assets, 'manifest.json'), JSON.stringify(manifest));
    await expect(f.converter.convert(f.input)).rejects.toThrow('fixed asset set'); expect(f.events).toEqual([]);
  });
});

test('invalid job, revoked source permission and mismatched actual OCI identity fail before native allocation', async () => {
  await fixture(async f => {
    await expect(f.converter.convert({ ...f.input, jobId: '../not-a-job' })).rejects.toThrow('fixed authorized'); expect(f.events).toEqual([]);
    f.revoke(); await expect(f.converter.convert(f.input)).rejects.toThrow('permission revoked'); expect(f.events).toEqual([]);
  });
  await fixture(async f => { f.fail('source-id'); await expect(f.converter.convert(f.input)).rejects.toThrow('OCI identity'); expect(f.events).toEqual([]); });
  await fixture(async f => { f.fail('source-size'); await expect(f.converter.convert(f.input)).rejects.toThrow('OCI identity'); expect(f.events).toEqual([]); });
  await fixture(async f => { f.fail('source-budget'); await expect(f.converter.convert(f.input)).rejects.toThrow('required guest capacity'); expect(f.events).toEqual([]); });
});

test('canonical asset intermediate directories cannot redirect packaged bytes outside the controlled root', async () => {
  for (const name of ['scripts', 'worker', 'worker/vm']) await fixture(async f => {
    const path = join(f.assets, name), outside = join(f.directory, 'outside');
    await mkdir(outside); await rm(path, { recursive: true, force: true }); await symlink(outside, path);
    await expect(f.converter.convert(f.input)).rejects.toThrow('asset directory is not confined');
    expect(f.events).toEqual([]); expect(f.receipts).toEqual([]);
  });
});

test('insufficient or malformed physical pool capacity fails before VM allocation, scratch creation or acknowledgements', async () => {
  for (const mode of ['capacity-small', 'capacity-64-root', 'capacity-invalid', 'capacity-missing']) await fixture(async f => {
    f.fail(mode);
    await expect(f.converter.convert(f.input)).rejects.toThrow(/pool (has|capacity)/);
    expect(f.events).toEqual(['seed', 'capacity']); expect(f.receipts).toEqual([]);
    await expect(lstat(join(f.directory, 'incus-image-converters'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('converter temporary root rejects symlink or nonprivate directory before native allocation', async () => {
  for (const unsafe of ['symlink', 'public']) await fixture(async f => {
    if (unsafe === 'symlink') { const outside = join(f.directory, 'outside'); await mkdir(outside); await symlink(outside, join(f.directory, 'incus-image-converters')); }
    else await mkdir(join(f.directory, 'incus-image-converters'), { mode: 0o755 });
    await expect(f.converter.convert(f.input)).rejects.toThrow('private owned real directory');
    expect(f.events).not.toContain('create'); expect(f.receipts).toEqual([]);
  });
});

test('converter keeps its private scratch separate from the existing shared backup temporary directory', async () => {
  await fixture(async f => {
    const shared = join(f.directory, 'tmp');
    await mkdir(shared, { mode: 0o755 });
    await writeFile(join(shared, 'backup-sentinel'), 'existing backup data');
    const before = await lstat(shared);
    f.fail('docker-load');
    await expect(f.converter.convert(f.input)).rejects.toThrow('OCI-load');
    expect(f.events).toContain('create');
    expect(f.receipts.at(-1)?.removed).toBe(true);
    expect((await lstat(join(f.directory, 'incus-image-converters'))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(f.directory, 'incus-image-converters', 'incus-image-' + f.input.jobId))).mode & 0o777).toBe(0o700);
    const after = await lstat(shared);
    expect([after.ino, after.uid, after.gid, after.mode]).toEqual([before.ino, before.uid, before.gid, before.mode]);
    expect(await readFile(join(shared, 'backup-sentinel'), 'utf8')).toBe('existing backup data');
  });
});

test('guest command diagnostics retain a fixed phase/exit code and bounded stderr, not an unbounded guest report', async () => {
  await fixture(async f => {
    f.fail('docker-load');
    let failure: Error | undefined;
    try { await f.converter.convert(f.input); } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('OCI-load failed (exit 1)');
    expect(Buffer.byteLength(failure!.message)).toBeLessThan(8400);
    expect(f.receipts.at(-1)?.removed).toBe(true);
  });
});

test('early closed OCI stdin preserves the later guest exit and stderr before exact converter cleanup', async () => {
  await fixture(async f => {
    f.fail('stdin-exit');
    await expect(f.converter.convert(f.input)).rejects.toThrow('OCI-load failed (exit 1): docker load: guest diagnostic');
    expect(f.events.indexOf('input-closed')).toBeLessThan(f.events.indexOf('guest-result'));
    expect(f.events.indexOf('guest-result')).toBeLessThan(f.events.indexOf('exec-close'));
    expect(f.events.indexOf('exec-close')).toBeLessThan(f.events.indexOf('stop'));
    expect(f.receipts.at(-1)?.removed).toBe(true);
    expect(f.commands.some(command => command[2]?.includes('actual=$(docker image inspect'))).toBe(false);
  });
});

test('a failed OCI transfer remains a failure even with guest exit zero or a lost exec result', async () => {
  for (const mode of ['stdin-zero', 'stdin-transport']) await fixture(async f => {
    f.fail(mode);
    await expect(f.converter.convert(f.input)).rejects.toThrow(mode === 'stdin-zero'
      ? 'OCI-load stream failed (guest exit 0): Incus exec stdin closed; docker load: guest diagnostic'
      : 'OCI-load stream failed: Incus exec stdin closed; docker load: guest diagnostic');
    expect(f.events.indexOf('guest-result')).toBeLessThan(f.events.indexOf('exec-close'));
    expect(f.receipts.at(-1)?.removed).toBe(true);
    expect(f.commands.filter(command => command[0] === '/usr/bin/docker')).toHaveLength(1);
  });
});

test('missing OCI exec result is bounded and cancellation interrupts the diagnostic wait', async () => {
  for (const cancel of [false, true]) await fixture(async f => {
    f.fail('stdin-never'); const controller = new AbortController();
    const started = Date.now();
    const pending = f.converter.convert({ ...f.input, signal: controller.signal });
    const cancellation = cancel ? setInterval(() => {
      if (f.events.includes('input-closed')) controller.abort(new Error('Test cancellation'));
    }, 5) : undefined;
    try { await expect(pending).rejects.toThrow(cancel ? 'Test cancellation' : 'OCI-load stream failed: Incus exec stdin closed'); }
    finally { clearInterval(cancellation); }
    expect(Date.now() - started).toBeLessThan(cancel ? 2000 : 15_000);
    expect(f.events).not.toContain('guest-result'); expect(f.events).toContain('exec-close');
    expect(f.receipts.at(-1)?.removed).toBe(true);
  });
});

test('stalled readiness probe uses remaining budget and settles cancellation before exact cleanup', async () => {
  for (const cancel of [false, true]) await fixture(async f => {
    const originalNow = Date.now, getInstance = f.client.getInstance.bind(f.client), start = f.client.startInstance.bind(f.client);
    const exec = f.client.execStream.bind(f.client), controller = new AbortController();
    let offset = 0, started = false, shifted = false, cancellation: ReturnType<typeof setTimeout> | undefined;
    f.client.startInstance = async (...args) => { await start(...args); started = true; };
    f.client.getInstance = async (...args) => {
      const current = await getInstance(...args);
      if (started && !shifted) { shifted = true; offset = 119_900; }
      return current;
    };
    f.client.execStream = async (...args) => {
      const session = await exec(...args);
      expect(args[1]).toEqual(['true']);
      const signal = args[2]!.signal!;
      session.result = new Promise<number>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          f.events.push('ready-aborted');
          setTimeout(() => { f.events.push('ready-settled'); reject(new Error('Probe cancelled')); }, 10);
        }, { once: true });
      });
      session.close = () => { f.events.push('ready-closed'); };
      if (cancel) cancellation = setTimeout(() => controller.abort(new Error('Readiness cancelled')), 5);
      return session;
    };
    try {
      Date.now = () => originalNow() + offset;
      await expect(f.converter.convert({ ...f.input, signal: controller.signal })).rejects.toThrow(cancel ? 'Readiness cancelled' : 'guest agent did not become ready');
    } finally { Date.now = originalNow; clearTimeout(cancellation); }
    expect(f.execTimeouts).toHaveLength(1);
    expect(f.execTimeouts[0]).toBeGreaterThan(0); expect(f.execTimeouts[0]).toBeLessThanOrEqual(100);
    expect(f.events.indexOf('ready-aborted')).toBeLessThan(f.events.indexOf('ready-settled'));
    expect(f.events.indexOf('ready-settled')).toBeLessThan(f.events.indexOf('ready-closed'));
    expect(f.events.indexOf('ready-closed')).toBeLessThan(f.events.indexOf('stop'));
    expect(f.receipts.at(-1)?.removed).toBe(true);
  });
});

test('readiness expiry avoids another probe and retry delay is abortable within its remaining budget', async () => {
  for (const outcome of ['expired', 'sleep-expiry', 'sleep-abort']) await fixture(async f => {
    const originalNow = Date.now, getInstance = f.client.getInstance.bind(f.client), start = f.client.startInstance.bind(f.client);
    const exec = f.client.execStream.bind(f.client), controller = new AbortController();
    let started = false, offset = 0, shifted = false, cancellation: ReturnType<typeof setTimeout> | undefined;
    f.client.startInstance = async (...args) => { await start(...args); started = true; };
    f.client.getInstance = async (...args) => {
      const current = await getInstance(...args);
      if (started && !shifted) { shifted = true; offset = outcome === 'expired' ? 120_001 : 119_950; }
      return current;
    };
    f.client.execStream = async (...args) => {
      await exec(...args);
      if (outcome === 'sleep-abort') cancellation = setTimeout(() => controller.abort(), 5);
      throw new Error('Guest agent unavailable');
    };
    const began = originalNow();
    try {
      Date.now = () => originalNow() + offset;
      await expect(f.converter.convert({ ...f.input, signal: controller.signal })).rejects.toThrow(outcome === 'sleep-abort' ? /abort/i : 'guest agent did not become ready');
    } finally { Date.now = originalNow; clearTimeout(cancellation); }
    expect(originalNow() - began).toBeLessThan(400);
    expect(f.execTimeouts).toHaveLength(outcome === 'expired' ? 0 : 1);
    expect(f.receipts.at(-1)?.removed).toBe(true);
  });
});

test('unknown accepted create/start results retain exact private acknowledgement and never adopt/get/stop a guessed UUID', async () => {
  for (const phase of ['create', 'start']) await fixture(async f => {
    f.fail(phase + '-observer'); await expect(f.converter.convert(f.input)).rejects.toThrow('Lost accepted');
    expect(f.receipts.at(-1)?.pending).toMatchObject({ kind: phase, operation: expect.stringMatching(/^\/1.0\/operations\//) });
    expect(f.receipts.at(-1)?.removed).not.toBe(true); expect(f.events).not.toContain('stop'); expect(f.events).not.toContain('delete');
    if (phase === 'create') { expect(f.receipts.at(-1)?.incarnation).toBeUndefined(); expect(f.events).not.toContain('inspect'); }
  });
});

test('same-name foreign incarnation cannot be used or removed during isolated conversion', async () => {
  await fixture(async f => {
    f.fail('foreign-uuid'); await expect(f.converter.convert(f.input)).rejects.toThrow('cleanup is unconfirmed');
    expect(f.commands).toEqual([]); expect(f.events).not.toContain('stop'); expect(f.events).not.toContain('delete');
    expect(f.receipts.at(-1)?.incarnation).toBeTruthy(); expect(f.receipts.at(-1)?.removed).not.toBe(true);
  });
});

test('isolated guest tools/native Docker/OCI stream use fixed trust inputs and known guest failure removes only captured compute', async () => {
  for (const failure of ['docker-load', 'revoke']) await fixture(async f => {
    f.fail(failure); await expect(f.converter.convert(f.input)).rejects.toThrow();
    const setup = f.commands.find(command => command[0] === '/bin/bash' && command[1] === '-ec')![2]!;
    expect(setup).toContain('d2vm_v0.4.0_linux_amd64.tar.gz'); expect(setup).toContain('9f2096bc7850367d063cbcf2da8ded6c5a23e70a9b0ecfdde150b2fbc9b8bd2f');
    expect(setup).toContain('12a749cb96cada5a00bed759c120364ed92d1f38de67b557bb85ac67abd96ed8');
    expect(setup).toContain('/run/systemd/system/docker.service.d'); expect(setup).toContain('Requires=');
    expect(setup).toContain('/run/systemd/system/docker.service.d/zz-agentor-converter.conf');
    expect(setup).toContain("/usr/lib/agentor/agentor-network.sh full '[]'");
    expect(setup.indexOf('/usr/lib/agentor/agentor-network.sh')).toBeLessThan(setup.indexOf('apt-get update'));
    expect(setup).toContain('e2fsprogs parted kpartx cryptsetup');
    expect(setup).toContain('for tool in parted kpartx cryptsetup qemu-img sgdisk grub-install mkfs.ext4 mkfs.fat');
    expect(setup).toContain('"containerd-snapshotter":true'); expect(setup).toContain('io.containerd.snapshotter.v1');
    expect(setup).toContain('ExecStart=\\nExecStart=/usr/bin/dockerd --config-file=/run/agentor-converter-tools/docker-daemon.json');
    expect(setup).toContain('chmod 0600 /run/agentor-converter-tools/docker-daemon.json');
    expect(setup).not.toContain('storage-driver'); expect(setup).not.toContain('> /etc/docker/daemon.json');
    expect('zz-agentor-converter.conf' > 'storage.conf').toBe(true);
    expect(setup).toContain('docker_diagnostics'); expect(setup).toContain('--lines=40');
    expect(setup).toContain('cloud-guest-utils'); expect(setup).toContain("os.stat('/').st_dev!=st.st_rdev");
    expect(setup).toContain("sys+'/partition'"); expect(setup).toContain("len(disks)!=1"); expect(setup).toContain('64*1024**3');
    expect(setup).toContain("['growpart',before[1],str(before[2])]"); expect(setup).toContain("['resize2fs',after[0]]");
    expect(setup).toContain("p.stdout.startswith(b'NOCHANGE:')"); expect(setup).toContain('after[9]-after[7]-after[8]<=2048');
    // Checking executable availability is not formatting a device.
    expect(setup).not.toMatch(/(?:^|\n)\s*(?:mkfs(?:\.[A-Za-z0-9]+)?|e2fsck|wipefs)(?:\s|$)/);
    expect(setup).not.toContain('/dev/sdb');
    const growth = /python3 - <<'PY'\n([\s\S]*?)\nPY\n/.exec(setup)![1]!;
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.argv[1])', growth]); // Syntax preflight only; never execute host block operations.
    execFileSync('bash', ['-n'], { input: setup });
    const space = f.commands.find(command => command[1] === '-ec' && command[2]?.includes('df -B1'))!;
    expect(space).toBeTruthy(); expect(f.commands.indexOf(space)).toBeLessThan(f.commands.findIndex(command => command[0] === '/usr/bin/docker'));
    expect(f.events.filter(event => event === 'asset')).toHaveLength(12); expect(f.events).toContain('export');
    expect(f.commands.some(command => command[0] === '/usr/bin/docker' && command[1] === 'load')).toBe(true);
    expect(f.events).toContain('stop'); expect(f.events).toContain('delete'); expect(f.receipts.at(-1)?.removed).toBe(true);
  });
});

test('post-load immutable identity mismatch stops before conversion/pull/build and cleans only captured converter compute', async () => {
  await fixture(async f => {
    f.fail('OCI-identity'); await expect(f.converter.convert(f.input)).rejects.toThrow('OCI-identity failed');
    expect(f.commands.some(command => command.includes('/root/agentor-convert/scripts/build-incus-worker-image.sh'))).toBe(false);
    expect(f.commands.some(command => command[0] === '/usr/bin/cat')).toBe(false);
    expect(f.receipts.at(-1)?.removed).toBe(true);
  });
});

test('SAME raw-only bootstrap script produces no guest QCOW/metadata authority and short opaque RAW never publishes success', async () => {
  await fixture(async f => {
    await expect(f.converter.convert(f.input)).rejects.toThrow('RAW size');
    const conversion = f.commands.find(command => command.includes('/root/agentor-convert/scripts/build-incus-worker-image.sh'))!;
    expect(conversion.slice(0, 2)).toEqual(['/bin/bash', '-ec']);
    expect(conversion[2]).toContain('exit "$converter_exit"');
    expect(conversion[2]).toContain('df -B1 --output=source,size,avail,target /');
    expect(conversion[2]).toContain('dmesg --level=err,warn | tail -n 20');
    execFileSync('bash', ['-n'], { input: conversion[2] });
    expect(conversion).toContain('--raw-only'); expect(conversion).toContain('--expected-source-id'); expect(conversion).toContain('--expected-recipe-id');
    expect(conversion).not.toContain('--force'); expect(conversion).not.toContain('--alias');
    const loaded = f.commands.findIndex(command => command[0] === '/usr/bin/docker' && command[1] === 'load');
    const identity = f.commands.findIndex(command => command[2]?.includes("actual=$(docker image inspect"));
    expect(identity).toBeGreaterThan(loaded); expect(identity).toBeLessThan(f.commands.indexOf(conversion));
    expect(f.commands[identity]?.at(-1)).toBe(sourceId); expect(f.commands[identity]?.[2]).toContain('head -n 32');
    expect(f.commands[identity]?.[2]).not.toMatch(/docker pull|docker tag/);
    expect(f.commands.at(-1)).toEqual(['/usr/bin/cat', '/root/agentor-convert/output/disk.raw']);
    expect(f.execTimeouts[0]).toBeGreaterThan(0); expect(f.execTimeouts[0]).toBeLessThanOrEqual(120_000);
    expect(f.execTimeouts.slice(1, -1)).toEqual(Array(5).fill(45 * 60_000));
    expect(f.execTimeouts.at(-1)).toBe(30 * 60_000);
    expect(f.receipts.at(-1)?.removed).toBe(true);
    const raw = join(f.directory, 'incus-image-converters/incus-image-' + f.input.jobId + '/disk.raw');
    expect((await lstat(raw)).size).toBe(65536); expect((await lstat(raw)).mode & 0o777).toBe(0o600);
  });
});

function cleanupFixture(status = 'Stopped') {
  const receipt: IncusImageConverterReceipt = { version: 1, name: 'aic-' + randomUUID(), installationId: randomUUID(),
    ownerId: 'converter-owner', sourceImageId: sourceId, seedFingerprint: seed, project: 'agentor-images',
    recipeId: 'c'.repeat(64), incarnation: randomUUID() };
  const config = { dataDir: '/unused', incusStoragePool: 'images', incusNetwork: 'image-network' };
  const events: string[] = [], receipts: IncusImageConverterReceipt[] = [];
  let current: any = { name: receipt.name, type: 'virtual-machine', status, profiles: [],
    config: { 'user.agentor.installation': receipt.installationId, 'user.agentor.owner': receipt.ownerId,
      'user.agentor.helper': 'image-converter', 'user.agentor.operation': receipt.name.slice(4),
      'user.agentor.source-image': sourceId, 'user.agentor.seed-image': seed, 'security.secureboot': 'false',
      'boot.autostart': 'false', 'limits.cpu': '2', 'limits.memory': '4GiB', 'volatile.uuid': receipt.incarnation, 'volatile.base_image': seed },
    devices: { root: { type: 'disk', path: '/', pool: 'images', size: '64GiB' },
      eth0: { type: 'nic', name: 'eth0', network: 'image-network',
        'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' } } };
  const client = new IncusClient({ endpoint: 'https://fixture.invalid', project: receipt.project });
  client.getInstance = async name => { expect(name).toBe(receipt.name); events.push('inspect');
    if (!current) throw new IncusError('Missing', 404); return structuredClone(current); };
  client.stopInstance = async (name, _options, accepted) => { expect(name).toBe(receipt.name); events.push('stop');
    expect(receipts.at(-1)?.pending).toEqual({ kind: 'stop' }); await accepted?.('/1.0/operations/' + randomUUID()); current.status = 'Stopped'; };
  client.deleteInstance = async (name, accepted) => { expect(name).toBe(receipt.name); events.push('delete');
    expect(receipts.at(-1)?.pending).toEqual({ kind: 'delete' }); await accepted?.('/1.0/operations/' + randomUUID()); current = undefined; };
  const acknowledge = async (value: IncusImageConverterReceipt) => { receipts.push(structuredClone(value)); events.push('ack:' + (value.pending?.kind ?? (value.removed ? 'removed' : 'settled'))); };
  return { receipt, config, client, events, receipts, acknowledge, get current() { return current; },
    recover: (validate = async () => {}) => IncusImageConverter.cleanup(config, client, receipt, validate, acknowledge) };
}

for (const status of ['Stopped', 'Running']) test(`explicit converter recovery removes only the captured ${status} disposable VM`, async () => {
  const f = cleanupFixture(status);
  try { await f.recover(); expect(f.current).toBeUndefined(); expect(f.events.filter(value => value === 'stop')).toHaveLength(status === 'Running' ? 1 : 0);
    expect(f.events.filter(value => value === 'delete')).toHaveLength(1); expect(f.receipts.at(-1)).toEqual({ ...f.receipt, removed: true });
    expect(f.receipts.some(value => value.pending?.kind === 'delete' && value.pending.operation)).toBe(true);
  } finally { f.client.dispose(); }
});

test('converter recovery refuses missing incarnation, pending and foreign identity before mutations', async () => {
  for (const variant of ['incarnation', 'pending', 'removed', 'uuid', 'source', 'pool', 'profiles', 'raw', 'disk', 'expanded', 'status'] as const) {
    const f = cleanupFixture();
    try {
      if (variant === 'incarnation') delete f.receipt.incarnation;
      if (variant === 'pending') f.receipt.pending = { kind: 'delete', operation: '/1.0/operations/' + randomUUID() };
      if (variant === 'removed') f.receipt.removed = true;
      if (variant === 'uuid') f.current.config['volatile.uuid'] = randomUUID();
      if (variant === 'source') f.current.config['user.agentor.source-image'] = 'sha256:' + 'd'.repeat(64);
      if (variant === 'pool') f.current.devices.root.pool = 'foreign';
      if (variant === 'profiles') f.current.profiles = ['default'];
      if (variant === 'raw') f.current.config['raw.qemu'] = 'foreign';
      if (variant === 'disk') f.current.devices.source = { type: 'disk', source: '/host' };
      if (variant === 'expanded') f.current.expanded_devices = { ...f.current.devices, foreign: { type: 'nic', network: 'foreign' } };
      if (variant === 'status') f.current.status = 'Starting';
      await expect(f.recover()).rejects.toThrow(); expect(f.events).not.toContain('stop'); expect(f.events).not.toContain('delete'); expect(f.receipts).toEqual([]);
    } finally { f.client.dispose(); }
  }
});

test('converter recovery retains unknown accepted deletion and refuses replay even when VM disappeared', async () => {
  const f = cleanupFixture();
  try {
    const original = f.client.deleteInstance.bind(f.client);
    f.client.deleteInstance = async (...args) => { await original(...args); throw new IncusError('lost delete result'); };
    await expect(f.recover()).rejects.toThrow('lost delete result');
    const pending = f.receipts.at(-1)!; expect(pending.pending).toMatchObject({ kind: 'delete' }); expect(pending.removed).toBeUndefined();
    f.events.length = 0;
    await expect(IncusImageConverter.cleanup(f.config, f.client, pending, async () => {}, f.acknowledge)).rejects.toThrow('captured');
    expect(f.events).toEqual([]);
  } finally { f.client.dispose(); }
});

test('converter recovery acknowledges only typed settled absence and stops on authority or persistence failure', async () => {
  for (const variant of ['typed-absence', 'lookalike-absence', 'authority', 'write'] as const) {
    const f = cleanupFixture();
    try {
      if (variant.endsWith('absence')) f.client.getInstance = async () => { throw variant === 'typed-absence' ? new IncusError('Missing', 404) : Object.assign(Error('transport'), { statusCode: 404 }); };
      const operation = IncusImageConverter.cleanup(f.config, f.client, f.receipt,
        async () => { if (variant === 'authority') throw Error('authority changed'); },
        async value => { if (variant === 'write') throw Error('disk full'); await f.acknowledge(value); });
      if (variant === 'typed-absence') { await operation; expect(f.receipts.at(-1)?.removed).toBe(true); }
      else await expect(operation).rejects.toThrow();
      expect(f.events).not.toContain('stop'); expect(f.events).not.toContain('delete');
    } finally { f.client.dispose(); }
  }
});
