import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePluginManifest } from '../../orchestrator/server/utils/plugin-manifest';
import { PluginDefinitionStore } from '../../orchestrator/server/utils/plugin-definition-store';
import { PluginInstallationStore } from '../../orchestrator/server/utils/plugin-installation-store';
import { PluginRuntimeManager, type PluginWorkerExecutor } from '../../orchestrator/server/utils/plugin-runtime-manager';
import { resolvePluginDesktop } from '../../orchestrator/server/utils/plugin-desktop-access';

function manifest(mode = 'isolated') { return { schemaVersion: 1, name: 'Desktop', slug: 'desktop', description: '', version: '1', lifecycle: { start: { argv: ['true'] } }, resources: { display: { mode } }, actions: [{ id: 'open', kind: 'desktop', label: 'Open' }] }; }
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-desktop-core-'));
  const definitions = new PluginDefinitionStore(directory), installations = new PluginInstallationStore(directory);
  await Promise.all([definitions.init(), installations.init()]);
  const definition = await definitions.create({ scope: 'owner', ownerId: 'owner', manifest: manifest() });
  const create = () => installations.create({ userId: 'owner', workerId: 'worker', definitionId: definition.id, definitionVersion: '1', definitionHash: definition.definitionHash });
  return { directory, definitions, installations, definition, create, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('isolated schema supplies bounded dimensions and a native port-free action without changing legacy manifests', () => {
  expect(validatePluginManifest(manifest())).toMatchObject({ resources: { display: { mode: 'isolated', width: 1920, height: 1080, depth: 24 } }, actions: [{ kind: 'desktop', displayId: 'primary' }] });
  for (const display of [{ mode: 'isolated', width: 99999 }, { mode: 'isolated', depth: 32 }, { mode: 'isolated', rangeStart: 99 }, { mode: 'shared', height: 600 }])
    expect(() => validatePluginManifest({ ...manifest(), resources: { display } })).toThrow();
  expect(() => validatePluginManifest(manifest('dedicated'))).toThrow(/requires/);
  expect(validatePluginManifest({ ...manifest('dedicated'), actions: [] }).resources?.display).toEqual({ mode: 'dedicated', rangeStart: 100, rangeEnd: 199 });
  expect(validatePluginManifest(manifest('shared')).resources?.display).toEqual({ mode: 'shared' });
  expect(() => validatePluginManifest({ ...manifest(), actions: [{ id: 'open', kind: 'desktop', label: 'Open', portId: 'vnc' }] })).toThrow(/unsupported/);
});

test('simultaneous reservations cannot collide and remain stable after store reload', async () => {
  const h = await setup(); try {
    const items = await Promise.all(Array.from({ length: 12 }, h.create));
    const reserved = await Promise.all(items.map(i => h.installations.reserveResources('owner', i.id, h.definition.manifest)));
    expect(new Set(reserved.map(i => i.allocations?.display)).size).toBe(12);
    expect(reserved.every(i => i.allocations?.display !== 99 && Object.keys(i.allocations!.ports).length === 0)).toBe(true);
    const reloaded = new PluginInstallationStore(h.directory); await reloaded.init();
    expect((await reloaded.reserveResources('owner', items[0]!.id, h.definition.manifest)).allocations).toEqual(reserved[0]!.allocations);
  } finally { await h.cleanup(); }
});

test('reconciliation starts desktop before GUI, repairs a crash, rebuilds all desired desktops, and cleans up only the disabled installation', async () => {
  const h = await setup(); try {
    const calls: string[] = [], alive = new Set<string>();
    const executor: PluginWorkerExecutor = {
      execute: async r => { calls.push(`${r.installationId}:${r.phase}`); if (r.phase === 'start') { expect(alive.has(r.installationId)).toBe(true); expect(r.isolatedDisplay).toBeGreaterThan(99); } return { exitCode: 0 }; },
      probe: async () => ({ exitCode: 0 }),
      desktop: async r => { calls.push(`${r.installationId}:${r.operation}`); if (r.operation === 'ensure' && r.config.display === 100) return { exitCode: 98 }; if (r.operation === 'ensure') alive.add(r.installationId); if (r.operation === 'stop') alive.delete(r.installationId); return { exitCode: r.operation === 'status' && !alive.has(r.installationId) ? 1 : 0 }; },
    };
    const runtime = new PluginRuntimeManager(h.definitions, h.installations, executor);
    const first = await h.create(), second = await h.create();
    await runtime.reconcileWorker('owner', 'worker', 'generation-1');
    expect(alive.size).toBe(2);
    expect(h.installations.getById(first.id)?.allocations?.display).toBe(101);
    expect(h.installations.getById(second.id)?.allocations?.display).toBe(102);
    alive.delete(first.id); await runtime.reconcileWorker('owner', 'worker', 'generation-1');
    expect(alive.size).toBe(2); expect(calls.filter(c => c === `${first.id}:start`)).toHaveLength(2);
    alive.clear(); await runtime.reconcileWorker('owner', 'worker', 'generation-2'); expect(alive.size).toBe(2);
    await runtime.disable('owner', first.id, 'generation-2'); expect([...alive]).toEqual([second.id]);
    await runtime.uninstall('owner', first.id, 'generation-2'); expect([...alive]).toEqual([second.id]);
    expect(h.installations.getById(second.id)?.observed.desktop).toMatchObject({ state: 'ready', viewerReady: true });
  } finally { await h.cleanup(); }
});

test('GUI failure tears down the managed desktop and retains a sanitized inspectable failure', async () => {
  const h = await setup(); try {
    const calls: string[] = [];
    const runtime = new PluginRuntimeManager(h.definitions, h.installations, {
      execute: async r => ({ exitCode: r.phase === 'start' ? 1 : 0, output: 'private command output' }), probe: async () => ({ exitCode: 0 }),
      desktop: async r => { calls.push(r.operation); return { exitCode: 0 }; },
    });
    const first = await h.create(); await expect(runtime.reconcileInstallation('owner', first.id, 'generation')).rejects.toThrow();
    expect(calls).toEqual(['ensure', 'stop']);
    const current = h.installations.getById(first.id)!;
    expect(current.observed.desktop).toMatchObject({ state: 'failed', viewerReady: false });
    expect(JSON.stringify(current)).not.toContain('private command output');
  } finally { await h.cleanup(); }
});

test('desktop authorization binds user, worker, installation, action, allocation, and runtime generation', async () => {
  const h = await setup(); try {
    const first = await h.create(); const allocated = await h.installations.reserveResources('owner', first.id, h.definition.manifest);
    const installation = { ...allocated, observed: { state: 'ready' as const, ready: true, runtimeGeneration: 'runtime', checkedAt: '', desktop: { mode: 'isolated' as const, display: allocated.allocations!.display!, state: 'ready' as const, viewerReady: true } } };
    const auth = { user: { id: 'owner', email: '', name: '' }, session: {} } as any;
    const worker = { id: 'worker', userId: 'owner', status: 'running', containerId: 'runtime', containerName: 'worker' };
    const target = { workerId: 'worker', installationId: first.id, actionId: 'open', displayId: 'primary' };
    const resolve = (a = auth, w = worker, i = installation, d = h.definition, t = target) => resolvePluginDesktop(a, w, i, d, t);
    expect(resolve().ready).toBe(true);
    expect(() => resolve(null)).toThrow(/Sign in/);
    expect(() => resolve({ ...auth, user: { ...auth.user, id: 'other' } })).toThrow(/not found/);
    for (const change of [{ workerId: 'other' }, { installationId: 'other' }, { actionId: 'other' }, { displayId: 'other' }]) expect(() => resolve(auth, worker, installation, h.definition, { ...target, ...change })).toThrow(/not found/);
    expect(() => resolve(auth, worker, { ...installation, allocations: { ports: {}, display: 99 } })).toThrow(/allocation/);
    expect(resolve(auth, { ...worker, containerId: 'replacement' }).ready).toBe(false);
    expect(resolve(auth, worker, { ...installation, desiredEnabled: false }).ready).toBe(false);
  } finally { await h.cleanup(); }
});
