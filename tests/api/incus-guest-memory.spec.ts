import { test, expect } from '@playwright/test';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { INCUS_GUEST_MEMORY_PROBE, parseGuestMemory, readIncusGuestMemory } from '../../orchestrator/server/utils/incus-guest-memory';
import { withOperationDeadline } from '../../orchestrator/server/utils/operation-deadline';
import { ContainerManager } from '../../orchestrator/server/utils/container';

const counters = { MemTotal: 10000, MemFree: 1000, Buffers: 200, Cached: 3000, SReclaimable: 500, Shmem: 400 };
function meminfo(patch: Partial<typeof counters> = {}) {
  return Object.entries({ ...counters, ...patch }).map(([key, value]) => `${key}: ${value} kB`).join('\n') + '\n';
}
function output(memory = meminfo(), arcstats?: string) { return JSON.stringify({ meminfo: memory, ...(arcstats === undefined ? {} : { arcstats }) }); }
function fixture() {
  let resolve!: (code: number) => void, reject!: (error: Error) => void, closed = 0;
  const result = new Promise<number>((done, fail) => { resolve = done; reject = fail; });
  result.catch(() => {});
  const session = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), result,
    close: () => {
      closed++;
      const error = new Error('Fixture session closed');
      for (const stream of [session.stdin, session.stdout, session.stderr]) stream.destroy(error);
      reject(error);
    } };
  for (const stream of [session.stdin, session.stdout, session.stderr]) stream.on('error', () => {});
  return { session, resolve, reject, closed: () => closed };
}
function finished(bytes = output(), code = 0, diagnostic = '') {
  const f = fixture(); f.session.stdout.end(bytes); f.session.stderr.end(diagnostic); f.resolve(code); return f;
}

test('htop numeric used includes shared memory and excludes buffers/cache/reclaimable, independent of MemAvailable', () => {
  expect(parseGuestMemory(output(meminfo() + 'MemAvailable: 123 kB\n'))).toEqual({ usedBytes: 5700 * 1024, totalBytes: 10000 * 1024 });
  expect(parseGuestMemory(output(meminfo() + 'MemAvailable: 9876 kB\nZswap: 123 kB\nZswapped: 456 kB\n'))).toEqual({ usedBytes: 5700 * 1024, totalBytes: 10000 * 1024 });
  expect(parseGuestMemory(output(meminfo({ MemFree: 0, Buffers: 0, Cached: 0, SReclaimable: 0, Shmem: 0 })))).toEqual({ usedBytes: 10000 * 1024, totalBytes: 10000 * 1024 });
});

test('htop fallback and guest ZFS ARC reclaimable size use the same KiB rounding', () => {
  expect(parseGuestMemory(output(meminfo({ Cached: 10000 })))).toMatchObject({ usedBytes: 9400 * 1024 });
  expect(parseGuestMemory(output(meminfo(), '13 1 0x01 2\nname type data\nsize 4 2048001\nc_min 4 512999\n'))).toMatchObject({ usedBytes: 4200 * 1024 });
  expect(parseGuestMemory(output(meminfo(), 'size 4 1024\nc_min 4 2048\n'))).toMatchObject({ usedBytes: 5700 * 1024 });
});

test('missing, duplicate, malformed, unsafe or impossible counters fail without inventing a zero reading', () => {
  for (const invalid of [
    '{', '{}', '[]', 'null', output(''), output(meminfo().replace('Shmem: 400 kB\n', '')),
    output(meminfo() + 'MemTotal: 1 kB\n'), output(meminfo().replace('MemTotal: 10000 kB', 'MemTotal: 10000 MB')),
    output(meminfo().replace('MemTotal: 10000 kB', 'MemTotal: NaN kB')),
    output(meminfo().replace('MemFree: 1000 kB', 'MemFree: -1 kB')),
    output(meminfo().replace('MemFree: 1000 kB', 'MemFree: 1.5 kB')),
    output(meminfo({ MemTotal: 0 })), output(meminfo({ Shmem: 10000 })),
    output(meminfo({ MemTotal: 100, MemFree: 110, Buffers: 0, Cached: 0, SReclaimable: 0, Shmem: 20 })),
    ...['MemFree', 'Buffers', 'Cached', 'SReclaimable', 'Shmem'].map(field => output(meminfo({ [field]: 10001 }))),
    output(meminfo().replace('MemTotal: 10000 kB', 'MemTotal: 9007199254740992 kB')),
    output(meminfo().replace('MemTotal: 10000 kB', 'MemTotal: 9007199254740 kB')),
    output('x'.repeat(16385)), output(meminfo(), ''), output(meminfo(), 'size 4 1024\n'),
    output(meminfo(), 'size 4 1024\nc_min 4 -1\n'), output(meminfo(), 'size 4 1024\nc_min 4 0\nsize 4 1024\n'),
    output(meminfo(), 'size 4 10000000\nc_min 4 0\n'), output(meminfo(), 'x'.repeat(16385)),
    JSON.stringify({ meminfo: meminfo(), arcstats: null }), JSON.stringify({ meminfo: meminfo(), extra: true }),
    ' '.repeat(65537),
  ]) expect(() => parseGuestMemory(invalid), invalid.slice(0, 120)).toThrow();
});

test('fixed Python probe reads only bounded kernel files and distinguishes absent ARC from unreadable or oversized files', () => {
  const harness = String.raw`
import builtins,io,json,sys
payload=json.load(sys.stdin);calls=[]
def read(path,*args,**kwargs):
    calls.append(path)
    assert path in ['/proc/meminfo','/proc/spl/kstat/zfs/arcstats']
    value=payload['files'].get(path,'missing')
    if value=='missing': raise FileNotFoundError(path)
    if value=='unreadable': raise PermissionError(path)
    return io.StringIO(value)
builtins.open=read
exec(compile(payload['probe'],'fixed-guest-memory-probe','exec'),{})
`;
  const probe = (files: Record<string, string>) => spawnSync('python3', ['-c', harness], {
    input: JSON.stringify({ probe: INCUS_GUEST_MEMORY_PROBE, files }), encoding: 'utf8', timeout: 5000,
  });
  const normal = probe({ '/proc/meminfo': meminfo() });
  expect(normal.status, normal.stderr).toBe(0);
  expect(parseGuestMemory(normal.stdout).usedBytes).toBe(5700 * 1024);
  for (const files of [
    { '/proc/meminfo': 'x'.repeat(16385) },
    { '/proc/meminfo': meminfo(), '/proc/spl/kstat/zfs/arcstats': 'unreadable' },
    { '/proc/meminfo': meminfo(), '/proc/spl/kstat/zfs/arcstats': 'x'.repeat(16385) },
  ]) expect(probe(files).status).toBe(1);
});

test('real Python probe waits for stdin EOF before reading counters or producing output', async () => {
  const harness = String.raw`
import builtins,io,sys
def read(path,*args,**kwargs):
    sys.stderr.write('kernel-read\n');sys.stderr.flush()
    if path=='/proc/meminfo': return io.StringIO(sys.argv[2])
    if path=='/proc/spl/kstat/zfs/arcstats': raise FileNotFoundError(path)
    raise ValueError('Unexpected counter path')
builtins.open=read
sys.stderr.write('ready\n');sys.stderr.flush()
exec(compile(sys.argv[1],'fixed-guest-memory-probe','exec'),{})
`;
  const child = spawn('python3', ['-c', harness, INCUS_GUEST_MEMORY_PROBE, meminfo()], { timeout: 5000, killSignal: 'SIGKILL' });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const closed = once(child, 'close');
  try {
    await Promise.race([once(child.stderr, 'data'), closed]);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(stderr).toBe('ready\n');
    expect(stdout).toBe('');
    expect(child.exitCode).toBeNull();
    child.stdin.end();
    const [code] = await closed;
    expect(code, stderr).toBe(0);
    expect(parseGuestMemory(stdout)).toEqual({ usedBytes: 5700 * 1024, totalBytes: 10000 * 1024 });
    expect(stderr).toBe('ready\nkernel-read\nkernel-read\n');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed;
  }
});

test('raw stream reads both output channels, verifies exit zero, and closes without provisioning', async () => {
  const f = finished(), calls: any[] = [];
  const client = { execStream: async (...args: any[]) => { calls.push(args); return f.session; } };
  const signal = new AbortController().signal;
  expect(await readIncusGuestMemory(client as any, 'fixed-name', signal)).toEqual({ usedBytes: 5700 * 1024, totalBytes: 10000 * 1024 });
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe('fixed-name');
  expect(calls[0][1]).toEqual(['/usr/bin/python3', '-c', INCUS_GUEST_MEMORY_PROBE]);
  expect(calls[0][2]).toMatchObject({ user: 0, group: 0, recordOutput: false, signal, timeoutMs: 5000 });
  expect(f.closed()).toBe(1);
});

test('nonzero exit, malformed output, and independently oversized stdout or stderr close and reject', async () => {
  for (const f of [finished(output(), 2), finished('{}'), finished('x'.repeat(65537)), finished(output(), 0, 'x'.repeat(1025))]) {
    await expect(readIncusGuestMemory({ execStream: async () => f.session } as any, 'fixture', new AbortController().signal)).rejects.toThrow();
    expect(f.closed()).toBeGreaterThan(0);
  }
});

test('stderr backpressure cannot block stdout collection and zero exit still requires both output EOFs', async () => {
  const f = fixture();
  f.session.stderr = new PassThrough({ highWaterMark: 1 });
  f.session.stderr.on('error', () => {});
  const producer = (async () => {
    if (!f.session.stderr.write('x'.repeat(1024))) await once(f.session.stderr, 'drain');
    f.session.stdout.end(output()); f.session.stderr.end(); f.resolve(0);
  })();
  expect(await withOperationDeadline(signal => readIncusGuestMemory({ execStream: async () => f.session } as any,
    'fixture', signal), 1000, 'Incus fixture sample')).toMatchObject({ usedBytes: 5700 * 1024 });
  await producer;
  const noEof = fixture(); noEof.resolve(0);
  await expect(withOperationDeadline(signal => readIncusGuestMemory({ execStream: async () => noEof.session } as any,
    'fixture', signal), 10, 'Incus fixture sample')).rejects.toMatchObject({ statusCode: 504 });
  expect(noEof.closed()).toBeGreaterThan(0);
});

test('whole-sample deadline aborts a blocked output and closes a session arriving after setup expiry', async () => {
  const blocked = fixture();
  await expect(withOperationDeadline(signal => readIncusGuestMemory({ execStream: async () => blocked.session } as any,
    'fixture', signal), 10, 'Incus fixture sample')).rejects.toMatchObject({ statusCode: 504 });
  expect(blocked.closed()).toBeGreaterThan(0);
  const late = fixture(); let setup!: (session: any) => void;
  const pending = new Promise<any>(resolve => { setup = resolve; });
  await expect(withOperationDeadline(signal => readIncusGuestMemory({ execStream: () => pending } as any,
    'fixture', signal), 10, 'Incus fixture sample')).rejects.toMatchObject({ statusCode: 504 });
  setup(late.session); await new Promise(resolve => setImmediate(resolve));
  expect(late.closed()).toBe(1);
});

test('an already cancelled sample never submits a guest command', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await expect(readIncusGuestMemory({ execStream: async () => { calls++; throw Error('Forbidden'); } } as any,
    'fixture', controller.signal)).rejects.toThrow();
  expect(calls).toBe(0);
});

for (const administrativeKind of ['platform', 'group']) test(`${administrativeKind} administrative telemetry reads guest memory with authority checks around the probe`, async () => {
  const manager = new ContainerManager({} as any, {} as any), f = finished();
  const state = { status: 'Running', processes: 4, memory: { usage: 999999, total: 2000000 } };
  (manager as any).containers.set('admin-fixture', { id: 'admin-fixture', containerName: 'fixed-admin', runtimeKind: 'incus-vm', administrativeKind });
  let validations = 0, changed = false;
  (manager as any).administrativeNativeTarget = () => ({
    validate: async () => {
      validations++;
      if (changed) throw Error('Administrative authority changed');
      return { instance: { config: { 'limits.cpu': '2' }, devices: { eth0: { hwaddr: '02:00:00:00:00:01' } } } };
    },
    native: { client: { getInstanceState: async () => state, execStream: async () => f.session } },
  });
  const sample = await manager.incusWorkerMetrics('admin-fixture');
  expect(sample).toMatchObject({ state, cpuCount: 2, primaryMac: '02:00:00:00:00:01', guestMemory: { usedBytes: 5700 * 1024, totalBytes: 10000 * 1024 } });
  expect(sample.state.memory).toBe(state.memory);
  expect(validations).toBe(3);
  const late = finished();
  (manager as any).administrativeNativeTarget = () => ({
    validate: async () => {
      if (changed) throw Error('Administrative authority changed');
      return { instance: { config: { 'limits.cpu': '2' }, devices: {} } };
    },
    native: { client: { getInstanceState: async () => state, execStream: async () => { changed = true; return late.session; } } },
  });
  await expect(manager.incusWorkerMetrics('admin-fixture')).rejects.toThrow('authority changed');
  expect(late.closed()).toBe(1);
});
