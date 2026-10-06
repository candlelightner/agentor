import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IncusClient, type IncusImage } from '../../orchestrator/server/utils/incus-client';
import { IncusWorkerImageManager } from '../../orchestrator/server/utils/incus-worker-image-manager';
import { type ImageCatalogManager, type NativeImageContext } from '../../orchestrator/server/utils/image-catalog';

test('private cache remains exact-project/exact-fingerprint and freshly authorized, never a property-based substitute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-image-manager-'));
  const assets = join(root, 'assets');
  await promisify(execFile)('node', ['../orchestrator/build-incus-worker-assets.mjs', assets]);
  let revoked = false, drift = false, queries = 0;
  const sourceImageId = 'sha256:' + 'a'.repeat(64), fingerprint = 'b'.repeat(64), seed = 'c'.repeat(64);
  const client = new IncusClient({ endpoint: 'https://fixture.invalid', project: 'agentor-private' });
  const validate = async () => { if (revoked) throw new Error('Current source permission revoked'); };
  const catalog = {
    authorizeNativeImageSource: async (_owner: string, _selection: unknown, current: () => Promise<void>) => {
      await current(); return { sourceImageId };
    },
    ensureNativeImageBinding: async (_source: unknown, context: NativeImageContext, current: () => Promise<void>) => {
      await current();
      return { context, buildId: randomUUID(), capability: 'agentor-storage-ownership-v1',
        identity: { version: 1, sourceImageId, recipeId: context.recipeId, architecture: 'amd64',
          converterVersion: 'v0.4.0', bootstrapGeneration: '3', fingerprint } };
    },
  } as unknown as ImageCatalogManager;
  const docker = { getImage: () => { throw new Error('Cached binding must not allocate/export/convert'); } };
  const manager = new IncusWorkerImageManager({ dataDir: root, incusNetwork: 'workers', incusStoragePool: 'workers' },
    client, docker, catalog, assets, seed);
  // Capture parent recipe from its private context; not a guest claim.
  let recipe = '';
  const originalEnsure = catalog.ensureNativeImageBinding.bind(catalog);
  catalog.ensureNativeImageBinding = async (...args) => {
    recipe = args[1].recipeId; return originalEnsure(...args);
  };
  client.getImage = async value => {
    queries++; expect(value).toBe(fingerprint);
    if (queries === 3) revoked = true;
    return { fingerprint: drift ? 'd'.repeat(64) : fingerprint, type: 'virtual-machine',
      architecture: 'x86_64', size: 1, aliases: [], properties: {
      source_image_id: sourceImageId, recipe_id: recipe, source_architecture: 'amd64',
      bootstrap_generation: '3', converter_version: 'v0.4.0',
    } } satisfies IncusImage;
  };
  try {
    expect((await manager.ensure('owner', { definitionId: randomUUID(), version: 'v1' }, validate)).identity.fingerprint).toBe(fingerprint);
    drift = true; await expect(manager.ensure('owner', {}, validate)).rejects.toThrow('cache image changed');
    drift = false; await expect(manager.ensure('owner', {}, validate)).rejects.toThrow('permission revoked');
    const before = queries;
    await expect(manager.ensure('owner', {}, validate)).rejects.toThrow('permission revoked'); expect(queries).toBe(before);
    const controller = new AbortController(); controller.abort(new Error('Cancelled before conversion'));
    await expect(manager.ensure('owner', {}, async () => {}, controller.signal)).rejects.toThrow('Cancelled before conversion');
    expect(queries).toBe(before);
    const invalid = new IncusWorkerImageManager({ dataDir: root, incusNetwork: 'workers', incusStoragePool: 'workers' },
      client, docker, catalog, assets, 'mutable-alias');
    await expect(invalid.ensure('owner', {}, async () => {})).rejects.toThrow('operator-pinned');
  } finally { client.dispose(); await rm(root, { recursive: true, force: true }); }
});
