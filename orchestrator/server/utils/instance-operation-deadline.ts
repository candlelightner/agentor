import { InstanceControlPlaneCoordinator } from './instance-control-plane-coordinator';
import { withOperationDeadline } from './operation-deadline';

/** Admit the actual operation lifetime, not merely the caller's bounded wait.
 *
 * The thunk MUST include and await all mutation, nested work and cleanup (for
 * example its own try/finally). Cleanup performed after this adapter returns
 * belongs to the caller's separate lifetime and is not covered by this child.
 * Any detached work must explicitly fork before its admitted parent settles.
 * Already-started promises are deliberately unsupported: their admission cannot
 * be established retroactively. Acquire before owner/store/worker locks.
 *
 * Abort/deadline returns promptly with the unchanged deadline error and its
 * settlement linkage. The independently registered child retains its live
 * coordinator context until the actual thunk settles, including late cleanup,
 * even if the caller catches the bounded error and returns successfully.
 * Neither cancellation nor a caught error proves that mutation has stopped.
 * Labels must be fixed server strings, never caller values or credentials.
 * This isolated adapter does not wire application writers into snapshot gates.
 */
export async function withInstanceOperationDeadline<T>(
  coordinator: InstanceControlPlaneCoordinator,
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (typeof operation !== 'function')
    throw new TypeError('Instance operation deadline requires an unstarted operation thunk');
  const child = coordinator.fork();
  try {
    return await withOperationDeadline(
      linkedSignal => child.run(() => operation(linkedSignal)),
      timeoutMs,
      label,
      signal,
    );
  } finally {
    // Pre-aborted signals or refused startup never invoke child.run. Retire
    // only that pending admission; cancel() cannot retire a running operation.
    child.cancel();
  }
}
