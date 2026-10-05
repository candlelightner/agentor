import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ManagedNetworkManager } from '../../orchestrator/server/utils/managed-network-manager';

(globalThis as any).createError ??= (options: any) => Object.assign(new Error(options.statusMessage), options);

test('network cleanup refuses foreign or changed runtime identity before any detach or remove', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}`, scope: 'selected', workerIds: [] } as any;
  const owned = { Name: network.dockerName, Driver: 'bridge', Internal: false,
    Labels: { 'agentor.managed-network': 'true', 'agentor.owner': network.userId }, Containers: { peer: {} } };
  for (const patch of [{ Name: 'foreign' }, { Driver: 'overlay' }, { Internal: true },
    { Labels: {} }, { Labels: { ...owned.Labels, 'agentor.owner': 'other-owner' } }]) {
    const manager = new ManagedNetworkManager(), mutations: string[] = [];
    (manager as any).docker = { getNetwork: () => ({ inspect: async () => ({ ...owned, ...patch }),
      disconnect: async () => { mutations.push('detach'); }, remove: async () => { mutations.push('remove'); } }) };
    await expect(manager.remove(network)).rejects.toMatchObject({ statusCode: 409 });
    expect(mutations).toEqual([]);
  }
});

test('owned bridge deletion retains existing bounded detach/remove semantics and missing bridge is idempotent', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}`, scope: 'selected', workerIds: [] } as any;
  const worker = { id: randomUUID(), userId: 'owner', containerName: 'owned-peer', containerId: 'peer', runtimeKind: 'legacy-docker' };
  const manager = new ManagedNetworkManager({ manager: () => ({ list: () => [worker] }) as any,
    workers: () => ({ get: () => ({ ...worker, status: 'active' }) }) as any,
    config: () => ({ incusEnabled: false }) as any }), mutations: any[] = [];
  (manager as any).docker = { getNetwork: (name: string) => ({ inspect: async () => {
    if (name !== network.dockerName) throw { statusCode: 404 };
    return { Name: network.dockerName,
    Driver: 'bridge', Internal: false, Labels: { 'agentor.managed-network': 'true', 'agentor.owner': network.userId },
    Containers: { peer: { Name: worker.containerName } } }; }, disconnect: async (options: any) => { mutations.push(options); },
    remove: async () => { mutations.push('remove'); } }) };
  await manager.remove(network);
  expect(mutations).toEqual([{ Container: 'peer', Force: true }, 'remove']);
  (manager as any).docker = { getNetwork: () => ({ inspect: async () => { throw { statusCode: 404 }; } }) };
  await manager.remove(network);
  expect(mutations).toHaveLength(2);
});

test('network mutations reject newly uncovered actual peers before dispatch, including deletion', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}`, scope: 'selected', workerIds: [] } as any;
  for (const action of ['reconcile', 'remove'] as const) {
    const manager = new ManagedNetworkManager(), mutations: string[] = [];
    let reads = 0;
    manager.actualWorkerIds = async () => ++reads === 1 ? ['covered'] : ['covered', 'new-peer'];
    (manager as any).docker = { getNetwork: () => ({ inspect: async () => ({ Id: 'bridge', Name: network.dockerName,
      Driver: 'bridge', Internal: false, Labels: { 'agentor.managed-network': 'true', 'agentor.owner': network.userId },
      Containers: { peer: { Name: 'owned-peer' } } }),
      disconnect: async () => { mutations.push('detach'); }, remove: async () => { mutations.push('remove'); },
      connect: async () => { mutations.push('attach'); } }) };
    const coverage = new Set(['covered']);
    await expect(action === 'reconcile' ? manager.reconcile(network, [], coverage) : manager.remove(network, coverage))
      .rejects.toThrow('uncovered worker');
    expect(reads).toBe(2); expect(mutations).toEqual([]);
  }
});

test('desired target outside captured authorization is rejected before bridge creation', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}`, scope: 'selected', workerIds: [] } as any;
  const manager = new ManagedNetworkManager(); manager.actualWorkerIds = async () => [];
  (manager as any).docker = { createNetwork: async () => { throw new Error('must not create'); } };
  await expect(manager.reconcile(network, ['uncovered'], new Set())).rejects.toThrow('uncovered worker');
});

test('actual network authority includes drifted peers by exact native ID and durable owner/runtime, not names', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}` } as any;
  const worker = { id: 'worker', userId: 'owner', containerName: 'agentor-worker-worker', containerId: 'docker-id', runtimeKind: 'legacy-docker' };
  const record = { id: 'worker', userId: 'owner', status: 'active', runtimeKind: 'legacy-docker' };
  const inspection = { Name: network.dockerName, Driver: 'bridge', Internal: false,
    Labels: { 'agentor.managed-network': 'true', 'agentor.owner': network.userId }, Containers: { 'docker-id': { Name: worker.containerName } } };
  const manager = new ManagedNetworkManager({ manager: () => ({ list: () => [worker] }) as any,
    workers: () => ({ get: () => record }) as any, config: () => ({ incusEnabled: false }) as any });
  (manager as any).docker = { getNetwork: (name: string) => ({ inspect: async () => {
    if (name === network.dockerName) return inspection;
    throw { statusCode: 404 };
  } }) };
  expect(await manager.actualWorkerIds(network)).toEqual(['worker']);
  for (const patch of [{ containerId: 'replacement' }, { userId: 'foreign' }, { runtimeKind: 'incus-vm' }]) {
    const original = { ...worker }; Object.assign(worker, patch);
    await expect(manager.actualWorkerIds(network)).rejects.toThrow(/foreign|stale|ambiguous/);
    Object.assign(worker, original);
  }
  record.runtimeKind = 'incus-vm';
  await expect(manager.actualWorkerIds(network)).rejects.toThrow('Docker endpoint');
});

test('actual network authority does not turn daemon errors or unknown endpoint maps into empty membership', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}` } as any;
  const manager = new ManagedNetworkManager({ manager: () => ({ list: () => [] }) as any,
    workers: () => ({ get: () => undefined }) as any, config: () => ({ incusEnabled: false }) as any });
  (manager as any).docker = { getNetwork: () => ({ inspect: async () => { throw { statusCode: 500 }; } }) };
  await expect(manager.actualWorkerIds(network)).rejects.toMatchObject({ statusCode: 500 });
  (manager as any).docker = { getNetwork: (name: string) => ({ inspect: async () => {
    if (name !== network.dockerName) throw { statusCode: 404 };
    return { Name: network.dockerName, Driver: 'bridge', Internal: false,
      Labels: { 'agentor.managed-network': 'true', 'agentor.owner': network.userId } };
  } }) };
  await expect(manager.actualWorkerIds(network)).rejects.toThrow('endpoint authority');
});

test('native actual membership rejects orphan or foreign references and does not probe unrelated unavailable VMs', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}` } as any;
  const vm = { id: 'vm', userId: 'owner', runtimeKind: 'incus-vm', containerName: 'agentor-worker-vm' };
  const unrelated = { ...vm, id: 'unrelated', containerName: 'agentor-worker-unrelated' };
  const record = { id: 'vm', userId: 'owner', runtimeKind: 'incus-vm', status: 'active' };
  let references = ['/1.0/instances/agentor-worker-vm?project=agentor'], bridgePresent = true;
  const probes: string[] = [];
  const manager = new ManagedNetworkManager({
    manager: () => ({ list: () => [vm, unrelated], inspectIncusManagedNetwork: async (id: string) => {
      probes.push(id); if (id !== 'vm') throw new Error('Unrelated VM unavailable'); return { attached: true };
    } }) as any,
    workers: () => ({ get: (_owner: string, id: string) => id === 'vm' ? record : undefined }) as any,
    config: () => ({ incusProject: 'agentor', incusEnabled: true }) as any,
    host: () => ({ inspect: async () => bridgePresent ? { references } : null }) as any,
  });
  (manager as any).docker = { getNetwork: () => ({ inspect: async () => { throw { statusCode: 404 }; } }) };
  expect(await manager.actualWorkerIds(network)).toEqual(['vm']); expect(probes).toEqual(['vm']);
  for (const reference of ['/1.0/instances/orphan?project=agentor', '/1.0/instances/agentor-worker-vm?project=foreign',
    '/1.0/instances/agentor-worker-vm?project=agentor&project=agentor', '/1.0/profiles/default?project=agentor',
    'https://incus.invalid/1.0/instances/agentor-worker-vm?project=agentor']) {
    references = [reference]; probes.length = 0;
    await expect(manager.actualWorkerIds(network)).rejects.toThrow(/foreign|unmapped|unsupported/);
    expect(probes).toEqual([]);
  }
  references = ['/1.0/instances/agentor-worker-vm?project=agentor']; record.status = 'archived';
  await expect(manager.actualWorkerIds(network)).rejects.toThrow('stale');
  bridgePresent = false; probes.length = 0;
  expect(await manager.actualWorkerIds(network)).toEqual([]); expect(probes).toEqual([]);
});

test('a shared Docker bridge without authoritative native backing is not empty or adoptable', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}` } as any;
  const manager = new ManagedNetworkManager({ manager: () => ({ list: () => [] }) as any,
    workers: () => ({ get: () => undefined }) as any,
    config: () => ({ incusProject: 'agentor', incusEnabled: true }) as any,
    host: () => ({ inspect: async () => null }) as any });
  (manager as any).docker = { getNetwork: (name: string) => ({ inspect: async () => {
    if (name === network.dockerName) throw { statusCode: 404 };
    return { Name: `${network.dockerName}-incus` };
  } }) };
  await expect(manager.actualWorkerIds(network)).rejects.toThrow('no authoritative native backing bridge');
});
