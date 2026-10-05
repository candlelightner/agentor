import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInstanceNativeRestoreGroup, rollbackInstanceNativeRestoreGroup,
  type InstanceNativeRestoreGroup, type InstanceNativeRestoreReceipt } from '../../orchestrator/instance-restore-native';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { WorkerStore, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { ManagedVolumeStore, type StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import { loadConfig } from '../../orchestrator/server/utils/config';
import type { IncusCustomVolume } from '../../orchestrator/server/utils/incus-client';

async function fixture(kind: 'stopped' | 'archived' | 'retained' = 'stopped', withManaged = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-native-apply-'));
  const config = { ...loadConfig(), dataDir }, id = randomUUID(), userId = 'apply-' + randomUUID();
  const stamp = '2026-10-05T12:00:00.000Z', incarnation = randomUUID(), nonce = randomUUID();
  const workers = new WorkerStore(dataDir), managed = new ManagedVolumeStore(dataDir);
  await Promise.all([workers.init(), managed.init()]);
  const worker: WorkerRecord = { id, userId, runtimeKind: 'incus-vm', status: kind === 'archived' ? 'archived' : 'active',
    desiredRuntimeStatus: 'stopped', displayName: 'Native restore test', createdAt: stamp, updatedAt: stamp,
    ...(kind === 'archived' ? { archivedAt: stamp } : {}) };
  if (kind !== 'retained') await workers.upsert(worker);
  const volumeId = randomUUID();
  const volume: StoredManagedVolume = { id: volumeId, userId, workerId: id, dockerName: 'agentor-persist-' + volumeId,
    target: '/srv/restored', name: 'Restored data', purpose: 'persistent-path', storageRuntimeKind: 'incus-vm',
    seeded: true, attached: kind !== 'retained', state: kind === 'retained' ? 'detached' : 'ready',
    createdAt: stamp, updatedAt: stamp, ...(kind === 'retained' ? { retainedAfterAccountDeletion: true } : {}) };
  if (withManaged) await managed.save(volume);
  const saved = managed.get(userId, volumeId);
  const descriptor = (role: 'workspace' | 'managed') => ({ name: role === 'managed' ? volume.dockerName : config.containerPrefix + '-' + id + '-workspace',
    kind: role === 'managed' ? 'persistent-path' as const : 'worker-workspace' as const,
    archive: 'verified.tar.gz', sha256: 'a'.repeat(64), size: 100, ownerId: userId, workerId: id });
  const group: InstanceNativeRestoreGroup = { workerId: id, userId,
    ...(kind !== 'retained' ? { worker: workers.get(userId, id)! } : {}),
    core: kind === 'retained' ? {} : { workspace: descriptor('workspace') },
    managed: saved ? [{ record: saved, descriptor: descriptor('managed') }] : [] };
  const options = { id, userId, containerName: config.containerPrefix + '-' + id,
    start: false, recreationNonce: nonce } as IncusWorkerOptions;
  const receipt: InstanceNativeRestoreReceipt = { attempted: false, unsettled: false, volumes: new Map(),
    marker: { nonce, initialCreate: true, importIncomplete: true } };
  const archives = new Map(Object.values(group.core).map(v => [v!.name, '/verified/workspace.tar']));
  for (const v of group.managed) archives.set(v.descriptor.name, '/verified/managed.tar');
  const events: string[] = [], restorers: Array<() => void> = [];
  const patch = (object: any, name: string, implementation: any) => {
    const own = Object.hasOwn(object, name), old = object[name]; object[name] = implementation;
    restorers.push(() => { if (own) object[name] = old; else delete object[name]; });
  };
  const nativeVolume = { name: volume.dockerName, project: config.incusProject, type: 'custom', content_type: 'filesystem',
    created_at: stamp, config: { 'user.agentor.owner': userId }, used_by: ['owned-reference'] } as IncusCustomVolume;
  const freshAuthority = async () => {
    const w = new WorkerStore(dataDir), m = new ManagedVolumeStore(dataDir);
    await Promise.all([w.init(), m.init()]);
    return { worker: w.get(userId, id), records: m.forWorker(userId, id) };
  };
  const assertPending = async () => {
    const state = await freshAuthority();
    if (group.worker) {
      expect(state.worker?.status).toBe('active'); expect(state.worker?.desiredRuntimeStatus).toBe('stopped');
      expect(state.worker?.incusRecreation).toMatchObject({ nonce, initialCreate: true, importIncomplete: true });
    } else expect(state.worker).toBeUndefined();
    for (const record of state.records) { expect(record.seeded).toBe(false); expect(record.state).toBe('pending'); }
  };
  patch(IncusWorkerRuntime.prototype, 'preflightCanonicalRestore', async () => { events.push('preflight'); await assertPending(); });
  patch(IncusWorkerRuntime.prototype, 'createCanonicalRestore', async () => {
    events.push('create'); await assertPending();
    return { config: { 'volatile.uuid': incarnation, 'user.agentor.recreation': nonce } };
  });
  patch(IncusWorkerRuntime.prototype, 'matchesWorkerIdentity', async () => true);
  patch(IncusWorkerRuntime.prototype, 'restoreCanonicalArchives', async (_o: unknown, uuid: string, _c: unknown, validate: () => Promise<void>) => {
    events.push('extract'); expect(uuid).toBe(incarnation); await validate(); await assertPending();
    expect((await freshAuthority()).worker?.incusRecreation?.replacementIncarnation ?? incarnation).toBe(incarnation);
  });
  patch(IncusWorkerRuntime.prototype, 'finishCanonicalRestore', async (_o: unknown, uuid: string, validate: () => Promise<void>, activation: string) => {
    events.push('promote'); expect(uuid).toBe(incarnation); expect(activation).toBe('stopped'); await validate();
    for (const record of (await freshAuthority()).records) expect(record.seeded).toBe(true);
  });
  patch(IncusWorkerRuntime.prototype, 'remove', async () => { events.push('remove-compute'); nativeVolume.used_by = []; });
  patch(IncusWorkerRuntime.prototype, 'removeStorage', async () => {
    events.push('remove-core');
    if (kind === 'retained' && !events.includes('rollback-compute'))
      for (const record of (await freshAuthority()).records) expect(record.seeded).toBe(false);
  });
  patch(IncusWorkerRuntime.prototype, 'start', async () => { events.push('start'); throw new Error('Controlled apply must not activate services'); });
  patch(IncusWorkerRuntime.prototype, 'rollbackRecreation', async (_o: unknown, marker: unknown) => {
    events.push('rollback-compute'); expect(marker).toEqual(receipt.marker); nativeVolume.used_by = [];
  });
  patch(IncusManagedVolumeRuntime.prototype, 'inspectVolume', async () => { events.push('inspect-managed'); return structuredClone(nativeVolume); });
  patch(IncusManagedVolumeRuntime.prototype, 'delete', async () => { events.push('delete-managed'); });
  const validateJob = async () => { events.push('job-proof'); };
  return { config, group, options, receipt, archives, incarnation, events, patch, nativeVolume, freshAuthority,
    apply: (validate = validateJob) => applyInstanceNativeRestoreGroup({ config, group, options, receipt, archives, validateJob: validate }),
    rollback: () => rollbackInstanceNativeRestoreGroup(config, group, options, receipt, validateJob),
    cleanup: async () => { for (const restore of restorers.reverse()) restore(); await rm(dataDir, { recursive: true, force: true }); } };
}

for (const kind of ['stopped', 'archived', 'retained'] as const) test(`native controlled apply preserves ${kind} recovery authority without whole-job completion`, async () => {
  const f = await fixture(kind); try {
    await f.apply(); const state = await f.freshAuthority();
    expect(f.receipt.attempted).toBe(true); expect(f.receipt.unsettled).toBe(false);
    expect(f.receipt.incarnation).toBe(f.incarnation); expect(f.receipt.volumes.size).toBe(1);
    expect(state.records[0]?.seeded).toBe(true);
    if (kind === 'retained') {
      expect(state.worker).toBeUndefined(); expect(state.records[0]?.state).toBe('detached');
      expect(f.events.indexOf('remove-core')).toBeGreaterThan(f.events.indexOf('extract'));
      expect(f.events).not.toContain('promote');
    } else {
      expect(state.worker?.incusRecreation).toMatchObject({ importIncomplete: true, replacementIncarnation: f.incarnation });
      expect(state.worker?.status).toBe('active'); // Original archive intent is committed only by whole-job completion.
      expect(f.events).toContain('promote');
      expect(f.events.includes('remove-compute')).toBe(kind === 'archived'); expect(f.events).not.toContain('remove-core');
    }
    expect(f.events).not.toContain('start'); expect(f.events).not.toContain('complete-job');
  } finally { await f.cleanup(); }
});

test('acknowledged UUID is captured before a fallible durable replacement write', async () => {
  const f = await fixture('stopped', false); try {
    f.patch(WorkerStore.prototype, 'transitionIncusRecreation', async () => { throw new Error('record write failed'); });
    await expect(f.apply()).rejects.toThrow('record write failed');
    expect(f.receipt.incarnation).toBe(f.incarnation); expect(f.receipt.marker.replacementIncarnation).toBe(f.incarnation);
    expect(f.receipt.unsettled).toBe(false); expect((await f.freshAuthority()).worker?.incusRecreation?.importIncomplete).toBe(true);
    await f.rollback(); expect(f.events).toContain('rollback-compute'); expect(f.events).not.toContain('extract');
  } finally { await f.cleanup(); }
});

for (const failure of ['create', 'extract', 'promote', 'remove-compute'] as const) test(`unknown native ${failure} leaves durable authority and denies rollback submission`, async () => {
  const f = await fixture(failure === 'remove-compute' ? 'archived' : 'stopped'); try {
    const method = { create: 'createCanonicalRestore', extract: 'restoreCanonicalArchives',
      promote: 'finishCanonicalRestore', 'remove-compute': 'remove' }[failure];
    f.patch(IncusWorkerRuntime.prototype, method, async () => { f.events.push('unknown-' + failure); throw new Error('Lost native reply'); });
    await expect(f.apply()).rejects.toThrow('Lost native reply');
    const state = await f.freshAuthority(); expect(state.worker?.incusRecreation?.importIncomplete).toBe(true);
    expect(f.receipt.attempted).toBe(true); expect(f.receipt.unsettled).toBe(true);
    const prior = [...f.events];
    await expect(f.rollback()).rejects.toThrow('Unsettled native restore retains installed authority');
    expect(f.events).toEqual(prior);
  } finally { await f.cleanup(); }
});

test('acknowledged rollback removes exact native resources before caller data rollback and never clears records itself', async () => {
  const f = await fixture(); try {
    await f.apply(); await f.rollback(); f.events.push('caller-rollback-data');
    expect(f.events.indexOf('rollback-compute')).toBeLessThan(f.events.indexOf('remove-core'));
    expect(f.events.indexOf('remove-core')).toBeLessThan(f.events.indexOf('delete-managed'));
    expect(f.events.indexOf('delete-managed')).toBeLessThan(f.events.indexOf('caller-rollback-data'));
    expect((await f.freshAuthority()).worker?.incusRecreation?.importIncomplete).toBe(true);
  } finally { await f.cleanup(); }
});

test('lost rollback delete or changed native creation identity prevents caller data rollback', async () => {
  for (const failure of ['delete', 'identity']) {
    const f = await fixture(); try {
      await f.apply();
      if (failure === 'identity') f.nativeVolume.created_at = '2026-10-06T12:00:00.000Z';
      else f.patch(IncusManagedVolumeRuntime.prototype, 'delete', async () => { throw new Error('Lost delete acknowledgement'); });
      await expect((async () => { await f.rollback(); f.events.push('caller-rollback-data'); })())
        .rejects.toThrow(failure === 'identity' ? 'creation identity changed' : 'Lost delete acknowledgement');
      expect(f.events).not.toContain('caller-rollback-data');
      expect((await f.freshAuthority()).worker?.incusRecreation?.importIncomplete).toBe(true);
      if (failure === 'delete') expect(f.receipt.unsettled).toBe(true);
    } finally { await f.cleanup(); }
  }
});

test('fresh apply authority detects a removed owner or changed managed partition before native create', async () => {
  for (const drift of ['removed-owner', 'managed-record', 'extra-managed']) {
    const f = await fixture(); try {
      f.patch(IncusWorkerRuntime.prototype, 'preflightCanonicalRestore', async () => {
        f.events.push('preflight');
        if (drift === 'removed-owner') {
          await rm(join(f.config.dataDir, 'users', f.group.userId), { recursive: true });
        } else {
          const store = new ManagedVolumeStore(f.config.dataDir); await store.init();
          const current = store.get(f.group.userId, f.group.managed[0]!.record.id)!;
          const id = randomUUID();
          await store.save(drift === 'managed-record' ? { ...current, target: '/srv/changed' }
            : { ...current, id, dockerName: 'agentor-persist-' + id, target: '/srv/additional' });
        }
      });
      await expect(f.apply()).rejects.toThrow('restore authority changed');
      expect(f.receipt.attempted).toBe(false); expect(f.events).not.toContain('create');
    } finally { await f.cleanup(); }
  }
});

test('rollback rechecks removed owner and whole-worker managed authority before any destructive boundary', async () => {
  for (const drift of ['removed-owner', 'managed-record', 'extra-managed']) {
    const f = await fixture(); try {
      await f.apply();
      if (drift === 'removed-owner') await rm(join(f.config.dataDir, 'users', f.group.userId), { recursive: true });
      else {
        const store = new ManagedVolumeStore(f.config.dataDir); await store.init();
        const current = store.get(f.group.userId, f.group.managed[0]!.record.id)!, id = randomUUID();
        await store.save(drift === 'managed-record' ? { ...current, name: 'Changed grant' }
          : { ...current, id, dockerName: 'agentor-persist-' + id, target: '/srv/additional', attached: false, state: 'detached' });
      }
      await expect(f.rollback()).rejects.toThrow('Installed native rollback authority changed');
      expect(f.events).not.toContain('rollback-compute'); expect(f.events).not.toContain('remove-core');
      expect(f.events).not.toContain('delete-managed');
    } finally { await f.cleanup(); }
  }
});

test('record drift after acknowledged compute rollback fences core deletion and retains uncertainty', async () => {
  const f = await fixture(); try {
    await f.apply();
    f.patch(IncusWorkerRuntime.prototype, 'rollbackRecreation', async () => {
      f.events.push('rollback-compute');
      const store = new WorkerStore(f.config.dataDir); await store.init();
      await store.upsert({ ...store.get(f.group.userId, f.group.workerId)!, displayName: 'Changed restore authority' });
    });
    await expect(f.rollback()).rejects.toThrow('Installed native rollback authority changed');
    expect(f.events).not.toContain('remove-core'); expect(f.events).not.toContain('delete-managed');
    expect(f.receipt.unsettled).toBe(true);
  } finally { await f.cleanup(); }
});

test('initial job callback cannot authorize overwriting changed or removed installed workers from cached snapshots', async () => {
  for (const change of ['changed', 'removed']) {
    const f = await fixture(); try {
      let callbacks = 0;
      await expect(f.apply(async () => {
        callbacks++;
        if (callbacks === 1) {
          const store = new WorkerStore(f.config.dataDir); await store.init();
          if (change === 'removed') await store.delete(f.group.userId, f.group.workerId);
          else await store.upsert({ ...store.get(f.group.userId, f.group.workerId)!, displayName: 'Concurrent installed edit' });
        }
      })).rejects.toThrow('Installed native worker authority differs');
      const state = await f.freshAuthority();
      expect(state.worker?.displayName).toBe(change === 'removed' ? undefined : 'Concurrent installed edit');
      expect(state.worker?.incusRecreation).toBeUndefined();
      expect(state.records[0]?.seeded).toBe(true); expect(state.records[0]?.state).toBe('ready');
      expect(f.receipt.attempted).toBe(false); expect(f.events).toEqual([]);
    } finally { await f.cleanup(); }
  }
});

test('each pending managed write freshly observes later installed record changes during job callbacks', async () => {
  const f = await fixture(); try {
    const store = new ManagedVolumeStore(f.config.dataDir); await store.init();
    const id = randomUUID(), second = { ...f.group.managed[0]!.record, id,
      dockerName: 'agentor-persist-' + id, target: '/srv/second' };
    await store.save(second);
    f.group.managed.push({ record: store.get(f.group.userId, id)!,
      descriptor: { ...f.group.managed[0]!.descriptor, name: second.dockerName } });
    let callbacks = 0;
    await expect(f.apply(async () => {
      callbacks++;
      if (callbacks === 3) {
        const fresh = new ManagedVolumeStore(f.config.dataDir); await fresh.init();
        await fresh.save({ ...fresh.get(f.group.userId, id)!, name: 'Concurrent managed edit' });
      }
    })).rejects.toThrow('Installed native managed authority differs');
    const records = (await f.freshAuthority()).records;
    const edited = records.find(record => record.id === id)!;
    expect(edited.name).toBe('Concurrent managed edit'); expect(edited.seeded).toBe(true); expect(edited.state).toBe('ready');
    expect(records.find(record => record.id !== id)?.state).toBe('pending');
    expect(f.receipt.attempted).toBe(false); expect(f.events).toEqual([]);
  } finally { await f.cleanup(); }
});
