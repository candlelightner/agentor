import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLegacyManagedMigration } from '../../orchestrator/server/utils/legacy-incus-managed-migration';
import { persistentPathVolumeName } from '../../orchestrator/server/utils/persistent-backup-paths';
import { ManagedVolumeStore, type StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import { incusManagedVolumeDeviceKey, incusManagedRestoreDevices, IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { planPortableManagedVolumeCapture } from '../../orchestrator/server/utils/portable-managed-volume-plan';
import type { Config } from '../../orchestrator/server/utils/config';

function fixture() {
  const owner = { id: randomUUID(), userId: randomUUID() };
  const sources: StoredManagedVolume[] = [true, false].map((attached, i) => ({
    id: randomUUID(), userId: owner.userId, workerId: owner.id, target: '/opt/retained-' + i,
    name: 'Retained ' + i, purpose: 'legacy-backup-path', attached, seeded: true,
    state: attached ? 'ready' : 'detached', dockerName: persistentPathVolumeName(owner.id, '/opt/retained-' + i),
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    operation: { id: randomUUID(), mode: 'recreate', stage: 'complete' },
  }));
  return { owner, sources };
}

test('legacy names normalize only fresh destination copies and persist strict native lifecycle records', async () => {
  const { owner, sources } = fixture(), original = structuredClone(sources);
  const native = prepareLegacyManagedMigration(owner, sources);
  const devices = incusManagedRestoreDevices(owner, 'pool', native.filter(v => v.attached), native.filter(v => !v.attached));
  expect(Object.values(devices).map(d => d.source).sort()).toEqual(native.map(v => 'agentor-persist-' + v.id).sort());
  const root = await mkdtemp(join(tmpdir(), 'legacy-managed-normalization-'));
  try {
    const store = new ManagedVolumeStore(root); await store.init();
    for (const v of native) {
      expect(v).toMatchObject({ purpose: 'persistent-path', storageRuntimeKind: 'incus-vm', seeded: false, state: 'pending' });
      expect(v.operation).toBeUndefined(); expect(incusManagedVolumeDeviceKey(v)).toMatch(/^m[a-f0-9]{6}$/);
      v.seeded = true; v.state = v.attached ? 'ready' : 'detached'; await store.save(v);
      const runtime = new IncusManagedVolumeRuntime({} as Config, {} as any);
      expect(runtime.device(v)).toMatchObject({ type: 'disk', source: 'agentor-persist-' + v.id, path: v.target });
    }
    const reloaded = new ManagedVolumeStore(root); await reloaded.init();
    expect(reloaded.forWorker(owner.userId, owner.id).map(v => v.dockerName).sort()).toEqual(native.map(v => v.dockerName).sort());
    const capture = planPortableManagedVolumeCapture(native.map(v => ({ ...v, volumeId: v.id,
      backend: 'incus-vm' as const, nativeAuthorityVerified: true, physicalExists: true,
      mountSourceVerified: true, mountDestinationVerified: true, operationDrift: false, recoveryDrift: false })));
    expect(capture.items).toHaveLength(1);
    expect(capture.items[0]!.source).toEqual({ volumeId: native[0]!.id, dockerName: native[0]!.dockerName });
    expect(capture.exclusions).toEqual([{ target: native[1]!.target, name: native[1]!.name, reason: 'detached' }]);
    expect(JSON.stringify(capture.items[0]!.entry)).not.toContain(sources[0]!.dockerName);
    expect(sources).toEqual(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const invalid of ['worker', 'owner', 'name', 'purpose', 'native-source', 'pending', 'unseeded', 'duplicate-id', 'duplicate-source', 'protected-parent'] as const)
test(`legacy managed normalization rejects ${invalid} without changing source records`, () => {
  const { owner, sources } = fixture();
  if (invalid === 'worker') sources[0]!.workerId = randomUUID();
  if (invalid === 'owner') sources[0]!.userId = randomUUID();
  if (invalid === 'name') sources[0]!.dockerName = 'agentor-persist-' + sources[0]!.id;
  if (invalid === 'purpose') sources[0]!.purpose = 'persistent-path';
  if (invalid === 'native-source') sources[0]!.storageRuntimeKind = 'incus-vm';
  if (invalid === 'pending') sources[0]!.operation!.stage = 'queued';
  if (invalid === 'unseeded') sources[0]!.seeded = false;
  if (invalid === 'duplicate-id') sources[1]!.id = sources[0]!.id;
  if (invalid === 'duplicate-source') { sources[1]!.target = sources[0]!.target; sources[1]!.dockerName = sources[0]!.dockerName; }
  if (invalid === 'protected-parent') { sources[0]!.target = '/home/agent/.local'; sources[0]!.dockerName = persistentPathVolumeName(owner.id, sources[0]!.target); }
  const original = structuredClone(sources);
  expect(() => prepareLegacyManagedMigration(owner, sources)).toThrow();
  expect(sources).toEqual(original);
});

test('native admission still rejects unnormalized historical names', () => {
  const { sources } = fixture();
  expect(() => incusManagedVolumeDeviceKey({ ...sources[0]!, storageRuntimeKind: 'incus-vm' })).toThrow();
});
