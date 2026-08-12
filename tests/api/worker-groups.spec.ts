import { test, expect } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
test.describe('Worker groups API', () => {
  test('creates, renames, assigns workers, and deletes only the group', async ({ request }) => {
    const api = new ApiClient(request); const worker = await api.createContainer({ displayName: `group-worker-${Date.now()}` });
    const created = await request.post('/api/worker-groups', { data: { name: 'Research' } }); expect(created.status()).toBe(201); const group = await created.json();
    const updated = await request.patch(`/api/worker-groups/${group.id}`, { data: { name: 'Research 2', workerIds: [worker.body.id] } }); expect(updated.status()).toBe(200); expect((await updated.json()).workerIds).toEqual([worker.body.id]);
    expect((await request.delete(`/api/worker-groups/${group.id}`)).status()).toBe(204); expect((await api.listContainers()).body.some((entry: any) => entry.id === worker.body.id)).toBe(true); await api.removeContainer(worker.body.id);
  });
  test('rejects invalid names and unknown workers', async ({ request }) => { expect((await request.post('/api/worker-groups', { data: { name: '' } })).status()).toBe(400); const group = await (await request.post('/api/worker-groups', { data: { name: 'Valid' } })).json(); expect((await request.patch(`/api/worker-groups/${group.id}`, { data: { workerIds: ['missing'] } })).status()).toBe(400); await request.delete(`/api/worker-groups/${group.id}`); });
});
