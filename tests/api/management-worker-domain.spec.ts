import { test, expect } from '@playwright/test';
import { ManagementWorkerDomain } from '../../orchestrator/server/utils/management-worker-domain';

test('management worker domain declares bounded worker, configuration, group, and lock tools', () => {
  const tools = new ManagementWorkerDomain().tools();
  const names = tools.map(tool => tool.name);
  for (const name of ['workers.create','workers.update','workers.restart','workers.rebuild','workers.archive','workers.unarchive','workers.delete','workers.clone','configuration.get','configuration.set','groups.list','groups.create','groups.update','groups.delete','locks.get','locks.set','locks.remove']) expect(names).toContain(name);
  expect(tools.find(tool => tool.name === 'locks.set')?.inputSchema).toMatchObject({ type:'object', required:['workerId','password'] });
  expect(tools.find(tool => tool.name === 'workers.delete')?.annotations).toMatchObject({ destructiveHint:true, readOnlyHint:false });
  expect(tools.find(tool => tool.name === 'configuration.get')?.annotations).toMatchObject({ readOnlyHint:true });
  expect((tools.find(tool => tool.name === 'workers.create')?.inputSchema as any).properties).toMatchObject({
    imageDefinitionId:{type:'string'},
    imageVersion:{type:'string'},
  });
  expect((tools.find(tool => tool.name === 'locks.set')?.inputSchema as any).properties).toMatchObject({
    password:{type:'string',writeOnly:true},
    currentPassword:{type:'string',writeOnly:true},
  });
  expect((tools.find(tool => tool.name === 'locks.remove')?.inputSchema as any).properties.password).toMatchObject({type:'string',writeOnly:true});
});
