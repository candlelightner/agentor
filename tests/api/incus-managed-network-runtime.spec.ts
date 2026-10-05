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
