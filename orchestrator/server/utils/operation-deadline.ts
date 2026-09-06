export interface OperationFailureData {
  code: "OPERATION_ABORTED" | "DOCKER_OPERATION_TIMEOUT";
  operation: string;
  retryable: true;
  timeoutMs?: number;
  nextAction: string;
}

/** Non-enumerable linkage used by lifecycle queues to keep a timed-out Docker
 * mutation serialized until abort has actually closed its client request. */
export const operationSettlement = Symbol("agentor.operationSettlement");
export type OperationFailureWithSettlement = Error & {
  [operationSettlement]?: Promise<void>;
};

/** A deliberately value-free control-plane error. Operation names must be
 * fixed server strings, never Docker command lines, environment values, or
 * other caller-controlled data that could contain credentials. */
export class OperationDeadlineError extends Error {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly code: OperationFailureData["code"];
  readonly data: OperationFailureData;

  constructor(
    code: OperationFailureData["code"],
    operation: string,
    timeoutMs?: number,
  ) {
    const timedOut = code === "DOCKER_OPERATION_TIMEOUT";
    const message = timedOut
      ? `${operation} did not respond within ${timeoutMs}ms`
      : `${operation} was cancelled`;
    super(message);
    this.name = "OperationDeadlineError";
    this.statusCode = timedOut ? 504 : 499;
    this.statusMessage = message;
    this.code = code;
    this.data = {
      code,
      operation,
      retryable: true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      nextAction: timedOut
        ? "Retry the individual operation or use managed worker recovery; other workers remain available."
        : "The operation was stopped and may be started again safely.",
    };
  }
}

/** Bound one external operation without leaving an unobserved late rejection.
 * A thunk receives a deadline-linked AbortSignal and is preferred for Docker
 * calls; legacy promise inputs remain observed but cannot be actively aborted. */
export function withOperationDeadline<T>(
  operation: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(
      new OperationDeadlineError("OPERATION_ABORTED", label),
    );
  const controller = new AbortController();
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(
      typeof operation === "function"
        ? operation(controller.signal)
        : operation,
    );
  } catch (error) {
    pending = Promise.reject(error);
  }
  const settlement = pending.then(
    () => undefined,
    () => undefined,
  );
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          controller.abort();
          const error = new OperationDeadlineError(
            "DOCKER_OPERATION_TIMEOUT",
            label,
            timeoutMs,
          ) as OperationFailureWithSettlement;
          Object.defineProperty(error, operationSettlement, {
            value: settlement,
            enumerable: false,
          });
          reject(error);
        }),
      timeoutMs,
    );
    timer.unref?.();
    const onAbort = () =>
      finish(() => {
        controller.abort();
        const error = new OperationDeadlineError(
          "OPERATION_ABORTED",
          label,
        ) as OperationFailureWithSettlement;
        Object.defineProperty(error, operationSettlement, {
          value: settlement,
          enumerable: false,
        });
        reject(error);
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    // AbortSignal does not replay an abort that lands between the initial
    // throwIfAborted() check and listener registration. Close that narrow
    // race explicitly so a disconnected client can never leave this wrapper
    // waiting until its ordinary timeout.
    if (signal?.aborted) onAbort();
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function isOperationTimeout(error: unknown): boolean {
  return (
    error instanceof OperationDeadlineError &&
    error.code === "DOCKER_OPERATION_TIMEOUT"
  );
}
