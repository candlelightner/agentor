import { expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserCredentialManager, AGENT_CREDENTIAL_MAPPINGS } from '../../orchestrator/server/utils/user-credentials';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';

function held() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
let previousLogger: unknown;
let messages: string[];
test.beforeEach(() => {
  previousLogger = (globalThis as any).useLogger;
  messages = [];
  (globalThis as any).useLogger = () => ({ info: (message: string) => messages.push(message), warn: (message: string) => messages.push(message) });
});
test.afterEach(async () => {
  try {
    await expect.poll(() => gate.activeOperations).toBe(0);
    expect(gate.barrierActive).toBe(false);
  } finally { (globalThis as any).useLogger = previousLogger; }
});

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'agentor-credential-drain-'));
  const ownership: Array<{ path: string; uid: number; gid: number }> = [];
  let ensures = 0;
  const storage = {
    dataDir: directory,
    dataHostPath: '/synthetic-data',
    getUserDir: (id: string) => join(directory, 'users', id),
    getUserHostDir: (id: string) => join('/synthetic-data/users', id),
    ensureUserDir: async (id: string) => { ensures++; await fs.mkdir(join(directory, 'users', id), { recursive: true }); },
    ensureUserKiloSharedDataDir: async (id: string) => { await fs.mkdir(join(directory, 'users', id, 'kilo/data'), { recursive: true }); },
    removeUserDir: async (id: string) => { await fs.rm(join(directory, 'users', id), { recursive: true, force: true }); },
  };
  const files = {
    mkdir: fs.mkdir, readFile: fs.readFile, readdir: fs.readdir, stat: fs.stat,
    unlink: fs.unlink, writeFile: fs.writeFile,
    chown: async (path: PathLike, uid: number, gid: number) => { ownership.push({ path: String(path), uid, gid }); },
  };
  const manager = new UserCredentialManager(storage as any, files);
  return { directory, storage, files, manager, ownership, ensures: () => ensures, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('credential mutation roots reject before storage, cache changes, or reset validation', async () => {
  const f = await fixture();
  try {
    await f.manager.ensureUserDir('owner');
    const baseline = f.ensures();
    const barrier = gate.begin('credential-roots', 'snapshot');
    try {
      for (const action of [
        () => f.manager.ensureUserDir('owner'), () => f.manager.ensureUserDir('new-owner'),
        () => f.manager.reset('owner', 'codex.json'), () => f.manager.reset('owner', 'unknown'),
        () => f.manager.removeUserData('owner'),
      ]) await expect(action()).rejects.toMatchObject({ statusCode: 423 });
      expect(f.ensures()).toBe(baseline);
      expect(await fs.readFile(f.manager.filePath('owner', 'codex.json'), 'utf8')).toBe('{}');
      barrier.assertDrained();
    } finally { barrier.release(); }
    await f.manager.ensureUserDir('owner'); expect(f.ensures()).toBe(baseline);
  } finally { await f.cleanup(); }
});

test('admitted seeding spans storage initialization, all files and late migration/cache', async () => {
  const f = await fixture(), entered = held(), release = held();
  const ensure = f.storage.ensureUserDir;
  f.storage.ensureUserDir = async id => { entered.resolve(); await release.promise; await ensure(id); };
  const operation = f.manager.ensureUserDir('owner'); await entered.promise;
  const barrier = gate.begin('credential-seed', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await operation; await barrier.drain({ timeoutMs: 1000 });
    for (const mapping of AGENT_CREDENTIAL_MAPPINGS) {
      const path = f.manager.filePath('owner', mapping.fileName);
      expect(await fs.readFile(path, 'utf8')).toBe('{}');
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(f.ownership).toHaveLength(4);
    expect(f.ownership.every(item => item.uid === 1000 && item.gid === 1000)).toBe(true);
  } finally { release.resolve(); await operation; barrier.release(); await f.cleanup(); }
});

for (const delayed of ['claude.json', 'auth.json']) test(`seeding failure retains delayed ${delayed} sibling until its write and ownership settle`, async () => {
  const f = await fixture(), entered = held(), release = held();
  const failure = new Error('synthetic seed failure'); let returned = false;
  f.files.writeFile = (async (path: any, data: any, options: any) => {
    if (String(path).endsWith('/codex.json')) throw failure;
    if (String(path).endsWith(`/${delayed}`)) { entered.resolve(); await release.promise; }
    return fs.writeFile(path, data, options);
  }) as typeof fs.writeFile;
  const operation = f.manager.ensureUserDir('owner').catch(error => { returned = true; return error; });
  await entered.promise; const barrier = gate.begin('credential-seed-failure', 'snapshot');
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); expect(await operation).toBe(failure);
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.ownership.some(item => item.path.endsWith(`/${delayed}`))).toBe(true);
  } finally { release.resolve(); await operation; barrier.release(); }
  try {
    f.files.writeFile = fs.writeFile;
    await f.manager.ensureUserDir('owner'); expect(f.ensures()).toBe(2);
  } finally { await f.cleanup(); }
});

test('legacy Kilo merge retains admission through unlink and late log without changing bind semantics', async () => {
  const f = await fixture(), entered = held(), release = held();
  await f.manager.ensureUserDir('owner');
  const legacy = join(f.manager.credentialsDir('owner'), 'kilo.json');
  const live = f.manager.filePath('owner', 'kilo.json');
  await fs.writeFile(legacy, JSON.stringify({ synthetic: 'old', added: 'new' }));
  await fs.writeFile(live, JSON.stringify({ synthetic: 'current' }));
  // A fresh manager has no seed cache, as after an orchestrator restart.
  const manager = new UserCredentialManager(f.storage as any, f.files);
  f.files.unlink = async path => { entered.resolve(); await release.promise; await fs.unlink(path); };
  const operation = manager.ensureUserDir('owner'); await entered.promise;
  const barrier = gate.begin('credential-migration', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    expect(messages.some(message => message.includes('migrated legacy'))).toBe(false);
    release.resolve(); await operation; await barrier.drain({ timeoutMs: 1000 });
    expect(JSON.parse(await fs.readFile(live, 'utf8'))).toEqual({ synthetic: 'current', added: 'new' });
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(messages.some(message => message.includes('migrated legacy'))).toBe(true);
    const binds = manager.getBindMountsForUser('owner');
    expect(binds).toHaveLength(3); expect(binds.some(bind => bind.includes('kilo'))).toBe(false);
    expect(binds).toContain('/synthetic-data/users/owner/credentials/codex.json:/home/agent/.agent-data/.codex/auth.json');
  } finally { release.resolve(); await operation; barrier.release(); await f.cleanup(); }
});

test('malformed legacy Kilo data remains retryable and shared synthetic data is not overwritten', async () => {
  const f = await fixture();
  try {
    await f.storage.ensureUserDir('owner'); await fs.mkdir(f.manager.credentialsDir('owner'));
    const legacy = join(f.manager.credentialsDir('owner'), 'kilo.json');
    await fs.writeFile(legacy, '{');
    await f.manager.ensureUserDir('owner');
    expect(await fs.readFile(legacy, 'utf8')).toBe('{');
    expect(messages.some(message => message.includes('malformed JSON'))).toBe(true);
    await fs.writeFile(legacy, JSON.stringify({ synthetic: true }));
    await f.manager.ensureUserDir('owner');
    expect(JSON.parse(await fs.readFile(f.manager.filePath('owner', 'kilo.json'), 'utf8'))).toEqual({ synthetic: true });
    expect(f.ensures()).toBe(3);
  } finally { await f.cleanup(); }
});

test('reset admitted before nested ensure continues after the barrier closes and preserves best-effort ownership', async () => {
  const f = await fixture(), entered = held(), release = held();
  const ensure = f.storage.ensureUserDir;
  f.storage.ensureUserDir = async id => { entered.resolve(); await release.promise; await ensure(id); };
  f.files.chown = async () => { throw new Error('synthetic ownership denial'); };
  const operation = f.manager.reset('owner', 'codex.json'); await entered.promise;
  const barrier = gate.begin('credential-reset-continuation', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await operation;
    await barrier.drain({ timeoutMs: 1000 });
    expect(await fs.readFile(f.manager.filePath('owner', 'codex.json'), 'utf8')).toBe('{}');
    expect(messages.some(message => message.includes('reset codex.json'))).toBe(true);
  } finally { release.resolve(); await operation; barrier.release(); await f.cleanup(); }
});

test('late legacy read failure remains inside admission through warning and never caches failure', async () => {
  const f = await fixture(), entered = held(), release = held();
  f.files.readFile = (async (path: any, options: any) => {
    if (String(path).endsWith('/credentials/kilo.json')) {
      entered.resolve(); await release.promise; throw new Error('synthetic legacy read failure');
    }
    return fs.readFile(path, options);
  }) as typeof fs.readFile;
  const operation = f.manager.ensureUserDir('owner'); await entered.promise;
  const barrier = gate.begin('credential-legacy-failure', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await operation;
    await barrier.drain({ timeoutMs: 1000 });
    expect(messages.some(message => message.includes('Kilo legacy migration failed'))).toBe(true);
  } finally { release.resolve(); await operation; barrier.release(); }
  try {
    f.files.readFile = fs.readFile; await f.manager.ensureUserDir('owner'); expect(f.ensures()).toBe(2);
  } finally { await f.cleanup(); }
});

for (const fileName of ['codex.json', 'kilo.json']) test(`${fileName} reset owns nested ensure, final write, ownership and log`, async () => {
  const f = await fixture(), entered = held(), release = held();
  let ownershipCalls = 0;
  const chown = f.files.chown;
  f.files.chown = async (path, uid, gid) => {
    if (++ownershipCalls === 5) { entered.resolve(); await release.promise; }
    await chown(path, uid, gid);
  };
  const operation = f.manager.reset('owner', fileName); await entered.promise;
  const barrier = gate.begin('credential-reset', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    expect(messages.some(message => message.includes('reset '))).toBe(false);
    release.resolve(); await operation; await barrier.drain({ timeoutMs: 1000 });
    expect(messages.some(message => message.includes(`reset ${fileName}`))).toBe(true);
    expect(await fs.readFile(f.manager.filePath('owner', fileName), 'utf8')).toBe('{}');
    expect(f.ownership.at(-1)).toEqual({ path: f.manager.filePath('owner', fileName), uid: 1000, gid: 1000 });
  } finally { release.resolve(); await operation; barrier.release(); await f.cleanup(); }
});

for (const fail of [false, true]) test(`remove retains its storage operation and cache invalidation through ${fail ? 'failure' : 'completion'}`, async () => {
  const f = await fixture(), entered = held(), release = held();
  await f.manager.ensureUserDir('owner');
  const remove = f.storage.removeUserDir;
  const failure = new Error('synthetic removal failure');
  f.storage.removeUserDir = async id => { entered.resolve(); await release.promise; if (fail) throw failure; await remove(id); };
  const operation = f.manager.removeUserData('owner').catch(error => error); await entered.promise;
  const barrier = gate.begin('credential-remove', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve();
    expect(await operation).toBe(fail ? failure : undefined);
    await barrier.drain({ timeoutMs: 1000 });
    expect(messages.some(message => message.includes('removed data directory'))).toBe(!fail);
  } finally { release.resolve(); await operation; barrier.release(); }
  try { await f.manager.ensureUserDir('owner'); expect(f.ensures()).toBe(2); }
  finally { await f.cleanup(); }
});
