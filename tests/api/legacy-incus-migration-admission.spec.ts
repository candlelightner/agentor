import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore, type WorkerRecord, type WorkerIncusMigration } from '../../orchestrator/server/utils/worker-store';
import type { Config } from '../../orchestrator/server/utils/config';
import type { ContainerInfo } from '../../orchestrator/shared/types';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import type { StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import { createRequire } from 'node:module';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { incusManagedRestoreDevices } from '../../orchestrator/server/utils/incus-managed-volume-runtime';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-migration-admission-'));
  const store = new WorkerStore(dir); await store.init();
  const record: WorkerRecord = { id: randomUUID(), userId: 'migration-owner', displayName: 'Source',
    runtimeKind: 'legacy-docker', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  await store.upsert(record);
  const docker = new Proxy({}, { get: () => () => { throw new Error('Unexpected Docker operation before admission'); } });
  const manager = new ContainerManager(docker as any, { dataDir: dir } as Config);
  manager.setWorkerStore(store); (manager as any).storageManager = {};
  const info = { ...record, status: 'running', containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64),
    containerName: 'agentor-worker-' + record.id, imageName: 'configured-source' } as ContainerInfo;
  manager.registerExternal(info);
  return { dir, store, record, info, manager, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

for (const condition of ['native', 'archived', 'revoked', 'hardware', 'admin', 'migration'] as const)
  test(`migration rejects ${condition} before stopping source or allocating destination`, async () => {
    const f = await fixture();
    try {
      if (condition === 'native') await f.store.upsert({ ...f.record, runtimeKind: 'incus-vm' });
      if (condition === 'archived') await f.store.upsert({ ...f.record, status: 'archived' });
      if (condition === 'revoked') await f.store.upsert({ ...f.record, hostMountsRevoked: true });
      if (condition === 'hardware') await f.store.upsert({ ...f.record, hardwareDeviceIds: ['unimplemented-passthrough'] });
      if (condition === 'admin') f.info.administrativeKind = 'platform';
      if (condition === 'migration') await f.store.transitionIncusMigration(f.record.userId, f.record.id, undefined, {
        nonce: randomUUID(), phase: 'preparing', source: { containerId: f.info.containerId,
          imageId: f.info.imageId, createdAt: f.record.createdAt, wasRunning: true },
      });
      const before = f.store.get(f.record.userId, f.record.id);
      let checks = 0;
      await expect(f.manager.migrateLegacyWorker(f.record.id, async () => { checks++; })).rejects.toMatchObject({ statusCode: 409 });
      expect(checks).toBe(1); expect(f.info.status).toBe('running');
      expect(f.store.get(f.record.userId, f.record.id)).toEqual(before);
    } finally { await f.cleanup(); }
  });

test('migration revocation rejects before any Docker or durable mutation', async () => {
  const f = await fixture();
  try {
    const before = f.store.get(f.record.userId, f.record.id);
    await expect(f.manager.migrateLegacyWorker(f.record.id, async () => {
      throw Object.assign(new Error('Administrator authority revoked'), { statusCode: 403 });
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.store.get(f.record.userId, f.record.id)).toEqual(before);
  } finally { await f.cleanup(); }
});

for (const condition of ['complete-attached', 'complete-detached', 'no-operation', 'active', 'failed', 'unseeded', 'incoherent-state'] as const)
  test(`managed migration admission ${condition} distinguishes settled history from unresolved storage`, async () => {
    const f = await fixture(), volumes = useManagedVolumeManager();
    const original = { init: volumes.init, assert: volumes.assertLiveRecoveryResolved,
      blocked: volumes.isRecoveryBlocked, records: volumes.store.forWorker };
    const Docker = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('dockerode');
    const getContainer = Docker.prototype.getContainer;
    let inspected = false;
    try {
      const volume: StoredManagedVolume = { id: randomUUID(), userId: f.record.userId, workerId: f.record.id,
        target: '/home/agent/persist', name: 'persist', dockerName: 'agentor-persist-' + randomUUID(),
        purpose: 'persistent-path', storageRuntimeKind: 'legacy-docker', seeded: true, attached: true,
        state: 'ready', createdAt: f.record.createdAt, updatedAt: f.record.updatedAt,
        operation: { id: randomUUID(), mode: 'recreate', stage: 'complete' } };
      if (condition === 'complete-detached') { volume.attached = false; volume.state = 'detached'; }
      if (condition === 'no-operation') delete volume.operation;
      if (condition === 'active') volume.operation!.stage = 'queued';
      if (condition === 'failed') volume.operation!.stage = 'failed';
      if (condition === 'unseeded') volume.seeded = false;
      if (condition === 'incoherent-state') volume.state = 'detached';
      volumes.init = async () => {};
      volumes.assertLiveRecoveryResolved = () => {};
      volumes.isRecoveryBlocked = () => false;
      volumes.store.forWorker = () => [volume];
      (f.manager as any).managedNetworkContext = async () => undefined;
      Docker.prototype.getContainer = () => ({ inspect: async () => { inspected = true; throw new Error('Source inspection sentinel'); } });
      const before = f.store.get(f.record.userId, f.record.id);
      const settled = ['complete-attached', 'complete-detached', 'no-operation'].includes(condition);
      await expect(f.manager.migrateLegacyWorker(f.record.id, async () => {})).rejects.toThrow(
        settled ? 'Source inspection sentinel' : 'Settle managed storage before migration');
      expect(inspected).toBe(settled);
      expect(f.store.get(f.record.userId, f.record.id)).toEqual(before);
    } finally {
      volumes.init = original.init; volumes.assertLiveRecoveryResolved = original.assert;
      volumes.isRecoveryBlocked = original.blocked; volumes.store.forWorker = original.records;
      Docker.prototype.getContainer = getContainer;
      await f.cleanup();
    }
  });

test('private secret-aware rollback start does not waive a changed migration nonce or source ID', async () => {
  const f = await fixture();
  try {
    const marker: WorkerIncusMigration = { nonce: randomUUID(), phase: 'preparing', source: {
      containerId: f.info.containerId, imageId: f.info.imageId, createdAt: f.record.createdAt, wasRunning: true,
    } };
    await f.store.transitionIncusMigration(f.record.userId, f.record.id, undefined, marker);
    await expect((f.manager as any).restartUnlocked(f.record.id, true, { ...marker, nonce: randomUUID() }))
      .rejects.toThrow('rollback restart authority changed');
    f.info.containerId = 'c'.repeat(64);
    await expect((f.manager as any).restartUnlocked(f.record.id, true, marker))
      .rejects.toThrow('rollback restart authority changed');
    f.info.containerId = marker.source.containerId;
    await f.store.updateHostMountAccess(f.record.userId, f.record.id, [], true);
    await expect((f.manager as any).restartUnlocked(f.record.id, true, marker))
      .rejects.toThrow('rollback restart authority changed');
    await expect(f.manager.restart(f.record.id)).rejects.toMatchObject({ code: 'WORKER_MIGRATION_RECOVERY_REQUIRED' });
    expect(f.store.get(f.record.userId, f.record.id)?.incusMigration).toMatchObject({ ...marker });
  } finally { await f.cleanup(); }
});

test('settled attached and detached legacy histories pass the real native staged-device preflight without copying source operations', async () => {
  const f = await fixture(), volumes = useManagedVolumeManager();
  const original = { init: volumes.init, assert: volumes.assertLiveRecoveryResolved, blocked: volumes.isRecoveryBlocked,
    records: volumes.store.forWorker, save: volumes.store.save, preflight: IncusWorkerRuntime.prototype.preflightCanonicalRestore };
  const Docker = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('dockerode');
  const dockerOriginal = { container: Docker.prototype.getContainer, volume: Docker.prototype.getVolume };
  const records = [true, false].map((attached, index): StoredManagedVolume => {
    const id = randomUUID();
    return { id, userId: f.record.userId, workerId: f.record.id, target: '/home/agent/persist-' + index, name: 'persist-' + index,
      dockerName: 'agentor-persist-' + id, purpose: 'persistent-path', storageRuntimeKind: 'legacy-docker', seeded: true,
      attached, state: attached ? 'ready' : 'detached', createdAt: f.record.createdAt, updatedAt: f.record.updatedAt,
      operation: { id: randomUUID(), mode: 'recreate', stage: 'complete' } };
  });
  const baseline = structuredClone(records), saved: StoredManagedVolume[] = [];
  let preflights = 0, attachedSeen: StoredManagedVolume[] = [], detachedSeen: StoredManagedVolume[] = [];
  try {
    await f.store.upsert({ ...f.record, imageRuntimeReference: f.info.imageId });
    const workerBefore = structuredClone(f.store.get(f.record.userId, f.record.id));
    const mounts = [{ Type: 'volume', Name: 'source-workspace', Destination: '/workspace', RW: true },
      { Type: 'volume', Name: 'source-agents', Destination: '/home/agent/.agent-data', RW: true },
      { Type: 'volume', Name: records[0]!.dockerName, Destination: records[0]!.target, RW: true }];
    const source = { Id: f.info.containerId, Name: '/' + f.info.containerName, Created: f.record.createdAt,
      Image: f.info.imageId, State: { Status: 'running', Running: true }, Mounts: mounts,
      Config: { Labels: { 'agentor.id': f.record.id }, Env: ['ENVIRONMENT={"dockerEnabled":false}'] } };
    Docker.prototype.getContainer = (id: string) => ({ inspect: async () => id === source.Id ? structuredClone(source) :
      { Image: 'sha256:' + 'c'.repeat(64), Mounts: [{ Destination: f.dir, Source: f.dir }] } });
    Docker.prototype.getVolume = (name: string) => ({ inspect: async () => {
      if (name === f.info.containerName + '-docker') throw Object.assign(new Error('Absent historical Docker'), { statusCode: 404 });
      return { Name: name, Driver: 'local', CreatedAt: f.record.createdAt, Options: {} };
    } });
    volumes.init = async () => {}; volumes.assertLiveRecoveryResolved = () => {}; volumes.isRecoveryBlocked = () => false;
    volumes.store.forWorker = () => records; volumes.store.save = async volume => { saved.push(structuredClone(volume)); };
    (f.manager as any).managedNetworkContext = async () => undefined;
    (f.manager as any).dockerService = { workerOciImage: () => ({ inspect: async () => ({ Id: f.info.imageId }) }) };
    (f.manager as any).storageManager = { dataHostPath: f.dir,
      getWorkerWorkspaceBind: () => 'source-workspace:/workspace', getWorkerAgentsBind: () => 'source-agents:/home/agent/.agent-data' };
    (f.manager as any).configureIncusImages = () => {};
    (f.manager as any).incusOptionsForWorker = async (_native: ContainerInfo, _start: boolean, _source: unknown, attached: StoredManagedVolume[]) =>
      ({ id: f.record.id, userId: f.record.userId, containerName: f.info.containerName, managedVolumes: attached,
        environmentJson: { dockerEnabled: false } });
    IncusWorkerRuntime.prototype.preflightCanonicalRestore = async (options, _source, detached = []) => {
      preflights++; attachedSeen = structuredClone(options.managedVolumes ?? []); detachedSeen = structuredClone(detached);
      expect(attachedSeen).toHaveLength(1); expect(detachedSeen).toHaveLength(1);
      for (const staged of [...attachedSeen, ...detachedSeen]) {
        expect(staged.operation).toBeUndefined(); expect(staged).toMatchObject({ storageRuntimeKind: 'incus-vm', seeded: false, state: 'pending' });
      }
      const devices = incusManagedRestoreDevices(options, 'approved-pool', options.managedVolumes, detached);
      expect(Object.values(devices).map(device => device.source).sort()).toEqual(records.map(volume => volume.dockerName).sort());
      expect(records).toEqual(baseline); // The source's completed history is still authoritative.
      throw new Error('Validated staged managed-device preflight sentinel');
    };
    await expect(f.manager.migrateLegacyWorker(f.record.id, async () => {})).rejects.toThrow('Validated staged managed-device preflight sentinel');
    expect(preflights).toBe(1); expect(records).toEqual(baseline); expect(saved).toEqual(baseline);
    expect(f.store.get(f.record.userId, f.record.id)).toMatchObject({ ...workerBefore, updatedAt: expect.any(String), incusMigration: undefined });
    expect(f.info.runtimeKind).toBe('legacy-docker'); expect(f.info.status).toBe('running');
    expect([...attachedSeen, ...detachedSeen].map(volume => volume.id).sort()).toEqual(records.map(volume => volume.id).sort());
  } finally {
    volumes.init = original.init; volumes.assertLiveRecoveryResolved = original.assert; volumes.isRecoveryBlocked = original.blocked;
    volumes.store.forWorker = original.records; volumes.store.save = original.save;
    IncusWorkerRuntime.prototype.preflightCanonicalRestore = original.preflight;
    Docker.prototype.getContainer = dockerOriginal.container; Docker.prototype.getVolume = dockerOriginal.volume;
    await f.cleanup();
  }
});
