import { DockerService } from "../../orchestrator/server/utils/docker";
import { test, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HardwareDeviceStore } from '../../orchestrator/server/utils/hardware-device-store';
import { WorkerStore, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { resolveIncusHardware, incusHardwareDevices, assertIncusHardwareLayout, assertIncusHardwareExclusive, type IncusHardwareOptions } from '../../orchestrator/server/utils/incus-hardware';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { HARDWARE_DEVICE_PROBE } from '../../orchestrator/server/utils/hardware-device-probe';
import type { Config } from '../../orchestrator/server/utils/config';
import type { HardwareDeviceCandidate } from '../../orchestrator/shared/types';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
const candidate: HardwareDeviceCandidate = { kind: 'usb', name: 'Serial adapter', selector: 'usb:0403:6001:stable-123',
  vendor: '0403', product: '6001', serial: 'stable-123', deviceNodes: ['/dev/bus/usb/001/004'], groupIds: [],
  incus: { supported: true, mode: 'usb-exclusive', reason: 'Exclusive USB' } };
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-hardware-native-'));
  const config = { dataDir, incusUsbEnabled: true, incusProject: 'agentor', containerPrefix: 'agentor-worker' } as Config;
  const workers = new WorkerStore(dataDir), groups = new WorkerGroupStore(dataDir);
  await Promise.all([workers.init(), groups.init()]);
  const record: WorkerRecord = { id: randomUUID(), userId: 'owner', displayName: 'USB worker', status: 'active', runtimeKind: 'incus-vm',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let inventory = [structuredClone(candidate)];
  const discover = async () => structuredClone(inventory);
  const hardware = new HardwareDeviceStore(dataDir, discover, groups, workers); await hardware.init();
  const device = await hardware.approveDevice({ selector: candidate.selector });
  record.hardwareDeviceIds = [device.id]; await workers.upsert(record);
  await hardware.setEntitlement(record.userId, device.id, true);
  await hardware.createOwnerGrant(record.userId, { deviceId: device.id, targetType: 'all' });
  const opts: IncusHardwareOptions = { id: record.id, userId: record.userId, containerName: 'agentor-worker-' + record.id,
    hardwareDevices: [{ deviceId: device.id, deviceNodes: ['/dev/forged'], groupIds: [] }] };
  return { dataDir, config, workers, record, hardware, device, opts, discover,
    inventory: (value: HardwareDeviceCandidate[]) => { inventory = value; },
    resolve: () => resolveIncusHardware(config, opts, discover, 'attach'),
    cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test('USB resolves opaque grants into exact serial assignment and survives node renumbering', async () => {
  const f = await fixture(); try {
    const initial = await f.resolve();
    expect(Object.values(initial)).toEqual([{ type: 'usb', vendorid: '0403', productid: '6001', serial: 'stable-123', required: 'true' }]);
    f.inventory([{ ...candidate, deviceNodes: ['/dev/bus/usb/002/009'] }]);
    expect(await f.resolve()).toEqual(initial);
    expect(JSON.stringify(initial)).not.toContain('forged');
  } finally { await f.cleanup(); }
});

test('missing, duplicate, serial-less, storage and unsupported GPU evidence fail closed', async () => {
  const f = await fixture(); try {
    for (const inventory of [[], [candidate, candidate], [{ ...candidate, serial: undefined }],
      [{ ...candidate, incus: { supported: false, mode: 'unsupported' as const, reason: 'USB storage is protected' } }]]) {
      f.inventory(inventory); await expect(f.resolve()).rejects.toThrow();
    }
    expect(() => incusHardwareDevices([{ deviceId: f.device.id, deviceNodes: [], groupIds: [], candidate: {
      ...candidate, kind: 'gpu', incus: { supported: false, mode: 'unsupported', reason: 'Intel iGPU sharing is unsupported' },
    } }])).toThrow('Intel iGPU sharing is unsupported');
    expect(f.workers.get('owner', f.record.id)?.hardwareDeviceIds).toEqual([f.device.id]);
  } finally { await f.cleanup(); }
});

test('fresh entitlement and assignment revocation denies reuse without trusting stale resolution', async () => {
  const f = await fixture(); try {
    await f.resolve(); await f.hardware.setEntitlement('owner', f.device.id, false);
    await expect(f.resolve()).rejects.toThrow('not assigned');
  } finally { await f.cleanup(); }
});

test('stopped active legacy/native peers reserve USB; archive releases and unarchive rechecks', async () => {
  const f = await fixture(); try {
    for (const runtimeKind of ['legacy-docker', 'incus-vm'] as const) {
      const peer = { ...f.record, id: randomUUID(), userId: 'other-owner', runtimeKind, desiredRuntimeStatus: 'stopped' as const };
      await f.workers.upsert(peer); await expect(f.resolve()).rejects.toThrow('exclusively reserved');
      await f.workers.archive(peer.userId, peer.id); await f.resolve();
      await f.workers.unarchive(peer.userId, peer.id); await expect(f.resolve()).rejects.toThrow('exclusively reserved');
      await f.workers.archive(peer.userId, peer.id);
    }
  } finally { await f.cleanup(); }
});

test('raw caller device IDs, changed durable intent and disabled installation cannot select hardware', async () => {
  const f = await fixture(); try {
    f.config.incusUsbEnabled = false; await expect(f.resolve()).rejects.toThrow('disabled'); f.config.incusUsbEnabled = true;
    f.opts.hardwareDevices![0]!.deviceId = randomUUID(); await expect(f.resolve()).rejects.toThrow('durable worker');
    f.opts.hardwareDevices![0]!.deviceId = f.device.id;
    await f.workers.upsert({ ...f.record, hardwareDevicesRevoked: true }); await expect(f.resolve()).rejects.toThrow('durable worker');
  } finally { await f.cleanup(); }
});

test('migration admission preserves grants; attaching requires captured validating destination', async () => {
  const f = await fixture(); try {
    await f.workers.upsert({ ...f.record, runtimeKind: 'legacy-docker' });
    await resolveIncusHardware(f.config, f.opts, f.discover, 'preflight');
    await expect(f.resolve()).rejects.toThrow('durable worker');
    const nonce = randomUUID(), incarnation = randomUUID();
    const migration = { nonce, phase: 'validating' as const, destinationIncarnation: incarnation,
      source: { containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), createdAt: f.record.createdAt, wasRunning: true } };
    await f.workers.upsert({ ...f.record, runtimeKind: 'legacy-docker', incusMigration: migration });
    f.opts.recreationNonce = nonce;
    const instance = { config: { 'volatile.uuid': incarnation, 'user.agentor.recreation': nonce } } as any;
    await resolveIncusHardware(f.config, f.opts, f.discover, 'attach', instance);
    instance.config['volatile.uuid'] = randomUUID();
    await expect(resolveIncusHardware(f.config, f.opts, f.discover, 'attach', instance)).rejects.toThrow();
    expect(f.workers.get('owner', f.record.id)?.hardwareDeviceIds).toEqual([f.device.id]);
  } finally { await f.cleanup(); }
});

test('device layout rejects broad USB, arbitrary PCI/GPU and profile or expanded-device injection', async () => {
  const f = await fixture(); try {
    const devices = await f.resolve(); const instance = { devices, profiles: [], config: {} } as any;
    expect(() => assertIncusHardwareLayout(instance, devices)).not.toThrow();
    for (const type of ['usb', 'gpu', 'pci', 'unix-char', 'unix-block', 'unix-hotplug'])
      expect(() => assertIncusHardwareLayout({ ...instance, expanded_devices: { ...devices, evil: { type } } }, devices)).toThrow();
    expect(() => assertIncusHardwareLayout({ ...instance, profiles: ['default'] }, devices)).toThrow();
    expect(() => assertIncusHardwareLayout(instance, {})).toThrow('rebuild');
  } finally { await f.cleanup(); }
});

test('exclusive check rejects exact or broad peer assignments including stopped foreign instances', async () => {
  const expected = incusHardwareDevices([{ deviceId: randomUUID(), candidate, deviceNodes: [], groupIds: [] }]);
  for (const usb of [{ type: 'usb' }, { type: 'usb', serial: candidate.serial }, Object.values(expected)[0]])
    expect(() => assertIncusHardwareExclusive('self', expected, [{ name: 'foreign', status: 'Stopped', devices: { usb } } as any])).toThrow('another Incus instance');
  expect(() => assertIncusHardwareExclusive('self', expected, [{ name: 'foreign', devices: { usb: { type: 'usb', vendorid: '9999' } } } as any])).not.toThrow();
});

test('runtime checks explicit restricted USB policy before allowing hardware', async () => {
  const f = await fixture(); try {
    const project = { config: { restricted: 'true', 'restricted.devices.usb': 'block' } as Record<string, string> };
    const runtime = new IncusWorkerRuntime(f.config, { request: async () => project, listInstances: async () => [] } as any);
    runtime.setHardwareDiscovery(f.discover);
    await expect(runtime.preflightHardware(f.opts)).rejects.toThrow('USB-only');
    project.config['restricted.devices.usb'] = 'allow'; await runtime.preflightHardware(f.opts);
    project.config['restricted.devices.pci'] = 'allow'; await expect(runtime.preflightHardware(f.opts)).rejects.toThrow('USB-only');
  } finally { await f.cleanup(); }
});

async function probe(classes: string[], options: { serial?: string; block?: boolean; deviceClass?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-usb-sysfs-'));
  try {
    const usb = join(root, 'sys/bus/usb/devices/1-2'); await mkdir(usb, { recursive: true });
    const values = { idVendor: '0403', idProduct: '6001', busnum: '1', devnum: '4', bDeviceClass: options.deviceClass ?? '00', serial: options.serial ?? 'stable' };
    for (const [key, value] of Object.entries(values)) await writeFile(join(usb, key), value);
    for (let index = 0; index < classes.length; index++) {
      const path = join(usb, `1-2:1.${index}`); await mkdir(path); await writeFile(join(path, 'bInterfaceClass'), classes[index]!);
    }
    if (options.block) await mkdir(join(usb, 'block'));
    const node = join(root, 'dev/bus/usb/001'); await mkdir(node, { recursive: true }); await symlink('/dev/null', join(node, '004'));
    const script = HARDWARE_DEVICE_PROBE.replace("root = Path('/host')", 'import sys\nroot = Path(sys.argv[1])');
    return JSON.parse(execFileSync('python3', ['-c', script, root], { encoding: 'utf8', timeout: 5000 }))[0] as HardwareDeviceCandidate;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('real discovery script refuses USB mass storage, hubs, block descendants and unknown interfaces', async () => {
  for (const [classes, options] of [[['08'], {}], [['ff'], { block: true }], [['09'], {}], [['ff'], { deviceClass: '09' }], [[], {}], [['00'], {}]] as const)
    expect((await probe([...classes], options)).incus?.supported).toBe(false);
  expect((await probe(['ff'])).incus).toMatchObject({ supported: true, mode: 'usb-exclusive' });
  expect((await probe(['ff'], { serial: '' })).incus?.reason).toContain('serial');
});


test('live legacy mappings block a claim after desired device intent was removed', async () => {
  const docker = new DockerService({} as Config);
  docker.discoverHardwareDevices = async () => [structuredClone(candidate)];
  docker.listContainers = async () => [{ Id: 'legacy-container', State: 'running', Labels: { 'agentor.id': 'other-worker' } }] as any;
  (docker as any).docker = { getContainer: () => ({ inspect: async () => ({ Id: 'legacy-container',
    Config: { Labels: { 'agentor.managed': 'true' } }, State: { Running: true },
    HostConfig: { Devices: [{ PathOnHost: candidate.deviceNodes[0] }] } }) }) };
  expect((await docker.discoverIncusHardwareDevices('new-worker'))[0]?.incus).toMatchObject({ supported: false });
  expect((await docker.discoverIncusHardwareDevices('other-worker'))[0]?.incus).toMatchObject({ supported: true });
});
