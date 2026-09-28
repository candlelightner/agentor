import { expect, test } from '@playwright/test';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';

test('retry reads the durable legacy selection and refuses before mutating or queueing a job', async () => {
  const manager = new BackupManager({ dataDir: '/unused' });
  const durable = { id: 'restore-1', userId: 'owner', status: 'failed', attempt: 1,
    operation: 'restore', target: 'new', requestedRuntimeProfile: 'legacy-runc' };
  (manager as any).init = async () => {};
  (manager as any).assertOwnerAvailable = () => {};
  (manager as any).store = { findJob: () => structuredClone(durable) };
  (manager as any).enqueue = () => { throw new Error('must not queue'); };
  await expect(manager.retry({ id: 'restore-1', userId: 'owner' } as any))
    .rejects.toMatchObject({ statusCode: 403, code: 'LEGACY_RESTORE_REAUTHORIZATION_REQUIRED' });
  expect((manager as any).retryClaims.size).toBe(0);
  expect(durable.attempt).toBe(1);
});

test('restore admission refuses runtime changes for an original worker and revoked live authority', async () => {
  const manager = new BackupManager({ dataDir: '/unused' });
  let initialized = false;
  (manager as any).init = async () => { initialized = true; };
  const authorization = async () => ({ runtimeProfile: 'legacy-runc' as const, legacyPrivilegeGrant: 'admin' as const, authorize: async () => {} });
  await expect(manager.createRestore('owner', {} as any, 'original', undefined, undefined, undefined, undefined, undefined, authorization))
    .rejects.toMatchObject({ statusCode: 400 });
  await expect(manager.createRestore('owner', {} as any, 'new', undefined, undefined, undefined, undefined, undefined, async () => {
    throw Object.assign(new Error('Administrator demoted'), { statusCode: 403 });
  })).rejects.toMatchObject({ statusCode: 403 });
  expect(initialized).toBe(false);
});
