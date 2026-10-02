import { AsyncLocalStorage } from 'node:async_hooks';
import { operationSettlement, type OperationFailureWithSettlement } from './operation-deadline';

type Scope = { accepting: boolean };
export type InstanceBarrierKind = 'snapshot' | 'restore';
export interface InstanceControlPlaneBarrier {
  readonly jobId: string;
  readonly kind: InstanceBarrierKind;
  drain(options: { timeoutMs: number; signal?: AbortSignal }): Promise<void>;
  /** Recheck immediately before each snapshot boundary, not just once. */
  assertDrained(): void;
  release(): void;
}

function refused(code = 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE'): Error {
  return Object.assign(new Error('Instance control-plane mutation admission or drain is unavailable'), {
    statusCode: 423, code,
  });
}

/** Process-local writer-lifetime primitive. NOT yet the application snapshot
 * gate: every logical writer, including authentication, MCP audits, timers,
 * queues, streams and cleanup, must be integrated before it proves a cut.
 *
 * Acquire admission BEFORE owner/worker/store locks. Close admission before
 * draining; never await drain from inside an admitted operation. Async context
 * permits reentrancy only while that callback is live. Detached work must fork
 * synchronously before its parent completes. Caller timeout/abort is not proof
 * of settlement. A barrier timeout leaves all outstanding scopes accounted.
 * No capability here is serializable or grants host/Docker/runtime authority.
 */
export class InstanceControlPlaneCoordinator {
  private readonly context = new AsyncLocalStorage<Scope>();
  private readonly scopes = new Set<Scope>();
  private readonly changed = new Set<() => void>();
  private barrier?: object;

  get activeOperations(): number { return this.scopes.size; }
  get barrierActive(): boolean { return this.barrier !== undefined; }
  /** Admission checks use this; observation of a barrier alone must not abort
   * the remainder of a logical transaction already being drained. */
  get mutationAllowed(): boolean {
    return !this.barrier || this.liveContext();
  }
  private liveContext(): boolean {
    const scope = this.context.getStore();
    return !!scope?.accepting && this.scopes.has(scope);
  }
  private acquire(): Scope {
    if (!this.mutationAllowed) throw refused();
    const scope = { accepting: false };
    this.scopes.add(scope);
    return scope;
  }
  private release(scope: Scope): void {
    scope.accepting = false;
    this.scopes.delete(scope);
    for (const notify of [...this.changed]) notify();
  }
  private execute<T>(scope: Scope, operation: () => T | Promise<T>): Promise<T> {
    scope.accepting = true;
    // Promise creation and callback execution happen in the same context. The
    // finally below closes implicit child admission at callback completion,
    // while pre-registered detached children remain independently accounted.
    const result = this.context.run(scope, async () => operation());
    return result.then(value => {
      this.release(scope);
      return value;
    }, error => {
      scope.accepting = false;
      const settlement = (error as OperationFailureWithSettlement | undefined)?.[operationSettlement];
      if (settlement) {
        // Conservative fallback accounting ONLY. A caught error never reaches
        // this branch, and the failed caller's context must not stay live.
        // Deadline integrations must lease the actual underlying thunk (see
        // withInstanceOperationDeadline), including its awaited cleanup.
        void Promise.resolve(settlement).then(() => this.release(scope), () => this.release(scope));
      } else this.release(scope);
      throw error;
    });
  }
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    try { return this.execute(this.acquire(), operation); }
    catch (error) { return Promise.reject(error); }
  }
  /** Drop inherited admission, WITHOUT acquiring or bypassing the gate. Used
   * only by the separately excluded instance-job scheduler so its snapshot or
   * restore drain can wait for the accepting request and final audit. Included
   * state writers invoked here still need ordinary admission and are rejected
   * during a barrier. This is not an internal mutation capability. */
  withoutOperationContext<T>(operation: () => T): T {
    return this.context.exit(operation);
  }
  /** Register BEFORE scheduling a timer/task/stream finalizer. The returned
   * handle can start once even after its parent returns and admission closes.
   * cancel() only retires work that has never started; it cannot cancel writes.
   * The owner must observe the promise returned by run(). */
  fork(): { run<T>(operation: () => T | Promise<T>): Promise<T>; cancel(): boolean } {
    const scope = this.acquire();
    let state: 'pending' | 'running' | 'cancelled' = 'pending';
    return Object.freeze({
      run: <T>(operation: () => T | Promise<T>): Promise<T> => {
        if (state !== 'pending') return Promise.reject(refused('INSTANCE_CONTROL_PLANE_LEASE_STALE'));
        state = 'running';
        return this.execute(scope, operation);
      },
      cancel: () => {
        if (state !== 'pending') return false;
        state = 'cancelled'; this.release(scope); return true;
      },
    });
  }
  begin(jobId: string, kind: InstanceBarrierKind): InstanceControlPlaneBarrier {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId) ||
        (kind !== 'snapshot' && kind !== 'restore')) throw refused('INSTANCE_CONTROL_PLANE_BARRIER_INVALID');
    // No same-job alias: only this opaque handle can release this acquisition.
    if (this.barrier) throw refused();
    const token = {};
    this.barrier = token;
    const assertOwner = () => {
      if (this.barrier !== token) throw refused('INSTANCE_CONTROL_PLANE_BARRIER_STALE');
    };
    const assertDrained = () => {
      assertOwner();
      if (this.scopes.size) throw refused('INSTANCE_CONTROL_PLANE_NOT_DRAINED');
    };
    return Object.freeze({ jobId, kind, assertDrained,
      drain: ({ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }) => {
        try {
          assertOwner();
          if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
            throw refused('INSTANCE_CONTROL_PLANE_DRAIN_INVALID');
          // A queued snapshot/restore task must detach from the accepting
          // request's live scope before draining its request + final audit.
          if (this.liveContext()) throw refused('INSTANCE_CONTROL_PLANE_DRAIN_SELF');
          if (signal?.aborted) throw refused('INSTANCE_CONTROL_PLANE_DRAIN_ABORTED');
        } catch (error) { return Promise.reject(error); }
        return new Promise<void>((resolve, reject) => {
          let complete = false;
          const finish = (error?: unknown) => {
            if (complete) return;
            complete = true; clearTimeout(timer); this.changed.delete(check);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve();
          };
          const check = () => {
            try { assertOwner(); if (!this.scopes.size) finish(); }
            catch (error) { finish(error); }
          };
          const abort = () => finish(refused('INSTANCE_CONTROL_PLANE_DRAIN_ABORTED'));
          const timer = setTimeout(() => finish(refused('INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT')), timeoutMs);
          this.changed.add(check); signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort(); else check();
        });
      },
      release: () => {
        if (this.barrier !== token) return;
        this.barrier = undefined;
        for (const notify of [...this.changed]) notify();
      },
    });
  }
}
