/** Serializes lifecycle mutations for one worker without blocking unrelated
 * workers. The queue deliberately survives a failed operation so a rejected
 * mutation cannot strand every later lifecycle request for that worker. */
export class WorkerLifecycleCoordinator {
  private queues = new Map<string, Promise<void>>();

  withWorker<T>(workerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workerId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
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
