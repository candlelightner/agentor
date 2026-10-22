import { useContainerManager, useHardwareDeviceStore, useWorkerStore } from './services';
import { gpuAssignments, isPhysicalGpuDevice } from './hardware-device-store';
import { useWorkerProtectionLockStore } from './worker-protection-lock';

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, statusMessage: message });
}

/** Incus/sysfs are authoritative; catalog bindings are permission/recovery receipts. */
export async function listPhysicalGpuAssignments() {
  const hardware = useHardwareDeviceStore(), workers = useWorkerStore(), manager = useContainerManager();
  const inventory = await hardware.listDiscoveredDevices(), instances = await manager.gpuInstances();
  const ordinary = workers.list().filter(worker => worker.runtimeKind === 'incus-vm' && worker.status === 'active' && !worker.deletionPending);
  return {
    devices: hardware.listCatalog().filter(isPhysicalGpuDevice).map(device => {
      const candidate = inventory.find(item => item.selector === device.selector), evidence = candidate?.incus?.evidence;
      const bindings = gpuAssignments(device);
      const native = instances.flatMap(instance => Object.entries(instance.expanded_devices ?? instance.devices)
        .filter(([, value]) => ['gpu', 'pci'].includes(value.type) && (!value.pci && !value.address || (value.pci || value.address) === evidence?.pciAddress))
        .map(([key, value]) => ({ workerId: instance.config['user.agentor.id'], profile: value.gputype === 'mdev' ? value.mdev as string : undefined,
          mode: value.gputype === 'mdev' ? 'gpu-mdev' : 'gpu-physical', status: instance.status.toLowerCase(),
          uuid: instance.status === 'Running' ? instance.config[`volatile.${key}.vgpu.uuid`] : undefined })));
      const allocations = bindings.map(binding => {
        const worker = workers.get(binding.userId, binding.workerId), actual = native.filter(value => value.workerId === binding.workerId);
        const profile = 'profile' in binding ? binding.profile as string : undefined;
        return { workerId: binding.workerId, displayName: worker?.displayName ?? 'Unavailable worker',
          profile: actual.length === 1 ? actual[0]!.profile : profile,
          status: !worker || worker.hardwareDevicesRevoked || !worker.hardwareDeviceIds?.includes(device.id) || actual.length !== 1 || actual[0]!.profile !== profile ||
            profile && actual[0]?.status === 'running' && (!actual[0].uuid || !evidence?.mediatedInstances?.[profile]?.includes(actual[0].uuid)) ? 'recovery-required' : actual[0]!.status,
          pendingRebuild: worker?.pendingRebuild === true };
      });
      const profiles = (evidence?.mediatedProfiles ?? []).map(id => {
        const active = evidence?.mediatedInstances?.[id] ?? [], info = evidence?.mediatedProfileInfo?.[id];
        const reserved = native.filter(value => value.profile === id && !value.uuid).length;
        const pending = bindings.filter(binding => 'profile' in binding && binding.profile === id && !native.some(value => value.workerId === binding.workerId)).length;
        const compatible = !native.some(value => value.mode !== 'gpu-mdev' || value.profile !== id) && !bindings.some(binding => !('profile' in binding) || binding.profile !== id) &&
          !Object.entries(evidence?.mediatedInstances ?? {}).some(([profile, ids]) => profile !== id && ids.length);
        return { id, name: info?.name ?? id, framebufferMiB: info?.framebufferMiB, total: info?.total,
          available: compatible ? Math.max(0, (evidence?.mediatedAvailable?.[id] ?? 0) - reserved - pending) : 0,
          hostAvailable: evidence?.mediatedAvailable?.[id] ?? 0, active: active.length, reserved: reserved + pending, compatible };
      });
      const unknownInstances = Object.values(evidence?.mediatedInstances ?? {}).flat().filter(uuid => !native.some(value => value.uuid === uuid)).length;
      const foreignAssignments = native.filter(value => !bindings.some(binding => binding.workerId === value.workerId)).length;
      const inconsistent = allocations.some(value => value.status === 'recovery-required') || foreignAssignments > 0 || unknownInstances > 0;
      return { id: device.id, name: device.name, available: !!candidate, reason: candidate?.incus?.reason ?? 'Device unavailable',
        mode: candidate?.incus?.mode ?? 'unsupported', physicalSupported: evidence?.physicalSupported ?? candidate?.incus?.mode === 'gpu-physical',
        physicalReason: evidence?.physicalReason ?? candidate?.incus?.reason, profiles, allocations, unknownInstances, foreignAssignments,
        workerId: device.physicalAssignment?.workerId,
        status: inconsistent ? 'recovery-required' : !candidate ? 'unavailable' : allocations.length === 1 ? allocations[0]!.status : allocations.length ? 'assigned' : 'unassigned',
        pendingRebuild: allocations.some(value => value.pendingRebuild) };
    }),
    workers: ordinary.map(worker => ({ id: worker.id, displayName: worker.displayName,
      status: manager.get(worker.id)?.status ?? 'unknown', pendingRebuild: worker.pendingRebuild === true })),
  };
}

/** REST and platform MCP supply the same live administrator check and worker lock. */
export async function setPhysicalGpuAssignment(deviceId: unknown, workerId: unknown,
  authorize: () => Promise<void>, lockPassword?: unknown, options: { profile?: unknown; releaseWorkerId?: unknown } = {}) {
  await authorize();
  if (typeof deviceId !== 'string' || !deviceId || workerId !== null && (typeof workerId !== 'string' || !workerId) ||
      options.profile !== undefined && (typeof options.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.profile)) ||
      options.releaseWorkerId !== undefined && (typeof options.releaseWorkerId !== 'string' || !options.releaseWorkerId) || workerId === null && options.profile !== undefined)
    fail(400, 'deviceId, an explicit workerId or null, and a valid optional profile are required');
  const hardware = useHardwareDeviceStore(), workers = useWorkerStore(), device = hardware.getDevice(deviceId);
  if (!isPhysicalGpuDevice(device)) fail(400, 'Select an approved PCI GPU');
  const bindings = gpuAssignments(device), selections = workers.list().filter(worker => worker.hardwareDeviceIds?.includes(deviceId));
  if (workerId === null && !options.releaseWorkerId && Math.max(bindings.length, selections.length) > 1) fail(409, 'Select the explicit worker allocation to release');
  const id = workerId ?? options.releaseWorkerId ?? bindings[0]?.workerId ?? selections[0]?.id;
  if (!id) return { released: true };
  const target = workers.findById(id as string), binding = bindings.find(value => value.workerId === id);
  if (!target || binding && binding.userId !== target.userId || workerId === null && !binding && !selections.some(worker => worker.id === id))
    fail(409, 'Assigned worker identity is unavailable; administrative recovery is required');
  if (workerId !== null && bindings.some(value => value.workerId !== id && (!options.profile || !('profile' in value))))
    fail(409, 'Release the currently assigned stopped VM before assigning another VM');
  const check = async () => {
    await authorize(); await useWorkerProtectionLockStore().verify(id as string, lockPassword);
    if (workerId === null && !gpuAssignments(hardware.getDevice(deviceId)).some(value => value.userId === target.userId && value.workerId === id) &&
        !workers.get(target.userId, id as string)?.hardwareDeviceIds?.includes(deviceId)) fail(409, 'GPU assignment changed while release was pending; refresh before retrying');
  };
  await check();
  await useContainerManager().setPhysicalGpuSelection(id as string, workerId === null ? undefined : deviceId, check, options.profile as string | undefined);
  return { deviceId, workerId, releasedWorkerId: workerId === null ? id : undefined, profile: options.profile, stopped: true };
}
