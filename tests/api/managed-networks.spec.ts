import { test, expect } from '@playwright/test';
test('managed networks validate scopes, normalize non-selected membership, and expose topology', async ({request}) => {
  expect((await request.post('/api/managed-networks',{data:{name:'x',scope:'bad'}})).status()).toBe(400);
  expect((await request.post('/api/managed-networks',{data:{name:'x',scope:'group',groupId:'missing'}})).status()).toBe(400);
  const created=await request.post('/api/managed-networks',{data:{name:`test-network-${Date.now()}`,scope:'all'}}); expect(created.status()).toBe(201); const n=await created.json();
  const topology=await request.get(`/api/managed-networks/${n.id}`); expect(topology.status()).toBe(200); expect((await topology.json()).network.id).toBe(n.id);
  expect((await request.patch(`/api/managed-networks/${n.id}`,{data:{scope:'invalid'}})).status()).toBe(400);
  const validation=await request.post(`/api/managed-networks/${n.id}/validate`); expect(validation.status()).toBe(200); expect(typeof (await validation.json()).ok).toBe('boolean');
  expect((await request.delete(`/api/managed-networks/${n.id}`)).status()).toBe(204);
});
