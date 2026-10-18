import { expect, test } from '@playwright/test';
import { reconcileCreatedManagedNetwork, updateManagedNetworkAtomically } from '../../orchestrator/server/utils/managed-network-update';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

const original = { id: 'network-a', userId: 'owner-a', name: 'before', scope: 'selected' as const,
  groupId: undefined, workerIds: ['worker-a'], dockerName: 'agentor-managed-network-a',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };

function pendingFailure() {
  const settlement = new Promise<void>(() => {});
  const error = Object.assign(new Error('native operation still pending'), { statusCode: 504 });
  Object.defineProperty(error, operationSettlement, { value: settlement, enumerable: false });
  return { error, settlement };
}

test('unsettled creation failure retains record without beginning runtime or record cleanup', async () => {
  const { error, settlement } = pendingFailure(), calls: string[] = [];
  const records = new Map([[original.id, original]]);
  await expect(reconcileCreatedManagedNetwork(original, {
    reconcile: async () => { calls.push('reconcile'); throw error; },
    removeRuntime: async () => { calls.push('runtime cleanup'); },
    removeRecord: async (_owner, id) => { calls.push('record cleanup'); records.delete(id); },
  })).rejects.toBe(error);
  expect(calls).toEqual(['reconcile']); expect(records.get(original.id)).toBe(original);
  expect((error as any)[operationSettlement]).toBe(settlement);
});

test('unsettled runtime cleanup preserves raw settlement and prevents record deletion', async () => {
  const { error, settlement } = pendingFailure(), calls: string[] = [];
  await expect(reconcileCreatedManagedNetwork(original, {
    reconcile: async () => { calls.push('reconcile'); throw new Error('settled attach failure'); },
    removeRuntime: async () => { calls.push('runtime cleanup'); throw error; },
    removeRecord: async () => { calls.push('record cleanup'); },
  })).rejects.toBe(error);
  expect(calls).toEqual(['reconcile', 'runtime cleanup']);
  expect((error as any)[operationSettlement]).toBe(settlement);
});

test('unsettled record cleanup preserves exact failure authority without further runtime calls', async () => {
  const { error, settlement } = pendingFailure(), calls: string[] = [];
  await expect(reconcileCreatedManagedNetwork(original, {
    reconcile: async () => { calls.push('reconcile'); throw new Error('settled attach failure'); },
    removeRuntime: async () => { calls.push('runtime cleanup'); },
    removeRecord: async () => { calls.push('record cleanup'); throw error; },
  })).rejects.toBe(error);
  expect(calls).toEqual(['reconcile', 'runtime cleanup', 'record cleanup']);
  expect((error as any)[operationSettlement]).toBe(settlement);
});

test('unsettled update failure retains updated desired state without starting either rollback', async () => {
  const { error, settlement } = pendingFailure(), calls: string[] = [];
  let saved = original;
  await expect(updateManagedNetworkAtomically(original, { name: 'after' }, {
    update: async (_owner, _id, patch) => { calls.push('persist'); saved = { ...original, ...patch }; return saved; },
    reconcile: async value => { calls.push(`reconcile ${value.name}`); throw error; },
  })).rejects.toBe(error);
  expect(calls).toEqual(['persist', 'reconcile after']); expect(saved.name).toBe('after');
  expect((error as any)[operationSettlement]).toBe(settlement);
});

test('unsettled persistence rollback prevents topology rollback and preserves raw authority', async () => {
  const { error, settlement } = pendingFailure(), calls: string[] = [];
  await expect(updateManagedNetworkAtomically(original, { name: 'after' }, {
    update: async (_owner, _id, patch) => { calls.push(`persist ${patch.name}`); if (patch.name === original.name) throw error; return { ...original, ...patch }; },
    reconcile: async value => { calls.push(`reconcile ${value.name}`); throw new Error('settled attach failure'); },
  })).rejects.toBe(error);
  expect(calls).toEqual(['persist after', 'reconcile after', 'persist before']);
  expect((error as any)[operationSettlement]).toBe(settlement);
});

test('unsettled topology rollback is not wrapped or followed by more runtime operations', async () => {
  const { error, settlement } = pendingFailure(), calls: string[] = [];
  await expect(updateManagedNetworkAtomically(original, { name: 'after' }, {
    update: async (_owner, _id, patch) => { calls.push(`persist ${patch.name}`); return { ...original, ...patch }; },
    reconcile: async value => { calls.push(`reconcile ${value.name}`); if (value.name === original.name) throw error; throw new Error('settled attach failure'); },
  })).rejects.toBe(error);
  expect(calls).toEqual(['persist after', 'reconcile after', 'persist before', 'reconcile before']);
  expect((error as any)[operationSettlement]).toBe(settlement);
});

test('failed creation retains desired authority when runtime cleanup fails', async () => {
  const records = new Map([[original.id, original]]);
  const forwardError = new Error('attach failed');
  const cleanupError = new Error('bridge still in use');
  const calls: string[] = [];
  await expect(reconcileCreatedManagedNetwork(original, {
    reconcile: async () => { throw forwardError; },
    removeRuntime: async network => { expect(network).toBe(original); calls.push('runtime'); throw cleanupError; },
    removeRecord: async (_ownerId, id) => { calls.push('record'); records.delete(id); },
  })).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining('record retained for recovery'), cause: { forwardError, cleanupError } });
  expect(calls).toEqual(['runtime']);
  expect(records.get(original.id)).toBe(original);
});

test('failed creation removes record once only after successful runtime cleanup', async () => {
  const records = new Map([[original.id, original]]);
  const calls: string[] = [];
  await expect(reconcileCreatedManagedNetwork(original, {
    reconcile: async () => ({ workerIds: original.workerIds, partialFailures: ['attach failed'] }),
    removeRuntime: async () => { calls.push('runtime'); },
    removeRecord: async (ownerId, id) => { expect([ownerId, id]).toEqual([original.userId, original.id]); calls.push('record'); records.delete(id); },
  })).rejects.toMatchObject({ statusCode: 409, message: 'attach failed' });
  expect(calls).toEqual(['runtime', 'record']);
  expect(records.has(original.id)).toBe(false);
});

test('failed creation surfaces record cleanup failure without hiding recovery state', async () => {
  const records = new Map([[original.id, original]]);
  const forwardError = new Error('attach failed');
  const cleanupError = new Error('disk write failed');
  let runtimeRemovals = 0;
  let recordRemovals = 0;
  await expect(reconcileCreatedManagedNetwork(original, {
    reconcile: async () => { throw forwardError; },
    removeRuntime: async () => { runtimeRemovals++; },
    removeRecord: async () => { recordRemovals++; throw cleanupError; },
  })).rejects.toMatchObject({ statusCode: 500, message: 'Managed network creation failed and record cleanup was incomplete', cause: { forwardError, cleanupError } });
  expect(records.get(original.id)).toBe(original);
  expect([runtimeRemovals, recordRemovals]).toEqual([1, 1]);
});

test('successful creation returns reconciliation without attempting cleanup', async () => {
  const reconciliation = { workerIds: original.workerIds, partialFailures: [] };
  expect(await reconcileCreatedManagedNetwork(original, {
    reconcile: async () => reconciliation,
    removeRuntime: async () => { throw new Error('unexpected runtime cleanup'); },
    removeRecord: async () => { throw new Error('unexpected record cleanup'); },
  })).toEqual({ ...original, reconciliation });
});

test('thrown reconciliation failures restore desired state and prior topology', async () => {
  const updates: any[] = []; const reconciled: string[] = [];
  await expect(updateManagedNetworkAtomically(original,{name:'after'}, {
    update: async (_owner,_id,patch) => { updates.push(patch); return {...original,...patch}; },
    reconcile: async network => { reconciled.push(network.name); if(network.name==='after')throw Object.assign(new Error('Docker inspect failed'),{statusCode:409}); return {workerIds:network.workerIds,partialFailures:[]}; },
  })).rejects.toThrow('Docker inspect failed');
  expect(updates).toEqual([{name:'after'},{name:'before',scope:'selected',groupId:'',workerIds:['worker-a']}]);
  expect(reconciled).toEqual(['after','before']);
});

test('partial failures roll back and incomplete rollback is surfaced', async () => {
  let reconcileCalls=0;
  await expect(updateManagedNetworkAtomically(original,{name:'after'}, {
    update: async (_owner,_id,patch) => ({...original,...patch}),
    reconcile: async network => { reconcileCalls++; return {workerIds:network.workerIds,partialFailures:[reconcileCalls===1?'attach failed':'rollback detach failed']}; },
  })).rejects.toMatchObject({statusCode:500,message:'Managed network update failed and rollback was incomplete'});
  expect(reconcileCalls).toBe(2);
});

test('topology rollback still runs when desired-state restoration throws', async () => {
  let updates=0; const reconciled:string[]=[];
  await expect(updateManagedNetworkAtomically(original,{name:'after'}, {
    update: async (_owner,_id,patch) => { updates++; if(updates===2)throw new Error('disk write failed'); return {...original,...patch}; },
    reconcile: async network => { reconciled.push(network.name); if(network.name==='after')throw new Error('Docker update failed'); return {workerIds:network.workerIds,partialFailures:[]}; },
  })).rejects.toMatchObject({statusCode:500,message:'Managed network update failed and rollback was incomplete'});
  expect(reconciled).toEqual(['after','before']);
});
