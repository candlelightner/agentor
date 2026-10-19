export interface VcpuSettings {
  vcpuCount: number;
  maxVcpuCount: number;
  status: 'running' | 'stopped';
  pending: boolean;
  pendingVcpuCount?: number;
}

export function validateVcpuCount(value: unknown, maximum?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw Object.assign(new Error('vCPU count must be a positive integer.'), { statusCode: 400 });
  if (maximum !== undefined && value > maximum)
    throw Object.assign(new Error(`vCPU count exceeds the backend maximum of ${maximum}.`), { statusCode: 400 });
  return value;
}
