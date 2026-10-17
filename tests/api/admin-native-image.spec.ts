import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAdministrativeNativeBase } from '../../orchestrator/server/utils/admin-native-image';
import { readCanonicalIncusBootstrap, incusConversionRecipeId } from '../../orchestrator/server/utils/incus-image-converter';

let root: string, directory: string;
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'admin-image-bootstrap-'));
  directory = join(root, 'bootstrap');
  const { buildIncusWorkerAssets } = await import(new URL('../../orchestrator/build-incus-worker-assets.mjs', import.meta.url).href);
  await buildIncusWorkerAssets(directory);
});
test.afterAll(async () => { await rm(root, {recursive:true,force:true}); });
const source = 'sha256:'+'a'.repeat(64), fingerprint = 'b'.repeat(64);
async function fixture() {
  const recipe = incusConversionRecipeId(source, await readCanonicalIncusBootstrap(directory));
  const image: any = { type: 'virtual-machine', fingerprint, properties: { source_image_id: source, recipe_id: recipe,
    source_architecture: 'amd64', converter_version: 'v0.4.0', bootstrap_generation: '3' } };
  let calls = 0;
  const client: any = { getImageAlias: async (name: string) => { calls++; expect(name).toBe('approved'); return {name,target:fingerprint}; },
    getImage: async (id: string) => { expect(id).toBe(fingerprint); return structuredClone(image); } };
  return { image, recipe, client, calls: () => calls };
}

test('approved administrative VM base binds current configured OCI content and exact canonical bootstrap', async () => {
  const f = await fixture();
  expect(await resolveAdministrativeNativeBase({incusWorkerImage:'approved'},f.client,source,directory)).toMatchObject({
    fingerprint, sourceImageId: source, recipeId: f.recipe, converterVersion:'v0.4.0', architecture:'amd64', bootstrapGeneration:'3' });
});

for (const change of ['fingerprint','source','recipe','converter','architecture','bootstrap','type'])
  test(`approved admin base rejects ${change} drift`, async () => {
    const f = await fixture();
    if (change === 'fingerprint') f.image.fingerprint = 'c'.repeat(64);
    if (change === 'source') f.image.properties.source_image_id = 'sha256:'+'c'.repeat(64);
    if (change === 'recipe') f.image.properties.recipe_id = 'c'.repeat(64);
    if (change === 'converter') f.image.properties.converter_version = 'unknown';
    if (change === 'architecture') f.image.properties.source_architecture = 'arm64';
    if (change === 'bootstrap') f.image.properties.bootstrap_generation = '1';
    if (change === 'type') f.image.type = 'container';
    await expect(resolveAdministrativeNativeBase({incusWorkerImage:'approved'},f.client,source,directory)).rejects.toThrow();
  });

test('nonimmutable approved OCI input is rejected before native lookups', async () => {
  const f = await fixture();
  await expect(resolveAdministrativeNativeBase({incusWorkerImage:'approved'},f.client,'worker:latest',directory)).rejects.toThrow('OCI source identity');
  expect(f.calls()).toBe(0);
});
