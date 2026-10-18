import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ImageCatalogCore } from '../../orchestrator/server/utils/image-catalog-core';
import { resolveDefaultIncusImage } from '../../orchestrator/server/utils/incus-default-image';
import { incusConversionRecipeId, readCanonicalIncusBootstrap } from '../../orchestrator/server/utils/incus-image-converter';
import { incusImageIdentity, type IncusWorkerImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';
import { snapshotIncusWorkerBackupRuntime } from '../../orchestrator/server/utils/worker-backup-runtime';
import { IncusWorkerImageManager } from '../../orchestrator/server/utils/incus-worker-image-manager';
import type { Config } from '../../orchestrator/server/utils/config';
import type { IncusClient } from '../../orchestrator/server/utils/incus-client';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'approved-default-history-')), assets = join(root, 'assets');
  execFileSync(process.execPath, ['../orchestrator/build-incus-worker-assets.mjs', assets]);
  const files = await readCanonicalIncusBootstrap(assets), catalog = new ImageCatalogCore(join(root, 'catalog'));
  const raw = (source: string, fingerprint: string, recipe = incusConversionRecipeId(source, files)) => ({ fingerprint,
    type: 'virtual-machine' as const, architecture: 'x86_64', size: 1, aliases: [], properties: { source_image_id: source,
      recipe_id: recipe, source_architecture: 'amd64', bootstrap_generation: '3', converter_version: 'v0.4.0' } });
  const old = raw('sha256:' + 'a'.repeat(64), 'b'.repeat(64)), next = raw('sha256:' + 'c'.repeat(64), 'd'.repeat(64));
  const config = { dataDir: root, workerImagePrefix: 'registry.fixture/', workerImage: 'worker:latest', incusWorkerImage: 'approved',
    incusStoragePool: 'workers', incusNetwork: 'workers', incusConverterSeedFingerprint: 'e'.repeat(64) } as unknown as Config;
  let available = [old, next], revoked = false, reads = 0;
  const client = { project: 'fixture-private', getImageAlias: async () => ({ target: next.fingerprint, type: next.type }),
    getImage: async (fingerprint: string) => { const image = available.find(value => value.fingerprint === fingerprint); if (!image) throw Object.assign(new Error('Not found'), { statusCode: 404 }); return image; },
    listImages: async () => available,
  } as unknown as IncusClient;
  const docker = { getImage: () => ({ inspect: async () => { reads++; return { Id: next.properties.source_image_id, Architecture: 'amd64' }; } }) } as unknown as Parameters<typeof resolveDefaultIncusImage>[2];
  const validate = async () => { if (revoked) throw new Error('Current authority revoked'); };
  const resolve = (stored?: IncusWorkerImageIdentity, restore = false, refresh = false) => resolveDefaultIncusImage(config, client,
    docker, catalog, assets, validate, restore ? undefined : stored,
    restore && stored ? snapshotIncusWorkerBackupRuntime(stored).source : undefined, refresh);
  return { root, assets, catalog, config, client, old, next, validate, resolve, raw,
    setImages: (value: typeof available) => { available = value; }, revoke: () => { revoked = true; }, reads: () => reads,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('exact old-default history permits original OCI rebuild and backup restore after default promotion', async () => {
  const f = await fixture(); try {
    const identity = incusImageIdentity(f.old); await f.catalog.rememberApprovedDefaultImage(identity, f.validate);
    expect(await f.resolve(identity, false, true)).toEqual(identity);
    expect(await f.resolve(identity, true)).toEqual(identity);
    expect(f.reads()).toBe(0); // Historical permission does not come from current alias B or its Docker image.
    const cold = new ImageCatalogCore(join(f.root, 'catalog'));
    expect(await cold.hasApprovedDefaultImage(identity, f.validate)).toBe(true);
    expect(await cold.hasApprovedDefaultImage({ ...identity, recipeId: '0'.repeat(64) }, f.validate)).toBe(false);
  } finally { await f.cleanup(); }
});

test('a cached foreign OCI or portable source descriptor alone cannot become a historical default', async () => {
  const f = await fixture(); try {
    const identity = incusImageIdentity(f.old);
    await expect(f.resolve(identity, true)).rejects.toThrow('no current or historical default approval');
    expect(await f.catalog.hasApprovedDefaultImage(identity, f.validate)).toBe(false);
    expect((await f.resolve()).sourceImageId).toBe(f.next.properties.source_image_id);
  } finally { await f.cleanup(); }
});

test('historical default rebuild refreshes only the original OCI with current bootstrap through the existing converter seam', async () => {
  const f = await fixture(), original = IncusWorkerImageManager.prototype.ensurePlatformDefault;
  try {
    const old = incusImageIdentity({ ...f.old, properties: { ...f.old.properties, recipe_id: '0'.repeat(64) } });
    await f.catalog.rememberApprovedDefaultImage(old, f.validate);
    f.setImages([f.next]); let calls = 0;
    IncusWorkerImageManager.prototype.ensurePlatformDefault = async (source, current) => {
      calls++; expect(source).toBe(old.sourceImageId); await current();
      return { identity: incusImageIdentity(f.old), context: { project: f.client.project }, buildId: randomUUID(), capability: 'agentor-storage-ownership-v1' } as any;
    };
    expect(await f.resolve(old, false, true)).toEqual(incusImageIdentity(f.old)); expect(calls).toBe(1);
    expect(await f.catalog.hasApprovedDefaultImage(incusImageIdentity(f.old), f.validate)).toBe(true);
    await expect(f.resolve(old)).rejects.toThrow('unavailable'); expect(calls).toBe(1); // Ordinary reconstruction keeps the captured recipe.
  } finally { IncusWorkerImageManager.prototype.ensurePlatformDefault = original; await f.cleanup(); }
});

test('rebuild and restore recheck current authority and refuse a converter that changes the historical OCI', async () => {
  const f = await fixture(), original = IncusWorkerImageManager.prototype.ensurePlatformDefault;
  try {
    const old = incusImageIdentity({ ...f.old, properties: { ...f.old.properties, recipe_id: '0'.repeat(64) } });
    await f.catalog.rememberApprovedDefaultImage(old, f.validate); f.setImages([f.next]);
    IncusWorkerImageManager.prototype.ensurePlatformDefault = async () => ({ identity: incusImageIdentity(f.next) } as any);
    await expect(f.resolve(old, false, true)).rejects.toThrow('changed the immutable OCI');
    f.revoke(); await expect(f.resolve(old, true)).rejects.toThrow('revoked');
  } finally { IncusWorkerImageManager.prototype.ensurePlatformDefault = original; await f.cleanup(); }
});
