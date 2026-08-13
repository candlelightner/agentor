import { expect, test } from '@playwright/test';
import { updateManagedNetworkAtomically } from '../../orchestrator/server/utils/managed-network-update';

const original = { id: 'network-a', userId: 'owner-a', name: 'before', scope: 'selected' as const,
  groupId: undefined, workerIds: ['worker-a'], dockerName: 'agentor-managed-network-a',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };

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
