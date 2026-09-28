import type { AdminLegacyRuntimeAuthorization } from './worker-runtime-policy';
import { resolveWorkerRuntimeProfile } from './worker-runtime-policy';
import { withOwnerWorkerLifecycleMutation } from './worker-lifecycle-coordinator';
import { instanceSnapshotActive } from './instance-snapshot-gate';
import type { WorkerRecord } from './worker-store';
import type { ContainerInfo } from '../../shared/types';

/** Server-held authority callback. Never construct this from request fields. */
export interface RuntimeAdministrator { authorize(): Promise<void> }
export type RuntimeRestoreAuthorization = () => Promise<AdminLegacyRuntimeAuthorization>;

/** Ephemeral authorization for a queued restore. It is never serialized with
 * a job or bundle, and rechecks the destination principal before each import. */
export async function authorizeRuntimeRestore(actor: RuntimeAdministrator, profile: unknown, acknowledged: unknown): Promise<RuntimeRestoreAuthorization | undefined> {
  const selected = await authorizeRuntimeSelection(actor, profile, acknowledged);
  if (!selected) return undefined;
  return async () => {
    await actor.authorize();
    return { runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin', authorize: () => actor.authorize() };
  };
}

export async function authorizeRuntimeSelection(
  actor: RuntimeAdministrator,
  profile: unknown,
  acknowledgeHostPrivilege: unknown,
): Promise<AdminLegacyRuntimeAuthorization | undefined> {
  if (profile === undefined || profile === 'kata-qemu') return undefined;
  if (profile !== 'legacy-runc')
    throw Object.assign(new Error('Invalid worker runtime profile'), { statusCode: 400 });
  await actor.authorize();
  if (acknowledgeHostPrivilege !== true)
    throw Object.assign(new Error('Legacy runc can grant host privilege; explicit acknowledgement is required'), { statusCode: 400 });
  return { runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin', authorize: () => actor.authorize() };
}

export interface RuntimeGrantDependencies {
  find(id: string): WorkerRecord | undefined;
  save(record: WorkerRecord): Promise<void>;
  live(id: string): ContainerInfo | undefined;
  verifyLock(id: string, password: unknown): Promise<void>;
  assertKataReady?(): Promise<void>;
}

/** Clear a destination restore hold without changing the backed-up profile. */
export async function approveRestoredKataRuntime(
  actor: RuntimeAdministrator, workerId: string, lockPassword: unknown, deps: RuntimeGrantDependencies,
) {
  await actor.authorize();
  const initial = deps.find(workerId);
  if (!initial) throw Object.assign(new Error('Worker not found'), { statusCode: 404 });
  return withOwnerWorkerLifecycleMutation(initial.userId, workerId, async () => {
    await actor.authorize();
    if (instanceSnapshotActive()) throw Object.assign(new Error('Runtime changes are unavailable during instance backup or restore'), { statusCode: 423 });
    const worker = deps.find(workerId);
    if (!worker || worker.userId !== initial.userId || worker.deletionPending)
      throw Object.assign(new Error('Worker not found'), { statusCode: 404 });
    if (worker.runtimeProfile !== 'kata-qemu')
      throw Object.assign(new Error('Changing a worker runtime requires explicit migration'), { statusCode: 409 });
    await deps.verifyLock(workerId, lockPassword);
    if (!deps.assertKataReady) throw Object.assign(new Error('Kata readiness unavailable'), { statusCode: 503 });
    await deps.assertKataReady();
    const next = { ...worker, updatedAt: new Date().toISOString() };
    delete next.runtimeRestoreApprovalRequired;
    delete next.legacyPrivilegeGrant;
    await deps.save(next);
    const live = deps.live(workerId);
    if (live) delete live.runtimeRestoreApprovalRequired;
    return { workerId, runtimeProfile: 'kata-qemu' as const, authorized: true };
  });
}

/** Reauthorizes existing legacy records, including pre-profile archives. This
 * changes no running container and cannot migrate a Kata worker to runc. */
export async function grantLegacyWorkerRuntime(
  actor: RuntimeAdministrator,
  workerId: string,
  input: { acknowledgeHostPrivilege?: unknown; lockPassword?: unknown },
  deps: RuntimeGrantDependencies,
) {
  await authorizeRuntimeSelection(actor, 'legacy-runc', input.acknowledgeHostPrivilege);
  const initial = deps.find(workerId);
  if (!initial) throw Object.assign(new Error('Worker not found'), { statusCode: 404 });
  return withOwnerWorkerLifecycleMutation(initial.userId, workerId, async () => {
    await actor.authorize();
    if (instanceSnapshotActive())
      throw Object.assign(new Error('Runtime changes are unavailable during instance backup or restore'), { statusCode: 423 });
    const worker = deps.find(workerId);
    if (!worker || worker.userId !== initial.userId || worker.deletionPending)
      throw Object.assign(new Error('Worker not found'), { statusCode: 404 });
    if (resolveWorkerRuntimeProfile(worker.runtimeProfile) !== 'legacy-runc')
      throw Object.assign(new Error('Changing a worker runtime requires explicit migration'), { statusCode: 409 });
    await deps.verifyLock(workerId, input.lockPassword);
    const next: WorkerRecord = { ...worker, runtimeProfile: 'legacy-runc',
      legacyPrivilegeGrant: 'admin', updatedAt: new Date().toISOString() };
    delete next.runtimeRestoreApprovalRequired;
    await deps.save(next);
    const live = deps.live(workerId);
    if (live) {
      live.runtimeProfile = 'legacy-runc';
      delete live.runtimeRestoreApprovalRequired;
      Object.defineProperty(live, 'legacyPrivilegeGrant', {
        value: 'admin', writable: true, configurable: true, enumerable: false,
      });
    }
    return { workerId, runtimeProfile: 'legacy-runc' as const, authorized: true,
      message: 'Legacy runtime authorized. Restart, rebuild or unarchive remains a separate operation.' };
  });
}

export async function runtimeGrantDependencies(): Promise<RuntimeGrantDependencies> {
  const [{ useWorkerStore, useContainerManager, useDockerService }, { useWorkerProtectionLockStore }] = await Promise.all([
    import('./services'), import('./worker-protection-lock'),
  ]);
  return {
    find: (id) => useWorkerStore().findById(id),
    save: (record) => useWorkerStore().upsert(record),
    live: (id) => useContainerManager().get(id),
    verifyLock: async (id, password) => { await useWorkerProtectionLockStore().verify(id, password); },
    assertKataReady: () => useDockerService().assertWorkerRuntimeAvailable('kata-qemu'),
  };
}
