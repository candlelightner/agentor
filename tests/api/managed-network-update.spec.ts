import { expect, test } from '@playwright/test';
import { reconcileCreatedManagedNetwork, updateManagedNetworkAtomically } from '../../orchestrator/server/utils/managed-network-update';

const original = { id: 'network-a', userId: 'owner-a', name: 'before', scope: 'selected' as const,
  groupId: undefined, workerIds: ['worker-a'], dockerName: 'agentor-managed-network-a',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };

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
