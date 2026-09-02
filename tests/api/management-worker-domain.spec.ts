import { test, expect } from '@playwright/test';
import { ManagementWorkerDomain, withinManagementFailFastDeadline } from '../../orchestrator/server/utils/management-worker-domain';

test('management worker domain declares bounded worker, configuration, group, and lock tools', () => {
  const tools = new ManagementWorkerDomain().tools();
  const names = tools.map(tool => tool.name);
  for (const name of ['workers.create','workers.update','workers.restart','workers.rebuild','workers.archive','workers.unarchive','workers.delete','workers.clone','workers.env-keys','configuration.get','configuration.set','groups.list','groups.create','groups.update','groups.delete','groups.workers.stop','groups.workers.rebuild','groups.workers.archive','groups.assign-worker','groups.env.list','groups.env.update','locks.get','locks.set','locks.remove']) expect(names).toContain(name);
  expect(tools.find(tool => tool.name === 'locks.set')?.inputSchema).toMatchObject({ type:'object', required:['workerId','password'] });
  expect(tools.find(tool => tool.name === 'workers.delete')?.annotations).toMatchObject({ destructiveHint:true, readOnlyHint:false });
  expect(tools.find(tool => tool.name === 'configuration.get')?.annotations).toMatchObject({ readOnlyHint:true });
  expect((tools.find(tool => tool.name === 'workers.create')?.inputSchema as any).properties).toMatchObject({
    imageDefinitionId:{type:'string'},
    imageVersion:{type:'string'},
    workerGroupId:{type:'string'},
  });
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
