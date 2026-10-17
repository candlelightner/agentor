/** Docker-style environment caps use binary units, including k/m/g spellings. */
export function incusWorkerMemoryLimit(value?: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|m|g|kb|mb|gb|kib|mib|gib)$/i.exec(value);
  if (!match) throw new Error('Invalid worker memory limit');
  const unit = match[2]!.toLowerCase();
  const exponent = unit === 'b' ? 0 : unit.startsWith('k') ? 1 : unit.startsWith('m') ? 2 : 3;
  const bytes = Math.floor(Number(match[1]) * 1024 ** exponent);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Worker memory limit exceeds the supported byte range');
  if (!bytes) return undefined;
  if (unit.includes('i')) return `${match[1]}${exponent === 1 ? 'KiB' : exponent === 2 ? 'MiB' : 'GiB'}`;
  return String(bytes);
}

export const DEFAULT_INCUS_WORKER_MEMORY_LIMIT = '4GiB';

/** A VM needs finite assigned RAM even when a Docker environment was uncapped. */
export function incusDefaultMemoryLimit(value: string = DEFAULT_INCUS_WORKER_MEMORY_LIMIT): string {
  let limit: string | undefined;
  try { limit = incusWorkerMemoryLimit(value); } catch { /* use a configuration-specific diagnostic below */ }
  if (!limit) throw new Error('INCUS_DEFAULT_MEMORY_LIMIT must be a finite positive memory size, e.g. 4GiB');
  return /^\d+$/.test(limit) ? `${limit}B` : limit;
}

export function effectiveIncusWorkerMemoryLimit(value?: string, fallback?: string): string {
  // Validate the operator policy even if this worker has an explicit cap.
  const defaultLimit = incusDefaultMemoryLimit(fallback);
  return incusWorkerMemoryLimit(value) ?? incusWorkerMemoryLimit(defaultLimit)!;
}

export interface WorkerMemoryPolicy {
  defaultMemoryLimit: string;
  incusDefaultMemoryLimit: string;
}
