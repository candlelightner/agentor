import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { workerStartupFailure, WorkerStartupError } from '../../orchestrator/server/utils/worker-startup-error';
import { recoveryState, validateRecoveryMaxRetries } from '../../orchestrator/shared/worker-recovery';
import { ManagementWorkerDomain } from '../../orchestrator/server/utils/management-worker-domain';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

test('recovery limits validate finite integers and defaults disable no existing worker implicitly', () => {
  expect(recoveryState()).toEqual({ attempts: 0, maxRetries: 3 });
  for (const input of [undefined, null, '3', -1, 1.5, Infinity, NaN, 101]) expect(() => validateRecoveryMaxRetries(input)).toThrow('integer from 0 to 100');
  for (const input of [0, 3, 100]) expect(validateRecoveryMaxRetries(input)).toBe(input);
});

test('retry reservations are atomic, survive reload, retain limits and reset only explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-recovery-limit-'));
  try {
    const store = new WorkerStore(directory); await store.init();
    await store.upsert({ id: 'worker', userId: 'owner', displayName: 'fixture', status: 'active', desiredRuntimeStatus: 'running', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    await store.updateRecovery('owner', 'worker', { maxRetries: 1 });
    const results = await Promise.all([store.updateRecovery('owner', 'worker', { attempt: true }), store.updateRecovery('owner', 'worker', { attempt: true })]);
    expect(results.filter(value => value.claimed)).toHaveLength(1);
    const reloaded = new WorkerStore(directory); await reloaded.init();
    expect(reloaded.get('owner', 'worker')?.recovery).toEqual({ maxRetries: 1, attempts: 1 });
    await reloaded.updateRecovery('owner', 'worker', { maxRetries: 0 });
    expect((await reloaded.updateRecovery('owner', 'worker', { attempt: true })).claimed).not.toBe(true);
    expect(reloaded.get('owner', 'worker')?.recovery?.attempts).toBe(1);
    await reloaded.updateRecovery('owner', 'worker', { reset: true });
    expect(reloaded.get('owner', 'worker')?.recovery).toEqual({ maxRetries: 0, attempts: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup diagnostics expose safe failing phase and exit status without raw guest output', () => {
  expect(workerStartupFailure(new WorkerStartupError('Docker storage preparation', 1))).toEqual({ code: 'WORKER_BOOTSTRAP_FAILED', message: 'Incus worker bootstrap command failed during Docker storage preparation (exit 1)', phase: 'Docker storage preparation', exitCode: 1 });
  const raw = Object.assign(new Error('PRIVATE-GUEST-TOKEN'), { stderr: 'PRIVATE-GUEST-TOKEN' });
  expect(JSON.stringify(workerStartupFailure(raw))).not.toContain('PRIVATE-GUEST-TOKEN');
});

test('MCP declares confirmation, read-only status and retry configuration contracts', () => {
  const tools = new Map(new ManagementWorkerDomain().tools().map(tool => [tool.name, tool]));
  for (const name of ['workers.emergency-stop', 'admin-workspace.emergency-stop', 'groups.admin-workspace.emergency-stop', 'workers.desired-state.set']) {
    expect(tools.get(name)?.inputSchema.required).toContain('confirmed');
    expect((tools.get(name)?.inputSchema.properties as any).confirmed.enum).toEqual([true]);
  }
  expect(tools.get('workers.recovery.get')?.annotations.readOnlyHint).toBe(true);
  expect((tools.get('workers.recovery.set')?.inputSchema.properties as any).maxRetries).toMatchObject({ type: 'integer', minimum: 0, maximum: 100 });
});


test('REST and MCP recovery mutations enforce owner access, confirmation and protection locks', async () => {
  const { useContainerManager } = await import('../../orchestrator/server/utils/services');
  const { useWorkerProtectionLockStore } = await import('../../orchestrator/server/utils/worker-protection-lock');
  const manager = useContainerManager(), locks = useWorkerProtectionLockStore();
  const saved = { get: manager.get, getRecovery: manager.getRecovery, setRecovery: manager.setRecovery, setDesiredState: manager.setDesiredState, emergencyStop: manager.emergencyStop, verify: locks.verify };
  const globals = globalThis as any, names = ['defineRouteMeta', 'defineEventHandler', 'getRouterParam', 'readBody', 'createError'];
  const previous = Object.fromEntries(names.map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  const { createError } = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('h3');
  const calls: string[] = [];
  let protectedWorker = false;
  try {
    Object.assign(globals, { defineRouteMeta: () => {}, defineEventHandler: (handler: unknown) => handler, getRouterParam: (event: any) => event.id, readBody: async (event: any) => event.body, createError });
    manager.get = ((id: string) => id === 'owned-worker' ? { id, userId: 'owner', status: 'unknown' } : undefined) as any;
    manager.getRecovery = () => ({ maxRetries: 3, attempts: 1, paused: false });
    manager.setRecovery = async (_id, count) => { validateRecoveryMaxRetries(count); calls.push('limit'); return manager.getRecovery('owned-worker'); };
    manager.setDesiredState = async (_id, desired) => { if (!['running', 'stopped'].includes(desired)) throw Object.assign(new Error('Invalid state'), { statusCode: 400 }); calls.push(desired); return { workerId: 'owned-worker', desiredRuntimeStatus: desired, status: 'unknown', warning: 'Intent does not confirm runtime state' }; };
    manager.emergencyStop = async () => { calls.push('emergency'); };
    locks.verify = async (_id, password) => { if (protectedWorker && password !== 'fixture-password') throw Object.assign(new Error('Locked'), { statusCode: 423 }); return true; };
    const get = (await import('../../orchestrator/server/api/containers/[id]/recovery.get')).default as any;
    const put = (await import('../../orchestrator/server/api/containers/[id]/recovery.put')).default as any;
    const desired = (await import('../../orchestrator/server/api/containers/[id]/desired-state.put')).default as any;
    const event = (body: unknown, owner = 'owner') => ({ id: 'owned-worker', body, context: { auth: { user: { id: owner, role: 'user' }, session: {} } } });
    await expect(get(event({}))).resolves.toMatchObject({ attempts: 1 });
    for (const handler of [get, put, desired]) await expect(handler(event({}, 'outsider'))).rejects.toMatchObject({ statusCode: 403 });
    await expect(desired(event({ desiredRuntimeStatus: 'stopped' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(put(event({ maxRetries: -1 }))).rejects.toMatchObject({ statusCode: 400 });
    protectedWorker = true;
    await expect(put(event({ maxRetries: 2 }))).rejects.toMatchObject({ statusCode: 423 });
    const domain = new ManagementWorkerDomain();
    for (const name of ['workers.recovery.set', 'workers.desired-state.set', 'workers.emergency-stop']) await expect(domain.execute(name, { workerId: 'owned-worker', confirmed: true, desiredRuntimeStatus: 'stopped', maxRetries: 2 })).rejects.toMatchObject({ statusCode: 423 });
    await domain.execute('workers.recovery.set', { workerId: 'owned-worker', maxRetries: 2, lockPassword: 'fixture-password' });
    await domain.execute('workers.desired-state.set', { workerId: 'owned-worker', desiredRuntimeStatus: 'stopped', confirmed: true, lockPassword: 'fixture-password' });
    await expect(domain.execute('workers.emergency-stop', { workerId: 'owned-worker', lockPassword: 'fixture-password' })).rejects.toMatchObject({ statusCode: 400 });
    await domain.execute('workers.emergency-stop', { workerId: 'owned-worker', confirmed: true, lockPassword: 'fixture-password' });
    expect(calls).toEqual(['limit', 'stopped', 'emergency']);
  } finally {
    Object.assign(manager, { get: saved.get, getRecovery: saved.getRecovery, setRecovery: saved.setRecovery, setDesiredState: saved.setDesiredState, emergencyStop: saved.emergencyStop }); locks.verify = saved.verify;
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key]; }
  }
});

test('global MCP discovers all controls; group MCP limits discovery and live authorization to subtree members', async () => {
  const { ManagementMcpStore } = await import('../../orchestrator/server/utils/management-mcp-store');
  const { useWorkerGroupStore, useContainerManager } = await import('../../orchestrator/server/utils/services');
  const groups = useWorkerGroupStore(), manager = useContainerManager();
  const saved = { findById: groups.findById, get: groups.get, listForUser: groups.listForUser, list: manager.list, archived: manager.listArchived };
  const stamp = new Date(0).toISOString();
  const records = [{ id: 'root', userId: 'owner', workerIds: ['member'], name: 'root', createdAt: stamp, updatedAt: stamp }, { id: 'child', parentId: 'root', userId: 'owner', workerIds: ['descendant'], name: 'child', createdAt: stamp, updatedAt: stamp }, { id: 'sibling', userId: 'owner', workerIds: ['outsider'], name: 'sibling', createdAt: stamp, updatedAt: stamp }];
  const directory = await mkdtemp(join(tmpdir(), 'agentor-recovery-mcp-scope-'));
  try {
    groups.findById = (id => records.find(group => group.id === id)) as any;
    groups.get = ((userId, id) => records.find(group => group.id === id && group.userId === userId)) as any;
    groups.listForUser = (userId => records.filter(group => group.userId === userId)) as any;
    manager.list = (() => ['member', 'descendant', 'outsider'].map(id => ({ id, userId: 'owner' }))) as any; manager.listArchived = () => [];
    const store = new ManagementMcpStore(directory, async () => {});
    await store.init();
    (store as any).state.policy.groups['worker-lifecycle'].enabled = true; (store as any).state.policy.groups.groups.enabled = true;
    const identity: any = { scope: 'group', workspaceId: 'root-admin', ownerId: 'owner', groupId: 'root' };
    const names = ['workers.recovery.get', 'workers.recovery.set', 'workers.desired-state.set', 'workers.emergency-stop'];
    const platformTools = await store.listTools(), groupTools = await store.listTools(identity);
    for (const name of [...names, 'admin-workspace.emergency-stop', 'groups.admin-workspace.emergency-stop']) expect(platformTools.some(tool => tool.name === name)).toBe(true);
    expect(groupTools.some(tool => tool.name === 'admin-workspace.emergency-stop')).toBe(false);
    for (const name of names) {
      expect(groupTools.some(tool => tool.name === name)).toBe(true);
      for (const workerId of ['member', 'descendant']) await (store as any).authorizeGroupInvocation(identity, name, { workerId });
      for (const workerId of ['outsider', 'root-admin', 'platform-admin']) await expect((store as any).authorizeGroupInvocation(identity, name, { workerId })).rejects.toMatchObject({ statusCode: 404 });
    }
    for (const groupId of ['root', 'child']) await (store as any).authorizeGroupInvocation(identity, 'groups.admin-workspace.emergency-stop', { groupId });
    await expect((store as any).authorizeGroupInvocation(identity, 'groups.admin-workspace.emergency-stop', { groupId: 'sibling' })).rejects.toMatchObject({ statusCode: 404 });
    records[1]!.parentId = 'sibling';
    await expect((store as any).authorizeGroupInvocation(identity, 'workers.desired-state.set', { workerId: 'descendant' })).rejects.toMatchObject({ statusCode: 404 });
    await expect((store as any).authorizeGroupInvocation(identity, 'admin-workspace.emergency-stop', { workerId: 'platform-admin' })).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    groups.findById = saved.findById; groups.get = saved.get; groups.listForUser = saved.listForUser; manager.list = saved.list; manager.listArchived = saved.archived;
    await rm(directory, { recursive: true, force: true });
  }
});


test('late runtime records cannot erase durable operator stop intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-stop-intent-'));
  try {
    const store = new WorkerStore(directory); await store.init();
    const record = { id: 'worker', userId: 'owner', displayName: 'fixture', status: 'active' as const, desiredRuntimeStatus: 'running' as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    await store.upsert(record);
    await store.setDesiredRuntimeStatus('owner', 'worker', 'stopped', true);
    await store.upsert(record);
    await store.setDesiredRuntimeStatus('owner', 'worker', 'running');
    expect(store.get('owner', 'worker')?.desiredRuntimeStatus).toBe('stopped');
    const reloaded = new WorkerStore(directory); await reloaded.init();
    expect(reloaded.get('owner', 'worker')?.desiredRuntimeStatus).toBe('stopped');
    await store.setDesiredRuntimeStatus('owner', 'worker', 'running', true);
    expect(store.get('owner', 'worker')?.desiredRuntimeStatus).toBe('running');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
