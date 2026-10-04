import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerConfigStore, useWorkerConfigStore, type WorkerAppliedBootstrap } from '../../orchestrator/server/utils/worker-config-store';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { encryptWorkerValue } from '../../orchestrator/server/utils/worker-config-crypto';
import type { Config } from '../../orchestrator/server/utils/config';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });

function bootstrap(): WorkerAppliedBootstrap {
  return { version: 1, cpuLimit: 0, memoryLimit: '2GiB', dockerEnabled: false,
    userEnv: { ...zeroUserEnvVars('owner'), envVars: [{ key: 'TOKEN', value: 'applied-account-secret' }] },
    environmentJson: { networkMode: 'custom', allowedDomains: ['example.com'], dockerEnabled: false,
      setupScript: 'old-setup', envVars: 'COLOR=blue', exposeApis: { portMappings: true, domainMappings: false, usage: false } },
    capabilitiesJson: [{ name: 'cap', content: 'old-capability' }],
    instructionsJson: [{ name: 'rules', content: 'old-instructions' }],
    workerJson: { id: 'worker', displayName: 'old-name', repos: [{ provider: 'git', url: 'https://example.com/old' }],
      initScript: 'old-init', gitName: 'old-git', gitEmail: 'old@example.com' },
    excludedGlobalEnvVarKeys: ['DELETED_CUSTOM'], excludedGroupEnvVarKeys: ['GROUP_SECRET'] };
}

async function fixture(run: (store: WorkerConfigStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-applied-bootstrap-'));
  try { await run(new WorkerConfigStore({ dataDir: root } as Config), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('applied bootstrap is encrypted, detached, reloadable and absent from public configuration', async () => {
  await fixture(async (store, root) => {
    const input = bootstrap();
    const save = store.markApplied('owner', 'worker', input);
    input.workerJson.initScript = 'mutated after call';
    await save;
    const disk = await readFile(join(root, 'users/owner/worker-configurations.json'), 'utf8');
    expect(disk).not.toContain('applied-account-secret');
    expect(disk).not.toContain('old-init');
    const reloaded = new WorkerConfigStore({ dataDir: root } as Config);
    const applied = (await reloaded.resolveAppliedBootstrap('owner', 'worker'))!;
    expect(applied).toEqual(bootstrap());
    applied.userEnv.envVars[0]!.value = 'mutated read';
    expect(await reloaded.resolveAppliedBootstrap('owner', 'worker')).toEqual(bootstrap());
    const publicResult = reloaded.publicRecord(await reloaded.get('owner', 'worker'), 'owner', 'worker');
    expect(publicResult).toMatchObject({ userId: 'owner', workerId: 'worker', entries: [] });
    expect(JSON.stringify(publicResult)).not.toContain('appliedBootstrap');
    expect(JSON.stringify(publicResult)).not.toContain('applied-account-secret');
    expect(await reloaded.resolveAppliedValues('owner', 'worker')).toEqual([]);
  });
});

test('pending changes survive old-revision promotion and only successful replacement promotes both snapshots', async () => {
  await fixture(async (store) => {
    await store.replace('owner', 'worker', [{ kind: 'secret', key: 'LOCAL', value: 'old-secret' }]);
    const old = await store.resolveDesiredRevision('owner', 'worker');
    // Configuration routes can edit while a slow VM is booting. This edit was
    // never sent to that VM and must not be marked applied on boot completion.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.replace('owner', 'worker', [{ kind: 'secret', key: 'LOCAL', value: 'new-secret' }]);
    await store.markApplied('owner', 'worker', bootstrap(), old.revision);
    expect((await store.resolveAppliedValues('owner', 'worker'))[0]!.value).toBe('old-secret');
    expect((await store.resolveValues('owner', 'worker'))[0]!.value).toBe('new-secret');
    expect((await store.get('owner', 'worker'))!.appliedAt).not.toBe((await store.get('owner', 'worker'))!.updatedAt);
    const desired = await store.resolveDesiredRevision('owner', 'worker');
    const next = bootstrap(); next.workerJson.initScript = 'new-init';
    const persist = (store as any).persist;
    (store as any).persist = async () => { throw new Error('disk failure'); };
    await expect(store.markApplied('owner', 'worker', next, desired.revision)).rejects.toThrow('disk failure');
    expect(await store.resolveAppliedBootstrap('owner', 'worker')).toEqual(bootstrap());
    expect((await store.resolveAppliedValues('owner', 'worker'))[0]!.value).toBe('old-secret');
    (store as any).persist = persist;
    await store.markApplied('owner', 'worker', next, desired.revision);
    expect((await store.resolveAppliedBootstrap('owner', 'worker'))!.workerJson.initScript).toBe('new-init');
    expect((await store.resolveAppliedValues('owner', 'worker'))[0]!.value).toBe('new-secret');
    expect((await store.get('owner', 'worker'))!.appliedAt).toBe((await store.get('owner', 'worker'))!.updatedAt);
  });
});

test('a no-local-entry revision cannot apply an edit that arrived during creation', async () => {
  await fixture(async (store) => {
    const empty = await store.resolveDesiredRevision('owner', 'worker');
    await store.replace('owner', 'worker', [{ kind: 'variable', key: 'COLOR', value: 'new' }]);
    await store.markApplied('owner', 'worker', bootstrap(), empty.revision);
    expect(await store.resolveAppliedValues('owner', 'worker')).toEqual([]);
    expect((await store.get('owner', 'worker'))!.appliedAt).toBeUndefined();
    expect((await store.resolveValues('owner', 'worker'))[0]!.value).toBe('new');
  });
});

test('failed initial snapshot persistence leaves no fake applied record', async () => {
  await fixture(async (store) => {
    (store as any).persist = async () => { throw new Error('disk failure'); };
    await expect(store.markApplied('owner', 'worker', bootstrap())).rejects.toThrow('disk failure');
    expect(await store.get('owner', 'worker')).toBeUndefined();
  });
});

test('legacy configuration without bootstrap remains readable and never substitutes pending values', async () => {
  await fixture(async (store, root) => {
    await store.replace('owner', 'worker', [{ kind: 'variable', key: 'COLOR', value: 'pending' }]);
    const reloaded = new WorkerConfigStore({ dataDir: root } as Config);
    expect(await reloaded.resolveAppliedBootstrap('owner', 'worker')).toBeUndefined();
    expect(await reloaded.resolveAppliedValues('owner', 'worker')).toEqual([]);
    expect((await reloaded.resolveValues('owner', 'worker'))[0]!.value).toBe('pending');
  });
});

test('historical partial exposure flags retain worker defaults and explicit false', async () => {
  await fixture(async (store, root) => {
    const input = bootstrap();
    input.environmentJson.exposeApis = { usage: false } as WorkerAppliedBootstrap['environmentJson']['exposeApis'];
    await store.markApplied('owner', 'worker', input);
    expect((await new WorkerConfigStore({ dataDir: root } as Config).resolveAppliedBootstrap('owner', 'worker'))!
      .environmentJson.exposeApis).toEqual({ usage: false });
  });
});

test('invalid bootstrap envelopes quarantine rather than overwrite persisted state', async () => {
  for (const alter of [(v: any) => { v.algorithm = 'invalid'; }, (v: any) => { v.iv = 'AA=='; },
    (v: any) => { v.tag = null; }, (v: any) => { v.ciphertext = '#'; },
    (v: any) => { v.ciphertext = 'A'.repeat(24 * 1024 * 1024); }]) {
    await fixture(async (store, root) => {
      await store.markApplied('owner', 'worker', bootstrap());
      const path = join(root, 'users/owner/worker-configurations.json');
      const records = JSON.parse(await readFile(path, 'utf8'));
      alter(records[0].appliedBootstrap);
      const source = JSON.stringify(records); await writeFile(path, source);
      const reloaded = new WorkerConfigStore({ dataDir: root } as Config);
      await expect(reloaded.resolveAppliedBootstrap('owner', 'worker')).rejects.toMatchObject({ statusCode: 503 });
      await expect(reloaded.markApplied('owner', 'worker', bootstrap())).rejects.toMatchObject({ statusCode: 503 });
      expect(await readFile(path, 'utf8')).toBe(source);
    });
  }
});

test('authenticated bootstrap schema rejects wrong identity, malformed fields and unsafe resource values', async () => {
  for (const alter of [(v: any) => { v.userEnv.userId = 'foreign'; }, (v: any) => { v.workerJson.id = 'foreign'; },
    (v: any) => { v.cpuLimit = -1; }, (v: any) => { v.environmentJson.dockerEnabled = true; },
    (v: any) => { v.userEnv.envVars[0].value = {}; }, (v: any) => { v.workerJson.repos = null; },
    (v: any) => { v.environmentJson.exposeApis.usage = 'true'; }, (v: any) => { v.environmentJson.exposeApis = []; },
    (v: any) => { v.instructionsJson = [null]; }]) {
    await fixture(async (store, root) => {
      await store.markApplied('owner', 'worker', bootstrap());
      const invalid = bootstrap(); alter(invalid);
      await expect(store.markApplied('owner', 'worker', invalid)).rejects.toThrow('bootstrap is invalid');
      const path = join(root, 'users/owner/worker-configurations.json');
      const records = JSON.parse(await readFile(path, 'utf8'));
      records[0].appliedBootstrap = await encryptWorkerValue({ dataDir: root } as Config,
        JSON.stringify(invalid), 'owner\0worker\0bootstrap\0applied');
      await writeFile(path, JSON.stringify(records));
      await expect(new WorkerConfigStore({ dataDir: root } as Config).resolveAppliedBootstrap('owner', 'worker'))
        .rejects.toThrow('explicit rebuild is required');
    });
  }
});

test('cross-worker ciphertext and ciphertext tampering cannot supply applied configuration', async () => {
  await fixture(async (store, root) => {
    await store.markApplied('owner', 'worker', bootstrap());
    const path = join(root, 'users/owner/worker-configurations.json');
    const records = JSON.parse(await readFile(path, 'utf8'));
    records.push({ ...records[0], workerId: 'other-worker' });
    await writeFile(path, JSON.stringify(records));
    await expect(new WorkerConfigStore({ dataDir: root } as Config).resolveAppliedBootstrap('owner', 'other-worker')).rejects.toThrow();
    const data = Buffer.from(records[0].appliedBootstrap.ciphertext, 'base64'); data[0] ^= 1;
    records[0].appliedBootstrap.ciphertext = data.toString('base64');
    await writeFile(path, JSON.stringify(records));
    await expect(new WorkerConfigStore({ dataDir: root } as Config).resolveAppliedBootstrap('owner', 'worker')).rejects.toThrow();
  });
});

test('restart uses applied environment/account/local values and exclusions but live credentials and SSH', async () => {
  const singleton = useWorkerConfigStore();
  const saved = { bootstrap: singleton.resolveAppliedBootstrap, applied: singleton.resolveAppliedValues, desired: singleton.resolveDesiredRevision };
  const manager = new ContainerManager({} as any, { containerPrefix: 'agentor-worker',
    incusEnabled: false } as Config);
  const info: any = { id: 'worker', userId: 'owner', containerName: 'agentor-worker-worker', runtimeKind: 'incus-vm',
    status: 'running', containerId: 'incus:uuid', pendingRebuild: true, environmentId: 'new-or-deleted-env',
    excludedGlobalEnvVarKeys: ['NEW_ACCOUNT'], excludedGroupEnvVarKeys: ['NEW_GROUP'], repos: [], initScript: 'pending-init' };
  singleton.resolveAppliedBootstrap = async () => bootstrap();
  singleton.resolveAppliedValues = async () => [{ kind: 'secret', key: 'LOCAL', value: 'old-local' }];
  singleton.resolveDesiredRevision = async () => { throw new Error('must not read pending local config'); };
  (manager as any).resolveEnvironmentConfig = () => { throw new Error('must not resolve desired/deleted environment'); };
  (manager as any).resolveGitIdentity = () => { throw new Error('must not replace baked git identity'); };
  (manager as any).resolveUserEnvAndBinds = async (...args: any[]) => {
    expect(args[1]).toEqual(['DELETED_CUSTOM']); expect(args[3]).toEqual(['GROUP_SECRET']);
    expect(args[5]).toEqual(bootstrap().userEnv);
    return { userEnv: zeroUserEnvVars('owner'), credentialBinds: ['live-bind'], groupSecrets: [{ kind: 'secret', key: 'GROUP', value: 'live-group' }] };
  };
  (manager as any).storageManager = { readSshAuthorizedKeys: async () => 'live-ssh' };
  try {
    const opts = await (manager as any).incusOptionsForWorker(info, true);
    expect(opts.environmentJson).toEqual(bootstrap().environmentJson);
    expect(opts.workerJson).toEqual(bootstrap().workerJson);
    expect(opts.userEnv).toEqual(bootstrap().userEnv);
    expect(opts.workerConfig.map((e: any) => e.value)).toEqual(['live-group', 'old-local']);
    expect(opts.credentialBinds).toEqual(['live-bind']); expect(opts.sshAuthorizedKeys).toBe('live-ssh');
    expect(info.pendingRebuild).toBe(true);
    singleton.resolveAppliedBootstrap = async () => undefined;
    await expect((manager as any).incusOptionsForWorker(info, true)).rejects.toThrow('explicit rebuild is required');
  } finally {
    singleton.resolveAppliedBootstrap = saved.bootstrap; singleton.resolveAppliedValues = saved.applied;
    singleton.resolveDesiredRevision = saved.desired;
  }
});

test('deleted historical account exclusions do not prevent applied restart', async () => {
  const manager = new ContainerManager({} as any, { incusEnabled: false } as Config);
  (manager as any).userEnvStore = { getOrDefault: () => zeroUserEnvVars('owner') };
  const result = await (manager as any).resolveUserEnvAndBinds('owner', ['DELETED_CUSTOM'], undefined, [], undefined, bootstrap().userEnv);
  expect(result.userEnv).toEqual(bootstrap().userEnv);
  await expect((manager as any).resolveUserEnvAndBinds('owner', ['DELETED_CUSTOM'])).rejects.toThrow('Unknown account');
});
