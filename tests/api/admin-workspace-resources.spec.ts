import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
