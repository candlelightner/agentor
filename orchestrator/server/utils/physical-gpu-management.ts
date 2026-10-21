import { useContainerManager, useHardwareDeviceStore, useWorkerStore } from './services';
import { isNvidiaPhysicalGpuDevice } from './hardware-device-store';
import { useWorkerProtectionLockStore } from './worker-protection-lock';

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, statusMessage: message });
}

/** Public administrative view; probe identity receipts remain server-only. */
export async function listPhysicalGpuAssignments() {
  const hardware = useHardwareDeviceStore(), workers = useWorkerStore(), manager = useContainerManager();
  const inventory = await hardware.listDiscoveredDevices();
  const ordinary = workers.list().filter(worker => worker.runtimeKind === 'incus-vm' &&
    worker.status === 'active' && !worker.deletionPending);
  return {
    devices: hardware.listCatalog().filter(isNvidiaPhysicalGpuDevice).map(device => {
      const candidate = inventory.find(item => item.selector === device.selector);
      const selected = workers.list().filter(worker => worker.hardwareDeviceIds?.includes(device.id));
      const binding = device.physicalAssignment;
      const assigned = binding && workers.get(binding.userId, binding.workerId);
      const live = assigned && manager.get(assigned.id);
      const inconsistent = selected.length > 1 || selected.some(worker => !binding ||
        worker.id !== binding.workerId || worker.userId !== binding.userId) ||
        !!binding && (!assigned || !assigned.hardwareDeviceIds?.includes(device.id));
      return {
        id: device.id, name: device.name, available: !!candidate,
        reason: candidate?.incus?.reason ?? 'Device unavailable',
        workerId: binding?.workerId ?? (selected.length === 1 ? selected[0]!.id : undefined),
        status: inconsistent || assigned?.hardwareDevicesRevoked ? 'recovery-required' :
          !candidate ? 'unavailable' : binding ? (live?.status ?? 'unknown') : 'unassigned',
        pendingRebuild: assigned?.pendingRebuild === true,
      };
    }),
    workers: ordinary.map(worker => ({ id: worker.id, displayName: worker.displayName,
      status: manager.get(worker.id)?.status ?? 'unknown', pendingRebuild: worker.pendingRebuild === true })),
  };
}

/** Both REST and platform MCP supply their existing authenticated admin check. */
export async function setPhysicalGpuAssignment(deviceId: unknown, workerId: unknown,
  authorize: () => Promise<void>, lockPassword?: unknown) {
  await authorize();
  if (typeof deviceId !== 'string' || !deviceId || workerId !== null && (typeof workerId !== 'string' || !workerId))
    fail(400, 'deviceId and an explicit workerId or null are required');
  const hardware = useHardwareDeviceStore(), workers = useWorkerStore();
  const device = hardware.getDevice(deviceId);
  if (!isNvidiaPhysicalGpuDevice(device)) fail(400, 'Select an approved NVIDIA physical GPU');
  const selections = workers.list().filter(worker => worker.hardwareDeviceIds?.includes(deviceId));
  if (selections.length > 1) fail(409, 'GPU ownership is ambiguous; administrative recovery is required');
  const binding = device!.physicalAssignment;
  if (workerId !== null && (binding && binding.workerId !== workerId ||
      selections.some(worker => worker.id !== workerId)))
    fail(409, 'Release the currently assigned stopped VM before assigning another VM');
  const id = workerId ?? binding?.workerId ?? selections[0]?.id;
  if (!id) return { released: true };
  const target = workers.findById(id);
  if (!target || binding && (target.id !== binding.workerId || target.userId !== binding.userId))
    fail(409, 'Assigned worker identity is unavailable; administrative recovery is required');
  const check = async () => {
    await authorize();
    await useWorkerProtectionLockStore().verify(id, lockPassword);
    if (workerId === null) {
      const current = hardware.getDevice(deviceId)?.physicalAssignment;
      const selected = workers.get(target.userId, id)?.hardwareDeviceIds?.includes(deviceId);
      if (!(current?.userId === target.userId && current.workerId === id) && !selected)
        fail(409, 'GPU assignment changed while release was pending; refresh before retrying');
    }
  };
  await check();
  await useContainerManager().setPhysicalGpuSelection(id, workerId === null ? undefined : deviceId, check);
  return { deviceId, workerId, stopped: true };
}
