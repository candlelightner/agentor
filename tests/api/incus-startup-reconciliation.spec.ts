import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { IncusError } from '../../orchestrator/server/utils/incus-client';

const compiler = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('typescript') as {
  transpileModule(source: string, options: { compilerOptions: { target: number } }): { outputText: string };
  ScriptTarget: { ES2022: number };
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;

// Execute the actual startup inventory/revocation/reconciliation/timer block,
// not a rewritten retry implementation or the unrelated native DB/admin init.
async function fixture(options: { initialError?: Error; enabled?: boolean; readiness?: boolean; recovery?: boolean } = {}) {
  const source = await readFile(new URL('../../orchestrator/server/plugins/services.ts', import.meta.url), 'utf8');
  const from = source.indexOf('  let startupInventoryDeferred = false;');
  const to = source.indexOf('  // Restore desired managed-network membership', from);
  expect(from).toBeGreaterThan(source.indexOf('await useManagedVolumeManager().recoverStartup()'));
  expect(to).toBeGreaterThan(from);
  const body = compiler.transpileModule(source.slice(from, to), { compilerOptions: { target: compiler.ScriptTarget.ES2022 } }).outputText;
  const calls: string[] = [], warnings: string[] = [], timers: Array<{ delay: number; callback: () => void }> = [];
  const record = Object.freeze({ id: 'owned-worker', userId: 'owner', runtimeKind: options.enabled === false ? 'legacy-docker' : 'incus-vm',
    desiredRuntimeStatus: 'running', hostMountsRevoked: false, hardwareDevicesRevoked: false, source: 'private-immutable-source' });
  const baseline = structuredClone(record);
  const api = { available: !options.initialError, readiness: options.readiness !== false, verifiedInventory: false };
  let initial = options.initialError, worker: { id: string; userId: string; status: string; containerId: string } | undefined;
  let hold: Promise<void> | undefined;
  const manager = {
    sync: async () => {
      calls.push('sync'); if (hold) await hold;
      if (initial) { const error = initial; initial = undefined; throw error; }
      if (!api.available) throw Object.assign(new Error('Private transport details'), { code: 'ECONNREFUSED', syscall: 'connect', port: 8443 });
      api.verifiedInventory = true; worker = { id: record.id, userId: record.userId, status: 'stopped',
        containerId: record.runtimeKind === 'legacy-docker' ? 'retained-legacy-id' : 'incus:captured-uuid' };
    },
    reconcileHostMountAccess: async () => { calls.push('host-fence'); return { failures: [] }; },
    reconcileHardwareDeviceAccess: async () => { calls.push('hardware-fence'); return { failures: [] }; },
    reconcileWorkers: async () => {
      calls.push('reconcile'); expect(api.verifiedInventory).toBe(true);
      if (!api.readiness) throw new IncusError('Verified runtime readiness denied', 403);
      expect(record).toEqual(baseline); worker!.status = 'running';
    },
    list: () => worker ? [worker] : [],
  };
  const adapter = { fixed: 'existing persistent-path adapter' };
  const start = new AsyncFunction('containerManager', 'IncusError', 'useConfig', 'logger', 'instanceRecoveryMode', 'useBackupManager',
    'usePersistentBackupPathManager', 'usePluginRuntimeManager', 'useLogCollector', 'usePluginInstallationStore', 'instanceSnapshotActive',
    'useWorkerStore', 'useTraefikManager', 'setInterval', body);
  return { calls, warnings, timers, record, baseline, api, worker: () => worker, hold: (value?: Promise<void>) => { hold = value; },
    start: () => start(manager, IncusError, () => ({ incusEnabled: options.enabled !== false, incusEndpoint: 'https://incus.internal:8443' }),
      { warn: (value: string) => warnings.push(value), error: () => {} }, options.recovery === true,
      () => ({ setPathPersistenceAdapter: (value: unknown) => { expect(value).toBe(adapter); calls.push('persistence-adapter'); } }), () => adapter,
      () => ({ reconcileWorker: async () => { calls.push('plugin'); } }), () => ({ reconcileIncus: async () => { calls.push('logs'); } }),
      () => ({ listForWorker: () => [] }), () => false, () => ({ list: () => [record] }),
      () => ({ refreshWorkerBackends: async () => { calls.push('routes'); } }),
      (callback: () => void, delay: number) => { timers.push({ callback, delay }); return { unref() {} }; }) };
}

for (const failure of ['refused', 'timeout'] as const) test(`initial Incus ${failure} retains fences and existing timer recovers desired-running worker`, async () => {
  const initialError = failure === 'refused'
    ? Object.assign(new Error('PRIVATE-TRANSPORT-SENTINEL'), { code: 'ECONNREFUSED', syscall: 'connect', port: 8443 })
    : new IncusError('PRIVATE-TRANSPORT-SENTINEL', 408);
  const f = await fixture({ initialError }); await f.start();
  expect(f.calls).toEqual(['sync', 'host-fence', 'hardware-fence', 'persistence-adapter']);
  expect(f.worker()).toBeUndefined(); expect(f.record).toEqual(f.baseline);
  expect(f.timers).toHaveLength(1); expect(f.timers[0]!.delay).toBe(30_000);
  expect(f.warnings.join('\n')).toContain('initial Incus inventory unavailable'); expect(f.warnings.join('\n')).not.toContain('PRIVATE-TRANSPORT-SENTINEL');
  f.timers[0]!.callback(); await expect.poll(() => f.calls.filter(value => value === 'sync').length).toBe(2);
  await new Promise(resolve => setImmediate(resolve)); expect(f.calls).not.toContain('reconcile');
  f.api.available = true; f.timers[0]!.callback();
  await expect.poll(() => f.worker()?.status).toBe('running'); expect(f.record).toEqual(f.baseline);
  expect(f.worker()?.containerId).toBe('incus:captured-uuid');
});

test('deferred startup preserves the existing nonoverlapping periodic pass', async () => {
  const f = await fixture({ initialError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED', syscall: 'connect', port: 8443 }) });
  await f.start(); f.api.available = true;
  let release!: () => void; f.hold(new Promise<void>(resolve => { release = resolve; }));
  f.timers[0]!.callback(); f.timers[0]!.callback(); expect(f.calls.filter(value => value === 'sync')).toHaveLength(2);
  release(); await expect.poll(() => f.worker()?.status).toBe('running');
});

test('permanent credential/project/readiness failures are not swallowed or converted to legacy authority', async () => {
  for (const initialError of [Object.assign(new Error('TLS identity denied'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), new IncusError('Project denied', 403)]) {
    const f = await fixture({ initialError }); await expect(f.start()).rejects.toBe(initialError);
    expect(f.timers).toEqual([]); expect(f.calls).toEqual(['sync']); expect(f.record).toEqual(f.baseline);
  }
  const readiness = await fixture({ readiness: false });
  await expect(readiness.start()).rejects.toMatchObject({ statusCode: 403 }); expect(readiness.worker()?.status).toBe('stopped');
  expect(readiness.record.runtimeKind).toBe('incus-vm'); expect(readiness.record).toEqual(readiness.baseline);
});

test('disabled legacy startup and Docker Unix failures retain their previous behavior', async () => {
  for (const options of [{ enabled: false, initialError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED', syscall: 'connect', port: 8443 }) },
    { initialError: Object.assign(new Error('Docker unavailable'), { code: 'ECONNREFUSED', syscall: 'connect', address: '/var/run/docker.sock' }) }]) {
    const f = await fixture(options); await expect(f.start()).rejects.toBe(options.initialError); expect(f.timers).toEqual([]);
  }
  const ordinary = await fixture({ enabled: false }); await ordinary.start();
  expect(ordinary.calls.slice(0, 5)).toEqual(['sync', 'host-fence', 'hardware-fence', 'persistence-adapter', 'reconcile']);
  expect(ordinary.worker()?.status).toBe('running'); expect(ordinary.record.runtimeKind).toBe('legacy-docker'); expect(ordinary.timers).toHaveLength(1);
});
