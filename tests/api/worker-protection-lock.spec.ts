import { test, expect } from '@playwright/test';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';

test.describe.serial('Worker protection locks', () => {
  let workerId = '';
  const password = `correct-lock-${Date.now()}-password`;
  test.beforeAll(async ({ request }) => { workerId = (await createWorker(request, { displayName: `protected-${Date.now()}` })).id; });
  test.afterAll(async ({ request }) => { if (workerId) await cleanupWorker(request, workerId).catch(() => {}); });

  test('stores only protection state and requires the current password to change or remove it', async ({ request }) => {
    expect((await request.put(`/api/containers/${workerId}/protection`, { data: { password } })).status()).toBe(200);
    const status = await request.get(`/api/containers/${workerId}/protection`);
    expect(status.status()).toBe(200); expect(await status.json()).toEqual({ workerId, protected: true });
    expect((await request.put(`/api/containers/${workerId}/protection`, { data: { password: 'new-password-123' } })).status()).toBe(423);
    expect((await request.delete(`/api/containers/${workerId}/protection`, { data: { password: 'wrong-password' } })).status()).toBe(423);
  });

  test('enforces the lock on settings, configuration, rebuild/archive aliases, then permits the correct password', async ({ request }) => {
    expect((await request.patch(`/api/containers/${workerId}`, { data: { displayName: 'blocked rename' } })).status()).toBe(423);
    expect((await request.put(`/api/containers/${workerId}/configuration`, { data: { variables: [{ key: 'LOCK_TEST', value: 'blocked' }] } })).status()).toBe(423);
    expect((await request.post(`/api/containers/${workerId}/archive`, { data: {} })).status()).toBe(423);
    expect((await request.patch(`/api/containers/${workerId}`, { data: { displayName: 'allowed rename', lockPassword: password } })).status()).toBe(200);
    expect((await request.post(`/api/containers/${workerId}/archive`, { data: { lockPassword: password } })).status()).toBe(200);
    expect((await request.post(`/api/archived/${workerId}/unarchive`, { data: {} })).status()).toBe(423);
    expect((await request.post(`/api/archived/${workerId}/unarchive`, { data: { lockPassword: password } })).status()).toBe(200);
  });

  test('enforces the lock when managed-network membership changes indirectly', async ({ request }) => {
    expect((await request.post('/api/managed-networks',{data:{name:`locked-all-${Date.now()}`,scope:'all'}})).status()).toBe(423);
    const created=await request.post('/api/managed-networks',{data:{name:`locked-selected-${Date.now()}`,scope:'selected',workerIds:[workerId],lockPasswords:{[workerId]:password}}});
    expect(created.status()).toBe(201);
    const network=await created.json();
    expect(network.workerIds).toEqual([workerId]);
    expect((await request.patch(`/api/managed-networks/${network.id}`,{data:{scope:'selected',workerIds:[]}})).status()).toBe(423);
    expect((await request.delete(`/api/managed-networks/${network.id}`,{data:{lockPasswords:{[workerId]:password}}})).status()).toBe(204);
  });

  test('enforces the same lock on stop and restart lifecycle aliases', async ({ request }) => {
    expect((await request.post(`/api/containers/${workerId}/stop`, { data: {} })).status()).toBe(423);
    expect((await request.post(`/api/containers/${workerId}/stop`, { data: { lockPassword: password } })).status()).toBe(200);
    expect((await request.post(`/api/containers/${workerId}/restart`, { data: {} })).status()).toBe(423);
    expect((await request.post(`/api/containers/${workerId}/restart`, { data: { lockPassword: password } })).status()).toBe(200);
  });

  test('removes protection with the correct password', async ({ request }) => {
    const result = await request.delete(`/api/containers/${workerId}/protection`, { data: { password } });
    expect(result.status()).toBe(200); expect(await result.json()).toEqual({ workerId, protected: false });
  });
});
