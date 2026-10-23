export const DEFAULT_RECOVERY_MAX_RETRIES = 3;
export const UNKNOWN_STATE_WARNING = 'Current runtime state may be unknown. This changes the requested state; it does not confirm that the worker has started or stopped.';

export interface WorkerRecoveryState {
  maxRetries: number;
  attempts: number;
  lastFailure?: { code: string; message: string; phase?: string; exitCode?: number };
}

export function recoveryState(value?: WorkerRecoveryState): WorkerRecoveryState {
  if (value !== undefined) {
    validateRecoveryMaxRetries(value.maxRetries);
    if (!Number.isSafeInteger(value.attempts) || value.attempts < 0)
      throw Object.assign(new Error('Persisted recovery attempt count is invalid; operator recovery required'), { statusCode: 503 });
  }
  return { maxRetries: DEFAULT_RECOVERY_MAX_RETRIES, attempts: 0, ...value };
}

export function validateRecoveryMaxRetries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100)
    throw Object.assign(new Error('maxRetries must be an integer from 0 to 100'), { statusCode: 400 });
  return value;
}
