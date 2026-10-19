import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdminWorkspaceStore, useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { GroupAdminWorkspaceStore, useGroupAdminWorkspaceStore } from '../../orchestrator/server/utils/group-admin-workspace-store';
import { useWorkerGroupStore } from '../../orchestrator/server/utils/services';

// Actual route handlers and authorization, with real global JSON persistence.
// Runtime work must never be invoked by a resource-settings request.
test('memory routes enforce platform/group ownership before body reads and persist without runtime work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-memory-routes-'));
  const global = useAdminWorkspaceStore(), groups = useGroupAdminWorkspaceStore(), groupStore = useWorkerGroupStore();
  const savedGlobal = Object.getOwnPropertyDescriptors(global), savedGroups = Object.getOwnPropertyDescriptors(groups);
  const findById = groupStore.findById, stamp = new Date(0).toISOString();
  const record: any = { schemaVersion: 1, id: 'memory-admin', kind: 'administrative', trusted: true, runtimeKind: 'incus-vm', status: 'running', createdAt: stamp, updatedAt: stamp };
  const group: any = { id: 'memory-group', userId: 'owner', name: 'Memory group', workerIds: [], createdAt: stamp, updatedAt: stamp,
    adminWorkspace: { ...record, id: 'memory-group-admin', kind: 'group-administrative', groupId: 'memory-group', ownerId: 'owner', services: [] } };
  let bodyReads = 0;
  const globals = globalThis as any;
  const values = { defineRouteMeta: () => {}, defineEventHandler: (handler: any) => handler,
    getRouterParam: (event: any) => event.id, readBody: (event: any) => { bodyReads++; return event.body; } };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  const event = (role?: string, userId = 'owner', memoryLimit: unknown = '8GiB') => ({ id: group.id, body: { memoryLimit },
    context: role ? { auth: { user: { id: userId, role }, session: {} } } : {} });
  try {
    await mkdir(join(directory, 'admin'));
    await writeFile(join(directory, 'admin/workspace.v1.json'), JSON.stringify(record));
    Object.assign(global, new AdminWorkspaceStore(directory));
    Object.assign(groups, new GroupAdminWorkspaceStore({ findById: (id: string) => id === group.id ? group : undefined,
      list: () => [group], update: async (_owner: string, _id: string, patch: any) => { group.adminWorkspace = structuredClone(patch.adminWorkspace); return group; } } as any));
    groupStore.findById = ((id: string) => id === group.id ? group : undefined) as any;
    Object.assign(globals, values);
    const getGlobal = (await import('../../orchestrator/server/api/admin/workspace/resources.get')).default as any;
    const setGlobal = (await import('../../orchestrator/server/api/admin/workspace/resources.put')).default as any;
    const getGroup = (await import('../../orchestrator/server/api/worker-groups/[id]/admin-workspace/resources.get')).default as any;
    const setGroup = (await import('../../orchestrator/server/api/worker-groups/[id]/admin-workspace/resources.put')).default as any;
    for (const handler of [getGlobal, setGlobal, getGroup, setGroup]) {
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 401 });
      await expect(handler(event('user', 'foreign-owner'))).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(bodyReads).toBe(0);
    for (const [get, set, role] of [[getGlobal, setGlobal, 'admin'], [getGroup, setGroup, 'user']] as const) {
      expect(await get(event(role))).toEqual({ memoryLimit: '4GiB', appliedMemoryLimit: '4GiB', pendingRebuild: false });
      await expect(set(event(role, 'owner', '0GiB'))).rejects.toMatchObject({ statusCode: 400 });
      expect(await set(event(role))).toEqual({ memoryLimit: '8GiB', appliedMemoryLimit: '4GiB', pendingRebuild: true });
      expect(await get(event(role))).toMatchObject({ memoryLimit: '8GiB', pendingRebuild: true });
    }
    const reloaded = new AdminWorkspaceStore(directory);
    expect(await reloaded.getResources()).toMatchObject({ memoryLimit: '8GiB', appliedMemoryLimit: '4GiB', pendingRebuild: true });
    expect(global.getRecord()?.status).toBe('running');
    expect(group.adminWorkspace.status).toBe('running');
  } finally {
    groupStore.findById = findById;
    for (const target of [global, groups]) for (const key of Object.keys(target)) delete (target as any)[key];
    Object.defineProperties(global, savedGlobal); Object.defineProperties(groups, savedGroups);
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('CPU routes authorize before body reads, enforce protection locks and persist both admin kinds without lifecycle work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-cpu-routes-'));
  const global = useAdminWorkspaceStore(), groups = useGroupAdminWorkspaceStore(), groupStore = useWorkerGroupStore();
  const { useWorkerProtectionLockStore } = await import('../../orchestrator/server/utils/worker-protection-lock');
  const locks = useWorkerProtectionLockStore(), verify = locks.verify;
  const savedGlobal = Object.getOwnPropertyDescriptors(global), savedGroups = Object.getOwnPropertyDescriptors(groups);
  const findById = groupStore.findById, stamp = new Date(0).toISOString();
  const native = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', nonce: '22222222-2222-4222-8222-222222222222',
    incarnation: '33333333-3333-4333-8333-333333333333', overlayVersion: '6', overlaySha256: 'a'.repeat(64),
    image: { version: 1, sourceImageId: 'sha256:' + '1'.repeat(64), recipeId: '2'.repeat(64), architecture: 'amd64',
      converterVersion: 'v0.4.0', bootstrapGeneration: '3', fingerprint: '3'.repeat(64) } };
  const record: any = { schemaVersion: 1, id: 'cpu-admin', kind: 'administrative', trusted: true, runtimeKind: 'incus-vm', status: 'stopped',
    createdAt: stamp, updatedAt: stamp, nativeRuntime: { ...native, name: 'agentor-admin-cpu-admin' } };
  const group: any = { id: 'cpu-group', userId: 'owner', name: 'CPU group', workerIds: [], createdAt: stamp, updatedAt: stamp,
    adminWorkspace: { ...record, id: 'cpu-group-admin', kind: 'group-administrative', groupId: 'cpu-group', ownerId: 'owner', services: [],
      nativeRuntime: { ...native, name: 'agentor-admin-cpu-group-admin' } } };
  let bodyReads = 0, updates = 0;
  const runtime: any = { getCpuSettings: async (r: any) => ({ vcpuCount: r.nativeRuntime.vcpuCount ?? 2, maxVcpuCount: 8, status: r.status, pending: false }),
    setCpuCount: async (r: any, count: number, ack: any) => { updates++; await ack({ runtimeKind: 'incus-vm', vcpuCount: count,
      nativeRuntime: { ...r.nativeRuntime, vcpuCount: count } }); return { vcpuCount: count, maxVcpuCount: 8, status: r.status, pending: false }; },
    ensure: () => { throw Error('CPU settings must not create compute'); }, start: () => { throw Error('CPU settings must not start compute'); },
    rebuild: () => { throw Error('CPU settings must not rebuild compute'); } };
  const globals = globalThis as any;
  const values = { defineRouteMeta: () => {}, defineEventHandler: (handler: any) => handler,
    getRouterParam: (event: any) => event.id, createError: (error: any) => Object.assign(new Error(error.statusMessage), error),
    readBody: (event: any) => { bodyReads++; return event.body; } };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  const event = (role?: string, userId = 'owner', password?: string, count: unknown = 3) => ({ id: group.id, body: { vcpuCount: count, lockPassword: password },
    context: role ? { auth: { user: { id: userId, role }, session: {} } } : {} });
  try {
    await mkdir(join(directory, 'admin'));
    await writeFile(join(directory, 'admin/workspace.v1.json'), JSON.stringify(record));
    Object.assign(global, new AdminWorkspaceStore(directory)); global.setRuntimeAdapter(runtime);
    Object.assign(groups, new GroupAdminWorkspaceStore({ findById: (id: string) => id === group.id ? group : undefined, list: () => [group],
      update: async (_owner: string, _id: string, patch: any) => { group.adminWorkspace = structuredClone(patch.adminWorkspace); return group; } } as any));
    groups.setRuntimeAdapter(runtime);
    groupStore.findById = ((id: string) => id === group.id ? group : undefined) as any;
    locks.verify = async (id: string, password: unknown) => {
      expect([record.id, group.adminWorkspace.id]).toContain(id);
      if (password !== 'fixture-password') throw Object.assign(new Error('Protected'), { statusCode: 423 }); return true;
    };
    Object.assign(globals, values);
    const getGlobal = (await import('../../orchestrator/server/api/admin/workspace/cpu.get')).default as any;
    const setGlobal = (await import('../../orchestrator/server/api/admin/workspace/cpu.put')).default as any;
    const getGroup = (await import('../../orchestrator/server/api/worker-groups/[id]/admin-workspace/cpu.get')).default as any;
    const setGroup = (await import('../../orchestrator/server/api/worker-groups/[id]/admin-workspace/cpu.put')).default as any;
    for (const handler of [getGlobal, setGlobal, getGroup, setGroup]) {
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 401 });
      await expect(handler(event('user', 'foreign-owner'))).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(bodyReads).toBe(0); expect(updates).toBe(0);
    for (const [get, set, role] of [[getGlobal, setGlobal, 'admin'], [getGroup, setGroup, 'user']] as const) {
      expect(await get(event(role))).toMatchObject({ vcpuCount: 2, pending: false });
      await expect(set(event(role))).rejects.toMatchObject({ statusCode: 423 });
      await expect(set(event(role, 'owner', 'fixture-password', 0))).rejects.toMatchObject({ statusCode: 400 });
      expect(await set(event(role, 'owner', 'fixture-password'))).toMatchObject({ vcpuCount: 3, pending: false });
      expect(await get(event(role))).toMatchObject({ vcpuCount: 3 });
    }
    const reloaded = new AdminWorkspaceStore(directory); await reloaded.init();
    expect(reloaded.getRecord()).toMatchObject({ vcpuCount: 3, nativeRuntime: { vcpuCount: 3 }, status: 'stopped' });
    expect(group.adminWorkspace).toMatchObject({ vcpuCount: 3, nativeRuntime: { vcpuCount: 3 }, status: 'stopped' });
    expect(await readFile(join(directory, 'admin/workspace.v1.json'), 'utf8')).not.toContain('fixture-password');
    expect(updates).toBe(2);
  } finally {
    locks.verify = verify; groupStore.findById = findById;
    for (const target of [global, groups]) for (const key of Object.keys(target)) delete (target as any)[key];
    Object.defineProperties(global, savedGlobal); Object.defineProperties(groups, savedGroups);
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
