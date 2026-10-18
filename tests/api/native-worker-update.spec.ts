import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promoteNativeWorkerUpdate, nativeWorkerUpdateStatus } from '../../orchestrator/server/utils/native-worker-update';
import { UpdateChecker } from '../../orchestrator/server/utils/update-checker';
import { IncusClient, type IncusImageAlias } from '../../orchestrator/server/utils/incus-client';
import { ImageCatalogCore, type NativeImageContext } from '../../orchestrator/server/utils/image-catalog-core';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { incusConversionRecipeId, readCanonicalIncusBootstrap } from '../../orchestrator/server/utils/incus-image-converter';
import type { Config } from '../../orchestrator/server/utils/config';

const sourceId = 'sha256:' + 'a'.repeat(64), oldId = 'sha256:' + 'b'.repeat(64), remote = 'sha256:' + 'c'.repeat(64);
const fingerprint = 'd'.repeat(64), previousFingerprint = 'e'.repeat(64);
const noOp = async () => {};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-worker-update-')), assets = join(root, 'assets');
  execFileSync(process.execPath, ['../orchestrator/build-incus-worker-assets.mjs', assets]);
  const config = { incusEnabled: true, dataDir: root, workerImagePrefix: 'registry.fixture/agentor/', workerImage: 'worker:latest',
    baseDomains: [], incusWorkerImage: 'approved-default', incusConverterSeedFingerprint: 'f'.repeat(64),
    incusNetwork: 'workers', incusStoragePool: 'workers' } as unknown as Config;
  const catalog = new ImageCatalogCore(join(root, 'catalog'));
  const client = new IncusClient({ endpoint: 'http://127.0.0.1:1', project: 'test-private' });
  const files = await readCanonicalIncusBootstrap(assets);
  const context: NativeImageContext = { installationId: await backupInstallationId(root), project: client.project,
    seedFingerprint: config.incusConverterSeedFingerprint!, sourceImageId: sourceId,
    recipeId: incusConversionRecipeId(sourceId, files), architecture: 'amd64', bootstrapGeneration: '3', converterVersion: 'v0.4.0', diskSize: '10G' };
  const identity = { version: 1 as const, fingerprint, sourceImageId: sourceId, recipeId: context.recipeId,
    architecture: 'amd64' as const, bootstrapGeneration: '3' as const, converterVersion: 'v0.4.0' };
  const source = await catalog.authorizePlatformDefaultImageSource(sourceId, noOp);
  let imports = 0;
  await catalog.ensureNativeImageBinding(source, context, noOp, async id => {
    imports++;
    await catalog.acknowledgeNativeConverter(id, { version: 1, name: 'aic-' + id, installationId: context.installationId,
      ownerId: source.requesterId, sourceImageId: sourceId, seedFingerprint: context.seedFingerprint, project: context.project,
      recipeId: context.recipeId, incarnation: randomUUID(), removed: true });
    await catalog.acknowledgeNativeImageImport(id, { pending: true }, noOp);
    await catalog.acknowledgeNativeImageImport(id, { pending: false, fingerprint }, noOp);
    await catalog.publishNativeImageBinding(id, identity, 'agentor-storage-ownership-v1', noOp);
  });
  const events: string[] = [];
  let configuredId = oldId, aliasTarget = previousFingerprint, stagedInspections = 0;
  let candidateDrift = false, unsupportedArchitecture = false;
  let failAlias = false, failTag = false, lostTagResponse = false, revoked = false, recipeDrift = false;
  const docker = { getImage: (reference: string) => ({
    inspect: async () => {
      const configured = reference === config.workerImagePrefix + config.workerImage;
      if (!configured) stagedInspections++;
      return { Id: configured ? configuredId : candidateDrift && stagedInspections > 1 ? oldId : sourceId,
        Architecture: unsupportedArchitecture ? 'arm64' : 'amd64' };
    },
    tag: async (input: { repo: string; tag: string }) => {
      events.push('tag'); expect(aliasTarget).toBe(fingerprint);
      expect(input).toEqual({ repo: 'registry.fixture/agentor/worker', tag: 'latest' });
      if (failTag) throw new Error('Tag unavailable'); configuredId = sourceId;
      if (lostTagResponse) throw new Error('Tag acknowledgement lost');
    },
  }) } as unknown as Parameters<typeof promoteNativeWorkerUpdate>[2];
  client.getImageAlias = async () => ({ name: config.incusWorkerImage, target: aliasTarget, description: 'Approved base', type: 'virtual-machine' });
  client.getImage = async requested => {
    if (requested === previousFingerprint) return { fingerprint: previousFingerprint, architecture: 'x86_64', type: 'virtual-machine', size: 1,
      aliases: [], properties: { source_image_id: oldId, recipe_id: incusConversionRecipeId(oldId, files), source_architecture: 'amd64', bootstrap_generation: '3', converter_version: 'v0.4.0' } };
    expect(requested).toBe(fingerprint); return {
    fingerprint, architecture: 'x86_64', type: 'virtual-machine', size: 1, aliases: [], properties: {
      source_image_id: sourceId, recipe_id: recipeDrift ? '0'.repeat(64) : context.recipeId,
      source_architecture: 'amd64', bootstrap_generation: '3', converter_version: 'v0.4.0',
    },
  }; };
  client.promoteImageAlias = async (_name, expected, target) => {
    expect(target).toBe(fingerprint); expect(configuredId).toBe(oldId);
    expect(expected.target).toBe(aliasTarget);
    if (failAlias) throw new Error('Alias unavailable');
    if (aliasTarget !== fingerprint) events.push('alias'); aliasTarget = target;
  };
  const validate = async () => { if (revoked) throw new Error('Administrator revoked'); };
  const run = () => promoteNativeWorkerUpdate(config, remote, docker, client, catalog, async reference => {
    events.push('pull'); expect(reference).toBe('registry.fixture/agentor/worker@' + remote);
    expect(configuredId).toBe(oldId);
  }, validate, assets);
  return { root, config, catalog, context, source, identity, client, events, run, validate,
    imports: () => imports, state: () => ({ configuredId, aliasTarget }),
    loseTagResponse: () => { lostTagResponse = true; }, failAlias: (value: boolean) => { failAlias = value; }, failTag: (value: boolean) => { failTag = value; },
    revoke: () => { revoked = true; }, drift: () => { recipeDrift = true; }, sourceDrift: () => { candidateDrift = true; }, unsupportedArchitecture: () => { unsupportedArchitecture = true; },
    cleanup: async () => { client.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test('worker Apply stages an immutable OCI, reuses settled native receipts, then publishes alias before Docker tag', async () => {
  const f = await fixture(); try {
    await f.run(); expect(f.events).toEqual(['pull', 'alias', 'tag']);
    expect(f.state()).toEqual({ configuredId: sourceId, aliasTarget: fingerprint }); expect(f.imports()).toBe(1);
    // Source remains exact upstream OCI, not a fabricated catalog build.
    const cold = new ImageCatalogCore(join(f.root, 'catalog'));
    expect(await cold.authorizePlatformDefaultImageSource(sourceId, f.validate)).toEqual(f.source);
    expect(await cold.readNativeImageBinding(f.source, f.context, f.validate)).toMatchObject({ identity: f.identity });
    expect(cold.list('operator', true)).toEqual([]);
  } finally { await f.cleanup(); }
});

test('lost Docker tag acknowledgement is observed positively without repeating the mutation', async () => {
  const f = await fixture(); try {
    f.loseTagResponse(); await f.run();
    expect(f.state()).toEqual({ configuredId: sourceId, aliasTarget: fingerprint });
    expect(f.events).toEqual(['pull', 'alias', 'tag']);
  } finally { await f.cleanup(); }
});

test('conversion failure keeps both old defaults and never publishes a tag or alias', async () => {
  const f = await fixture(); try {
    f.catalog.ensureNativeImageBinding = async () => { throw new Error('Conversion failed; receipts retained'); };
    await expect(f.run()).rejects.toThrow('Conversion failed');
    expect(f.state()).toEqual({ configuredId: oldId, aliasTarget: previousFingerprint });
    expect(f.events).toEqual(['pull']);
  } finally { await f.cleanup(); }
});

test('failed alias publication preserves the prior Docker default and explicit Apply reuses the settled conversion', async () => {
  const f = await fixture(); try {
    f.failAlias(true); await expect(f.run()).rejects.toThrow('Alias unavailable');
    expect(f.state()).toEqual({ configuredId: oldId, aliasTarget: previousFingerprint }); expect(f.events).toEqual(['pull']);
    f.failAlias(false); await f.run(); expect(f.imports()).toBe(1); expect(f.events).toEqual(['pull', 'pull', 'alias', 'tag']);
  } finally { await f.cleanup(); }
});

test('failed tag publication remains retryable with the already-promoted exact alias and no reconversion', async () => {
  const f = await fixture(); try {
    f.failTag(true); await expect(f.run()).rejects.toThrow('Tag unavailable');
    expect(f.state()).toEqual({ configuredId: oldId, aliasTarget: fingerprint });
    f.failTag(false); await f.run(); expect(f.imports()).toBe(1);
    expect(f.events).toEqual(['pull', 'alias', 'tag', 'pull', 'tag']);
  } finally { await f.cleanup(); }
});

for (const scenario of ['revoked', 'revoked-after-native-read', 'recipe', 'digest-config', 'seed-config', 'source-drift', 'unsupported-architecture'] as const) test(`native Apply refuses ${scenario} before default mutation`, async () => {
  const f = await fixture(); try {
    if (scenario === 'revoked') f.revoke();
    if (scenario === 'revoked-after-native-read') {
      const original = f.client.getImage.bind(f.client);
      f.client.getImage = async value => { const image = await original(value); f.revoke(); return image; };
    }
    if (scenario === 'recipe') f.drift();
    if (scenario === 'digest-config') f.config.workerImage = 'worker@' + sourceId;
    if (scenario === 'seed-config') f.config.incusConverterSeedFingerprint = '';
    if (scenario === 'source-drift') f.sourceDrift();
    if (scenario === 'unsupported-architecture') f.unsupportedArchitecture();
    await expect(f.run()).rejects.toThrow();
    expect(f.state()).toEqual({ configuredId: oldId, aliasTarget: previousFingerprint });
    expect(f.events).not.toContain('alias'); expect(f.events).not.toContain('tag');
  } finally { await f.cleanup(); }
});

test('upstream platform acknowledgement never grants a custom selector, forged source or revoked publisher', async () => {
  const f = await fixture(); try {
    await expect(f.catalog.authorizeNativeImageSource('ordinary', {}, f.validate)).rejects.toThrow('authorized controlled');
    await expect(f.catalog.readNativeImageBinding({ ...f.source, requesterId: 'ordinary' }, f.context, f.validate)).rejects.toThrow('malformed');
    f.revoke(); await expect(f.catalog.readNativeImageBinding(f.source, f.context, f.validate)).rejects.toThrow('revoked');
    await expect(f.catalog.authorizePlatformDefaultImageSource(oldId, f.validate)).rejects.toThrow('revoked');
  } finally { await f.cleanup(); }
});

test('pending upstream converter authority survives reload and blocks a different source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-update-pending-'));
  try {
    const catalog = new ImageCatalogCore(root), source = await catalog.authorizePlatformDefaultImageSource(sourceId, noOp);
    const context: NativeImageContext = { installationId: randomUUID(), project: 'test-private', seedFingerprint: 'f'.repeat(64),
      sourceImageId: sourceId, recipeId: 'd'.repeat(64), architecture: 'amd64', bootstrapGeneration: '3', converterVersion: 'v0.4.0', diskSize: '10G' };
    const id = await catalog.openNativeImageDerivation(source, context, noOp);
    await catalog.acknowledgeNativeConverter(id, { version: 1, name: 'aic-' + id, installationId: context.installationId,
      ownerId: source.requesterId, sourceImageId: sourceId, seedFingerprint: context.seedFingerprint, project: context.project,
      recipeId: context.recipeId, pending: { kind: 'create' } });
    const cold = new ImageCatalogCore(root);
    await expect(cold.authorizePlatformDefaultImageSource(oldId, noOp)).rejects.toThrow('unsettled');
    expect(cold.build(id, 'admin', true)).toMatchObject({ status: 'failed', recovery: 'restart-failed-safe' });
    expect((await readFile(join(root, 'image-catalog.json'), 'utf8'))).toContain('aic-' + id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed durable platform acknowledgement is rolled back rather than granting conversion authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-update-write-')); let fail = false;
  try {
    const catalog = new ImageCatalogCore(root, async state => {
      if (fail) throw new Error('Disk unavailable');
      await writeFile(join(root, 'state'), JSON.stringify(state));
    });
    const source = await catalog.authorizePlatformDefaultImageSource(sourceId, noOp);
    fail = true; await expect(catalog.authorizePlatformDefaultImageSource(oldId, noOp)).rejects.toThrow('Disk unavailable');
    fail = false; expect(await catalog.authorizePlatformDefaultImageSource(sourceId, noOp)).toEqual(source);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['success', 'lost-response', 'conflict', 'unobserved', 'already-published', 'drift', 'no-etag'] as const) test(`alias CAS listener: ${mode}`, async () => {
  let target = mode === 'already-published' ? fingerprint : mode === 'drift' ? '0'.repeat(64) : previousFingerprint, puts = 0;
  const expected: IncusImageAlias = { name: 'approved', target: previousFingerprint, description: 'Approved base', type: 'virtual-machine' };
  const server = createServer(async (req, res) => {
    expect(new URL(req.url!, 'http://fixture').searchParams.get('project')).toBe('fixture-private');
    if (req.method === 'GET') { if (mode !== 'no-etag') res.setHeader('ETag', '"observed"'); res.end(JSON.stringify({ type: 'sync', metadata: { ...expected, target } })); return; }
    puts++; expect(req.method).toBe('PUT'); expect(req.headers['if-match']).toBe('"observed"');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ target: fingerprint, description: expected.description });
    if (mode === 'conflict') { res.statusCode = 412; res.end(JSON.stringify({ type: 'error', error: 'ETag conflict' })); return; }
    if (mode !== 'unobserved') target = fingerprint;
    if (mode === 'lost-response') { req.socket.destroy(); return; }
    res.end(JSON.stringify({ type: 'sync', metadata: {} }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, client = new IncusClient({ endpoint: `http://127.0.0.1:${port}`, project: 'fixture-private' });
  try {
    const work = client.promoteImageAlias('approved', expected, fingerprint);
    if (mode === 'conflict' || mode === 'unobserved' || mode === 'drift' || mode === 'no-etag') await expect(work).rejects.toThrow(); else await work;
    expect(puts).toBe(['already-published', 'drift', 'no-etag'].includes(mode) ? 0 : 1);
  } finally { client.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('concurrent Apply calls share one worker mutation; failures settle and permit a later explicit retry', async () => {
  const checker = new UpdateChecker({ workerImagePrefix: 'registry/', workerImage: 'worker:latest', baseDomains: [], incusEnabled: false } as unknown as Config);
  const internal = checker as unknown as { status: { worker: { updateAvailable: boolean } }; pullImage: (name: string) => Promise<void> };
  internal.status.worker = { updateAvailable: true };
  let release!: () => void, calls = 0, fail = false;
  internal.pullImage = async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); if (fail) throw new Error('Pull failed'); };
  const first = checker.applyUpdates(['worker']), second = checker.applyUpdates(['worker']);
  expect(calls).toBe(1); release(); expect((await first).workerPulled).toBe(true); expect((await second).workerPulled).toBe(true);
  fail = true; const third = checker.applyUpdates(['worker']); release(); expect((await third).errors.join()).toContain('Pull failed');
  fail = false; const fourth = checker.applyUpdates(['worker']); release(); expect((await fourth).workerPulled).toBe(true); expect(calls).toBe(3);
});

test('native concurrent Apply shares promotion while every joining caller retains fresh administrator checks', async () => {
  const checker = new UpdateChecker({ workerImagePrefix: 'registry/', workerImage: 'worker:latest', baseDomains: [], incusEnabled: true } as unknown as Config);
  const internal = checker as unknown as { status: { worker: { updateAvailable: boolean } }; updateWorkerImage: (validate: () => Promise<void>) => Promise<void> };
  internal.status.worker = { updateAvailable: true };
  let release!: () => void, calls = 0, revoked = false;
  internal.updateWorkerImage = async validate => { calls++; await new Promise<void>(resolve => { release = resolve; }); await validate(); };
  const allowed = noOp, conditional = async () => { if (revoked) throw new Error('Joining administrator revoked'); };
  const first = checker.applyUpdates(['worker'], allowed), second = checker.applyUpdates(['worker'], conditional);
  await Promise.resolve(); expect(calls).toBe(1);
  revoked = true; release(); expect((await first).workerPulled).toBe(true);
  expect((await second).errors.join()).toContain('Joining administrator revoked'); expect(calls).toBe(1);
  expect((await checker.applyUpdates(['worker'])).errors.join()).toContain('current platform administrator'); expect(calls).toBe(1);
});

for (const scenario of ['ready', 'new-bootstrap', 'wrong-source'] as const) test(`native readiness remains actionable with an unchanged OCI tag: ${scenario}`, async () => {
  const f = await fixture(); try {
    const original = f.client.getImage.bind(f.client);
    f.client.getImageAlias = async () => ({ name: 'approved', target: fingerprint, type: 'virtual-machine', description: '' });
    f.client.getImage = async value => { const image = await original(value);
      return scenario === 'new-bootstrap' ? { ...image, properties: { ...image.properties, recipe_id: '0'.repeat(64) } }
        : scenario === 'wrong-source' ? { ...image, properties: { ...image.properties, source_image_id: oldId } } : image;
    };
    const info = { name: 'worker', localDigest: remote, remoteDigest: remote, updateAvailable: false, lastChecked: new Date().toISOString() };
    const docker = { getImage: () => ({ inspect: async () => ({ Id: sourceId, Architecture: 'amd64' }) }) } as unknown as Parameters<typeof nativeWorkerUpdateStatus>[2];
    const result = await nativeWorkerUpdateStatus(f.config, info, docker, f.client, join(f.root, 'assets'));
    expect(result.updateAvailable).toBe(scenario !== 'ready'); expect(result.nativeUpdateRequired).toBe(scenario !== 'ready');
  } finally { await f.cleanup(); }
});

test('Apply All defers native worker preparation until the updated orchestrator owns the bootstrap', async () => {
  const checker = new UpdateChecker({ workerImagePrefix: 'registry/', workerImage: 'worker:latest', orchestratorImage: 'orchestrator:latest', baseDomains: [], incusEnabled: true } as unknown as Config);
  const internal = checker as unknown as { status: { worker: { updateAvailable: boolean }; orchestrator: { updateAvailable: boolean } };
    updateWorkerImage: () => Promise<void>; pullImage: (name: string) => Promise<void> };
  internal.status.worker = { updateAvailable: true }; internal.status.orchestrator = { updateAvailable: true };
  const calls: string[] = [];
  internal.updateWorkerImage = async () => { calls.push('native'); }; internal.pullImage = async reference => { calls.push(reference); };
  const result = await checker.applyUpdates(undefined, noOp);
  expect(result).toMatchObject({ workerDeferred: true, workerPulled: false, orchestratorPulled: true });
  expect(calls).toEqual(['registry/orchestrator:latest']);
  internal.status.orchestrator.updateAvailable = false;
  const next = await checker.applyUpdates(['worker'], noOp); expect(next.workerPulled).toBe(true); expect(calls).toEqual(['registry/orchestrator:latest', 'native']);
});
