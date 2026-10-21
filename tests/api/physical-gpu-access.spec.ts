import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { publicHardwareDevice } from '../../orchestrator/server/utils/hardware-device-response';

function load(relative: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = readFileSync(new URL('../../orchestrator/server/' + relative, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  new Function('require', 'exports', ...Object.keys(globals), code)((name: string) => {
    if (!(name in modules)) throw new Error('Unexpected fixture import: ' + name);
    return modules[name];
  }, exports, ...Object.values(globals));
  return exports;
}

function fixture() {
  let device: any = { id: 'gpu-device', kind: 'gpu', selector: 'pci-gpu:10de:1234:1234:1234:synthetic',
    physicalAssignment: { userId: 'owner', workerId: 'worker' } };
  let durable: any[] = [], cached: any[] = [];
  const calls: string[] = [];
  let currentRole = 'admin';
  const createError = (value: any) => Object.assign(new Error(value.statusMessage), value);
  const store = { getDevice: () => device, listCatalog: () => [device], listDiscoveredDevices: async () => [device],
    listEntitledDevices: () => [device], approveDevice: async () => device, updateDevice: async () => device,
    deleteDevice: async () => { calls.push('delete'); return { deviceIds: [device.id] }; },
    setEntitlement: async () => { calls.push('entitlement'); return {}; } };
  const services = { useHardwareDeviceStore: () => store, useWorkerStore: () => ({ list: () => durable }),
    useContainerManager: () => ({ list: () => cached, reconcileHardwareDeviceAccess: async () => {
      calls.push('enforcement'); return { failures: [], stoppedWorkerIds: [] };
    } }) };
  const revocation = load('utils/hardware-device-revocation.ts', {
    h3: { createError }, './services': services,
    './hardware-device-store': { isPhysicalGpuDevice: (value: any) => value?.kind === 'gpu' && value.selector.startsWith('pci-gpu:') },
  });
  const auth = { requireAdmin: (event: any) => {
    if (event.role !== 'admin') throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
    return { user: { id: 'admin', role: 'admin' } };
  } };
  const globals = { defineRouteMeta() {}, defineEventHandler: (handler: unknown) => handler,
    setResponseStatus() {}, readBody: async (event: any) => event.body, getRouterParam: () => 'gpu-device', createError };
  const routeModules = { '../../utils/auth-helpers': auth, '../../utils/auth': { getUserById: () => ({ id: 'owner' }) },
    '../../utils/services': services, '../../utils/hardware-device-revocation': revocation,
    '../../utils/hardware-device-response': { publicHardwareDevice } };
  const routes = {
    remove: load('api/hardware-devices/[id].delete.ts', routeModules, globals).default,
    entitlement: load('api/hardware-devices/entitlements.put.ts', routeModules, globals).default,
    approve: load('api/hardware-devices/index.post.ts', routeModules, globals).default,
    rename: load('api/hardware-devices/[id].patch.ts', routeModules, globals).default,
  };
  const physical = { listPhysicalGpuAssignments: async () => { calls.push('list-physical'); return [{ deviceId: device.id }]; },
    setPhysicalGpuAssignment: async (id: string, worker: string | null, authorize: () => void, password?: string) => {
      await authorize(); calls.push('physical:' + (worker ?? 'none')); return { deviceId: id, workerId: worker, passwordSupplied: !!password };
    } };
  const { ManagementHardwareDeviceDomain } = load('utils/management-hardware-device-domain.ts', {
    './services': services, './hardware-device-revocation': revocation, './auth': { getUserById: () => ({ id: 'owner' }) },
    './physical-gpu-management': physical, './hardware-device-response': { publicHardwareDevice },
  });
  const gpuRoutes = {
    list: load('api/hardware-devices/gpu.get.ts', { '../../utils/auth-helpers': auth, '../../utils/physical-gpu-management': physical }, globals).default,
    set: load('api/hardware-devices/gpu.put.ts', { '../../utils/auth-helpers': auth, '../../utils/physical-gpu-management': physical,
      '../../utils/auth': { getAuthDb: () => ({ prepare: () => ({ get: () => ({ role: currentRole }) }) }) } }, globals).default,
  };
  return { calls, routes, gpuRoutes, currentRole: (role: string) => { currentRole = role; }, domain: new ManagementHardwareDeviceDomain(), revocation,
    setDevice: (value: any) => { device = value; }, device: () => device,
    workers: (records: any[], live: any[] = []) => { durable = records; cached = live; } };
}

test('generic admin catalog/entitlement revocation cannot detach assigned or legacy-selected physical GPUs', async () => {
  const f = fixture();
  const event = { role: 'admin', body: { ownerId: 'owner', deviceId: 'gpu-device', enabled: false } };
  for (const state of ['binding', 'durable', 'cached']) {
    f.setDevice({ ...f.device(), physicalAssignment: state === 'binding' ? { userId: 'owner', workerId: 'worker' } : undefined });
    f.workers(state === 'durable' ? [{ hardwareDeviceIds: ['gpu-device'] }] : [], state === 'cached' ? [{ hardwareDeviceIds: ['gpu-device'] }] : []);
    await expect(f.routes.remove(event)).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.routes.entitlement(event)).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.domain.execute('hardware-devices.catalog.delete', { deviceId: 'gpu-device' }, { scope: 'platform' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.domain.execute('hardware-devices.entitlements.set', event.body, { scope: 'platform' })).rejects.toMatchObject({ statusCode: 409 });
  }
  expect(f.calls).toEqual([]);
});

test('USB and mediated GPU policy revocation retains existing behavior; unassigned physical catalog entries remain removable', async () => {
  const f = fixture();
  const event = { role: 'admin', body: { ownerId: 'owner', deviceId: 'gpu-device', enabled: false } };
  for (const device of [{ kind: 'usb', selector: 'usb:1234:5678:synthetic' }, { kind: 'gpu', selector: 'drm:pci:0000:00:02.0' }]) {
    f.setDevice({ id: 'gpu-device', ...device }); f.workers([{ hardwareDeviceIds: ['gpu-device'] }]);
    await f.routes.entitlement(event); await f.routes.remove(event);
  }
  expect(f.calls.filter(call => call === 'enforcement')).toHaveLength(4);
  f.setDevice({ id: 'gpu-device', kind: 'gpu', selector: 'pci-gpu:10de:1234:1234:1234:synthetic' }); f.workers([]);
  await f.routes.remove(event);
  expect(f.calls.filter(call => call === 'delete')).toHaveLength(3);
});

test('only platform administrators reach dedicated physical GPU MCP mutations and listing', async () => {
  const f = fixture();
  for (const name of ['hardware-devices.gpu.list', 'hardware-devices.gpu.assign', 'hardware-devices.gpu.release']) {
    for (const authority of [undefined, { scope: 'ordinary' }, { scope: 'group', ownerId: 'owner', groupId: 'group' }])
      await expect(f.domain.execute(name, { deviceId: 'gpu-device', workerId: 'worker', scope: 'platform' }, authority)).rejects.toMatchObject({ statusCode: authority?.scope === 'group' ? 403 : 401 });
  }
  expect(f.calls).toEqual([]);
  await expect(f.domain.execute('hardware-devices.gpu.assign', { deviceId: 'gpu-device', workerId: 'worker', lockPassword: 'synthetic' }, { scope: 'platform', reauthorize: async () => {} })).resolves.toMatchObject({ handled: true, result: { workerId: 'worker', passwordSupplied: true } });
  await expect(f.domain.execute('hardware-devices.gpu.release', { deviceId: 'gpu-device' }, { scope: 'platform', reauthorize: async () => {} })).resolves.toMatchObject({ handled: true, result: { workerId: null } });
  await f.domain.execute('hardware-devices.gpu.list', {}, { scope: 'platform', reauthorize: async () => {} });
  expect(f.calls).toEqual(['physical:worker', 'physical:none', 'list-physical']);
  const tools = f.domain.tools();
  expect(tools.find((tool: any) => tool.name === 'hardware-devices.gpu.assign').inputSchema.properties.lockPassword.writeOnly).toBe(true);
  expect(tools.find((tool: any) => tool.name === 'hardware-devices.gpu.release').annotations.destructiveHint).toBe(true);
});

test('ordinary owner cannot use generic administrative catalog/entitlement REST routes', async () => {
  const f = fixture();
  const event = { role: 'user', body: { ownerId: 'owner', deviceId: 'gpu-device', enabled: false, role: 'admin' } };
  await expect(f.routes.remove(event)).rejects.toMatchObject({ statusCode: 403 });
  await expect(f.routes.entitlement(event)).rejects.toMatchObject({ statusCode: 403 });
  expect(f.calls).toEqual([]);
});


test('MCP worker cloning omits physical GPU ownership while retaining USB and mediated GPU selections', async () => {
  const worker = { id: 'source', userId: 'owner', displayName: 'Source', hardwareDeviceIds: ['physical', 'usb', 'mediated'] };
  const devices: Record<string, any> = { physical: { kind: 'gpu', selector: 'pci-gpu:synthetic' },
    usb: { kind: 'usb', selector: 'usb:synthetic' }, mediated: { kind: 'gpu', selector: 'drm:pci:synthetic' } };
  let request: any;
  const cm = { get: () => worker, create: async (input: any) => {
    request = input; return { id: 'clone', containerId: 'clone-vm', userId: 'owner' };
  } };
  const { ManagementWorkerDomain } = load('utils/management-worker-domain.ts', {
    '../../shared/types': { PREDEFINED_ENV_VAR_KEYS: [] },
    './services': { useContainerManager: () => cm, useHardwareDeviceStore: () => ({ getDevice: (id: string) => devices[id] }),
      useWorkerGroupStore: () => ({ listForUser: () => [] }) },
    './hardware-device-store': { isPhysicalGpuDevice: (device: any) => device?.selector.startsWith('pci-gpu:') },
    './worker-protection-lock': { useWorkerProtectionLockStore: () => ({ verify: async () => {} }) },
    './worker-config-store': { useWorkerConfigStore: () => ({ resolveValues: async () => [] }) },
    './workspace-inventory': { findWorkspaceInventory: async () => ({ state: 'available' }) },
    './workspace-access': { OfflineWorkspaceAccess: class { async cloneInto() {} } },
    './worker-self-access': { withEffectiveWorkerSelfApiAccess: (value: any) => value },
    './image-catalog': {}, './worker-config-response': {}, './worker-group-manager': {},
    './group-admin-workspace-store': {}, './worker-group-hierarchy': {}, './worker-group-env': {}, './worker-group-response': {},
  });
  await expect(new ManagementWorkerDomain().execute('workers.clone', { workerId: worker.id })).resolves.toMatchObject({ handled: true });
  expect(request.hardwareDeviceIds).toEqual(['usb', 'mediated']);
  expect(worker.hardwareDeviceIds).toEqual(['physical', 'usb', 'mediated']);
});


test('dedicated GPU REST endpoints reject ordinary users before calling administrative helpers', async () => {
  const f = fixture();
  const event = { role: 'user', body: { deviceId: 'gpu-device', workerId: 'worker', role: 'admin', scope: 'platform' } };
  await expect(f.gpuRoutes.list(event)).rejects.toMatchObject({ statusCode: 403 });
  await expect(f.gpuRoutes.set(event)).rejects.toMatchObject({ statusCode: 403 });
  expect(f.calls).toEqual([]);
  f.currentRole('user');
  await expect(f.gpuRoutes.set({ role: 'admin', body: event.body })).rejects.toMatchObject({ statusCode: 403 });
  expect(f.calls).toEqual([]);
  f.currentRole('admin');
  await f.gpuRoutes.list({ role: 'admin' });
  await f.gpuRoutes.set({ role: 'admin', body: { deviceId: 'gpu-device', workerId: 'worker' } });
  expect(f.calls).toEqual(['list-physical', 'physical:worker']);
});

test('queued release of GPU A cannot release replacement GPU B on the same worker', async () => {
  const worker = { id: 'worker', userId: 'owner', hardwareDeviceIds: ['gpu-a'] };
  let binding: any = { userId: worker.userId, workerId: worker.id };
  let mutations = 0, authorized = 0;
  const store = { getDevice: () => ({ id: 'gpu-a', physicalAssignment: binding }) };
  const workers = { list: () => [worker], findById: () => worker, get: () => worker };
  const manager = { setPhysicalGpuSelection: async (id: string, deviceId: string | undefined, check: () => Promise<void>) => {
    expect(id).toBe('worker'); expect(deviceId).toBeUndefined();
    binding = undefined; worker.hardwareDeviceIds = ['gpu-b'];
    await check();
    mutations++;
  } };
  const { setPhysicalGpuAssignment } = load('utils/physical-gpu-management.ts', {
    './services': { useHardwareDeviceStore: () => store, useWorkerStore: () => workers, useContainerManager: () => manager },
    './hardware-device-store': { isNvidiaPhysicalGpuDevice: () => true },
    './worker-protection-lock': { useWorkerProtectionLockStore: () => ({ verify: async () => {} }) },
  });
  await expect(setPhysicalGpuAssignment('gpu-a', null, async () => { authorized++; })).rejects.toMatchObject({ statusCode: 409 });
  expect(authorized).toBeGreaterThan(1);
  expect(mutations).toBe(0);
  expect(worker.hardwareDeviceIds).toEqual(['gpu-b']);
});


test('GPU MCP operations require server-held live authority and honor revocation during assignment', async () => {
  const f = fixture();
  await expect(f.domain.execute('hardware-devices.gpu.assign', { deviceId: 'gpu-device', workerId: 'worker',
    reauthorize: async () => {} }, { scope: 'platform' })).rejects.toMatchObject({ statusCode: 403 });
  let checks = 0;
  const authority = { scope: 'platform', reauthorize: async () => {
    if (++checks > 1) throw Object.assign(new Error('Revoked'), { statusCode: 403 });
  } };
  await expect(f.domain.execute('hardware-devices.gpu.assign', { deviceId: 'gpu-device', workerId: 'worker' }, authority)).rejects.toMatchObject({ statusCode: 403 });
  expect(checks).toBe(2);
  expect(f.calls).toEqual([]);
});


test('catalog REST and MCP responses omit host identity and assignment incarnation receipts', async () => {
  const f = fixture();
  f.setDevice({ ...f.device(), physicalIdentity: { bootId: 'private-synthetic-boot', inode: 'private-synthetic-inode' },
    physicalAssignment: { userId: 'owner', workerId: 'worker', incarnation: 'private-synthetic-incarnation' } });
  const responses = [await f.routes.approve({ role: 'admin', body: {} }), await f.routes.rename({ role: 'admin', body: {} })];
  for (const name of ['hardware-devices.discover', 'hardware-devices.catalog.list', 'hardware-devices.catalog.approve',
    'hardware-devices.catalog.update', 'hardware-devices.entitlements.list'])
    responses.push((await f.domain.execute(name, { ownerId: 'owner', deviceId: 'gpu-device' }, { scope: 'platform' })).result);
  for (const response of responses) {
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('private-synthetic');
    expect(serialized).not.toContain('physicalIdentity');
    expect(serialized).not.toContain('incarnation');
    expect(serialized).toContain('worker');
  }
  expect(publicHardwareDevice(f.device()).physicalAssignment).toEqual({ userId: 'owner', workerId: 'worker' });
  expect(f.device().physicalAssignment.incarnation).toBe('private-synthetic-incarnation');
  expect(f.device().physicalIdentity.bootId).toBe('private-synthetic-boot');
});
