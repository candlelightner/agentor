import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminWorkspaceStore, type AdminWorkspaceRuntimeAdapter } from '../../orchestrator/server/utils/admin-workspace-store';
import { GroupAdminWorkspaceStore } from '../../orchestrator/server/utils/group-admin-workspace-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { test, expect } from '@playwright/test';
import { refreshAdministrativeWorkspaceIdentities } from '../../orchestrator/server/utils/admin-workspace-refresh';

test('global admin failure still refreshes every existing group admin and reports the original failure', async () => {
  const failure = Object.assign(new Error('Global authority unavailable'), { statusCode: 503 });
  const calls: string[] = [], errors: unknown[] = [], credentials = new Map<string, string>();
  await refreshAdministrativeWorkspaceIdentities(
    async () => { calls.push('global'); throw failure; },
    () => [{ id: 'plain-group' }, { id: 'first', adminWorkspace: {} }, { id: 'second', adminWorkspace: {} }],
    async id => { calls.push(id); credentials.set(id, 'fresh-' + id); },
    error => errors.push(error),
  );
  expect(calls).toEqual(['global', 'first', 'second']);
  expect([...credentials.keys()]).toEqual(['first', 'second']);
  expect(errors).toEqual([failure]); expect(errors[0]).toBe(failure);
});

test('an earlier group failure preserves its error and does not starve later group identities', async () => {
  const failure = Object.assign(new Error('First group operation pending'), { statusCode: 503 });
  const calls: string[] = [], errors: unknown[] = [], credentials = new Map<string, string>();
  await refreshAdministrativeWorkspaceIdentities(
    async () => { calls.push('global'); },
    () => [{ id: 'failed', adminWorkspace: {} }, { id: 'healthy', adminWorkspace: {} }],
    async id => { calls.push(id); if (id === 'failed') throw failure; credentials.set(id, 'fresh'); },
    error => errors.push(error),
  );
  expect(calls).toEqual(['global', 'failed', 'healthy']);
  expect(credentials.has('failed')).toBe(false); expect(credentials.get('healthy')).toBe('fresh');
  expect(errors).toEqual([failure]); expect(errors[0]).toBe(failure);
});

test('unavailable group registry fails closed without guessing group identities', async () => {
  const failure = new Error('Group registry unavailable'), errors: unknown[] = [];
  let globalCalls = 0, groupCalls = 0;
  await refreshAdministrativeWorkspaceIdentities(
    async () => { globalCalls++; },
    () => { throw failure; },
    async () => { groupCalls++; },
    error => errors.push(error),
  );
  expect(globalCalls).toBe(1); expect(groupCalls).toBe(0); expect(errors).toEqual([failure]);
});

test('an earlier failed pass does not cache or suppress the next explicit admin refresh', async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const refresh = () => refreshAdministrativeWorkspaceIdentities(
    async () => {},
    () => [{ id: 'group', adminWorkspace: {} }],
    async () => { if (++calls === 1) throw new Error('transient'); },
    error => errors.push(error),
  );
  await refresh(); await refresh(); expect(calls).toBe(2); expect(errors).toHaveLength(1);
});

function boundRuntime(calls: string[]): AdminWorkspaceRuntimeAdapter {
  return {
    ensure: async record => { expect(record.runtimeKind).toBe('incus-vm'); calls.push('ensure'); },
    start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); },
    rebuild: async () => { calls.push('rebuild'); }, remove: async () => { calls.push('remove'); },
  };
}

test('unbound platform lifecycle returns 503 before creating metadata; explicit binding enables native creation', async () => {
  const directory=await mkdtemp(join(tmpdir(),'admin-unbound-global-'));
  try {
    const store=new AdminWorkspaceStore(directory);await store.init();
    for(const operation of [()=>store.ensure(),()=>store.setStatus('running'),()=>store.setStatus('stopped'),()=>store.rebuild()])
      await expect(operation()).rejects.toMatchObject({statusCode:503});
    expect(store.getRecord()).toBeUndefined();
    await expect(readFile(join(directory,'admin/workspace.v1.json'))).rejects.toMatchObject({code:'ENOENT'});
    const calls:string[]=[];store.setRuntimeAdapter(boundRuntime(calls));
    expect((await store.ensure()).runtimeKind).toBe('incus-vm');
    await store.setStatus('stopped');await store.rebuild();expect(calls).toEqual(['ensure','stop','rebuild']);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('unbound existing platform authority remains readable while lifecycle calls preserve exact bytes and status', async () => {
  const directory=await mkdtemp(join(tmpdir(),'admin-unbound-existing-'));
  try {
    const creator=new AdminWorkspaceStore(directory);creator.setRuntimeAdapter(boundRuntime([]));await creator.ensure();
    const path=join(directory,'admin/workspace.v1.json'),before=await readFile(path,'utf8');
    const store=new AdminWorkspaceStore(directory);await store.init();const record=store.getRecord();
    for(const operation of [()=>store.ensure(),()=>store.setStatus('running'),()=>store.setStatus('stopped'),()=>store.rebuild()])
      await expect(operation()).rejects.toMatchObject({statusCode:503});
    expect(store.getRecord()).toEqual(record);expect(await readFile(path,'utf8')).toBe(before);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('unbound group lifecycle cannot create or change administrative metadata and binding enables normal native actions', async () => {
  const directory=await mkdtemp(join(tmpdir(),'admin-unbound-group-'));
  try {
    const groups=new WorkerGroupStore(directory);await groups.init();const group=await groups.create('owner','group');
    const store=new GroupAdminWorkspaceStore(groups,async(_owner,operation)=>operation());
    const path=join(directory,'users/owner/worker-groups.json'),before=await readFile(path,'utf8');
    for(const operation of [()=>store.ensure(group.id),()=>store.setStatus(group.id,'running'),()=>store.setStatus(group.id,'stopped'),()=>store.rebuild(group.id)])
      await expect(operation()).rejects.toMatchObject({statusCode:503});
    expect(groups.findById(group.id)!.adminWorkspace).toBeUndefined();expect(await readFile(path,'utf8')).toBe(before);
    // A group without any administrative runtime still needs no admin cleanup.
    await store.remove(group.id);expect(await readFile(path,'utf8')).toBe(before);
    const calls:string[]=[];store.setRuntimeAdapter(boundRuntime(calls));await store.ensure(group.id);
    await store.setStatus(group.id,'stopped');await store.rebuild(group.id);expect(calls).toEqual(['ensure','stop','rebuild']);
    const record=groups.findById(group.id)!.adminWorkspace!,existingBytes=await readFile(path,'utf8');
    const unbound=new GroupAdminWorkspaceStore(groups,async(_owner,operation)=>operation());
    expect(unbound.findByWorkspaceId(record.id)).toEqual(record);
    for(const operation of [()=>unbound.ensure(group.id),()=>unbound.setStatus(group.id,'stopped'),()=>unbound.rebuild(group.id),()=>unbound.remove(group.id),()=>unbound.restoreAfterFailedGroupDelete(group.id)])
      await expect(operation()).rejects.toMatchObject({statusCode:503});
    expect(unbound.findByWorkspaceId(record.id)).toEqual(record);expect(await readFile(path,'utf8')).toBe(existingBytes);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('failed deletion rollback of an ordinary group never creates a new administrative VM', async () => {
  const directory=await mkdtemp(join(tmpdir(),'admin-ordinary-group-rollback-'));
  try {
    const groups=new WorkerGroupStore(directory);await groups.init();const group=await groups.create('owner','plain group');
    const store=new GroupAdminWorkspaceStore(groups,async(_owner,operation)=>operation()),calls:string[]=[];
    store.setRuntimeAdapter(boundRuntime(calls));
    const path=join(directory,'users/owner/worker-groups.json'),before=await readFile(path,'utf8');
    await store.remove(group.id);await store.restoreAfterFailedGroupDelete(group.id);
    expect(calls).toEqual([]);expect(groups.findById(group.id)!.adminWorkspace).toBeUndefined();
    expect(await readFile(path,'utf8')).toBe(before);
  } finally {await rm(directory,{recursive:true,force:true});}
});
