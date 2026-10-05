import { expect, test } from '@playwright/test';
import { authorizeManagedNetworkMutation } from '../../orchestrator/server/utils/managed-network-authorization';
import type { ManagedNetwork } from '../../orchestrator/server/utils/managed-network-store';

const network = { id: 'network-a', userId: 'owner-a', workerIds: ['desired'], scope: 'selected' } as ManagedNetwork;

test('actual drift is included in lock verification before returning mutation coverage', async () => {
  const calls: string[] = [], passwords = { desired: 'desired-unlock', drifted: 'drifted-unlock' };
  const coverage = await authorizeManagedNetworkMutation([network], ['desired'], passwords, {
    actualWorkerIds: async value => { expect(value).toBe(network); calls.push('inspect'); return ['drifted']; },
    verify: async (ids, supplied) => {
      calls.push('verify'); expect([...ids]).toEqual(['desired', 'drifted']); expect(supplied).toBe(passwords);
    },
  });
  expect([...coverage]).toEqual(['desired', 'drifted']);
  expect(calls).toEqual(['inspect', 'verify']);
});

test('an unprovided drifted-worker unlock rejects before mutation dispatch', async () => {
  let dispatched = false;
  const failure = Object.assign(new Error('Worker is protected'), { statusCode: 423 });
  const operation = async () => {
    const coverage = await authorizeManagedNetworkMutation([network], ['desired'], { desired: 'unlock' }, {
      actualWorkerIds: async () => ['drifted'],
      verify: async (ids, supplied) => {
        expect([...ids]).toContain('drifted');
        expect(supplied).not.toHaveProperty('drifted');
        throw failure;
      },
    });
    dispatched = true; return coverage;
  };
  await expect(operation()).rejects.toBe(failure);
  expect(dispatched).toBe(false);
});

test('all desired and actual workers are deduplicated across current and changed networks', async () => {
  const changed = { ...network, id: 'network-b' }, inspected: string[] = [];
  let verified = 0;
  const coverage = await authorizeManagedNetworkMutation([network, changed], new Set(['desired', 'removed']), null, {
    actualWorkerIds: async value => { inspected.push(value.id); return value.id === network.id ? ['removed', 'drifted'] : ['drifted', 'other']; },
    verify: async (ids, supplied) => { verified++; expect([...ids]).toEqual(['desired', 'removed', 'drifted', 'other']); expect(supplied).toBeNull(); },
  });
  expect([...coverage]).toEqual(['desired', 'removed', 'drifted', 'other']);
  expect(inspected).toEqual(['network-a', 'network-b']); expect(verified).toBe(1);
});

test('failed actual-authority lookup does not verify an incomplete set or return coverage', async () => {
  let verified = false;
  await expect(authorizeManagedNetworkMutation([network], ['desired'], {}, {
    actualWorkerIds: async () => { throw new Error('Foreign NIC authority'); },
    verify: async () => { verified = true; },
  })).rejects.toThrow('Foreign NIC authority');
  expect(verified).toBe(false);
});

test('coverage retains only IDs and never reuses passwords from an earlier request', async () => {
  const passwords = { desired: 'private-request-password' }, supplied: unknown[] = [];
  const dependencies = {
    actualWorkerIds: async () => [] as string[],
    verify: async (_ids: Iterable<string>, value: unknown) => { supplied.push(value); },
  };
  const first = await authorizeManagedNetworkMutation([], ['desired'], passwords, dependencies);
  const second = await authorizeManagedNetworkMutation([], ['desired'], undefined, dependencies);
  expect([...first]).toEqual(['desired']); expect([...second]).toEqual(['desired']);
  expect(Object.keys(first)).toEqual([]);
  expect(JSON.stringify([...first])).not.toContain(passwords.desired);
  expect(supplied).toEqual([passwords, undefined]);
});

