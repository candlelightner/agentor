import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { IncusManagedNetworkHost } from '../../orchestrator/server/utils/incus-managed-network-host';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';
import type { ManagedNetwork } from '../../orchestrator/server/utils/managed-network-store';

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
