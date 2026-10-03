import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { withWorkerLifecycleMutation, isWorkerLifecycleMutationActive } from "../../orchestrator/server/utils/worker-lifecycle-coordinator";

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
