import { expect, test } from '@playwright/test';
import { authorizeRuntimeSelection, authorizeRuntimeRestore, grantLegacyWorkerRuntime, approveRestoredKataRuntime } from '../../orchestrator/server/utils/worker-runtime-admin';
import { withOwnerWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { beginInstanceSnapshot } from '../../orchestrator/server/utils/instance-snapshot-gate';
import type { WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { ContainerManager } from '../../orchestrator/server/utils/container';

const deny = async () => { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); };
const admin = { authorize: async () => {} };

test('public migration fails closed before journal or Docker access while capacity admission is unavailable', async () => {
  const calls: string[] = [];
  const manager = {
    withExistingWorkerLifecycleMutation: async (_id: string, run: () => Promise<unknown>) => run(),
    runtimeMigrations: async () => { calls.push('journal'); throw new Error('must not open journal'); },
    runtimeMigrationInput: async () => { calls.push('inspect'); throw new Error('must not access Docker'); },
    runtimeMigrationEngine: () => { calls.push('engine'); throw new Error('must not migrate'); },
  };
  for (const target of ['kata-qemu', 'legacy-runc'] as const) {
    await expect(ContainerManager.prototype.migrateRuntime.call(manager as any, 'worker', target, async () => { calls.push('authorize'); }))
      .rejects.toMatchObject({ statusCode: 503, code: 'WORKER_RUNTIME_MIGRATION_CAPACITY_UNVERIFIED' });
  }
  expect(calls).toEqual(['authorize', 'authorize']);
  await expect(ContainerManager.prototype.migrateRuntime.call(manager as any, 'worker', 'kata-qemu', deny))
    .rejects.toMatchObject({ statusCode: 403 });
});

test('queued restore authority stays ephemeral and rechecks revocation for every import', async () => {
  let authorized = true;
  const authority = await authorizeRuntimeRestore({ authorize: async () => { if (!authorized) await deny(); } }, 'legacy-runc', true);
  expect(JSON.stringify({ authority })).toBe('{}');
  expect(await authority!()).toMatchObject({ legacyPrivilegeGrant: 'admin' });
  authorized = false;
  await expect(authority!()).rejects.toMatchObject({ statusCode: 403 });
});

test('runtime selection requires platform authority and separate explicit privilege acknowledgement', async () => {
  expect(await authorizeRuntimeSelection({ authorize: deny }, undefined, true)).toBeUndefined();
  await expect(authorizeRuntimeSelection({ authorize: deny }, 'legacy-runc', true)).rejects.toMatchObject({ statusCode: 403 });
  await expect(authorizeRuntimeSelection(admin, 'legacy-runc', false)).rejects.toMatchObject({ statusCode: 400 });
  expect(await authorizeRuntimeSelection(admin, 'legacy-runc', true)).toMatchObject({ runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin', authorize: expect.any(Function) });
});

function fixture(profile?: WorkerRecord['runtimeProfile']) {
  let saved: WorkerRecord = { id: 'runtime-grant-worker', userId: 'owner', displayName: 'old archive', status: 'archived',
    createdAt: '2026-01-01', updatedAt: '2026-01-01', runtimeProfile: profile };
  let writes = 0;
  let locks = 0;
  return { deps: {
    find: () => saved,
    save: async (record: WorkerRecord) => { saved = record; writes++; },
    live: () => undefined,
    verifyLock: async () => { locks++; },
  }, record: () => saved, writes: () => writes, locks: () => locks };
}

test('an old archive receives durable admin authorization without starting or migrating it', async () => {
  const f = fixture();
  f.record().runtimeRestoreApprovalRequired = true;
  await grantLegacyWorkerRuntime(admin, 'runtime-grant-worker', { acknowledgeHostPrivilege: true }, f.deps);
  expect(f.record()).toMatchObject({ status: 'archived', runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin' });
  expect(f.writes()).toBe(1);
  expect(f.locks()).toBe(1);
  expect(f.record().runtimeRestoreApprovalRequired).toBeUndefined();
});

test('restored Kata approval requires destination readiness and keeps the runtime profile', async () => {
  const f = fixture('kata-qemu');
  f.record().runtimeRestoreApprovalRequired = true;
  await expect(approveRestoredKataRuntime(admin, 'runtime-grant-worker', undefined, {
    ...f.deps, assertKataReady: async () => { throw Object.assign(new Error('Not validated'), { statusCode: 503 }); },
  })).rejects.toMatchObject({ statusCode: 503 });
  expect(f.record().runtimeRestoreApprovalRequired).toBe(true);
  expect(f.writes()).toBe(0);
  await approveRestoredKataRuntime(admin, 'runtime-grant-worker', undefined, { ...f.deps, assertKataReady: async () => {} });
  expect(f.record().runtimeProfile).toBe('kata-qemu');
  expect(f.record().legacyPrivilegeGrant).toBeUndefined();
  expect(f.record().runtimeRestoreApprovalRequired).toBeUndefined();
});

test('legacy grant cannot switch Kata runtime or bypass snapshot barrier', async () => {
  const kata = fixture('kata-qemu');
  await expect(grantLegacyWorkerRuntime(admin, 'runtime-grant-worker', { acknowledgeHostPrivilege: true }, kata.deps))
    .rejects.toMatchObject({ statusCode: 409 });
  expect(kata.writes()).toBe(0);
  const legacy = fixture();
  const release = beginInstanceSnapshot('runtime-grant-snapshot');
  try {
    await expect(grantLegacyWorkerRuntime(admin, 'runtime-grant-worker', { acknowledgeHostPrivilege: true }, legacy.deps))
      .rejects.toMatchObject({ statusCode: 423 });
  } finally { release(); }
  expect(legacy.writes()).toBe(0);
});

test('queued grant rechecks administrator authority before persistence', async () => {
  const f = fixture();
  let entered!: () => void;
  let unblock!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { unblock = resolve; });
  const first = withOwnerWorkerLifecycleMutation('owner', 'runtime-grant-worker', async () => { entered(); await held; });
  await ready;
  let authorized = true;
  const pending = grantLegacyWorkerRuntime({ authorize: async () => { if (!authorized) await deny(); } },
    'runtime-grant-worker', { acknowledgeHostPrivilege: true }, f.deps);
  await new Promise<void>((resolve) => setImmediate(resolve));
  authorized = false;
  unblock();
  await first;
  await expect(pending).rejects.toMatchObject({ statusCode: 403 });
  expect(f.writes()).toBe(0);
});
