import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Docker from 'dockerode';
import { assertLegacyMigrationAuthority } from '../../orchestrator/server/utils/legacy-incus-migration-authority';
import { WorkerStore, type WorkerRecord, type WorkerIncusMigration } from '../../orchestrator/server/utils/worker-store';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
const secret = 'SENSITIVE-config-label-path-token';
function fixture() {
  const record: WorkerRecord = { id: randomUUID(), userId: 'owner', displayName: secret, status: 'active',
    runtimeKind: 'legacy-docker', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  const marker: WorkerIncusMigration = { nonce: randomUUID(), phase: 'validating', source: {
    containerId: secret, createdAt: record.createdAt, imageId: secret, wasRunning: false } };
  const source = { Id: secret, Created: record.createdAt, Image: secret, Config: { Labels: { token: secret } },
    Mounts: [{ Type: 'volume', Name: secret, Destination: '/workspace', RW: true }], State: { Running: false } } as Docker.ContainerInspectInfo;
  return { record, marker, current: { ...structuredClone(record), incusMigration: structuredClone(marker) },
    source, actual: structuredClone(source), stopped: true, managed: () => [], sourceManaged: [] };
}

for (const category of ['record-missing', 'record-runtime', 'migration-marker', 'record-baseline', 'source-id',
  'source-created', 'source-image', 'source-mounts', 'source-labels', 'source-running', 'managed-records'])
  test(`migration guard reports only safe ${category} diagnostics`, () => {
    const f = fixture();
    if (category === 'record-missing') f.current = undefined as any;
    if (category === 'record-runtime') f.current.runtimeKind = 'incus-vm';
    if (category === 'migration-marker') f.current.incusMigration.nonce = secret;
    if (category === 'record-baseline') Object.assign(f.current, { initScript: secret, [secret]: secret });
    if (category === 'source-id') f.actual.Id += secret;
    if (category === 'source-created') f.actual.Created += secret;
    if (category === 'source-image') f.actual.Image += secret;
    if (category === 'source-mounts') f.actual.Mounts[0]!.Destination = '/' + secret;
    if (category === 'source-labels') f.actual.Config.Labels.token += secret;
    if (category === 'source-running') f.actual.State.Running = true;
    if (category === 'managed-records') f.managed = () => [{ name: secret }] as any;
    let error: any;
    try { assertLegacyMigrationAuthority(f); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'LEGACY_MIGRATION_AUTHORITY_CHANGED', category });
    expect(error.message).toContain('category=' + category);
    expect(error.message + JSON.stringify(error)).not.toContain(secret);
    if (category === 'record-baseline') expect(error.changedFields).toEqual(['initScript', 'other']);
  });

test('migration guard preserves comparison order, exclusions and undefined presence', () => {
  const f = fixture(); Object.assign(f.current, { updatedAt: secret });
  expect(() => assertLegacyMigrationAuthority(f)).not.toThrow();
  Object.assign(f.current, { initScript: undefined });
  expect(() => assertLegacyMigrationAuthority(f)).toThrow('fields=initScript');
  f.current.runtimeKind = 'incus-vm';
  f.managed = () => { throw new Error('Managed read must remain short circuited'); };
  expect(() => assertLegacyMigrationAuthority(f)).toThrow('category=record-runtime');
});

test('real WorkerStore transitions preserve freshly unarchived undefined keys; disk reload is distinguishable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-migration-authority-'));
  try {
    const f = fixture(), store = new WorkerStore(dir); await store.init();
    await store.upsert({ ...f.record, status: 'archived', initScript: undefined });
    await store.unarchive(f.record.userId, f.record.id);
    f.record = store.get(f.record.userId, f.record.id)!;
    f.marker.phase = 'preparing';
    f.marker.source.containerId = 'a'.repeat(64); f.marker.source.imageId = 'sha256:' + 'b'.repeat(64);
    f.marker = (await store.transitionIncusMigration(f.record.userId, f.record.id, undefined, f.marker)).incusMigration!;
    for (const phase of ['source-stopped', 'destination-created', 'validating'] as const) {
      const next = { ...f.marker, phase, ...(phase !== 'source-stopped' ? { destinationIncarnation: randomUUID() } : {}) };
      if (f.marker.destinationIncarnation) next.destinationIncarnation = f.marker.destinationIncarnation;
      f.marker = (await store.transitionIncusMigration(f.record.userId, f.record.id, f.marker, next)).incusMigration!;
      f.current = store.get(f.record.userId, f.record.id)! as typeof f.current;
      expect(() => assertLegacyMigrationAuthority(f)).not.toThrow();
    }
    expect(Object.hasOwn(f.current, 'initScript')).toBe(true);
    const reloaded = new WorkerStore(dir); await reloaded.loadUser(f.record.userId);
    f.current = reloaded.get(f.record.userId, f.record.id)! as typeof f.current;
    expect(() => assertLegacyMigrationAuthority(f)).toThrow('fields=archivedAt,initScript');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
