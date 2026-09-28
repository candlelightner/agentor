import type { WorkerRuntimeProfile } from '../../shared/types';

/** Docker daemon alias installed by the Agentor host setup. It resolves to
 * Kata's containerd shim with the platform's QEMU configuration. */
export const KATA_DOCKER_RUNTIME = 'agentor-kata-qemu';
export const LEGACY_DOCKER_RUNTIME = 'runc';

export type LegacyPrivilegeGrant = 'preexisting' | 'admin';

/** Internal service argument, never a worker request or backup manifest field.
 * Caller must authenticate a platform administrator before constructing it. */
export interface AdminLegacyRuntimeAuthorization {
  runtimeProfile: 'legacy-runc';
  legacyPrivilegeGrant: 'admin';
  authorize(): Promise<void>;
}

export function resolveNewWorkerRuntime(authorization?: AdminLegacyRuntimeAuthorization): {
  runtimeProfile: WorkerRuntimeProfile;
  legacyPrivilegeGrant?: 'admin';
} {
  if (authorization === undefined) return { runtimeProfile: 'kata-qemu' };
  if (authorization?.runtimeProfile !== 'legacy-runc' || authorization.legacyPrivilegeGrant !== 'admin' || typeof authorization.authorize !== 'function')
    throw Object.assign(new Error('Invalid trusted runtime authorization'), { statusCode: 403 });
  return { runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin' };
}

export function resolveWorkerRuntimeProfile(value: unknown): WorkerRuntimeProfile {
  // Missing values belong only to workers created before runtime profiles were
  // introduced. Every newly provisioned worker persists an explicit profile.
  if (value === undefined) return 'legacy-runc';
  if (value === 'kata-qemu' || value === 'legacy-runc') return value;
  throw Object.assign(new Error('Invalid stored worker runtime profile'), {
    statusCode: 409,
    code: 'WORKER_RUNTIME_PROFILE_INVALID',
  });
}

export function resolveWorkerRuntimePolicy(input: {
  runtimeProfile: WorkerRuntimeProfile;
  dockerEnabled: boolean;
  legacyPrivilegeGrant?: LegacyPrivilegeGrant;
}): { runtime: string; privileged: boolean } {
  const { runtimeProfile, dockerEnabled, legacyPrivilegeGrant } = input;
  if (runtimeProfile === 'kata-qemu') {
    if (legacyPrivilegeGrant !== undefined) throw new Error('Kata workers cannot carry a legacy privilege grant');
    // Docker privileged mode enumerates host devices into the OCI spec even
    // when Kata is selected. Guest capabilities and overlay2 backing storage
    // have not yet been validated; do not guess a capability/device recipe.
    if (dockerEnabled)
      throw Object.assign(new Error('Kata Docker-in-Docker is unavailable until guest permissions and Docker storage pass validation; worker data was preserved'), {
        statusCode: 503,
        code: 'KATA_DIND_NOT_VALIDATED',
      });
    return { runtime: KATA_DOCKER_RUNTIME, privileged: false };
  }
  if (runtimeProfile !== 'legacy-runc') throw new Error('Invalid worker runtime profile');
  if (legacyPrivilegeGrant !== undefined && legacyPrivilegeGrant !== 'preexisting' && legacyPrivilegeGrant !== 'admin')
    throw new Error('Invalid legacy worker privilege grant');
  if (dockerEnabled && !legacyPrivilegeGrant)
    throw Object.assign(new Error('Enabling Docker-in-Docker on a legacy worker requires an explicit administrator privilege grant'), {
      statusCode: 409,
      code: 'LEGACY_WORKER_PRIVILEGE_NOT_AUTHORIZED',
    });
  return { runtime: LEGACY_DOCKER_RUNTIME, privileged: dockerEnabled };
}

/** Docker inspection must agree with the durable selection. Empty runtime is
 * an older daemon's default runc and is accepted only for legacy workers. */
export function assertWorkerRuntimeMatches(
  profile: WorkerRuntimeProfile,
  observedRuntime: string | undefined,
  observedPrivileged: boolean,
  legacyPrivilegeGrant?: LegacyPrivilegeGrant,
): void {
  const expectedRuntime = profile === 'kata-qemu' ? KATA_DOCKER_RUNTIME : LEGACY_DOCKER_RUNTIME;
  const runtimeMatches = profile === 'legacy-runc'
    ? !observedRuntime || observedRuntime === LEGACY_DOCKER_RUNTIME
    : observedRuntime === expectedRuntime;
  const validLegacyGrant = legacyPrivilegeGrant === 'preexisting' || legacyPrivilegeGrant === 'admin';
  if ((profile !== 'kata-qemu' && profile !== 'legacy-runc') || !runtimeMatches ||
      (profile === 'kata-qemu' && (observedPrivileged || legacyPrivilegeGrant !== undefined)) ||
      (profile === 'legacy-runc' && observedPrivileged && !validLegacyGrant))
    throw Object.assign(new Error('Docker worker runtime does not match its durable runtime policy'), {
      statusCode: 409,
      code: 'WORKER_RUNTIME_MISMATCH',
    });
}
