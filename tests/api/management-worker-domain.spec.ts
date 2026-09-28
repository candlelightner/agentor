import { test, expect } from '@playwright/test';
import { ManagementWorkerDomain, managementRuntimeAdministrator, withinManagementFailFastDeadline } from '../../orchestrator/server/utils/management-worker-domain';
import { createLiveManagementVolumeAuthority, ManagementMcpStore } from '../../orchestrator/server/utils/management-mcp-store';
import { authorizeRuntimeSelection } from '../../orchestrator/server/utils/worker-runtime-admin';

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

test('legacy MCP runtime authority requires a live platform principal and acknowledgement', async () => {
  const domain = new ManagementWorkerDomain();
  for (const name of ['workers.runtime.preflight', 'workers.runtime.status', 'workers.runtime.migrate', 'workers.runtime.recover', 'workers.runtime.finalize']) {
    await expect(domain.execute(name, { workerId: 'worker-1', runtimeProfile: 'kata-qemu', confirmDowntime: true },
      { scope: 'group', reauthorize: async () => ({ scope: 'platform' }) } as any)).rejects.toMatchObject({ statusCode: 403 });
  }
  for (const authority of [undefined, { scope: 'platform' as const },
    { scope: 'group' as const, reauthorize: async () => ({ scope: 'platform' as const }) }]) {
    await expect(domain.execute('workers.create', { userId: 'owner', runtimeProfile: 'legacy-runc', acknowledgeHostPrivilege: true }, authority))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(domain.execute('workers.runtime.authorize', { workerId: 'worker', runtimeProfile: 'legacy-runc', acknowledgeHostPrivilege: true }, authority))
      .rejects.toMatchObject({ statusCode: 403 });
  }
  const principal = { scope: 'platform' as const, workspaceId: 'admin-workspace' };
  let enabled = true;
  let bound = true;
  const actor = managementRuntimeAdministrator(createLiveManagementVolumeAuthority(principal,
    async () => principal, () => enabled, () => bound));
  await expect(authorizeRuntimeSelection(actor, 'legacy-runc', false)).rejects.toMatchObject({ statusCode: 400 });
  await expect(authorizeRuntimeSelection(actor, 'legacy-runc', true)).resolves.toMatchObject({ legacyPrivilegeGrant: 'admin' });
  enabled = false;
  await expect(actor.authorize()).rejects.toMatchObject({ statusCode: 403 });
  enabled = true; bound = false;
  await expect(actor.authorize()).rejects.toMatchObject({ statusCode: 403 });
});

test('runtime tools exclude internal grant fields and group discovery excludes platform authority', async () => {
  const domain = new ManagementWorkerDomain();
  const definitions = domain.tools();
  for (const name of ['workers.create', 'workers.runtime.authorize']) {
    const schema = definitions.find((tool) => tool.name === name)!.inputSchema as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.runtimeProfile.enum).toEqual(['kata-qemu', 'legacy-runc']);
    expect(schema.properties).not.toHaveProperty('legacyPrivilegeGrant');
    await expect(domain.execute(name, { legacyPrivilegeGrant: 'admin' })).rejects.toMatchObject({ statusCode: 400 });
  }
  const store = new ManagementMcpStore('/unused', async () => undefined);
  (store as any).init = async () => undefined;
  (store as any).state.policy.groups['worker-lifecycle'].enabled = true;
  const platform = await store.listTools();
  expect(platform.map((tool) => tool.name)).toContain('workers.runtime.authorize');
  expect(platform.map((tool) => tool.name)).toContain('workers.runtime.finalize');
  expect(definitions.find((tool) => tool.name === 'workers.runtime.finalize')).toMatchObject({
    annotations: { destructiveHint: true }, inputSchema: { required: ['workerId', 'confirmDeleteRollback'] },
  });
  expect((definitions.find((tool) => tool.name === 'workers.runtime.recover')!.inputSchema as any).properties)
    .toHaveProperty('acknowledgeDaemonOperationsSettled');
  const group = await store.listTools({ scope: 'group', workspaceId: 'group-workspace', ownerId: 'owner', groupId: 'group' } as any);
  expect(group.map((tool) => tool.name)).not.toContain('workers.runtime.authorize');
  expect(group.map((tool) => tool.name)).not.toContain('workers.runtime.finalize');
  const groupCreate = group.find((tool) => tool.name === 'workers.create')!.inputSchema as any;
  expect(groupCreate.properties).not.toHaveProperty('runtimeProfile');
  expect(groupCreate.properties).not.toHaveProperty('acknowledgeHostPrivilege');
});

test('direct MCP invocation cannot give group credentials a runtime selection', async () => {
  const store = new ManagementMcpStore('/unused', async () => undefined);
  (store as any).init = async () => undefined;
  (store as any).auditSafely = async () => undefined;
  (store as any).introspect = async () => ({ scope: 'group', workspaceId: 'group-workspace', ownerId: 'owner', groupId: 'group' });
  (store as any).state.policy.groups['worker-lifecycle'].enabled = true;
  for (const args of [
    { runtimeProfile: 'legacy-runc', acknowledgeHostPrivilege: true },
    { legacyPrivilegeGrant: 'admin' },
    { acknowledgeHostPrivilege: true },
  ]) await expect(store.invoke('server-credential', 'workers.create', args)).rejects.toMatchObject({ statusCode: 404 });
  await expect(store.invoke('server-credential', 'workers.runtime.authorize', { workerId: 'worker', runtimeProfile: 'legacy-runc', acknowledgeHostPrivilege: true }))
    .rejects.toMatchObject({ statusCode: 403 });
});
