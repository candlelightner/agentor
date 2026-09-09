import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HardwareDeviceStore } from '../../orchestrator/server/utils/hardware-device-store';
import { ManagementHardwareDeviceDomain } from '../../orchestrator/server/utils/management-hardware-device-domain';
import { ManagementWorkerDomain } from '../../orchestrator/server/utils/management-worker-domain';

const owner = 'owner-a'; const stamp = '2026-09-09T00:00:00.000Z';
const candidate = { kind: 'gpu' as const, selector: 'drm:pci:0000:00:02.0', name: 'Intel GPU', vendor: '8086', product: '5917', deviceNodes: ['/dev/dri/card1', '/dev/dri/renderD128'], groupIds: [44, 993] };
function group(id: string, parentId?: string, workerIds: string[] = []) { return { id, userId: owner, name: id, parentId, workerIds, createdAt: stamp, updatedAt: stamp }; }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-hardware-'));
  const groups = [group('root', undefined, ['root-worker']), group('child', 'root', ['child-worker']), group('sibling', undefined, ['sibling-worker'])];
  const workers = new Set(['root-worker', 'child-worker', 'sibling-worker']);
  let connected = true;
  const store = new HardwareDeviceStore(dir, async () => connected ? [candidate] : [], { listForUser: () => groups, get: (_u: string, id: string) => groups.find((item) => item.id === id) } as any, { get: (u: string, id: string) => u === owner && workers.has(id) ? { id, userId: u, status: 'active' } : undefined } as any);
  await store.init();
  return { dir, store, disconnect: () => { connected = false; } };
}

test('hardware catalog approves only discovered stable selectors and resolves live nodes', async () => {
  const { dir, store, disconnect } = await fixture();
  try {
    await expect(store.approveDevice({ selector: 'forged' })).rejects.toMatchObject({ statusCode: 404 });
    const device = await store.approveDevice({ selector: candidate.selector });
    await store.setEntitlement(owner, device.id, true);
    await store.createOwnerGrant(owner, { deviceId: device.id, targetType: 'worker', targetId: 'root-worker' });
    await expect(store.resolveAuthorizedDevices(owner, 'root-worker', [device.id], 'root')).resolves.toEqual([{ deviceId: device.id, deviceNodes: candidate.deviceNodes, groupIds: candidate.groupIds }]);
    expect(() => store.authorizeDeviceIds(owner, 'child-worker', [device.id], 'child')).toThrow(/not assigned/);
    disconnect();
    await expect(store.resolveAuthorizedDevices(owner, 'root-worker', [device.id], 'root')).rejects.toThrow(/unavailable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('device grants delegate only downward from an explicit group grant', async () => {
  const { dir, store } = await fixture();
  try {
    const device = await store.approveDevice({ selector: candidate.selector }); await store.setEntitlement(owner, device.id, true);
    await store.createOwnerGrant(owner, { deviceId: device.id, targetType: 'all' });
    await expect(store.createGroupDelegation(owner, 'root', { deviceId: device.id, targetType: 'group', targetId: 'child' })).rejects.toThrow(/account owner/);
    const parent = await store.createOwnerGrant(owner, { deviceId: device.id, targetType: 'group', targetId: 'root' });
    const child = await store.createGroupDelegation(owner, 'root', { deviceId: device.id, targetType: 'group', targetId: 'child' });
    expect(store.canWorkerUseDevice(owner, 'child-worker', device.id, 'child')).toBe(true);
    await expect(store.createGroupDelegation(owner, 'root', { deviceId: device.id, targetType: 'group', targetId: 'sibling' })).rejects.toMatchObject({ statusCode: 403 });
    expect((await store.deleteGrant(owner, parent.id)).removedGrantIds).toEqual(expect.arrayContaining([parent.id, child.id]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('management MCP exposes platform device controls, downward delegation, and worker selection IDs', () => {
  const tools = new ManagementHardwareDeviceDomain().tools();
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['hardware-devices.discover', 'hardware-devices.catalog.approve', 'hardware-devices.entitlements.set', 'hardware-devices.grants.create', 'hardware-devices.delegations.create']));
  const approve: any = tools.find((tool) => tool.name === 'hardware-devices.catalog.approve')?.inputSchema;
  expect(approve.properties.selector).toBeTruthy(); expect(approve.properties.deviceNodes).toBeUndefined();
  for (const name of ['workers.create', 'workers.update']) {
    const schema: any = new ManagementWorkerDomain().tools().find((tool) => tool.name === name)?.inputSchema;
    expect(schema.properties.hardwareDeviceIds.items).toMatchObject({ type: 'string' });
  }
});
