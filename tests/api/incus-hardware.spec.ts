import { DockerService } from "../../orchestrator/server/utils/docker";
import { test, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { HardwareDeviceStore } from '../../orchestrator/server/utils/hardware-device-store';
import { WorkerStore, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { resolveIncusHardware, incusHardwareDevices, assertIncusHardwareLayout, assertIncusHardwareExclusive, INCUS_MDEV_GUEST_SETUP, type IncusHardwareOptions } from '../../orchestrator/server/utils/incus-hardware';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { HARDWARE_DEVICE_PROBE } from '../../orchestrator/server/utils/hardware-device-probe';
import type { Config } from '../../orchestrator/server/utils/config';
import type { HardwareDeviceCandidate } from '../../orchestrator/shared/types';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
const candidate: HardwareDeviceCandidate = { kind: 'usb', name: 'Serial adapter', selector: 'usb:0403:6001:stable-123',
  vendor: '0403', product: '6001', serial: 'stable-123', deviceNodes: ['/dev/bus/usb/001/004'], groupIds: [],
  incus: { supported: true, mode: 'usb-exclusive', reason: 'Exclusive USB' } };
async function fixture(initial: HardwareDeviceCandidate = candidate) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-hardware-native-'));
  const config = { dataDir, incusUsbEnabled: true, incusProject: 'agentor', containerPrefix: 'agentor-worker' } as Config;
  const workers = new WorkerStore(dataDir), groups = new WorkerGroupStore(dataDir);
  await Promise.all([workers.init(), groups.init()]);
  const record: WorkerRecord = { id: randomUUID(), userId: 'owner', displayName: 'USB worker', status: 'active', runtimeKind: 'incus-vm',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let inventory = [structuredClone(initial)];
  const discover = async () => structuredClone(inventory);
  const hardware = new HardwareDeviceStore(dataDir, discover, groups, workers); await hardware.init();
  const device = await hardware.approveDevice({ selector: initial.selector });
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

for (const kind of ['usb', 'gpu'] as const) test(`${kind} migration admission preserves grants; attaching requires captured validating destination`, async () => {
  const f = await fixture(kind === 'gpu' ? gpu : candidate); try {
    if (kind === 'gpu') f.config.incusGpuMdevProfile = gpuProfile;
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
    await expect(runtime.preflightHardware(f.opts)).rejects.toThrow('USB/mdev-only');
    project.config['restricted.devices.usb'] = 'allow'; await runtime.preflightHardware(f.opts);
    project.config['restricted.devices.pci'] = 'allow'; await expect(runtime.preflightHardware(f.opts)).rejects.toThrow('USB/mdev-only');
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


const gpuProfile = 'i915-GVTg_V5_4';
const gpu: HardwareDeviceCandidate = { kind: 'gpu', name: 'Intel GPU', selector: 'drm:pci:0000:00:02.0',
  vendor: '8086', product: '5917', deviceNodes: ['/dev/dri/card0', '/dev/dri/renderD128'], groupIds: [44],
  incus: { supported: true, mode: 'gpu-mdev', reason: 'GVT-g profile', evidence: { driver: 'i915', gvtEnabled: true,
    bootVga: true, mediatedProfiles: [gpuProfile], mediatedAvailable: { [gpuProfile]: 1 }, mediatedInstances: {} } } };

test('Intel mdev requires exact operator profile and fresh GPU grant; physical passthrough is never selected', async () => {
  const f = await fixture(gpu); try {
    await expect(f.resolve()).rejects.toThrow('INCUS_GPU_MDEV_PROFILE');
    f.config.incusUsbEnabled = false;
    f.config.incusGpuMdevProfile = gpuProfile;
    const devices = await f.resolve();
    expect(Object.values(devices)).toEqual([{ type: 'gpu', gputype: 'mdev', pci: '0000:00:02.0', mdev: gpuProfile }]);
    for (const profile of ['../create', 'i915-GVTg_V5_8', 'physical', '']) {
      f.config.incusGpuMdevProfile = profile; await expect(f.resolve()).rejects.toThrow();
    }
    f.config.incusGpuMdevProfile = gpuProfile;
    await f.hardware.setEntitlement('owner', f.device.id, false);
    await expect(f.resolve()).rejects.toThrow('not assigned');
    expect(f.workers.get('owner', f.record.id)?.hardwareDeviceIds).toEqual([f.device.id]);
  } finally { await f.cleanup(); }
});

test('GPU capability and capacity fail closed; only a proven current owned allocation can reuse a full profile', () => {
  const deviceId = randomUUID();
  const input = { deviceId, candidate: gpu, deviceNodes: [], groupIds: [] };
  const devices = incusHardwareDevices([input], gpuProfile); const key = Object.keys(devices)[0]!;
  const allocated = randomUUID();
  const full = { ...gpu, incus: { ...gpu.incus!, evidence: { ...gpu.incus!.evidence!,
    mediatedAvailable: { [gpuProfile]: 0 }, mediatedInstances: { [gpuProfile]: [allocated] } } } };
  expect(() => incusHardwareDevices([{ ...input, candidate: full }], gpuProfile)).toThrow('capacity');
  const instance = { status: 'Running', devices, config: { [`volatile.${key}.vgpu.uuid`]: allocated } } as any;
  expect(incusHardwareDevices([{ ...input, candidate: full }], gpuProfile, instance)).toEqual(devices);
  for (const changed of [{ ...instance, status: 'Stopped' }, { ...instance, config: {} },
    { ...instance, devices: { [key]: { ...devices[key], pci: '0000:00:03.0' } } }])
    expect(() => incusHardwareDevices([{ ...input, candidate: full }], gpuProfile, changed)).toThrow('capacity');
  for (const evidence of [{ driver: 'vfio-pci' }, { gvtEnabled: false }, { mediatedProfiles: [] },
    { mediatedAvailable: { [gpuProfile]: -1 } }, { mediatedAvailable: { [gpuProfile]: Number.NaN } }])
    expect(() => incusHardwareDevices([{ ...input, candidate: { ...gpu, incus: { ...gpu.incus!, evidence: { ...gpu.incus!.evidence!, ...evidence } } } }], gpuProfile)).toThrow();
  expect(() => incusHardwareDevices([{ ...input, candidate: { ...gpu, selector: 'drm:pci:../../disk' } }], gpuProfile)).toThrow();
});

test('GPU reserves exact PCI and rejects broad or foreign raw assignments, including stopped peers', () => {
  const expected = incusHardwareDevices([{ deviceId: randomUUID(), candidate: gpu, deviceNodes: [], groupIds: [] }], gpuProfile);
  for (const device of [{ type: 'gpu' }, { type: 'gpu', gputype: 'physical', pci: '0000:00:02.0' },
    { type: 'gpu', gputype: 'mdev', pci: '0000:00:02.0', mdev: gpuProfile }, { type: 'pci', address: '0000:00:02.0' }])
    expect(() => assertIncusHardwareExclusive('self', expected, [{ name: 'other', status: 'Stopped', devices: { device } } as any])).toThrow('GPU');
  expect(() => assertIncusHardwareExclusive('self', expected, [{ name: 'other', devices: { device: { type: 'gpu', pci: '0000:01:00.0' } } } as any])).not.toThrow();
});

test('mdev runtime requires matching explicit project profile and never enables raw PCI authority', async () => {
  const f = await fixture(gpu); try {
    f.config.incusUsbEnabled = false; f.config.incusGpuMdevProfile = gpuProfile;
    const project = { config: { restricted: 'true', 'restricted.devices.gpu': 'allow', 'user.agentor.gpu-mdev-profile': gpuProfile } as Record<string, string> };
    const runtime = new IncusWorkerRuntime(f.config, { request: async () => project, listInstances: async () => [] } as any);
    runtime.setHardwareDiscovery(f.discover);
    await runtime.preflightHardware(f.opts);
    for (const [field, value] of [['restricted.devices.pci', 'allow'], ['restricted.devices.usb', 'allow'],
      ['restricted.virtual-machines.lowlevel', 'allow'], ['user.agentor.gpu-mdev-profile', 'different']]) {
      const old = project.config[field!]; project.config[field!] = value!;
      await expect(runtime.preflightHardware(f.opts)).rejects.toThrow('restricted project');
      if (old === undefined) delete project.config[field!]; else project.config[field!] = old;
    }
  } finally { await f.cleanup(); }
});

test('real GPU discovery reports only live Intel GVT-g profiles and availability without creating a device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-gvt-sysfs-'));
  try {
    const pci = join(root, 'sys/bus/pci/devices/0000:00:02.0'), driver = join(root, 'sys/bus/pci/drivers/i915');
    await mkdir(pci, { recursive: true }); await mkdir(driver, { recursive: true }); await symlink(driver, join(pci, 'driver'));
    for (const [key, value] of Object.entries({ vendor: '0x8086', device: '0x5917', boot_vga: '1' })) await writeFile(join(pci, key), value);
    for (const name of ['card0', 'renderD128']) {
      const path = join(root, 'sys/class/drm', name); await mkdir(path, { recursive: true }); await symlink(pci, join(path, 'device'));
    }
    await mkdir(join(root, 'dev/dri'), { recursive: true }); await symlink('/dev/null', join(root, 'dev/dri/renderD128')); await symlink('/dev/null', join(root, 'dev/dri/card0'));
    const params = join(root, 'sys/module/i915/parameters'); await mkdir(params, { recursive: true }); await writeFile(join(params, 'enable_gvt'), 'N');
    const profile = join(pci, 'mdev_supported_types', gpuProfile); await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'available_instances'), '1'); await writeFile(join(profile, 'device_api'), 'vfio-pci');
    const script = HARDWARE_DEVICE_PROBE.replace("root = Path('/host')", 'import sys\nroot = Path(sys.argv[1])');
    const read = () => JSON.parse(execFileSync('python3', ['-c', script, root], { encoding: 'utf8', timeout: 5000 }))[0];
    expect(read().incus).toMatchObject({ supported: false, evidence: { gvtEnabled: false } });
    await writeFile(join(params, 'enable_gvt'), 'Y');
    expect(read().incus).toMatchObject({ supported: true, mode: 'gpu-mdev', evidence: { mediatedAvailable: { [gpuProfile]: 1 } } });
    await writeFile(join(profile, 'device_api'), 'wrong'); expect(read().incus.supported).toBe(false);
    await writeFile(join(profile, 'device_api'), 'vfio-pci'); await writeFile(join(profile, 'available_instances'), 'unknown');
    expect(read().incus.supported).toBe(false);
    await expect((await import('node:fs/promises')).readdir(profile)).resolves.toEqual(expect.arrayContaining(['device_api', 'available_instances']));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GPU guest setup rejects missing/denied render access and configures only guest video/render membership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-gpu-guest-'));
  try {
    const bin = join(root, 'bin'); await mkdir(bin);
    for (const name of ['groupadd', 'usermod', 'udevadm'])
      await writeFile(join(bin, name), '#!/bin/sh\nprintf "%s %s\\n" "' + name + '" "$*" >> "$CALLS"\n', { mode: 0o755 });
    const runner = join(bin, 'runuser'); await writeFile(runner, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
    const script = INCUS_MDEV_GUEST_SETUP.replaceAll('/sys/class/drm', join(root, 'drm')).replaceAll('/dev/dri', join(root, 'dev'));
    const options = { env: { ...process.env, PATH: bin + ':/usr/bin:/bin', CALLS: join(root, 'calls') }, encoding: 'utf8' as const, timeout: 5000, stdio: 'pipe' as const };
    expect(() => execFileSync('bash', ['-ec', script], options)).toThrow();
    const card = join(root, 'drm/renderD128/device'); await mkdir(card, { recursive: true });
    await mkdir(join(root, 'i915')); await symlink(join(root, 'i915'), join(card, 'driver'));
    await mkdir(join(root, 'dev')); await symlink('/dev/null', join(root, 'dev/renderD128'));
    expect(() => execFileSync('bash', ['-ec', script], options)).not.toThrow();
    const calls = await (await import('node:fs/promises')).readFile(join(root, 'calls'), 'utf8');
    expect(calls).toContain('usermod -aG video,render agent');
    await writeFile(runner, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() => execFileSync('bash', ['-ec', script], options)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});


async function dockerProbeLogs(logs: string, exitCode: number, run: (docker: DockerService, calls: string[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-hardware-probe-logs-'));
  const socket = join(directory, 'docker.sock'), calls: string[] = [], id = 'a'.repeat(64);
  const server = createServer(async (request, response) => {
    const path = request.url!.split('?')[0];
    calls.push(`${request.method} ${path}`);
    const reply = (status: number, value?: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (request.method === 'GET' && path === '/images/worker:fixture/json') return reply(200, { Id: 'sha256:' + 'b'.repeat(64) });
    if (request.method === 'POST' && path === '/containers/create') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ Tty: true,
        HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Binds: ['/dev:/host/dev:ro', '/sys:/host/sys:ro'] } });
      return reply(201, { Id: id, Warnings: [] });
    }
    if (request.method === 'POST' && path === `/containers/${id}/start`) return reply(204);
    if (request.method === 'POST' && path === `/containers/${id}/wait`) return reply(200, { StatusCode: exitCode });
    if (request.method === 'GET' && path === `/containers/${id}/logs`) {
      response.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      response.end(logs); return;
    }
    if (request.method === 'DELETE' && path === `/containers/${id}`) return reply(204);
    reply(500, { message: 'Unexpected fixture request' });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const docker = new DockerService({ workerImagePrefix: '', workerImage: 'worker:fixture' } as Config);
  // Exercise actual Dockerode decoding against an owned socket, never a daemon.
  (docker as any).docker.modem.socketPath = socket;
  try { await run(docker, calls); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('actual Dockerode JSON log decoding preserves hardware inventory and probe cleanup', async () => {
  await dockerProbeLogs(JSON.stringify([gpu]) + '\n', 0, async (docker, calls) => {
    expect(await docker.discoverHardwareDevices()).toContainEqual(gpu);
    expect(calls.at(-1)).toBe('DELETE /containers/' + 'a'.repeat(64));
  });
});

test('failed hardware probe rejects before decoding its output and still removes its helper', async () => {
  await dockerProbeLogs('probe failed\n', 2, async (docker, calls) => {
    await expect(docker.discoverHardwareDevices()).rejects.toThrow('Host hardware probe failed');
    expect(calls.at(-1)).toBe('DELETE /containers/' + 'a'.repeat(64));
  });
});

test('shared Docker log reader retains raw buffers and parsed strings without changing their text', async () => {
  for (const [logs, expected] of [['plain worker output\r\nsecond line\n', 'plain worker output\r\nsecond line\n'],
    ['"quoted worker output"\n', 'quoted worker output'], ['null\n', 'null\n']]) {
    await dockerProbeLogs(logs!, 0, async docker => {
      expect(await docker.getLogs('a'.repeat(64))).toBe(expected);
    });
  }
});
