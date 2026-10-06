import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertLegacyOriginalRestoreTarget, assertOriginalRestoreTarget, assertOriginalRestoreSourceRuntime,
  replaceStoppedWorkspace } from '../../orchestrator/server/utils/backup-restore-helper';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';
import { useContainerManager, useDockerService, useWorkerStore, useIncusClient } from '../../orchestrator/server/utils/services';

const Docker = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('dockerode');

async function fixture(run: (worker: any, record: any, calls: string[]) => Promise<void>) {
  const worker: any = { id: randomUUID(), userId: 'original-restore-owner', status: 'stopped',
    runtimeKind: 'legacy-docker', containerId: 'retained-legacy-container' };
  const record: any = { id: worker.id, userId: worker.userId, status: 'active', displayName: 'historical' };
  const cm = useContainerManager(), store = useWorkerStore(), docker = useDockerService(), incus = useIncusClient();
  const original = { get: cm.get, init: store.init, record: store.get, image: docker.ensureImage,
    volume: Docker.prototype.getVolume, create: Docker.prototype.createContainer,
    nativeRead: incus.getInstance, nativeCreate: incus.createInstance, nativeStart: incus.startInstance };
  const calls: string[] = [];
  cm.get = id => id === worker.id ? worker : undefined;
  store.init = async () => { calls.push('durable-init'); };
  store.get = (owner, id) => owner === record.userId && id === record.id && !record.missing ? record : undefined;
  const trap = () => { calls.push('Docker'); throw new Error('Original restore must not touch retained Docker storage'); };
  docker.ensureImage = trap;
  Docker.prototype.getVolume = trap;
  Docker.prototype.createContainer = trap as any;
  const nativeTrap = async () => { calls.push('Incus'); throw new Error('Readonly runtime admission must not query or mutate Incus'); };
  incus.getInstance = nativeTrap; incus.createInstance = nativeTrap; incus.startInstance = nativeTrap;
  try { await run(worker, record, calls); }
  finally {
    cm.get = original.get; store.init = original.init; store.get = original.record;
    docker.ensureImage = original.image; Docker.prototype.getVolume = original.volume;
    Docker.prototype.createContainer = original.create;
    incus.getInstance = original.nativeRead; incus.createInstance = original.nativeCreate; incus.startInstance = original.nativeStart;
  }
}

test('original restore rejects cached or durable Incus identity before retained legacy storage access', async () => {
  for (const scenario of ['cached', 'durable', 'handle'] as const) await fixture(async (worker, record, calls) => {
    if (scenario === 'cached') worker.runtimeKind = 'incus-vm';
    if (scenario === 'durable') record.runtimeKind = 'incus-vm'; // stale legacy cache after cutover
    if (scenario === 'handle') worker.containerId = 'incus:' + randomUUID();
    await expect(replaceStoppedWorkspace(worker.userId, worker.id, '/no-fixture-archive'))
      .rejects.toMatchObject({ statusCode: 409, code: 'INCUS_ORIGINAL_RESTORE_CAPABILITY_PENDING' });
    expect(calls).toEqual(['durable-init']);
  });
});

function native(worker: any, record: any) {
  const incarnation = randomUUID();
  worker.runtimeKind = record.runtimeKind = 'incus-vm';
  worker.containerId = 'incus:' + incarnation;
  worker.containerName = useContainerManager().buildContainerName(worker.id);
  return incarnation;
}

test('runtime-specific original admission observes exact stopped native UUID without querying or mutating either backend', async () => {
  await fixture(async (worker, record, calls) => {
    const incarnation = native(worker, record);
    expect(await assertOriginalRestoreTarget(worker.userId, worker.id))
      .toEqual({ worker, record, runtimeKind: 'incus-vm', incarnation });
    expect(calls).toEqual(['durable-init']);
    await expect(assertLegacyOriginalRestoreTarget(worker.userId, worker.id))
      .rejects.toMatchObject({ code: 'INCUS_ORIGINAL_RESTORE_CAPABILITY_PENDING' });
    expect(calls).toEqual(['durable-init', 'durable-init']);
  });
});

test('runtime-specific admission never resolves cache, durable or handle disagreement through environment policy', async () => {
  for (const scenario of ['cached-native', 'durable-native', 'legacy-native-handle', 'missing-cache-kind', 'unknown-cache-kind', 'unknown-durable-kind'])
    await fixture(async (worker, record, calls) => {
      if (scenario === 'cached-native') { worker.runtimeKind = 'incus-vm'; worker.containerId = 'incus:' + randomUUID(); }
      if (scenario === 'durable-native') record.runtimeKind = 'incus-vm';
      if (scenario === 'legacy-native-handle') worker.containerId = 'incus:' + randomUUID();
      if (scenario === 'missing-cache-kind') { native(worker, record); delete worker.runtimeKind; }
      if (scenario === 'unknown-cache-kind') worker.runtimeKind = 'future-runtime';
      if (scenario === 'unknown-durable-kind') record.runtimeKind = 'future-runtime';
      await expect(assertOriginalRestoreTarget(worker.userId, worker.id))
        .rejects.toMatchObject({ statusCode: 409, code: 'ORIGINAL_RESTORE_RUNTIME_IDENTITY_MISMATCH' });
      expect(calls).toEqual(['durable-init']);
    });
});

test('native readonly admission rejects foreign or unsettled records before backend storage access', async () => {
  for (const scenario of ['missing', 'archived', 'deletion', 'recreation', 'cached-owner', 'durable-owner', 'cached-id', 'running', 'admin'])
    await fixture(async (worker, record, calls) => {
      native(worker, record); const workerId = worker.id, userId = worker.userId;
      if (scenario === 'missing') record.missing = true;
      if (scenario === 'archived') record.status = 'archived';
      if (scenario === 'deletion') record.deletionPending = true;
      if (scenario === 'recreation') record.incusRecreation = { nonce: randomUUID() };
      if (scenario === 'cached-owner') worker.userId = 'foreign-owner';
      if (scenario === 'durable-owner') record.userId = 'foreign-owner';
      if (scenario === 'cached-id') worker.id = randomUUID();
      if (scenario === 'running') worker.status = 'running';
      if (scenario === 'admin') worker.administrativeKind = 'platform';
      await expect(assertOriginalRestoreTarget(userId, workerId)).rejects.toMatchObject({ statusCode: 409 });
      expect(calls).toEqual(['durable-init']);
    });
});

test('native readonly admission requires captured UUID handle and exact stable worker name', async () => {
  for (const handle of ['', 'incus:', 'incus:unknown', 'incus:' + randomUUID() + ':suffix', 'retained-legacy-container', undefined])
    await fixture(async (worker, record, calls) => {
      native(worker, record); worker.containerId = handle;
      await expect(assertOriginalRestoreTarget(worker.userId, worker.id))
        .rejects.toMatchObject({ statusCode: 409, code: 'ORIGINAL_RESTORE_RUNTIME_IDENTITY_MISMATCH' });
      expect(calls).toEqual(['durable-init']);
    });
  await fixture(async (worker, record, calls) => {
    native(worker, record); worker.containerName = 'lookalike-foreign-vm';
    await expect(assertOriginalRestoreTarget(worker.userId, worker.id))
      .rejects.toMatchObject({ code: 'ORIGINAL_RESTORE_RUNTIME_IDENTITY_MISMATCH' });
    expect(calls).toEqual(['durable-init']);
  });
});

test('historical absent runtime still resolves only to legacy original authority', async () => {
  await fixture(async (worker, record, calls) => {
    delete worker.runtimeKind; delete record.runtimeKind;
    expect(await assertOriginalRestoreTarget(worker.userId, worker.id))
      .toEqual({ worker, record, runtimeKind: 'legacy-docker' });
    expect(() => assertOriginalRestoreSourceRuntime('legacy-docker', undefined)).not.toThrow();
    expect(() => assertOriginalRestoreSourceRuntime('legacy-docker', { version: 1, kind: 'legacy-docker' })).not.toThrow();
    expect(calls).toEqual(['durable-init']);
  });
});

test('authenticated original backup runtime describes bytes but cannot migrate either target or select an image', () => {
  const runtime = { version: 1, kind: 'incus-vm', source: { sourceImageId: 'sha256:' + 'a'.repeat(64),
    recipeId: 'b'.repeat(64), architecture: 'amd64', converterVersion: '0.4.0', bootstrapGeneration: '3' } };
  const before = structuredClone(runtime);
  expect(() => assertOriginalRestoreSourceRuntime('incus-vm', runtime)).not.toThrow();
  expect(runtime).toEqual(before);
  for (const legacy of [undefined, { version: 1, kind: 'legacy-docker' }])
    expect(() => assertOriginalRestoreSourceRuntime('incus-vm', legacy))
      .toThrow('original restore cannot migrate');
  expect(() => assertOriginalRestoreSourceRuntime('legacy-docker', runtime))
    .toThrow('original restore cannot migrate');
  for (const invalid of [null, { version: 1, kind: 'foreign' }, { ...runtime, source: { sourceImageId: 'mutable:latest' } }])
    expect(() => assertOriginalRestoreSourceRuntime('incus-vm', invalid)).toThrow();
});

test('original restore requires settled active durable and stopped cached legacy authority', async () => {
  for (const scenario of ['missing', 'archived', 'deletion', 'recreation', 'owner', 'running'] as const)
    await fixture(async (worker, record, calls) => {
      if (scenario === 'missing') record.missing = true;
      if (scenario === 'archived') record.status = 'archived';
      if (scenario === 'deletion') record.deletionPending = true;
      if (scenario === 'recreation') record.incusRecreation = { nonce: randomUUID() };
      if (scenario === 'owner') worker.userId = 'foreign-owner';
      if (scenario === 'running') worker.status = 'running';
      await expect(replaceStoppedWorkspace('original-restore-owner', worker.id, '/no-fixture-archive'))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(calls).toEqual(['durable-init']);
    });
});

test('historical records without runtime metadata remain eligible for legacy original restore', async () => {
  await fixture(async (worker, record, calls) => {
    delete worker.runtimeKind; delete record.runtimeKind;
    expect(await assertLegacyOriginalRestoreTarget(worker.userId, worker.id)).toBe(worker);
    expect(calls).toEqual(['durable-init']);
  });
});

test('internal restore admission rejects inconsistent native and stale legacy targets before any job or artifact pin', async () => {
  for (const scenario of ['cached', 'durable', 'handle'] as const) await fixture(async (worker, record, calls) => {
    if (scenario === 'cached') worker.runtimeKind = 'incus-vm';
    if (scenario === 'durable') record.runtimeKind = 'incus-vm';
    if (scenario === 'handle') worker.containerId = 'incus:' + randomUUID();
    const artifact: any = { id: randomUUID(), userId: worker.userId, providerObjectId: 'fixture-object', workspaceId: worker.id };
    const manager: any = {
      init: async () => {}, assertOwnerAvailable() {}, store: { findArtifact: () => artifact },
      assertRestoreRuntimePrincipal: (BackupManager.prototype as any).assertRestoreRuntimePrincipal,
      artifactWorkspaceIds: () => [worker.id], selectRestoreWorkspaceIds: () => [worker.id],
      pinRestoreArtifact() { calls.push('pin'); throw new Error('Must reject before pin'); },
      claimStartJob() { calls.push('job'); throw new Error('Must reject before job'); },
      enqueue() { calls.push('enqueue'); throw new Error('Must reject before enqueue'); },
    };
    await expect(BackupManager.prototype.createRestore.call(manager, worker.userId, artifact, 'original'))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORIGINAL_RESTORE_RUNTIME_IDENTITY_MISMATCH' });
    expect(calls).toEqual(['durable-init']);
  });
});

test('public manager admission accepts exact native or historical legacy authority without backend mutation', async () => {
  for (const kind of ['incus-vm', 'legacy-docker'] as const) await fixture(async (worker, record, calls) => {
    if (kind === 'incus-vm') native(worker, record);
    else { delete worker.runtimeKind; delete record.runtimeKind; }
    const artifact: any = { id: randomUUID(), userId: worker.userId, providerObjectId: 'fixture-object', workspaceId: worker.id };
    const manager: any = {
      init: async () => {}, assertOwnerAvailable() {}, store: { findArtifact: () => artifact },
      assertRestoreRuntimePrincipal: (BackupManager.prototype as any).assertRestoreRuntimePrincipal,
      artifactWorkspaceIds: () => [worker.id], selectRestoreWorkspaceIds: () => [worker.id],
      restorePinOwner: () => 'exact-fixture-pin',
      pinRestoreArtifact() { calls.push('pin'); throw new Error('Verified original admission reached artifact pin'); },
    };
    await expect(BackupManager.prototype.createRestore.call(manager, worker.userId, artifact, 'original'))
      .rejects.toThrow('Verified original admission reached artifact pin');
    expect(calls).toEqual(['durable-init', 'pin']);
  });
});
