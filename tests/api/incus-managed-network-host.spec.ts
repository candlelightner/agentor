import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { IncusManagedNetworkHost } from '../../orchestrator/server/utils/incus-managed-network-host';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';
import { ManagedNetworkStore, type ManagedNetwork } from '../../orchestrator/server/utils/managed-network-store';
import { createRequire } from 'node:module';
import { IncusManagedDockerBridge } from '../../orchestrator/server/utils/incus-managed-docker-bridge';
import type { IncusManagedBridge } from '../../orchestrator/server/utils/incus-managed-network-host';
import { ManagedNetworkManager } from '../../orchestrator/server/utils/managed-network-manager';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { authorizeManagedNetworkMutation } from '../../orchestrator/server/utils/managed-network-authorization';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

const Docker = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('dockerode');

test('host network transport has only bounded owned bridge methods and verifies returned identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-network-host-'));
  try {
    const installation = await backupInstallationId(dataDir), id = randomUUID(), userId = 'historical-owner_123';
    const config = { dataDir, incusNetworkHostEndpoint: 'https://host.invalid:8444', incusProject: 'agentor',
      incusNetwork: 'workers' } as Config;
    const network = { id, userId, dockerName: `agentor-managed-${id}` } as ManagedNetwork;
    const bridge = { installation, name: 'am' + createHash('sha256').update(`${installation}:${userId}:${id}`)
      .digest('hex').slice(0, 12), userId, networkId: id, subnet: '10.42.87.0/24',
      gateway: '10.42.87.1', dockerRange: '10.42.87.0/26' };
    let response: any;
    const calls: any[] = [];
    const host = new IncusManagedNetworkHost(config, { request: async (...args: any[]) => {
      calls.push(args); return response;
    } });
    response = { ready: true, installation, project: 'agentor', primary: 'workers' };
    await host.readiness();
    expect(calls.pop()).toEqual(['GET', '/v1/managed-networks/readiness']);
    for (const key of ['ready', 'installation', 'project', 'primary']) {
      const original = response[key]; response[key] = key === 'ready' ? false : 'foreign';
      await expect(host.readiness()).rejects.toThrow('does not match'); response[key] = original;
    }
    response = bridge;
    expect(await host.ensure(network)).toEqual(bridge);
    expect(calls.pop()).toEqual(['POST', '/v1/managed-networks/ensure', { userId, networkId: id }]);
    response = { ...bridge, references: [] };
    expect(await host.inspect(network)).toEqual(response);
    expect(calls.pop()).toEqual(['POST', '/v1/managed-networks/inspect', { userId, networkId: id }]);
    for (const references of [undefined, null, {}, [''], [1], ['x'.repeat(1025)]]) {
      response = { ...bridge, references };
      await expect(host.inspect(network)).rejects.toThrow('reference authority');
    }
    for (const patch of [{ name: 'foreign' }, { installation: randomUUID() }, { userId: 'foreign' },
      { networkId: randomUUID() }, { gateway: '192.0.2.1' }, { gateway: '10.42.87.2' },
      { subnet: '10.42.87.0/16' }, { dockerRange: '10.42.87.0/24' }]) {
      response = { ...bridge, references: [], ...patch };
      await expect(host.ensure(network)).rejects.toThrow(/authority|geometry/);
      await expect(host.inspect(network)).rejects.toThrow(/authority|geometry/);
    }
    calls.length = 0;
    for (const patch of [{ id: '../foreign' }, { userId: 'owner,/etc' }, { dockerName: 'forged' }])
      await expect(host.ensure({ ...network, ...patch })).rejects.toThrow('Invalid managed network');
    expect(calls).toEqual([]);
    response = null;
    expect(await host.inspect(network)).toBe(null); calls.length = 0;
    await host.remove(network);
    expect(calls).toEqual([['POST', '/v1/managed-networks/remove', { userId, networkId: id }]]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('missing endpoint or installation never silently uses Docker or manufactures host authority', async () => {
  expect(() => new IncusManagedNetworkHost({} as Config)).toThrow('operator-installed');
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-network-host-'));
  try {
    const calls: unknown[] = [];
    const host = new IncusManagedNetworkHost({ dataDir, incusNetworkHostEndpoint: 'https://host.invalid' } as Config,
      { request: async (...args: any[]) => { calls.push(args); throw new Error('must not reach host'); } });
    await expect(host.readiness()).rejects.toThrow();
    await expect(host.ensure({ id: randomUUID(), userId: 'owner', dockerName: 'forged' } as ManagedNetwork))
      .rejects.toThrow();
    expect(calls).toEqual([]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('real TypeScript client uses pinned mTLS for owned native host bridge lifecycle', async () => {
  test.skip(process.env.INCUS_NETWORK_HOST_TEST !== 'true', 'Explicit serial disposable host service gate');
  test.setTimeout(420_000);
  const run = promisify(execFile);
  const access = ['-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
    '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts',
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes'];
  const destination = 'kata-test@172.19.0.1';
  const root = async (command: string) => (await run('ssh', ['-p', '22375', ...access, destination, command],
    { timeout: 30_000 })).stdout.trim();
  const copy = async (sources: string[], target: string, recursive = false) => {
    await run('scp', ['-P', '22375', ...access, ...(recursive ? ['-r'] : []), ...sources,
      `${destination}:${target}`], { timeout: 30_000 });
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-network-host-client-'));
  const installation = await backupInstallationId(dataDir);
  const store = new ManagedNetworkStore(dataDir);
  await store.init();
  const network = await store.create('network-host-client-gate', 'mTLS host gate', 'selected');
  const expectedName = 'am' + createHash('sha256').update(`${installation}:${network.userId}:${network.id}`)
    .digest('hex').slice(0, 12);
  const unit = `agentor-network-host-test-${network.id}.service`;
  let remoteDir: string | undefined, submitted = false, ensureSubmitted = false, complete = false;
  let tunnel: ChildProcess | undefined;
  const dockerSocket = join(dataDir, 'disposable-docker.sock');
  const adapter = new IncusManagedDockerBridge(new Docker({ socketPath: dockerSocket }));
  let adapterSubmitted = false, adapterReady = false, adapterBridge: IncusManagedBridge | undefined;
  let peerRuntime: IncusWorkerRuntime | undefined, peerOwner: { id: string; userId: string; containerName: string } | undefined;
  let peerIncarnation: string | undefined, peerCreateSubmitted = false;
  const config = { dataDir, incusProject: 'agentor', incusNetwork: 'incusbr0',
    incusNetworkHostEndpoint: 'https://127.0.0.1:18444',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' } as Config;
  const host = new IncusManagedNetworkHost(config);
  const workers = new WorkerStore(dataDir); await workers.init();
  let observedManager: any = { list: () => [] };
  const actual = new ManagedNetworkManager({ config: () => config, host: () => host,
    manager: () => observedManager, workers: () => workers });
  (actual as any).docker = new Docker({ socketPath: dockerSocket });
  const projectBefore = JSON.parse(await root('sudo incus query /1.0/projects/agentor'));
  console.info('Exact TypeScript host-service fixture', { installation, networkId: network.id, expectedName, dataDir, unit });
  try {
    remoteDir = await root('mktemp -d /var/tmp/agentor-network-host-client.XXXXXXXX');
    expect(remoteDir).toMatch(/^\/var\/tmp\/agentor-network-host-client\.[a-zA-Z0-9]+$/);
    await root(`mkdir -p '${remoteDir}/scripts' '${remoteDir}/data'`);
    await copy([fileURLToPath(new URL('../../scripts/agentor-incus-network-service.py', import.meta.url)),
      fileURLToPath(new URL('../../scripts/incus-managed-network-policy.py', import.meta.url))], `${remoteDir}/scripts/`);
    await copy([dataDir + '/.'], `${remoteDir}/data/`, true);
    // Only the public client certificate crosses to the host. The restricted
    // platform client key stays in the test controller, never in a worker VM.
    await copy([config.incusClientCertPath], `${remoteDir}/client.crt`);
    expect(await root(`sudo systemctl show '${unit}' --property=LoadState --value`)).toBe('not-found');
    submitted = true;
    await root(`sudo systemd-run --no-block --collect --unit='${unit}' --property=RuntimeMaxSec=390 --property=TimeoutStopSec=10 /usr/bin/python3 '${remoteDir}/scripts/agentor-incus-network-service.py' --data-dir '${remoteDir}/data' --installation '${installation}' --project agentor --primary incusbr0 --bind 127.0.0.1 --port 18444 --server-cert /var/lib/incus/server.crt --server-key /var/lib/incus/server.key --client-cert '${remoteDir}/client.crt'`);
    let tunnelExit: number | null | undefined, tunnelError = '';
    tunnel = spawn('ssh', ['-N', '-p', '22375', ...access, '-o', 'ExitOnForwardFailure=yes',
      '-L', '127.0.0.1:18444:127.0.0.1:18444', '-L', `${dockerSocket}:/var/run/docker.sock`, destination],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    tunnel.on('error', error => { tunnelError = error.message; });
    tunnel.on('exit', code => { tunnelExit = code; });
    tunnel.stderr!.on('data', chunk => { tunnelError = (tunnelError + chunk.toString()).slice(-1000); });
    await expect.poll(async () => {
      if (tunnelExit !== undefined || tunnelError) throw new Error(`Fixture tunnel failed: ${tunnelError}`);
      try { await host.readiness(); return true; } catch { return false; }
    }, { timeout: 15_000, intervals: [200, 500] }).toBe(true);
    console.info('Host readiness verified; inspecting absent fixture bridge without mutation');
    expect(await host.inspect(network)).toBe(null);
    expect(await actual.actualWorkerIds(network)).toEqual([]);
    console.info('Read-only native404 verified; ensuring exact owned fixture bridge');
    ensureSubmitted = true; // uncertain acknowledgement must retain cleanup authority
    const bridge = await host.ensure(network);
    expect(bridge).toMatchObject({ name: expectedName, installation, userId: network.userId, networkId: network.id });
    expect(await host.ensure(network)).toEqual(bridge);
    expect(await host.inspect(network)).toEqual({ ...bridge, references: [] });
    adapterBridge = bridge; adapterSubmitted = true;
    const dockerNetwork = await adapter.ensure(network, bridge); adapterReady = true;
    expect(dockerNetwork.Name).toBe(`${network.dockerName}-incus`);
    expect(await adapter.ensure(network, bridge)).toEqual(dockerNetwork);
    expect(await actual.actualWorkerIds(network)).toEqual([]);
    const legacyName = network.dockerName;
    // Real SDK over a private pinned SSH Unix forward to this disposable host
    // only. Production still uses its existing Docker socket, never Incus's.
    await expect(new Docker({ socketPath: dockerSocket }).getNetwork(legacyName).inspect())
      .rejects.toMatchObject({ statusCode: 404 });
    // Stopped synthetic VM: real native reference ownership, without another
    // boot/service fixture. Source images and original recovered VMs stay put.
    const peerConfig = { ...config, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443',
      containerPrefix: 'agentor-worker', incusStoragePool: 'default', incusWorkerImage: 'agentor-worker-phase7-bounded',
      incusInternalGatewayUrl: 'http://10.159.68.1:38000', workerImagePrefix: '', workerImage: 'agentor-worker:latest' } as Config;
    const peerId = randomUUID(); peerOwner = { id: peerId, userId: network.userId, containerName: `agentor-worker-${peerId}` };
    await store.update(network.userId, network.id, { workerIds: [peerId] });
    peerRuntime = new IncusWorkerRuntime(peerConfig);
    peerCreateSubmitted = true;
    const peer = await peerRuntime.create({ ...peerOwner, start: false, dockerEnabled: false, userEnv: zeroUserEnvVars(network.userId),
      environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '', exposeApis: {} },
      capabilitiesJson: [], instructionsJson: [], workerJson: { id: peerId, displayName: 'native reference gate', repos: [], initScript: '', gitName: '', gitEmail: '' } });
    peerIncarnation = peer.config['volatile.uuid']; expect(peerIncarnation).toBeTruthy();
    await workers.upsert({ id: peerId, userId: network.userId, status: 'active', runtimeKind: 'incus-vm', displayName: 'native reference gate' } as any);
    const peerManager = new ContainerManager({} as any, peerConfig);
    peerManager.setWorkerStore(workers); peerManager.setIncusRuntime(peerRuntime);
    peerManager.registerExternal({ ...peerOwner, containerId: `incus:${peerIncarnation}`, runtimeKind: 'incus-vm', status: 'stopped' } as any);
    (peerManager as any).assertOwnerExists = async (userId: string) => expect(userId).toBe(network.userId);
    observedManager = peerManager;
    await peerManager.setIncusManagedNetwork(peerId, network.id, true);
    expect((await host.inspect(network))!.references).toContain(`/1.0/instances/${peerOwner.containerName}?project=agentor`);
    expect(await actual.actualWorkerIds(network)).toEqual([peerId]);
    const beforeDenied = await peerRuntime.client.getInstance(peerOwner.containerName);
    const coverage = await authorizeManagedNetworkMutation([network], [], undefined, {
      actualWorkerIds: value => actual.actualWorkerIds(value),
      verify: async ids => expect([...ids]).toEqual([peerId]),
    });
    expect([...coverage]).toEqual([peerId]);
    await expect(actual.reconcile(network, [], new Set())).rejects.toThrow('uncovered worker');
    await expect(actual.remove(network, new Set())).rejects.toThrow('uncovered worker');
    expect((await peerRuntime.client.getInstance(peerOwner.containerName)).devices).toEqual(beforeDenied.devices);
    await expect(new Docker({ socketPath: dockerSocket }).getNetwork(legacyName).inspect())
      .rejects.toMatchObject({ statusCode: 404 });
    observedManager = { list: () => [] }; // orphaned cache must not hide a real native attachment
    await expect(actual.actualWorkerIds(network)).rejects.toThrow('unmapped');
    observedManager = peerManager;
    await peerManager.setIncusManagedNetwork(peerId, network.id, false);
    expect(await actual.actualWorkerIds(network)).toEqual([]);
    await peerRuntime.remove(peerOwner, peerIncarnation!); await peerRuntime.removeStorage(peerOwner);
    peerRuntime.client.dispose(); peerCreateSubmitted = false; peerIncarnation = undefined;
    const native = JSON.parse(await root(`sudo incus query /1.0/networks/${expectedName}`));
    expect(native).toMatchObject({ name: expectedName, type: 'bridge', managed: true, used_by: [], config: {
      'user.agentor.installation': installation, 'user.agentor.owner': network.userId, 'user.agentor.network-id': network.id } });
    const current = JSON.parse(await root('sudo incus query /1.0/projects/agentor'));
    expect(current.config['restricted.networks.access'].split(',')).toContain(expectedName);
    for (const [key, value] of Object.entries(projectBefore.config))
      if (key !== 'restricted.networks.access') expect(current.config[key]).toBe(value);
    await expect(new IncusManagedNetworkHost({ ...config, incusProject: 'foreign' }).readiness()).rejects.toThrow();
    const absentId = randomUUID();
    await expect(host.ensure({ ...network, id: absentId, dockerName: `agentor-managed-${absentId}` })).rejects.toThrow();
    await adapter.remove(network, bridge); adapterSubmitted = false;
    const afterDocker = JSON.parse(await root(`sudo incus query /1.0/networks/${expectedName}`));
    expect(afterDocker.config['ipv4.address']).toBe(`${bridge.gateway}/24`);
    await host.remove(network);
    await host.remove(network);
    ensureSubmitted = false;
    expect(JSON.parse(await root('sudo incus query /1.0/projects/agentor')).config).toEqual(projectBefore.config);
    complete = true;
  } finally {
    try {
      if (peerCreateSubmitted) {
        if (!peerRuntime || !peerOwner || !peerIncarnation)
          throw new Error('Unsettled native reference fixture retained for captured-identity recovery');
        await peerRuntime.remove(peerOwner, peerIncarnation); await peerRuntime.removeStorage(peerOwner);
        peerRuntime.client.dispose();
      }
      if (adapterSubmitted) {
        // Unknown Docker create acknowledgement is diagnostic authority, not
        // permission to delete the backing bridge underneath a late request.
        if (!adapterReady || !adapterBridge)
          throw new Error('Unsettled Docker adapter fixture retained for exact inspection');
        await adapter.remove(network, adapterBridge);
      }
      if (ensureSubmitted) await host.remove(network); // exact owned native metadata still required
    } finally {
      try {
        if (submitted && await root(`sudo systemctl show '${unit}' --property=LoadState --value`) !== 'not-found') {
          const command = await root(`sudo systemctl show '${unit}' --property=ExecStart --value`);
          expect(command).toContain(`${remoteDir}/scripts/agentor-incus-network-service.py`);
          expect(command).toContain(installation);
          await root(`sudo systemctl stop '${unit}'`);
        }
      } finally {
        if (tunnel) {
          tunnel.kill('SIGTERM');
          if (tunnel.exitCode === null && tunnel.signalCode === null)
            await new Promise<void>(resolveExit => {
              const timer = setTimeout(() => { tunnel!.kill('SIGKILL'); resolveExit(); }, 5000);
              tunnel!.once('exit', () => { clearTimeout(timer); resolveExit(); });
            });
        }
        if (complete) {
          await rm(dataDir, { recursive: true, force: true });
          console.info('Stopped service; nonsecret remote fixture scripts and metadata retained', { remoteDir, unit });
        }
        else console.error('Host-service diagnostic authority retained', { dataDir, remoteDir, expectedName, installation, unit });
      }
    }
  }
});
