import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { IncusHostMountClient } from '../../orchestrator/server/utils/incus-host-mount-client';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';

test('host mount client sends only catalog ID and pins source/project/installation/mode/identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-host-export-client-'));
  try {
    const installation = await backupInstallationId(dataDir), pathId = randomUUID();
    const config = { dataDir, incusProject: 'agentor', incusNetworkHostEndpoint: 'https://host.invalid' } as Config;
    const mount = { pathId, source: '/srv/approved-share', target: '/mnt/share', readOnly: true };
    const selected = { installation, project: 'agentor', pathId, sourcePath: mount.source,
      allowWrite: false, sourceIdentity: 'a'.repeat(64) };
    let result: any = selected; const calls: any[] = [];
    const host = new IncusHostMountClient(config, { request: async (...args: any[]) => { calls.push(args); return result; } });
    expect(await host.ensure(mount)).toEqual(selected);
    expect(await host.inspect(mount)).toEqual(selected);
    expect(calls).toEqual([['POST', '/v1/host-mounts/ensure', { pathId }], ['POST', '/v1/host-mounts/inspect', { pathId }]]);
    for (const patch of [{ installation: randomUUID() }, { project: 'foreign' }, { pathId: randomUUID() },
      { sourcePath: '/etc' }, { allowWrite: 'true' }, { sourceIdentity: 'not-authority' }]) {
      result = { ...selected, ...patch }; await expect(host.ensure(mount)).rejects.toThrow('authority');
    }
    result = selected; await expect(host.ensure({ ...mount, readOnly: false })).rejects.toThrow('read-only');
    result = { ...selected, allowWrite: true };
    expect((await host.ensure({ ...mount, readOnly: false })).allowWrite).toBe(true);
    calls.length = 0;
    for (const patch of [{ pathId: undefined }, { pathId: '../foreign' }, { source: '/' }, { source: '/srv/share,/etc' },
      { source: '/srv/../etc' }, { readOnly: 'false' }])
      await expect(host.ensure({ ...mount, ...patch } as any)).rejects.toThrow('resolved catalog');
    expect(calls).toEqual([]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('missing host policy endpoint or installation fails closed without manufacturing authority', async () => {
  expect(() => new IncusHostMountClient({} as Config)).toThrow('operator-installed');
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-host-export-client-'));
  try {
    const calls: unknown[] = [];
    const host = new IncusHostMountClient({ dataDir, incusNetworkHostEndpoint: 'https://host.invalid' } as Config,
      { request: async (...args: any[]) => { calls.push(args); throw new Error('must not request'); } });
    await expect(host.ensure({ pathId: randomUUID(), source: '/srv/share', target: '/mnt/share' })).rejects.toThrow();
    expect(calls).toEqual([]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
