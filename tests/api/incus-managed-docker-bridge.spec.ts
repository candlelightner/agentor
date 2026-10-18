import { expect, test } from '@playwright/test';
import type Docker from 'dockerode';
import { IncusManagedDockerBridge } from '../../orchestrator/server/utils/incus-managed-docker-bridge';
import { incusManagedBridgeIdentity } from '../../orchestrator/server/utils/incus-managed-network-identity';
import type { ManagedNetwork } from '../../orchestrator/server/utils/managed-network-store';
import type { IncusManagedBridge } from '../../orchestrator/server/utils/incus-managed-network-host';

const network: ManagedNetwork = {
  id: '11111111-2222-4333-8444-555555555555', userId: 'owner-a', name: 'shared',
  dockerName: 'agentor-managed-11111111-2222-4333-8444-555555555555', scope: 'selected',
  workerIds: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};
const installation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const bridge: IncusManagedBridge = {
  name: incusManagedBridgeIdentity(installation, network).name, installation,
  userId: network.userId, networkId: network.id, gateway: '10.75.23.1',
  subnet: '10.75.23.0/24', dockerRange: '10.75.23.0/26',
};

function ownedInspection(): Docker.NetworkInspectInfo {
  return {
    Name: `${network.dockerName}-incus`, Id: 'a'.repeat(64), Driver: 'bridge', Internal: false,
    EnableIPv6: false, Created: new Date(0).toISOString(), Scope: 'local', Attachable: false,
    Ingress: false, ConfigOnly: false, Containers: {},
    Labels: { 'agentor.managed-network': 'true', 'agentor.owner': network.userId,
      'agentor.network-id': network.id, 'agentor.installation': installation },
    Options: { 'com.docker.network.bridge.name': bridge.name, 'com.docker.network.bridge.inhibit_ipv4': 'true' },
    IPAM: { Driver: 'default', Options: {}, Config: [{ Subnet: bridge.subnet, IPRange: bridge.dockerRange, Gateway: bridge.gateway }] },
  };
}

function fixture(initial: Docker.NetworkInspectInfo | null = ownedInspection()) {
  let state = initial;
  const lookups: string[] = [], created: any[] = [], removed: string[] = [];
  let inspectionError: unknown, creationError: unknown;
  let createdInspection: Docker.NetworkInspectInfo | null = ownedInspection();
  const docker = {
    getNetwork: (name: string) => {
      lookups.push(name);
      return {
        inspect: async () => {
          if (inspectionError) throw inspectionError;
          if (!state) throw Object.assign(new Error('not found'), { statusCode: 404 });
          return structuredClone(state);
        },
        remove: async () => { removed.push(name); state = null; },
        disconnect: async () => { throw new Error('adapter must never disconnect'); },
      };
    },
    createNetwork: async (options: any) => {
      created.push(options);
      if (creationError) throw creationError;
      state = createdInspection;
      return {};
    },
  } as unknown as Pick<Docker, 'getNetwork' | 'createNetwork'>;
  return {
    adapter: new IncusManagedDockerBridge(docker), lookups, created, removed,
    setInspectionError: (error: unknown) => { inspectionError = error; },
    setCreationError: (error: unknown) => { creationError = error; },
    setCreatedInspection: (value: Docker.NetworkInspectInfo | null) => { createdInspection = value; },
  };
}

test('owned adapter is idempotent and never resolves the original legacy Docker network', async () => {
  const f = fixture();
  expect(await f.adapter.inspect(network, bridge)).toEqual(ownedInspection());
  expect(await f.adapter.ensure(network, bridge)).toEqual(ownedInspection());
  expect(f.created).toEqual([]);
  expect(f.lookups).toEqual([`${network.dockerName}-incus`, `${network.dockerName}-incus`]);
});

test('creation joins only the native bridge with disjoint Docker allocation and re-inspects ownership', async () => {
  const f = fixture(null);
  expect(await f.adapter.ensure(network, bridge)).toEqual(ownedInspection());
  expect(f.created).toHaveLength(1);
  const { abortSignal, ...options } = f.created[0];
  expect(abortSignal).toBeInstanceOf(AbortSignal);
  expect(options).toEqual({
    Name: `${network.dockerName}-incus`, Driver: 'bridge', CheckDuplicate: true, Internal: false, EnableIPv6: false,
    Labels: ownedInspection().Labels, Options: ownedInspection().Options,
    IPAM: { Driver: 'default', Config: [{ Subnet: bridge.subnet, IPRange: bridge.dockerRange, Gateway: bridge.gateway }] },
  });
  expect(f.lookups).toEqual([`${network.dockerName}-incus`, `${network.dockerName}-incus`]);
  expect(f.removed).toEqual([]);
});

test('foreign labels, native bridge device, geometry and raw options never authorize ensure or deletion', async () => {
  const mutations: ((value: Docker.NetworkInspectInfo) => void)[] = [
    value => { value.Name = network.dockerName; }, value => { value.Id = ''; },
    value => { value.Driver = 'overlay'; }, value => { value.Internal = true; }, value => { value.EnableIPv6 = true; },
    ...['agentor.managed-network', 'agentor.owner', 'agentor.network-id', 'agentor.installation'].map(key =>
      (value: Docker.NetworkInspectInfo) => { value.Labels![key] = 'foreign'; }),
    value => { value.Labels!['foreign'] = 'extra'; },
    value => { value.Options!['com.docker.network.bridge.name'] = 'foreign'; },
    value => { value.Options!['com.docker.network.bridge.inhibit_ipv4'] = 'false'; },
    value => { value.Options!['com.docker.network.bridge.enable_ip_masquerade'] = 'true'; },
    value => { delete value.Options; }, value => { delete value.IPAM; },
    value => { value.IPAM!.Driver = 'foreign'; }, value => { value.IPAM!.Options = { raw: 'foreign' }; },
    value => { Object.assign(value.IPAM!, { raw: 'foreign' }); },
    value => { value.IPAM!.Config![0]!.Subnet = '10.75.0.0/16'; },
    value => { value.IPAM!.Config![0]!.IPRange = '10.75.23.0/24'; },
    value => { value.IPAM!.Config![0]!.Gateway = '10.75.23.2'; },
    value => { value.IPAM!.Config![0]!.AuxiliaryAddresses = { stolen: '10.75.23.130' }; },
    value => { value.IPAM!.Config!.push({ Subnet: 'fd00::/64' }); },
    value => { Object.assign(value.IPAM!.Config![0]!, { raw: 'foreign' }); },
  ];
  for (const mutate of mutations) {
    const value = ownedInspection(); mutate(value); const f = fixture(value);
    await expect(f.adapter.ensure(network, bridge)).rejects.toThrow('ownership or fixed network policy');
    await expect(f.adapter.remove(network, bridge)).rejects.toThrow('ownership or fixed network policy');
    expect(f.created).toEqual([]); expect(f.removed).toEqual([]);
  }
});

test('invalid bridge authority or overlapping allocation fails before Docker is contacted', async () => {
  for (const patch of [{ name: 'foreign' }, { installation: 'foreign' }, { userId: 'foreign' },
    { networkId: 'foreign' }, { gateway: '192.0.2.1' }, { gateway: '10.75.23.2' },
    { subnet: '10.75.23.0/16' }, { dockerRange: '10.75.23.0/24' }]) {
    const f = fixture();
    await expect(f.adapter.ensure(network, { ...bridge, ...patch })).rejects.toThrow(/authority|geometry/);
    await expect(f.adapter.remove(network, { ...bridge, ...patch })).rejects.toThrow(/authority|geometry/);
    expect(f.lookups).toEqual([]);
  }
  const f = fixture();
  await expect(f.adapter.ensure({ ...network, dockerName: 'bridge' }, bridge)).rejects.toThrow('Invalid managed network authority');
  expect(f.lookups).toEqual([]);
});

test('missing adapter is removable but read or creation uncertainty never triggers mutation cleanup', async () => {
  const missing = fixture(null);
  expect(await missing.adapter.inspect(network, bridge)).toBeNull();
  await missing.adapter.remove(network, bridge);
  expect(missing.created).toEqual([]); expect(missing.removed).toEqual([]);
  for (const statusCode of [403, 500]) {
    const f = fixture(); f.setInspectionError(Object.assign(new Error('unavailable'), { statusCode }));
    await expect(f.adapter.ensure(network, bridge)).rejects.toThrow('unavailable');
    await expect(f.adapter.remove(network, bridge)).rejects.toThrow('unavailable');
    expect(f.created).toEqual([]); expect(f.removed).toEqual([]);
  }
  const f = fixture(null); f.setCreationError(new Error('creation response lost'));
  await expect(f.adapter.ensure(network, bridge)).rejects.toThrow('creation response lost');
  expect(f.removed).toEqual([]);
});

test('post-create policy failure never destroys ambiguous resources', async () => {
  const f = fixture(null), foreign = ownedInspection(); foreign.Labels!['agentor.owner'] = 'foreign';
  f.setCreatedInspection(foreign);
  await expect(f.adapter.ensure(network, bridge)).rejects.toThrow('ownership or fixed network policy');
  expect(f.created).toHaveLength(1); expect(f.removed).toEqual([]);
  const missing = fixture(null); missing.setCreatedInspection(null);
  await expect(missing.adapter.ensure(network, bridge)).rejects.toThrow('Created Docker shared Incus bridge is missing');
  expect(missing.created).toHaveLength(1); expect(missing.removed).toEqual([]);
});

test('removal refuses attached endpoints and pins the exact inspected Docker identity', async () => {
  const unknown = ownedInspection(); delete unknown.Containers;
  const uncertain = fixture(unknown);
  await expect(uncertain.adapter.remove(network, bridge)).rejects.toThrow('endpoint state is unavailable');
  expect(uncertain.removed).toEqual([]);
  const populated = ownedInspection(); populated.Containers = { peer: {} as Docker.NetworkContainer };
  const blocked = fixture(populated);
  await expect(blocked.adapter.remove(network, bridge)).rejects.toThrow('attached endpoints');
  expect(blocked.removed).toEqual([]);
  const f = fixture(); await f.adapter.remove(network, bridge); await f.adapter.remove(network, bridge);
  expect(f.removed).toEqual([ownedInspection().Id]);
  expect(f.lookups).not.toContain(network.dockerName);
});
