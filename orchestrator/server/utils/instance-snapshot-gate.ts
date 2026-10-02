import { InstanceControlPlaneCoordinator, type InstanceControlPlaneBarrier } from './instance-control-plane-coordinator';

export type InstanceControlPlaneBarrierKind = "snapshot" | "restore";

export const instanceControlPlaneCoordinator = new InstanceControlPlaneCoordinator();
export type InstanceBarrierRelease = (() => void) & Pick<InstanceControlPlaneBarrier, 'drain' | 'assertDrained'>;

/** Admission predicate, unlike barrier observation, preserves the remainder of
 * an already admitted transaction while a snapshot drains its descendants. */
export function instanceMutationAllowed(): boolean {
  return instanceControlPlaneCoordinator.mutationAllowed;
}
export function instanceMutationBlocked(): boolean {
  return !instanceMutationAllowed();
}

let active:
  | { jobId: string; kind: InstanceControlPlaneBarrierKind }
  | undefined;

/** Short control-plane write barrier used while auth.db and the JSON-backed
 * stores are copied into one instance snapshot. Worker/admin processes must
 * already be stopped; this closes the remaining dashboard mutation window. */
export function beginInstanceSnapshot(jobId: string): InstanceBarrierRelease {
  return beginInstanceControlPlaneBarrier(jobId, "snapshot");
}

/** Hold the same fail-closed mutation barrier from restore acceptance until
 * the restart helper has either taken control or failed. This closes the gap
 * between a successful empty-installation preflight and destructive apply. */
export function beginInstanceRestore(jobId: string): InstanceBarrierRelease {
  return beginInstanceControlPlaneBarrier(jobId, "restore");
}

function beginInstanceControlPlaneBarrier(
  jobId: string,
  kind: InstanceControlPlaneBarrierKind,
): InstanceBarrierRelease {
  if (active)
    throw Object.assign(
      new Error("Another instance control-plane recovery operation is already active"),
      { statusCode: 409, code: "INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE" },
    );
  const barrier = instanceControlPlaneCoordinator.begin(jobId, kind);
  const identity = { jobId, kind };
  active = identity;
  let released = false;
  return Object.assign(() => {
    if (released) return;
    released = true;
    barrier.release();
    if (active === identity) active = undefined;
  }, { drain: barrier.drain, assertDrained: barrier.assertDrained });
}

export function instanceSnapshotActive(): boolean {
  return Boolean(active);
}

export function instanceSnapshotJobId(): string | undefined {
  return active?.jobId;
}

export function instanceControlPlaneBarrierKind():
  | InstanceControlPlaneBarrierKind
  | undefined {
  return active?.kind;
}
