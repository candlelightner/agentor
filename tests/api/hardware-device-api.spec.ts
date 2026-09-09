import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createTestUser, deleteTestUser } from '../helpers/test-users';
import { cleanupWorker, createWorker } from '../helpers/worker-lifecycle';
const run = promisify(execFile); const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
async function owner() { const user = await createTestUser('Hardware owner'); const context = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL }, storageState: { cookies: [], origins: [] } }); const signed = await new ApiClient(context).signInEmail(user.email, user.password); if (signed.status !== 200) throw new Error('sign-in failed'); return { user, context }; }

test.describe.serial('Hardware device authorization API', () => {
  test('platform approval, owner assignment, Docker mapping, revocation guard, and clean rebuild', async ({ request }) => {
    test.setTimeout(300_000); const account = await owner(); let deviceId = ''; let grantId = ''; let workerId = '';
    try {
      const denied = await account.context.post('/api/hardware-devices', { data: { selector: 'usb:agentor:test-device' } }); expect(denied.status()).toBe(403);
      const discovered = await request.get('/api/hardware-devices'); expect(discovered.status(), await discovered.text()).toBe(200);
      expect((await discovered.json()).discovered).toEqual(expect.arrayContaining([expect.objectContaining({ selector: 'usb:agentor:test-device', deviceNodes: ['/dev/null'] })]));
      const approved = await request.post('/api/hardware-devices', { data: { selector: 'usb:agentor:test-device', name: `Test device ${Date.now()}` } }); expect(approved.status(), await approved.text()).toBe(201); deviceId = (await approved.json()).id;
      expect((await request.put('/api/hardware-devices/entitlements', { data: { ownerId: account.user.id, deviceId, enabled: true } })).status()).toBe(200);
      const granted = await account.context.post('/api/hardware-devices/grants', { data: { deviceId, targetType: 'all' } }); expect(granted.status(), await granted.text()).toBe(201); grantId = (await granted.json()).id;
      const worker = await createWorker(account.context, { hardwareDeviceIds: [deviceId] }); workerId = worker.id;
      const dockerName = `agentor-worker-${workerId}`;
      const before = JSON.parse((await run('docker', ['inspect', '--format', '{{json .HostConfig.Devices}}', dockerName])).stdout);
      expect(before).toEqual(expect.arrayContaining([expect.objectContaining({ PathOnHost: '/dev/null', PathInContainer: '/dev/null', CgroupPermissions: 'rwm' })]));
      const revoked = await account.context.delete(`/api/hardware-devices/grants/${grantId}`); expect(revoked.status(), await revoked.text()).toBe(200); expect((await revoked.json()).enforcement.stoppedWorkerIds).toContain(workerId);
      const api = new ApiClient(account.context); const stopped = (await api.listContainers()).body.find((item: any) => item.id === workerId); expect(stopped).toMatchObject({ status: 'stopped', pendingRebuild: true, hardwareDevicesRevoked: true }); expect(stopped.hardwareDeviceIds ?? []).toEqual([]);
      expect((await api.restartContainer(workerId)).status).toBe(409);
      const rebuilt = await api.rebuildContainer(workerId); expect(rebuilt.status).toBe(200); expect(rebuilt.body).toMatchObject({ pendingRebuild: false, hardwareDevicesRevoked: false });
      const after = JSON.parse((await run('docker', ['inspect', '--format', '{{json .HostConfig.Devices}}', dockerName])).stdout || 'null'); expect(after ?? []).toEqual([]);
    } finally {
      if (workerId) await cleanupWorker(account.context, workerId); if (deviceId) await request.delete(`/api/hardware-devices/${deviceId}`).catch(() => undefined); await account.context.dispose(); await deleteTestUser(account.user.id);
    }
  });
});
