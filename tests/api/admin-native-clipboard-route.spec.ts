import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AdminWorkspaceStore, useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { useContainerManager } from '../../orchestrator/server/utils/services';
import { useGroupAdminWorkspaceStore } from '../../orchestrator/server/utils/group-admin-workspace-store';
import { requireAuth } from '../../orchestrator/server/utils/auth-helpers';
import { workerLifecycleGeneration } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { buildPng } from '../helpers/clipboard';

test('actual clipboard handler preserves admin lifecycle handles and authorization without provisioning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-clipboard-route-'));
  const admin = useAdminWorkspaceStore(), containers = useContainerManager(), groups = useGroupAdminWorkspaceStore();
  const savedAdmin = Object.getOwnPropertyDescriptors(admin);
  const original = { get: containers.get, clipboard: containers.setClipboard,
    findGroup: groups.findByWorkspaceId, groupClipboard: groups.setClipboard };
  const globals = globalThis as any, adminId = randomUUID(), workerId = randomUUID(), groupId = randomUUID();
  const stamp = new Date(0).toISOString(), owner = 'clipboard-owner';
  const record = { schemaVersion: 1, id: adminId, kind: 'administrative', trusted: true,
    runtimeKind: 'incus-vm', status: 'running', createdAt: stamp, updatedAt: stamp };
  const workers = new Map([workerId, groupId].map(id => [id, { id, userId: owner, status: 'running' }]));
  const group = { id: groupId, status: 'running' };
  const calls: string[] = [];
  let bodyReads = 0, ensures = 0;
  const values = { defineRouteMeta: () => {}, defineEventHandler: (handler: unknown) => handler,
    getRouterParam: (event: any) => event.id, getRequestHeader: (event: any) => event.mime,
    getRequestWebStream: (event: any) => { bodyReads++; return new ReadableStream({ start(controller) {
      controller.enqueue(event.body); controller.close();
    } }); }, requireAuth, useAdminWorkspaceStore: () => admin,
    createError: (value: any) => Object.assign(Error(value.statusMessage), value) };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  const png = buildPng(2, 2);
  const capture = async (target: string, mime: string, bytes: Buffer) => {
    expect(mime).toBe('image/png'); expect(bytes.equals(png)).toBe(true); calls.push(target);
  };
  try {
    await mkdir(join(directory, 'admin'));
    await writeFile(join(directory, 'admin/workspace.v1.json'), JSON.stringify(record));
    Object.assign(admin, new AdminWorkspaceStore(directory));
    admin.setRuntimeAdapter({ ensure: async () => { ensures++; },
      setClipboard: (mime: string, bytes: Buffer) => capture('admin', mime, bytes) } as any);
    containers.get = ((id: string) => workers.get(id)) as any;
    containers.setClipboard = async (_id, mime, bytes) => { await capture('worker', mime, bytes); return { ok: true }; };
    groups.findByWorkspaceId = ((id: string) => id === groupId ? group : undefined) as any;
    groups.setClipboard = async (_record, mime, bytes) => { await capture('group', mime, bytes); };
    Object.assign(globals, values);
    const route = (await import('../../orchestrator/server/api/containers/[id]/clipboard.post')).default as any;
    const event = (id: string, userId = owner, role = 'user') => ({ id, mime: 'image/png', body: png,
      context: { auth: { user: { id: userId, role }, session: {} } } });
    const generation = workerLifecycleGeneration(adminId);
    for (const request of [event(adminId, 'operator', 'admin'), event(workerId), event(groupId)]) {
      expect(await route(request)).toEqual({ ok: true, type: 'image/png', width: 2, height: 2 });
      expect(workerLifecycleGeneration(adminId)).toBe(generation);
      expect(ensures).toBe(0);
    }
    expect(calls).toEqual(['admin', 'worker', 'group']);
    const denied = async (request: any, statusCode: number) => {
      const before = bodyReads, beforeCalls = calls.length;
      await expect(route(request)).rejects.toMatchObject({ statusCode });
      expect(bodyReads).toBe(before); expect(calls).toHaveLength(beforeCalls);
      expect(workerLifecycleGeneration(adminId)).toBe(generation);
    };
    await denied({ ...event(adminId), context: {} }, 401);
    await denied(event(adminId), 403);
    await denied({ ...event(workerId), context: {} }, 401);
    await denied(event(workerId, 'foreign-owner'), 403);
    await denied(event(randomUUID()), 404);
    workers.get(workerId)!.status = 'stopped';
    await denied(event(workerId), 409);
    workers.get(workerId)!.status = 'running';
    group.status = 'stopped'; await denied(event(groupId), 409); group.status = 'running';
    (admin as any).record.status = 'stopped';
    await denied(event(adminId, 'operator', 'admin'), 409);
    (admin as any).record.status = 'running';
    await denied({ ...event(workerId), mime: 'application/octet-stream' }, 415);
    const before = calls.length;
    await expect(route({ ...event(workerId), body: Buffer.alloc(0) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(route({ ...event(workerId), body: Buffer.from('not a PNG') })).rejects.toMatchObject({ statusCode: 415 });
    expect(calls).toHaveLength(before);
    // Ordinary clipboard use must work before any global admin is provisioned.
    Object.assign(admin, new AdminWorkspaceStore(join(directory, 'empty')));
    admin.setRuntimeAdapter({ ensure: async () => { ensures++; } } as any);
    expect(await route(event(workerId))).toMatchObject({ ok: true });
    expect(admin.getRecord()).toBeUndefined();
    expect(ensures).toBe(0);
    expect(workerLifecycleGeneration(adminId)).toBe(generation);
  } finally {
    containers.get = original.get; containers.setClipboard = original.clipboard;
    groups.findByWorkspaceId = original.findGroup; groups.setClipboard = original.groupClipboard;
    for (const key of Object.keys(admin)) delete (admin as any)[key];
    Object.defineProperties(admin, savedAdmin);
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
