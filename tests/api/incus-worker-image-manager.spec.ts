import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IncusClient, IncusError, type IncusImage } from '../../orchestrator/server/utils/incus-client';
import { IncusWorkerImageManager } from '../../orchestrator/server/utils/incus-worker-image-manager';
import { type ImageCatalogManager, type NativeImageContext } from '../../orchestrator/server/utils/image-catalog';
import { incusConversionRecipeId, readCanonicalIncusBootstrap } from '../../orchestrator/server/utils/incus-image-converter';

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

test('regeneration requires repeated typed native absence, never transport or lookalike errors', async () => {
  for (const scenario of ['missing', 'transport', 'lookalike', 'reappeared'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'agentor-image-cache-missing-'));
    const assets = join(root, 'assets');
    await promisify(execFile)('node', ['../orchestrator/build-incus-worker-assets.mjs', assets]);
    const sourceImageId = 'sha256:' + 'a'.repeat(64), fingerprint = 'b'.repeat(64);
    const client = new IncusClient({ endpoint: 'https://fixture.invalid', project: 'agentor-private' });
    let queries = 0, evictions = 0, ensures = 0, absent = true, recipe = '';
    const catalog = {
      authorizeNativeImageSource: async () => ({ sourceImageId }),
      ensureNativeImageBinding: async (_source: unknown, context: NativeImageContext, current: () => Promise<void>) => {
        await current(); ensures++; recipe = context.recipeId;
        return { context, buildId: randomUUID(), capability: 'agentor-storage-ownership-v1',
          identity: { version: 1, sourceImageId, recipeId: recipe, architecture: 'amd64',
            converterVersion: 'v0.4.0', bootstrapGeneration: '3', fingerprint } };
      },
      forgetMissingNativeImageBinding: async (_source: unknown, _binding: unknown, current: () => Promise<void>,
        verify: (value: string) => Promise<void>) => {
        await current(); await verify(fingerprint); evictions++; absent = false;
      },
    } as unknown as ImageCatalogManager;
    client.getImage = async value => {
      expect(value).toBe(fingerprint); queries++;
      if (scenario === 'transport') throw new IncusError('Incus unavailable', 503);
      if (scenario === 'lookalike') throw Object.assign(new Error('Unknown transport'), { statusCode: 404 });
      if (scenario === 'reappeared' && queries > 1) absent = false;
      if (absent) throw new IncusError('Image not found', 404);
      return { fingerprint, type: 'virtual-machine', architecture: 'x86_64', size: 1, aliases: [], properties: {
        source_image_id: sourceImageId, recipe_id: recipe, source_architecture: 'amd64',
        bootstrap_generation: '3', converter_version: 'v0.4.0',
      } } satisfies IncusImage;
    };
    const manager = new IncusWorkerImageManager({ dataDir: root, incusNetwork: 'workers', incusStoragePool: 'workers' },
      client, { getImage: () => { throw new Error('This cache test must not export'); } }, catalog, assets, 'c'.repeat(64));
    try {
      const result = manager.ensure('owner', {}, async () => {});
      if (scenario === 'missing') {
        expect((await result).identity.fingerprint).toBe(fingerprint);
        expect(queries).toBe(3); expect(evictions).toBe(1); expect(ensures).toBe(2);
      } else {
        await expect(result).rejects.toThrow();
        expect(evictions).toBe(0); expect(ensures).toBe(1);
        expect(queries).toBe(scenario === 'reappeared' ? 2 : 1);
      }
    } finally { client.dispose(); await rm(root, { recursive: true, force: true }); }
  }
});

for (const scenario of ['source-mismatch', 'unsupported', 'older', 'current', 'no-binding', 'missing',
  'transport', 'lookalike', 'reappeared', 'revoked', 'binding-drift', 'image-drift', 'unknown-ack'] as const)
test(`descriptive restore source preserves current authorization and private historical authority: ${scenario}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-image-restore-source-')), assets = join(root, 'assets');
  await promisify(execFile)('node', ['../orchestrator/build-incus-worker-assets.mjs', assets]);
  const sourceImageId = 'sha256:' + 'a'.repeat(64), oldFingerprint = 'b'.repeat(64), currentFingerprint = 'e'.repeat(64);
  const client = new IncusClient({ endpoint: 'https://fixture.invalid', project: 'agentor-private' });
  const currentRecipe = incusConversionRecipeId(sourceImageId, await readCanonicalIncusBootstrap(assets));
  const descriptor = { sourceImageId: scenario === 'source-mismatch' ? 'sha256:' + 'f'.repeat(64) : sourceImageId,
    recipeId: scenario === 'current' ? currentRecipe : 'd'.repeat(64), architecture: 'amd64' as const,
    bootstrapGeneration: '3' as const, converterVersion: scenario === 'unsupported' ? 'v0.3.0' : 'v0.4.0' };
  let revoked = false, reads = 0, oldQueries = 0, currentEnsures = 0;
  const validate = async () => { if (revoked) throw new Error('Current source permission revoked'); };
  const buildId = randomUUID(), currentBuildId = randomUUID();
  const binding = (context: NativeImageContext, historical = true) => ({ context,
    buildId: historical ? buildId : currentBuildId, capability: 'agentor-storage-ownership-v1' as const,
    identity: { version: 1 as const, sourceImageId, recipeId: context.recipeId, architecture: 'amd64' as const,
      converterVersion: 'v0.4.0', bootstrapGeneration: '3', fingerprint: historical ? oldFingerprint : currentFingerprint } });
  const catalog = {
    authorizeNativeImageSource: async (_owner: string, _selection: unknown, current: () => Promise<void>) => {
      await current(); return { sourceImageId };
    },
    readNativeImageBinding: async (_source: unknown, context: NativeImageContext, current: () => Promise<void>) => {
      await current(); reads++;
      expect(context).toMatchObject({ project: client.project, seedFingerprint: 'c'.repeat(64), sourceImageId,
        recipeId: descriptor.recipeId, bootstrapGeneration: '3', converterVersion: 'v0.4.0' });
      if (scenario === 'unknown-ack') throw new Error('Native cache hint lacks exact settled import acknowledgement');
      if (scenario === 'no-binding') return undefined;
      const result = binding(context);
      return scenario === 'binding-drift' && reads > 1 ? { ...result, buildId: randomUUID() } : result;
    },
    ensureNativeImageBinding: async (_source: unknown, context: NativeImageContext, current: () => Promise<void>) => {
      await current(); currentEnsures++; expect(context.recipeId).toBe(currentRecipe); return binding(context, false);
    },
  } as unknown as ImageCatalogManager;
  client.getImage = async fingerprint => {
    const historical = fingerprint === oldFingerprint;
    expect([oldFingerprint, currentFingerprint]).toContain(fingerprint);
    if (historical) {
      oldQueries++;
      if (scenario === 'transport') throw new IncusError('Incus unavailable', 503);
      if (scenario === 'lookalike') throw Object.assign(new Error('Transport uncertainty'), { statusCode: 404 });
      if (scenario === 'missing' || scenario === 'reappeared' && oldQueries === 1) throw new IncusError('Image missing', 404);
      if (scenario === 'revoked') revoked = true;
    }
    return { fingerprint, type: 'virtual-machine', architecture: 'x86_64', size: 1, aliases: [], properties: {
      source_image_id: scenario === 'image-drift' ? 'sha256:' + 'f'.repeat(64) : sourceImageId,
      recipe_id: historical ? descriptor.recipeId : currentRecipe, source_architecture: 'amd64',
      bootstrap_generation: '3', converter_version: 'v0.4.0',
    } } satisfies IncusImage;
  };
  const manager = new IncusWorkerImageManager({ dataDir: root, incusNetwork: 'workers', incusStoragePool: 'workers' },
    client, { getImage: () => { throw new Error('Restore cache test must not export or allocate'); } }, catalog, assets, 'c'.repeat(64));
  try {
    const result = manager.ensure('owner', {}, validate, undefined, descriptor);
    if (['older', 'current', 'no-binding', 'missing'].includes(scenario)) {
      expect((await result).identity.fingerprint).toBe(scenario === 'older' ? oldFingerprint : currentFingerprint);
      expect(currentEnsures).toBe(scenario === 'older' ? 0 : 1);
      expect(oldQueries).toBe(scenario === 'missing' ? 2 : scenario === 'older' ? 1 : 0);
      if (scenario === 'older') expect(reads).toBe(2);
    } else {
      await expect(result).rejects.toThrow(); expect(currentEnsures).toBe(0);
      if (scenario === 'source-mismatch' || scenario === 'unsupported') { expect(reads).toBe(0); expect(oldQueries).toBe(0); }
    }
  } finally { client.dispose(); await rm(root, { recursive: true, force: true }); }
});
