export class WorkerStartupError extends Error {
  readonly code = 'WORKER_BOOTSTRAP_FAILED';
  constructor(readonly phase: string, readonly exitCode?: number) {
    super(`Incus worker bootstrap command failed during ${phase}${exitCode === undefined ? '' : ` (exit ${exitCode})`}`);
  }
}

/** Only platform-authored phases and numeric exit codes are public; guest output can contain secrets. */
export function workerStartupFailure(error: unknown) {
  if (error instanceof WorkerStartupError)
    return { code: error.code, message: error.message, phase: error.phase, exitCode: error.exitCode };
  return { code: 'WORKER_RECOVERY_FAILED', message: 'Worker recovery failed; runtime readiness or identity could not be confirmed' };
}
