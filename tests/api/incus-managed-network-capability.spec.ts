import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncusClient } from '../../orchestrator/server/utils/incus-client';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import type { Config } from '../../orchestrator/server/utils/config';
import { ManagedNetworkStore } from '../../orchestrator/server/utils/managed-network-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { incusManagedBridgeIdentity, incusManagedNetworkDevice } from '../../orchestrator/server/utils/incus-managed-network-identity';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

const run = promisify(execFile);
const sshArguments = ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts',
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
  'kata-test@172.19.0.1'];

async function rootCommand(command: string): Promise<string> {
  const started = Date.now();
  try { return (await run('ssh', [...sshArguments, command], { timeout: 30_000 })).stdout; }
  catch (error: any) {
    console.error('Disposable command failed', { elapsedMs: Date.now() - started, killed: error.killed,
      signal: error.signal, code: error.code, stderr: String(error.stderr ?? '').slice(0, 1000) });
    throw error;
  }
}

/** Root runs this explicit capability gate serially on the approved disposable
 * host. Only exact owned fixture bridges are temporarily allowlisted; native
 * managed-only NIC restrictions and certificate authority remain unchanged. */
test('restricted allowlist denies arbitrary bridge creation', async () => {
  test.skip(process.env.INCUS_MANAGED_NETWORK_TEST !== 'true', 'Explicit disposable network capability gate');
  test.setTimeout(120_000);
  const id = randomUUID(), installation = randomUUID(), name = `amn${id.replaceAll('-', '').slice(0, 10)}`;
  const client = new IncusClient({ endpoint: 'https://127.0.0.1:18443', project: 'agentor',
    clientCertPath: '/workspace/agentor-incus-tls/client.crt', clientKeyPath: '/workspace/agentor-incus-tls/client.key',
    serverCertPath: '/workspace/agentor-incus-tls/server.crt' });
  const path = `/1.0/networks/${name}`;
  const root = rootCommand;
  const inspect = async () => JSON.parse(await root(`sudo incus query '${path}'`));
  const owned = (network: any) => {
    expect(network).toMatchObject({ name, type: 'bridge', managed: true, config: {
      'user.agentor.installation': installation, 'user.agentor.network-id': id,
      'user.agentor.owner': 'managed-network-capability' } });
    expect(network.used_by ?? []).toEqual([]);
  };
  let created = false, submitted = false;
  try {
    // Earlier loose-project evidence permitted create/read but not mutation.
    // With the final exact allowlist, even arbitrary creation is denied.
    submitted = true;
    await expect(client.request('POST', '/1.0/networks', { name, type: 'bridge', config: {
      'ipv4.address': 'auto', 'ipv4.nat': 'false', 'ipv6.address': 'none',
      'user.agentor.installation': installation, 'user.agentor.network-id': id,
      'user.agentor.owner': 'managed-network-capability' } }).then(result => { created = true; return result; }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect((await root(`sudo incus network list --format csv -c n`)).trim().split('\n')).not.toContain(name);
    console.info('Restricted exact allowlist rejects arbitrary bridge creation. Lifecycle remains on the narrow pinned host policy.');
  } catch (error) {
    if (submitted && !created)
      console.error('Network submission was not acknowledged; inspect exact fixture before cleanup', { name, id, installation });
    throw error;
  } finally {
    if (created) {
      owned(await inspect());
      await root(`sudo incus network delete '${name}'`);
      await expect(client.getNetwork(name)).rejects.toMatchObject({ statusCode: 404 });
    }
  }
});

test('filtered secondary managed bridge preserves primary routing and supports mixed Docker VM members', async () => {
  test.skip(process.env.INCUS_MANAGED_NETWORK_TEST !== 'true', 'Explicit disposable mixed network gate');
  test.setTimeout(600_000);
  const id = randomUUID();
  const dockerName = `agentor-network-capability-${id}`, peerName = `agentor-network-peer-${id}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-network-capability-'));
  const config = { dataDir, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase7-bounded', containerPrefix: 'agentor-worker',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000', workerImagePrefix: '', workerImage: 'agentor-worker:latest' } as Config;
  const runtime = new IncusWorkerRuntime(config), client = runtime.client;
  const owner = { id, userId: 'managed-network-capability', containerName: `agentor-worker-${id}` };
  const store = new ManagedNetworkStore(dataDir);
  const managedNetwork = await store.create(owner.userId, 'registered mixed bridge gate', 'selected');
  await store.update(owner.userId, managedNetwork.id, { workerIds: [id] });
  const networkIdentity = incusManagedBridgeIdentity(await backupInstallationId(dataDir), managedNetwork);
  const bridge = networkIdentity.name, deviceKey = networkIdentity.key;
  const secondary = incusManagedNetworkDevice(networkIdentity.installation, id, managedNetwork);
  const options = { ...owner, dockerEnabled: false, userEnv: zeroUserEnvVars(owner.userId),
    environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '', exposeApis: {} },
    capabilitiesJson: [], instructionsJson: [], workerJson: { id, displayName: 'mixed bridge gate', repos: [], initScript: '', gitName: '', gitEmail: '' } };
  const root = rootCommand;
  const checked = async (command: string[]) => {
    const result = await client.exec(owner.containerName, command);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0); return result.stdout.trim();
  };
  let incarnation: string | undefined, dockerCreated = false, peerCreated = false, bridgeCreated = false, failed = false;
  let allowlisted = false, installation: string | undefined;
  const inspectBridge = async () => JSON.parse(await root(`sudo incus query '/1.0/networks/${bridge}'`));
  const assertBridge = async () => expect(await inspectBridge()).toMatchObject({ name: bridge, type: 'bridge', managed: true,
    config: { 'user.agentor.network-id': managedNetwork.id, 'user.agentor.owner': owner.userId,
      'user.agentor.installation': installation } });
  try {
    const instance = await runtime.create(options); incarnation = instance.config['volatile.uuid'];
    const workers = new WorkerStore(dataDir); await workers.init();
    await workers.upsert({ id, userId: owner.userId, displayName: 'network admission gate', status: 'active', runtimeKind: 'incus-vm' } as any);
    const manager = new ContainerManager({} as any, config);
    manager.setWorkerStore(workers); manager.setIncusRuntime(runtime);
    manager.registerExternal({ ...owner, containerId: `incus:${incarnation}`, runtimeKind: 'incus-vm', status: 'running' } as any);
    // Fixture owner has no dashboard SQLite account. All real durable runtime,
    // lifecycle, native project and device authority checks remain in place.
    (manager as any).assertOwnerExists = async (userId: string) => expect(userId).toBe(owner.userId);
    installation = instance.config['user.agentor.installation'];
    expect(installation).toMatch(/^[0-9a-f-]{36}$/);
    const primary = await runtime.resolvePrimaryAddress(owner);
    const routes = await checked(['ip', '-j', 'route', 'show', 'default']);
    const resolver = await checked(['resolvectl', 'dns', 'eth0']);
    await root(`sudo incus query -X POST /1.0/networks -d '${JSON.stringify({ name: bridge, type: 'bridge', config: {
      'ipv4.address': 'auto', 'ipv4.nat': 'false', 'ipv6.address': 'none',
      'user.agentor.network-id': managedNetwork.id, 'user.agentor.owner': owner.userId,
      'user.agentor.installation': installation } })}'`);
    bridgeCreated = true; await assertBridge();
    // Scope the diagnostic grant to this exact owned fixture, preserving
    // managed-only NIC restrictions and every unrelated allowlist entry.
    const allowed = (await root('sudo incus project get agentor restricted.networks.access')).trim().split(',');
    expect((await root('sudo incus project get agentor restricted.devices.nic')).trim()).toBe('managed');
    expect(allowed).toContain(config.incusNetwork);
    expect(allowed.every(name => /^[a-zA-Z0-9_-]{1,15}$/.test(name))).toBe(true);
    allowlisted = true;
    await root(`sudo incus project set agentor restricted.networks.access '${[...new Set([...allowed, bridge])].join(',')}'`);
    const network = await inspectBridge(), match = /^(\d+\.\d+\.\d+)\.1\/24$/.exec(network.config['ipv4.address']);
    expect(match).toBeTruthy(); const prefix = match![1];
    await root(`sudo incus network set '${bridge}' ipv4.dhcp.ranges '${prefix}.128-${prefix}.254'`);
    await root(`sudo docker network create --driver bridge --subnet '${prefix}.0/24' --ip-range '${prefix}.0/26' --gateway '${prefix}.1' --opt 'com.docker.network.bridge.name=${bridge}' --opt com.docker.network.bridge.inhibit_ipv4=true --label 'agentor.capability=${id}' '${dockerName}'`);
    dockerCreated = true;
    const program = 'require("http").createServer((q,r)=>r.end("mixed-member-ok")).listen(18181,"0.0.0.0")';
    await root(`sudo docker run -d --name '${peerName}' --network '${dockerName}' --ip '${prefix}.2' --label 'agentor.capability=${id}' --entrypoint node agentor-phase7-orchestrator:bounded -e '${program}'`);
    peerCreated = true;
    // Incus's NIC name is not a guest interface rename for QEMU VMs. Match a
    // host-assigned MAC before hotplug, earlier than image netplan catchalls.
    // Secondary DHCP receives no route, DNS, domain or IPv6 RA authority.
    const secondaryMac = secondary.hwaddr!;
    const current = await client.getInstance(owner.containerName);
    await manager.setIncusManagedNetwork(id, managedNetwork.id, true);
    await expect.poll(async () => {
      const state = await client.getInstanceState(owner.containerName);
      return Object.values(state.network ?? {}).find(nic => nic.hwaddr === secondaryMac)
        ?.addresses.find(address => address.family === 'inet' && address.scope === 'global')?.address;
    }, { timeout: 60_000, intervals: [500, 1000] }).toMatch(new RegExp(`^${prefix.replaceAll('.', '\\.')}\\.\\d+$`));
    console.info('Secondary network configuration evidence:', await checked(['bash', '-ec',
      'networkctl status --all --no-pager; for f in /run/systemd/network/*.network /etc/systemd/network/*.network; do test ! -f "$f" || { echo "$f"; cat "$f"; }; done; ip -j route show default']));
    expect(await checked(['ip', '-j', 'route', 'show', 'default'])).toBe(routes);
    expect(await checked(['resolvectl', 'dns', 'eth0'])).toBe(resolver);
    expect(await runtime.resolvePrimaryAddress(owner)).toEqual(primary);
    await store.update(owner.userId, managedNetwork.id, { workerIds: [] });
    await expect(runtime.resolvePrimaryAddress(owner)).rejects.toThrow('network identity');
    await store.update(owner.userId, managedNetwork.id, { workerIds: [id] });
    expect(await runtime.resolvePrimaryAddress(owner)).toEqual(primary);
    expect(await checked(['curl', '--fail', '--max-time', '5', `http://${prefix}.2:18181`])).toBe('mixed-member-ok');
    const leases = await client.getNetworkLeases(bridge), attached = await client.getInstance(owner.containerName);
    const mac = attached.devices[deviceKey].hwaddr || attached.config[`volatile.${deviceKey}.hwaddr`];
    expect(mac).toBe(secondaryMac);
    const address = leases.find(lease => lease.type === 'dynamic' && lease.hwaddr === mac)?.address;
    expect(address).toBeTruthy();
    const request = `require("http").get("http://${address}:8443/",r=>{if(r.statusCode>=500)process.exit(1);r.resume();r.on("end",()=>console.log("vm-editor-ok"))}).on("error",()=>process.exit(1))`;
    expect((await root(`sudo docker exec '${peerName}' node -e '${request}'`)).trim()).toBe('vm-editor-ok');
    // Guest root must not turn an approved secondary NIC into spoof authority.
    const state = await client.getInstanceState(owner.containerName);
    const nic = Object.entries(state.network ?? {}).find(([, value]) => value.hwaddr === secondaryMac)?.[0];
    expect(nic).toMatch(/^[a-zA-Z0-9_.-]{1,15}$/);
    expect(nic).not.toBe('eth0');
    const target = `http://${prefix}.2:18181`;
    await checked(['ip', 'address', 'add', `${prefix}.3/24`, 'dev', nic!]);
    try {
      const denied = await client.exec(owner.containerName, ['curl', '--interface', `${prefix}.3`,
        '--fail', '--max-time', '3', target]);
      expect(denied.returnCode, denied.stdout + denied.stderr).toBe(28);
    } finally { await checked(['ip', 'address', 'del', `${prefix}.3/24`, 'dev', nic!]); }
    expect(await checked(['curl', '--fail', '--max-time', '5', target])).toBe('mixed-member-ok');
    const spoofMac = '02:ff:ff:ff:ff:fe';
    try {
      await checked(['ip', 'link', 'set', 'dev', nic!, 'down']);
      await checked(['ip', 'link', 'set', 'dev', nic!, 'address', spoofMac]);
      await checked(['ip', 'link', 'set', 'dev', nic!, 'up']);
      await checked(['ip', 'address', 'replace', `${address}/24`, 'dev', nic!]);
      const denied = await client.exec(owner.containerName, ['curl', '--interface', address!,
        '--fail', '--max-time', '3', target]);
      expect(denied.returnCode, denied.stdout + denied.stderr).toBe(28);
    } finally {
      await checked(['ip', 'link', 'set', 'dev', nic!, 'down']);
      await checked(['ip', 'link', 'set', 'dev', nic!, 'address', secondaryMac]);
      await checked(['ip', 'link', 'set', 'dev', nic!, 'up']);
      await checked(['networkctl', 'reconfigure', nic!]);
    }
    await expect.poll(async () => (await client.exec(owner.containerName,
      ['curl', '--fail', '--max-time', '3', target])).returnCode,
      { timeout: 60_000, intervals: [500, 1000] }).toBe(0);
    expect(await checked(['ip', '-j', 'route', 'show', 'default'])).toBe(routes);
    expect(await checked(['resolvectl', 'dns', 'eth0'])).toBe(resolver);
    const bootBefore = await checked(['cat', '/proc/sys/kernel/random/boot_id']);
    await runtime.stop(owner, incarnation!);
    await runtime.start(options, incarnation!);
    expect(await checked(['cat', '/proc/sys/kernel/random/boot_id'])).not.toBe(bootBefore);
    expect(await checked(['stat', '-c', '%a:%u:%g', `/run/systemd/network/00-agentor-${deviceKey}.network`])).toBe('644:0:0');
    expect(await checked(['ip', '-j', 'route', 'show', 'default'])).toBe(routes);
    expect(await checked(['resolvectl', 'dns', 'eth0'])).toBe(resolver);
    expect(await runtime.resolvePrimaryAddress(owner)).toEqual(primary);
    expect(await checked(['curl', '--fail', '--max-time', '5', target])).toBe('mixed-member-ok');
    expect((await root(`sudo docker exec '${peerName}' node -e '${request}'`)).trim()).toBe('vm-editor-ok');
    await manager.setIncusManagedNetwork(id, managedNetwork.id, false);
    expect((await client.getInstance(owner.containerName)).devices).toEqual(current.devices);
    expect(await runtime.resolvePrimaryAddress(owner)).toEqual(primary);
    console.info('Mixed-member traffic passed; IPv4/MAC spoof traffic denied with healthy controls, primary route/DNS retained and detach restores identity.');
  } catch (error) { failed = true; throw error; }
  finally {
    if (incarnation) await runtime.remove(owner, incarnation);
    await runtime.removeStorage(owner);
    if (peerCreated) {
      const peer = JSON.parse(await root(`sudo docker inspect '${peerName}'`))[0];
      expect(peer.Config.Labels['agentor.capability']).toBe(id); await root(`sudo docker rm -f '${peerName}'`);
    }
    if (dockerCreated) {
      const network = JSON.parse(await root(`sudo docker network inspect '${dockerName}'`))[0];
      expect(network.Labels['agentor.capability']).toBe(id); expect(Object.keys(network.Containers ?? {})).toEqual([]);
      await root(`sudo docker network rm '${dockerName}'`);
    }
    if (bridgeCreated) { await assertBridge(); expect((await inspectBridge()).used_by ?? []).toEqual([]); await root(`sudo incus network delete '${bridge}'`); }
    if (allowlisted) {
      const allowed = (await root('sudo incus project get agentor restricted.networks.access')).trim().split(',');
      expect(allowed.every(name => /^[a-zA-Z0-9_-]{1,15}$/.test(name))).toBe(true);
      await root(`sudo incus project set agentor restricted.networks.access '${allowed.filter(name => name !== bridge).join(',')}'`);
    }
    if (!failed) await rm(dataDir, { recursive: true, force: true });
    else console.error('Mixed-network diagnostic metadata retained', dataDir, id);
  }
});

test('Docker joins an owned native Incus bridge without replacing its gateway or deleting the bridge', async () => {
  test.skip(process.env.INCUS_MANAGED_NETWORK_TEST !== 'true', 'Explicit disposable shared bridge gate');
  test.setTimeout(120_000);
  const id = randomUUID(), installation = randomUUID(), name = `amn${id.replaceAll('-', '').slice(0, 10)}`;
  const dockerName = `agentor-network-capability-${id}`;
  const client = new IncusClient({ endpoint: 'https://127.0.0.1:18443', project: 'agentor',
    clientCertPath: '/workspace/agentor-incus-tls/client.crt', clientKeyPath: '/workspace/agentor-incus-tls/client.key',
    serverCertPath: '/workspace/agentor-incus-tls/server.crt' });
  const root = rootCommand;
  const inspect = async () => JSON.parse(await root(`sudo incus query '/1.0/networks/${name}'`));
  const owned = (network: any) => {
    expect(network).toMatchObject({ name, type: 'bridge', managed: true, config: {
      'user.agentor.installation': installation, 'user.agentor.network-id': id,
      'user.agentor.owner': 'managed-network-capability' } });
    expect(network.used_by ?? []).toEqual([]);
  };
  let created = false, dockerCreated = false, submitted = false;
  try {
    submitted = true;
    await root(`sudo incus query -X POST /1.0/networks -d '${JSON.stringify({ name, type: 'bridge', config: {
      'ipv4.address': 'auto', 'ipv4.nat': 'false', 'ipv6.address': 'none',
      'user.agentor.installation': installation, 'user.agentor.network-id': id,
      'user.agentor.owner': 'managed-network-capability' } })}'`);
    created = true;
    const network = await inspect(); owned(network);
    const match = /^(\d+\.\d+\.\d+)\.1\/24$/.exec(network.config['ipv4.address']);
    expect(match, 'Fixture requires the native automatic /24; do not guess ranges').toBeTruthy();
    const prefix = match![1], gateway = `${prefix}.1`, subnet = `${prefix}.0/24`;
    // DHCP and Docker IPAM own disjoint slices of the exact discovered subnet.
    await root(`sudo incus network set '${name}' ipv4.dhcp.ranges '${prefix}.128-${prefix}.254'`);
    const addresses = async () => JSON.parse(await root(`ip -j address show dev '${name}'`))[0].addr_info;
    const before = await addresses();
    expect(before.some((address: any) => address.local === gateway && address.prefixlen === 24)).toBe(true);
    await root(`sudo docker network create --driver bridge --subnet '${subnet}' --ip-range '${prefix}.0/26' --gateway '${gateway}' --opt 'com.docker.network.bridge.name=${name}' --opt com.docker.network.bridge.inhibit_ipv4=true --label 'agentor.capability=${id}' --label 'agentor.installation=${installation}' '${dockerName}'`);
    dockerCreated = true;
    const docker = JSON.parse(await root(`sudo docker network inspect '${dockerName}'`))[0];
    expect(docker.Labels).toMatchObject({ 'agentor.capability': id, 'agentor.installation': installation });
    expect(docker.Options).toMatchObject({ 'com.docker.network.bridge.name': name,
      'com.docker.network.bridge.inhibit_ipv4': 'true' });
    expect(docker.IPAM.Config).toContainEqual({ Subnet: subnet, IPRange: `${prefix}.0/26`, Gateway: gateway });
    expect(await addresses()).toEqual(before);
    await root(`sudo docker network rm '${dockerName}'`); dockerCreated = false;
    owned(await inspect()); expect(await addresses()).toEqual(before);
    console.info('Docker and native Incus share one bridge with disjoint allocation ranges; gateway retained and Docker removal leaves the Incus bridge intact.');
  } catch (error) {
    if (submitted && !created) console.error('Unacknowledged exact bridge submission; preserve for inspection', { name, id, installation });
    throw error;
  } finally {
    if (dockerCreated) {
      const docker = JSON.parse(await root(`sudo docker network inspect '${dockerName}'`))[0];
      expect(docker.Labels).toMatchObject({ 'agentor.capability': id, 'agentor.installation': installation });
      expect(Object.keys(docker.Containers ?? {})).toEqual([]);
      await root(`sudo docker network rm '${dockerName}'`);
    }
    if (created) { owned(await inspect()); await root(`sudo incus network delete '${name}'`); }
  }
});
