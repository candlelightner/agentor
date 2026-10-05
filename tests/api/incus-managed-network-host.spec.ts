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
    for (const patch of [{ name: 'foreign' }, { installation: randomUUID() }, { userId: 'foreign' },
      { networkId: randomUUID() }, { gateway: '192.0.2.1' }, { gateway: '10.42.87.2' },
      { subnet: '10.42.87.0/16' }, { dockerRange: '10.42.87.0/24' }]) {
      response = { ...bridge, ...patch };
      await expect(host.ensure(network)).rejects.toThrow(/authority|geometry/);
    }
    calls.length = 0;
    for (const patch of [{ id: '../foreign' }, { userId: 'owner,/etc' }, { dockerName: 'forged' }])
      await expect(host.ensure({ ...network, ...patch })).rejects.toThrow('Invalid managed network');
    expect(calls).toEqual([]);
    response = null;
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
  test.setTimeout(180_000);
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
  const config = { dataDir, incusProject: 'agentor', incusNetwork: 'incusbr0',
    incusNetworkHostEndpoint: 'https://127.0.0.1:18444',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' } as Config;
  const host = new IncusManagedNetworkHost(config);
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
    await root(`sudo systemd-run --no-block --collect --unit='${unit}' --property=RuntimeMaxSec=150 --property=TimeoutStopSec=10 /usr/bin/python3 '${remoteDir}/scripts/agentor-incus-network-service.py' --data-dir '${remoteDir}/data' --installation '${installation}' --project agentor --primary incusbr0 --bind 127.0.0.1 --port 18444 --server-cert /var/lib/incus/server.crt --server-key /var/lib/incus/server.key --client-cert '${remoteDir}/client.crt'`);
    let tunnelExit: number | null | undefined, tunnelError = '';
    tunnel = spawn('ssh', ['-N', '-p', '22375', ...access, '-o', 'ExitOnForwardFailure=yes',
      '-L', '127.0.0.1:18444:127.0.0.1:18444', destination], { stdio: ['ignore', 'ignore', 'pipe'] });
    tunnel.on('error', error => { tunnelError = error.message; });
    tunnel.on('exit', code => { tunnelExit = code; });
    tunnel.stderr!.on('data', chunk => { tunnelError = (tunnelError + chunk.toString()).slice(-1000); });
    await expect.poll(async () => {
      if (tunnelExit !== undefined || tunnelError) throw new Error(`Fixture tunnel failed: ${tunnelError}`);
      try { await host.readiness(); return true; } catch { return false; }
    }, { timeout: 15_000, intervals: [200, 500] }).toBe(true);
    ensureSubmitted = true; // uncertain acknowledgement must retain cleanup authority
    const bridge = await host.ensure(network);
    expect(bridge).toMatchObject({ name: expectedName, installation, userId: network.userId, networkId: network.id });
    expect(await host.ensure(network)).toEqual(bridge);
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
    await host.remove(network);
    await host.remove(network);
    ensureSubmitted = false;
    expect(JSON.parse(await root('sudo incus query /1.0/projects/agentor')).config).toEqual(projectBefore.config);
    complete = true;
  } finally {
    try {
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
