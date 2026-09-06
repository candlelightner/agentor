import {
  operationSettlement,
  type OperationFailureWithSettlement,
} from "./operation-deadline";

/** Serializes lifecycle mutations for one worker without blocking unrelated
 * workers. The queue deliberately survives a failed operation so a rejected
 * mutation cannot strand every later lifecycle request for that worker. */
export class WorkerLifecycleCoordinator {
  private queues = new Map<string, Promise<void>>();
  /** A monotonic admission marker lets inventory reconciliation distinguish a
   * Docker list snapshot taken before a worker mutation from current state.
   * Queue occupancy alone is insufficient: a mutation can complete while
   * `sync()` is awaiting task probes, leaving an old Docker list response
   * otherwise able to resurrect an archived/replaced worker. */
  private sequence = 0;
  private generations = new Map<string, number>();

  isBusy(workerId: string): boolean {
    return this.queues.has(workerId);
  }

  currentSequence(): number {
    return this.sequence;
  }

  generation(workerId: string): number {
    return this.generations.get(workerId) ?? 0;
  }

  withWorker<T>(
    workerId: string,
    operation: () => Promise<T>,
    options: { holdTimeoutSettlement?: boolean } = {},
  ): Promise<T> {
    this.generations.set(workerId, ++this.sequence);
    const previous = this.queues.get(workerId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      async (error: OperationFailureWithSettlement) => {
        // The caller receives its bounded timeout immediately. Keep only this
        // worker's queue occupied until the aborted Docker HTTP request has
        // actually settled, preventing a retry/reconciler from racing a late
        // start, stop, restart, or remove. Unrelated workers remain available.
        if (options.holdTimeoutSettlement !== false)
          await error?.[operationSettlement];
      },
    );
    this.queues.set(workerId, tail);
    void tail.finally(() => {
      if (this.queues.get(workerId) === tail) this.queues.delete(workerId);
    });
    return result;
  }
}

const lifecycleCoordinator = new WorkerLifecycleCoordinator();

export function withWorkerLifecycleMutation<T>(
  workerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return lifecycleCoordinator.withWorker(workerId, operation);
}

/** Read-only reconciliation must not reinterpret a worker that is between
 * Docker mutations as missing. This exposes only lock occupancy, never the
 * queued operation or any caller data. */
export function isWorkerLifecycleMutationActive(workerId: string): boolean {
  return lifecycleCoordinator.isBusy(workerId);
}

/** Snapshot markers for read-only inventory work. They contain no worker
 * configuration and are deliberately separate from the mutation API. */
export function workerLifecycleSequence(): number {
  return lifecycleCoordinator.currentSequence();
}

export function workerLifecycleGeneration(workerId: string): number {
  return lifecycleCoordinator.generation(workerId);
}

/** Serialize mutations that publish or remove owner-scoped worker state.
 * The namespace prefix cannot collide with UUID worker ids. */
export function withOwnerLifecycleMutation<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return lifecycleCoordinator.withWorker(`owner:${userId}`, operation);
}

/** Acquire lifecycle fences in the only supported nesting order. Keeping the
 * ordering here prevents a future worker mutation from accidentally taking the
 * worker fence first and deadlocking owner cleanup. */
export function withOwnerWorkerLifecycleMutation<T>(
  userId: string,
  workerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  // The worker fence owns the late Docker settlement. Propagating it into the
  // outer owner fence would make one wedged worker block every sibling of the
  // same owner indefinitely, despite each sibling having an independent
  // Docker task. Account cleanup still takes owner→worker in this order and
  // therefore waits for the affected worker fence before touching it.
  return lifecycleCoordinator.withWorker(`owner:${userId}`, () =>
    withWorkerLifecycleMutation(workerId, operation),
    { holdTimeoutSettlement: false },
  );
}
