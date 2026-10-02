import { expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageManager, SHARED_DIRECTORY_MOUNT_POINTS } from '../../orchestrator/server/utils/storage';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

function held() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
let previousLogger: unknown, previousHostname: string | undefined;
test.beforeEach(() => {
  previousLogger = (globalThis as any).useLogger;
  previousHostname = process.env.HOSTNAME;
  process.env.HOSTNAME = 'synthetic-orchestrator';
  (globalThis as any).useLogger = () => ({ info() {}, error() {} });
});
test.afterEach(async () => {
  try { await expect.poll(() => gate.activeOperations).toBe(0); expect(gate.barrierActive).toBe(false); }
  finally {
    (globalThis as any).useLogger = previousLogger;
    if (previousHostname === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = previousHostname;
  }
});

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'agentor-storage-drain-'));
  const ownership: Array<{ path: string; uid: number; gid: number }> = [];
  const files = {
    mkdir: fs.mkdir, rm: fs.rm, chmod: fs.chmod, stat: fs.stat, writeFile: fs.writeFile, readFile: fs.readFile,
    chown: (async (path, uid, gid) => { ownership.push({ path: String(path), uid, gid }); }) as typeof fs.chown,
  };
  let inspections = 0;
  const docker = {
    getContainer: () => ({ inspect: async () => { inspections++; return { Mounts: [{ Destination: directory, Type: 'bind', Source: '/synthetic-data' }] }; } }),
    getVolume: (_name: string) => ({ remove: async () => {} }),
  };
  const manager = new StorageManager(docker as any, { dataDir: directory, dataVolume: 'synthetic-volume' } as any, files);
  return { directory, files, docker, manager, ownership, inspections: () => inspections, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('all direct mutation roots refuse before filesystem, Docker or validation work', async () => {
  const f = await fixture();
  const barrier = gate.begin('storage-roots', 'snapshot');
  try {
    for (const action of [
      () => f.manager.init(), () => f.manager.ensureWorkerDirs('owner', 'worker'),
      () => f.manager.ensureUserSshDir('owner'), () => f.manager.ensureUserKiloConfigDir('owner'),
      () => f.manager.ensureUserKiloSharedDataDir('owner'), () => f.manager.writeSshAuthorizedKeys('owner', 'synthetic-key'),
      () => f.manager.ensureUserDir('owner'), () => f.manager.removeUserDir('owner'),
      () => f.manager.removeWorkerWorkspace('owner', 'worker', 'container'),
      () => f.manager.removeWorkerAgents('owner', 'worker', 'container'), () => f.manager.removeWorkerDocker('container'),
      () => f.manager.ensureCertDir(), () => f.manager.ensureSelfSignedCertDir(), () => f.manager.ensureDefaultsDir(),
      () => f.manager.ensureUserDir('../invalid'),
    ]) await expect(action()).rejects.toMatchObject({ statusCode: 423 });
    expect(f.inspections()).toBe(0); expect(await fs.readdir(f.directory)).toEqual([]);
    expect(f.ownership).toEqual([]); barrier.assertDrained();
  } finally { barrier.release(); await f.cleanup(); }
});

test('initialized-only inventory neither inspects nor writes, and pending initialization cannot publish readiness', async () => {
  const f = await fixture(), entered = held(), release = held();
  const inspect = f.docker.getContainer;
  f.docker.getContainer = () => ({ inspect: async () => { entered.resolve(); await release.promise; return inspect().inspect(); } });
  expect(() => f.manager.assertInitializedForInstanceSnapshot()).toThrow();
  const first = f.manager.init(), second = f.manager.init(); await entered.promise;
  const barrier = gate.begin('storage-init', 'snapshot');
  try {
    expect(() => f.manager.assertInitializedForInstanceSnapshot()).toThrow();
    expect(() => barrier.assertDrained()).toThrow();
    await expect(f.manager.init()).rejects.toMatchObject({ statusCode: 423 });
    release.resolve(); await Promise.all([first, second]); await barrier.drain({ timeoutMs: 1000 });
    f.manager.assertInitializedForInstanceSnapshot(); expect(f.inspections()).toBe(1);
    expect(f.manager.getDataBind(true)).toBe('/synthetic-data:/data:ro');
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { release.resolve(); await Promise.all([first, second]); barrier.release(); await f.cleanup(); }
});

test('caught failed inspection preserves ordinary fallback, retains rejecting settlement and stays unready until retry', async () => {
  const f = await fixture(), release = held();
  const original = f.docker.getContainer;
  const failure = Object.freeze(Object.defineProperty(new Error('synthetic inspect failure'), operationSettlement, {
    value: release.promise.then(() => { throw new Error('late synthetic failure'); }),
  }));
  f.docker.getContainer = () => ({ inspect: async () => { throw failure; } });
  await f.manager.init();
  const barrier = gate.begin('storage-failed-init', 'snapshot');
  try {
    expect(f.manager.getDataBind()).toBe('synthetic-volume:/data');
    expect(() => f.manager.assertInitializedForInstanceSnapshot()).toThrow();
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(() => f.manager.assertInitializedForInstanceSnapshot()).toThrow();
  } finally { release.resolve(); barrier.release(); }
  try { f.docker.getContainer = original; await f.manager.init(); f.manager.assertInitializedForInstanceSnapshot(); }
  finally { await f.cleanup(); }
});

test('explicit reinitialization reinspects legacy mount state and revokes readiness during pending and failed inspection', async () => {
  const f = await fixture(), entered = held(), release = held(); await f.manager.init();
  f.manager.assertInitializedForInstanceSnapshot();
  f.docker.getContainer = () => ({ inspect: async () => { entered.resolve(); await release.promise; throw new Error('synthetic reinspection failure'); } });
  const operation = f.manager.init(); await entered.promise;
  const barrier = gate.begin('storage-reinit', 'snapshot');
  try {
    expect(() => f.manager.assertInitializedForInstanceSnapshot()).toThrow();
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await operation;
    await barrier.drain({ timeoutMs: 1000 }); expect(() => f.manager.assertInitializedForInstanceSnapshot()).toThrow();
    expect(f.manager.getDataBind()).toBe('synthetic-volume:/data');
  } finally { release.resolve(); await operation; barrier.release(); await f.cleanup(); }
});

for (const fallback of ['hostname', 'mount', 'volume']) test(`successful ${fallback} initialization is snapshot-ready with legacy binds`, async () => {
  const f = await fixture();
  if (fallback === 'hostname') delete process.env.HOSTNAME;
  else f.docker.getContainer = () => ({ inspect: async () => ({ Mounts: fallback === 'mount' ? [] : [{ Destination: f.directory, Type: 'volume', Name: 'mounted-volume', Source: '/synthetic-volume-data' }] }) as any });
  try {
    await f.manager.init(); const barrier = gate.begin('storage-fallback', 'snapshot');
    try {
      f.manager.assertInitializedForInstanceSnapshot(); barrier.assertDrained();
      expect(f.manager.mode).toBe('volume');
      expect(f.manager.getWorkerWorkspaceBind('owner', 'worker', 'container')).toBe('container-workspace:/workspace');
      expect(f.manager.getDataBind()).toBe(`${fallback === 'volume' ? 'mounted-volume' : 'synthetic-volume'}:/data`);
    } finally { barrier.release(); }
  } finally { await f.cleanup(); }
});

test('an admitted worker setup finishes every late mountpoint, permission and ownership step', async () => {
  const f = await fixture(), entered = held(), release = held(); await f.manager.init();
  const mkdir = f.files.mkdir; let calls = 0;
  f.files.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => { if (++calls === 2) { entered.resolve(); await release.promise; } return mkdir(...args); }) as typeof fs.mkdir;
  const operation = f.manager.ensureWorkerDirs('owner', 'worker'); await entered.promise;
  const barrier = gate.begin('storage-worker-dirs', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await operation; await barrier.drain({ timeoutMs: 1000 });
    for (const path of SHARED_DIRECTORY_MOUNT_POINTS) expect((await fs.stat(join(f.manager.getUserDir('owner'), 'agents/worker', path))).mode & 0o777).toBe(0o700);
    for (const path of ['.claude/.credentials.json', '.codex/auth.json', '.gemini/oauth_creds.json']) {
      const full = join(f.manager.getUserDir('owner'), 'agents/worker', path);
      expect(await fs.readFile(full, 'utf8')).toBe(''); expect((await fs.stat(full)).mode & 0o777).toBe(0o600);
    }
    expect(f.ownership.every(item => item.uid === 1000 && item.gid === 1000)).toBe(true);
  } finally { release.resolve(); await operation; barrier.release(); await f.cleanup(); }
});

for (const rejecting of [false, true]) test(`caught ownership and stat settlements retain drain through ${rejecting ? 'rejection' : 'resolution'}`, async () => {
  const f = await fixture(), release = held(); await f.manager.init();
  const settlement = release.promise.then(() => { if (rejecting) throw new Error('late synthetic rejection'); });
  const failure = Object.freeze(Object.defineProperty(new Error('synthetic best effort failure'), operationSettlement, { value: settlement }));
  f.files.stat = async () => { throw failure; };
  f.files.chown = async () => { throw failure; };
  await f.manager.ensureWorkerDirs('owner', 'worker');
  const barrier = gate.begin('storage-caught-files', 'snapshot');
  try { expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await barrier.drain({ timeoutMs: 1000 }); }
  finally { release.resolve(); barrier.release(); await f.cleanup(); }
});

for (const action of [
  'ensureUserSshDir', 'ensureUserKiloConfigDir', 'ensureUserKiloSharedDataDir', 'ensureUserDir',
  'writeSshAuthorizedKeys', 'ensureCertDir', 'ensureSelfSignedCertDir', 'ensureDefaultsDir',
  'removeUserDir', 'removeWorkerWorkspace', 'removeWorkerAgents',
] as const) test(`${action} owns delayed filesystem work through its final completion`, async () => {
  const f = await fixture(), entered = held(), release = held(); await f.manager.init();
  const fileMethod = action.startsWith('remove') ? 'rm' : 'mkdir';
  const original = f.files[fileMethod];
  (f.files as any)[fileMethod] = async (...args: any[]) => { entered.resolve(); await release.promise; return (original as any)(...args); };
  const operation = action === 'writeSshAuthorizedKeys' ? f.manager.writeSshAuthorizedKeys('owner', 'synthetic-public-key')
    : action === 'removeWorkerWorkspace' || action === 'removeWorkerAgents' ? f.manager[action]('owner', 'worker', 'container')
    : action === 'ensureCertDir' || action === 'ensureSelfSignedCertDir' || action === 'ensureDefaultsDir' ? f.manager[action]()
    : f.manager[action]('owner');
  await entered.promise; const barrier = gate.begin('storage-direct-fs', 'snapshot');
  try { expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await operation; await barrier.drain({ timeoutMs: 1000 }); }
  finally { release.resolve(); await operation; barrier.release(); await f.cleanup(); }
});

test('uncaught filesystem failure and non-404 Docker failures preserve their original errors and settlement', async () => {
  const f = await fixture(), release = held();
  const failure = Object.freeze(Object.defineProperty(new Error('synthetic deletion failure'), operationSettlement, { value: release.promise }));
  f.files.rm = async () => { throw failure; };
  f.docker.getVolume = () => ({ remove: async () => { throw failure; } });
  await expect(f.manager.removeUserDir('owner')).rejects.toBe(failure);
  await expect(f.manager.removeWorkerDocker('container')).rejects.toBe(failure);
  const barrier = gate.begin('storage-propagated-error', 'snapshot');
  try { expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await barrier.drain({ timeoutMs: 1000 }); }
  finally { release.resolve(); barrier.release(); await f.cleanup(); }
});

test('SSH and shared Kilo directory modes and bind semantics survive storage admission', async () => {
  const f = await fixture(); await f.manager.init();
  try {
    await f.manager.ensureUserSshDir('owner'); await f.manager.writeSshAuthorizedKeys('owner', 'synthetic-public-key  \n');
    expect(await f.manager.readSshAuthorizedKeys('owner')).toBe('synthetic-public-key');
    const key = join(f.manager.getUserDir('owner'), 'ssh/authorized_keys');
    expect(await fs.readFile(key, 'utf8')).toBe('synthetic-public-key\n'); expect((await fs.stat(key)).mode & 0o777).toBe(0o644);
    await f.manager.ensureUserSshDir('owner'); expect(await fs.readFile(key, 'utf8')).toBe('synthetic-public-key\n');
    await f.manager.ensureUserKiloConfigDir('owner'); await f.manager.ensureUserKiloSharedDataDir('owner');
    for (const dir of ['ssh', 'kilo', 'kilo/config', 'kilo/data']) expect((await fs.stat(join(f.manager.getUserDir('owner'), dir))).mode & 0o777).toBe(0o700);
    expect(f.manager.getSshAuthorizedKeysBind('owner')).toBe('/synthetic-data/users/owner/ssh/authorized_keys:/home/agent/.ssh/authorized_keys:ro');
    expect(f.manager.getKiloConfigBind('owner')).toBe('/synthetic-data/users/owner/kilo/config:/home/agent/.agent-data/.kilo/config');
    expect(f.manager.getKiloSharedDataBind('owner')).toBe('/synthetic-data/users/owner/kilo/data:/home/agent/.agent-data/.kilo/shared-data');
    await f.manager.writeSshAuthorizedKeys('owner', ''); expect(await fs.readFile(key, 'utf8')).toBe('');
  } finally { await f.cleanup(); }
});

for (const target of ['Workspace', 'Docker', 'Agents']) test(`volume ${target} removal preserves 404 idempotence while retaining its settlement`, async () => {
  const f = await fixture(), release = held();
  const names: string[] = [];
  const failure = Object.defineProperty(new Error('synthetic missing volume'), operationSettlement, { value: release.promise });
  Object.assign(failure, { statusCode: 404 });
  f.docker.getVolume = name => ({ remove: async () => { names.push(name); throw failure; } });
  const remove = () => target === 'Docker' ? f.manager.removeWorkerDocker('container') : target === 'Workspace' ? f.manager.removeWorkerWorkspace('owner', 'worker', 'container') : f.manager.removeWorkerAgents('owner', 'worker', 'container');
  await remove(); const barrier = gate.begin('storage-volume', 'snapshot');
  try { expect(names).toEqual([`container-${target.toLowerCase()}`]); expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await barrier.drain({ timeoutMs: 1000 }); }
  finally { release.resolve(); barrier.release(); await f.cleanup(); }
});

for (const target of ['inspect', 'remove']) test(`bounded ${target} wait cannot retire the actual late Docker thunk`, async () => {
  const f = await fixture(), entered = held(), release = held();
  const originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: any, delay: number, ...args: any[]) => originalTimer(callback, delay === 30_000 ? 5 : delay, ...args)) as typeof setTimeout;
  const originalInspect = f.docker.getContainer;
  if (target === 'inspect') f.docker.getContainer = () => ({ inspect: async () => { entered.resolve(); await release.promise; return originalInspect().inspect(); } });
  else f.docker.getVolume = () => ({ remove: async () => { entered.resolve(); await release.promise; } });
  const operation = (target === 'inspect' ? f.manager.init() : f.manager.removeWorkerDocker('container')).catch(error => error);
  await entered.promise;
  const barrier = gate.begin('storage-late-docker', 'snapshot');
  try {
    const result = await operation;
    if (target === 'remove') expect(result).toMatchObject({ code: 'DOCKER_OPERATION_TIMEOUT' });
    else { expect(result).toBeUndefined(); expect(() => f.manager.assertInitializedForInstanceSnapshot()).toThrow(); }
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await barrier.drain({ timeoutMs: 1000 });
    if (target === 'inspect') expect(() => f.manager.assertInitializedForInstanceSnapshot()).toThrow();
  } finally { release.resolve(); await operation; globalThis.setTimeout = originalTimer; barrier.release(); await turn(); await f.cleanup(); }
});
