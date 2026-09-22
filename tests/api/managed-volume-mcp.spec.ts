import { test, expect, request as playwrightRequest } from '@playwright/test';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { createTestUser, deleteTestUser } from '../helpers/test-users';
import { ApiClient } from '../helpers/api-client';

test('delegated volume MCP confines inventory and mutations to the current group subtree', async ({ request }) => {
  test.setTimeout(180_000);
  const owner = await createTestUser('Volume MCP owner');
  const ownerRequest = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000', storageState: { cookies: [], origins: [] } });
  const workers: string[] = [], volumes: string[] = [];
  let groupId = '', previous: boolean | undefined;
  try {
    expect((await new ApiClient(ownerRequest).signInEmail(owner.email, owner.password)).status).toBe(200);
    for (const suffix of ['member', 'sibling']) workers.push((await createWorker(ownerRequest, { displayName: `Volume MCP ${suffix} ${Date.now()}` })).id);
    const group = await ownerRequest.post('/api/worker-groups', { data: { name: `Volume MCP ${Date.now()}` } });
    expect(group.status()).toBe(201); groupId = (await group.json()).id;
    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [workers[0]] } })).status()).toBe(200);
    const workspace = await ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace`, { data: {} });
    expect([200, 201], await workspace.text()).toContain(workspace.status());
    const workspaceId = (await workspace.json()).id;
    const policy = await (await request.get('/api/admin/management-mcp/policy')).json();
    previous = policy.groups['storage-maintenance'].enabled;
    expect((await request.put('/api/admin/management-mcp/policy', { data: { groups: { 'storage-maintenance': true } } })).status()).toBe(200);
    const identity = await request.post('/api/admin/management-mcp/diagnostics/issue-identity', { data: { workspaceId, ttlSeconds: 300 } });
    expect(identity.status()).toBe(201);
    const credential = (await identity.json()).credential;
    const invoke = (tool: string, args: Record<string, unknown> = {}) => request.post('/api/admin/management-mcp/diagnostics/invoke', { data: { credential, tool, arguments: args } });
    const added = await invoke('workers.storage.add', { workerId: workers[0], target: '/home/agent/group-cache' });
    expect(added.status(), await added.text()).toBe(200);
    const own = await added.json(); volumes.push(own.id);
    expect(own).toMatchObject({ workerId: workers[0], attached: true });
    const sibling = await ownerRequest.post(`/api/containers/${workers[1]}/storage`, { data: { action: 'add', target: '/home/agent/sibling-cache' } });
    expect(sibling.status()).toBe(200); const other = await sibling.json(); volumes.push(other.id);
    const inventory = await invoke('volumes.inventory');
    expect(inventory.status(), await inventory.text()).toBe(200);
    const entries = (await inventory.json()).volumes;
    expect(entries.some((v: any) => v.id === own.id)).toBe(true);
    expect(entries.some((v: any) => v.id === other.id)).toBe(false);
    const workspaceVolume = entries.find((v: any) => v.workerId === workers[0] && v.purpose === 'workspace');
    expect(workspaceVolume).toBeTruthy();
    const sizeStart = await invoke('volumes.size.start', { volumeId: workspaceVolume.id, force: true });
    expect(sizeStart.status(), await sizeStart.text()).toBe(200);
    const sizeJob = await sizeStart.json();
    let terminalJob: any;
    await expect.poll(async () => {
      const response = await invoke('volumes.size.inspect', { jobId: sizeJob.id });
      terminalJob = response.status() === 200 ? await response.json() : { status: `http-${response.status()}` };
      return terminalJob.status;
    }, { timeout: 60_000 }).toMatch(/succeeded|failed|cancelled/);
    expect(terminalJob.status, terminalJob.error).toBe('succeeded');
    for (const tool of ['volumes.inspect', 'volumes.rename', 'volumes.delete', 'volumes.size.start', 'workers.storage.apply', 'workers.storage.detach', 'workers.storage.reattach']) {
      const args: Record<string, unknown> = { volumeId: other.id };
      if (tool === 'volumes.rename') args.name = 'Forbidden';
      if (tool === 'volumes.delete' || tool === 'workers.storage.detach') args.confirmed = true;
      if (tool === 'workers.storage.apply') args.mode = 'recreate';
      expect((await invoke(tool, args)).status(), tool).toBe(404);
    }
    expect((await invoke('workers.storage.add', { workerId: workers[1], target: '/home/agent/forbidden' })).status()).toBe(404);
    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [] } })).status()).toBe(200);
    expect((await invoke('volumes.inspect', { volumeId: own.id })).status()).toBe(404);
  } finally {
    if (groupId) await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [] } });
    for (const worker of workers) await cleanupWorker(ownerRequest, worker);
    for (const id of volumes) await ownerRequest.post(`/api/volumes/${id}`, { data: { action: 'delete', confirmed: true } });
    if (groupId) await ownerRequest.delete(`/api/worker-groups/${groupId}`);
    if (previous !== undefined) await request.put('/api/admin/management-mcp/policy', { data: { groups: { 'storage-maintenance': previous } } });
    await ownerRequest.dispose(); await deleteTestUser(owner.id);
  }
});
