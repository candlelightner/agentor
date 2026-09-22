import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ManagedVolumeSizingManager,
  VOLUME_SIZE_SCANNER,
  parseBoundedInteger,
  parseScannerOutput,
  restVolumeSizeAuthorizer,
} from '../../orchestrator/server/utils/managed-volume-sizing';
import { beginInstanceSnapshot } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { managedVolumeIsLive, type ManagedVolumeSizingResource } from '../../orchestrator/server/utils/managed-volume-inventory';

const TEST_ORCHESTRATOR_HOSTNAME = 'sizing-test-orchestrator';
// The mocked Docker runtime needs an orchestrator identity even on non-container
// runners. Own it per test rather than inheriting this worker's HOSTNAME.
const test = base.extend<{ orchestratorIdentity: void }>({
  orchestratorIdentity: [async ({}, use) => {
    const previousHostname = process.env.HOSTNAME;
    process.env.HOSTNAME = TEST_ORCHESTRATOR_HOSTNAME;
    try {
      await use();
    } finally {
      if (previousHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = previousHostname;
    }
  }, { auto: true }],
});

const INCARNATION = 'a'.repeat(64);
const fakeDocker = () => ({ listContainers: async () => [] });
const resource = (id: string, ownerKey = 'owner-a', live = false): ManagedVolumeSizingResource => ({
  id, dockerName: `private-${id}`, userId: ownerKey, workerId: `worker-${id}`,
  ownerKey, purpose: 'persistent-path', classification: 'managed', incarnation: INCARNATION, live,
});

async function terminal(manager: ManagedVolumeSizingManager, id: string) {
  return expect.poll(async () => (await manager.get(id))?.status).toMatch(/succeeded|failed|cancelled/)
    .then(() => manager.get(id));
}

test('size cache distinguishes known, stale, unknown and volume incarnation changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-cache-'));
  let now = Date.now(), scans = 0;
  try {
    const manager = new ManagedVolumeSizingManager(dir, { docker: fakeDocker() as any, now: () => now,
      scan: async () => { scans += 1; return { allocatedBytes: 8192, logicalBytes: 5000, entriesScanned: 3 }; } });
    const target = resource('volume-a', 'owner-a', true), authorize = async () => target;
    const started = await manager.create('owner-a', authorize, true);
    expect((await terminal(manager, started.id))?.measurement).toMatchObject({
      state: 'known', allocatedBytes: 8192, logicalBytes: 5000, consistency: 'live-approximate',
    });
    expect(scans).toBe(1);
    const cached = await manager.create('owner-a', authorize, false);
    expect(cached.status).toBe('succeeded'); expect(scans).toBe(1);
    now += 15 * 60 * 1000 + 1;
    expect(manager.measurementFor(target.id, INCARNATION)).toMatchObject({ state: 'stale', reason: 'stale', allocatedBytes: 8192 });
    expect(manager.measurementFor(target.id, 'b'.repeat(64))).toMatchObject({ state: 'unknown', reason: 'incarnation-changed', allocatedBytes: null });
    expect(manager.measurementFor(target.id, INCARNATION, false)).toMatchObject({ state: 'unknown', reason: 'volume-unavailable' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('scheduler enforces global two and one scan per resource owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-concurrency-'));
  const releases: Array<() => void> = [], started: string[] = [];
  try {
    const manager = new ManagedVolumeSizingManager(dir, { docker: fakeDocker() as any,
      scan: async (item) => { started.push(item.id); await new Promise<void>((resolve) => releases.push(resolve)); return { allocatedBytes: 1, logicalBytes: 1, entriesScanned: 1 }; } });
    const jobs = await Promise.all([
      manager.create('requester', async () => resource('a1', 'owner-a'), true),
      manager.create('requester', async () => resource('a2', 'owner-a'), true),
      manager.create('requester', async () => resource('b1', 'owner-b'), true),
    ]);
    await expect.poll(() => started.length).toBe(2);
    expect(started).toEqual(expect.arrayContaining(['a1', 'b1']));
    expect(started).not.toContain('a2');
    releases.splice(0).forEach((release) => release());
    await expect.poll(() => started.includes('a2')).toBe(true);
    releases.splice(0).forEach((release) => release());
    for (const job of jobs) expect((await terminal(manager, job.id))?.status).toBe('succeeded');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation aborts a running scan and queued/running jobs block instance snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-cancel-'));
  try {
    const manager = new ManagedVolumeSizingManager(dir, { docker: fakeDocker() as any,
      scan: async (_item, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })) });
    const job = await manager.create('owner-a', async () => resource('cancel'), true);
    await expect.poll(async () => (await manager.get(job.id))?.status).toBe('running');
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    expect(await manager.cancel(job.id)).toMatchObject({ status: 'cancelled', phase: 'cancelled' });
    expect((await terminal(manager, job.id))?.status).toBe('cancelled');
    const release = beginInstanceSnapshot('size-test');
    try {
      await expect(manager.create('owner-a', async () => resource('blocked'), true)).rejects.toMatchObject({ statusCode: 409 });
    } finally { release(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restart marks persisted queued work failed instead of resuming without live authority', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-restart-'));
  try {
    const ownerDir = join(dir, 'system-state', 'users', 'volume-sizing'); await mkdir(ownerDir, { recursive: true });
    const stamp = new Date().toISOString();
    await writeFile(join(ownerDir, 'volume-size-jobs.v1.json'), JSON.stringify([{
      id: 'job-a', userId: 'volume-sizing', requesterId: 'owner-a', ownerKey: 'owner-a', volumeId: 'volume-a', incarnation: INCARNATION,
      status: 'queued', phase: 'queued', progress: 0, entriesScanned: 0, createdAt: stamp, updatedAt: stamp,
    }]));
    const manager = new ManagedVolumeSizingManager(dir, { docker: fakeDocker() as any }); await manager.init();
    expect(await manager.get('job-a')).toMatchObject({ status: 'failed', phase: 'failed', error: expect.stringContaining('interrupted') });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('authorization revocation before publication fails closed and does not cache a result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-revoke-'));
  let revoked = false;
  try {
    const manager = new ManagedVolumeSizingManager(dir, { docker: fakeDocker() as any,
      scan: async () => { revoked = true; return { allocatedBytes: 99, logicalBytes: 88, entriesScanned: 2 }; } });
    const target = resource('revoked');
    const authorize = async () => {
      if (revoked) throw Object.assign(new Error('Storage resource not found.'), { statusCode: 404, storageSafeError: true });
      return target;
    };
    const job = await manager.create('owner-a', authorize, true);
    expect(await terminal(manager, job.id)).toMatchObject({ status: 'failed', error: 'Storage resource not found.' });
    expect(manager.measurementFor(target.id, INCARNATION)).toMatchObject({ state: 'unknown', allocatedBytes: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('helper is immutable, read-only, networkless and grants only DAC_READ_SEARCH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-helper-'));
  let createOptions: any;
  try {
    const helper = {
      start: async () => {}, wait: async () => ({ StatusCode: 0 }),
      logs: async () => Buffer.from('AGENTOR_VOLUME_SIZE {"ok":true,"allocatedBytes":"4096","logicalBytes":"17","entriesScanned":2}\n'),
      remove: async () => {},
    };
    const docker = {
      listContainers: async () => [], getVolume: () => ({ inspect: async () => ({ Name: 'private-helper' }) }),
      getContainer: (id: string) => ({
        inspect: async () => {
          expect(id).toBe(TEST_ORCHESTRATOR_HOSTNAME);
          return { Image: 'sha256:trusted' };
        },
        remove: async () => {},
      }),
      createContainer: async (options: any) => { createOptions = options; return helper; },
    };
    const target = { ...resource('helper'), dockerName: 'private-helper' };
    const manager = new ManagedVolumeSizingManager(dir, { docker: docker as any });
    const job = await manager.create('owner-a', async () => target, true);
    expect((await terminal(manager, job.id))?.status).toBe('succeeded');
    expect(createOptions).toMatchObject({ Image: 'sha256:trusted', User: '0:0', Env: [], NetworkDisabled: true,
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: ['DAC_READ_SEARCH'],
        SecurityOpt: ['no-new-privileges:true'], Mounts: [{ Type: 'volume', Source: 'private-helper', Target: '/volume', ReadOnly: true, VolumeOptions: { NoCopy: true } }] } });
    expect(createOptions.HostConfig).not.toHaveProperty('Privileged');
    expect(JSON.stringify(createOptions)).not.toContain('/var/run/docker.sock');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('trusted-image failure before Docker create releases snapshot, owner, and global scheduling accounting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-image-failure-'));
  let imageInspections = 0, createCalls = 0, helperRemovals = 0;
  const started: string[] = [], releases = new Map<string, () => void>();
  try {
    const docker = {
      listContainers: async () => [],
      getVolume: () => ({ inspect: async () => ({}) }),
      getContainer: (id: string) => id === TEST_ORCHESTRATOR_HOSTNAME ? {
        inspect: async () => {
          imageInspections += 1;
          if (imageInspections === 1) throw new Error('trusted image unavailable');
          return { Image: 'sha256:trusted' };
        },
      } : {
        remove: async () => { helperRemovals += 1; },
      },
      createContainer: async (options: any) => {
        createCalls += 1;
        const volumeId = options.Labels['agentor.helper.volume-id'];
        return {
          start: async () => { started.push(volumeId); },
          wait: async () => await new Promise<{ StatusCode: number }>((resolve) => {
            releases.set(volumeId, () => resolve({ StatusCode: 0 }));
          }),
          logs: async () => Buffer.from('AGENTOR_VOLUME_SIZE {"ok":true,"allocatedBytes":"4","logicalBytes":"3","entriesScanned":1}\n'),
        };
      },
    };
    const manager = new ManagedVolumeSizingManager(dir, { docker: docker as any });
    const failed = await manager.create('owner-a', async () => resource('image-failure', 'owner-a'), true);
    expect(await terminal(manager, failed.id)).toMatchObject({ status: 'failed' });
    expect(createCalls).toBe(0);
    expect(helperRemovals).toBe(0);
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);

    const retried = await manager.create('owner-a', async () => resource('image-failure', 'owner-a'), true);
    const otherOwner = await manager.create('owner-b', async () => resource('other-volume', 'owner-b'), true);
    await expect.poll(() => releases.size).toBe(2);
    expect(started).toEqual(expect.arrayContaining(['image-failure', 'other-volume']));
    expect(started).toHaveLength(2);
    expect(createCalls).toBe(2);
    releases.get('image-failure')!();
    releases.get('other-volume')!();
    expect(await terminal(manager, retried.id)).toMatchObject({ status: 'succeeded' });
    expect(await terminal(manager, otherOwner.id)).toMatchObject({ status: 'succeeded' });
    expect(helperRemovals).toBe(2);
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('scanner output parser rejects malformed, unknown and unbounded values', () => {
  expect(parseScannerOutput('header\nAGENTOR_VOLUME_SIZE {"ok":true,"allocatedBytes":"1","logicalBytes":"2","entriesScanned":3}\n')).toMatchObject({ ok: true });
  expect(() => parseScannerOutput('AGENTOR_VOLUME_SIZE {"ok":false,"error":"host detail"}\n')).toThrow();
  expect(() => parseScannerOutput('AGENTOR_VOLUME_SIZE {not json}\n')).toThrow();
  expect(() => parseScannerOutput('no result')).toThrow();
  expect(parseBoundedInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  for (const value of ['-1', '01', '9007199254740992', '1e6', 12]) expect(() => parseBoundedInteger(value)).toThrow();
  expect(() => parseBoundedInteger('1000001', 1_000_000)).toThrow();
});

test('admission atomically deduplicates a volume and enforces the per-owner queue cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-admission-'));
  try {
    const manager = new ManagedVolumeSizingManager(dir, { docker: fakeDocker() as any,
      scan: async (_item, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })) });
    const same = await Promise.all(Array.from({ length: 12 }, () =>
      manager.create('requester', async () => resource('same-volume', 'owner-a'), true)));
    expect(new Set(same.map((job) => job.id)).size).toBe(1);

    const capped = [];
    for (let index = 0; index < 10; index += 1)
      capped.push(await manager.create('requester', async () => resource(`cap-${index}`, 'owner-cap'), true));
    await expect(manager.create('requester', async () => resource('cap-overflow', 'owner-cap'), true))
      .rejects.toMatchObject({ statusCode: 429 });
    for (const id of new Set([...same, ...capped].map((job) => job.id))) await manager.cancel(id);
    await expect.poll(() => manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation during final authorization cannot publish cache or overwrite cancelled state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-publish-cancel-'));
  let calls = 0, releasePublish!: () => void, publishEntered!: () => void;
  const publishBlocked = new Promise<void>((resolve) => { releasePublish = resolve; });
  const atPublish = new Promise<void>((resolve) => { publishEntered = resolve; });
  try {
    const target = resource('publish-cancel');
    const manager = new ManagedVolumeSizingManager(dir, { docker: fakeDocker() as any,
      scan: async () => ({ allocatedBytes: 9, logicalBytes: 8, entriesScanned: 2 }) });
    const authorize = async () => {
      calls += 1;
      if (calls === 5) { publishEntered(); await publishBlocked; }
      return target;
    };
    const job = await manager.create('owner-a', authorize, true);
    await atPublish;
    const cancelling = manager.cancel(job.id);
    releasePublish();
    expect(await cancelling).toMatchObject({ status: 'cancelled' });
    expect(await terminal(manager, job.id)).toMatchObject({ status: 'cancelled' });
    expect(manager.measurementFor(target.id, INCARNATION)).toMatchObject({ state: 'unknown', allocatedBytes: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('late Docker create settlement keeps snapshot accounting until the helper is removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-late-create-'));
  let resolveCreate!: (helper: any) => void, createEntered!: () => void;
  let helperExists = false, removeAttempts = 0;
  const createStarted = new Promise<void>((resolve) => { createEntered = resolve; });
  try {
    const docker = {
      listContainers: async () => [],
      getVolume: () => ({ inspect: async () => ({ Name: 'late-volume' }) }),
      getContainer: () => ({
        inspect: async () => ({ Image: 'sha256:trusted' }),
        remove: async () => {
          removeAttempts += 1;
          if (!helperExists) throw Object.assign(new Error('not found'), { statusCode: 404 });
          helperExists = false;
        },
      }),
      createContainer: async () => {
        createEntered();
        return await new Promise<any>((resolve) => { resolveCreate = resolve; });
      },
    };
    const target = { ...resource('late-create'), dockerName: 'late-volume' };
    const manager = new ManagedVolumeSizingManager(dir, { docker: docker as any });
    const job = await manager.create('owner-a', async () => target, true);
    await createStarted;
    expect(await manager.cancel(job.id)).toMatchObject({ status: 'cancelled' });
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    helperExists = true;
    resolveCreate({});
    await expect.poll(() => manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
    expect(helperExists).toBe(false);
    expect(removeAttempts).toBeGreaterThanOrEqual(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('helper removal failure fails the job and retains the snapshot barrier until stale cleanup succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-cleanup-failure-'));
  let helperName = '', helperExists = false, failCleanup = true;
  try {
    const helper = {
      start: async () => {}, wait: async () => ({ StatusCode: 0 }),
      logs: async () => Buffer.from('AGENTOR_VOLUME_SIZE {"ok":true,"allocatedBytes":"4","logicalBytes":"3","entriesScanned":1}\n'),
    };
    const docker = {
      listContainers: async () => helperExists ? [{ Id: 'helper-id', Names: [`/${helperName}`] }] : [],
      getVolume: () => ({ inspect: async () => ({ Name: 'cleanup-volume' }) }),
      getContainer: () => ({
        inspect: async () => ({ Image: 'sha256:trusted' }),
        remove: async () => {
          if (failCleanup) throw Object.assign(new Error('daemon unavailable'), { statusCode: 500 });
          helperExists = false;
        },
      }),
      createContainer: async (options: any) => { helperName = options.name; helperExists = true; return helper; },
    };
    const target = { ...resource('cleanup-failure'), dockerName: 'cleanup-volume' };
    const manager = new ManagedVolumeSizingManager(dir, { docker: docker as any });
    const job = await manager.create('owner-a', async () => target, true);
    expect(await terminal(manager, job.id)).toMatchObject({ status: 'failed' });
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    failCleanup = false;
    expect(await manager.cleanupStaleHelpers()).toBe(1);
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pending authorization participates in snapshot admission and rechecks the barrier before persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-snapshot-admission-'));
  let releaseAuthorize!: () => void, authorizeEntered!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseAuthorize = resolve; });
  const entered = new Promise<void>((resolve) => { authorizeEntered = resolve; });
  try {
    const manager = new ManagedVolumeSizingManager(dir, { docker: fakeDocker() as any,
      scan: async () => ({ allocatedBytes: 1, logicalBytes: 1, entriesScanned: 1 }) });
    const creating = manager.create('owner-a', async () => { authorizeEntered(); await blocked; return resource('snapshot-race'); }, true);
    await entered;
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    const releaseSnapshot = beginInstanceSnapshot('sizing-admission-race');
    releaseAuthorize();
    try { await expect(creating).rejects.toMatchObject({ statusCode: 409 }); }
    finally { releaseSnapshot(); }
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('live-injected mounts are classified live only for the verified running container id', () => {
  const referenced = new Set<string>();
  expect(managedVolumeIsLive('private-volume', 'container-a', referenced, new Set(['container-a']))).toBe(true);
  expect(managedVolumeIsLive('private-volume', 'container-a', referenced, new Set(['container-b']))).toBe(false);
  expect(managedVolumeIsLive('private-volume', undefined, new Set(['private-volume']), new Set())).toBe(true);
});

test('fd-rooted scanner deduplicates hardlinks and never follows a volume symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-scanner-'));
  const root = join(dir, 'root'), outside = join(dir, 'outside');
  try {
    await mkdir(root); await mkdir(outside);
    const payload = Buffer.from('sizing-payload');
    await writeFile(join(root, 'payload'), payload);
    await link(join(root, 'payload'), join(root, 'hardlink'));
    await writeFile(join(outside, 'must-not-count'), Buffer.alloc(4096));
    await symlink(outside, join(root, 'escape'));
    const scanner = VOLUME_SIZE_SCANNER.replace("const ROOT='/volume'", `const ROOT=${JSON.stringify(root)}`);
    const output = execFileSync(process.execPath, ['-e', scanner], { encoding: 'utf8' });
    const parsed = parseScannerOutput(output);
    expect(parsed).toMatchObject({ ok: true, logicalBytes: String(payload.length) });
    expect(Number(parsed.entriesScanned)).toBe(4);
    expect(scanner).toContain('/proc/self/fd/');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('REST sizing rejects a requester deleted while Docker resolution is paused', async () => {
  let exists = true, releaseResolve!: () => void, resolveEntered!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const authorize = restVolumeSizeAuthorizer('platform-admin', 'foreign-volume', {
    resolve: async () => {
      resolveEntered();
      await blocked;
      return resource('foreign-volume', 'foreign-owner');
    },
    getUserById: () => exists ? {} : null,
    isPlatformAdminUser: () => true,
  });
  const pending = authorize();
  await entered;
  exists = false;
  releaseResolve();
  await expect(pending).rejects.toMatchObject({ statusCode: 404 });
});

test('REST sizing rejects platform demotion while Docker resolution is paused', async () => {
  let admin = true, releaseResolve!: () => void, resolveEntered!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const authorize = restVolumeSizeAuthorizer('platform-admin', 'foreign-volume', {
    resolve: async () => {
      resolveEntered();
      await blocked;
      return resource('foreign-volume', 'foreign-owner');
    },
    getUserById: () => ({}),
    isPlatformAdminUser: () => admin,
  });
  const pending = authorize();
  await entered;
  admin = false;
  releaseResolve();
  await expect(pending).rejects.toMatchObject({ statusCode: 404 });
});

test('startup helper inventory failure blocks snapshots and admissions until reconciliation succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-list-failure-'));
  let failList = true;
  try {
    const docker = {
      listContainers: async () => { if (failList) throw new Error('daemon unavailable'); return []; },
    };
    const manager = new ManagedVolumeSizingManager(dir, { docker: docker as any });
    await manager.init();
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    await expect(manager.create('owner-a', async () => resource('blocked-list'), true))
      .rejects.toMatchObject({ statusCode: 503 });
    failList = false;
    expect(await manager.cleanupStaleHelpers()).toBe(0);
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('startup removal failure reserves owner and volume until absence is confirmed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-recovered-helper-'));
  let helperExists = true, failRemove = true;
  try {
    const item = {
      Id: 'recovered-helper', Names: ['/agentor-volume-size-recovered'], State: 'exited',
      Labels: { 'agentor.helper.owner-id': 'owner-a', 'agentor.helper.volume-id': 'recovered-volume' },
    };
    const docker = {
      listContainers: async () => helperExists ? [item] : [],
      getContainer: () => ({
        remove: async () => {
          if (failRemove) throw Object.assign(new Error('daemon unavailable'), { statusCode: 500 });
          helperExists = false;
        },
      }),
    };
    const manager = new ManagedVolumeSizingManager(dir, { docker: docker as any });
    await manager.init();
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    await expect(
      manager.create('owner-a', async () => resource('recovered-volume', 'owner-a'), true),
    ).rejects.toMatchObject({ statusCode: 503 });
    failRemove = false;
    helperExists = false;
    expect(await manager.cleanupStaleHelpers()).toBe(0);
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed helper wait and removal reserve same-volume, owner, and global capacity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-size-capacity-reservation-'));
  let createCalls = 0;
  try {
    const helper = {
      start: async () => {},
      wait: async () => { throw new Error('wait failed'); },
      logs: async () => Buffer.alloc(0),
      remove: async () => { throw Object.assign(new Error('remove failed'), { statusCode: 500 }); },
    };
    const docker = {
      listContainers: async () => [],
      getVolume: () => ({ inspect: async () => ({}) }),
      getContainer: () => ({
        inspect: async () => ({ Image: 'sha256:trusted' }),
        remove: async () => { throw Object.assign(new Error('remove failed'), { statusCode: 500 }); },
      }),
      createContainer: async () => {
        createCalls += 1;
        return helper;
      },
    };
    const manager = new ManagedVolumeSizingManager(dir, { docker: docker as any });
    const first = await manager.create('owner-a', async () => resource('volume-a', 'owner-a'), true);
    expect(await terminal(manager, first.id)).toMatchObject({ status: 'failed' });
    expect(createCalls).toBe(1);
    await expect(manager.create('owner-a', async () => resource('volume-a', 'owner-a'), true))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(manager.create('owner-a', async () => resource('volume-b', 'owner-a'), true))
      .rejects.toMatchObject({ statusCode: 409 });
    const second = await manager.create('owner-b', async () => resource('volume-b', 'owner-b'), true);
    expect(await terminal(manager, second.id)).toMatchObject({ status: 'failed' });
    expect(createCalls).toBe(2);
    const third = await manager.create('owner-c', async () => resource('volume-c', 'owner-c'), true);
    await expect.poll(async () => (await manager.get(third.id))?.status).toBe('queued');
    expect(createCalls).toBe(2);
    await manager.cancel(third.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
