import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, readFile, chmod, lstat, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { MANAGED_NETWORK_HOSTS_SCRIPT, normalizeManagedNetworkHosts } from '../../orchestrator/server/utils/managed-network-hosts';

const BEGIN = '# BEGIN AGENTOR MANAGED NETWORK HOSTS';
const END = '# END AGENTOR MANAGED NETWORK HOSTS';
const peers = [{ address: '10.42.0.8', names: ['retained-peer', 'Docker_peer'] }];

async function fixture(run: (path: string, execute: (mode: string, input?: unknown) =>
  ReturnType<typeof spawnSync>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-network-hosts-'));
  const path = join(root, 'hosts');
  // Test-local substitution only. The production script has no path argument.
  const script = MANAGED_NETWORK_HOSTS_SCRIPT.replace('PATH="/etc/hosts"', 'PATH=' + JSON.stringify(path));
  expect(script).not.toBe(MANAGED_NETWORK_HOSTS_SCRIPT);
  const execute = (mode: string, input: unknown = normalizeManagedNetworkHosts(peers)) =>
    spawnSync('python3', ['-c', script, mode, JSON.stringify(input)], { encoding: 'utf8', timeout: 10_000 });
  try { await run(path, execute); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('normalization merges addresses, lowercases and sorts deduplicated safe Docker aliases', () => {
  expect(normalizeManagedNetworkHosts([
    { address: '10.0.0.8', names: ['B_peer', 'b_peer', 'a-peer'] },
    { address: '10.0.0.2', names: ['PEER.Example'] },
    { address: '10.0.0.8', names: ['c-peer'] },
  ])).toEqual([
    { address: '10.0.0.2', names: ['peer.example'] },
    { address: '10.0.0.8', names: ['a-peer', 'b_peer', 'c-peer'] },
  ]);
  expect(normalizeManagedNetworkHosts([])).toEqual([]);
});

test('normalization rejects unsafe IPv4, names, fields and bounded-count/output violations', () => {
  for (const address of ['010.0.0.1', '10.0.0.256', '::1', '10.0.0.1\n', '127.1'])
    expect(() => normalizeManagedNetworkHosts([{ address, names: ['peer'] }])).toThrow();
  for (const name of ['peer\n127.0.0.1 evil', 'peer;echo', '#peer', '../peer', '-peer', 'peer-', 'Kpeer', 'épeer', 'a'.repeat(254)])
    expect(() => normalizeManagedNetworkHosts([{ address: '10.0.0.1', names: [name] }])).toThrow();
  for (const input of [null, {}, [{ address: '10.0.0.1', names: [] }],
    [{ address: '10.0.0.1', names: ['peer'], path: '/other' }],
    [{ address: '10.0.0.1', names: Array.from({ length: 2049 }, () => 'peer') }],
    [{ address: '10.0.0.1', names: Array.from({ length: 2048 }, (_, n) => 'a'.repeat(40) + n) }]])
    expect(() => normalizeManagedNetworkHosts(input)).toThrow();
});

test('writer preserves unmanaged bytes and inode/mode/owner; check and unchanged apply do not rewrite', async () => {
  await fixture(async (path, execute) => {
    const unmanaged = Buffer.from('127.0.0.1 localhost\n# operator entry\n192.0.2.1 operator-peer\nlast-line-no-newline');
    await writeFile(path, unmanaged); await chmod(path, 0o640);
    const initial = await lstat(path);
    expect(execute('check').status).toBe(3);
    expect(await readFile(path)).toEqual(unmanaged);
    expect(execute('apply').status).toBe(0);
    const expected = BEGIN + '\n10.42.0.8 docker_peer retained-peer\n' + END + '\n' + unmanaged.toString();
    expect(await readFile(path, 'utf8')).toBe(expected);
    const updated = await lstat(path);
    for (const key of ['ino', 'dev', 'mode', 'uid', 'gid'] as const) expect(updated[key]).toBe(initial[key]);
    expect(execute('check').status).toBe(0);
    expect(execute('apply').status).toBe(0);
    const unchanged = await lstat(path);
    expect(unchanged.mtimeMs).toBe(updated.mtimeMs); expect(unchanged.ctimeMs).toBe(updated.ctimeMs);
    expect(execute('apply', []).status).toBe(0);
    expect(await readFile(path)).toEqual(unmanaged);
    expect(execute('check', []).status).toBe(0);
  });
});

test('existing section replacement removes only its marked lines and keeps both unmanaged sides', async () => {
  await fixture(async (path, execute) => {
    await writeFile(path, 'before\n' + BEGIN + '\n10.0.0.9 stale-peer\n' + END + '\nafter');
    expect(execute('apply').status).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('before\n' + BEGIN +
      '\n10.42.0.8 docker_peer retained-peer\n' + END + '\nafter');
    expect(execute('apply', []).status).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('before\nafter');
  });
});

test('malformed or duplicate markers fail before changing any bytes', async () => {
  await fixture(async (path, execute) => {
    for (const malformed of [
      BEGIN + '\nold',
      END + '\n',
      END + '\n' + BEGIN + '\n',
      BEGIN + '\n' + BEGIN + '\n' + END + '\n',
      BEGIN + '\n' + END + '\n' + END + '\n',
      BEGIN + ' trailing\n' + END + '\n',
      '# note: ' + BEGIN + '\n',
    ]) {
      await writeFile(path, malformed);
      expect(execute('apply').status).not.toBe(0);
      expect(await readFile(path, 'utf8')).toBe(malformed);
    }
  });
});

test('Python independently rejects injected input, unsafe names and unsupported modes without writes', async () => {
  await fixture(async (path, execute) => {
    await writeFile(path, '127.0.0.1 localhost\n');
    for (const input of [null, [{ address: '10.0.0.01', names: ['peer'] }],
      [{ address: '::1', names: ['peer'] }], [{ address: '10.0.0.1', names: ['peer\nevil'] }],
      [{ address: '10.0.0.1', names: ['peer;$(id)'] }], [{ address: '10.0.0.1', names: ['Kpeer'] }],
      [{ address: '10.0.0.1', names: ['peer'], path: '/outside' }],
      [{ address: '10.0.0.1', names: Array.from({ length: 2049 }, () => 'p') }],
      [{ address: '10.0.0.1', names: ['a'.repeat(50_000)] }]]) {
      expect(execute('apply', input).status).not.toBe(0);
      expect(await readFile(path, 'utf8')).toBe('127.0.0.1 localhost\n');
    }
    expect(execute('other').status).not.toBe(0);
    expect(await readFile(path, 'utf8')).toBe('127.0.0.1 localhost\n');
  });
});

test('symlink, nonregular and oversized hosts paths are rejected without touching the source', async () => {
  await fixture(async (path, execute) => {
    const other = path + '-other'; await writeFile(other, 'protected\n'); await symlink(other, path);
    expect(execute('apply').status).not.toBe(0);
    expect(await readFile(other, 'utf8')).toBe('protected\n');
    await rm(path);
    expect(spawnSync('mkfifo', [path]).status).toBe(0);
    const fifo = execute('apply');
    expect(fifo.error).toBeUndefined(); expect(fifo.status).not.toBe(0);
    await rm(path); await mkdir(path);
    expect(execute('apply').status).not.toBe(0);
    await rm(path, { recursive: true }); await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x61));
    const before = await lstat(path);
    expect(execute('apply').status).not.toBe(0);
    expect((await lstat(path)).size).toBe(before.size);
    expect((await lstat(path)).mtimeMs).toBe(before.mtimeMs);
  });
});

test('a held file lock times out without writing or changing unmanaged metadata', async () => {
  await fixture(async (path, execute) => {
    await writeFile(path, 'operator-data\n');
    const before = await lstat(path);
    const locker = spawn('python3', ['-c',
      'import fcntl,sys; f=open(sys.argv[1],"rb"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()',
      path], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve) => locker.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        locker.once('error', reject);
        locker.stdout.once('data', data => data.toString().trim() === 'locked' ? resolve() : reject(new Error('Lock probe failed')));
        locker.once('exit', () => reject(new Error('Lock probe exited before ready')));
      });
      const start = Date.now(), result = execute('apply');
      expect(result.status).not.toBe(0); expect(result.stderr).toContain('lock timed out');
      expect(Date.now() - start).toBeLessThan(8000);
      expect(await readFile(path, 'utf8')).toBe('operator-data\n');
      expect((await lstat(path)).mtimeMs).toBe(before.mtimeMs);
    } finally { locker.stdin.end(); locker.kill('SIGTERM'); await exited; }
  });
});
