import { DEFAULT_INCUS_WORKER_MEMORY_LIMIT, incusDefaultMemoryLimit } from './worker-memory';

export function validateAdminMemoryLimit(value: unknown): string {
  if (typeof value === 'string' && value.length <= 64) {
    try { return incusDefaultMemoryLimit(value); } catch { /* Return an API-specific validation error. */ }
  }
  throw Object.assign(new Error('memoryLimit must be a finite positive memory size, e.g. 4GiB'), { statusCode: 400 });
}

export function adminMemorySettings(record: { memoryLimit?: string; nativeRuntime?: { memoryLimit?: string } }) {
  const memoryLimit = record.memoryLimit ?? DEFAULT_INCUS_WORKER_MEMORY_LIMIT;
  const appliedMemoryLimit = record.nativeRuntime?.memoryLimit ?? DEFAULT_INCUS_WORKER_MEMORY_LIMIT;
  return { memoryLimit, appliedMemoryLimit, pendingRebuild: memoryLimit !== appliedMemoryLimit };
}
