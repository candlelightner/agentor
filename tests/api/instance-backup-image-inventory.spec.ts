import { expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as deadlines from '../../orchestrator/server/utils/operation-deadline';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';

const unavailable = { statusCode: 503, code: 'INSTANCE_SNAPSHOT_IMAGE_CATALOG_UNAVAILABLE' };
const digest = `sha256:${'a'.repeat(64)}`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Execute both production classes, replacing only their external boundaries.
 * No live service singleton, Docker client, image operation or snapshot runs.
 * Actual catalog loading/normalization/admission and inventory code are intact. */
async function loadModule(filename: string, modules: Record<string, unknown>) {
  const source = await fs.readFile(new URL(`../../orchestrator/server/utils/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(compiled, {
    exports, structuredClone, Buffer, setTimeout, clearTimeout,
    require: (id: string) => modules[id] ?? Object.freeze({}),
  }, { timeout: 1000 });
  return exports;
}

async function fixture(beforeWrite: () => Promise<void> = async () => {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'agentor-inventory-catalog-'));
  const path = join(directory, 'image-catalog.json');
  await fs.writeFile(path, JSON.stringify({ definitions: [
    { id: 'owner-image', ownerId: 'owner', versions: [{ version: '1', digest }, { version: '2', digest: 'invalid' }] },
    { id: 'other-image', ownerId: 'other-owner', versions: [{ version: '1', digest }] },
  ], builds: [], userDefaults: {}, faults: {}, deletions: [] }));
  const catalogModule = await loadModule('image-catalog.ts', {
    'node:fs/promises': fs, 'node:crypto': crypto, 'node:path': { join },
    dockerode: class SyntheticDocker {},
    './instance-snapshot-gate': { instanceControlPlaneCoordinator: gate },
    './operation-deadline': deadlines,
  });
  let writes = 0, initCalls = 0, inventoryCalls = 0;
  const catalog = new catalogModule.ImageCatalogManager(directory, async () => {
    writes++; await beforeWrite();
  });
  const originalInit = catalog.init.bind(catalog);
  catalog.init = () => { initCalls++; return originalInit(); };
  const services = {
    useConfig: () => ({ containerPrefix: 'synthetic', dataDir: directory }),
    useStorageManager: () => ({ assertInitializedForInstanceSnapshot() {}, mode: 'bind' }),
    useWorkerStore: () => ({ hasUnavailableOwners: () => false, listUserIds: () => [], listForUser: () => [] }),
    useWorkerGroupStore: () => ({ list: () => [] }),
    usePluginDefinitionStore: () => ({ list: () => [{ userId: null }, { userId: 'owner' }] }),
    usePluginInstallationStore: () => ({ list: () => [{ id: 'installation' }] }),
    useHostMountStore: () => ({ listCatalog: () => [] }),
  };
  const managerModule = await loadModule('instance-backup-manager.ts', {
    'node:path': { join }, './services': services, './operation-deadline': deadlines,
    './instance-snapshot-gate': { instanceControlPlaneCoordinator: gate },
    './image-catalog': { useImageCatalogManager: () => catalog },
    './admin-workspace-store': { useAdminWorkspaceStore: () => ({ getRecord: () => undefined }) },
    './managed-volume-manager': { useManagedVolumeManager: () => ({
      assertInitializedForInstanceSnapshot() {}, store: { list: () => [] }, runtime: { inspectVolume: () => { throw new Error('Unexpected volume inspection'); } },
    }) },
    './worker-runtime-snapshot': { capturedWorkerImageInventory: async (_docker: unknown, workers: unknown[]) => {
      expect(workers).toEqual([]); inventoryCalls++; return [];
    } },
  });
  const manager = new managerModule.InstanceBackupManager({
    dataDir: directory, docker: { listVolumes: async () => ({ Volumes: [] }) }, store: {}, backupManager: {},
    authSnapshot: async () => { throw new Error('No snapshot is authorized by this fixture'); },
  });
  return {
    catalog, path, run: () => manager.inventory('owner'),
    counters: () => ({ writes, initCalls, inventoryCalls }),
    close: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false);
  await expect.poll(() => gate.activeOperations).toBe(0);
});

test('real initialized image catalog supplies full inventory under drained barrier without lazy init or writes', async () => {
  const f = await fixture();
  try {
    await f.catalog.init();
    const before = f.counters(), bytes = await fs.readFile(f.path, 'utf8');
    const barrier = gate.begin('image-inventory-ready', 'snapshot');
    try {
      await barrier.drain({ timeoutMs: 1000 });
      await expect(f.run()).resolves.toMatchObject({
        images: { definitions: 2, immutableDigests: [digest], capturedWorkerImages: [], layersIncluded: false },
        plugins: { platformDefinitionCount: 1, ownerDefinitionCount: 1, installationCount: 1 },
      });
      expect(f.counters()).toEqual({ ...before, inventoryCalls: 1 });
      expect(await fs.readFile(f.path, 'utf8')).toBe(bytes);
      barrier.assertDrained();
      // Read-only inventory must not confer admission on subsequent catalog work.
      await expect(f.catalog.init()).rejects.toMatchObject({ statusCode: 423 });
      expect(f.counters().writes).toBe(before.writes); barrier.assertDrained();
    } finally { barrier.release(); }
  } finally { await f.close(); }
});

for (const state of ['uninitialized', 'failed-load', 'failed-write'] as const)
  test(`real ${state} catalog rejects inventory with503 without lazy initialization or write bypass`, async () => {
    const f = await fixture(state === 'failed-write' ? async () => { throw new Error('Synthetic catalog write failure'); } : undefined);
    try {
      if (state === 'failed-load') await fs.writeFile(f.path, '{corrupt');
      if (state !== 'uninitialized') await expect(f.catalog.init()).rejects.toThrow();
      const before = f.counters(), bytes = await fs.readFile(f.path, 'utf8');
      const barrier = gate.begin(`image-inventory-${state}`, 'snapshot');
      try {
        await barrier.drain({ timeoutMs: 1000 });
        await expect(f.run()).rejects.toMatchObject(unavailable);
        expect(f.counters()).toEqual(before); expect(await fs.readFile(f.path, 'utf8')).toBe(bytes);
        barrier.assertDrained();
        await expect(f.catalog.init()).rejects.toMatchObject({ statusCode: 423 });
        expect(f.counters().writes).toBe(before.writes); barrier.assertDrained();
      } finally { barrier.release(); }
    } finally { await f.close(); }
  });

test('pending real catalog load rejects inventory until its admitted write settles and barrier drains', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture(async () => { entered.resolve(); await release.promise; await gate.run(() => {}); });
  const loading = f.catalog.init();
  try {
    await entered.promise;
    const before = f.counters(), barrier = gate.begin('image-inventory-pending', 'snapshot');
    try {
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      await expect(f.run()).rejects.toMatchObject(unavailable);
      expect(f.counters()).toEqual(before);
      release.resolve(); await loading; await barrier.drain({ timeoutMs: 1000 });
      await expect(f.run()).resolves.toMatchObject({ images: { definitions: 2, immutableDigests: [digest] } });
      expect(f.counters()).toEqual({ ...before, inventoryCalls: 1 }); barrier.assertDrained();
    } finally { release.resolve(); await loading; barrier.release(); }
  } finally { release.resolve(); await loading; await f.close(); }
});
