import { test, expect } from '@playwright/test';
import { ManagementWorkerDomain, withinManagementFailFastDeadline } from '../../orchestrator/server/utils/management-worker-domain';
import { workerGroupsWithMemberCounts, workerGroupWithMemberCounts } from '../../orchestrator/server/utils/worker-group-response';

test('management worker domain declares bounded worker, configuration, group, and lock tools', () => {
  const tools = new ManagementWorkerDomain().tools();
  const names = tools.map(tool => tool.name);
  for (const name of ['workers.create','workers.update','workers.restart','workers.recover','workers.rebuild','workers.archive','workers.unarchive','workers.delete','workers.clone','workers.env-keys','configuration.get','configuration.set','groups.list','groups.create','groups.update','groups.delete','groups.workers.stop','groups.workers.rebuild','groups.workers.archive','groups.assign-worker','groups.env.list','groups.env.update','locks.get','locks.set','locks.remove']) expect(names).toContain(name);
  expect(tools.find(tool => tool.name === 'locks.set')?.inputSchema).toMatchObject({ type:'object', required:['workerId','password'] });
  expect(tools.find(tool => tool.name === 'workers.delete')?.annotations).toMatchObject({ destructiveHint:true, readOnlyHint:false });
  expect(tools.find(tool => tool.name === 'workers.recover')?.description).toContain('Persistent mounts');
  expect(tools.find(tool => tool.name === 'configuration.get')?.annotations).toMatchObject({ readOnlyHint:true });
  expect((tools.find(tool => tool.name === 'workers.create')?.inputSchema as any).properties).toMatchObject({
    imageDefinitionId:{type:'string'},
    imageVersion:{type:'string'},
    workerGroupId:{type:'string'},
    workerSelfApiAccess:{type:'string',enum:['inherit','allow','deny']},
  });
  expect((tools.find(tool => tool.name === 'workers.update')?.inputSchema as any).properties.workerSelfApiAccess)
    .toMatchObject({type:'string',enum:['inherit','allow','deny']});
  expect((tools.find(tool => tool.name === 'groups.create')?.inputSchema as any).properties.workerSelfApiAccess)
    .toMatchObject({type:'string',enum:['inherit','allow','deny']});
  expect((tools.find(tool => tool.name === 'groups.update')?.inputSchema as any).properties.workerSelfApiAccess)
    .toMatchObject({type:'string',enum:['inherit','allow','deny']});
  for (const name of ['workers.create', 'workers.update', 'groups.create', 'groups.update'])
    expect(tools.find(tool => tool.name === name)?.description).toContain('immediate');
  const createMount = (tools.find(tool => tool.name === 'workers.create')?.inputSchema as any).properties.mounts.items;
  expect(createMount).toMatchObject({ additionalProperties:false, required:['pathId','target'] });
  expect(createMount.properties).not.toHaveProperty('source');
  expect((tools.find(tool => tool.name === 'locks.set')?.inputSchema as any).properties).toMatchObject({
    password:{type:'string',writeOnly:true},
    currentPassword:{type:'string',writeOnly:true},
  });
  expect((tools.find(tool => tool.name === 'locks.remove')?.inputSchema as any).properties.password).toMatchObject({type:'string',writeOnly:true});
  expect((tools.find(tool => tool.name === 'groups.assign-worker')?.inputSchema as any).properties.targetGroupId).toMatchObject({type:['string','null']});
  expect((tools.find(tool => tool.name === 'groups.assign-worker')?.inputSchema as any).required).toEqual(['workerId','targetGroupId']);
  const groupEnvUpdate = tools.find(tool => tool.name === 'groups.env.update')?.inputSchema as any;
  expect(groupEnvUpdate).toMatchObject({ additionalProperties:false, required:['groupId'] });
  expect(groupEnvUpdate.properties.entries.items).toMatchObject({ additionalProperties:false, required:['key','value'] });
  expect(groupEnvUpdate.properties.entries.items.properties.value).toMatchObject({ type:'string', writeOnly:true });
  expect(tools.find(tool => tool.name === 'workers.env-keys')?.annotations).toMatchObject({ readOnlyHint:true });
  for (const name of ['workers.env-keys','groups.list','groups.create','groups.update','groups.delete','groups.assign-worker','groups.env.list','groups.env.update']) {
    const schema = tools.find(tool => tool.name === name)?.inputSchema as any;
    expect(schema).toMatchObject({ additionalProperties:false });
    expect(schema.properties.timeoutSeconds).toMatchObject({ type:'integer', minimum:1, maximum:120 });
    expect(schema.properties.timeoutSeconds.description).toContain('structured 504 error');
    expect(tools.find(tool => tool.name === name)?.description).toContain('timeoutSeconds');
  }
  for (const name of ['groups.workers.stop','groups.workers.rebuild','groups.workers.archive']) {
    const tool = tools.find(item => item.name === name)!;
    const schema = tool.inputSchema as any;
    expect(schema).toMatchObject({
      type:'object',
      additionalProperties:false,
      required:['groupId'],
    });
    expect(schema.properties.lockPasswords.additionalProperties).toMatchObject({
      type:'string',
      writeOnly:true,
    });
    expect(schema.properties.timeoutSeconds).toMatchObject({
      type:'integer',
      minimum:1,
      maximum:900,
    });
    expect(tool.description).toContain('descendant');
    expect(tool.description).toContain('Administrative workspaces are not affected');
  }
});

test('recursive management fail-fast deadline returns a structured timeout error', async () => {
  const started = Date.now();
  await expect(withinManagementFailFastDeadline(
    () => new Promise<void>(() => {}),
    0.01,
    'groups.env.list',
  )).rejects.toMatchObject({ statusCode:504, message:expect.stringContaining('groups.env.list') });
  expect(Date.now() - started).toBeLessThan(1000);
});

test('recursive management tools reject invalid timeout switches before work', async () => {
  await expect(new ManagementWorkerDomain().execute('groups.list', { timeoutSeconds:0 }))
    .rejects.toMatchObject({ statusCode:400, message:expect.stringContaining('timeoutSeconds') });
});

test('public group projections retain administrative CPU settings without native authority or pending receipts', () => {
  const group: any = { id: 'public-group-fixture', userId: 'fixture-owner', name: 'Public group', workerIds: [],
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    adminWorkspace: { id: 'fixture-admin', kind: 'group-administrative', runtimeKind: 'incus-vm', status: 'stopped',
      vcpuCount: 3, services: ['terminal', 'editor', 'desktop'],
      nativeRuntime: { pending: { kind: 'cpu', cpu: { previousCount: 2, vcpuCount: 3, definitionFingerprint: 'synthetic-private-receipt' } } },
      nativeMigration: { phase: 'retained', nonce: 'synthetic-private-migration' } } };
  const before = structuredClone(group);
  const list = workerGroupsWithMemberCounts([group], []);
  const single = workerGroupWithMemberCounts(group, [], [group]);
  const fallback = workerGroupWithMemberCounts(group, [], []);
  for (const response of [list[0]!, single, fallback]) {
    expect(response.adminWorkspace).toEqual({ id: 'fixture-admin', kind: 'group-administrative', runtimeKind: 'incus-vm',
      status: 'stopped', vcpuCount: 3, services: ['terminal', 'editor', 'desktop'] });
    expect(JSON.stringify(response)).not.toContain('synthetic-private');
    expect(response.memberCounts).toEqual({ total: 0, active: 0, archived: 0 });
  }
  expect(group).toEqual(before);
  const { adminWorkspace: _admin, ...ordinary } = group;
  expect(workerGroupsWithMemberCounts([ordinary], [])[0]).not.toHaveProperty('adminWorkspace');
});
