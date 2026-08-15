import { test, expect, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { cleanupWorker, createWorker } from '../helpers/worker-lifecycle';

async function invoke(
  request: APIRequestContext,
  credential: string,
  tool: string,
  args: Record<string, unknown>,
) {
  return request.post('/api/admin/management-mcp/diagnostics/invoke', {
    data: { credential, tool, arguments: args },
  });
}

async function expectNetworkMembers(
  request: APIRequestContext,
  networkIds: string[],
  expectedContainerNames: string[],
) {
  for (const networkId of networkIds) {
    await expect.poll(async () => {
      const response = await request.get(`/api/managed-networks/${networkId}`);
      if (response.status() !== 200) return [`status:${response.status()}`];
      const topology = await response.json() as { containers: Array<{ name: string }> };
      return topology.containers.map((container) => container.name).sort();
    }).toEqual([...expectedContainerNames].sort());
  }
}

test.describe('Worker groups API', () => {
  test('creates, renames, assigns workers, and deletes only the group', async ({ request }) => {
    const api = new ApiClient(request); const worker = await api.createContainer({ displayName: `group-worker-${Date.now()}` });
    const created = await request.post('/api/worker-groups', { data: { name: 'Research' } }); expect(created.status()).toBe(201); const group = await created.json();
    const updated = await request.patch(`/api/worker-groups/${group.id}`, { data: { name: 'Research 2', workerIds: [worker.body.id] } }); expect(updated.status()).toBe(200); expect((await updated.json()).workerIds).toEqual([worker.body.id]);
    expect((await request.delete(`/api/worker-groups/${group.id}`)).status()).toBe(409);
    expect((await request.put('/api/worker-groups/assignment', { data: { workerId: worker.body.id, groupId: null } })).status()).toBe(200);
    expect((await request.delete(`/api/worker-groups/${group.id}`)).status()).toBe(204); expect((await api.listContainers()).body.some((entry: any) => entry.id === worker.body.id)).toBe(true); await api.removeContainer(worker.body.id);
  });
  test('rejects invalid names and unknown workers', async ({ request }) => { expect((await request.post('/api/worker-groups', { data: { name: '' } })).status()).toBe(400); const group = await (await request.post('/api/worker-groups', { data: { name: 'Valid' } })).json(); expect((await request.patch(`/api/worker-groups/${group.id}`, { data: { workerIds: ['missing'] } })).status()).toBe(400); await request.delete(`/api/worker-groups/${group.id}`); });

  test('reconciles every dependent network through API and MCP and preserves referenced groups', async ({ request }) => {
    const stamp = Date.now();
    const passwordA = `group-lock-a-${stamp}`;
    const passwordB = `group-lock-b-${stamp}`;
    let first: Awaited<ReturnType<typeof createWorker>> | undefined;
    let second: Awaited<ReturnType<typeof createWorker>> | undefined;
    let groupId = '';
    const networkIds: string[] = [];
    let credential = '';
    let previousGroupsPolicy: boolean | undefined;
    let previousNetworkingPolicy: boolean | undefined;

    try {
      first = await createWorker(request, { displayName: `group-old-${stamp}` });
      second = await createWorker(request, { displayName: `group-new-${stamp}` });
      const ownerId = String(first.userId);
      expect(ownerId).toBeTruthy();
      expect(second.userId).toBe(ownerId);

      const createdGroup = await request.post('/api/worker-groups', {
        data: { name: `reconciled-${stamp}` },
      });
      expect(createdGroup.status()).toBe(201);
      groupId = (await createdGroup.json()).id;
      expect((await request.patch(`/api/worker-groups/${groupId}`, {
        data: { workerIds: [first.id] },
      })).status()).toBe(200);

      for (const suffix of ['one', 'two']) {
        const createdNetwork = await request.post('/api/managed-networks', {
          data: {
            name: `group-network-${suffix}-${stamp}`,
            scope: 'group',
            groupId,
          },
        });
        expect(createdNetwork.status(), await createdNetwork.text()).toBe(201);
        networkIds.push((await createdNetwork.json()).id);
      }
      await expectNetworkMembers(request, networkIds, [first.containerName]);

      expect((await request.put(`/api/containers/${first.id}/protection`, {
        data: { password: passwordA },
      })).status()).toBe(200);
      expect((await request.put(`/api/containers/${second.id}/protection`, {
        data: { password: passwordB },
      })).status()).toBe(200);

      // The indirect network mutation covers the union of workers detached
      // and attached. Either half of the credential map alone must fail.
      expect((await request.patch(`/api/worker-groups/${groupId}`, {
        data: { workerIds: [second.id], lockPasswords: { [first.id]: passwordA } },
      })).status()).toBe(423);
      expect((await request.patch(`/api/worker-groups/${groupId}`, {
        data: { workerIds: [second.id], lockPasswords: { [second.id]: passwordB } },
      })).status()).toBe(423);
      expect((await request.patch(`/api/worker-groups/${groupId}`, {
        data: {
          workerIds: [second.id],
          lockPasswords: { [first.id]: passwordA, [second.id]: passwordB },
        },
      })).status()).toBe(200);
      await expectNetworkMembers(request, networkIds, [second.containerName]);

      const workspace = await request.post('/api/admin/workspace', { data: {} });
      expect([200, 201]).toContain(workspace.status());
      const policy = await (await request.get('/api/admin/management-mcp/policy')).json();
      previousGroupsPolicy = policy.groups.groups.enabled;
      previousNetworkingPolicy = policy.groups.networking.enabled;
      expect((await request.put('/api/admin/management-mcp/policy', {
        data: { groups: { groups: true, networking: true } },
      })).status()).toBe(200);
      const identity = await request.post('/api/admin/management-mcp/diagnostics/issue-identity', {
        data: { workspaceId: (await workspace.json()).id, ttlSeconds: 60 },
      });
      expect(identity.status()).toBe(201);
      credential = (await identity.json()).credential;

      expect((await invoke(request, credential, 'groups.update', {
        groupId,
        workerIds: [first.id],
        lockPasswords: { [second.id]: passwordB },
      })).status()).toBe(423);
      expect((await invoke(request, credential, 'groups.update', {
        groupId,
        workerIds: [first.id],
        lockPasswords: { [first.id]: passwordA },
      })).status()).toBe(423);
      expect((await invoke(request, credential, 'groups.update', {
        groupId,
        workerIds: [first.id],
        lockPasswords: { [first.id]: passwordA, [second.id]: passwordB },
      })).status()).toBe(200);
      await expectNetworkMembers(request, networkIds, [first.containerName]);

      // A platform administrator can compose the normal group-membership
      // operation with the group-admin lifecycle without a browser session.
      // The returned workspace remains tied to this group rather than either
      // selected worker.
      const provisioned = await invoke(request, credential, 'groups.admin-workspace.provision', { groupId });
      expect(provisioned.status()).toBe(200);
      const groupWorkspace = await provisioned.json();
      expect(groupWorkspace).toMatchObject({ groupId, userId: ownerId, status: 'running' });
      expect((await invoke(request, credential, 'groups.admin-workspace.get', { groupId })).status()).toBe(200);
      expect((await invoke(request, credential, 'groups.admin-workspace.stop', { groupId })).status()).toBe(200);
      expect((await invoke(request, credential, 'groups.admin-workspace.start', { groupId })).status()).toBe(200);

      // Neither transport may erase a group while a network still derives its
      // membership from it, and failed deletion leaves both records intact.
      expect((await request.delete(`/api/worker-groups/${groupId}`)).status()).toBe(409);
      expect((await invoke(request, credential, 'groups.delete', { groupId })).status()).toBe(409);
      expect((await request.get(`/api/worker-groups/${groupId}`)).status()).toBe(200);

      expect((await invoke(request, credential, 'networks.delete', {
        networkId: networkIds[0],
        lockPasswords: { [first.id]: passwordA },
      })).status()).toBe(200);
      networkIds.shift();
      expect((await request.delete(`/api/worker-groups/${groupId}`)).status()).toBe(409);
      expect((await request.delete(`/api/managed-networks/${networkIds[0]}`, {
        data: { lockPasswords: { [first.id]: passwordA } },
      })).status()).toBe(204);
      networkIds.shift();
      expect((await request.put('/api/worker-groups/assignment', {
        data: { workerId: first.id, groupId: null, lockPasswords: { [first.id]: passwordA } },
      })).status()).toBe(200);
      expect((await invoke(request, credential, 'groups.delete', { groupId })).status()).toBe(200);
      groupId = '';

      expect((await request.get(`/api/containers/${first.id}`)).status()).toBe(200);
      expect((await request.get(`/api/containers/${second.id}`)).status()).toBe(200);
    } finally {
      if (previousGroupsPolicy !== undefined && previousNetworkingPolicy !== undefined) {
        await request.put('/api/admin/management-mcp/policy', {
          data: { groups: { groups: previousGroupsPolicy, networking: previousNetworkingPolicy } },
        }).catch(() => {});
      }
      for (const networkId of networkIds) {
        await request.delete(`/api/managed-networks/${networkId}`, {
          data: {
            lockPasswords: {
              ...(first ? { [first.id]: passwordA } : {}),
              ...(second ? { [second.id]: passwordB } : {}),
            },
          },
        }).catch(() => {});
      }
      if (groupId) await request.delete(`/api/worker-groups/${groupId}`).catch(() => {});
      if (first) {
        await request.delete(`/api/containers/${first.id}/protection`, { data: { password: passwordA } }).catch(() => {});
        await cleanupWorker(request, first.id).catch(() => {});
      }
      if (second) {
        await request.delete(`/api/containers/${second.id}/protection`, { data: { password: passwordB } }).catch(() => {});
        await cleanupWorker(request, second.id).catch(() => {});
      }
    }
  });
});
