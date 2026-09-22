import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedVolumeSizingManager } from '../../orchestrator/server/utils/managed-volume-sizing';
import {
  authorizeManagementVolumeSizeJob, authorizeRestVolumeSizeJob,
  type ManagementVolumeAuthority, type VolumeSizeControlTarget,
} from '../../orchestrator/server/utils/management-volume-domain';
import { createLiveManagementVolumeAuthority } from '../../orchestrator/server/utils/management-mcp-store';

const job = { volumeId: 'volume-1', ownerKey: 'owner-1', requesterId: 'original-admin' };
const target: VolumeSizeControlTarget = {
  id: job.volumeId, userId: 'owner-1', workerId: 'worker-1', ownerKey: 'owner-1', platformOnly: false,
};
const principal = { scope: 'group' as const, ownerId: 'owner-1', groupId: 'group-1', workspaceId: 'admin-1' };
const initialize = async () => {};
const rest = () => ({ initialize, resolve: () => target, getUserById: () => ({}), isPlatformAdminUser: () => false });
const group = () => ({ initialize, resolve: () => target, workerIds: () => new Set(['worker-1']) });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function scanResource(id: string) {
  return {
    id, ownerKey: 'owner-1', userId: 'owner-1', workerId: 'worker-1', dockerName: 'server-private-name',
    purpose: 'workspace', classification: 'builtin' as const, incarnation: 'a'.repeat(64), live: true,
  };
}

async function runningManager(directory: string, onAbort: () => void) {
  const scanEntered = deferred();
  const manager = new ManagedVolumeSizingManager(directory, {
    docker: { listContainers: async () => [] } as any,
    scan: async (_resource, signal) => {
      scanEntered.release();
      return new Promise((_resolve, reject) => {
        const fail = () => {
          onAbort();
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    },
  });
  const started = await manager.create('original-admin', async () => scanResource('volume-1'), true);
  await scanEntered.promise;
  return { manager, started };
}

function blockInitializedManager(manager: ManagedVolumeSizingManager) {
  const blocked = deferred();
  const initialized = (manager as any).initPromise as Promise<void>;
  (manager as any).initPromise = blocked.promise.then(() => initialized);
  return blocked;
}

async function blockManagerState(manager: ManagedVolumeSizingManager) {
  const blocked = deferred(), entered = deferred();
  const pending = (manager as any).withState(async () => {
    entered.release();
    await blocked.promise;
  });
  await entered.promise;
  return { ...blocked, pending };
}

test('owner and group controls need only durable metadata, without physical volume or incarnation', async () => {
  await expect(authorizeRestVolumeSizeJob('owner-1', job, rest())).resolves.toBeUndefined();
  await expect(authorizeManagementVolumeSizeJob(job, principal, group())).resolves.toBeUndefined();
});

test('missing, foreign, retained and mismatched targets deny owner and group controls', async () => {
  const invalid: Array<VolumeSizeControlTarget | undefined> = [
    undefined, { ...target, userId: 'stranger' }, { ...target, ownerKey: 'stranger' },
    { ...target, platformOnly: true }, { ...target, id: 'different-volume' },
  ];
  for (const candidate of invalid) {
    await expect(authorizeRestVolumeSizeJob('owner-1', job, { ...rest(), resolve: () => candidate })).rejects.toMatchObject({ statusCode: 404 });
    await expect(authorizeManagementVolumeSizeJob(job, principal, { ...group(), resolve: () => candidate })).rejects.toMatchObject({ statusCode: 404 });
  }
  await expect(authorizeRestVolumeSizeJob('original-admin', job, rest())).rejects.toMatchObject({ statusCode: 404 });
  await expect(authorizeRestVolumeSizeJob('owner-1', { ...job, ownerKey: 'another-owner' }, rest())).rejects.toMatchObject({ statusCode: 404 });
  await expect(authorizeManagementVolumeSizeJob({ ...job, ownerKey: 'another-owner' }, principal, group())).rejects.toMatchObject({ statusCode: 404 });
});

test('current platform principals control orphan and deleted-target jobs without target discovery', async () => {
  const resolve = () => { throw new Error('target discovery must not run'); };
  await expect(authorizeRestVolumeSizeJob('admin', { ...job, ownerKey: 'platform' }, {
    initialize, resolve, getUserById: () => ({}), isPlatformAdminUser: () => true,
  })).resolves.toBeUndefined();
  await expect(authorizeManagementVolumeSizeJob({ ...job, ownerKey: 'platform' }, {
    scope: 'platform', workspaceId: 'platform-admin',
    reauthorize: async () => ({ scope: 'platform', workspaceId: 'platform-admin' }),
  }, { initialize, resolve })).resolves.toBeUndefined();
  await expect(authorizeRestVolumeSizeJob('deleted-admin', job, {
    ...rest(), getUserById: () => undefined, isPlatformAdminUser: () => true,
  })).rejects.toMatchObject({ statusCode: 404 });
});

test('REST checks current role and existence after asynchronous initialization', async () => {
  for (const change of ['demote', 'delete'] as const) {
    let exists = true, admin = true;
    const blocked = deferred();
    const pending = authorizeRestVolumeSizeJob('original-admin', job, {
      ...rest(), initialize: () => blocked.promise,
      getUserById: () => exists ? {} : undefined, isPlatformAdminUser: () => admin,
    });
    if (change === 'demote') admin = false; else exists = false;
    blocked.release();
    await expect(pending).rejects.toMatchObject({ statusCode: 404 });
  }
});

test('group controls recheck current descendants and target after awaited authorization', async () => {
  for (const change of ['descendant', 'delete', 'retain', 'owner'] as const) {
    let current: VolumeSizeControlTarget | undefined = target;
    let descendants = new Set(['worker-1']);
    const blocked = deferred(), entered = deferred();
    const authority: ManagementVolumeAuthority = { ...principal, reauthorize: async () => {
      entered.release(); await blocked.promise; return principal;
    } };
    const pending = authorizeManagementVolumeSizeJob(job, authority, {
      initialize, resolve: () => current, workerIds: () => new Set(descendants),
    });
    await entered.promise;
    if (change === 'descendant') descendants.clear();
    if (change === 'delete') current = undefined;
    if (change === 'retain') current = { ...target, platformOnly: true };
    if (change === 'owner') current = { ...target, userId: 'another-owner' };
    blocked.release();
    await expect(pending).rejects.toMatchObject({ statusCode: 404 });
  }
  await expect(authorizeManagementVolumeSizeJob(job, { ...principal, ownerId: 'sibling-owner' }, group())).rejects.toMatchObject({ statusCode: 404 });
});

test('MCP controls enforce credential, workspace, policy and principal binding', async () => {
  for (const change of ['expired', 'revoked', 'policy', 'workspace'] as const) {
    let denied = false;
    const authority = createLiveManagementVolumeAuthority(principal, async () => {
      if (denied && (change === 'expired' || change === 'revoked'))
        throw Object.assign(new Error('identity unavailable'), { statusCode: 401 });
      return principal;
    }, () => !(denied && change === 'policy'), () => !(denied && change === 'workspace'));
    await authorizeManagementVolumeSizeJob(job, authority, group());
    denied = true;
    await expect(authorizeManagementVolumeSizeJob(job, authority, group())).rejects.toMatchObject({
      statusCode: change === 'expired' || change === 'revoked' ? 401 : 403,
    });
  }
  await expect(authorizeManagementVolumeSizeJob(job, {
    ...principal, reauthorize: async () => ({ ...principal, groupId: 'replacement-group' }),
  }, group())).rejects.toMatchObject({ statusCode: 403 });
});

test('REST inspect and cancel reauthorize after manager initialization and state-queue waits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-sizing-rest-control-race-'));
  let aborts = 0;
  const { manager, started } = await runningManager(directory, () => { aborts += 1; });
  const authorize = (admin: () => boolean) => ({
    initialize, resolve: () => target, getUserById: () => ({}), isPlatformAdminUser: admin,
  });
  try {
    let admin = true;
    const init = blockInitializedManager(manager);
    const inspecting = manager.get(started.id, {
      authorize: (current) => authorizeRestVolumeSizeJob('original-admin', current, authorize(() => admin)),
    });
    admin = false;
    init.release();
    await expect(inspecting).rejects.toMatchObject({ statusCode: 404 });
    expect(aborts).toBe(0);
    expect(await manager.get(started.id)).toMatchObject({ status: 'running' });

    admin = true;
    const state = await blockManagerState(manager);
    const preauthorized = deferred();
    let checks = 0;
    const cancelling = manager.cancel(started.id, {
      authorize: async (current) => {
        await authorizeRestVolumeSizeJob('original-admin', current, authorize(() => admin));
        if (++checks === 1) preauthorized.release();
      },
    });
    await preauthorized.promise;
    await expect.poll(() => aborts).toBe(1);
    admin = false;
    state.release();
    await state.pending;
    await expect(cancelling).rejects.toMatchObject({ statusCode: 404 });
    await expect.poll(async () => (await manager.get(started.id))?.status).toBe('failed');
    expect(await manager.get(started.id)).not.toMatchObject({ status: 'cancelled' });
  } finally {
    await manager.cancel(started.id).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP inspect and cancel reauthorize after manager initialization and state-queue waits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-sizing-mcp-control-race-'));
  let aborts = 0, revoked = false;
  const { manager, started } = await runningManager(directory, () => { aborts += 1; });
  const platform = { scope: 'platform' as const, workspaceId: 'platform-admin' };
  const authority: ManagementVolumeAuthority = {
    ...platform,
    reauthorize: async () => {
      if (revoked) throw Object.assign(new Error('identity unavailable'), { statusCode: 401 });
      return platform;
    },
  };
  try {
    const init = blockInitializedManager(manager);
    const inspecting = manager.get(started.id, {
      authorize: (current) => authorizeManagementVolumeSizeJob(current, authority, { initialize }),
    });
    revoked = true;
    init.release();
    await expect(inspecting).rejects.toMatchObject({ statusCode: 401 });
    expect(aborts).toBe(0);
    expect(await manager.get(started.id)).toMatchObject({ status: 'running' });

    revoked = false;
    const state = await blockManagerState(manager);
    const preauthorized = deferred();
    let checks = 0;
    const cancelling = manager.cancel(started.id, {
      authorize: async (current) => {
        await authorizeManagementVolumeSizeJob(current, authority, { initialize });
        if (++checks === 1) preauthorized.release();
      },
    });
    await preauthorized.promise;
    await expect.poll(() => aborts).toBe(1);
    revoked = true;
    state.release();
    await state.pending;
    await expect(cancelling).rejects.toMatchObject({ statusCode: 401 });
    await expect.poll(async () => (await manager.get(started.id))?.status).toBe('failed');
    expect(await manager.get(started.id)).not.toMatchObject({ status: 'cancelled' });
  } finally {
    await manager.cancel(started.id).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('queued and running jobs remain controllable during Docker outage without leaking private fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-sizing-job-control-'));
  let outage = false, dockerCalls = 0;
  const scanEntered = deferred();
  const manager = new ManagedVolumeSizingManager(directory, {
    docker: { listContainers: async () => {
      dockerCalls += 1;
      if (outage) throw new Error('Docker unavailable');
      return [];
    } } as any,
    scan: async (_resource, signal) => {
      scanEntered.release();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    },
  });
  try {
    const running = await manager.create('original-admin', async () => scanResource('volume-1'), true);
    await scanEntered.promise;
    const queued = await manager.create('original-admin', async () => scanResource('volume-2'), true);
    expect(queued.status).toBe('queued');
    outage = true;
    const callsBeforeControls = dockerCalls;
    for (const started of [queued, running]) {
      const stored = manager.getStored(started.id)!;
      const currentTarget = { ...target, id: stored.volumeId };
      const inspected = await manager.get(started.id, { authorize: (current) =>
        authorizeRestVolumeSizeJob('owner-1', current, { ...rest(), resolve: () => currentTarget }) });
      expect(inspected?.status).toBe(started.id === queued.id ? 'queued' : 'running');
      for (const key of ['ownerKey', 'requesterId', 'incarnation', 'dockerName', 'userId'])
        expect(inspected).not.toHaveProperty(key);
      const cancelled = await manager.cancel(started.id, { authorize: (current) =>
        authorizeManagementVolumeSizeJob(current, principal, { ...group(), resolve: () => currentTarget }) });
      expect(cancelled).toMatchObject({ status: 'cancelled' });
      expect(JSON.stringify(cancelled)).not.toContain('server-private-name');
      expect(await manager.get(started.id)).toMatchObject({ status: 'cancelled' });
    }
    expect(dockerCalls).toBe(callsBeforeControls);
    await expect.poll(() => manager.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
