import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertLegacyOriginalRestoreTarget, replaceStoppedWorkspace } from '../../orchestrator/server/utils/backup-restore-helper';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';
import { useContainerManager, useDockerService, useWorkerStore } from '../../orchestrator/server/utils/services';

const Docker = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('dockerode');

async function fixture(run: (worker: any, record: any, calls: string[]) => Promise<void>) {
  const worker: any = { id: randomUUID(), userId: 'original-restore-owner', status: 'stopped',
    runtimeKind: 'legacy-docker', containerId: 'retained-legacy-container' };
  const record: any = { id: worker.id, userId: worker.userId, status: 'active', displayName: 'historical' };
  const cm = useContainerManager(), store = useWorkerStore(), docker = useDockerService();
  const original = { get: cm.get, init: store.init, record: store.get, image: docker.ensureImage,
    volume: Docker.prototype.getVolume, create: Docker.prototype.createContainer };
  const calls: string[] = [];
  cm.get = id => id === worker.id ? worker : undefined;
  store.init = async () => { calls.push('durable-init'); };
  store.get = (owner, id) => owner === record.userId && id === record.id && !record.missing ? record : undefined;
  const trap = () => { calls.push('Docker'); throw new Error('Original restore must not touch retained Docker storage'); };
  docker.ensureImage = trap;
  Docker.prototype.getVolume = trap;
  Docker.prototype.createContainer = trap as any;
  try { await run(worker, record, calls); }
  finally {
    cm.get = original.get; store.init = original.init; store.get = original.record;
    docker.ensureImage = original.image; Docker.prototype.getVolume = original.volume;
    Docker.prototype.createContainer = original.create;
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

test('internal restore admission rejects native and stale legacy targets before any job or artifact pin', async () => {
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
      .rejects.toMatchObject({ statusCode: 409, code: 'INCUS_ORIGINAL_RESTORE_CAPABILITY_PENDING' });
    expect(calls).toEqual(['durable-init']);
  });
});
