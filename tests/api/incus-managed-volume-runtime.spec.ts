import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncusManagedVolumeRuntime, INCUS_PERSISTENCE_TARGET_CHECK } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { ManagedVolumeStore } from '../../orchestrator/server/utils/managed-volume-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { ManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import type { Config } from '../../orchestrator/server/utils/config';

async function fixture(run: (runtime: IncusManagedVolumeRuntime, v: any, calls: string[], state: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'incus-managed-adapter-'));
  const config = { dataDir: root, containerPrefix: 'agentor-worker', incusProject: 'agentor', incusStoragePool: 'default' } as Config;
  const store = new ManagedVolumeStore(root); await store.init();
  const v = await store.create('owner', 'worker', '/opt/models', undefined, 'incus-vm');
  const installation = await backupInstallationId(root), calls: string[] = [];
  const state: any = { volume: undefined, instance: { name: 'agentor-worker-worker', status: 'Running',
    config: { 'volatile.uuid': 'original' }, devices: {} } };
  const runtime = new IncusManagedVolumeRuntime(config, {
    matchesWorkerIdentity: async () => true,
    stop: async (_owner: any, uuid: string) => { calls.push('stop:' + uuid); state.instance.status = 'Stopped'; },
    client: {
      endpoint: 'https://incus.test',
      getInstance: async () => state.instance,
      getCustomVolume: async () => {
        if (state.lookupFailure) throw Object.assign(new Error('unavailable'), { statusCode: 503 });
        if (!state.volume) throw Object.assign(new Error('missing'), { statusCode: 404 }); return state.volume;
      },
      createCustomVolume: async (_pool: string, spec: any) => { calls.push('create-volume'); state.volume = { ...spec, type: 'custom', used_by: [] }; },
      deleteCustomVolume: async () => { calls.push('delete-volume'); state.volume = undefined; },
      updateInstanceDevices: async (_name: string, devices: any) => { calls.push('devices'); state.instance.devices = devices; },
      startInstance: async () => { calls.push('start'); state.instance.status = 'Running'; if (state.startFailure) throw new Error('lost start response'); },
      exec: async (_name: string, command: string[]) => {
        const copying = command[0] === 'timeout' && command[1] === '150';
        calls.push(copying ? 'copy' : 'exec');
        if (copying && state.copyFailure) return { returnCode: 1, stderr: 'ENOSPC', stdout: '' };
        return { returnCode: 0, stderr: '', stdout: '' };
      },
    },
  } as any);
  state.ownedVolume = { name: v.dockerName, type: 'custom', content_type: 'filesystem', used_by: [], config: {
    'user.agentor.installation': installation, 'user.agentor.owner': v.userId, 'user.agentor.id': v.workerId,
    'user.agentor.volume-id': v.id, 'user.agentor.target': v.target } };
  try { await run(runtime, v, calls, state); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('Incus storage refuses missing seeded data, wrong backend and unavailable or foreign identity without allocating', async () => {
  await fixture(async (runtime, v, calls, state) => {
    await expect(runtime.ensureVolume({ ...v, seeded: true })).rejects.toThrow('no empty replacement');
    await expect(runtime.ensureVolume({ ...v, storageRuntimeKind: undefined })).rejects.toThrow('backend');
    for (const key of ['user.agentor.installation', 'user.agentor.owner', 'user.agentor.id', 'user.agentor.volume-id', 'user.agentor.target']) {
      state.volume = { ...state.ownedVolume, config: { ...state.ownedVolume.config, [key]: 'foreign' } };
      await expect(runtime.ensureVolume(v)).rejects.toThrow('ownership');
    }
    for (const field of [{ type: 'image' }, { content_type: 'block' }, { name: 'foreign' },
      { used_by: undefined }, { used_by: null },
      { used_by: ['/1.0/instances/foreign?project=agentor'] }, { used_by: ['/1.0/instances/agentor-worker-worker?project=foreign'] }]) {
      state.volume = { ...state.ownedVolume, ...field };
      await expect(runtime.ensureVolume(v)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
    state.lookupFailure = true;
    await expect(runtime.ensureVolume(v)).rejects.toThrow('unavailable');
    expect(calls).toEqual([]); state.lookupFailure = false;
    state.volume = state.ownedVolume;
    await expect(runtime.inspect(v.userId, v.workerId, 'incus:wrong')).rejects.toThrow('incarnation');
    state.instance.config['volatile.uuid'] = '';
    await expect(runtime.inspect(v.userId, v.workerId, 'worker-name')).rejects.toThrow('incarnation');
  });
});

test('a failed seeded-store write can retry only exact-owned detached staging, preserving the original source', async () => {
  await fixture(async (runtime, v, calls, state) => {
    await expect(runtime.seed('incus:original', v, async () => { throw new Error('persistence failure'); })).rejects.toThrow('persistence failure');
    expect(v.seeded).toBe(false);
    await runtime.seed('incus:original', v, async () => { calls.push('commit'); v.seeded = true; });
    expect(v.seeded).toBe(true); expect(state.instance.config['volatile.uuid']).toBe('original');
    expect(calls.filter(call => call === 'copy')).toHaveLength(2);
    expect(calls.filter(call => call === 'delete-volume')).toHaveLength(1);
    expect(calls.at(-1)).toBe('stop:original');
  });
});

test('manager storage backend survives missing WorkerRecord and never probes Docker for retained Incus data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-manager-backend-'));
  try {
    const manager = new ManagedVolumeManager(root, new Proxy({}, { get: () => () => { throw new Error('Docker must not be called'); } }) as any);
    await manager.init();
    const v = await manager.store.create('retained-incus-owner', 'retained-incus-worker', '/opt/retained', undefined, 'incus-vm');
    const calls: string[] = [];
    (manager as any).incus = {
      ensureVolume: async () => { calls.push('ensure'); },
      seed: async (_handle: string, record: any, commit: () => Promise<void>) => {
        expect(record.seeded).toBe(false); calls.push('seed'); await commit();
      },
      deviceKey: () => 'm123456',
      inspectVolume: async () => ({ used_by: [] }),
    };
    await manager.prepare({ id: v.workerId, userId: v.userId, containerId: 'incus:captured' });
    expect(manager.store.get(v.userId, v.id)?.seeded).toBe(true);
    await manager.recoverWorker(v.userId, v.workerId);
    await manager.workerDeleted(v.userId, v.workerId);
    await manager.retainDeletedOwner(v.userId);
    expect(manager.store.get(v.userId, v.id)).toMatchObject({ seeded: true, attached: false, storageRuntimeKind: 'incus-vm', retainedAfterAccountDeletion: true });
    expect(calls).toContain('seed'); expect(calls).toContain('ensure');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('current compute boot repair ignores unseeded deferred paths but verifies mounted deferred detachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-manager-current-layout-'));
  try {
    const manager = new ManagedVolumeManager(root, {} as any); await manager.init();
    const v = await manager.store.create('layout-owner', 'layout-worker', '/opt/deferred', undefined, 'incus-vm');
    const actual: any = { devices: {} }, calls: string[] = [];
    (manager as any).incus = {
      inspect: async () => actual, deviceKey: () => 'm123456',
      matchesDevice: (device: any) => device?.source === v.dockerName && device?.path === v.target,
      ensureVolume: async () => { calls.push('ensure'); },
    };
    expect(await manager.currentIncusVolumes(v.userId, v.workerId, 'incus:current')).toEqual([]);
    expect(calls).toEqual([]);
    v.seeded = true; v.attached = false; await manager.store.save(v);
    actual.devices.m123456 = { source: v.dockerName, path: v.target };
    expect(await manager.currentIncusVolumes(v.userId, v.workerId, 'incus:current')).toEqual([expect.objectContaining({ id: v.id, attached: true, seeded: true })]);
    expect(manager.store.get(v.userId, v.id)?.attached).toBe(false);
    actual.devices.m123456.path = '/run/staging';
    await expect(manager.currentIncusVolumes(v.userId, v.workerId, 'incus:current')).rejects.toThrow('interrupted');
    delete actual.devices.m123456; v.attached = true; await manager.store.save(v);
    await expect(manager.currentIncusVolumes(v.userId, v.workerId, 'incus:current')).rejects.toThrow('not declared');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Incus deletion and staging cleanup require exact ownership and authoritative empty references', async () => {
  await fixture(async (runtime, v, calls, state) => {
    state.volume = { ...state.ownedVolume, used_by: ['/1.0/instances/agentor-worker-worker?project=agentor'] };
    await expect(runtime.delete(v)).rejects.toThrow('referenced');
    await expect(runtime.removeStaging(v)).rejects.toThrow('attached');
    await expect(runtime.removeStaging({ ...v, seeded: true })).rejects.toThrow('Populated');
    expect(calls).toEqual([]);
    state.volume.used_by = [];
    await runtime.delete(v); expect(calls).toEqual(['delete-volume']);
  });
});

test('Incus seeding saves authority after copy and stops only the captured retained incarnation', async () => {
  await fixture(async (runtime, v, calls, state) => {
    await runtime.seed('incus:original', v, async () => { calls.push('commit'); v.seeded = true; });
    expect(calls.indexOf('commit')).toBeGreaterThan(calls.indexOf('copy'));
    expect(calls.at(-1)).toBe('stop:original');
    expect(v.seeded).toBe(true); expect(state.volume).toBeTruthy();
    expect(state.instance.config['volatile.uuid']).toBe('original');
  });
});

test('lost VM start, ENOSPC copy and seeded-store failure preserve original root and non-authoritative staging', async () => {
  for (const failure of ['start', 'copy', 'commit']) await fixture(async (runtime, v, calls, state) => {
    state.startFailure = failure === 'start'; state.copyFailure = failure === 'copy';
    await expect(runtime.seed('incus:original', v, async () => { throw new Error('seeded store unavailable'); })).rejects.toThrow();
    expect(v.seeded).toBe(false); expect(state.volume).toBeTruthy();
    expect(state.instance.config['volatile.uuid']).toBe('original');
    expect(state.instance.status).toBe('Stopped'); expect(calls.at(-1)).toBe('stop:original');
    expect(calls).not.toContain('delete-volume');
  });
});

test('staging key collision and declared overlap fail before stopping or changing storage', async () => {
  await fixture(async (runtime, v, calls, state) => {
    state.instance.devices[runtime.deviceKey(v)] = { type: 'disk', path: '/foreign', source: 'foreign' };
    await expect(runtime.seed('incus:original', v, async () => {})).rejects.toThrow('conflicts');
    state.instance.devices = { existing: { type: 'disk', path: '/opt/models/nested', source: 'other' } };
    await expect(runtime.validateTarget(v.userId, v.workerId, 'incus:original', v.target)).rejects.toThrow('overlaps');
    expect(calls).toEqual([]);
  });
});

test('actual guest path validator rejects symlink components and decodes mountinfo spaces and octal escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-path-proof-'));
  try {
    const target = join(root, 'directory with spaces'); await mkdir(target);
    const mountinfo = join(root, 'mountinfo');
    const script = INCUS_PERSISTENCE_TARGET_CHECK.replace("'/proc/self/mountinfo'", JSON.stringify(mountinfo));
    const run = (path = target) => execFileSync('python3', ['-c', script, path, '']);
    await writeFile(mountinfo, `1 0 0:1 / / rw - ext4 /dev/root rw\n`);
    expect(() => run()).not.toThrow();
    await symlink(target, join(root, 'alias'));
    expect(() => run(join(root, 'alias/child'))).toThrow();
    for (const path of [target, join(target, 'nested'), root]) {
      await writeFile(mountinfo, `1 0 0:1 / ${path.replaceAll(' ', '\\040')} rw - ext4 /dev/disk rw\n`);
      expect(() => run()).toThrow();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
