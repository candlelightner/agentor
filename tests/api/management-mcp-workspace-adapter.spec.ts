import {test,expect} from '@playwright/test'; import {workspaceMcpTools} from '../../orchestrator/server/utils/management-mcp-workspace-adapter'; import {ManagementWorkerDomain,withinGroupAdminLifecycleDeadline} from '../../orchestrator/server/utils/management-worker-domain';
test('workspace MCP adapter declares private streaming download, clone, and durable export tools',()=>{
  expect(workspaceMcpTools.map(x=>x.name)).toEqual(expect.arrayContaining(['workspaces.download','workspaces.clone','exports.create','exports.cancel','exports.download']));
  const clone=workspaceMcpTools.find(x=>x.name==='workspaces.clone');
  expect(clone?.inputSchema.properties).toHaveProperty('displayName');
  expect(clone?.inputSchema.properties.lockPassword).toMatchObject({type:'string',writeOnly:true});
  expect(workspaceMcpTools.find(x=>x.name==='workspaces.download')?.description).toContain('private one-use streaming');
  expect(workspaceMcpTools.find(x=>x.name==='exports.download')?.description).toContain('private one-use');
});

test('group-admin lifecycle tools declare bounded deadlines and return a timeout instead of hanging', async () => {
  const tools = new ManagementWorkerDomain().tools().filter(tool => tool.name.startsWith('groups.admin-workspace.'));
  expect(tools.map(tool => tool.name)).toEqual([
    'groups.admin-workspace.get',
    'groups.admin-workspace.provision',
    'groups.admin-workspace.start',
    'groups.admin-workspace.stop',
    'groups.admin-workspace.rebuild',
  ]);
  for (const tool of tools) {
    expect(tool.inputSchema).toMatchObject({ required: ['groupId'], properties: { groupId: { type: 'string' }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300 } } });
    expect((tool.inputSchema.properties as any).timeoutSeconds.description).toContain('default 120');
  }
  await expect(withinGroupAdminLifecycleDeadline(() => new Promise<never>(() => {}), 0.01))
    .rejects.toMatchObject({ statusCode: 504 });
});
