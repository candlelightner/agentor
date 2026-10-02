import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { instanceControlPlaneCoordinator } from './instance-snapshot-gate';

/** All management requests participate, including nominally read-only tools:
 * identity denials and final tool/transfer audits write included instance data.
 * Rejection happens before dispatch/audit; a rejected new root must not start
 * another persisted audit while the snapshot cut is closed. */
export function runManagementOperation<T>(operation: () => T | Promise<T>): Promise<T> {
  return instanceControlPlaneCoordinator.run(operation);
}

/** Streams returned to direct callers must outlive their opening call's lease.
 * This does not assert that unrelated async cleanup attached to stream events
 * has settled: the helper/resource owner must register that cleanup separately.
 * Transport callers additionally retain their whole pipeline and final audit. */
export function accountManagementStream(stream: Readable): void {
  const child = instanceControlPlaneCoordinator.fork();
  void child.run(async () => {
    // Observe failures without introducing a second unhandled stream rejection;
    // the actual consumer remains responsible for reporting the transfer error.
    await finished(stream, { cleanup: true }).catch(() => {});
  }).catch(() => {});
}
