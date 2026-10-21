import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { HardwareDeviceStore } from '../../orchestrator/server/utils/hardware-device-store';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { useHardwareDeviceStore } from '../../orchestrator/server/utils/services';
import type { HardwareDeviceCandidate } from '../../orchestrator/shared/types';

// Entirely synthetic Incus transport; no host driver, PCI or device access.
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-direct-gpu-'));
  const workers = new WorkerStore(dataDir), groups = new WorkerGroupStore(dataDir);
  await Promise.all([workers.init(), groups.init()]);
  const id = randomUUID(), incarnation = randomUUID(), owner = { id, userId: 'synthetic-owner', containerName: 'worker-' + id };
  const info: any = { ...owner, runtimeKind: 'incus-vm', containerId: 'incus:' + incarnation,
    displayName: 'Synthetic worker', status: 'stopped', desiredRuntimeStatus: 'stopped',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  await workers.upsert({ ...info, status: 'active' });
  const candidate: HardwareDeviceCandidate = { kind: 'gpu', name: 'Synthetic NVIDIA',
    vendor: '10de', product: '1234', serial: 'synthetic-serial', selector: 'pci-gpu:10de:1234:10de:0000:synthetic-serial',
    deviceNodes: [], groupIds: [], incus: { supported: true, mode: 'gpu-physical', reason: 'Synthetic isolated GPU',
      evidence: { pciAddress: '0000:04:00.0', driver: 'vfio-pci', bootVga: false, iommuGroup: '24', iommuMembers: ['0000:04:00.0'] } } };
  let inventory = [candidate], lost = false, writes = 0, authorization = true;
  const hardware = new HardwareDeviceStore(dataDir, async () => inventory, groups, workers); await hardware.init();
  const device = await hardware.approveDevice({ selector: candidate.selector });
  const globalHardware: any = useHardwareDeviceStore(), saved = new Map<string, any>();
  for (const name of ['getDevice', 'listCatalog', 'setPhysicalGpuAssignment', 'authorizeDeviceIds', 'canWorkerUseDevice']) {
    saved.set(name, globalHardware[name]); globalHardware[name] = (hardware as any)[name].bind(hardware);
  }
  const initial: any = { name: owner.containerName, type: 'virtual-machine', status: 'Stopped', profiles: [],
    config: { 'volatile.uuid': incarnation, 'user.agentor.id': id, 'user.agentor.owner': owner.userId,
      'user.agentor.installation': await backupInstallationId(dataDir) },
    devices: { root: { type: 'disk', path: '/', pool: 'synthetic' },
      workspace: { type: 'disk', source: 'synthetic-workspace', pool: 'synthetic' },
      agents: { type: 'disk', source: 'synthetic-agents', pool: 'synthetic' },
      eth0: { type: 'nic', network: 'synthetic' } } };
  const actual = structuredClone(initial);
  const client: any = { getInstance: async () => structuredClone(actual), getInstanceState: async () => ({ status: actual.status }),
    listInstances: async () => [], request: async () => ({ config: { restricted: 'true', 'restricted.devices.gpu': 'allow',
      'user.agentor.gpu-physical': 'true', 'restricted.virtual-machines.lowlevel': 'block' } }),
    updateInstanceDevices: async (_name: string, devices: any, _accepted: any, expected: any) => {
      expect(expected).toEqual(actual); expect(actual.status).toBe('Stopped');
      expect(workers.get(owner.userId, id)?.hardwareDevicesRevoked).toBe(true);
      expect(hardware.getDevice(device.id)?.physicalAssignment).toMatchObject({ userId: owner.userId, workerId: id });
      writes++; actual.devices = structuredClone(devices);
      if (lost) throw Error('Lost native configuration response');
    } };
  const config: any = { dataDir, containerPrefix: 'worker', incusProject: 'synthetic', incusGpuPhysicalEnabled: true };
  const runtime = new IncusWorkerRuntime(config, client); runtime.assertWorkspaceReplacementSettled = async () => {};
  const manager = new ContainerManager({ discoverIncusHardwareDevices: async () => inventory } as any, config);
  manager.setWorkerStore(workers); manager.setIncusRuntime(runtime);
  (manager as any).assertOwnerExists = async () => {};
  (manager as any).containers.set(id, info);
  const authorize = async () => { if (!authorization) throw Object.assign(Error('Not a platform administrator'), { statusCode: 403 }); };
  return { dataDir, manager, workers, hardware, runtime, device, id, incarnation, owner, info, initial, actual,
    get writes() { return writes; }, set lost(value: boolean) { lost = value; },
    disconnect() { inventory = []; }, deny() { authorization = false; }, authorize,
    assign: () => manager.setPhysicalGpuSelection(id, device.id, authorize),
    release: () => manager.setPhysicalGpuSelection(id, undefined, authorize),
    cleanup: async () => { for (const [name, value] of saved) globalHardware[name] = value; await rm(dataDir, { recursive: true, force: true }); } };
}

test('admin cold assignment and lost-device release preserve ordinary VM root and volumes', async () => {
  const f = await fixture(); try {
    await f.assign();
    expect(f.writes).toBe(1); expect(Object.values(f.actual.devices)).toContainEqual({ type: 'gpu', gputype: 'physical', pci: '0000:04:00.0' });
    expect(f.actual.config).toEqual(f.initial.config); expect(f.actual.devices.root).toEqual(f.initial.devices.root);
    expect(f.workers.get(f.owner.userId, f.id)).toMatchObject({ hardwareDeviceIds: [f.device.id], hardwareDevicesRevoked: false, pendingRebuild: false });
    f.disconnect(); await f.release();
    expect(f.actual).toEqual(f.initial); expect(f.writes).toBe(2);
    expect(f.hardware.getDevice(f.device.id)?.physicalAssignment).toBeUndefined();
    expect(f.workers.get(f.owner.userId, f.id)?.hardwareDeviceIds).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('running, unauthorized and unrelated-pending workers remain unchanged', async () => {
  for (const reason of ['running', 'unauthorized', 'pending']) {
    const f = await fixture(); try {
      if (reason === 'running') f.actual.status = 'Running';
      if (reason === 'unauthorized') f.deny();
      if (reason === 'pending') f.info.pendingRebuild = true;
      await expect(f.assign()).rejects.toThrow(); expect(f.writes).toBe(0);
      expect(f.hardware.getDevice(f.device.id)?.physicalAssignment).toBeUndefined();
      expect(f.workers.get(f.owner.userId, f.id)?.hardwareDevicesRevoked).toBeUndefined();
    } finally { await f.cleanup(); }
  }
});

test('lost native responses preserve recovery fences and retries converge without restarting the VM', async () => {
  const f = await fixture(); try {
    f.lost = true; await expect(f.assign()).rejects.toThrow('Lost native');
    expect(f.workers.get(f.owner.userId, f.id)).toMatchObject({ hardwareDeviceIds: [f.device.id], hardwareDevicesRevoked: true, pendingRebuild: true });
    expect(f.hardware.getDevice(f.device.id)?.physicalAssignment).toBeDefined();
    await expect(f.manager.rebuild(f.id)).rejects.toMatchObject({ statusCode: 409 });
    f.lost = false; await f.assign(); expect(f.writes).toBe(1);
    f.lost = true; await expect(f.release()).rejects.toThrow('Lost native');
    expect(f.hardware.getDevice(f.device.id)?.physicalAssignment).toBeDefined();
    expect(f.workers.get(f.owner.userId, f.id)?.hardwareDevicesRevoked).toBe(true);
    f.lost = false; await f.release(); expect(f.writes).toBe(2);
    expect(f.actual).toEqual(f.initial); expect(f.workers.get(f.owner.userId, f.id)?.hardwareDevicesRevoked).toBe(false);
  } finally { await f.cleanup(); }
});

test('generic updates, archive and delete cannot revoke a physical assignment', async () => {
  const f = await fixture(); try {
    await f.assign(); const originalName = f.info.displayName;
    await expect(f.manager.updateSettings(f.id, { displayName: 'must remain unchanged', hardwareDeviceIds: [] })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.info.displayName).toBe(originalName);
    await expect(f.manager.archive(f.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.manager.remove(f.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.writes).toBe(1); await f.release();
  } finally { await f.cleanup(); }
});

test('durable fence failure submits no catalog or native mutation, and completion failure retains recovery', async () => {
  const f = await fixture(); try {
    const update = f.workers.updateHardwareDeviceAccess.bind(f.workers);
    f.workers.updateHardwareDeviceAccess = async () => { throw Error('Fence persistence failed'); };
    await expect(f.assign()).rejects.toThrow('Fence persistence'); expect(f.writes).toBe(0);
    expect(f.hardware.getDevice(f.device.id)?.physicalAssignment).toBeUndefined();
    f.workers.updateHardwareDeviceAccess = update;
    const upsert = f.workers.upsert.bind(f.workers);
    f.workers.upsert = async record => { if (record.hardwareDevicesRevoked === false) throw Error('Completion persistence failed'); await upsert(record); };
    await expect(f.assign()).rejects.toThrow('Completion persistence');
    expect(f.workers.get(f.owner.userId, f.id)?.hardwareDevicesRevoked).toBe(true);
    expect(f.hardware.getDevice(f.device.id)?.physicalAssignment).toBeDefined();
    f.workers.upsert = upsert; await f.assign(); await f.release();
  } finally { await f.cleanup(); }
});

test('interrupted GPU changes reject an adopted replacement UUID while completed assignments survive ordinary rebuild', async () => {
  for (const interrupted of [true, false]) {
    const f = await fixture(); try {
      if (interrupted) { f.lost = true; await expect(f.assign()).rejects.toThrow('Lost native'); f.lost = false; }
      else await f.assign();
      const replacement = randomUUID();
      f.info.containerId = 'incus:' + replacement; f.actual.config['volatile.uuid'] = replacement;
      if (interrupted) {
        await expect(f.release()).rejects.toMatchObject({ statusCode: 409 });
        expect(f.writes).toBe(1);
        expect(f.hardware.getDevice(f.device.id)?.physicalAssignment?.incarnation).toBe(f.incarnation);
      } else {
        await f.release(); expect(f.writes).toBe(2);
        expect(f.hardware.getDevice(f.device.id)?.physicalAssignment).toBeUndefined();
      }
    } finally { await f.cleanup(); }
  }
});

test('failed final catalog release retains a retryable captured binding after the VM is positively GPU-free', async () => {
  const f = await fixture(); try {
    await f.assign();
    const set = f.hardware.setPhysicalGpuAssignment.bind(f.hardware);
    f.hardware.setPhysicalGpuAssignment = async (id, target, expected) => {
      if (!target) throw Error('Catalog release persistence failed');
      return set(id, target, expected);
    };
    // The shared facade delegates through this test's current method too.
    const facade: any = useHardwareDeviceStore();
    facade.setPhysicalGpuAssignment = (...args: Parameters<typeof set>) => f.hardware.setPhysicalGpuAssignment(...args);
    await expect(f.release()).rejects.toThrow('Catalog release persistence');
    expect(f.actual).toEqual(f.initial);
    expect(f.hardware.getDevice(f.device.id)?.physicalAssignment?.incarnation).toBe(f.incarnation);
    expect(f.workers.get(f.owner.userId, f.id)?.hardwareDeviceIds).toBeUndefined();
    f.hardware.setPhysicalGpuAssignment = set;
    await f.release(); expect(f.writes).toBe(2);
    expect(f.hardware.getDevice(f.device.id)?.physicalAssignment).toBeUndefined();
  } finally { await f.cleanup(); }
});
