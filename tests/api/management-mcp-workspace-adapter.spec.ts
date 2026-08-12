import {test,expect} from '@playwright/test'; import {workspaceMcpTools} from '../../orchestrator/server/utils/management-mcp-workspace-adapter';
test('workspace MCP adapter declares bounded download and durable export tools',()=>{expect(workspaceMcpTools.map(x=>x.name)).toEqual(expect.arrayContaining(['workspaces.download','exports.create','exports.cancel','exports.download']))});
