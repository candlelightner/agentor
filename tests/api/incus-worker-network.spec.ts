import { test, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIncusPrimaryLease } from "../../orchestrator/server/utils/incus-worker-network";
import { IncusWorkerRuntime } from "../../orchestrator/server/utils/incus-worker-runtime";
import { backupInstallationId } from "../../orchestrator/server/utils/backup-installation";
import type { Config } from "../../orchestrator/server/utils/config";
import type { IncusInstance, IncusNetwork, IncusNetworkLease } from "../../orchestrator/server/utils/incus-client";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";
import { ContainerManager } from "../../orchestrator/server/utils/container";
import { WorkerStore } from "../../orchestrator/server/utils/worker-store";
import { withWorkerLifecycleMutation, withOwnerWorkerRuntimeSetup, isWorkerLifecycleMutationActive,
  isWorkerLifecycleMutationPending, workerLifecycleGeneration } from "../../orchestrator/server/utils/worker-lifecycle-coordinator";
import { ManagedNetworkStore } from '../../orchestrator/server/utils/managed-network-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { incusManagedBridgeIdentity, incusManagedNetworkDevice, incusManagedNetworkAuthority } from '../../orchestrator/server/utils/incus-managed-network-identity';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

const mac = "10:66:6a:11:22:33";
const uuid = "11111111-2222-3333-4444-555555555555";

test("real restricted client can read host network and leases", async () => {
  test.skip(process.env.INCUS_LIVE_TEST !== "true", "Read-only approved disposable-host diagnostic");
  const client = new IncusClient({ endpoint: "https://127.0.0.1:18443", project: "agentor",
    clientCertPath: "/workspace/agentor-incus-tls/client.crt", clientKeyPath: "/workspace/agentor-incus-tls/client.key",
    serverCertPath: "/workspace/agentor-incus-tls/server.crt" });
  const network = await client.getNetwork("incusbr0");
  console.log("Restricted network description (not credentials):", network);
  expect(network.managed).toBe(true);
  expect(Array.isArray(await client.getNetworkLeases("incusbr0"))).toBe(true);
});
function fixture() {
  const instance = { name: "agentor-worker-test", type: "virtual-machine", status: "Running",
    config: { "volatile.uuid": uuid, "volatile.eth0.hwaddr": mac, "user.agentor.id": "test", "user.agentor.owner": "owner" },
    devices: { eth0: { type: "nic", name: "eth0", network: "workers", "security.mac_filtering": "true",
      "security.ipv4_filtering": "true", "security.ipv6_filtering": "true" } },
  } as unknown as IncusInstance;
  const network: IncusNetwork = { name: "workers", managed: true, type: "bridge",
    config: { "ipv4.address": "10.20.30.1/24", "ipv6.address": "fd42:abcd::1/64" } };
  const leases: IncusNetworkLease[] = [{ address: "10.20.30.42", hwaddr: mac, type: "dynamic", hostname: "foreign-guest-claim" }];
  return { instance, network, leases, resolve: (peers: IncusInstance[] = []) => resolveIncusPrimaryLease(instance, peers, network, leases, "workers") };
}

test('secondary NIC authority comes from durable own-account all/selected/group membership and is revocable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-secondary-authority-'));
  try {
    const installation = await backupInstallationId(dir), owner = { id: 'test', userId: 'owner' };
    const store = new ManagedNetworkStore(dir), groups = new WorkerGroupStore(dir);
    const all = await store.create(owner.userId, 'all', 'all');
    const selected = await store.create(owner.userId, 'selected', 'selected');
    await store.update(owner.userId, selected.id, { workerIds: [owner.id] });
    const root = await groups.create(owner.userId, 'root'), child = await groups.create(owner.userId, 'child', root.id);
    await groups.update(owner.userId, child.id, { workerIds: [owner.id] });
    const grouped = await store.create(owner.userId, 'grouped', 'group', root.id);
    const foreign = await store.create('other-owner', 'foreign', 'all');
    const expected = Object.fromEntries([all, selected, grouped].map(network => [
      incusManagedBridgeIdentity(installation, network).key, incusManagedNetworkDevice(installation, owner.id, network)]));
    expect(await incusManagedNetworkAuthority(dir, owner)).toEqual(expected);
    expect(Object.values(expected).every(nic => nic.network !== incusManagedBridgeIdentity(installation, foreign).name)).toBe(true);
    await store.update(owner.userId, selected.id, { workerIds: [] });
    await groups.update(owner.userId, child.id, { workerIds: [] });
    expect(await incusManagedNetworkAuthority(dir, owner)).toEqual({
      [incusManagedBridgeIdentity(installation, all).key]: incusManagedNetworkDevice(installation, owner.id, all) });
    for (const patch of [{ workerIds: owner.id }, { workerIds: [42] }, { userId: undefined },
      { parentId: 42 }, { parentId: 'missing-parent' }, { parentId: child.id }]) {
      await writeFile(join(dir, 'users', owner.userId, 'worker-groups.json'), JSON.stringify([
        { ...root, ...patch }, child ]));
      await expect(incusManagedNetworkAuthority(dir, owner)).rejects.toThrow();
    }
    await writeFile(join(dir, 'users', owner.userId, 'worker-groups.json'), JSON.stringify([root, child]));
    await writeFile(join(dir, 'users', owner.userId, 'managed-networks.json'), JSON.stringify([{ ...all, userId: undefined }]));
    await expect(incusManagedNetworkAuthority(dir, owner)).rejects.toThrow('owner authority');
    await writeFile(join(dir, 'users', owner.userId, 'managed-networks.json'), '[corrupt');
    await expect(incusManagedNetworkAuthority(dir, owner)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registered exact filtered secondary NIC preserves primary lease; foreign, modified and revoked NICs fail closed', () => {
  const f = fixture();
  const network = { id: '11111111-2222-4333-8444-555555555555', userId: 'owner',
    dockerName: 'agentor-managed-11111111-2222-4333-8444-555555555555' } as any;
  const installation = '11111111-2222-4333-8444-555555555556';
  const key = incusManagedBridgeIdentity(installation, network).key;
  const secondary = incusManagedNetworkDevice(installation, 'test', network);
  f.instance.devices[key] = { ...secondary };
  const resolve = (approved = { [key]: secondary }) => resolveIncusPrimaryLease(f.instance, [], f.network, f.leases, 'workers', approved);
  expect(resolve()).toEqual({ address: '10.20.30.42', incarnation: uuid });
  expect(() => resolve({})).toThrow('network identity');
  for (const patch of [{ network: 'foreign' }, { hwaddr: '02:ff:ff:ff:ff:fe' },
    { 'security.ipv4_filtering': 'false' }, { 'security.mac_filtering': 'false' },
    { 'security.ipv6_filtering': 'false' }, { 'ipv4.routes': '10.0.0.0/8' }, { parent: 'host-interface' }]) {
    f.instance.devices[key] = { ...secondary, ...patch };
    expect(() => resolve()).toThrow('network identity');
  }
  f.instance.devices[key] = { ...secondary };
  f.instance.config[`volatile.${key}.hwaddr`] = '02:ff:ff:ff:ff:fe';
  expect(() => resolve()).toThrow('network identity');
  delete f.instance.config[`volatile.${key}.hwaddr`];
  f.instance.devices.eth0!.type = 'disk';
  expect(() => resolve()).toThrow('network identity');
});

test('runtime rechecks durable membership when resolving an owned VM with a managed secondary NIC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-secondary-runtime-'));
  try {
    const installation = await backupInstallationId(dir), f = fixture(), owner = { id: 'test', userId: 'owner', containerName: f.instance.name };
    f.instance.config['user.agentor.installation'] = installation;
    const store = new ManagedNetworkStore(dir), network = await store.create(owner.userId, 'registered', 'all');
    const key = incusManagedBridgeIdentity(installation, network).key;
    f.instance.devices[key] = incusManagedNetworkDevice(installation, owner.id, network);
    const client = { getInstance: async () => structuredClone(f.instance), listInstances: async () => [f.instance],
      getNetwork: async () => f.network, getNetworkLeases: async () => f.leases };
    const runtime = new IncusWorkerRuntime({ dataDir: dir, containerPrefix: 'agentor-worker', incusNetwork: 'workers' } as Config, client as any);
    expect(await runtime.resolvePrimaryAddress(owner)).toEqual({ address: '10.20.30.42', incarnation: uuid });
    const read = client.getInstance; let calls = 0;
    client.getInstance = async () => { if (++calls === 2) await store.remove(owner.userId, network.id); return read(); };
    await expect(runtime.resolvePrimaryAddress(owner)).rejects.toThrow('network identity');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("host filtered dynamic lease is authority, not guest network reports or hostnames", () => {
  const f = fixture();
  f.instance.state = { network: { eth0: { addresses: [{ address: "203.0.113.99", family: "inet", scope: "global" }] } } } as any;
  expect(f.resolve()).toEqual({ address: "10.20.30.42", incarnation: uuid });
});

for (const unsafe of ["stopped", "missing-uuid", "mac-filter", "ipv4-filter", "ipv6-filter", "extra-nic", "route", "raw-qemu", "foreign-network", "foreign-mac"]) {
  test(`primary address rejects ${unsafe}`, () => {
    const f = fixture(), nic = f.instance.devices.eth0!;
    if (unsafe === "stopped") f.instance.status = "Stopped";
    if (unsafe === "missing-uuid") delete f.instance.config["volatile.uuid"];
    if (unsafe === "mac-filter") nic["security.mac_filtering"] = "false";
    if (unsafe === "ipv4-filter") nic["security.ipv4_filtering"] = "false";
    if (unsafe === "ipv6-filter") nic["security.ipv6_filtering"] = "false";
    if (unsafe === "extra-nic") f.instance.expanded_devices = { ...f.instance.devices, extra: { type: "nic", network: "foreign" } };
    if (unsafe === "route") nic["ipv4.routes.external"] = "10.0.0.0/8";
    if (unsafe === "raw-qemu") f.instance.expanded_config = { ...f.instance.config, "raw.qemu": "-netdev user,id=other" };
    if (unsafe === "foreign-network") nic.network = "foreign";
    if (unsafe === "foreign-mac") nic.hwaddr = "10:66:6a:aa:bb:cc";
    expect(() => f.resolve()).toThrow("network identity");
  });
}

test("lease ambiguity, conflicting IP/MAC owners and foreign subnet fail closed", () => {
  for (const scenario of ["multiple-addresses", "duplicate-lease-owner", "duplicate-mac", "duplicate-static-ip", "outside-subnet", "gateway", "no-lease"]) {
    const f = fixture();
    const peers: IncusInstance[] = [];
    if (scenario === "multiple-addresses") f.leases.push({ ...f.leases[0]!, address: "10.20.30.43" });
    if (scenario === "duplicate-lease-owner") f.leases.push({ ...f.leases[0]!, hwaddr: "10:66:6a:aa:bb:cc" });
    if (scenario === "duplicate-mac" || scenario === "duplicate-static-ip") {
      const peer = structuredClone(f.instance); peer.name = "foreign-instance";
      if (scenario === "duplicate-static-ip") { peer.config["volatile.eth0.hwaddr"] = "10:66:6a:aa:bb:cc"; peer.devices.eth0!["ipv4.address"] = "10.20.30.42"; }
      peers.push(peer);
    }
    if (scenario === "outside-subnet") f.leases[0]!.address = "203.0.113.42";
    if (scenario === "gateway") f.leases[0]!.address = "10.20.30.1";
    if (scenario === "no-lease") f.leases.length = 0;
    expect(() => f.resolve(peers), scenario).toThrow("network identity");
  }
});

test("IPv4-only managed networks do not require an unused IPv6 filter", () => {
  const f = fixture(); f.network.config["ipv6.address"] = "none";
  delete f.instance.devices.eth0!["security.ipv6_filtering"];
  expect(f.resolve().address).toBe("10.20.30.42");
});

test("native bridge config redaction uses host leases without assuming IPv6 filtering is optional", () => {
  const f = fixture(); f.network.config = {};
  expect(f.resolve().address).toBe("10.20.30.42");
  delete f.instance.devices.eth0!["security.ipv6_filtering"];
  expect(() => f.resolve()).toThrow("network identity");
});

test("runtime resolver verifies installation/owner and rejects replacement during host reads without guest exec", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-network-identity-"));
  try {
    for (const scenario of ["valid", "foreign-installation", "wrong-owner", "replaced", "read-failure"]) {
      const f = fixture();
      f.instance.config["user.agentor.installation"] = await backupInstallationId(dir);
      if (scenario === "foreign-installation") f.instance.config["user.agentor.installation"] = "foreign";
      if (scenario === "wrong-owner") f.instance.config["user.agentor.owner"] = "other";
      let reads = 0;
      const client = {
        getInstance: async () => { const instance = structuredClone(f.instance); if (++reads === 2 && scenario === "replaced") instance.config["volatile.uuid"] = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; return instance; },
        listInstances: async () => [f.instance], getNetwork: async () => f.network,
        getNetworkLeases: async () => { if (scenario === "read-failure") throw new Error("Incus read unavailable"); return f.leases; },
        getInstanceState: () => { throw new Error("Guest network report used"); },
        exec: () => { throw new Error("Guest exec used"); }, startInstance: () => { throw new Error("Unexpected restart"); },
      };
      const runtime = new IncusWorkerRuntime({ dataDir: dir, containerPrefix: "agentor-worker", incusNetwork: "workers" } as Config, client as any);
      const result = runtime.resolvePrimaryAddress({ id: "test", userId: "owner", containerName: f.instance.name });
      if (scenario === "valid") await expect(result).resolves.toEqual({ address: "10.20.30.42", incarnation: uuid });
      else await expect(result).rejects.toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("manager publishes only current record/incarnation/lease authority, not stale addresses or busy lifecycles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-network-manager-"));
  try {
    const f = fixture(); f.instance.config["user.agentor.installation"] = await backupInstallationId(dir);
    const config = { dataDir: dir, containerPrefix: "agentor-worker", incusNetwork: "workers" } as Config;
    const client = { getInstance: async () => structuredClone(f.instance), listInstances: async () => [f.instance],
      getNetwork: async () => f.network, getNetworkLeases: async () => f.leases,
      startInstance: () => { throw new Error("Observation triggered restart"); } };
    const manager = new ContainerManager({} as any, config);
    manager.setIncusRuntime(new IncusWorkerRuntime(config, client as any));
    const store = new WorkerStore(dir); await store.init(); manager.setWorkerStore(store);
    await store.upsert({ id: "test", userId: "owner", status: "active", runtimeKind: "incus-vm", displayName: "Fixture" } as any);
    const info = { id: "test", userId: "owner", status: "running", runtimeKind: "incus-vm",
      containerId: `incus:${uuid}`, containerName: f.instance.name };
    (manager as any).containers.set(info.id, info);
    expect(await manager.resolveWorkerHost(info.id)).toBe("10.20.30.42");
    expect(await manager.resolveIncusCaller("10.20.30.42")).toBe(info);
    expect(await manager.resolveIncusCaller("::1")).toBeNull();
    f.leases[0]!.address = "10.20.30.43";
    expect(await manager.resolveIncusCaller("10.20.30.42")).toBeNull();
    expect(await manager.resolveWorkerHost(info.id)).toBe("10.20.30.43");
    expect(await manager.resolveIncusCaller("10.20.30.43")).toBe(info);
    const generation = workerLifecycleGeneration(info.id);
    await withOwnerWorkerRuntimeSetup(info.userId, info.id, async () => {
      expect(isWorkerLifecycleMutationActive(info.id)).toBe(true);
      expect(isWorkerLifecycleMutationPending(info.id)).toBe(false);
      expect(await manager.resolveWorkerHost(info.id)).toBe('10.20.30.43');
      expect(await manager.resolveIncusCaller('10.20.30.43')).toBe(info);
    });
    expect(workerLifecycleGeneration(info.id)).toBe(generation);
    await withWorkerLifecycleMutation(info.id, async () => {
      await expect(manager.resolveWorkerHost(info.id)).rejects.toThrow("not authoritative");
      expect(await manager.resolveIncusCaller("10.20.30.43")).toBeNull();
    });
    await expect.poll(() => isWorkerLifecycleMutationActive(info.id)).toBe(false);
    f.instance.config["volatile.uuid"] = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await expect(manager.resolveWorkerHost(info.id)).rejects.toThrow("changed during");
    expect(await manager.resolveIncusCaller("10.20.30.43")).toBeNull();
    f.instance.config["volatile.uuid"] = uuid;
    const readLeases = client.getNetworkLeases;
    client.getNetworkLeases = async () => { throw new Error("Read unavailable"); };
    expect(await manager.resolveIncusCaller("10.20.30.43")).toBeNull();
    client.getNetworkLeases = readLeases;
    client.getNetworkLeases = async () => { await withWorkerLifecycleMutation(info.id, async () => {}); return f.leases; };
    await expect(manager.resolveWorkerHost(info.id)).rejects.toThrow("changed during");
    client.getNetworkLeases = readLeases;
    await store.delete("owner", "test");
    await expect(manager.resolveWorkerHost(info.id)).rejects.toThrow("not authoritative");
    expect(await manager.resolveIncusCaller("10.20.30.43")).toBeNull();
    info.runtimeKind = "legacy-docker";
    expect(await manager.resolveWorkerHost(info.id)).toBe(info.containerName);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
