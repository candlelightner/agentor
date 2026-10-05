import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceBackupManager } from '../../orchestrator/server/utils/instance-backup-manager';
import { FakeBackupProvider } from '../../orchestrator/server/utils/backup-provider';
import { backupKeyFingerprint } from '../../orchestrator/server/utils/backup-keyring';
import { useConfig, useWorkerStore, useContainerManager, useStorageManager, useWorkerGroupStore,
  usePluginDefinitionStore, usePluginInstallationStore, useHostMountStore } from '../../orchestrator/server/utils/services';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { useImageCatalogManager } from '../../orchestrator/server/utils/image-catalog';
import { beginInstanceSnapshot, instanceSnapshotActive } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { isWorkerLifecycleMutationPending } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

const source = { sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64), architecture: 'amd64',
  converterVersion: '0.4.0', bootstrapGeneration: '3' };

async function inventoryFixture(run: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'instance-native-inventory-'));
  const restorers: Array<() => void> = [];
  const patch = (obj: any, key: string, value: any) => {
    const owned = Object.hasOwn(obj, key), previous = obj[key]; obj[key] = value;
    restorers.push(() => { if (owned) obj[key] = previous; else delete obj[key]; });
  };
  const worker = { id: randomUUID(), userId: randomUUID(), runtimeKind: 'incus-vm', status: 'active' };
  const prefix = useConfig().containerPrefix, name = `${prefix}-${worker.id}`;
  const managed = { id: randomUUID(), userId: worker.userId, workerId: worker.id,
    dockerName: '', target: '/srv/models', storageRuntimeKind: 'incus-vm',
    seeded: true, attached: false, state: 'detached' };
  managed.dockerName = 'agentor-persist-' + managed.id;
  const containers = useContainerManager(), volumes = useManagedVolumeManager();
  const calls: string[] = [];
  const inspect = async (id: string) => {
    expect(id).toBe(worker.id); expect(isWorkerLifecycleMutationPending(id)).toBe(true);
    expect(instanceSnapshotActive()).toBe(true); calls.push('native-core');
    return { docker: true, runtime: { version: 1, kind: 'incus-vm', source } };
  };
  patch(useWorkerStore(), 'list', () => [worker]);
  patch(useStorageManager(), 'init', async () => {}); patch(useStorageManager(), 'mode', 'directory');
  patch(containers, 'inspectInstanceBackupStorageWithLifecycleFenceHeld', inspect);
  patch(volumes, 'init', async () => {}); patch(volumes.store, 'list', () => [managed]);
  patch(volumes.runtime, 'inspectVolume', async () => { throw new Error('Native data must not be inspected via Docker'); });
  patch(volumes.incusRuntime, 'inspectVolume', async () => { calls.push('native-managed'); return {}; });
  patch(useAdminWorkspaceStore(), 'getRecord', () => undefined);
  patch(useWorkerGroupStore(), 'list', () => []);
  patch(usePluginDefinitionStore(), 'list', () => []); patch(usePluginInstallationStore(), 'list', () => []);
  patch(useHostMountStore(), 'listCatalog', () => []);
  patch(useImageCatalogManager(), 'init', async () => {}); patch(useImageCatalogManager(), 'list', () => []);
  const docker = { listVolumes: async () => ({ Volumes: [
    ...['workspace', 'agents', 'docker'].map(role => ({ Name: name + '-' + role })),
    { Name: managed.dockerName }, { Name: 'retained-old-path', Labels: { 'agentor.worker-id': worker.id } },
    { Name: 'legacy-path', Labels: { 'agentor.worker-id': 'legacy-worker' } },
  ] }), getVolume: (id: string) => ({ inspect: async () => { calls.push('docker:' + id); return {}; } }) };
  const manager = new InstanceBackupManager({ dataDir: root, docker: docker as any });
  const release = beginInstanceSnapshot(randomUUID());
  try { await run({ root, patch, worker, managed, containers, volumes, calls, manager, name }); }
  finally { release(); for (const restore of restorers.reverse()) restore(); await rm(root, { recursive: true, force: true }); }
}

test('durable native inventory never probes colliding retained Docker sources even in directory mode', async () => {
  await inventoryFixture(async f => {
    const result = await f.manager.inventory('admin');
    expect(result.nativeRuntime).toBe(true);
    expect(result.volumes.map((v: any) => v.name)).toEqual([
      f.name + '-workspace', f.name + '-agents', f.name + '-docker', 'legacy-path', f.managed.dockerName,
    ]);
    expect(result.volumes.filter((v: any) => v.runtime).map((v: any) => v.runtime.role))
      .toEqual(['workspace', 'agents', 'docker', 'managed']);
    expect(result.volumes[0].runtime.dockerData).toBe(true);
    expect(result.volumes.slice(1).every((v: any) => !Object.hasOwn(v.runtime ?? {}, 'dockerData'))).toBe(true);
    expect(f.calls).toEqual(['native-core', 'native-managed', 'docker:legacy-path']);
  });
});

test('native inventory explicitly records absence even if colliding legacy Docker storage remains', async () => {
  await inventoryFixture(async f => {
    f.patch(f.containers, 'inspectInstanceBackupStorageWithLifecycleFenceHeld', async () => ({
      docker: false, runtime: { version: 1, kind: 'incus-vm', source },
    }));
    const result = await f.manager.inventory('admin');
    const workspace = result.volumes.find((v: any) => v.runtime?.role === 'workspace');
    expect(workspace.runtime.dockerData).toBe(false);
    expect(result.volumes.some((v: any) => v.name === f.name + '-docker')).toBe(false);
    expect(f.calls.some((call: string) => call === 'docker:' + f.name + '-docker')).toBe(false);
  });
});

test('missing native core or seeded managed data fails rather than reading same-name legacy bytes', async () => {
  for (const role of ['core', 'managed']) await inventoryFixture(async f => {
    if (role === 'core') f.patch(f.containers, 'inspectInstanceBackupStorageWithLifecycleFenceHeld', async () => { throw new Error('Native canonical data missing'); });
    else f.patch(f.volumes.incusRuntime, 'inspectVolume', async () => undefined);
    await expect(f.manager.inventory('admin')).rejects.toThrow(/missing/);
    expect(f.calls.some((value: string) => value.startsWith('docker:'))).toBe(false);
  });
});

test('unallocated pending native managed records carry no invented bytes, while mixed durable authority rejects', async () => {
  await inventoryFixture(async f => {
    f.managed.seeded = false; f.managed.attached = true; f.managed.state = 'pending';
    f.patch(f.volumes.incusRuntime, 'inspectVolume', async () => undefined);
    const result = await f.manager.inventory('admin');
    expect(result.volumes.filter((v: any) => v.runtime?.role === 'managed')).toEqual([]);
    expect(result.nativeRuntime).toBe(true);
  });
  await inventoryFixture(async f => {
    f.managed.storageRuntimeKind = 'legacy-docker';
    await expect(f.manager.inventory('admin')).rejects.toThrow('runtime authority disagree');
    expect(f.calls.some((value: string) => value.startsWith('docker:'))).toBe(false);
  });
});

test('deleted-worker retained inventory uses its durable native managed record without inventing core or Docker fixtures', async () => {
  await inventoryFixture(async f => {
    f.patch(useWorkerStore(), 'list', () => []);
    f.patch(f.manager.docker, 'listVolumes', async () => ({ Volumes: [] }));
    f.managed.retainedAfterAccountDeletion = true;
    const result = await f.manager.inventory('admin');
    expect(result.nativeRuntime).toBe(true);
    expect(result.volumes.map((v: any) => [v.name, v.runtime?.role])).toEqual([[f.managed.dockerName, 'managed']]);
    expect(f.calls).toEqual(['native-managed']);
  });
});

test('native canonical snapshot batches selected roles inside the existing lifecycle fence without Docker fallback', async () => {
  await inventoryFixture(async f => {
    const inventory = await f.manager.inventory('admin'), candidates = inventory.volumes.slice(0, 2);
    let calls = 0;
    f.patch(f.containers, 'captureInstanceCanonicalWithLifecycleFenceHeld', async (id: string, paths: any) => {
      calls++; expect(isWorkerLifecycleMutationPending(id)).toBe(true); expect(instanceSnapshotActive()).toBe(true);
      expect(paths).toEqual({ workspace: '/fixture/workspace.gz', agents: '/fixture/agents.gz' });
      return { runtime: { version: 1, kind: 'incus-vm', source }, bytes: {} };
    });
    await f.manager.snapshotNativeVolumes(candidates.map((volume: any, i: number) => ({ volume, path: i ? '/fixture/agents.gz' : '/fixture/workspace.gz' })), new AbortController().signal);
    expect(calls).toBe(1);
    f.patch(f.containers, 'captureInstanceCanonicalWithLifecycleFenceHeld', async () => ({ runtime: { kind: 'incus-vm', source: { ...source, recipeId: 'c'.repeat(64) } } }));
    await expect(f.manager.snapshotNativeVolumes([{ volume: candidates[0], path: '/fixture/workspace.gz' }], new AbortController().signal))
      .rejects.toThrow('immutable source changed');
  });
});

test('native workspace capture rechecks Docker presence before and after bytes instead of retaining stale absence proof', async () => {
  for (const inventoryPresence of [true, false]) for (const drift of ['before', 'after']) {
    await inventoryFixture(async f => {
      f.patch(f.containers, 'inspectInstanceBackupStorageWithLifecycleFenceHeld', async () => ({
        docker: inventoryPresence, runtime: { version: 1, kind: 'incus-vm', source },
      }));
      const inventory = await f.manager.inventory('admin');
      const workspace = inventory.volumes.find((v: any) => v.runtime?.role === 'workspace');
      let captures = 0, reads = 0;
      f.patch(f.containers, 'inspectInstanceBackupStorageWithLifecycleFenceHeld', async () => {
        expect(instanceSnapshotActive()).toBe(true); expect(isWorkerLifecycleMutationPending(f.worker.id)).toBe(true);
        reads++; return { docker: drift === 'before' || reads > 1 ? !inventoryPresence : inventoryPresence,
          runtime: { version: 1, kind: 'incus-vm', source } };
      });
      f.patch(f.containers, 'captureInstanceCanonicalWithLifecycleFenceHeld', async () => {
        captures++; return { runtime: { version: 1, kind: 'incus-vm', source }, bytes: {} };
      });
      await expect(f.manager.snapshotNativeVolumes([{ volume: workspace, path: '/fixture/workspace.gz' }],
        new AbortController().signal)).rejects.toThrow('Docker data presence changed');
      expect(captures).toBe(drift === 'before' ? 0 : 1);
      expect(reads).toBe(drift === 'before' ? 1 : 2);
    });
  }
});

test('native control-plane-only instance backup retains authenticated v2 metadata and rejects legacy-only restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'instance-native-control-plane-'));
  const provider = new FakeBackupProvider(join(root, 'provider')), material = Buffer.alloc(32, 45).toString('base64');
  const manager = new InstanceBackupManager({ dataDir: root, authSnapshot: path => writeFile(path, 'snapshot'),
    preflightCreate: async () => {}, backupManager: { instanceBackupProvider: () => provider,
      resolveInstanceRecoveryMaterial: async () => ({ material, fingerprint: backupKeyFingerprint(material) }) } as any,
    inventory: async () => ({ nativeRuntime: true, volumes: [], storage: { mode: 'directory', containerPrefix: 'worker' },
      plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
      hostMounts: { configuredPaths: [], contentsIncluded: false }, images: { definitions: 0, immutableDigests: [], layersIncluded: false } }) });
  try {
    const job = await manager.create('admin', 'fake', { includeDockerVolumes: false });
    await expect.poll(async () => (await manager.getJob(job.id))?.status).toBe('succeeded');
    const artifact = (await manager.list('admin')).artifacts[0]!;
    expect(artifact.formatVersion).toBe(2); expect(artifact.manifest?.formatVersion).toBe(2);
    await expect(manager.restorePreflight('admin', artifact.id, { restoreDockerVolumes: false }))
      .rejects.toMatchObject({ code: 'INSTANCE_RESTORE_NATIVE_UNAVAILABLE', statusCode: 409 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
