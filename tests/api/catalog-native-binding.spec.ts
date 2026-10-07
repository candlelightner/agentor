import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ImageCatalogManager, type ImageDefinition, type ImageBuild, type NativeImageContext,
  type NativeImageSource } from '../../orchestrator/server/utils/image-catalog';
import type { IncusImageConverterReceipt } from '../../orchestrator/server/utils/incus-image-converter';
import type { IncusWorkerImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';

const digest = 'sha256:' + 'a'.repeat(64), stamp = '2026-10-06T10:00:00.000Z';
const definitionInput = { name: 'Controlled source', description: '', baseImage: 'agentor-worker:approved-test',
  dockerfileFragment: '', contextFiles: [], provisioning: [{ type: 'command', command: 'true' }] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'catalog-native-binding-'));
  let failWrite = false, revoked = false, inspections = 0, actualImageId = digest, holdWrite: Promise<void> | undefined;
  const path = join(root, 'image-catalog.json');
  const manager = new ImageCatalogManager(root, async state => {
    if (holdWrite) await holdWrite;
    if (failWrite) throw new Error('Controlled private catalog persistence failure');
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  });
  await manager.init();
  const owner = 'fixture-owner', definition = await manager.create(owner, definitionInput);
  definition.versions.push({ version: 'v1', digest, runtimeImage: digest, baseImage: definition.baseImage,
    createdAt: stamp, readiness: 'ready' });
  const state = (manager as unknown as { state: { definitions: ImageDefinition[]; builds: ImageBuild[]; systemDefault?: { definitionId: string; version: string } } }).state;
  state.builds.push({ id: randomUUID(), ownerId: owner, definitionId: definition.id, operation: 'build', builder: 'controlled',
    status: 'succeeded', phase: 'complete', progress: 100, imageCreated: true, digest, version: 'v1', createdAt: stamp, updatedAt: stamp, logs: [] });
  (manager as unknown as { docker: { getImage(reference: string): { inspect(): Promise<{ Id: string; Architecture: string }> } } }).docker = {
    getImage: reference => ({ inspect: async () => { inspections++; expect(reference).toBe(digest); return { Id: actualImageId, Architecture: 'amd64' }; } }),
  };
  const validate = async () => { if (revoked) throw new Error('Current owner/group permission was revoked'); };
  const authorize = (requesterId = owner, allowedGroupIds?: string[], explicit = true) => manager.authorizeNativeImageSource(requesterId,
    { ...(explicit ? { definitionId: definition.id, version: 'v1' } : {}), ...(allowedGroupIds ? { allowedGroupIds } : {}) }, validate);
  const context: NativeImageContext = { installationId: randomUUID(), project: 'agentor-private', seedFingerprint: 'b'.repeat(64),
    sourceImageId: digest, recipeId: 'c'.repeat(64), architecture: 'amd64', bootstrapGeneration: '3', converterVersion: 'v0.4.0', diskSize: '10G' };
  const identity: IncusWorkerImageIdentity = { version: 1, sourceImageId: digest, recipeId: context.recipeId,
    architecture: 'amd64', bootstrapGeneration: '3', converterVersion: 'v0.4.0', fingerprint: 'd'.repeat(64) };
  const receipt = (id: string): IncusImageConverterReceipt => ({ version: 1, name: 'aic-' + id, installationId: context.installationId,
    ownerId: owner, sourceImageId: digest, seedFingerprint: context.seedFingerprint, project: context.project, recipeId: context.recipeId,
    incarnation: randomUUID(), removed: true });
  const imported = async (id: string) => {
    await manager.acknowledgeNativeConverter(id, receipt(id));
    await manager.acknowledgeNativeImageImport(id, { pending: true }, validate);
    await manager.acknowledgeNativeImageImport(id, { pending: true, operation: '/1.0/operations/' + randomUUID() }, validate);
    const operation = manager.build(id, owner, false).nativeDerivation!.imageImport!.operation;
    await manager.acknowledgeNativeImageImport(id, { pending: false, operation, fingerprint: identity.fingerprint }, validate);
  };
  return { manager, owner, definition, state, context, identity, path, root, validate, authorize, receipt, imported,
    fail: (value: boolean) => { failWrite = value; }, revoke: () => { revoked = true; }, inspections: () => inspections,
    actualImage: (value: string) => { actualImageId = value; },
    holdWrite: (value: Promise<void> | undefined) => { holdWrite = value; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('owned controlled source uses actual immutable Docker acknowledgement and public projections exclude native authority', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(); expect(source.sourceImageId).toBe(digest); expect(f.inspections()).toBe(1);
    const id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.imported(id);
    const binding = await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
    expect(await f.manager.readNativeImageBinding(source, f.context, f.validate)).toEqual(binding);
    expect(f.manager.publicBuild(id, f.owner, false)).not.toHaveProperty('nativeDerivation');
    expect(f.manager.publicBuilds(f.owner, false).every(build => !Object.hasOwn(build, 'nativeDerivation'))).toBe(true);
    expect(JSON.stringify(f.manager.list(f.owner, false))).not.toContain('nativeBindings');
    expect(await f.manager.readNativeImageBinding(source, { ...f.context, installationId: randomUUID() }, f.validate)).toBeUndefined();
    expect(await f.manager.readNativeImageBinding(source, { ...f.context, project: 'another-private' }, f.validate)).toBeUndefined();
    expect(await f.manager.readNativeImageBinding(source, { ...f.context, seedFingerprint: 'e'.repeat(64) }, f.validate)).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('a descriptive or synthesized hash cannot substitute for the actual controlled OCI image ID', async () => {
  const f = await fixture(); try {
    f.actualImage('sha256:' + 'e'.repeat(64));
    await expect(f.authorize()).rejects.toThrow('actual immutable OCI image');
    expect(f.inspections()).toBe(1);
  } finally { await f.cleanup(); }
});

test('fake, recovered and foreign source metadata never authorizes a known cached digest', async () => {
  for (const kind of ['fake', 'recovered', 'foreign', 'no-ack', 'source-drift'] as const) {
    const f = await fixture(); try {
      if (kind === 'fake') f.state.builds[0]!.builder = 'fake';
      if (kind === 'recovered') f.definition.versions[0]!.recovered = true;
      if (kind === 'no-ack') f.state.builds = [];
      if (kind === 'source-drift') f.definition.versions[0]!.runtimeImage = 'sha256:' + 'e'.repeat(64);
      await expect(f.authorize(kind === 'foreign' ? 'another-owner' : f.owner)).rejects.toThrow();
      expect(f.inspections()).toBe(0);
    } finally { await f.cleanup(); }
  }
});

test('group and system-default permission reuse existing selection and remain current at publication', async () => {
  const f = await fixture(); try {
    const groupId = randomUUID(); f.definition.groupId = groupId; f.state.builds[0]!.groupId = groupId;
    await expect(f.authorize(f.owner, [])).rejects.toThrow();
    expect((await f.authorize(f.owner, [groupId])).scope).toBe('group');
    delete f.definition.groupId; delete f.state.builds[0]!.groupId;
    f.state.systemDefault = { definitionId: f.definition.id, version: 'v1' };
    const source = await f.authorize('system-recipient', undefined, false); expect(source.scope).toBe('system-default');
    const id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.manager.acknowledgeNativeConverter(id, { ...f.receipt(id), ownerId: source.requesterId });
    await f.manager.acknowledgeNativeImageImport(id, { pending: true }, f.validate);
    await f.manager.acknowledgeNativeImageImport(id, { pending: false, fingerprint: f.identity.fingerprint }, f.validate);
    delete f.state.systemDefault;
    await expect(f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate)).rejects.toThrow('permission changed');
  } finally { await f.cleanup(); }
});

test('already accepted cleanup/import acknowledgements survive revocation but cannot grant publication', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.manager.acknowledgeNativeConverter(id, f.receipt(id));
    await f.manager.acknowledgeNativeImageImport(id, { pending: true }, f.validate);
    f.revoke(); f.state.definitions = []; f.manager.build(id, f.owner, false).status = 'cancelled';
    await f.manager.acknowledgeNativeImageImport(id, { pending: true, operation: '/1.0/operations/' + randomUUID() }, f.validate);
    await expect(f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate)).rejects.toThrow('revoked');
    expect(f.manager.build(id, f.owner, false).nativeDerivation!.imageImport!.operation).toMatch(/^\/1\.0\/operations\//);
    expect(f.manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
  } finally { await f.cleanup(); }
});

test('source version drift and missing native import acknowledgement prohibit binding publication', async () => {
  for (const drift of ['version', 'owner', 'fingerprint', 'unsettled'] as const) {
    const f = await fixture(); try {
      const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
      if (drift !== 'unsettled') await f.imported(id);
      if (drift === 'version') f.definition.versions[0]!.digest = 'sha256:' + 'e'.repeat(64);
      if (drift === 'owner') f.definition.ownerId = 'other-owner';
      await expect(f.manager.publishNativeImageBinding(id, drift === 'fingerprint' ? { ...f.identity, fingerprint: 'e'.repeat(64) } : f.identity,
        'agentor-storage-ownership-v1', f.validate)).rejects.toThrow();
      expect(f.manager.publicBuild(id, f.owner, false).status).toBe('running');
    } finally { await f.cleanup(); }
  }
});

test('failed durable publication restores private map and exact acknowledged job without replay', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.imported(id); const before = structuredClone(f.manager.build(id, f.owner, false));
    f.fail(true);
    await expect(f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate)).rejects.toThrow('persistence failure');
    expect(f.manager.build(id, f.owner, false)).toEqual(before);
    expect(await f.manager.readNativeImageBinding(source, f.context, f.validate)).toBeUndefined();
    f.fail(false); await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
    expect((await f.manager.readNativeImageBinding(source, f.context, f.validate))!.identity.fingerprint).toBe(f.identity.fingerprint);
  } finally { await f.cleanup(); }
});

test('restart retains exact pending converter authority and source readiness without native resubmission', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    const receipt = { ...f.receipt(id), pending: { kind: 'create' as const, operation: '/1.0/operations/' + randomUUID() } };
    delete receipt.removed;
    await f.manager.acknowledgeNativeConverter(id, receipt);
    const restarted = new ImageCatalogManager(f.root); await restarted.init();
    expect(restarted.build(id, f.owner, false)).toMatchObject({ status: 'failed', nativeDerivation: { converter: receipt } });
    expect(restarted.version(f.definition.id, 'v1', f.owner, false).readiness).toBe('ready');
    await expect(restarted.openNativeImageDerivation(source, f.context, f.validate)).rejects.toThrow('already owns');
    expect(restarted.hasActiveOperationsForInstanceSnapshot()).toBe(true);
  } finally { await f.cleanup(); }
});

test('recovered catalog import ignores forged private binding/converter capability fields', async () => {
  const f = await fixture(); try {
    const recovered = await f.manager.importRecovered(f.owner, { ...definitionInput, nativeBindings: { forged: f.identity }, versions: [
      { version: 'v1', digest, ghcr: { reference: 'ghcr.io/foreign/known@' + digest }, nativeDerivation: f.receipt(randomUUID()),
        capability: 'agentor-storage-ownership-v1', nativeBinding: { context: f.context, identity: f.identity } },
    ] });
    expect(recovered.versions[0]).toMatchObject({ recovered: true });
    expect(recovered.versions[0]).not.toHaveProperty('nativeBinding'); expect(recovered.versions[0]).not.toHaveProperty('nativeDerivation');
    await expect(f.manager.authorizeNativeImageSource(f.owner, { definitionId: recovered.id, version: 'v1' }, f.validate)).rejects.toThrow('controlled OCI');
  } finally { await f.cleanup(); }
});

test('strict loading refuses malformed private acknowledged fields without rewriting inventory', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.manager.acknowledgeNativeConverter(id, f.receipt(id));
    const original = JSON.parse(await readFile(f.path, 'utf8'));
    original.builds.find((build: ImageBuild) => build.id === id).nativeDerivation.converter.incarnation = ['not-a-scalar-UUID'];
    const bytes = JSON.stringify(original); await writeFile(f.path, bytes, { mode: 0o600 });
    await expect(new ImageCatalogManager(f.root).init()).rejects.toThrow('malformed');
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
  } finally { await f.cleanup(); }
});

test('identical authorized conversions converge through the existing execution table and each reader reauthorizes', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(); let entered!: () => void, resume!: () => void, executions = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { resume = resolve; });
    const execute = async (id: string) => { executions++; entered(); await held;
      await f.imported(id); await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate); };
    const first = f.manager.ensureNativeImageBinding(source, f.context, f.validate, execute); await started;
    const second = f.manager.ensureNativeImageBinding(source, f.context, f.validate, execute);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(executions).toBe(1);
    resume(); expect(await first).toEqual(await second); expect(executions).toBe(1);
    await expect(f.manager.readNativeImageBinding({ ...source, requesterId: 'foreign-owner' }, f.context, f.validate)).rejects.toThrow();
  } finally { await f.cleanup(); }
});

test('accepted converter operation identity cannot regress or be replaced by another namespace', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    const prepared = f.receipt(id); delete prepared.removed; delete prepared.incarnation;
    await f.manager.acknowledgeNativeConverter(id, prepared);
    const accepted = { ...prepared, pending: { kind: 'create' as const, operation: '/1.0/operations/' + randomUUID() } };
    await f.manager.acknowledgeNativeConverter(id, accepted);
    for (const changed of [{ ...accepted, name: 'aic-' + randomUUID() }, { ...accepted, project: 'foreign-project' },
      { ...accepted, pending: { kind: 'create' as const } },
      { ...accepted, pending: { kind: 'create' as const, operation: '/1.0/operations/' + randomUUID() } }])
      await expect(f.manager.acknowledgeNativeConverter(id, changed)).rejects.toThrow();
    expect(f.manager.build(id, f.owner, false).nativeDerivation!.converter).toEqual(accepted);
  } finally { await f.cleanup(); }
});

test('private binding readers wait for existing durable mutation settlement and never observe failed publication', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.imported(id); let resume!: () => void;
    f.holdWrite(new Promise<void>(resolve => { resume = resolve; })); f.fail(true);
    const publication = f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate)
      .then(() => undefined, (error: unknown) => error);
    await new Promise<void>(resolve => setImmediate(resolve));
    let observed = false;
    const reading = f.manager.readNativeImageBinding(source, f.context, f.validate).then(value => { observed = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(observed).toBe(false);
    resume(); expect(await publication).toBeInstanceOf(Error); expect(await reading).toBeUndefined();
    f.holdWrite(undefined); f.fail(false);
  } finally { await f.cleanup(); }
});

test('a persisted physical fingerprint hint cannot replace its private successful import acknowledgement', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.imported(id); await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
    f.manager.build(id, f.owner, false).nativeDerivation!.imageImport!.fingerprint = 'e'.repeat(64);
    await expect(f.manager.readNativeImageBinding(source, f.context, f.validate)).rejects.toThrow('exact settled import');
  } finally { await f.cleanup(); }
});

test('queued publication and binding reads revalidate external membership after catalog write settlement', async () => {
  for (const action of ['publish', 'read'] as const) {
    const f = await fixture(); try {
      const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
      await f.imported(id);
      if (action === 'read') await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
      let resume!: () => void; f.holdWrite(new Promise<void>(resolve => { resume = resolve; }));
      const otherWrite = f.manager.setUserDefault(f.owner, f.definition.id, 'v1');
      await new Promise<void>(resolve => setImmediate(resolve));
      const observing = (action === 'publish'
        ? f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate)
        : f.manager.readNativeImageBinding(source, f.context, f.validate)).then(() => undefined, (error: unknown) => error);
      await new Promise<void>(resolve => setImmediate(resolve));
      f.revoke(); resume(); await otherWrite;
      expect(await observing).toBeInstanceOf(Error);
      expect((await observing as Error).message).toContain('revoked');
      f.holdWrite(undefined);
    } finally { await f.cleanup(); }
  }
});

test('verified-missing settled cache can regenerate without erasing prior successful acknowledgements', async () => {
  const f = await fixture(); try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.imported(id);
    const binding = await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
    const before = structuredClone(f.manager.build(id, f.owner, false));
    let checks = 0;
    const missing = async (fingerprint: string) => { checks++; expect(fingerprint).toBe(f.identity.fingerprint); };
    await f.manager.forgetMissingNativeImageBinding(source, binding, f.validate, missing);
    expect(checks).toBe(1);
    expect(f.manager.build(id, f.owner, false)).toEqual(before);
    expect(await f.manager.readNativeImageBinding(source, f.context, f.validate)).toBeUndefined();
    let executions = 0;
    const replacement = await f.manager.ensureNativeImageBinding(source, f.context, f.validate, async next => {
      executions++; expect(next).not.toBe(id); await f.imported(next);
      await f.manager.publishNativeImageBinding(next, f.identity, 'agentor-storage-ownership-v1', f.validate);
    });
    expect(executions).toBe(1); expect(replacement.buildId).not.toBe(id);
    await f.manager.forgetMissingNativeImageBinding(source, binding, f.validate, missing);
    expect(checks).toBe(1); // Stale readers cannot evict the replacement.
    expect(await f.manager.readNativeImageBinding(source, f.context, f.validate)).toEqual(replacement);
    expect(f.manager.build(id, f.owner, false)).toEqual(before);
  } finally { await f.cleanup(); }
});

test('missing-cache eviction preserves authority on unavailable native proof, revocation and persistence failure', async () => {
  for (const failure of ['native', 'revoked', 'persist', 'unsettled'] as const) {
    const f = await fixture(); try {
      const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
      await f.imported(id);
      const binding = await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
      if (failure === 'persist') f.fail(true);
      if (failure === 'unsettled') f.manager.build(id, f.owner, false).nativeDerivation!.imageImport!.pending = true;
      const bytes = await readFile(f.path, 'utf8');
      const missing = async () => {
        if (failure === 'native') throw new Error('Native absence is unproven');
        if (failure === 'revoked') f.revoke();
      };
      await expect(f.manager.forgetMissingNativeImageBinding(source, binding, f.validate, missing)).rejects.toThrow();
      expect(await readFile(f.path, 'utf8')).toBe(bytes);
      if (failure === 'native' || failure === 'persist')
        expect(await f.manager.readNativeImageBinding(source, f.context, f.validate)).toEqual(binding);
      await expect(f.manager.openNativeImageDerivation(source, f.context, f.validate)).rejects.toThrow();
    } finally { await f.cleanup(); }
  }
});
