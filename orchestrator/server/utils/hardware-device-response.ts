import type { HardwareDevice } from '../../shared/types';

/** Public hardware metadata excludes host identity and cold-change receipts. */
export function publicHardwareDevice<T extends Pick<HardwareDevice, 'physicalIdentity' | 'physicalAssignment'>>(device: T) {
  const { physicalIdentity: _physicalIdentity, physicalAssignment, ...metadata } = device;
  return { ...metadata, ...(physicalAssignment ? {
    physicalAssignment: { userId: physicalAssignment.userId, workerId: physicalAssignment.workerId },
  } : {}) };
}
