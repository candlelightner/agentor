import { createError } from "h3";
import { useContainerManager, useHardwareDeviceStore, useWorkerStore } from "./services";
import { isPhysicalGpuDevice } from "./hardware-device-store";

/** Device grants are already durably revoked. Stop affected workers and keep a
 * restart guard until rebuild removes Docker's immutable device mappings. */
export async function enforceHardwareDeviceRevocation(userId?: string) {
  const result = await useContainerManager().reconcileHardwareDeviceAccess(userId);
  if (result.failures.length)
    throw createError({
      statusCode: 409,
      statusMessage:
        "Hardware device access was revoked, but one or more affected workers could not be stopped. Desired devices were removed and restart is blocked; stop or rebuild those workers immediately.",
      data: { revocationCommitted: true, ...result },
    });
  return result;
}

/** Generic policy deletion must not become an implicit physical GPU detach. */
export function assertPhysicalGpuPolicyRemovalSafe(deviceId: string): void {
  const device = useHardwareDeviceStore().getDevice(deviceId);
  if (!isPhysicalGpuDevice(device)) return;
  if (device!.physicalAssignment || [...useWorkerStore().list(), ...useContainerManager().list()]
    .some(worker => worker.hardwareDeviceIds?.includes(deviceId)))
    throw createError({ statusCode: 409, statusMessage: 'Release the physical GPU through platform GPU management before deleting its catalog entry or entitlement.' });
}
