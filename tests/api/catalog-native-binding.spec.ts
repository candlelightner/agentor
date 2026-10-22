import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ImageCatalogManager, ImageCatalogCore, type ImageDefinition, type ImageBuild, type NativeImageContext,
  type NativeImageSource } from '../../orchestrator/server/utils/image-catalog';
import type { IncusImageConverterReceipt } from '../../orchestrator/server/utils/incus-image-converter';
import type { IncusWorkerImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';

const digest = 'sha256:' + 'a'.repeat(64), stamp = '2026-10-06T10:00:00.000Z';
const definitionInput = { name: 'Controlled source', description: '', baseImage: 'agentor-worker:approved-test',
  dockerfileFragment: '', contextFiles: [], provisioning: [{ type: 'command', command: 'true' }] };

async function fixture(cold = false) {
  const root = await mkdtemp(join(tmpdir(), 'catalog-native-binding-'));
  let writes = 0, failWrite = false, revoked = false, inspections = 0, actualImageId = digest, holdWrite: Promise<void> | undefined;
  const path = join(root, 'image-catalog.json');
  const manager = new (cold ? ImageCatalogCore : ImageCatalogManager)(root, async state => {
    if (holdWrite) await holdWrite;
    if (failWrite) throw new Error('Controlled private catalog persistence failure');
    await writeFile(path, JSON.stringify(state), { mode: 0o600 }); writes++;
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
    writes: () => writes, fail: (value: boolean) => { failWrite = value; }, revoke: () => { revoked = true; }, inspections: () => inspections,
    actualImage: (value: string) => { actualImageId = value; },
    holdWrite: (value: Promise<void> | undefined) => { holdWrite = value; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('cold catalog uses the same current source authority and private converter/import acknowledgements without application services', async () => {
  const f = await fixture(true); try {
    await expect(f.authorize('foreign-owner')).rejects.toThrow();
    const source = await f.authorize();
    const id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await expect(f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate)).rejects.toThrow();
    await f.imported(id);
    const binding = await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
    expect(await f.manager.readNativeImageBinding(source, f.context, f.validate)).toEqual(binding);
    f.revoke();
    await expect(f.manager.readNativeImageBinding(source, f.context, f.validate)).rejects.toThrow('revoked');
  } finally { await f.cleanup(); }
});

test('operator failed-abandonment survives catalog reload, permits authorized retry, and never grants publication or revoked access', async () => {
  const f = await fixture(true); try {
    const source = await f.authorize(); let id = '';
    await expect(f.manager.ensureNativeImageBinding(source, f.context, f.validate, async buildId => {
      id = buildId;
      await f.manager.acknowledgeNativeConverter(id, { ...f.receipt(id), removed: undefined,
        pending: { kind: 'start', operation: '/1.0/operations/' + randomUUID() } });
      throw new Error('Lost native acknowledgement');
    })).rejects.toThrow('Lost native acknowledgement');
    await expect(f.manager.openNativeImageDerivation(source, f.context, f.validate)).rejects.toThrow();
    const script = fileURLToPath(new URL('../../scripts/recover-incus-job.py', import.meta.url));
    const changed = execFileSync('python3', ['-c',
      'import importlib.util,json,sys;s=importlib.util.spec_from_file_location("recovery",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);sys.stdout.buffer.write(m.replacement("converter",json.load(sys.stdin),sys.argv[2]))',
      script, id], { input: await readFile(f.path), timeout: 10_000 });
    await writeFile(f.path, changed, { mode: 0o600 });
    const loaded = new ImageCatalogCore(f.root); await loaded.init();
    expect(loaded.build(id, f.owner, false)).toMatchObject({ status: 'failed', nativeDerivation: { converter: { removed: true } } });
    expect(loaded.build(id, f.owner, false).nativeDerivation!.converter).not.toHaveProperty('pending');
    expect(await loaded.readNativeImageBinding(source, f.context, f.validate)).toBeUndefined();
    await expect(loaded.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate)).rejects.toThrow();
    const retry = await loaded.openNativeImageDerivation(source, f.context, f.validate); expect(retry).not.toBe(id);
    f.revoke();
    await expect(loaded.openNativeImageDerivation(source, { ...f.context, recipeId: 'f'.repeat(64) }, f.validate)).rejects.toThrow('revoked');
  } finally { await f.cleanup(); }
});

test('failed native conversion retains bounded sanitized cause logs and unchanged exact acknowledgements', async () => {
  const f = await fixture(true); try {
    f.manager.setNativeDiagnosticLogger({ info() { throw Error('Private log sink failure'); }, warn() { throw Error('Private log sink failure'); } });
    const source = await f.authorize(); let id = '', acknowledged: IncusImageConverterReceipt | undefined;
    const failure = new Error('Isolated converter raw-convert failed (exit 37):\nAPI_KEY=PRIVATE_API_SENTINEL PASSWORD=PRIVATE_PASSWORD_SENTINEL ' +
      'authorization: Bearer PRIVATE_BEARER_SENTINEL authorization: Basic PRIVATE_BASIC_SENTINEL /var/run/docker.sock https://reader:PRIVATE_URL_SENTINEL@private.example/path ' +
      'https://public.example/path?ordinary=user@example ' + 'x'.repeat(1000));
    await expect(f.manager.ensureNativeImageBinding(source, f.context, f.validate, async buildId => {
      id = buildId; acknowledged = f.receipt(id); await f.manager.acknowledgeNativeConverter(id, acknowledged);
      f.manager.build(id, f.owner, false).logs.push(...Array.from({ length: 2000 }, (_, index) => 'existing-' + index));
      throw failure;
    })).rejects.toBe(failure);
    const failed = f.manager.build(id, f.owner, false), diagnostic = failed.logs.at(-1)!;
    expect(failed).toMatchObject({ status: 'failed', phase: 'failed', outcome: 'build-failed',
      error: 'Native image conversion failed; exact acknowledged authority is retained.', nativeDerivation: { converter: acknowledged } });
    expect(failed.logs).toHaveLength(2000); expect(failed.logs[0]).toBe('existing-1');
    expect(diagnostic).toContain('[native] Isolated converter raw-convert failed (exit 37):');
    expect(diagnostic.length).toBeLessThanOrEqual(509); expect(diagnostic).not.toMatch(/[\r\n]|PRIVATE_API_SENTINEL|PRIVATE_PASSWORD_SENTINEL|PRIVATE_BEARER_SENTINEL|PRIVATE_BASIC_SENTINEL|PRIVATE_URL_SENTINEL|reader:|docker\.sock/);
    expect(diagnostic).toContain('[redacted]'); expect(diagnostic).toContain('[redacted-path]');
    expect(diagnostic).toContain('[redacted]private.example/path'); expect(diagnostic).toContain('https://public.example/path?ordinary=user@example');
    expect(await f.manager.readNativeImageBinding(source, f.context, f.validate)).toBeUndefined();
    expect(f.manager.publicBuild(id, f.owner, false)).not.toHaveProperty('nativeDerivation');
    expect(JSON.parse(await readFile(f.path, 'utf8')).builds.find((build: ImageBuild) => build.id === id).logs).toEqual(failed.logs);
  } finally { await f.cleanup(); }
});

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

test('UI-expanded explicit selection authorizes only the exact effective foreign system default', async () => {
  const f = await fixture(); try {
    expect((await f.authorize()).scope).toBe('own');
    f.state.systemDefault = { definitionId: f.definition.id, version: 'v1' };
    const source = await f.authorize('system-recipient');
    expect(source).toMatchObject({ scope: 'system-default', definitionId: f.definition.id,
      version: 'v1', requesterId: 'system-recipient', definitionOwnerId: f.owner, sourceImageId: digest });
    f.definition.versions.push({ ...f.definition.versions[0]!, version: 'v2' });
    f.state.builds.push({ ...f.state.builds[0]!, id: randomUUID(), version: 'v2' });
    const foreign = await f.manager.create('another-owner', definitionInput);
    foreign.versions.push({ ...f.definition.versions[0]! });
    f.state.builds.push({ ...f.state.builds[0]!, id: randomUUID(), ownerId: foreign.ownerId, definitionId: foreign.id });
    const inspections = f.inspections();
    for (const selection of [{ definitionId: f.definition.id, version: 'v2' },
      { definitionId: foreign.id, version: 'v1' }])
      await expect(f.manager.authorizeNativeImageSource('system-recipient', selection, f.validate)).rejects.toThrow();
    expect(f.inspections()).toBe(inspections);
  } finally { await f.cleanup(); }
});

test('revoking or changing the exact explicit system default prohibits cached reuse and publication', async () => {
  for (const change of ['revoke', 'version', 'definition'] as const) for (const action of ['reuse', 'publish'] as const) {
    const f = await fixture(); try {
      f.state.systemDefault = { definitionId: f.definition.id, version: 'v1' };
      const source = await f.authorize('system-recipient');
      const id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
      await f.manager.acknowledgeNativeConverter(id, { ...f.receipt(id), ownerId: source.requesterId });
      await f.manager.acknowledgeNativeImageImport(id, { pending: true }, f.validate);
      await f.manager.acknowledgeNativeImageImport(id, { pending: false, fingerprint: f.identity.fingerprint }, f.validate);
      if (action === 'reuse') {
        await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
        expect((await f.manager.readNativeImageBinding(source, f.context, f.validate))!.identity).toEqual(f.identity);
      }
      if (change === 'revoke') delete f.state.systemDefault;
      if (change === 'version') f.state.systemDefault = { definitionId: f.definition.id, version: 'v2' };
      if (change === 'definition') f.state.systemDefault = { definitionId: randomUUID(), version: 'v1' };
      if (action === 'reuse') await expect(f.manager.readNativeImageBinding(source, f.context, f.validate)).rejects.toThrow('permission changed');
      else await expect(f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate))
          .rejects.toThrow('permission changed');
      await expect(f.authorize('system-recipient')).rejects.toThrow();
    } finally { await f.cleanup(); }
  }
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

test('terminal converter recovery is owner/admin scoped, serial and durable, then permits a fresh same-key build', async () => {
  const f = await fixture(true);
  try {
    const source = await f.authorize(); let id = '';
    await expect(f.manager.ensureNativeImageBinding(source, f.context, f.validate, async buildId => {
      id = buildId; await f.manager.acknowledgeNativeConverter(id, { ...f.receipt(id), removed: undefined }); throw Error('conversion interrupted');
    })).rejects.toThrow('interrupted');
    let called = 0, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await expect(f.manager.withNativeConverterRecovery(id, 'foreign', false, async () => { called++; })).rejects.toMatchObject({ statusCode: 403 });
    const recovery = f.manager.withNativeConverterRecovery(id, 'operator', true, async (receipt, validate, acknowledge) => {
      called++; await held; await validate();
      await acknowledge({ ...receipt, pending: { kind: 'delete' } });
      await acknowledge({ ...receipt, pending: { kind: 'delete', operation: '/1.0/operations/' + randomUUID() } });
      await acknowledge({ ...receipt, pending: undefined });
      await acknowledge({ ...receipt, removed: true });
    });
    await expect.poll(() => called).toBe(1);
    await expect(f.manager.withNativeConverterRecovery(id, f.owner, false, async () => { called++; })).rejects.toThrow('still active');
    release(); const result = await recovery;
    expect(result.status).toBe('failed'); expect(result).not.toHaveProperty('nativeDerivation'); expect(called).toBe(1);
    const loaded = new ImageCatalogCore(f.root); await loaded.init();
    expect(loaded.build(id, f.owner, false).nativeDerivation!.converter?.removed).toBe(true);
    expect(await loaded.openNativeImageDerivation(source, f.context, f.validate)).not.toBe(id);
  } finally { await f.cleanup(); }
});

test('recovery refuses active, unknown, imported, removed or malformed receipts without invoking cleanup', async () => {
  for (const condition of ['running','pending','missing-incarnation','import','removed','source','context'] as const) {
    const f = await fixture(true);
    try {
      const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
      const receipt = { ...f.receipt(id), removed: undefined };
      await f.manager.acknowledgeNativeConverter(id, receipt);
      const build = f.manager.build(id, f.owner, false); build.status = condition === 'running' ? 'running' : 'failed';
      if (condition === 'pending') build.nativeDerivation!.converter!.pending = { kind: 'stop' };
      if (condition === 'missing-incarnation') delete build.nativeDerivation!.converter!.incarnation;
      if (condition === 'removed') build.nativeDerivation!.converter!.removed = true;
      if (condition === 'source') build.nativeDerivation!.converter!.sourceImageId = 'sha256:' + 'e'.repeat(64);
      if (condition === 'context') build.nativeDerivation!.context.recipeId = 'f'.repeat(64);
      if (condition === 'import') { build.nativeDerivation!.converter!.removed = true; build.nativeDerivation!.imageImport = { pending: true }; }
      let calls = 0;
      await expect(f.manager.withNativeConverterRecovery(id, f.owner, false, async () => { calls++; })).rejects.toThrow();
      expect(calls).toBe(0);
    } finally { await f.cleanup(); }
  }
});

test('failed cleanup retains its last acknowledged pending receipt in memory and after restart', async () => {
  const f = await fixture(true);
  try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.manager.acknowledgeNativeConverter(id, { ...f.receipt(id), removed: undefined });
    f.manager.build(id, f.owner, false).status = 'cancelled';
    await expect(f.manager.withNativeConverterRecovery(id, f.owner, false, async (receipt, _validate, acknowledge) => {
      await acknowledge({ ...receipt, pending: { kind: 'delete', operation: '/1.0/operations/' + randomUUID() } });
      throw Error('lost observation');
    })).rejects.toThrow('lost observation');
    const pending = f.manager.build(id, f.owner, false).nativeDerivation!.converter!;
    expect(pending.pending?.operation).toBeTruthy(); expect(pending.removed).toBeUndefined();
    const loaded = new ImageCatalogCore(f.root); await loaded.init();
    expect(loaded.build(id, f.owner, false).nativeDerivation!.converter).toEqual(pending);
    await expect(loaded.withNativeConverterRecovery(id, f.owner, false, async () => {})).rejects.toThrow('without pending');
  } finally { await f.cleanup(); }
});

test('actual converter recovery route requires authentication, exact path and empty body and forwards trusted owner/admin context', async () => {
  const { useImageCatalogManager } = await import('../../orchestrator/server/utils/image-catalog');
  const manager = useImageCatalogManager(), originalInit = manager.init, originalRecover = manager.recoverNativeConverter;
  const calls: unknown[][] = [], globals = globalThis as any;
  const values: Record<string, unknown> = { defineRouteMeta: () => {}, defineEventHandler: (handler: unknown) => handler,
    getRouterParam: (event: any) => event.path, readBody: async (event: any) => event.body,
    createError: (value: any) => Object.assign(Error(value.statusMessage), value) };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  Object.assign(globals, values);
  manager.init = async () => {};
  manager.recoverNativeConverter = async (...args) => { calls.push(args); return { id: args[0] } as any; };
  try {
    const route = (await import('../../orchestrator/server/api/image-builds/[...path]')).default as any;
    const id = randomUUID(), event = { method: 'POST', path: id + '/recover-converter', body: {},
      context: { auth: { user: { id: 'owner', role: 'user' }, session: {} } } };
    await expect(route({ ...event, context: {} })).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toEqual([]);
    expect(await route(event)).toEqual({ id }); expect(calls.at(-1)).toEqual([id, 'owner', false]);
    expect(await route({ ...event, context: { auth: { user: { id: 'operator', role: 'admin' }, session: {} } } })).toEqual({ id });
    expect(calls.at(-1)).toEqual([id, 'operator', true]);
    for (const body of [undefined, null, [], { name: 'arbitrary' }, { force: true }])
      await expect(route({ ...event, body })).rejects.toMatchObject({ statusCode: 400 });
    await expect(route({ ...event, path: event.path + '/extra' })).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toHaveLength(2);
  } finally {
    manager.init = originalInit; manager.recoverNativeConverter = originalRecover;
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key];
    }
  }
});

test('application recovery reads existing installation identity without creating a missing identity or invoking native cleanup', async () => {
  const f = await fixture();
  const { useConfig } = await import('../../orchestrator/server/utils/services');
  const { IncusImageConverter } = await import('../../orchestrator/server/utils/incus-image-converter');
  const config = useConfig(), previous = { dataDir: config.dataDir, incusEnabled: config.incusEnabled };
  const original = IncusImageConverter.cleanup;
  let calls = 0;
  IncusImageConverter.cleanup = async () => { calls++; throw Error('Must not touch native client'); };
  Object.assign(config, { dataDir: f.root, incusEnabled: true });
  try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.manager.acknowledgeNativeConverter(id, { ...f.receipt(id), removed: undefined });
    f.manager.build(id, f.owner, false).status = 'failed';
    await expect((f.manager as ImageCatalogManager).recoverNativeConverter(id, f.owner, false)).rejects.toMatchObject({ statusCode: 409 });
    await expect(readFile(join(f.root, 'backup-installation-id'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(0);
  } finally { Object.assign(config, previous); IncusImageConverter.cleanup = original; await f.cleanup(); }
});


test('native phases and bounded waiting are durable indeterminate observations, with owner-scoped public projections and official logs', async () => {
  const f = await fixture(true);
  const { Logger } = await import('../../orchestrator/server/utils/logger');
  const entries: any[] = [], broadcast: any[] = [];
  const logger = new Logger({ logLevel: 'info' } as any, { append: entry => entries.push(entry) } as any,
    { broadcast: entry => broadcast.push(entry) } as any); logger.setReady();
  f.manager.setNativeDiagnosticLogger(logger);
  try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.manager.reportNativeImagePhase(id, 'converting-disk');
    const build = f.manager.build(id, f.owner, false);
    const phaseStartedAt = new Date(Date.now() - 20_000).toISOString();
    build.nativeActivity!.phaseStartedAt = phaseStartedAt;
    const beforeWaiting = f.writes();
    await f.manager.noteNativeImageWaiting(id);
    const activity = structuredClone(build.nativeActivity);
    expect(activity).toEqual({ progressMode: 'indeterminate', phase: 'converting-disk', phaseStartedAt,
      waitingAt: expect.any(String) });
    expect(f.writes()).toBe(beforeWaiting + 1);
    const written = f.writes();
    await f.manager.noteNativeImageWaiting(id);
    await f.manager.reportNativeImagePhase(id, 'converting-disk');
    for (let i = 0; i < 3; i++) f.manager.publicBuild(id, f.owner, false);
    expect(f.writes()).toBe(written); // Reads/repeated observations do not create activity or writes.
    expect(f.manager.publicBuild(id, f.owner, false)).toMatchObject({ status: 'running', phase: 'converting-disk', nativeActivity: activity });
    expect(f.manager.publicBuild(id, f.owner, false)).not.toHaveProperty('progress');
    expect(f.manager.publicBuild(id, f.owner, false)).not.toHaveProperty('nativeDerivation');
    expect(f.manager.publicBuild(id, f.owner, false)).not.toHaveProperty('logs');
    expect(() => f.manager.publicBuild(id, 'foreign-owner', false)).toThrow();
    expect(f.manager.publicBuilds('foreign-owner', false)).toEqual([]);
    expect(f.manager.publicBuild(id, 'operator', true).nativeActivity).toEqual(activity);
    expect(JSON.parse(await readFile(f.path, 'utf8')).builds.find(item => item.id === id).nativeActivity).toEqual(activity);
    expect(entries).toEqual(broadcast);
    expect(entries.map(entry => entry.message).join('\n')).toContain(`job=${id} phase=converting-disk elapsedMs=`);
    expect(entries.at(-1).message).toContain('Controller still waiting; no measured converter progress is available.');
    expect(f.manager.logs(id, f.owner, false)).toContain('Entered stage: converting-disk; progress is indeterminate.');
    await f.manager.reportNativeImagePhase(id, 'receiving-disk');
    expect(f.manager.build(id, f.owner, false).nativeActivity).not.toHaveProperty('waitingAt');
    await f.imported(id);
    await f.manager.reportNativeImagePhase(id, 'publishing-image');
    await f.manager.publishNativeImageBinding(id, f.identity, 'agentor-storage-ownership-v1', f.validate);
    const settled = structuredClone(f.manager.publicBuild(id, f.owner, false)), settledWrites = f.writes();
    await f.manager.reportNativeImagePhase(id, 'waiting-for-agent');
    await f.manager.noteNativeImageWaiting(id);
    expect(f.manager.publicBuild(id, f.owner, false)).toEqual(settled);
    expect(f.writes()).toBe(settledWrites);
    expect(settled).not.toHaveProperty('progress');
    expect(entries.at(-1).message).toContain('worker startup is a separate operation');
  } finally { await f.cleanup(); }
});

test('phase persistence rollback and restart retain exact authority without resuming or inventing completed work', async () => {
  const f = await fixture(true);
  try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.manager.acknowledgeNativeConverter(id, { ...f.receipt(id), removed: undefined });
    const before = structuredClone(f.manager.build(id, f.owner, false)), bytes = await readFile(f.path, 'utf8');
    f.fail(true);
    await expect(f.manager.reportNativeImagePhase(id, 'converting-disk')).rejects.toThrow('persistence failure');
    expect(f.manager.build(id, f.owner, false)).toEqual(before);
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    f.fail(false);
    await f.manager.reportNativeImagePhase(id, 'converting-disk');
    const activity = structuredClone(f.manager.publicBuild(id, f.owner, false).nativeActivity);
    const loaded = new ImageCatalogCore(f.root); await loaded.init();
    expect(loaded.publicBuild(id, f.owner, false)).toMatchObject({ status: 'failed', phase: 'failed',
      recovery: 'restart-failed-safe', completedAt: expect.any(String), nativeActivity: activity });
    expect(loaded.publicBuild(id, f.owner, false)).not.toHaveProperty('progress');
    expect(loaded.build(id, f.owner, false).nativeDerivation).toEqual(before.nativeDerivation);
    const after = structuredClone(loaded.publicBuild(id, f.owner, false));
    await loaded.reportNativeImagePhase(id, 'receiving-disk'); await loaded.noteNativeImageWaiting(id);
    expect(loaded.publicBuild(id, f.owner, false)).toEqual(after);
  } finally { await f.cleanup(); }
});

test('malformed or ordinary-build telemetry is discarded without weakening strict native receipt validation', async () => {
  const f = await fixture(true);
  try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    const original = JSON.parse(await readFile(f.path, 'utf8'));
    const valid = { progressMode: 'indeterminate', phase: 'converting-disk', phaseStartedAt: stamp };
    for (const activity of [{ ...valid, phase: 'guest-selected-stage\nSECRET' },
      { ...valid, phaseStartedAt: 'invalid' }, { ...valid, phaseStartedAt: '2026-02-30T00:00:00.000Z' },
      { ...valid, waitingAt: '2026-10-05T00:00:00.000Z' }, { ...valid, progressMode: 'percent', percent: 99 }]) {
      const state = structuredClone(original);
      state.builds.find(item => item.id === id).nativeActivity = activity;
      state.builds[0].nativeActivity = valid;
      await writeFile(f.path, JSON.stringify(state));
      const loaded = new ImageCatalogCore(f.root); await loaded.init();
      expect(loaded.publicBuild(id, f.owner, false).nativeActivity).toBeUndefined();
      expect(loaded.publicBuild(state.builds[0].id, f.owner, false).nativeActivity).toBeUndefined();
      expect(loaded.build(id, f.owner, false).nativeDerivation).toEqual(original.builds.find(item => item.id === id).nativeDerivation);
    }
  } finally { await f.cleanup(); }
});

test('actual authenticated REST status and MCP status preserve indeterminate telemetry and never expose private receipts', async () => {
  const f = await fixture(true);
  const { useImageCatalogManager } = await import('../../orchestrator/server/utils/image-catalog');
  const { ManagementImageBackupDomain } = await import('../../orchestrator/server/utils/management-image-backup-domain');
  const manager = useImageCatalogManager(), originalInit = manager.init, originalPublic = manager.publicBuild;
  const globals = globalThis as any;
  const values = { defineRouteMeta: () => {}, defineEventHandler: (handler: unknown) => handler,
    getRouterParam: (event: any) => event.path,
    createError: (value: any) => Object.assign(Error(value.statusMessage), value) };
  const descriptors = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  Object.assign(globals, values); manager.init = async () => {}; manager.publicBuild = f.manager.publicBuild.bind(f.manager);
  try {
    const source = await f.authorize(), id = await f.manager.openNativeImageDerivation(source, f.context, f.validate);
    await f.manager.reportNativeImagePhase(id, 'converting-disk');
    const route = (await import('../../orchestrator/server/api/image-builds/[...path]')).default as any;
    const event = { method: 'GET', path: id, context: { auth: { user: { id: f.owner, role: 'user' }, session: {} } } };
    await expect(route({ ...event, context: {} })).rejects.toMatchObject({ statusCode: 401 });
    await expect(route({ ...event, context: { auth: { user: { id: 'foreign-owner', role: 'user' }, session: {} } } })).rejects.toMatchObject({ statusCode: 403 });
    const rest = await route(event);
    const mcp = (await new ManagementImageBackupDomain().execute('images.build-status', { ownerId: f.owner, buildId: id })).result;
    for (const result of [rest, mcp]) {
      expect(result).toMatchObject({ id, status: 'running', nativeActivity: { progressMode: 'indeterminate', phase: 'converting-disk' } });
      expect(result).not.toHaveProperty('progress'); expect(result).not.toHaveProperty('nativeDerivation'); expect(result).not.toHaveProperty('logs');
    }
    expect(mcp.nextActions.status.arguments).toEqual({ buildId: id });
    expect(mcp.nextActions.logs.arguments).toEqual({ buildId: id });
  } finally {
    manager.init = originalInit; manager.publicBuild = originalPublic;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key];
    }
    await f.cleanup();
  }
});
