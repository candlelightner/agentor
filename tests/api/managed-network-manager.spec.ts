import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ManagedNetworkManager } from '../../orchestrator/server/utils/managed-network-manager';

(globalThis as any).createError ??= (options: any) => Object.assign(new Error(options.statusMessage), options);

test('network cleanup refuses foreign or changed runtime identity before any detach or remove', async () => {
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}` } as any;
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
  const id = randomUUID(), network = { id, userId: 'owner', dockerName: `agentor-managed-${id}` } as any;
  const manager = new ManagedNetworkManager(), mutations: any[] = [];
  (manager as any).docker = { getNetwork: () => ({ inspect: async () => ({ Name: network.dockerName,
    Driver: 'bridge', Internal: false, Labels: { 'agentor.managed-network': 'true', 'agentor.owner': network.userId },
    Containers: { peer: {} } }), disconnect: async (options: any) => { mutations.push(options); },
    remove: async () => { mutations.push('remove'); } }) };
  await manager.remove(network);
  expect(mutations).toEqual([{ Container: 'peer', Force: true }, 'remove']);
  (manager as any).docker = { getNetwork: () => ({ inspect: async () => { throw { statusCode: 404 }; } }) };
  await manager.remove(network);
  expect(mutations).toHaveLength(2);
});
