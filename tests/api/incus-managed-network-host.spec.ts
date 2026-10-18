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
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { authorizeManagedNetworkMutation } from '../../orchestrator/server/utils/managed-network-authorization';
import { withOwnerWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });

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
  const running = process.env.INCUS_NETWORK_RUNNING_TEST === 'true';
  test.setTimeout(running ? 720_000 : 420_000);
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
  let legacyPeer: any, legacyPeerId: string | undefined;
  let legacySubmitted = false, legacyBackingSubmitted = false, legacyBridgeId: string | undefined;
  const docker = new Docker({ socketPath: dockerSocket });
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
    await root(`sudo systemd-run --no-block --collect --unit='${unit}' --property=RuntimeMaxSec=${running ? 690 : 390} --property=TimeoutStopSec=10 /usr/bin/python3 '${remoteDir}/scripts/agentor-incus-network-service.py' --data-dir '${remoteDir}/data' --installation '${installation}' --project agentor --primary incusbr0 --bind 127.0.0.1 --port 18444 --server-cert /var/lib/incus/server.crt --server-key /var/lib/incus/server.key --client-cert '${remoteDir}/client.crt'`);
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
      containerPrefix: 'agentor-worker', incusStoragePool: 'default',
      incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase7-bounded',
      incusInternalGatewayUrl: 'http://10.159.68.1:38000', workerImagePrefix: '', workerImage: 'agentor-worker:latest' } as Config;
    const peerId = randomUUID(); peerOwner = { id: peerId, userId: network.userId, containerName: `agentor-worker-${peerId}` };
    await store.update(network.userId, network.id, { workerIds: [peerId] });
    peerRuntime = new IncusWorkerRuntime(peerConfig);
    peerCreateSubmitted = true;
    const peerOptions: IncusWorkerOptions = { ...peerOwner, start: running, dockerEnabled: false, userEnv: zeroUserEnvVars(network.userId),
      environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '',
        exposeApis: { portMappings: false, domainMappings: false, usage: false } },
      capabilitiesJson: [], instructionsJson: [], workerJson: { id: peerId, displayName: 'native reference gate', repos: [], initScript: '', gitName: '', gitEmail: '' } };
    const peer = await peerRuntime.create(peerOptions);
    peerIncarnation = peer.config['volatile.uuid']; expect(peerIncarnation).toBeTruthy();
    await workers.upsert({ id: peerId, userId: network.userId, status: 'active', desiredRuntimeStatus: running ? 'running' : 'stopped',
      runtimeKind: 'incus-vm', displayName: 'native reference gate' } as any);
    const peerDocker = new DockerService(peerConfig);
    (peerDocker as any).docker = docker; // exact disposable Docker SDK forward
    const peerManager = new ContainerManager(peerDocker, peerConfig);
    peerManager.setWorkerStore(workers); peerManager.setIncusRuntime(peerRuntime);
    peerManager.registerExternal({ ...peerOwner, containerId: `incus:${peerIncarnation}`, runtimeKind: 'incus-vm', status: running ? 'running' : 'stopped' } as any);
    (peerManager as any).assertOwnerExists = async (userId: string) => expect(userId).toBe(network.userId);
    observedManager = peerManager;
    (peerManager as any).managedNetworks = actual; // same disposable SDK in own hostname projection
    if (running) {
      // A minimal real legacy compute peer exercises the existing manager's
      // connect-new/verify/disconnect-old path, not manual shared-bridge wiring.
      legacyPeerId = randomUUID();
      const legacyName = `agentor-worker-${legacyPeerId}`;
      legacyBackingSubmitted = true;
      legacyBridgeId = (await (actual as any).ensure(network)).Id;
      legacySubmitted = true;
      legacyPeer = await docker.createContainer({ name: legacyName, Image: 'agentor-phase7-orchestrator:bounded',
        Entrypoint: ['node'], Cmd: ['-e', 'require("http").createServer((q,r)=>r.end("mixed-manager-ok")).listen(18181,"0.0.0.0")'],
        Labels: { 'agentor.network-running-fixture': network.id },
        NetworkingConfig: { EndpointsConfig: { [network.dockerName]: { Aliases: ['retained-peer'] } } } });
      await legacyPeer.start();
      await workers.upsert({ id: legacyPeerId, userId: network.userId, status: 'active', runtimeKind: 'legacy-docker', displayName: 'mixed peer' } as any);
      peerManager.registerExternal({ id: legacyPeerId, userId: network.userId, containerName: legacyName,
        containerId: legacyPeer.id, runtimeKind: 'legacy-docker', status: 'running' } as any);
      await store.update(network.userId, network.id, { workerIds: [peerId, legacyPeerId] });
    }
    const refreshNames = peerManager.refreshManagedNetworkHosts.bind(peerManager);
    if (running && process.env.INCUS_NETWORK_DNS_TEST === 'true')
      peerManager.refreshManagedNetworkHosts = async () => {}; // exact pre-adaptation negative control
    const savedNetwork = store.get(network.userId, network.id)!;
    const peerCoverage = new Set([peerId, ...(legacyPeerId ? [legacyPeerId] : [])]);
    expect((await actual.reconcile(savedNetwork, undefined, peerCoverage)).partialFailures).toEqual([]);
    if (running) {
      const adapted = (await legacyPeer.inspect()).NetworkSettings.Networks;
      expect(adapted[network.dockerName]).toBeUndefined();
      expect(adapted[`${network.dockerName}-incus`].Aliases).toContain('retained-peer');
      expect((await docker.getNetwork(network.dockerName).inspect()).Containers).toEqual({});
      console.info('Production mixed bridge adaptation preserved aliases and original empty bridge');
      if (process.env.INCUS_NETWORK_DNS_TEST === 'true') {
        const legacyHost = (await legacyPeer.inspect()).Name.slice(1);
        const absentName = await peerRuntime.client.exec(peerOwner.containerName,
          ['curl', '--fail', '--max-time', '5', `http://${legacyHost}:18181/`]);
        expect(absentName.returnCode, 'Without derived hints, the original VM resolver cannot resolve the legacy worker name').toBe(6);
        peerManager.refreshManagedNetworkHosts = refreshNames;
        expect((await actual.reconcile(savedNetwork, undefined, peerCoverage)).partialFailures).toEqual([]);
        // Check the retained alias at migration, before the later deliberate
        // detach/recreate drops endpoint-only aliases by Docker semantics.
        const namedAlias = await peerRuntime.client.exec(peerOwner.containerName,
          ['curl', '--fail', '--max-time', '5', 'http://retained-peer:18181/']);
        expect(namedAlias.returnCode, namedAlias.stderr).toBe(0);
        expect(namedAlias.stdout.trim()).toBe('mixed-manager-ok');
      }
    }
    const localHook = () => withOwnerWorkerLifecycleMutation(network.userId, peerId, () =>
      (peerManager as any).reconcileManagedNetworksForWorker(peerManager.get(peerId)!));
    const attachedDevices = (await peerRuntime.client.getInstance(peerOwner.containerName)).devices;
    await localHook(); // own guarded native leaf, no queue reentry or unnecessary PUT
    expect((await peerRuntime.client.getInstance(peerOwner.containerName)).devices).toEqual(attachedDevices);
    expect((await host.inspect(network))!.references).toContain(`/1.0/instances/${peerOwner.containerName}?project=agentor`);
    expect(await actual.actualWorkerIds(network)).toEqual([...peerCoverage].sort());
    const beforeDenied = await peerRuntime.client.getInstance(peerOwner.containerName);
    const coverage = await authorizeManagedNetworkMutation([network], [], undefined, {
      actualWorkerIds: value => actual.actualWorkerIds(value),
      verify: async ids => expect([...ids].sort()).toEqual([...peerCoverage].sort()),
    });
    expect([...coverage].sort()).toEqual([...peerCoverage].sort());
    await expect(actual.reconcile(network, [], new Set())).rejects.toThrow('uncovered worker');
    await expect(actual.remove(network, new Set())).rejects.toThrow('uncovered worker');
    expect((await peerRuntime.client.getInstance(peerOwner.containerName)).devices).toEqual(beforeDenied.devices);
    if (!running) await expect(new Docker({ socketPath: dockerSocket }).getNetwork(legacyName).inspect())
      .rejects.toMatchObject({ statusCode: 404 });
    observedManager = { list: () => [] }; // orphaned cache must not hide a real native attachment
    await expect(actual.actualWorkerIds(network)).rejects.toThrow(/unmapped|Docker endpoint/);
    observedManager = peerManager;
    expect((await actual.reconcile(savedNetwork, [], peerCoverage)).partialFailures).toEqual([]);
    expect(await actual.actualWorkerIds(network)).toEqual([]);
    await localHook(); // lifecycle restores only the desired captured worker
    expect(await actual.actualWorkerIds(network)).toEqual([peerId]);
    if (running) {
      const runtime = peerRuntime, info = peerManager.get(peerId)!;
      // Minimal synthetic owner has no account/environment DB. Only fixture
      // options resolution is supplied; recovery, native exec/provisioning,
      // stores, queue admission and membership dispatch are production paths.
      (peerManager as any).incusOptionsForWorker = async () => peerOptions;
      const checked = async (command: string[]) => {
        const result = await runtime.client.exec(info.containerName, command);
        expect(result.returnCode, result.stdout + result.stderr).toBe(0); return result.stdout.trim();
      };
      const healthy = await runtime.inspectGuestReadiness(info, peerIncarnation!);
      expect(healthy.provisioned && healthy.serviceReady).toBe(true);
      const pid = await checked(['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service']);
      expect(Number(pid)).toBeGreaterThan(0);
      const primary = await runtime.resolvePrimaryAddress(info);
      const routes = await checked(['ip', '-j', 'route', 'show', 'default']);
      const resolver = await checked(['resolvectl', 'dns', 'eth0']);
      await peerManager.setIncusManagedNetwork(peerId, network.id, false);
      await peerManager.reconcileIncusWorkers();
      expect((await peerManager.inspectIncusManagedNetwork(peerId, network.id)).attached).toBe(true);
      expect((await runtime.inspectGuestReadiness(info, peerIncarnation!)).bootId).toBe(healthy.bootId);
      expect(await checked(['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service'])).toBe(pid);
      expect((await actual.reconcile(savedNetwork, undefined, peerCoverage)).partialFailures).toEqual([]);
      const endpoints = (await legacyPeer.inspect()).NetworkSettings.Networks;
      expect(endpoints[network.dockerName]).toBeUndefined();
      expect((await docker.getNetwork(network.dockerName).inspect()).Containers).toEqual({});
      const mixedTraffic = async () => {
        await expect.poll(async () => (await runtime.client.exec(info.containerName,
          ['curl', '--fail', '--max-time', '3', `http://${endpoints[`${network.dockerName}-incus`].IPAddress}:18181/`])).stdout.trim(),
          { timeout: 60_000, intervals: [500, 1000] }).toBe('mixed-manager-ok');
        const vm = await peerManager.inspectIncusManagedNetwork(peerId, network.id);
        expect(vm.ipv4Address).toBeTruthy();
        const result = await root(`sudo docker exec '${(await legacyPeer.inspect()).Name.slice(1)}' node -e 'require("http").get("http://${vm.ipv4Address}:8443/",r=>{if(r.statusCode>=500)process.exit(1);r.resume();r.on("end",()=>console.log("vm-editor-ok"))}).on("error",()=>process.exit(1))'`);
        expect(result).toBe('vm-editor-ok');
        if (process.env.INCUS_NETWORK_DNS_TEST === 'true') {
          // The existing app UI advertises containerName as a resolvable
          // on-network hostname. Endpoint alias metadata alone does not prove
          // compatibility for VM peers after Docker bridge adaptation.
          const namedLegacy = await runtime.client.exec(info.containerName,
            ['curl', '--fail', '--max-time', '5', `http://${(await legacyPeer.inspect()).Name.slice(1)}:18181/`]);
          expect(namedLegacy.returnCode, namedLegacy.stderr).toBe(0);
          expect(namedLegacy.stdout.trim()).toBe('mixed-manager-ok');
          const namedVm = await root(`sudo docker exec '${(await legacyPeer.inspect()).Name.slice(1)}' node -e 'require("http").get("http://${info.containerName}:8443/",r=>{if(r.statusCode>=500)process.exit(1);r.resume();r.on("end",()=>console.log("named-vm-editor-ok"))}).on("error",e=>{console.error(e.code);process.exit(1)})'`);
          expect(namedVm).toBe('named-vm-editor-ok');
        }
      };
      await mixedTraffic();
      expect(await checked(['ip', '-j', 'route', 'show', 'default'])).toBe(routes);
      expect(await checked(['resolvectl', 'dns', 'eth0'])).toBe(resolver);
      expect(await runtime.resolvePrimaryAddress(info)).toEqual(primary);
      await runtime.client.exec(info.containerName, ['sh', '-c', 'nohup sh -c "sleep 1; reboot" >/dev/null 2>&1 &']);
      await expect.poll(async () => {
        try { const state = await runtime.inspectGuestReadiness(info, peerIncarnation!);
          return state.bootId !== healthy.bootId && !state.provisioned;
        } catch { return false; }
      }, { timeout: 120_000, intervals: [1000, 2000] }).toBe(true);
      await peerManager.reconcileIncusWorkers();
      const recovered = await runtime.inspectGuestReadiness(info, peerIncarnation!);
      expect(recovered).toMatchObject({ provisioned: true, serviceReady: true });
      expect(recovered.bootId).not.toBe(healthy.bootId);
      await mixedTraffic();
      expect(await checked(['ip', '-j', 'route', 'show', 'default'])).toBe(routes);
      expect(await checked(['resolvectl', 'dns', 'eth0'])).toBe(resolver);
      expect(await runtime.resolvePrimaryAddress(info)).toEqual(primary);
      console.info('Running production-manager mixed traffic, aliases, healthy network-only repair and guest reboot recovery passed');
    }
    await store.update(network.userId, network.id, { workerIds: [] });
    await localHook(); // revoked membership is detached, never blessed by cache
    expect(await actual.actualWorkerIds(network)).toEqual(legacyPeerId ? [legacyPeerId] : []);
    expect((await actual.reconcile(savedNetwork, [], peerCoverage)).partialFailures).toEqual([]);
    await peerRuntime.remove(peerOwner, peerIncarnation!); await peerRuntime.removeStorage(peerOwner);
    peerRuntime.client.dispose(); peerCreateSubmitted = false; peerIncarnation = undefined;
    if (legacyPeer) {
      const state = await legacyPeer.inspect();
      expect(state.Id).toBe(legacyPeer.id);
      expect(state.Config.Labels['agentor.network-running-fixture']).toBe(network.id);
      await legacyPeer.remove({ force: true }); legacyPeer = undefined; legacySubmitted = false;
    }
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
    await actual.remove(savedNetwork, peerCoverage); adapterSubmitted = false; ensureSubmitted = false; legacyBackingSubmitted = false;
    expect(await host.inspect(network)).toBe(null);
    await host.remove(network);
    await host.remove(network);
    ensureSubmitted = false;
    expect(JSON.parse(await root('sudo incus query /1.0/projects/agentor')).config).toEqual(projectBefore.config);
    complete = true;
  } catch (error) {
    console.error('Host-service live gate failed before cleanup', error);
    throw error;
  } finally {
    try {
      if (peerCreateSubmitted) {
        if (!peerRuntime || !peerOwner || !peerIncarnation)
          throw new Error('Unsettled native reference fixture retained for captured-identity recovery');
        await peerRuntime.remove(peerOwner, peerIncarnation); await peerRuntime.removeStorage(peerOwner);
        peerRuntime.client.dispose();
      }
      if (legacyPeer) {
        const state = await legacyPeer.inspect();
        expect(state.Id).toBe(legacyPeer.id);
        expect(state.Config.Labels['agentor.network-running-fixture']).toBe(network.id);
        await legacyPeer.remove({ force: true }); legacySubmitted = false;
      }
      if (legacySubmitted) throw new Error('Unacknowledged legacy peer create retained for captured-identity recovery');
      if (legacyBackingSubmitted) {
        if (!legacyBridgeId) throw new Error('Unacknowledged legacy backing create retained for exact inspection');
        let legacy: any;
        try { legacy = await docker.getNetwork(legacyBridgeId).inspect(); }
        catch (error: any) { if (error?.statusCode !== 404) throw error; }
        if (legacy) {
          expect(legacy.Id).toBe(legacyBridgeId); expect(legacy.Name).toBe(network.dockerName);
          expect(legacy.Labels).toMatchObject({ 'agentor.managed-network': 'true', 'agentor.owner': network.userId });
          expect(Object.keys(legacy.Containers)).toEqual([]);
          await docker.getNetwork(legacyBridgeId).remove();
        }
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
