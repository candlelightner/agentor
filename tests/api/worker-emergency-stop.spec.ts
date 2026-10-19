import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdminWorkspaceStore, useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { useGroupAdminWorkspaceStore } from '../../orchestrator/server/utils/group-admin-workspace-store';
import { useContainerManager, useWorkerGroupStore } from '../../orchestrator/server/utils/services';
import { useWorkerProtectionLockStore } from '../../orchestrator/server/utils/worker-protection-lock';
import { withWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { DockerAdminWorkspaceRuntime } from '../../orchestrator/server/utils/admin-workspace-runtime';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

test('emergency stop handler enforces confirmation, lock passwords and separate ordinary/platform/group authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-emergency-route-'));
  const platform = useAdminWorkspaceStore(), groups = useGroupAdminWorkspaceStore(), groupStore = useWorkerGroupStore();
  const containers = useContainerManager(), locks = useWorkerProtectionLockStore();
  const platformProperties = Object.getOwnPropertyDescriptors(platform);
  const saved = { get: containers.get, emergency: containers.emergencyStop, groupFind: groups.findByWorkspaceId,
    groupStatus: groups.setStatus, groupStoreFind: groupStore.findById, groupStoreInit: groupStore.init, verify: locks.verify };
  const workerId = randomUUID(), adminId = randomUUID(), groupWorkspaceId = randomUUID(), owner = 'emergency-owner';
  const stamp = new Date(0).toISOString(), groupId = randomUUID();
  const admin = { schemaVersion: 1, id: adminId, kind: 'administrative', trusted: true,
    status: 'running', createdAt: stamp, updatedAt: stamp };
  const groupWorkspace = { ...admin, id: groupWorkspaceId, kind: 'group-administrative', ownerId: owner, groupId };
  const workers = new Map<string, any>([
    [workerId, { id: workerId, userId: owner, status: 'unknown' }],
    [groupWorkspaceId, { id: groupWorkspaceId, userId: owner, administrativeKind: 'group' }],
  ]);
  const calls: string[] = [];
  let locked = false, bodyReads = 0;
  const globals = globalThis as any, values = { defineRouteMeta: () => {},
    defineEventHandler: (handler: unknown) => handler, getRouterParam: (event: any) => event.id,
    readBody: async (event: any) => { bodyReads++; return event.body; } };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  try {
    await mkdir(join(directory, 'admin'));
    await writeFile(join(directory, 'admin/workspace.v1.json'), JSON.stringify(admin));
    Object.assign(platform, new AdminWorkspaceStore(directory));
    platform.setRuntimeAdapter({ ensure: async () => { throw Error('Must never provision'); },
      start: async () => { throw Error('Must never start'); }, rebuild: async () => {},
      stop: async (_record, _ack, force) => { expect(force).toBe(true); calls.push('platform'); } });
    containers.get = ((id: string) => workers.get(id)) as any;
    containers.emergencyStop = async (id: string) => { expect(id).toBe(workerId); calls.push('ordinary'); };
    groups.findByWorkspaceId = ((id: string) => id === groupWorkspaceId ? structuredClone(groupWorkspace) : undefined) as any;
    groupStore.init = async () => {};
    groupStore.findById = ((id: string) => id === groupId ? { id, userId: owner } : undefined) as any;
    groups.setStatus = async (id, status, authorize, force, expectedId) => {
      expect(id).toBe(groupId); expect(status).toBe('stopped'); expect(force).toBe(true); expect(expectedId).toBe(groupWorkspaceId);
      authorize?.(); calls.push('group'); return {} as any;
    };
    locks.verify = async (id, password) => {
      expect([workerId, adminId, groupWorkspaceId]).toContain(id);
      if (locked && password !== 'fixture-password') throw Object.assign(Error('Worker protected'), { statusCode: 423 });
      return true;
    };
    Object.assign(globals, values);
    const route = (await import('../../orchestrator/server/api/containers/[id]/emergency-stop.post')).default as any;
    const event = (id: string, userId = owner, role = 'user', body: unknown = { confirmed: true }) => ({ id, body,
      context: { auth: { user: { id: userId, role }, session: {} } } });
    for (const request of [event(workerId), event(adminId, 'operator', 'admin'), event(groupWorkspaceId)])
      expect(await route(request)).toEqual({ ok: true });
    expect(calls).toEqual(['ordinary', 'platform', 'group']);
    for (const request of [event(workerId, 'foreign'), event(adminId), event(groupWorkspaceId, 'foreign')]) {
      const before = bodyReads;
      await expect(route(request)).rejects.toMatchObject({ statusCode: 403 });
      expect(bodyReads).toBe(before);
    }
    await expect(route({ ...event(workerId), context: {} })).rejects.toMatchObject({ statusCode: 401 });
    await expect(route(event(randomUUID()))).rejects.toMatchObject({ statusCode: 404 });
    for (const body of [{}, { confirmed: false }, { confirmed: 'true' }, null])
      await expect(route(event(workerId, owner, 'user', body))).rejects.toMatchObject({ statusCode: 400 });
    locked = true;
    for (const id of [workerId, adminId, groupWorkspaceId]) {
      const role = id === adminId ? 'admin' : 'user';
      await expect(route(event(id, owner, role))).rejects.toMatchObject({ statusCode: 423 });
      await expect(route(event(id, owner, role, { confirmed: true, lockPassword: 'wrong' }))).rejects.toMatchObject({ statusCode: 423 });
      await route(event(id, owner, role, { confirmed: true, lockPassword: 'fixture-password' }));
    }
    locked = false;
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const pending = withWorkerLifecycleMutation(workerId, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    try {
      await ready;
      await expect(route(event(workerId))).rejects.toMatchObject({ statusCode: 409 });
    } finally { release(); await pending; }
    expect(calls).toEqual(['ordinary', 'platform', 'group', 'ordinary', 'platform', 'group']);
  } finally {
    containers.get = saved.get; containers.emergencyStop = saved.emergency;
    groups.findByWorkspaceId = saved.groupFind; groups.setStatus = saved.groupStatus;
    groupStore.findById = saved.groupStoreFind; groupStore.init = saved.groupStoreInit; locks.verify = saved.verify;
    for (const key of Object.keys(platform)) delete (platform as any)[key];
    Object.defineProperties(platform, platformProperties);
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Docker emergency shutdown sends SIGKILL while graceful shutdown keeps fifteen seconds', async () => {
  const service = new DockerService({} as any), calls: unknown[] = [];
  (service as any).docker = { getContainer: (id: string) => ({
    kill: async (options: any) => { calls.push([id, options.signal]); },
    stop: async (options: any) => { calls.push([id, options.t]); },
  }) };
  await service.killContainer('immutable-worker');
  await service.stopContainer('immutable-worker');
  expect(calls).toEqual([['immutable-worker', 'SIGKILL'], ['immutable-worker', 15]]);
});

test('legacy admin emergency stop refuses foreign labels and stops only the inspected immutable Docker ID', async () => {
  const runtime = new DockerAdminWorkspaceRuntime({} as any) as any;
  const record = { id: 'fixture-admin', kind: 'administrative', imageDigest: 'sha256:' + '1'.repeat(64) };
  const inspection = { Id: 'immutable-admin', Name: '/agentor-admin-workspace', Image: record.imageDigest,
    State: { Running: true, Paused: true }, Config: { Labels: { 'agentor.administrative': 'true', 'agentor.admin.workspace-id': record.id } } };
  const calls: unknown[] = [];
  runtime.docker = { getContainer: (id: string) => ({ inspect: async () => structuredClone(inspection),
    kill: async (options: unknown) => { calls.push([id, options]); },
    stop: async () => { throw Error('Must bypass graceful stop'); } }) };
  runtime.registerServices = async () => {};
  await runtime.stop(record, undefined, true);
  expect(calls).toEqual([['immutable-admin', { signal: 'SIGKILL' }]]);
  runtime.docker.getContainer = () => ({ inspect: async () => structuredClone(inspection),
    kill: async () => { throw Object.assign(Error('Container immutable-admin is not running'), { statusCode: 409 }); } });
  await expect(runtime.stop(record, undefined, true)).resolves.toBeUndefined();
  inspection.Config.Labels['agentor.admin.workspace-id'] = 'foreign-admin';
  await expect(runtime.stop(record, undefined, true)).rejects.toMatchObject({ statusCode: 409 });
  expect(calls).toHaveLength(1);
});
