export type InstanceControlPlaneBarrierKind = "snapshot" | "restore";

let active:
  | { jobId: string; kind: InstanceControlPlaneBarrierKind }
  | undefined;

/** Short control-plane write barrier used while auth.db and the JSON-backed
 * stores are copied into one instance snapshot. Worker/admin processes must
 * already be stopped; this closes the remaining dashboard mutation window. */
export function beginInstanceSnapshot(jobId: string): () => void {
  return beginInstanceControlPlaneBarrier(jobId, "snapshot");
}

/** Hold the same fail-closed mutation barrier from restore acceptance until
 * the restart helper has either taken control or failed. This closes the gap
 * between a successful empty-installation preflight and destructive apply. */
export function beginInstanceRestore(jobId: string): () => void {
  return beginInstanceControlPlaneBarrier(jobId, "restore");
}

function beginInstanceControlPlaneBarrier(
  jobId: string,
  kind: InstanceControlPlaneBarrierKind,
): () => void {
  if (active && (active.jobId !== jobId || active.kind !== kind))
    throw Object.assign(
      new Error("Another instance control-plane recovery operation is already active"),
      { statusCode: 409, code: "INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE" },
    );
  active = { jobId, kind };
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (active?.jobId === jobId && active.kind === kind) active = undefined;
  };
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
