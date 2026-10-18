import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagedNetworkManager } from '../../orchestrator/server/utils/managed-network-manager';
import { ManagedNetworkStore } from '../../orchestrator/server/utils/managed-network-store';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { incusManagedBridgeIdentity } from '../../orchestrator/server/utils/incus-managed-network-identity';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

async function fixture(run: (value: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const value = await prepare();
  try { await run(value); }
  finally { await rm(value.dataDir, { recursive: true, force: true }); }
}

async function prepare() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-network-host-authority-'));
  const userId = 'host-authority-owner', installation = randomUUID();
  const workers = new WorkerStore(dataDir), networks = new ManagedNetworkStore(dataDir);
  await Promise.all([workers.init(), networks.init()]);
  const stamp = new Date(0).toISOString();
  const infos: any[] = ['recipient', 'vm-one', 'vm-two', 'docker'].map((role) => {
    const id = randomUUID();
    return { id, role, userId, runtimeKind: role === 'docker' ? 'legacy-docker' : 'incus-vm',
      containerName: 'worker-' + id, containerId: role === 'docker' ? 'd'.repeat(64) : 'incus:' + randomUUID(),
      status: 'running', createdAt: stamp, updatedAt: stamp };
  });
  for (const info of infos)
    await workers.upsert({ id: info.id, userId, runtimeKind: info.runtimeKind, status: 'active',
      displayName: info.role, createdAt: stamp, updatedAt: stamp });
  const [recipient, vmOne, vmTwo, docker] = infos;
  const created = await Promise.all([networks.create(userId, 'first', 'selected'), networks.create(userId, 'second', 'selected')]);
  const selected = await Promise.all(created.map((network, index) =>
    networks.update(userId, network.id, { workerIds: [recipient.id, index ? vmTwo.id : vmOne.id, docker.id] })));
  const native = new Map<string, any>(), shared = new Map<string, any>(), attachments = new Map<string, any>();
  const actual = new Map<string, string[]>(), nativeAddresses = new Map<string, { attached: boolean; ipv4Address: string }>();
  for (const [index, network] of selected.entries()) {
    const prefix = '10.42.' + (index + 1);
    const bridge = { ...incusManagedBridgeIdentity(installation, network), userId, networkId: network.id,
      gateway: prefix + '.1', subnet: prefix + '.0/24', dockerRange: prefix + '.0/26', references: [] };
    native.set(network.id, bridge);
    const name = network.dockerName + '-incus', id = String(index + 1).repeat(64);
    shared.set(name, { Id: id, Name: name, Driver: 'bridge', Internal: false, EnableIPv6: false,
      Labels: { 'agentor.managed-network': 'true', 'agentor.owner': userId,
        'agentor.network-id': network.id, 'agentor.installation': installation },
      Options: { 'com.docker.network.bridge.name': bridge.name, 'com.docker.network.bridge.inhibit_ipv4': 'true' },
      IPAM: { Driver: 'default', Config: [{ Subnet: bridge.subnet, IPRange: bridge.dockerRange, Gateway: bridge.gateway }] },
      Containers: { [docker.containerId]: { Name: docker.containerName, IPv4Address: prefix + '.2/24' } } });
    attachments.set(name, { NetworkID: id, IPAddress: prefix + '.2', Aliases: ['Retained_peer', 'retained-peer'] });
    actual.set(network.id, [...network.workerIds]);
    nativeAddresses.set((index ? vmTwo.id : vmOne.id) + ':' + network.id,
      { attached: true, ipv4Address: prefix + '.130' });
  }
  const reads: string[] = [];
  let dockerInspection: any = { Id: docker.containerId, NetworkSettings: { Networks: Object.fromEntries(attachments) } };
  const observedManager = {
    get: (id: string) => infos.find(info => info.id === id), list: () => infos,
    inspectIncusManagedNetwork: async (id: string, networkId: string) => {
      reads.push('native:' + id + ':' + networkId);
      const observed = nativeAddresses.get(id + ':' + networkId);
      if (!observed) throw new Error('Unexpected native observation');
      return structuredClone(observed);
    },
  };
  const manager = new ManagedNetworkManager({
    workers: () => workers,
    config: () => ({ dataDir, containerPrefix: 'worker', incusProject: 'agentor' }) as any,
    manager: () => observedManager as any,
    host: () => ({ inspect: async (network: any) => structuredClone(native.get(network.id)) }) as any,
  });
  // Endpoint/native identity proof is independently covered in the manager's
  // actualWorkerIds tests. Keep this slice about hostname derivation from that
  // proof; still exercise the real exact-policy Docker bridge adapter below.
  manager.actualWorkerIds = async (network) => {
    reads.push('actual:' + network.id); return [...(actual.get(network.id) ?? [])];
  };
  (manager as any).docker = {
    getNetwork: (name: string) => ({ inspect: async () => {
      reads.push('docker-network:' + name);
      const value = shared.get(name);
      if (!value) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return structuredClone(value);
    } }),
    getContainer: (id: string) => ({ inspect: async () => {
      if (id !== docker.containerId) throw new Error('Unexpected Docker identity');
      reads.push('docker-container:' + id); return structuredClone(dockerInspection);
    } }),
    createNetwork: async () => { throw new Error('Hostname observation must not create'); },
  };
  return { dataDir, userId, workers, networks, selected, recipient, vmOne, vmTwo, docker, manager,
    actual, native, nativeAddresses, shared, attachments, reads,
    setDockerInspection(value: any) { dockerInspection = value; },
    dockerInspection: () => dockerInspection,
    entries: () => manager.workerHostEntries(recipient.id, recipient.containerId) };
}

test('host entries union attached networks using current native addresses and canonical Docker names plus retained aliases', async () => {
  await fixture(async f => {
    expect(await f.entries()).toEqual([
      { address: '10.42.1.130', names: [f.vmOne.containerName] },
      { address: '10.42.1.2', names: [f.docker.containerName, 'retained-peer', 'retained_peer'].sort() },
      { address: '10.42.2.130', names: [f.vmTwo.containerName] },
      { address: '10.42.2.2', names: [f.docker.containerName, 'retained-peer', 'retained_peer'].sort() },
    ]);
    for (const network of f.selected)
      expect(f.reads.filter(read => read === 'actual:' + network.id)).toHaveLength(2);
    f.nativeAddresses.set(f.vmOne.id + ':' + f.selected[0].id, { attached: true, ipv4Address: '10.42.1.177' });
    expect((await f.entries()).find(entry => entry.names.includes(f.vmOne.containerName))?.address).toBe('10.42.1.177');
  });
});

test('desired-only, detached and revoked peers are not published and detached recipients get no entries', async () => {
  await fixture(async f => {
    const first = f.selected[0], second = f.selected[1];
    // vm-one is desired but no longer actually attached. vm-two is actually
    // attached but its durable membership has been revoked.
    f.actual.set(first.id, [f.recipient.id, f.docker.id]);
    await f.networks.update(f.userId, second.id, { workerIds: [f.recipient.id, f.docker.id] });
    const entries = await f.entries();
    expect(entries.some(entry => entry.names.includes(f.vmOne.containerName) || entry.names.includes(f.vmTwo.containerName))).toBe(false);
    expect(entries).toHaveLength(2);
    f.actual.set(first.id, [f.docker.id]);
    f.actual.set(second.id, [f.docker.id]);
    expect(await f.entries()).toEqual([]);
    expect(f.reads.filter(read => read.startsWith('native:'))).toEqual([]);
  });
});

test('native attachment drift or malformed current address fails closed rather than publishing a desired IP', async () => {
  await fixture(async f => {
    const key = f.vmOne.id + ':' + f.selected[0].id;
    for (const state of [{ attached: false, ipv4Address: '10.42.1.130' },
      { attached: true, ipv4Address: '10.42.1.0130' }, { attached: true, ipv4Address: '10.42.1.130\nforged' }]) {
      f.nativeAddresses.set(key, state);
      await expect(f.entries()).rejects.toThrow();
    }
  });
});

test('membership changing during endpoint observation rejects the entire hostname projection', async () => {
  await fixture(async f => {
    const read = f.manager.actualWorkerIds.bind(f.manager);
    let firstReads = 0;
    f.manager.actualWorkerIds = async (...args) => {
      const ids = await read(...args);
      if (args[0].id === f.selected[0].id && ++firstReads === 2)
        return ids.filter(id => id !== f.vmOne.id);
      return ids;
    };
    await expect(f.entries()).rejects.toThrow('membership changed during observation');
  });
});

test('changed Docker Id, NetworkID, endpoint name/address and malformed aliases never yield host entries', async () => {
  await fixture(async f => {
    const original = structuredClone(f.dockerInspection()), name = f.selected[0].dockerName + '-incus';
    for (const patch of [
      (value: any) => { value.Id = 'foreign'; },
      (value: any) => { value.NetworkSettings.Networks[name].NetworkID = 'foreign'; },
      (value: any) => { value.NetworkSettings.Networks[name].IPAddress = '10.42.1.9'; },
      (value: any) => { value.NetworkSettings.Networks[name].Aliases = ['safe', 7]; },
      (value: any) => { value.NetworkSettings.Networks[name].Aliases = 'unsafe'; },
      (value: any) => { value.NetworkSettings.Networks[name].Aliases = ['peer\nforged']; },
    ]) {
      const value = structuredClone(original); patch(value); f.setDockerInspection(value);
      await expect(f.entries()).rejects.toThrow();
    }
    f.setDockerInspection(original);
    const endpoint = f.shared.get(name).Containers[f.docker.containerId];
    endpoint.Name = 'foreign-peer';
    await expect(f.entries()).rejects.toThrow('endpoint changed');
    endpoint.Name = f.docker.containerName;
    endpoint.IPv4Address = 'not-an-address';
    f.dockerInspection().NetworkSettings.Networks[name].IPAddress = 'not-an-address';
    await expect(f.entries()).rejects.toThrow();
  });
});

test('retained aliases cannot impersonate another canonical WorkerRecord including archived names', async () => {
  await fixture(async f => {
    const archivedId = randomUUID();
    await f.workers.upsert({ id: archivedId, userId: f.userId, runtimeKind: 'legacy-docker',
      status: 'archived', displayName: 'archived', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    const attachment = f.dockerInspection().NetworkSettings.Networks[f.selected[0].dockerName + '-incus'];
    for (const alias of [f.vmOne.containerName, f.recipient.containerName.toUpperCase(), 'WORKER-' + archivedId.toUpperCase()]) {
      attachment.Aliases = [alias];
      await expect(f.entries()).rejects.toThrow('alias conflicts with worker identity');
    }
  });
});

test('host hints do not consume user-selected source or IP fields and reject foreign shared bridge policy', async () => {
  await fixture(async f => {
    const record = f.workers.get(f.userId, f.vmOne.id)!;
    await f.workers.upsert({ ...record, source: 'http://user-controlled', ipv4Address: '192.0.2.44' } as any);
    f.vmOne.source = 'http://user-controlled'; f.vmOne.ipv4Address = '192.0.2.45';
    await f.networks.update(f.userId, f.selected[0].id, { source: '/caller/path', ipv4Address: '192.0.2.46' } as any);
    expect((await f.entries()).find(entry => entry.names.includes(f.vmOne.containerName))?.address).toBe('10.42.1.130');
    f.shared.get(f.selected[0].dockerName + '-incus').Options['raw'] = 'caller-config';
    await expect(f.entries()).rejects.toThrow('fixed network policy');
  });
});
