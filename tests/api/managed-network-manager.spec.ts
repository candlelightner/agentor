import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ManagedNetworkManager } from '../../orchestrator/server/utils/managed-network-manager';
import { incusManagedBridgeIdentity } from '../../orchestrator/server/utils/incus-managed-network-identity';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

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
  const fixture = dispatcherFixture();
  await fixture.manager.remove(fixture.network, fixture.coverage);
  expect(fixture.mutations).toEqual([`disconnect:${fixture.network.dockerName}:docker-id`, `remove:${fixture.network.dockerName}`]);
  await fixture.manager.remove(fixture.network, fixture.coverage);
  expect(fixture.mutations).toHaveLength(2);
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
    expect(reads).toBeGreaterThanOrEqual(2); expect(mutations).toEqual([]);
  }
});

test('mixed dispatch connects legacy peer with aliases before disconnecting original and never sends VM handle to Docker', async () => {
  const fixture = dispatcherFixture({ vm: true });
  const result = await fixture.manager.reconcile(fixture.network, undefined, fixture.coverage);
  expect(result.partialFailures).toEqual([]);
  const connect = fixture.mutations.indexOf(`connect:${fixture.sharedName}:docker-id`);
  const disconnect = fixture.mutations.indexOf(`disconnect:${fixture.network.dockerName}:docker-id`);
  expect(connect).toBeGreaterThanOrEqual(0); expect(disconnect).toBeGreaterThan(connect);
  expect(fixture.endpoints.get('docker-id')![fixture.sharedName].Aliases).toEqual(['kept-alias']);
  expect(fixture.endpoints.get('docker-id')![fixture.network.dockerName]).toBeUndefined();
  expect(fixture.attachedVms.has('vm')).toBe(true);
  expect(fixture.bridges.has(fixture.network.dockerName)).toBe(true);
});

test('failed new legacy attachment retains original endpoint and populated original bridge', async () => {
  const fixture = dispatcherFixture({ vm: true, failConnect: true });
  const result = await fixture.manager.reconcile(fixture.network, undefined, fixture.coverage);
  expect(result.partialFailures.join(';')).toContain('connect failed');
  expect(fixture.endpoints.get('docker-id')![fixture.network.dockerName].Aliases).toEqual(['kept-alias']);
  expect(fixture.mutations.some(value => value.startsWith(`disconnect:${fixture.network.dockerName}`))).toBe(false);
  expect(fixture.bridges.has(fixture.network.dockerName)).toBe(true);
});

test('native bridge errors never attach Incus worker to legacy Docker bridge', async () => {
  const fixture = dispatcherFixture({ vm: true, failNative: true });
  await expect(fixture.manager.reconcile(fixture.network, undefined, fixture.coverage)).rejects.toThrow('native unavailable');
  expect(fixture.mutations).toEqual([]);
});

test('mixed deletion detaches verified VM and Docker peers before exact empty bridge removal', async () => {
  const fixture = dispatcherFixture({ vm: true });
  await fixture.manager.reconcile(fixture.network, undefined, fixture.coverage);
  fixture.mutations.length = 0;
  await fixture.manager.remove(fixture.network, fixture.coverage);
  expect(fixture.mutations.indexOf('vm:detach')).toBeLessThan(fixture.mutations.indexOf('native:remove'));
  expect(fixture.mutations.indexOf(`disconnect:${fixture.sharedName}:docker-id`))
    .toBeLessThan(fixture.mutations.indexOf(`remove:${fixture.sharedName}`));
  expect(fixture.bridges.size).toBe(0); expect(fixture.attachedVms.size).toBe(0);
});

test('mixed topology retains existing response shape with captured VM identity and host lease addresses', async () => {
  const fixture = dispatcherFixture({ vm: true });
  await fixture.manager.reconcile(fixture.network, undefined, fixture.coverage);
  const topology = await fixture.manager.topology(fixture.network);
  expect(topology.network).toBe(fixture.network); expect(topology.exists).toBe(true);
  expect(topology.containers.map(peer => peer.id).sort()).toEqual(['docker-id', 'incus:vm-uuid']);
  expect(topology.containers.find(peer => peer.id === 'incus:vm-uuid'))
    .toEqual({ id: 'incus:vm-uuid', name: 'worker-vm', ipv4Address: '' });
  expect(await fixture.manager.validate(fixture.network)).toMatchObject({ ok: true, missingWorkerIds: [], unexpected: [] });
});

test('unsettled Docker mutation preserves raw settlement error and stops dispatch to later VM', async () => {
  const fixture = dispatcherFixture({ vm: true });
  const error = Object.assign(new Error('request unsettled'), { [operationSettlement]: Promise.resolve() });
  fixture.failures.connect = error;
  await expect(fixture.manager.reconcile(fixture.network, undefined, fixture.coverage)).rejects.toBe(error);
  expect(fixture.attachedVms.size).toBe(0);
  expect(fixture.endpoints.get('docker-id')![fixture.network.dockerName]).toBeTruthy();
});

test('native-only detachment/removal never creates or repairs an unused Docker adapter', async () => {
  const fixture = dispatcherFixture({ vm: true });
  await fixture.manager.reconcile(fixture.network, undefined, fixture.coverage);
  fixture.bridges.delete(fixture.sharedName); // empty/no actual Docker endpoints on this native-only fixture
  fixture.mutations.length = 0;
  await fixture.manager.remove(fixture.network, fixture.coverage);
  expect(fixture.mutations).toEqual(['vm:detach', `remove:${fixture.network.dockerName}`, 'native:remove']);
});

test('delete preserves unsettled detach error and cannot return success on a late remove404', async () => {
  const fixture = dispatcherFixture();
  const error = Object.assign(new Error('detach unsettled'), { [operationSettlement]: Promise.resolve() });
  fixture.failures.disconnect = error;
  await expect(fixture.manager.remove(fixture.network, fixture.coverage)).rejects.toBe(error);
  expect(fixture.bridges.has(fixture.network.dockerName)).toBe(true);
  fixture.failures.disconnect = undefined;
  fixture.failures.remove = Object.assign(new Error('captured bridge disappeared during removal'), { statusCode: 404 });
  await expect(fixture.manager.remove(fixture.network, fixture.coverage)).rejects.toMatchObject({ statusCode: 409 });
});

function dispatcherFixture(options: { vm?: boolean; failConnect?: boolean; failNative?: boolean } = {}) {
  const id = randomUUID(), installation = randomUUID();
  const network = { id, userId: 'owner', dockerName: `agentor-managed-${id}`, scope: 'selected', workerIds: options.vm ? ['docker', 'vm'] : ['docker'] } as any;
  const sharedName = `${network.dockerName}-incus`;
  const bridge = { ...incusManagedBridgeIdentity(installation, network), userId: 'owner', networkId: id,
    gateway: '10.42.87.1', subnet: '10.42.87.0/24', dockerRange: '10.42.87.0/26' };
  const infos: any[] = [{ id: 'docker', userId: 'owner', containerName: 'worker-docker', containerId: 'docker-id', runtimeKind: 'legacy-docker' }];
  if (options.vm) infos.push({ id: 'vm', userId: 'owner', containerName: 'worker-vm', containerId: 'incus:vm-uuid', runtimeKind: 'incus-vm' });
  const mutations: string[] = [], attachedVms = new Set<string>();
  const bridges = new Map<string, any>([[network.dockerName, { Id: 'original-id', Name: network.dockerName, Driver: 'bridge', Internal: false,
    Labels: { 'agentor.managed-network': 'true', 'agentor.owner': 'owner' }, Containers: { 'docker-id': { Name: 'worker-docker' } } }]]);
  const endpoints = new Map<string, any>([['docker-id', { [network.dockerName]: { NetworkID: 'original-id', Aliases: ['kept-alias'] } }]]);
  let nativePresent = false;
  const failures: { connect?: Error; disconnect?: Error; remove?: Error } = options.failConnect ? { connect: new Error('connect failed') } : {};
  const host = {
    inspect: async () => nativePresent ? { ...bridge, references: [...attachedVms].map(id => `/1.0/instances/worker-${id}?project=agentor`) } : null,
    ensure: async () => { if (options.failNative) throw new Error('native unavailable'); nativePresent = true; mutations.push('native:ensure'); return bridge; },
    remove: async () => { if (attachedVms.size || bridges.has(sharedName)) throw new Error('native peers remain'); nativePresent = false; mutations.push('native:remove'); },
  };
  const manager = new ManagedNetworkManager({ config: () => ({ incusProject: 'agentor' }) as any,
    host: () => host as any, workers: () => ({ get: (_owner: string, id: string) => {
      const info = infos.find(info => info.id === id); return info && { ...info, status: 'active' };
    } }) as any,
    manager: () => ({ list: () => infos, get: (id: string) => infos.find(info => info.id === id),
      inspectIncusManagedNetwork: async (id: string) => ({ attached: attachedVms.has(id), ipv4Address: '' }),
      setIncusManagedNetwork: async (id: string, _networkId: string, attach: boolean) => {
        mutations.push(`vm:${attach ? 'attach' : 'detach'}`); if (attach) attachedVms.add(id); else attachedVms.delete(id);
      },
    }) as any,
  });
  (manager as any).docker = {
    getNetwork: (name: string) => {
      const resolve = () => {
        const value = bridges.get(name) ?? [...bridges.values()].find(value => value.Id === name);
        if (!value) throw { statusCode: 404 }; return value;
      };
      return { inspect: async () => resolve(),
        connect: async (options: any) => {
          expect(options.Container).not.toMatch(/^incus:/);
          if (failures.connect) throw failures.connect;
          const value = resolve(); mutations.push(`connect:${value.Name}:${options.Container}`);
          value.Containers[options.Container] = { Name: 'worker-docker' };
          endpoints.get(options.Container)![value.Name] = { NetworkID: value.Id, ...options.EndpointConfig };
        },
        disconnect: async (options: any) => {
          if (failures.disconnect) throw failures.disconnect;
          expect(options.Container).not.toMatch(/^incus:/);
          const value = resolve(); mutations.push(`disconnect:${value.Name}:${options.Container}`);
          delete value.Containers[options.Container]; delete endpoints.get(options.Container)![value.Name];
        },
        remove: async () => { if (failures.remove) throw failures.remove;
          const value = resolve(); if (Object.keys(value.Containers).length) throw new Error('populated bridge');
          mutations.push(`remove:${value.Name}`); bridges.delete(value.Name); },
      };
    },
    createNetwork: async (options: any) => { const value = { ...options, Id: 'shared-id', Containers: {}, EnableIPv6: false };
      bridges.set(options.Name, value); mutations.push(`create:${options.Name}`); return { id: value.Id }; },
    getContainer: (id: string) => ({ inspect: async () => ({ Id: id, NetworkSettings: { Networks: endpoints.get(id) } }) }),
  };
  return { manager, network, sharedName, coverage: new Set(network.workerIds) as Set<string>, mutations, endpoints, bridges, attachedVms, failures };
}

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
