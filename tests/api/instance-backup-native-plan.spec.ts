import { test, expect } from '@playwright/test';
import { planInstanceNativeRestore } from '../../orchestrator/instance-restore-native';
import { validateInstanceManifest, instanceVolumeArchiveName } from '../../orchestrator/server/utils/instance-backup-bundle';
import type { InstanceBackupManifest, InstanceBackupVolumeManifest } from '../../orchestrator/server/utils/instance-backup-types';
import type { WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import type { StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';

const workerId = '11111111-2222-3333-4444-555555555555', deletedId = '99999999-8888-7777-6666-555555555555';
const stamp = '2026-10-05T12:00:00.000Z';
const source = { sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64),
  architecture: 'amd64' as const, converterVersion: '0.4.0', bootstrapGeneration: '3' as const };
function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return { id: workerId, userId: 'fixture-owner', displayName: 'Native stopped worker', status: 'active',
    desiredRuntimeStatus: 'stopped', runtimeKind: 'incus-vm', createdAt: stamp, updatedAt: stamp, ...overrides };
}
function managed(index: number, overrides: Partial<StoredManagedVolume> = {}): StoredManagedVolume {
  const id = `${index.toString(16).padStart(6, '0')}aa-bbbb-cccc-dddd-${index.toString().padStart(12, '0')}`;
  return { id, dockerName: 'agentor-persist-' + id, userId: 'fixture-owner', workerId,
    target: '/srv/data-' + index, name: 'Data ' + index, purpose: 'persistent-path', storageRuntimeKind: 'incus-vm',
    attached: true, seeded: true, state: 'ready', createdAt: stamp, updatedAt: stamp, ...overrides };
}
function core(role: 'workspace' | 'agents' | 'docker', owner = worker()): InstanceBackupVolumeManifest {
  const name = `agentor-worker-${owner.id}-${role}`;
  return { name, ownerId: owner.userId, workerId: owner.id,
    kind: { workspace: 'worker-workspace' as const, agents: 'worker-agent-data' as const, docker: 'worker-dind' as const }[role],
    archive: instanceVolumeArchiveName(name), sha256: 'c'.repeat(64), size: 100,
    runtime: role === 'workspace'
      ? { kind: 'incus-vm', role, source: structuredClone(source), dockerData: false }
      : { kind: 'incus-vm', role, source: structuredClone(source) } };
}
function descriptor(record: StoredManagedVolume): InstanceBackupVolumeManifest {
  return { name: record.dockerName, ownerId: record.userId, workerId: record.workerId, kind: 'persistent-path',
    archive: instanceVolumeArchiveName(record.dockerName), sha256: 'd'.repeat(64), size: 100,
    runtime: { kind: 'incus-vm', role: 'managed', managedVolumeId: record.id, target: record.target } };
}
function manifest(volumes: InstanceBackupVolumeManifest[], overrides: Partial<InstanceBackupManifest> = {}): InstanceBackupManifest {
  return validateInstanceManifest({ kind: 'agentor-instance-backup', formatVersion: 2, backupId: 'instance-fixture',
    sourceInstallationId: 'source-fixture', createdByUserId: 'platform-admin', createdAt: stamp, agentorVersion: 'test',
    storage: { mode: 'volume', containerPrefix: 'agentor-worker' },
    options: { includeWorkers: true, includeAgentData: true, includeDockerVolumes: true, includeLogs: false, includeLocalBackups: false },
    dataArchive: { archive: 'data.tar.gz', sha256: 'e'.repeat(64), size: 100 }, volumes,
    plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
    hostMounts: { configuredPaths: [], contentsIncluded: false },
    images: { definitions: 0, immutableDigests: [], layersIncluded: false }, excludedDataPaths: [], ...overrides });
}
const canonical = () => [core('workspace'), core('agents')];

test('historical records and format1 remain legacy; version2 alone never changes runtime authority', () => {
  const historical = worker(); delete historical.runtimeKind;
  const legacyDescriptor = core('workspace'); delete legacyDescriptor.runtime;
  for (const formatVersion of [1, 2] as const) {
    const value = manifest([legacyDescriptor], { formatVersion });
    const legacyManaged = managed(1, { storageRuntimeKind: undefined });
    expect(planInstanceNativeRestore(value, [historical], [legacyManaged])).toEqual([]);
    expect(planInstanceNativeRestore(value, [worker({ runtimeKind: 'legacy-docker' })], [])).toEqual([]);
    expect(historical.runtimeKind).toBeUndefined();
  }
});

test('native logical core groups immutable roles with attached, detached and deleted-owner data without mutation', () => {
  const record = worker(), attached = managed(1), detached = managed(2, { attached: false, state: 'detached' });
  const retained = managed(3, { workerId: deletedId, userId: 'deleted-owner', attached: false, state: 'detached', retainedAfterAccountDeletion: true });
  const value = manifest([...canonical(), core('docker'), descriptor(attached), descriptor(detached), descriptor(retained)]);
  if (value.volumes[0]!.runtime?.role !== 'workspace') throw new Error('Fixture workspace missing');
  value.volumes[0]!.runtime.dockerData = true;
  const records = [record], volumes = [attached, detached, retained], before = structuredClone({ value, records, volumes });
  const result = planInstanceNativeRestore(value, records, volumes);
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ workerId, userId: record.userId, worker: record, source,
    core: { workspace: value.volumes[0], agents: value.volumes[1], docker: value.volumes[2] },
    managed: [{ record: attached, descriptor: value.volumes[3] }, { record: detached, descriptor: value.volumes[4] }] });
  expect(result[1]).toEqual({ workerId: deletedId, userId: 'deleted-owner', core: {}, managed: [{ record: retained, descriptor: value.volumes[5] }] });
  expect({ value, records, volumes }).toEqual(before);
  result[0]!.worker!.displayName = 'changed-result'; result[0]!.managed[0]!.record.target = '/srv/changed-result';
  result[0]!.core.workspace!.name = 'changed-result'; result[0]!.source!.recipeId = 'f'.repeat(64);
  expect({ value, records, volumes }).toEqual(before);
});

test('archived/stopped intent survives and intentionally omitted agents or unseeded data never allocates', () => {
  for (const status of ['active', 'archived'] as const) {
    const record = worker({ status, desiredRuntimeStatus: 'stopped', ...(status === 'archived' ? { archivedAt: stamp } : {}) });
    const missing = managed(1, { seeded: false, state: 'pending' });
    const orphan = managed(2, { workerId: deletedId, userId: 'deleted-owner', attached: false, seeded: false, state: 'detached' });
    const value = manifest([core('workspace', record)]);
    value.options.includeAgentData = false;
    const result = planInstanceNativeRestore(value, [record], [missing, orphan]);
    expect(result).toHaveLength(1); expect(result[0]!.worker).toEqual(record);
    expect(result[0]!.core.agents).toBeUndefined(); expect(result[0]!.managed).toEqual([]);
    expect(() => planInstanceNativeRestore(manifest([...canonical(), descriptor(missing)]), [record], [missing]))
      .toThrow(/canonical record/);
  }
  const orphan = managed(1, { workerId: deletedId, userId: 'deleted-owner', attached: false, seeded: false, state: 'detached' });
  expect(planInstanceNativeRestore(manifest([]), [], [orphan])).toEqual([]);
  expect(() => planInstanceNativeRestore(manifest([], { formatVersion: 1 }), [], [orphan])).toThrow(/version2|format|native/i);
});

test('Docker payload omission requires explicit canonical absence, not disabled current capability', () => {
  const record = worker();
  for (const presence of [undefined, true, false]) for (const hasPayload of [false, true]) {
    const roles = canonical(), workspace = roles[0]!.runtime;
    if (workspace?.role !== 'workspace') throw new Error('Fixture workspace missing');
    if (presence === undefined) delete workspace.dockerData;
    else workspace.dockerData = presence;
    const value = manifest([...roles, ...(hasPayload ? [core('docker')] : [])]);
    const before = structuredClone(value);
    if (hasPayload ? presence !== false : presence === false) {
      expect(planInstanceNativeRestore(value, [record], [])[0]!.core.docker !== undefined).toBe(hasPayload);
    } else expect(() => planInstanceNativeRestore(value, [record], [])).toThrow(/Docker.*missing|absence.*unproven/i);
    expect(value).toEqual(before);
  }
});

test('missing canonical roles, managed bytes or selected filesystem gates fail closed', () => {
  const record = worker(), volume = managed(1);
  for (const volumes of [[], [core('agents')], [core('workspace')]])
    expect(() => planInstanceNativeRestore(manifest(volumes), [record], [])).toThrow(/canonical.*missing/i);
  expect(() => planInstanceNativeRestore(manifest(canonical()), [record], [volume])).toThrow(/managed data.*missing/i);
  expect(() => planInstanceNativeRestore(manifest(canonical()), [record], [], false)).toThrow(/filesystem data/);
  for (const option of ['includeDockerVolumes', 'includeWorkers'] as const) {
    const value = manifest(canonical()); value.options[option] = false;
    expect(() => planInstanceNativeRestore(value, [record], [])).toThrow(/filesystem data/);
  }
  const old = canonical().map(value => { const copy = structuredClone(value); delete copy.runtime; return copy; });
  expect(() => planInstanceNativeRestore(manifest(old, { formatVersion: 1 }), [record], [])).toThrow(/legacy Docker/);
});

test('runtime/owner/worker/managed joins and immutable source disagreements never grant native admission', () => {
  const record = worker(), volume = managed(1), value = manifest([...canonical(), descriptor(volume)]);
  for (const runtimeKind of [undefined, 'legacy-docker'] as const)
    expect(() => planInstanceNativeRestore(value, [worker({ runtimeKind })], [volume])).toThrow(/authority disagree|staged owner/);
  expect(() => planInstanceNativeRestore(value, [record], [{ ...volume, storageRuntimeKind: 'legacy-docker' }]))
    .toThrow(/authority disagree/);
  for (const change of [{ userId: 'another-owner' }, { workerId: deletedId }, { target: '/srv/another' },
    { dockerName: 'agentor-persist-aaaaaaaa-bbbb-cccc-dddd-999999999999' },
    { id: 'aaaaaaaa-bbbb-cccc-dddd-999999999999', dockerName: 'agentor-persist-aaaaaaaa-bbbb-cccc-dddd-999999999999' }])
    expect(() => planInstanceNativeRestore(value, [record], [{ ...volume, ...change }])).toThrow();
  const wrongOwner = structuredClone(value); wrongOwner.volumes[0]!.ownerId = 'another-owner';
  expect(() => planInstanceNativeRestore(wrongOwner, [record], [volume])).toThrow(/staged owner/);
  const wrongWorker = structuredClone(value); wrongWorker.volumes[0] = core('workspace', worker({ id: deletedId }));
  expect(() => planInstanceNativeRestore(wrongWorker, [record], [volume])).toThrow(/staged owner/);
  const wrongSource = structuredClone(value); (wrongSource.volumes[1]!.runtime as any).source.recipeId = 'f'.repeat(64);
  expect(() => planInstanceNativeRestore(wrongSource, [record], [volume])).toThrow(/immutable OCI source/);
  const untagged = structuredClone(value); delete untagged.volumes[0]!.runtime;
  expect(() => planInstanceNativeRestore(untagged, [record], [volume])).toThrow(/legacy Docker descriptor/);
});

test('duplicate durable records and unresolved live, operation or lifecycle authority reject before planning', () => {
  const record = worker(), volume = managed(1), value = manifest([...canonical(), descriptor(volume)]);
  expect(() => planInstanceNativeRestore(value, [record, structuredClone(record)], [volume])).toThrow(/duplicate staged WorkerRecord/);
  expect(() => planInstanceNativeRestore(value, [record], [volume, structuredClone(volume)])).toThrow(/duplicate staged managed/);
  for (const change of [{ deletionPending: true }, { incusRecreation: { nonce: workerId, initialCreate: true } },
    { status: 'unknown' }, { desiredRuntimeStatus: 'unknown' }])
    expect(() => planInstanceNativeRestore(value, [{ ...record, ...change } as any], [volume])).toThrow(/lifecycle/);
  for (const change of [{ state: 'preparing' }, { state: 'failed' }, { operation: { stage: 'restoring' } },
    { incusLive: { id: workerId, incarnation: deletedId, bootId: workerId, attachment: 'settled' } },
    { liveContainerId: 'legacy-source' }, { liveContainerId: '' }, { liveContainerId: null },
    { previousRestartPolicy: { Name: 'unless-stopped' } }, { previousRestartPolicy: null },
    { retainedAfterAccountDeletion: true }])
    expect(() => planInstanceNativeRestore(value, [record], [{ ...volume, ...change } as any])).toThrow(/storage|live/i);
  const complete = { ...volume, operation: { stage: 'complete' } } as any;
  expect(planInstanceNativeRestore(value, [record], [complete])[0]!.managed[0]!.record).toEqual(complete);
});

test('canonical/staging overlap, operational overlap and shortened native device collisions reject admission', () => {
  const admit = (volumes: StoredManagedVolume[]) => planInstanceNativeRestore(
    manifest([...canonical(), ...volumes.map(descriptor)]), [worker()], volumes);
  for (const target of ['/workspace', '/workspace/project', '/restore', '/restore/managed/private']) {
    expect(() => admit([managed(1, { target })])).toThrow(/overlap|restore|workspace/i);
    expect(() => admit([managed(1, { target, attached: false, state: 'detached' })]))
      .toThrow(/overlap|restore|workspace/i);
  }
  for (const target of ['/srv/data-1', '/srv/data-1/child', '/srv'])
    expect(() => admit([managed(1), managed(2, { target })])).toThrow(/targets overlap/i);

  const collision = managed(2, { id: '000001bb-bbbb-cccc-dddd-000000000002',
    dockerName: 'agentor-persist-000001bb-bbbb-cccc-dddd-000000000002' });
  expect(() => admit([managed(1), collision])).toThrow(/device keys collide/i);
  expect(() => admit([managed(1), { ...collision, attached: false, state: 'detached' }]))
    .toThrow(/device keys collide/i);

  // Historical detached targets are descriptive: their inverse staging roots
  // use distinct volume IDs, so they need not become operationally attached.
  const detached = managed(2, { target: '/srv/data-1/child', attached: false, state: 'detached' });
  const sameHistorical = managed(3, { target: detached.target, attached: false, state: 'detached' });
  expect(admit([managed(1), detached, sameHistorical])[0]!.managed.map(item => item.record))
    .toEqual([managed(1), detached, sameHistorical]);
});

test('combined attached and detached volume cap is enforced before any destination allocation', () => {
  const volumes = Array.from({ length: 32 }, (_, index) => managed(index + 1,
    index % 2 ? { attached: false, state: 'detached' } : {}));
  const admit = (records: StoredManagedVolume[]) => planInstanceNativeRestore(
    manifest([...canonical(), ...records.map(descriptor)]), [worker()], records);
  expect(admit(volumes)[0]!.managed).toHaveLength(32);
  const before = structuredClone(volumes);
  expect(() => admit([...volumes, managed(33, { attached: false, state: 'detached' })]))
    .toThrow(/volume limit/i);
  expect(volumes).toEqual(before);
});
