import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagedVolumeStore, PersistencePolicyStore, publicVolume, validatePersistenceTarget, managedVolumeRuntimeKind } from '../../orchestrator/server/utils/managed-volume-store';
import { ManagedVolumeRuntime } from '../../orchestrator/server/utils/managed-volume-runtime';
import { ManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';

test('persistent paths reject protected roots, aliases and credentials', () => {
  for (const path of ['/', '/etc/data', '/home', '/home/agent', '/var', '/proc/1/root', '/usr/local', '/home/agent/.codex', '/data/../etc', '/data//x', '/data/', 'relative'])
    expect(() => validatePersistenceTarget(path), path).toThrow();
  for (const path of ['/data', '/opt/models', '/home/agent/cache', '/var/lib/myapp'])
    expect(validatePersistenceTarget(path)).toBe(path);
});

test('volume records survive restart and are owner scoped, idempotent and non-overlapping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-store-'));
  try {
    const store = new ManagedVolumeStore(dir); await store.init();
    const first = await store.create('owner-a', 'worker-a', '/opt/models');
    expect((await store.create('owner-a', 'worker-a', '/opt/models')).id).toBe(first.id);
    await expect(store.create('owner-a', 'worker-a', '/opt/models/cache')).rejects.toMatchObject({ statusCode: 409 });
    expect(store.get('owner-b', first.id)).toBeUndefined();
    const second = await store.create('owner-b', 'worker-b', '/opt/models');
    expect(first.dockerName).not.toBe(second.dockerName);
    expect(publicVolume(first)).not.toHaveProperty('dockerName');
    expect(publicVolume(first)).not.toHaveProperty('seeded');
    const reloaded = new ManagedVolumeStore(dir); await reloaded.init();
    expect(reloaded.get('owner-a', first.id)).toMatchObject({ target: '/opt/models', seeded: false, attached: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('managed storage backend is durable internal authority and old records remain Docker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-runtime-'));
  try {
    const store = new ManagedVolumeStore(dir); await store.init();
    const legacy = await store.create('legacy-owner', 'legacy-worker', '/opt/legacy');
    expect(legacy.storageRuntimeKind).toBeUndefined();
    expect(managedVolumeRuntimeKind(legacy)).toBe('legacy-docker');
    const vm = await store.create('vm-owner', 'vm-worker', '/opt/vm', undefined, 'incus-vm');
    expect(managedVolumeRuntimeKind(vm)).toBe('incus-vm');
    expect(publicVolume(vm)).not.toHaveProperty('storageRuntimeKind');
    await store.retainForDeletedOwner(vm.userId);
    await rm(join(dir, 'users', vm.userId), { recursive: true, force: true });
    const reloaded = new ManagedVolumeStore(dir); await reloaded.init();
    expect(managedVolumeRuntimeKind(reloaded.get(vm.userId, vm.id)!)).toBe('incus-vm');
    expect(managedVolumeRuntimeKind(reloaded.get(legacy.userId, legacy.id)!)).toBe('legacy-docker');
    await expect(reloaded.save({ ...vm, storageRuntimeKind: 'foreign' as any })).rejects.toThrow('storage runtime');
    expect(managedVolumeRuntimeKind(reloaded.get(vm.userId, vm.id)!)).toBe('incus-vm');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('self-service, recreation and privileged helper authorizations default off and are independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-persistence-policy-'));
  try {
    const store = new PersistencePolicyStore(dir); await store.init();
    expect(store.policy('owner-a', 'worker-a')).toMatchObject({ selfService: false, allowSelfRecreate: false, allowLiveMount: false });
    await store.configure('owner-a', 'worker-a', { selfService: true });
    expect(store.policy('owner-a', 'worker-a')).toMatchObject({ selfService: true, allowSelfRecreate: false, allowLiveMount: false });
    expect(store.policy('owner-a', 'worker-b').selfService).toBe(false);
    await expect(store.configure('owner-a', 'worker-a', { allowLiveMount: 'true' })).rejects.toThrow();
    await expect(store.configure('owner-a', 'worker-a', { userId: 'owner-b' })).rejects.toThrow();
    await expect(store.configure('owner-a', 'worker-a', { selfService: false, allowLiveMount: 'invalid' })).rejects.toThrow();
    expect(store.policy('owner-a', 'worker-a').selfService).toBe(true);
    const reloaded = new PersistencePolicyStore(dir); await reloaded.init();
    expect(reloaded.policy('owner-a', 'worker-a').selfService).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Incus live intent survives reload, remains private and cannot be forgotten or removed with its owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-incus-live-intent-'));
  try {
    const store = new ManagedVolumeStore(dir); await store.init();
    const v = await store.create('live-owner', 'live-worker', '/opt/models', undefined, 'incus-vm');
    const intent = { id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment: 'unknown' as const };
    await store.save({ ...v, incusLive: intent });
    const reloaded = new ManagedVolumeStore(dir); await reloaded.init();
    expect(reloaded.get(v.userId, v.id)?.incusLive).toEqual(intent);
    expect(publicVolume(reloaded.get(v.userId, v.id)!)).not.toHaveProperty('incusLive');
    await expect(reloaded.forget(v.userId, v.id)).rejects.toThrow('unresolved');
    await expect(reloaded.removeForUser(v.userId)).rejects.toThrow('unresolved');
    await expect(reloaded.retainForDeletedOwner(v.userId)).rejects.toThrow('recovery');
    expect(reloaded.get(v.userId, v.id)?.incusLive).toEqual(intent);
    for (const bad of [null, {}, { ...intent, id: 'not-a-uuid' }, { ...intent, attachment: 'accepted' },
      { ...intent, operation: `/1.0/operations/${randomUUID()}` }, { ...intent, attachment: 'settled', operation: 'https://foreign/operation' },
      { ...intent, authority: 'discard-source' }, { ...intent, bootId: 'old-boot' }, { ...intent, rollback: false }])
      await expect(reloaded.save({ ...v, incusLive: bad as any })).rejects.toThrow('recovery intent');
    for (const fields of [{ storageRuntimeKind: undefined }, { liveContainerId: 'container' }, { previousRestartPolicy: { Name: 'always' } }, { purpose: 'legacy-backup-path' }])
      await expect(reloaded.save({ ...v, incusLive: intent, ...fields } as any)).rejects.toThrow('recovery intent');
    const accepted = { ...intent, attachment: 'accepted' as const, operation: `/1.0/operations/${randomUUID()}` };
    await expect(reloaded.save({ ...v, seeded: true, incusLive: { ...accepted, rollback: true } })).rejects.toThrow('recovery intent');
    await reloaded.save({ ...v, incusLive: accepted });
    await reloaded.save({ ...v, incusLive: { ...accepted, attachment: 'settled' }, seeded: true });
    const committed = new ManagedVolumeStore(dir); await committed.init();
    expect(committed.get(v.userId, v.id)).toMatchObject({ seeded: true, incusLive: { attachment: 'settled' } });
    await expect(committed.forget(v.userId, v.id)).rejects.toThrow('unresolved');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a missing populated volume is never silently replaced by empty storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-missing-'));
  try {
    const store = new ManagedVolumeStore(dir); await store.init();
    const record = await store.create('owner-a', 'worker-a', '/opt/models');
    record.seeded = true;
    let creations = 0;
    const runtime = new ManagedVolumeRuntime({
      getVolume: () => ({ inspect: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); } }),
      createVolume: async () => { creations++; },
    } as any, dir);
    await expect(runtime.ensureVolume(record)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no empty replacement') });
    expect(creations).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('startup quarantines only the worker whose storage recovery fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-volume-quarantine-'));
  try {
    const manager = new ManagedVolumeManager(dir, {} as any); await manager.init();
    const broken = await manager.store.create('owner-a', 'broken-worker', '/opt/models');
    const healthy = await manager.store.create('owner-a', 'healthy-worker', '/opt/models');
    const visited: string[] = [];
    manager.recoverWorker = async (_owner, worker) => {
      visited.push(worker);
      if (worker === 'broken-worker') throw new Error('internal detail must not escape');
    };
    await manager.recoverStartup();
    expect(visited).toEqual(expect.arrayContaining(['broken-worker', 'healthy-worker']));
    expect(manager.isRecoveryBlocked('broken-worker')).toBe(true);
    expect(manager.isRecoveryBlocked('healthy-worker')).toBe(false);
    expect(manager.store.get('owner-a', broken.id)).toMatchObject({ state: 'failed' });
    expect(JSON.stringify(publicVolume(manager.store.get('owner-a', broken.id)!))).not.toContain('internal detail');
    expect(manager.store.get('owner-a', healthy.id)).toMatchObject({ state: 'pending' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deleted-account volume records survive removal of the owner directory and a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-retained-volumes-'));
  try {
    const store = new ManagedVolumeStore(dir); await store.init();
    const v = await store.create('removed-owner', 'worker-a', '/opt/models');
    await store.retainForDeletedOwner('removed-owner');
    await rm(join(dir, 'users', 'removed-owner'), { recursive: true, force: true });
    const restarted = new ManagedVolumeStore(dir); await restarted.init();
    expect(restarted.get('removed-owner', v.id)).toMatchObject({ retainedAfterAccountDeletion: true, attached: false, dockerName: v.dockerName });
    expect(restarted.listUserIds()).not.toContain('removed-owner');
    await restarted.forget('removed-owner', v.id);
    const afterDeletion = new ManagedVolumeStore(dir); await afterDeletion.init();
    expect(afterDeletion.list()).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
