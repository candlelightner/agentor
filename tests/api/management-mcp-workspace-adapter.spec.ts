import {test,expect} from '@playwright/test'; import {workspaceMcpTools} from '../../orchestrator/server/utils/management-mcp-workspace-adapter';
test('workspace MCP adapter declares bounded download, clone, and durable export tools',()=>{
  expect(workspaceMcpTools.map(x=>x.name)).toEqual(expect.arrayContaining(['workspaces.download','workspaces.clone','exports.create','exports.cancel','exports.download']));
  const clone=workspaceMcpTools.find(x=>x.name==='workspaces.clone');
  expect(clone?.inputSchema.properties).toHaveProperty('displayName');
  expect(clone?.inputSchema.properties.lockPassword).toMatchObject({type:'string',writeOnly:true});
});
