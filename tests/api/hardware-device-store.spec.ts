import { expect, test } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HardwareDeviceStore, hardwareDeviceSelector } from '../../orchestrator/server/utils/hardware-device-store';
import { ManagementHardwareDeviceDomain } from '../../orchestrator/server/utils/management-hardware-device-domain';
import { ManagementWorkerDomain } from '../../orchestrator/server/utils/management-worker-domain';

const owner = 'owner-a'; const stamp = '2026-09-09T00:00:00.000Z';
const candidate = { kind: 'gpu' as const, selector: 'drm:pci:0000:00:02.0', name: 'Intel GPU', vendor: '8086', product: '5917', deviceNodes: ['/dev/dri/card1', '/dev/dri/renderD128'], groupIds: [44, 993] };
function group(id: string, parentId?: string, workerIds: string[] = []) { return { id, userId: owner, name: id, parentId, workerIds, createdAt: stamp, updatedAt: stamp }; }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-hardware-'));
  const groups = [group('root', undefined, ['root-worker']), group('child', 'root', ['child-worker']), group('sibling', undefined, ['sibling-worker'])];
  const workers = new Set(['root-worker', 'child-worker', 'sibling-worker']);
  let connected = true; let candidates = [candidate] as any[];
  const store = new HardwareDeviceStore(dir, async () => connected ? candidates : [], { listForUser: () => groups, get: (_u: string, id: string) => groups.find((item) => item.id === id) } as any, { get: (u: string, id: string) => u === owner && workers.has(id) ? { id, userId: u, status: 'active' } : undefined } as any);
  await store.init();
  return { dir, store, inventory: (value: any[]) => { candidates = value; }, disconnect: () => { connected = false; } };
}

test('hardware catalog approves only discovered stable selectors and resolves live nodes', async () => {
  const { dir, store, disconnect } = await fixture();
  try {
    await expect(store.approveDevice({ selector: 'forged' })).rejects.toMatchObject({ statusCode: 404 });
    const device = await store.approveDevice({ selector: candidate.selector });
    await store.setEntitlement(owner, device.id, true);
    await store.createOwnerGrant(owner, { deviceId: device.id, targetType: 'worker', targetId: 'root-worker' });
    await expect(store.resolveAuthorizedDevices(owner, 'root-worker', [device.id], 'root')).resolves.toEqual([{ deviceId: device.id, candidate, deviceNodes: candidate.deviceNodes, groupIds: candidate.groupIds }]);
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


test('legacy newline-padded USB selectors keep exact grant IDs and match normalized discovery', async () => {
  const f = await fixture();
  const old = { kind: 'usb' as const, name: 'Camera', vendor: '0408 ', product: '5371 ', serial: '0001 ',
    selector: 'usb:0408 :5371 :0001 ', deviceNodes: ['/dev/bus/usb/001/009'], groupIds: [] };
  const live = { ...old, vendor: '0408', product: '5371', serial: '0001', selector: 'usb:0408:5371:0001' };
  try {
    f.inventory([old]); const device = await f.store.approveDevice({ selector: old.selector });
    await f.store.setEntitlement(owner, device.id, true);
    await f.store.createOwnerGrant(owner, { deviceId: device.id, targetType: 'worker', targetId: 'root-worker' });
    const before = await readFile(join(f.dir, 'admin/hardware-devices.v1.json'), 'utf8');
    const grants = structuredClone(f.store.listGrants(owner, true));
    f.inventory([live]);
    expect(await f.store.resolveAuthorizedDevices(owner, 'root-worker', [device.id], 'root')).toMatchObject([{ deviceId: device.id, candidate: live }]);
    await expect(f.store.approveDevice({ selector: live.selector })).rejects.toThrow('already approved');
    expect(await readFile(join(f.dir, 'admin/hardware-devices.v1.json'), 'utf8')).toBe(before);
    expect(f.store.listGrants(owner, true)).toEqual(grants);
    f.inventory([{ ...live, serial: 'different', selector: 'usb:0408:5371:different' }]);
    await expect(f.store.resolveAuthorizedDevices(owner, 'root-worker', [device.id], 'root')).rejects.toThrow('unavailable');
    f.inventory([live, live]);
    await expect(f.store.resolveAuthorizedDevices(owner, 'root-worker', [device.id], 'root')).rejects.toThrow('ambiguous');
    expect(f.store.listGrants(owner, true)).toEqual(grants);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('legacy selector compatibility is exact and never substitutes USB serials or catalog aliases', async () => {
  const old = { kind: 'usb' as const, vendor: '152d ', product: '0551 ', serial: 'old-disk ', selector: 'usb:152d :0551 :old-disk ' };
  expect(hardwareDeviceSelector(old)).toBe('usb:152d:0551:old-disk');
  for (const changed of [{ ...old, serial: 'replacement ' }, { ...old, vendor: '152d' },
    { ...old, product: '0551\t' }, { ...old, selector: 'usb:152d :0551 :old-disk' },
    { ...old, serial: undefined, selector: 'usb:152d :0551 :invented' }])
    expect(hardwareDeviceSelector(changed)).toBe(changed.selector);
  expect(hardwareDeviceSelector({ ...old, serial: undefined, selector: 'usb:152d :0551 :port:1-2.3' })).toBe('usb:152d:0551:port:1-2.3');
  expect(hardwareDeviceSelector({ ...old, serial: '0000:00:14.0 ', selector: 'usb:152d :0551 :0000:00:14.0 ' })).toBe('usb:152d:0551:0000:00:14.0');
  const f = await fixture(); try {
    const live = { ...old, vendor: '152d', product: '0551', serial: 'old-disk', selector: 'usb:152d:0551:old-disk', name: 'disk', deviceNodes: ['/dev/bus/usb/002/001'], groupIds: [] };
    f.inventory([live]); const device = await f.store.approveDevice({ selector: live.selector });
    await f.store.setEntitlement(owner, device.id, true);
    await f.store.createOwnerGrant(owner, { deviceId: device.id, targetType: 'all' });
    await writeFile(join(f.dir, 'admin/hardware-devices.v1.json'), JSON.stringify([device, { ...device, ...old, id: 'legacy-alias' }]));
    await expect(f.store.init()).rejects.toThrow('Duplicate approved hardware selector');
    await expect(f.store.resolveAuthorizedDevices(owner, 'root-worker', [device.id], 'root')).rejects.toThrow('unavailable');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
