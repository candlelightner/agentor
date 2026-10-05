import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { ManagedNetworkStore } from '../../orchestrator/server/utils/managed-network-store';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { incusManagedBridgeIdentity, incusManagedNetworkDevice } from '../../orchestrator/server/utils/incus-managed-network-identity';
import type { Config } from '../../orchestrator/server/utils/config';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { ManagedVolumeStore } from '../../orchestrator/server/utils/managed-volume-store';
import { isWorkerLifecycleMutationPending } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

async function fixture(run: (f: any) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-managed-nic-runtime-'));
  try {
    const installation = await backupInstallationId(dataDir), incarnation = randomUUID();
    const state = { boot: randomUUID() };
    const owner = { id: 'worker', userId: 'owner', containerName: 'agentor-worker-worker' };
    const store = new ManagedNetworkStore(dataDir);
    const network = await store.create(owner.userId, 'managed test', 'selected');
    await store.update(owner.userId, network.id, { workerIds: [owner.id] });
    const identity = incusManagedBridgeIdentity(installation, network);
    const device = incusManagedNetworkDevice(installation, owner.id, network);
    const instance = { name: owner.containerName, type: 'virtual-machine', status: 'Running', profiles: [],
      config: { 'volatile.uuid': incarnation, 'user.agentor.installation': installation,
        'user.agentor.id': owner.id, 'user.agentor.owner': owner.userId },
      devices: { eth0: { type: 'nic', name: 'eth0', network: 'primary' }, root: { type: 'disk', path: '/', pool: 'pool' } } } as any;
    const calls: any[] = [];
    const client = {
      getInstance: async () => structuredClone(instance),
      getNetwork: async (name: string) => ({ name, type: 'bridge', managed: true, config: {} }),
      getNetworkLeases: async () => [],
      updateInstanceDevices: async (_name: string, devices: any) => { calls.push(['devices', devices]); instance.devices = structuredClone(devices); },
      pushFile: async (...args: any[]) => { calls.push(['file', ...args]); },
      exec: async (...args: any[]) => { calls.push(['exec', ...args]); return { returnCode: 0, stdout: args[1][0] === 'cat' ? state.boot : '', stderr: '' }; },
    };
    const runtime = new IncusWorkerRuntime({ dataDir, containerPrefix: 'agentor-worker' } as Config, client as any);
    await run({ runtime, client, calls, owner, incarnation, store, network, instance, identity, device, state });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
}

test('live managed NIC hotplug writes readable primary-safe MAC rule before update and preserves other devices', async () => {
  await fixture(async f => {
    const before = structuredClone(f.instance.devices);
    await f.runtime.setManagedNetwork(f.owner, f.incarnation, f.network.id, true);
    expect(f.instance.devices).toEqual({ ...before, [f.identity.key]: f.device });
    const file = f.calls.find((call: any[]) => call[0] === 'file');
    expect(file.slice(1)).toEqual([f.owner.containerName, `/run/systemd/network/00-agentor-${f.identity.key}.network`,
      expect.stringContaining(`MACAddress=${f.device.hwaddr}`), { uid: 0, gid: 0, mode: 0o644 }]);
    for (const setting of ['UseRoutes=no', 'UseDNS=no', 'UseDomains=no', 'IPv6AcceptRA=no', 'ClientIdentifier=mac']) expect(file[3]).toContain(setting);
    expect(f.calls.indexOf(file)).toBeLessThan(f.calls.findIndex((call: any[]) => call[0] === 'devices'));
    await f.runtime.setManagedNetwork(f.owner, f.incarnation, f.network.id, true);
    expect(f.calls.filter((call: any[]) => call[0] === 'devices')).toHaveLength(1);
    await f.store.update(f.owner.userId, f.network.id, { workerIds: [] });
    await f.runtime.setManagedNetwork(f.owner, f.incarnation, f.network.id, false);
    expect(f.instance.devices).toEqual(before);
    expect(f.calls.some((call: any[]) => call[0] === 'exec' && call[2][0] === 'rm')).toBe(true);
  });
});

test('managed topology uses only exact captured device and host leases; stopped and unattached states have no address', async () => {
  await fixture(async f => {
    f.client.getNetwork = async () => ({ name: f.identity.name, type: 'bridge', managed: true, config: {} });
    let leases = [{ hwaddr: f.device.hwaddr, address: '10.123.45.128', type: 'dynamic' }];
    f.client.getNetworkLeases = async () => leases;
    const inspect = () => f.runtime.inspectManagedNetwork(f.owner, f.incarnation, f.network.id);
    expect(await inspect()).toEqual({ attached: false, ipv4Address: '' });
    f.instance.devices[f.identity.key] = f.device;
    expect(await inspect()).toEqual({ attached: true, ipv4Address: '10.123.45.128' });
    // Revoked desired membership must still be observable for detachment; it
    // does not grant routing or worker-self authentication authority.
    await f.store.update(f.owner.userId, f.network.id, { workerIds: [] });
    expect(await inspect()).toEqual({ attached: true, ipv4Address: '10.123.45.128' });
    leases = [...leases, { ...leases[0]!, address: '10.123.45.129' }];
    await expect(inspect()).rejects.toThrow('ambiguous');
    f.instance.status = 'Stopped';
    expect(await inspect()).toEqual({ attached: true, ipv4Address: '' });
    f.instance.devices[f.identity.key] = { ...f.device, 'security.mac_filtering': 'false' };
    await expect(inspect()).rejects.toThrow('device authority');
    f.instance.devices[f.identity.key] = f.device;
    f.instance.config['volatile.uuid'] = randomUUID();
    await expect(inspect()).rejects.toThrow('incarnation changed');
  });
});

test('manager admission uses current durable Incus authority and lifecycle fence; pending storage blocks device mutation', async () => {
  await fixture(async f => {
    const dataDir = (f.runtime as any).config.dataDir;
    const manager = new ContainerManager({} as any, { dataDir, containerPrefix: 'agentor-worker' } as Config);
    manager.setIncusRuntime(f.runtime);
    const workers = new WorkerStore(dataDir); await workers.init(); manager.setWorkerStore(workers);
    await workers.upsert({ id: f.owner.id, userId: f.owner.userId, status: 'active', runtimeKind: 'incus-vm', displayName: 'test' } as any);
    const info = { ...f.owner, containerId: `incus:${f.incarnation}`, runtimeKind: 'incus-vm', status: 'running' } as any;
    manager.registerExternal(info);
    (manager as any).assertOwnerExists = async (owner: string) => { expect(owner).toBe(f.owner.userId); };
    const leaf = f.runtime.setManagedNetwork.bind(f.runtime);
    f.runtime.setManagedNetwork = async (...args: any[]) => {
      expect(isWorkerLifecycleMutationPending(f.owner.id)).toBe(true);
      await expect(manager.inspectIncusManagedNetwork(f.owner.id, f.network.id)).rejects.toThrow('unavailable');
      return leaf(...args);
    };
    await manager.setIncusManagedNetwork(f.owner.id, f.network.id, true);
    expect(f.instance.devices[f.identity.key]).toEqual(f.device);
    expect(await manager.inspectIncusManagedNetwork(f.owner.id, f.network.id)).toEqual({ attached: true, ipv4Address: '' });
    const read = f.runtime.inspectManagedNetwork.bind(f.runtime);
    f.runtime.inspectManagedNetwork = async (...args: any[]) => {
      const result = await read(...args); info.containerId = `incus:${randomUUID()}`; return result;
    };
    await expect(manager.inspectIncusManagedNetwork(f.owner.id, f.network.id)).rejects.toThrow('changed');
    info.containerId = `incus:${f.incarnation}`; f.runtime.inspectManagedNetwork = read;
    await manager.setIncusManagedNetwork(f.owner.id, f.network.id, false);
    f.calls.length = 0;
    const volumes = new ManagedVolumeStore(dataDir);
    const volume = await volumes.create(f.owner.userId, f.owner.id, '/opt/pending-storage', undefined, 'incus-vm');
    await volumes.save({ ...volume, incusLive: { id: randomUUID(), incarnation: f.incarnation, bootId: f.state.boot, attachment: 'unknown' } });
    await expect(manager.setIncusManagedNetwork(f.owner.id, f.network.id, true)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    await volumes.save({ ...volume, incusLive: undefined });
    await workers.upsert({ ...workers.get(f.owner.userId, f.owner.id)!, deletionPending: true });
    await expect(manager.setIncusManagedNetwork(f.owner.id, f.network.id, true)).rejects.toThrow('not authoritative');
    expect(f.calls).toEqual([]);
    await workers.upsert({ ...workers.get(f.owner.userId, f.owner.id)!, deletionPending: undefined, runtimeKind: 'legacy-docker' });
    await expect(manager.setIncusManagedNetwork(f.owner.id, f.network.id, true)).rejects.toThrow('not authoritative');
    expect(f.calls).toEqual([]);
  });
});

test('guest self-reboot or missing run rule cannot authorize hotplug or report successful configuration', async () => {
  for (const scenario of ['reboot-before-put', 'reboot-after-put', 'missing-rule']) await fixture(async f => {
    if (scenario === 'reboot-before-put') f.client.pushFile = async () => { f.state.boot = randomUUID(); };
    if (scenario === 'reboot-after-put') {
      const update = f.client.updateInstanceDevices;
      f.client.updateInstanceDevices = async (...args: any[]) => { await update(...args); f.state.boot = randomUUID(); };
    }
    if (scenario === 'missing-rule') {
      const exec = f.client.exec;
      f.client.exec = async (...args: any[]) => args[1].includes('agentor-managed-rule-proof')
        ? { returnCode: 1, stdout: '', stderr: 'run configuration missing' } : exec(...args);
    }
    await expect(f.runtime.setManagedNetwork(f.owner, f.incarnation, f.network.id, true)).rejects.toThrow();
    expect(f.calls.filter((call: any[]) => call[0] === 'devices')).toHaveLength(scenario === 'reboot-after-put' ? 1 : 0);
    expect(f.calls.some((call: any[]) => call[0] === 'exec' && call[2].includes('agentor-managed-network'))).toBe(false);
  });
});

test('stopped NIC configuration does not attempt guest exec; reboot reprovisions current attached grants', async () => {
  await fixture(async f => {
    f.instance.status = 'Stopped';
    await f.runtime.setManagedNetwork(f.owner, f.incarnation, f.network.id, true);
    expect(f.calls.map((call: any[]) => call[0])).toEqual(['devices']);
    f.calls.length = 0; f.instance.status = 'Running';
    await f.runtime.reprovisionManagedNetworks(f.owner, f.incarnation);
    expect(f.calls.filter((call: any[]) => call[0] === 'file')).toHaveLength(1);
    expect(f.calls.filter((call: any[]) => call[0] === 'devices')).toHaveLength(0);
    await f.store.update(f.owner.userId, f.network.id, { workerIds: [] }); f.calls.length = 0;
    await expect(f.runtime.reprovisionManagedNetworks(f.owner, f.incarnation)).rejects.toThrow('registry-authorized');
    expect(f.calls).toEqual([]);
  });
});

test('missing/revoked membership, foreign devices/profiles/UUID and mid-provision revoke never attach', async () => {
  for (const scenario of ['revoked', 'missing', 'foreign-device', 'profile', 'uuid', 'no-uuid', 'mid-revoke']) {
    await fixture(async f => {
      let uuid = f.incarnation, id = f.network.id;
      if (scenario === 'revoked') await f.store.update(f.owner.userId, id, { workerIds: [] });
      if (scenario === 'missing') id = randomUUID();
      if (scenario === 'foreign-device') f.instance.devices[f.identity.key] = { ...f.device, network: 'foreign' };
      if (scenario === 'profile') f.instance.profiles = ['foreign'];
      if (scenario === 'uuid') uuid = randomUUID();
      if (scenario === 'no-uuid') uuid = '';
      if (scenario === 'mid-revoke') f.client.pushFile = async () => { await f.store.update(f.owner.userId, id, { workerIds: [] }); };
      await expect(f.runtime.setManagedNetwork(f.owner, uuid, id, true)).rejects.toThrow();
      expect(f.calls.filter((call: any[]) => call[0] === 'devices')).toEqual([]);
    });
  }
});
