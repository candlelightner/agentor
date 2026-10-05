import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { ManagedVolumeStore } from '../../orchestrator/server/utils/managed-volume-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';

async function fixture(run: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-instance-detached-fresh-'));
  try {
    const config = { dataDir: root, containerPrefix: 'agentor-worker', incusProject: 'agentor', incusStoragePool: 'default' } as Config;
    const store = new ManagedVolumeStore(root); await store.init();
    const record = await store.create('fixture-owner', randomUUID(), '/srv/retained', undefined, 'incus-vm');
    const installation = await backupInstallationId(root), calls: string[] = [];
    const state: any = { volume: undefined, createdChanges: {} };
    const owned = { name: record.dockerName, type: 'custom', content_type: 'filesystem', project: 'agentor',
      created_at: '2026-10-05T12:00:00.000Z', used_by: [], config: {
        'user.agentor.installation': installation, 'user.agentor.owner': record.userId,
        'user.agentor.id': record.workerId, 'user.agentor.volume-id': record.id, 'user.agentor.target': record.target,
      } };
    const runtime = new IncusManagedVolumeRuntime(config, { client: {
      endpoint: 'https://incus.fixture',
      getCustomVolume: async (pool: string, name: string) => {
        calls.push('lookup'); expect(pool).toBe('default'); expect(name).toBe(record.dockerName);
        if (!state.volume) throw Object.assign(new Error('missing'), { statusCode: 404 });
        return structuredClone(state.volume);
      },
      createCustomVolume: async (pool: string, spec: any) => {
        calls.push('create'); expect(pool).toBe('default'); state.spec = structuredClone(spec);
        state.volume = { ...structuredClone(owned), ...structuredClone(spec), ...state.createdChanges };
        if (state.createError) throw state.createError;
        return {};
      },
      getInstance: async () => { throw new Error('Detached allocation must not mutate or inspect compute'); },
      updateInstanceDevices: async () => { throw new Error('Detached allocation must never attach data'); },
    } } as any);
    await run({ runtime, record, state, owned, calls, store });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('fresh attached default and explicit detached allocation keep exact native metadata and desired state', async () => {
  for (const detached of [false, true]) await fixture(async ({ runtime, record, state, calls, owned, store }) => {
    const value = { ...record, attached: !detached }, before = structuredClone(value);
    const durableBefore = store.get(value.userId, value.id);
    const found = detached ? await runtime.freshRestoreVolume(value, true) : await runtime.freshRestoreVolume(value);
    expect(found).toEqual(state.volume); expect(found.used_by).toEqual([]);
    expect(state.spec).toEqual({ name: value.dockerName, content_type: 'filesystem', config: owned.config });
    expect(value).toEqual(before); expect(store.get(value.userId, value.id)).toEqual(durableBefore);
    expect(value.attached).toBe(!detached); expect(calls).toEqual(['lookup', 'create', 'lookup']);
  });
});

test('invalid modes, identity, attachment or unsettled records reject before any native call', async () => {
  for (const detached of [false, true]) await fixture(async ({ runtime, record, calls, state }) => {
    const base = { ...record, attached: !detached };
    for (const change of [{ attached: detached }, { attached: undefined }, { attached: 'false' },
      { seeded: true }, { seeded: undefined }, { state: 'detached' }, { state: 'ready' },
      { operation: { stage: 'complete' } }, { operation: null }, { incusLive: null },
      { incusLive: { id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment: 'settled' } },
      { id: 'a'.repeat(36), dockerName: 'agentor-persist-' + 'a'.repeat(36) },
      { userId: '../foreign' }, { userId: '' }, { userId: 1 }, { workerId: 'foreign/worker' }, { workerId: undefined },
      { storageRuntimeKind: 'legacy-docker' }]) {
      const candidate = { ...base, ...change }, before = structuredClone(candidate);
      await expect(runtime.freshRestoreVolume(candidate, detached)).rejects.toThrow();
      expect(candidate).toEqual(before); expect(calls).toEqual([]); expect(state.volume).toBeUndefined();
    }
    for (const mode of [null, 'true', 1, {}, []])
      await expect(runtime.freshRestoreVolume(base, mode)).rejects.toThrow(/attachment mode/);
    expect(calls).toEqual([]);
  });
});

test('detached restore refuses existing owned/foreign data and rejects unavailable allocation authority without adoption', async () => {
  for (const foreign of [false, true]) await fixture(async ({ runtime, record, state, owned, calls }) => {
    state.volume = structuredClone(owned);
    if (foreign) state.volume.config['user.agentor.owner'] = 'foreign-owner';
    const before = structuredClone(state.volume), value = { ...record, attached: false };
    await expect(runtime.freshRestoreVolume(value, true)).rejects.toThrow(foreign ? /ownership/ : /fresh pending/);
    expect(state.volume).toEqual(before); expect(calls).toEqual(['lookup']);
  });
  for (const createdChanges of [{ project: 'foreign' }, { created_at: undefined }, { created_at: 'invalid' },
    { used_by: undefined }, { used_by: ['/1.0/instances/foreign?project=agentor'] },
    { config: { 'user.agentor.owner': 'foreign' } }]) await fixture(async ({ runtime, record, state, calls }) => {
    state.createdChanges = createdChanges; const value = { ...record, attached: false }, before = structuredClone(value);
    await expect(runtime.freshRestoreVolume(value, true)).rejects.toThrow();
    expect(value).toEqual(before); expect(calls).toEqual(['lookup', 'create', 'lookup']);
    expect(state.volume).toBeTruthy();
  });
  await fixture(async ({ runtime, record, state, calls }) => {
    state.createError = new Error('lost creation acknowledgement');
    const value = { ...record, attached: false };
    await expect(runtime.freshRestoreVolume(value, true)).rejects.toBe(state.createError);
    expect(calls).toEqual(['lookup', 'create']);
    await expect(runtime.freshRestoreVolume(value, true)).rejects.toThrow(/fresh pending/);
    expect(calls).toEqual(['lookup', 'create', 'lookup']);
  });
});
