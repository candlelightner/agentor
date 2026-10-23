import { test, expect } from '@playwright/test';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IncusClient, IncusRequestRejected, incusCpuDefinitionFingerprint } from '../../orchestrator/server/utils/incus-client';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { useContainerManager, useWorkerGroupStore } from '../../orchestrator/server/utils/services';
import { useWorkerProtectionLockStore } from '../../orchestrator/server/utils/worker-protection-lock';
import { withWorkerLifecycleMutation, isWorkerLifecycleMutationActive } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

const previousLogger = Object.getOwnPropertyDescriptor(globalThis, 'useLogger');
test.beforeAll(() => { (globalThis as any).useLogger ??= () => ({ debug() {}, info() {}, warn() {}, error() {} }); });
test.afterAll(() => {
  if (previousLogger) Object.defineProperty(globalThis, 'useLogger', previousLogger);
  else delete (globalThis as any).useLogger;
});

const instance = () => ({ name: 'fixture', type: 'virtual-machine', status: 'Stopped', profiles: [], description: 'retained',
  config: { 'volatile.uuid': randomUUID(), 'limits.cpu': '2', 'limits.memory': '4GiB', 'user.agentor.owner': 'owner' },
  devices: { root: { type: 'disk', pool: 'pool', path: '/' }, eth0: { type: 'nic', network: 'private' } } });

function clientFixture() {
  const client = new IncusClient({ endpoint: 'https://fixture.invalid', project: 'agentor' });
  let current = instance(), operations: any = {}, capacity: any = 8, etag: string | undefined = 'captured';
  let response: any = { type: 'sync' }, lost = false;
  const writes: any[] = [], order: string[] = [];
  client.request = async (_method, path) => path === '/1.0/resources' ? { cpu: { total: capacity } } as any : operations;
  client.rawRequest = async (method, path, body, headers) => {
    if (method === 'GET') return { statusCode: 200, headers: { etag }, body: Buffer.from(JSON.stringify({ type: 'sync', metadata: current })) };
    writes.push([method, path, body, headers]);
    if (lost) throw Error('Lost mutation response');
    return { statusCode: response.type === 'error' ? 400 : 200, headers: {}, body: Buffer.from(JSON.stringify(response)) };
  };
  client.waitForOperation = async () => { order.push('wait'); return {} as any; };
  return { client, writes, order, get current() { return current; }, set current(value) { current = value; },
    set operations(value) { operations = value; }, set capacity(value) { capacity = value; },
    set etag(value) { etag = value; }, set response(value) { response = value; }, set lost(value) { lost = value; } };
}

test('CPU definition update preserves every unrelated setting and persists acceptance before observation', async () => {
  const f = clientFixture(), original = structuredClone(f.current);
  f.response = { type: 'async', operation: '/1.0/operations/fixture-cpu?project=agentor' };
  await f.client.updateInstanceCpuCount('fixture', 4, async operation => { f.order.push('persist:' + operation); }, original as any);
  expect(f.order).toEqual(['persist:/1.0/operations/fixture-cpu', 'wait']);
  expect(f.writes).toEqual([['PUT', '/1.0/instances/fixture', {
    config: { ...original.config, 'limits.cpu': '4' }, devices: original.devices, profiles: [], description: original.description,
  }, { 'If-Match': 'captured' }]]);
  expect(incusCpuDefinitionFingerprint(original as any)).toBe(incusCpuDefinitionFingerprint({ ...original, config: { ...original.config, 'limits.cpu': '4' } } as any));
});

test('CPU update rejects invalid counts, unsupported capacity, running or replaced VMs, drift and unsettled mutations', async () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, '2', 9]) {
    const f = clientFixture();
    await expect(f.client.updateInstanceCpuCount('fixture', value as any, undefined, f.current as any)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  }
  for (const capacity of [undefined, 0, -1, NaN, '8', 1.5]) {
    const f = clientFixture(); f.capacity = capacity;
    await expect(f.client.getCpuCapacity()).rejects.toThrow('capacity');
  }
  for (const change of ['running', 'replacement', 'device', 'memory', 'profile', 'etag', 'pending']) {
    const f = clientFixture(), captured = structuredClone(f.current);
    if (change === 'running') f.current.status = 'Running';
    if (change === 'replacement') f.current.config['volatile.uuid'] = randomUUID();
    if (change === 'device') f.current.devices.eth0.network = 'foreign';
    if (change === 'memory') f.current.config['limits.memory'] = '8GiB';
    if (change === 'profile') f.current = { ...f.current, profiles: ['foreign'] } as any;
    if (change === 'etag') f.etag = undefined;
    if (change === 'pending') f.operations = { running: [{ status: 'Running', description: 'Updating instance', resources: { instances: ['/1.0/instances/fixture?project=agentor'] } }] };
    await expect(f.client.updateInstanceCpuCount('fixture', 4, undefined, captured as any)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  }
});

test('explicit rejection is distinguishable from unknown submission or failed durable acknowledgement', async () => {
  const unavailable = clientFixture();
  unavailable.client.getCpuCapacity = async () => { throw Error('Capacity lookup failed before submission'); };
  await expect(unavailable.client.updateInstanceCpuCount('fixture', 4, undefined, unavailable.current as any)).rejects.toBeInstanceOf(IncusRequestRejected);
  expect(unavailable.writes).toEqual([]);
  const f = clientFixture(); f.response = { type: 'error', error: 'CPU limit rejected' };
  await expect(f.client.updateInstanceCpuCount('fixture', 4, undefined, f.current as any)).rejects.toBeInstanceOf(IncusRequestRejected);
  f.lost = true;
  await expect(f.client.updateInstanceCpuCount('fixture', 4, undefined, f.current as any)).rejects.not.toBeInstanceOf(IncusRequestRejected);
  f.lost = false; f.response = { type: 'async', operation: '/1.0/operations/fixture-cpu?project=agentor' };
  await expect(f.client.updateInstanceCpuCount('fixture', 4, async () => { throw Error('Durable write failed'); }, f.current as any)).rejects.toThrow('Durable write');
  expect(f.order).toEqual([]);
});

async function workerFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-vcpu-')), id = randomUUID(), uuid = randomUUID();
  const store = new WorkerStore(directory); await store.init();
  const owner = { id, userId: 'fixture-owner', containerName: 'agentor-worker-' + id };
  const stamp = new Date(0).toISOString();
  const info: any = { ...owner, runtimeKind: 'incus-vm', containerId: 'incus:' + uuid, status: 'stopped',
    displayName: 'CPU fixture', createdAt: stamp, updatedAt: stamp, pendingRebuild: true };
  await store.upsert({ ...info, status: 'active' });
  let actual: any = { ...instance(), name: owner.containerName, config: { ...instance().config,
    'volatile.uuid': uuid, 'user.agentor.id': id, 'user.agentor.owner': owner.userId,
    'user.agentor.installation': await backupInstallationId(directory) } };
  let mode = 'success', maximum = 8, terminal = 'Success', updates = 0;
  const client: any = { getInstance: async () => structuredClone(actual), getCpuCapacity: async () => maximum,
    assertInstanceMutationSettled: async () => {}, request: async () => ({ status: terminal, status_code: terminal === 'Success' ? 200 : 400 }),
    updateInstanceCpuCount: async (_name: string, count: number, accepted: any, expected: any) => {
      updates++;
      expect(store.get(owner.userId, id)?.incusCpuResize).toMatchObject({ targetCount: count, incarnation: uuid });
      expect(expected).toEqual(actual);
      if (mode === 'rejected') throw new IncusRequestRejected('Rejected', 400);
      if (mode === 'no-ack') throw Error('Unknown response');
      await accepted(mode === 'unknown' || mode === 'failed' ? '/1.0/operations/fixture-cpu' : undefined);
      if (mode !== 'failed') actual.config['limits.cpu'] = String(count);
      if (mode !== 'success') throw Error('Lost operation observation');
    } };
  const runtime = new IncusWorkerRuntime({ dataDir: directory, containerPrefix: 'agentor-worker' } as any, client);
  runtime.assertWorkspaceReplacementSettled = async () => {};
  const manager = new ContainerManager({} as any, { dataDir: directory } as any);
  manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  (manager as any).assertOwnerExists = async () => {};
  (manager as any).containers.set(id, info);
  return { manager, store, runtime, info, owner, directory, get actual() { return actual; }, get updates() { return updates; },
    set mode(value: string) { mode = value; }, set maximum(value: number) { maximum = value; }, set terminal(value: string) { terminal = value; },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('ordinary stopped VM resize persists an independent override, retains pending settings and survives store reload', async () => {
  const f = await workerFixture();
  try {
    const original = structuredClone(f.actual);
    expect(await f.manager.getVcpuSettings(f.info.id)).toMatchObject({ vcpuCount: 2, maxVcpuCount: 8, status: 'stopped', pending: false });
    expect(await f.manager.setVcpuCount(f.info.id, 4)).toMatchObject({ vcpuCount: 4, pending: false });
    expect(f.actual).toEqual({ ...original, config: { ...original.config, 'limits.cpu': '4' } });
    expect(f.info.vcpuCount).toBe(4);
    const reloaded = new WorkerStore(f.directory); await reloaded.init();
    expect(reloaded.get(f.owner.userId, f.info.id)).toMatchObject({ vcpuCount: 4, pendingRebuild: true });
    expect(reloaded.get(f.owner.userId, f.info.id)?.incusCpuResize).toBeUndefined();
    expect(await f.manager.setVcpuCount(f.info.id, 4)).toMatchObject({ vcpuCount: 4 });
    expect(f.updates).toBe(1);
    f.actual.status = 'Running';
    await expect(f.manager.setVcpuCount(f.info.id, 2)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.updates).toBe(1);
  } finally { await f.cleanup(); }
});

test('unknown accepted CPU update fences lifecycle and is reconciled only from its terminal operation without resubmission', async () => {
  const f = await workerFixture();
  try {
    f.mode = 'unknown';
    await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow('Lost operation');
    await expect.poll(() => isWorkerLifecycleMutationActive(f.info.id)).toBe(false);
    expect(await f.manager.getVcpuSettings(f.info.id)).toMatchObject({ vcpuCount: 4, pending: true, pendingVcpuCount: 4 });
    await expect(f.manager.recover(f.info.id)).rejects.toThrow('CPU change requires reconciliation');
    await expect(f.manager.setVcpuCount(f.info.id, 2)).rejects.toThrow('recorded target');
    f.terminal = 'Running';
    await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow('terminal outcome');
    f.maximum = 2; f.terminal = 'Success';
    expect(await f.manager.setVcpuCount(f.info.id, 4)).toMatchObject({ vcpuCount: 4, maxVcpuCount: 2, pending: false });
    expect(f.updates).toBe(1);
    expect(f.store.get(f.owner.userId, f.info.id)?.vcpuCount).toBe(4);
  } finally { await f.cleanup(); }
});

test('unknown unacknowledged, changed-incarnation or unrelated-definition changes cannot clear CPU intent', async () => {
  for (const change of ['no-ack', 'uuid', 'memory']) {
    const f = await workerFixture();
    try {
      f.mode = change === 'no-ack' ? 'no-ack' : 'unknown';
      await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow();
      if (change === 'uuid') f.actual.config['volatile.uuid'] = randomUUID();
      if (change === 'memory') f.actual.config['limits.memory'] = '8GiB';
      await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow();
      expect(f.store.get(f.owner.userId, f.info.id)?.incusCpuResize).toBeDefined();
      expect(f.updates).toBe(1);
    } finally { await f.cleanup(); }
  }
});

test('definitive rejection and acknowledged terminal failure retain the previous CPU count without rollback writes', async () => {
  for (const mode of ['rejected', 'failed']) {
    const f = await workerFixture();
    try {
      f.mode = mode;
      await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow();
      if (mode === 'failed') {
        f.terminal = 'Failure';
        await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow('previous count was preserved');
      }
      expect(f.actual.config['limits.cpu']).toBe('2');
      expect(f.store.get(f.owner.userId, f.info.id)?.incusCpuResize).toBeUndefined();
      expect(f.updates).toBe(1);
    } finally { await f.cleanup(); }
  }
});

test('failed durable intent writes submit no update; failed completion retains acknowledged intent for reconciliation', async () => {
  const f = await workerFixture();
  const persist = (f.store as any).persistUser;
  try {
    (f.store as any).persistUser = async () => { throw Error('Disk unavailable'); };
    await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow('Disk unavailable');
    expect(f.updates).toBe(0);
    expect(f.store.get(f.owner.userId, f.info.id)?.incusCpuResize).toBeUndefined();
    (f.store as any).persistUser = async (...args: any[]) => {
      const current = (f.store as any).items.get(f.owner.userId).get(f.info.id);
      if (!current.incusCpuResize && current.vcpuCount === 4) throw Error('Completion write failed');
      return persist.apply(f.store, args);
    };
    await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow('Completion write failed');
    expect(f.actual.config['limits.cpu']).toBe('4');
    expect(f.info.vcpuCount).toBeUndefined();
    expect(f.store.get(f.owner.userId, f.info.id)?.incusCpuResize).toMatchObject({ accepted: true, targetCount: 4 });
    (f.store as any).persistUser = persist;
    expect(await f.manager.setVcpuCount(f.info.id, 4)).toMatchObject({ pending: false, vcpuCount: 4 });
    expect(f.updates).toBe(1);
  } finally { (f.store as any).persistUser = persist; await f.cleanup(); }
});

test('a repeated capacity preflight failure clears only proven unchanged intent and a deferred rejection remains recoverable', async () => {
  const f = await workerFixture();
  try {
    let lookups = 0;
    f.runtime.client.getCpuCapacity = async () => {
      if (++lookups === 2) throw Error('Capacity lookup unavailable');
      return 8;
    };
    f.runtime.client.updateInstanceCpuCount = IncusClient.prototype.updateInstanceCpuCount.bind(f.runtime.client);
    await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow('Capacity lookup unavailable');
    expect(f.store.get(f.owner.userId, f.info.id)?.incusCpuResize).toBeUndefined();
    expect(f.actual.config['limits.cpu']).toBe('2');
  } finally { await f.cleanup(); }
  const g = await workerFixture();
  try {
    g.mode = 'rejected';
    g.runtime.client.assertInstanceMutationSettled = async () => { throw Error('Operation inventory unavailable'); };
    await expect(g.manager.setVcpuCount(g.info.id, 4)).rejects.toThrow('inventory unavailable');
    expect(g.store.get(g.owner.userId, g.info.id)?.incusCpuResize).toMatchObject({ rejected: true });
    g.runtime.client.assertInstanceMutationSettled = async () => {};
    await expect(g.manager.setVcpuCount(g.info.id, 4)).rejects.toThrow('previous count was preserved');
    expect(g.store.get(g.owner.userId, g.info.id)?.incusCpuResize).toBeUndefined();
    expect(g.updates).toBe(1);
  } finally { await g.cleanup(); }
});

test('CPU routes authorize before body reads, honor protection and reject pending lifecycle operations', async () => {
  const manager = useContainerManager(), locks = useWorkerProtectionLockStore();
  const original = { get: manager.get, read: manager.getVcpuSettings, write: manager.setVcpuCount, verify: locks.verify };
  const globals = globalThis as any, saved = new Map<string, PropertyDescriptor | undefined>();
  let reads = 0, updates = 0, protectedWorker = false;
  const values = { defineRouteMeta() {}, defineEventHandler: (handler: any) => handler, getRouterParam: () => 'cpu-route',
    createError: (details: any) => Object.assign(Error(details.statusMessage), details), readBody: (event: any) => { reads++; return event.body; } };
  for (const key of Object.keys(values)) saved.set(key, Object.getOwnPropertyDescriptor(globals, key));
  try {
    Object.assign(globals, values);
    manager.get = (() => ({ id: 'cpu-route', userId: 'owner', runtimeKind: 'incus-vm' })) as any;
    manager.getVcpuSettings = async () => ({ vcpuCount: 2, maxVcpuCount: 8, status: 'stopped', pending: false });
    manager.setVcpuCount = async (_id, count) => { updates++; return { vcpuCount: count as number, maxVcpuCount: 8, status: 'stopped', pending: false }; };
    locks.verify = async (_id, password) => { if (protectedWorker && password !== 'fixture-password') throw Object.assign(Error('Protected'), { statusCode: 423 }); return true; };
    const get = (await import('../../orchestrator/server/api/containers/[id]/cpu.get')).default as any;
    const put = (await import('../../orchestrator/server/api/containers/[id]/cpu.put')).default as any;
    const event = (userId = 'owner', body: any = { vcpuCount: 4 }) => ({ body, context: { auth: { user: { id: userId, role: 'user' }, session: {} } } });
    for (const route of [get, put]) await expect(route(event('foreign'))).rejects.toMatchObject({ statusCode: 403 });
    await expect(put({ context: {}, body: {} })).rejects.toMatchObject({ statusCode: 401 });
    expect(reads).toBe(0);
    await expect(put(event('owner', { vcpuCount: 1.5 }))).rejects.toMatchObject({ statusCode: 400 });
    protectedWorker = true;
    await expect(put(event())).rejects.toMatchObject({ statusCode: 423 });
    expect(await put(event('owner', { vcpuCount: 4, lockPassword: 'fixture-password' }))).toMatchObject({ vcpuCount: 4 });
    await withWorkerLifecycleMutation('cpu-route', async () => { await expect(put(event())).rejects.toMatchObject({ statusCode: 409 }); });
    expect(updates).toBe(1);
  } finally {
    manager.get = original.get; manager.getVcpuSettings = original.read; manager.setVcpuCount = original.write; locks.verify = original.verify;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key]; }
  }
});


test('group ceiling applies to owner resize and readback, while recorded reconciliation stays observational', async () => {
  const f = await workerFixture(), groups = useWorkerGroupStore();
  await groups.init();
  const group = await groups.create(f.owner.userId, 'CPU policy fixture', undefined, undefined, 4);
  await groups.update(f.owner.userId, group.id, { workerIds: [f.info.id] });
  try {
    expect(await f.manager.getVcpuSettings(f.info.id)).toMatchObject({ vcpuCount: 2, maxVcpuCount: 4 });
    await expect(f.manager.setVcpuCount(f.info.id, 5)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.updates).toBe(0);
    expect(f.store.get(f.owner.userId, f.info.id)?.incusCpuResize).toBeUndefined();
    f.mode = 'unknown';
    await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow('Lost operation');
    await groups.update(f.owner.userId, group.id, { maxVcpuCount: 1 });
    expect(await f.manager.getVcpuSettings(f.info.id)).toMatchObject({ vcpuCount: 4, maxVcpuCount: 1, pending: true });
    expect(await f.manager.setVcpuCount(f.info.id, 4, undefined, true)).toMatchObject({ vcpuCount: 4, maxVcpuCount: 1, pending: false });
    expect(f.updates).toBe(1);
    await expect(f.manager.setVcpuCount(f.info.id, 1, undefined, true)).rejects.toThrow('No pending');
    expect(f.updates).toBe(1);
    expect(f.actual.config['limits.cpu']).toBe('4');
  } finally { await groups.remove(f.owner.userId, group.id); await f.cleanup(); }
});

test('CPU authority and the group ceiling are rechecked after asynchronous preflight', async () => {
  const f = await workerFixture(), groups = useWorkerGroupStore();
  await groups.init();
  const group = await groups.create(f.owner.userId, 'CPU recheck fixture', undefined, undefined, 4);
  await groups.update(f.owner.userId, group.id, { workerIds: [f.info.id] });
  let allowed = true;
  try {
    f.runtime.client.getCpuCapacity = async () => {
      await groups.update(f.owner.userId, group.id, { maxVcpuCount: 2 });
      return 8;
    };
    await expect(f.manager.setVcpuCount(f.info.id, 4)).rejects.toThrow('ceiling of 2');
    expect(f.updates).toBe(0);
    f.runtime.client.getCpuCapacity = async () => { allowed = false; return 8; };
    await expect(f.manager.setVcpuCount(f.info.id, 1, () => {
      if (!allowed) throw Object.assign(new Error('Delegation revoked'), { statusCode: 403 });
    })).rejects.toThrow('Delegation revoked');
    expect(f.updates).toBe(0);
    expect(f.store.get(f.owner.userId, f.info.id)?.incusCpuResize).toBeUndefined();
  } finally { await groups.remove(f.owner.userId, group.id); await f.cleanup(); }
});


test('CPU authority revoked at the final native submission boundary produces no write', async () => {
  const f = clientFixture();
  await expect(f.client.updateInstanceCpuCount('fixture', 4, undefined, f.current as any, () => {
    throw Object.assign(new Error('CPU authority revoked'), { statusCode: 403 });
  })).rejects.toBeInstanceOf(IncusRequestRejected);
  expect(f.writes).toEqual([]);
});


test('ordinary runtime receives live allocation policy from its container manager before native preflight', async () => {
  const f = await workerFixture(), groups = useWorkerGroupStore();
  await groups.init();
  const group = await groups.create(f.owner.userId, 'Runtime policy fixture', undefined, undefined, 2);
  await groups.update(f.owner.userId, group.id, { workerIds: [f.info.id] });
  const options: any = { ...f.owner, cpuLimit: 3, start: false, recreationNonce: 'fixture-nonce' };
  try {
    await expect(f.runtime.preflightRecreation(options)).rejects.toThrow('ceiling of 2');
    await expect(f.runtime.preflightCanonicalRestore(options)).rejects.toThrow('ceiling of 2');
    await expect(f.runtime.create(options)).rejects.toThrow('ceiling of 2');
    expect(f.updates).toBe(0);
  } finally { await groups.remove(f.owner.userId, group.id); await f.cleanup(); }
});
