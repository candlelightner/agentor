import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { useImageCatalogManager } from '../../orchestrator/server/utils/image-catalog';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { parseWorkerImportImageResolution } from '../../orchestrator/server/utils/worker-import-image-resolution';
import { withOwnerWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import type { Config } from '../../orchestrator/server/utils/config';

(globalThis as any).useLogger ??= () => ({ info() {}, error() {}, warn() {}, debug() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).reassignWorkerMappings ??= async () => {};
const digest = 'sha256:' + 'a'.repeat(64), oldDigest = 'sha256:' + 'b'.repeat(64);

async function fixture(run: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'archived-image-recovery-'));
  const owner = randomUUID(), id = randomUUID(), calls: string[] = [];
  const store = new WorkerStore(root); await store.init();
  const original = { id, userId: owner, runtimeKind: 'legacy-docker' as const, status: 'archived' as const, desiredRuntimeStatus: 'stopped' as const,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), displayName: 'Retained custom worker',
    imageDefinitionId: 'lost-definition', imageVersion: 'v1', imageDigest: oldDigest, imageRuntimeReference: oldDigest,
    initScript: 'echo retained', repos: [], mounts: [], hardwareDeviceIds: [], pendingRebuild: true };
  await store.upsert(original);
  const docker = { createWorkerContainer: async (options: any) => {
    calls.push('create'); expect(options.image).toBe(digest);
    expect(store.get(owner, id)).toMatchObject({ status: 'active', imageDigest: digest });
    return { id: 'new-docker-id' };
  }, removeContainer: async () => { calls.push('remove'); } };
  const manager = new ContainerManager(docker as any, { dataDir: root, containerPrefix: 'agentor-worker' } as Config);
  manager.setWorkerStore(store);
  Object.assign(manager, { assertOwnerExists: async () => {}, resolveAuthorizedHostMounts: async () => [],
    resolveHardwareDeviceAccess: async () => [], resolveEnvironmentConfig: () => ({}),
    deriveLimits: () => ({ cpuLimit: '', memoryLimit: '4g', dockerEnabled: true }),
    resolveGitIdentity: async () => ({ gitName: '', gitEmail: '' }),
    resolveUserEnvAndBinds: async () => ({ userEnv: zeroUserEnvVars(owner), credentialBinds: [], groupSecrets: [] }),
    persistentBackupPathMounts: async () => [], reconcileManagedNetworksForWorker: async () => {},
    reconcileWorkerPlugins: async () => {} });
  const catalog = useImageCatalogManager(); await catalog.init();
  const definition = await catalog.create(owner, { name: 'Recovered fixture', description: '',
    baseImage: 'agentor-worker:approved-default', dockerfileFragment: '', contextFiles: [] });
  definition.versions.push({ version: 'v1', digest, runtimeImage: digest, baseImage: definition.baseImage,
    createdAt: new Date().toISOString(), readiness: 'ready' });
  const replacement = { mode: 'replacement' as const, imageDefinitionId: definition.id, imageVersion: 'v1' };
  const config = useWorkerConfigStore(), managed = useManagedVolumeManager();
  const saved = { resolve: config.resolveValues, applied: config.markApplied, declared: managed.markDeclared };
  config.resolveValues = async () => []; config.markApplied = async () => {}; managed.markDeclared = async () => {};
  try { await run({ manager, store, owner, id, original, replacement, docker, calls, catalog, definition }); }
  finally { config.resolveValues = saved.resolve; config.markApplied = saved.applied; managed.markDeclared = saved.declared;
    await rm(root, { recursive: true, force: true }); }
}

test('explicit catalog recovery preserves worker identity/settings and saves selected immutable image before creation', async () => {
  await fixture(async (f) => {
    const result = await f.manager.unarchive(f.owner, f.id, f.replacement);
    expect(f.calls).toEqual(['create']); expect(result).toMatchObject({ id: f.id, userId: f.owner,
      imageDefinitionId: f.definition.id, imageVersion: 'v1', imageDigest: digest, imageRuntimeReference: digest,
      displayName: f.original.displayName, initScript: f.original.initScript });
    expect(f.store.get(f.owner, f.id)).toMatchObject({ status: 'active', imageDigest: digest });
  });
});

test('unavailable, foreign and incompatible catalog replacements leave archived state untouched', async () => {
  for (const kind of ['missing', 'foreign', 'incompatible']) await fixture(async (f) => {
    const choice = { ...f.replacement };
    if (kind === 'missing') choice.imageVersion = 'absent';
    if (kind === 'foreign') f.definition.ownerId = randomUUID();
    if (kind === 'incompatible') f.definition.versions[0].readiness = 'built-incompatible';
    await expect(f.manager.unarchive(f.owner, f.id, choice)).rejects.toThrow();
    expect(f.calls).toEqual([]); expect(f.store.get(f.owner, f.id)).toEqual(f.original);
  });
});

test('replacement checks remain inside owner/worker lifecycle fence and reread archived authority', async () => {
  await fixture(async (f) => {
    let unlock!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    let admitted!: () => void; const started = new Promise<void>(resolve => { admitted = resolve; });
    const blocker = withOwnerWorkerLifecycleMutation(f.owner, f.id, async () => { admitted(); await held;
      await f.store.delete(f.owner, f.id); });
    await started; const queued = f.manager.unarchive(f.owner, f.id, f.replacement);
    await Promise.resolve(); expect(f.calls).toEqual([]); unlock(); await blocker;
    await expect(queued).rejects.toThrow('Archived worker not found'); expect(f.calls).toEqual([]);
  });
});

test('workspace-only, imported rootfs, native and deleting workers never gain replacement authority', async () => {
  for (const kind of ['workspace-only', 'imported', 'native', 'deleting']) await fixture(async (f) => {
    if (kind === 'imported') await f.store.upsert({ ...f.original, importedImage: 'captured:rootfs' });
    if (kind === 'native') await f.store.upsert({ ...f.original, runtimeKind: 'incus-vm' });
    if (kind === 'deleting') await f.store.upsert({ ...f.original, deletionPending: true });
    const before = structuredClone(f.store.get(f.owner, f.id));
    await expect(f.manager.unarchive(f.owner, f.id, kind === 'workspace-only' ? { mode: 'workspace-only' } : f.replacement)).rejects.toThrow();
    expect(f.calls).toEqual([]); expect(f.store.get(f.owner, f.id)).toEqual(before);
  });
});

test('replacement persistence failure allocates no Docker compute', async () => {
  await fixture(async (f) => {
    f.store.upsert = async () => { throw new Error('desired selection write failed'); };
    await expect(f.manager.unarchive(f.owner, f.id, f.replacement)).rejects.toThrow('desired selection write failed');
    expect(f.calls).toEqual([]); expect(f.store.get(f.owner, f.id)).toEqual(f.original);
  });
});

test('failed compute creation returns to archived state with explicit desired replacement and other settings retained', async () => {
  await fixture(async (f) => {
    f.docker.createWorkerContainer = async () => { f.calls.push('create-failed'); throw new Error('image unavailable'); };
    await expect(f.manager.unarchive(f.owner, f.id, f.replacement)).rejects.toThrow('image unavailable');
    expect(f.calls).toEqual(['create-failed', 'remove']);
    expect(f.store.get(f.owner, f.id)).toMatchObject({ status: 'archived', imageDefinitionId: f.definition.id,
      imageDigest: digest, displayName: f.original.displayName, initScript: f.original.initScript });
  });
});

test('the public recovery parser rejects raw references, provenance and workspace loss', () => {
  expect(parseWorkerImportImageResolution({ mode: 'replacement', imageDefinitionId: 'owned-catalog', imageVersion: 'v2' }))
    .toEqual({ mode: 'replacement', imageDefinitionId: 'owned-catalog', imageVersion: 'v2' });
  for (const field of ['imageRuntimeReference', 'imageDigest', 'runtimeKind', 'provenance'])
    expect(() => parseWorkerImportImageResolution({ mode: 'replacement', imageDefinitionId: 'owned-catalog', imageVersion: 'v2', [field]: 'untrusted' })).toThrow();
});

test('unarchive without an explicit replacement keeps the original immutable selection', async () => {
  await fixture(async (f) => {
    f.docker.createWorkerContainer = async (options: any) => {
      expect(options.image).toBe(oldDigest); f.calls.push('original-create'); return { id: 'original-image-container' };
    };
    await f.manager.unarchive(f.owner, f.id);
    expect(f.calls).toEqual(['original-create']);
    expect(f.store.get(f.owner, f.id)).toMatchObject({ imageDefinitionId: f.original.imageDefinitionId,
      imageVersion: f.original.imageVersion, imageDigest: oldDigest, imageRuntimeReference: oldDigest });
  });
});

test('a catalog selection without a runtime alias uses its new immutable digest rather than the lost image or platform default', async () => {
  await fixture(async (f) => {
    delete f.definition.versions[0].runtimeImage;
    await f.manager.unarchive(f.owner, f.id, f.replacement);
    expect(f.calls).toEqual(['create']);
    expect(f.store.get(f.owner, f.id)).toMatchObject({ imageDigest: digest, imageRuntimeReference: digest });
  });
});
